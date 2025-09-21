/* public/firebase-messaging-sw.js — v4 (debug) */
const SW_DEBUG_VERSION = 'v4-' + Date.now();

self.addEventListener('install', () => self.skipWaiting?.());
self.addEventListener('activate', (e) => {
  self.clients?.claim?.();
  console.log('[FM SW] activate', SW_DEBUG_VERSION);
});

self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (e) {
    try { payload = JSON.parse(event.data.text()); } catch {}
  }

  const data = payload?.data || {};
  const title =
    (typeof data.__title === 'string' && data.__title) ||
    (payload.notification?.title || '');
  const body =
    (typeof data.__body === 'string' && data.__body) ||
    (payload.notification?.body || '');

  console.log('[FM SW] push payload=', payload);
  console.log('[FM SW] using title/body=', { title, body });

  if (!title && !body) {
    // No mostrar nada si no viene contenido real
    return;
  }

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: (data.icon || '/icon-192.png'),
      badge: '/icon-192.png',
      data,
      tag: (data.tag || data.__tag || 'fcm-msg'),
      renotify: false,
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification?.data || {};
  const targetUrl = data.url || data.link || '/';

  event.waitUntil((async () => {
    const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const sameOrigin = clientsList.find((c) => c.url.startsWith(self.location.origin));
    if (sameOrigin) {
      sameOrigin.focus();
      try { sameOrigin.postMessage({ type: 'push-click', data }); } catch {}
    } else {
      await self.clients.openWindow(targetUrl);
    }
  })());
});
