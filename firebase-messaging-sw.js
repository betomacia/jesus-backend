// public/firebase-messaging-sw.js
// v5 — data-only first, fallback a 'push', auto-update SW

importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

// --- Forzar update del SW cada vez que cambie este valor ---
const SW_VERSION = "2025-09-21_09"; // súbelo cuando quieras forzar otro update
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

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

/**
 * BACKGROUND (Firebase) — pensado para payloads "data-only".
 * Si viene payload.notification, dejamos que el navegador lo dibuje (evita duplicados).
 */
messaging.onBackgroundMessage((payload) => {
  // Si el backend llegara a mandar "notification", no hacemos nada aquí
  if (payload && payload.notification) return;

  const d = payload?.data || {};
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

  self.registration.showNotification(title, options);
});

/**
 * Fallback robusto (evento 'push'): si por algún motivo el handler anterior no corre,
 * mostramos la notificación para payloads data-only que lleguen como push crudo.
 * Nota: si el push trae "notification", dejamos que el navegador lo muestre (para no duplicar).
 */
self.addEventListener('push', (event) => {
  if (!event.data) return;
  let raw = {};
  try { raw = event.data.json() || {}; } catch {}

  if (raw && raw.notification) return; // evitar duplicados cuando FCM ya dibuja

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
 * Click: enfocar o abrir la app y navegar a data.url (si es del mismo origen).
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

      // Reutiliza una pestaña del mismo origen si existe
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

      // O abre una ventana nueva
      if (clients.openWindow) await clients.openWindow(targetUrl);
    } catch {
      if (clients.openWindow) await clients.openWindow('/');
    }
  })());
});
