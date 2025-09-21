/* public/firebase-messaging-sw.js */
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

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

const messaging = firebase.messaging();

// ÚNICA vía de render en background (evita duplicados)
messaging.onBackgroundMessage((payload) => {
  try { console.log('[SW] FCM payload:', payload); } catch {}

  const n = payload && payload.notification ? payload.notification : {};
  const d = payload && payload.data ? payload.data : {};

  // Prioridad a los campos “exactos” del admin
  const title = (d.__title != null ? d.__title : n.title) || 'Notificación';
  const body  = (d.__body  != null ? d.__body  : n.body)  || '';

  const opts = {
    body,
    icon: '/icon-192.png',
    badge: '/badge-72.png',
    tag: d.tag || 'general',
    renotify: true,
    data: {
      url: d.url || d.click_action || '/',
      raw: d
    }
  };

  self.registration.showNotification(title, opts);
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const rawUrl = (event.notification && event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    let target = '/';
    try {
      const u = new URL(rawUrl, self.location.origin);
      if (u.origin === self.location.origin) target = u.pathname + u.search + u.hash;
    } catch {}

    const clientsList = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of clientsList) {
      try {
        const cu = new URL(c.url);
        if (cu.origin === self.location.origin) {
          if ((cu.pathname + cu.search + cu.hash) !== target && 'navigate' in c) await c.navigate(target);
          if ('focus' in c) await c.focus();
          return;
        }
      } catch {}
    }
    if (clients.openWindow) await clients.openWindow(target);
  })());
});
