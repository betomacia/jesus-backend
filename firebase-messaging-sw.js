// public/firebase-messaging-sw.js
// Usa compat en el Service Worker (recomendado)
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

// ✅ Config EXACTA como en tu app web (usar appspot.com en storageBucket)
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
 * ✅ Solo mostrar notificación si el payload es data-only.
 * Si viene payload.notification, el navegador ya dibuja la notificación,
 * así que no hacemos nada para evitar duplicados.
 */
messaging.onBackgroundMessage((payload) => {
  // Si llega con notification -> la muestra el navegador; evitamos duplicado
  if (payload && payload.notification) return;

  // Data-only: tomar título/cuerpo desde data (compat con backend que envía __title/__body)
  const title = payload?.data?.__title || 'Notificación';
  const body  = payload?.data?.__body  || '';
  const icon  = payload?.data?.icon    || '/icon-192.png';
  const data  = payload?.data || {};

  self.registration.showNotification(title, {
    body,
    icon,
    data,
    // tag: 'push', // opcional si querés evitar stacking
  });
});

// Al hacer clic en la notificación: enfocar/abrir la app
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  // Podemos enviar una URL en data.url (debe ser mismo origen)
  const rawUrl = event?.notification?.data?.url || '/';

  event.waitUntil((async () => {
    try {
      // Normalizamos/validamos la URL respecto al origen del SW
      let targetUrl = '/';
      try {
        const u = new URL(rawUrl, self.location.origin);
        if (u.origin === self.location.origin) {
          targetUrl = u.pathname + u.search + u.hash;
        }
      } catch { /* si falla, queda '/' */ }

      // ¿Ya hay una pestaña de este origen abierta?
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

      // Si no había pestaña, abrimos una nueva
      if (clients.openWindow) {
        await clients.openWindow(targetUrl);
      }
    } catch {
      if (clients.openWindow) await clients.openWindow('/');
    }
  })());
});
