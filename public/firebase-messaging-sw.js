// v6 — data-only only, de-dupe window
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

const SW_VERSION = "2025-09-21_10";
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

// --- De-dupe simple en memoria (5s)
let lastKey = null;
let lastTs = 0;
function shouldShowOnce(key) {
  const now = Date.now();
  const ok = !(lastKey === key && (now - lastTs) < 5000);
  if (ok) { lastKey = key; lastTs = now; }
  return ok;
}

function drawDataOnlyNotification(d) {
  const title = d.__title || d.title || 'Notificación';
  const body  = d.__body  || d.body  || '';
  const icon  = d.icon    || '/icon-192.png';
  const badge = d.badge   || '/badge-72.png';
  const tag   = d.tag     || 'general';
  const url   = d.url || d.click_action || '/';

  const key = `${title}__${body}__${d.__id || d.id || d.ts || ''}`;
  if (!shouldShowOnce(key)) return;

  const options = {
    body, icon, badge, tag,
    renotify: true,
    data: { url, raw: d, swv: SW_VERSION },
  };
  return self.registration.showNotification(title, options);
}

// Solo dibujar si ES data-only (sin "notification")
messaging.onBackgroundMessage((payload) => {
  if (payload && payload.notification) return; // evitar duplicados con FCM UI
  const d = payload?.data || {};
  return drawDataOnlyNotification(d);
});

// Fallback: algunos navegadores entregan push crudo
self.addEventListener('push', (event) => {
  if (!event.data) return;
  let raw = {};
  try { raw = event.data.json() || {}; } catch {}
  if (raw && raw.notification) return; // evitar duplicado si FCM UI ya dibuja

  const d = raw?.data || raw || {};
  event.waitUntil(drawDataOnlyNotification(d));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const rawUrl = event?.notification?.data?.url || '/';

  event.waitUntil((async () => {
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
  })());
});
