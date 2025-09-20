// public/firebase-messaging-sw.js
// v3 — evita duplicados, fuerza activación inmediata y colapsa stacking
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

// Forzar que este SW reemplace al anterior sin esperar
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (evt) => {
  evt.waitUntil(self.clients.claim());
});

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
 * ✅ Solo mostramos si el payload es data-only.
 * Si viene payload.notification, el navegador ya muestra el toast -> no hacemos nada.
 */
messaging.onBackgroundMessage((payload) => {
  if (payload && payload.notification) return; // evitar duplicado

  const d = payload?.data || {};
  const title = d.__title || d.title || 'Notificación';
  const body  = d.__body  || d.body  || '';
  const icon  = d.__icon  || d.icon  || '/icon-192.png';

  self.registration.showNotification(title, {
    body,
    icon,
    data: d,
    tag: 'global-push',   // colapsa múltiples en una sola
    renotify: true,       // vuelve a notificar si llega otra con mismo tag
    // Opcionales útiles en Android:
    // badge: '/badge-72.png',
    // vibrate: [80, 40, 80],
    // timestamp: Date.now(),
  });
});

// Click: enfocar o abrir app (misma origin)
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
