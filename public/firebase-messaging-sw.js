importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyCWIev2L18k_TugAAIDEYREwsfFn0chdpQ",
  authDomain: "jesus-e7711.firebaseapp.com",
  projectId: "jesus-e7711",
  // ✅ usar appspot.com en Web
  storageBucket: "jesus-e7711.appspot.com",
  messagingSenderId: "228736362294",
  appId: "1:228736362294:web:d34485861f9daccb9cf597",
  measurementId: "G-9QVKVW3YVD"
});

const messaging = firebase.messaging();

/* ===== DEBUG: informar cada notificación saliente desde el SW (NO intrusivo) ===== */
async function __dbg_postToClients(msg) {
  try {
    const cs = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of cs) {
      try { c.postMessage({ __fromSW: true, ...msg }); } catch {}
    }
  } catch {}
}
const __origShow = self.registration.showNotification.bind(self.registration);
self.registration.showNotification = async (title, options) => {
  __dbg_postToClients({ type: "SW_NOTIFY", title, options });
  return __origShow(title, options);
};
/* ========================================================================= */

/**
 * BACKGROUND:
 * - Soporta data-only: usa data.__title/__body si vienen.
 * - Si no hay, usa payload.notification.
 */
messaging.onBackgroundMessage((payload) => {
  const data = (payload && payload.data) || {};
  const title =
    (data.__title && String(data.__title)) ||
    (payload.notification && payload.notification.title) ||
    "Notificación";

  const body =
    (data.__body && String(data.__body)) ||
    (payload.notification && payload.notification.body) ||
    "";

  const icon = data.icon || "/icon-192.png";

  // Copiamos data para usarla en el click handler
  const ndata = {};
  if (payload && payload.data) {
    Object.keys(payload.data).forEach((k) => (ndata[k] = payload.data[k]));
  }

  self.registration.showNotification(title, {
    body,
    icon,
    data: ndata,
    // tag: data.tag || undefined,
    // renotify: !!data.tag,
    // requireInteraction: data.requireInteraction === "true",
  });
});

/**
 * CLICK:
 * - Si llega data.url:
 *    - Si es relativa, la convierte a absoluta con el origen.
 *    - Enfoca una pestaña ya abierta con esa URL (o abre una nueva).
 * - Si no llega, abre/enfoca la raíz ('/').
 */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const rawUrl = (event.notification && event.notification.data && event.notification.data.url) || "/";
  let targetUrl = rawUrl;

  try {
    if (rawUrl.startsWith("/")) {
      targetUrl = new URL(rawUrl, self.location.origin).toString();
    } else {
      targetUrl = new URL(rawUrl).toString();
    }
  } catch {
    targetUrl = self.location.origin + "/";
  }

  event.waitUntil((async () => {
    const allClients = await clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of allClients) {
      if (client.url && client.url.startsWith(self.location.origin)) {
        if (client.url === targetUrl || client.url === self.location.origin + "/") {
          if ("focus" in client) return client.focus();
        }
      }
    }
    if (clients.openWindow) return clients.openWindow(targetUrl);
  })());
});
