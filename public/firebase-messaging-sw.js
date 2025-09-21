// public/firebase-messaging-sw.js
// v5 — data-only primero, fallback a 'push', auto-update del SW

importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

const SW_VERSION = "2025-09-21_06";
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (evt) => evt.waitUntil(self.clients.claim()));

firebase.initializeApp({
  apiKey: "AIzaSyCWIev2L18k_TugAAIDEYREwsfFn0chdpQ",
  authDomain: "jesus-e7711.firebaseapp.com",
  projectId: "jesus-e7711",
  // (Messaging no usa el bucket, pero este es el formato estándar:)
  storageBucket: "jesus-e7711.appspot.com",
  messagingSenderId: "228736362294",
  appId: "1:228736362294:web:d34485861f9daccb9cf597",
  measurementId: "G-9QVKVW3YVD"
});

const messaging = firebase.messaging();

/**
 * Handler Firebase — SOLO dibuja si el payload es "data-only".
 * Si llega payload.notification, dejamos que el navegador lo muestre (evita duplicados).
 */
messaging.onBackgroundMessage((payload) => {
  if (payload && payload.notification) return; // evitar doble notificación

  const d = payload?.data || {};
  const title = d.__title || d.title || 'Notificación';
  const body  = d.__body  || d.body  || '';
  const icon  = d.icon    || '/icon-192.png';
  const badge = d.badge   || '/badge-72.png';
  const tag   = d.tag     || 'general';

  self.registration.showNotification(title, {
    body,
    icon,
    badge,
    tag,
    renotify: true,
    data: {
      url: d.url || d.click_action || '/',
      raw: d,
      swv: SW_VERSION,
    },
  });
});

/**
 * Fallback (evento 'push'): si por algún motivo el handler anterior no corre,
 * mostramos la notificación para payloads data-only.
 */
self.addEventListener('push', (event) => {
  if (!event.data) return;
  let raw = {};
  try { raw = event.data.json() || {}; } catch {}

  if (raw && raw.notification) return; // si trae notification, que lo dibuje el navegador

  const d = raw?.data || raw || {};
  const title = d.__title || d.title || 'Notificación';
  const body  = d.__body  || d.body  || '';
  const icon  = d.icon    || '/icon-192.png';
  const badge = d.badge   || '/badge-72.png';
  const tag   = d.tag     || 'general';

  const options = {
    body,
    icon,
    badge,
    tag,
    renotify: true,
    data: {
      url: d.url || d.click_action || '/',
      raw: d,
      swv: SW_VERSION,
    },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

/**
 * Click en la notificación: enfocar/abrir la app y navegar a data.url (mismo origen).
 */
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
