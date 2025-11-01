// public/firebase-messaging-sw.js
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

function s(x){ return typeof x === 'string' ? x : (x == null ? '' : String(x)); }

/**
 * Mostramos notificación SOLO si:
 *  - viene payload.notification (Android visible), o
 *  - vienen data.__title / data.__body (desktop data-only controlada)
 */
messaging.onBackgroundMessage((payload) => {
  const data = payload?.data || {};
  const n = payload?.notification;

  const hasAdminData = typeof data.__title === 'string' || typeof data.__body === 'string';
  const hasNotification = !!n;

  if (!hasAdminData && !hasNotification) {
    // Silencio para evitar toasts genéricos (p.ej. updates en segundo plano)
    return;
  }

  const title = s(hasAdminData ? data.__title : n?.title) || 'Notificación';
  const body  = s(hasAdminData ? data.__body  : n?.body)  || '';
  const icon  = s(data.icon) || '/icon-192.png';

  const meta = { ...data };

  self.registration.showNotification(title, {
    body,
    icon,
    data: meta,
    tag: data.tag || undefined,
    renotify: !!data.tag,
  });
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const rawUrl = event.notification?.data?.url || '/';
  let targetUrl = rawUrl;
  try {
    targetUrl = rawUrl.startsWith('/')
      ? new URL(rawUrl, self.location.origin).toString()
      : new URL(rawUrl).toString();
  } catch {
    targetUrl = self.location.origin + '/';
  }

  event.waitUntil((async () => {
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url && c.url.startsWith(self.location.origin)) {
        if (c.url === targetUrl || c.url === self.location.origin + '/') {
          return c.focus && c.focus();
        }
      }
    }
    return clients.openWindow && clients.openWindow(targetUrl);
  })());
});
