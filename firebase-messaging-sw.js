// public/firebase-messaging-sw.js
// v3: data-only + fallback al evento 'push'
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyCWIev2L18k_TugAAIDEYREwsfFn0chdpQ",
  authDomain: "jesus-e7711.firebaseapp.com",
  projectId: "jesus-e7711",
  storageBucket: "jesus-e7711.appspot.com",
  messagingSenderId: "228736362294",
  appId: "1:228736362294:web:d34485861f9daccb9cf597",
  measurementId: "G-9QVKVW3YVD"
});

const messaging = firebase.messaging();

/**
 * Firebase handler — SOLO para payloads data-only
 * (si viene payload.notification, deja que el navegador lo dibuje solo).
 */
messaging.onBackgroundMessage((payload) => {
  if (payload && payload.notification) return;

  const data  = payload?.data || {};
  const title = data.__title || 'Notificación';
  const body  = data.__body  || '';
  const icon  = data.icon    || '/icon-192.png';

  self.registration.showNotification(title, { body, icon, data });
});

/**
 * Fallback robusto: si por algún motivo el handler de Firebase no corre,
 * capturamos el 'push' crudo y mostramos la notificación para payloads data-only.
 */
self.addEventListener('push', (event) => {
  if (!event.data) return;
  let raw = {};
  try { raw = event.data.json() || {}; } catch {}

  // FCM v1 suele venir como { data: {...}, notification?: {...} }
  if (raw.notification) return;      // si trae notification, deja al navegador
  const d = raw.data || raw || {};

  const title = d.__title || 'Notificación';
  const body  = d.__body  || '';
  const icon  = d.icon    || '/icon-192.png';

  event.waitUntil(
    self.registration.showNotification(title, { body, icon, data: d })
  );
});

// Click: enfocar/abrir la app (misma lógica que ya tenías)
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const rawUrl = event?.notification?.data?.url || '/';

  event.waitUntil((async () => {
    try {
      let targetUrl = '/';
      try {
        const u = new URL(rawUrl, self.location.origin);
        if (u.origin === self.location.origin) {
          targetUrl = u.pathname + u.search + u.hash;
        }
      } catch {}

      const clientList = await clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clientList) {
        try {
          const cu = new URL(client.url);
          if (cu.origin === self.location.origin) {
            if (targetUrl && (cu.pathname + cu.search + cu.hash) !== targetUrl && 'navigate' in client) {
              await client.navigate(targetUrl);
            }
            if ('focus' in client) await client.focus();
            return;
          }
        } catch {}
      }
      if (clients.openWindow) await clients.openWindow(targetUrl);
    } catch {
      if (clients.openWindow) await clients.openWindow('/');
    }
  })());
});
