// public/firebase-messaging-sw.js
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
    // Opcionales:
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
    // Si es relativa, que sea absoluta en este origen.
    if (rawUrl.startsWith("/")) {
      targetUrl = new URL(rawUrl, self.location.origin).toString();
    } else {
      // Si ya es absoluta y válida, la usamos tal cual
      targetUrl = new URL(rawUrl).toString();
    }
  } catch {
    // Si falló parseo, volvemos a la raíz
    targetUrl = self.location.origin + "/";
  }

  event.waitUntil((async () => {
    const allClients = await clients.matchAll({ type: "window", includeUncontrolled: true });

    // Intentamos enfocar una pestaña del mismo origen; si coincide exactamente, mejor
    for (const client of allClients) {
      // Mismo origen
      if (client.url && client.url.startsWith(self.location.origin)) {
        // Si ya está en la misma URL o es la app, enfocamos
        if (client.url === targetUrl || client.url === self.location.origin + "/") {
          if ("focus" in client) return client.focus();
        }
      }
    }
    // Abrir nueva pestaña si no encontramos una para enfocar
    if (clients.openWindow) return clients.openWindow(targetUrl);
  })());
});
