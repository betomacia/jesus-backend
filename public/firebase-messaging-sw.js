// public/firebase-messaging-sw.js
/* FCM Web SW – v3 */
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyCWIev2L18k_TugAAIDEYREwsfFn0chdpQ",
  authDomain: "jesus-e7711.firebaseapp.com",
  projectId: "jesus-e7711",
  storageBucket: "jesus-e7711.firebasestorage.app",
  messagingSenderId: "228736362294",
  appId: "1:228736362294:web:d34485861f9daccb9cf597",
  measurementId: "G-9QVKVW3YVD"
});

const messaging = firebase.messaging();

// --------- util: construir notificación desde payload ----------
function buildFromPayload(payload) {
  // FCM data-only => va en payload.data
  const d = (payload && payload.data) ? payload.data : {};
  // Si vino notification (Android sistémico), igual priorizamos data si están los campos
  const n = (payload && payload.notification) ? payload.notification : {};

  const title = (d.__title != null ? String(d.__title) : (n.title || "")).trim();
  const body  = (d.__body  != null ? String(d.__body)  : (n.body  || "")).trim();

  // No mostrar “Notificación” por defecto: si no hay nada, no mostramos.
  if (!title && !body) return null;

  const icon  = d.icon  || n.icon  || "/icon-192.png";
  const badge = d.badge || n.badge || "/icon-192.png";
  const image = d.image || n.image || undefined;

  const tag   = d.tag || "push-admin";        // mismo tag para reemplazar, no apilar
  const url   = d.url || d.click_action || "/";

  const data  = Object.assign({}, d, { __open_url: url });

  return {
    title,
    options: {
      body,
      icon,
      badge,
      image,
      data,
      tag,
      renotify: false,
      requireInteraction: false,
      // Evita “este sitio se actualizó…”: no usamos skipWaiting/clientsClaim acá.
      silent: false
    }
  };
}

// --------- onBackgroundMessage (canal oficial FCM) ----------
messaging.onBackgroundMessage((payload) => {
  try {
    const built = buildFromPayload(payload);
    if (!built) return; // nada que mostrar
    self.registration.showNotification(built.title, built.options);
  } catch (e) {
    // log minimal en SW
    // console.error no siempre aparece en todos los browsers, igual lo dejamos.
    try { console.error('SW onBackgroundMessage error:', e); } catch {}
  }
});

// --------- listener ‘push’ (fallback y debug) ----------
self.addEventListener('push', (event) => {
  try {
    let payload = {};
    if (event.data) {
      try { payload = event.data.json(); } catch { payload = {}; }
    }
    const built = buildFromPayload(payload);
    if (!built) return;
    event.waitUntil(self.registration.showNotification(built.title, built.options));
  } catch (e) {
    try { console.error('SW push event error:', e); } catch {}
  }
});

// --------- click: abrir o enfocar la app ----------
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification && event.notification.data && event.notification.data.__open_url) || '/';
  event.waitUntil((async () => {
    const allClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of allClients) {
      // Si ya hay una pestaña con la app, enfócala
      try {
        const u = new URL(c.url);
        if (u.origin === location.origin) {
          await c.focus();
          try { c.navigate(url); } catch {}
          return;
        }
      } catch {}
    }
    // Si no hay, abrir nueva
    await clients.openWindow(url);
  })());
});
