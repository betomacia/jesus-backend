/* public/firebase-messaging-sw.js — v3 (debug) */
const SW_DEBUG_VERSION = 'v3-' + Date.now();

self.addEventListener('install', (e) => {
  // fuerzo actualización del archivo en clientes nuevos
  self.skipWaiting?.();
});

self.addEventListener('activate', (e) => {
  self.clients?.claim?.();
  // pequeño ping para ver que activó
  console.log('[FM SW] activate', SW_DEBUG_VERSION);
});

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    // algunos navegadores entregan texto plano
    try { payload = JSON.parse(event.data.text()); } catch {}
  }

  const data = payload?.data || {};
  const title =
    (typeof data.__title === 'string' ? data.__title : (payload.notification?.title || '')) || '';
  const body =
    (typeof data.__body  === 'string' ? data.__body  : (payload.notification?.body  || '')) || '';
  const icon = (typeof data.icon === 'string' && data.icon) || '/icon-192.png';
  const tag  = (typeof data.tag  === 'string' && data.tag)  ||
               (typeof data.__tag === 'string' && data.__tag) || 'fcm-msg';

  // LOG COMPLETO EN CONSOLA DEL SW
  console.log('[FM SW] push payload=', payload);
  console.log('[FM SW] using title/body=', { title, body });

  if (!title && !body) {
    // si no vino nada útil, no mostramos notificación
    return;
  }

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon,
      badge: '/icon-192.png',
      data: data,
      tag,
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
