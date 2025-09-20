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

// Mostrar notificaciones cuando la página está en 2º plano
messaging.onBackgroundMessage((payload) => {
  const title = payload?.notification?.title || 'Notificación';
  const body  = payload?.notification?.body  || '';
  const icon  = payload?.notification?.icon  || '/icon-192.png'; // opcional
  const data  = payload?.data || {};

  self.registration.showNotification(title, {
    body,
    icon,
    data,            // guardamos la data para usarla al click
    // tag: 'push',  // opcional (evita stacking)
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
        // Solo navegamos si es el mismo origen por seguridad
        if (u.origin === self.location.origin) targetUrl = u.pathname + u.search + u.hash;
      } catch { /* si falla, queda '/' */ }

      // ¿Ya hay una pestaña de este origen abierta?
      const clientList = await clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clientList) {
        try {
          const cu = new URL(client.url);
          if (cu.origin === self.location.origin) {
            // Si ya está en otra ruta, navegamos; luego enfocamos
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
    } catch (e) {
      // En caso de error, al menos intentamos abrir la home
      if (clients.openWindow) await clients.openWindow('/');
    }
  })());
});
