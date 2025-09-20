// Usa compat en el Service Worker (recomendado)
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

// ✅ Config exactamente como en tu app web (storageBucket en appspot.com)
firebase.initializeApp({
  apiKey: "AIzaSyCWIev2L18k_TugAAIDEYREwsfFn0chdpQ",
  authDomain: "jesus-e7711.firebaseapp.com",
  projectId: "jesus-e7711",
  storageBucket: "jesus-e7711.appspot.com", // <-- cambio clave
  messagingSenderId: "228736362294",
  appId: "1:228736362294:web:d34485861f9daccb9cf597",
  measurementId: "G-9QVKVW3YVD"
});

const messaging = firebase.messaging();

// Mostrar notificaciones cuando la página está en 2º plano
messaging.onBackgroundMessage((payload) => {
  const title = payload?.notification?.title || 'Notificación';
  const body  = payload?.notification?.body  || '';
  const icon  = payload?.notification?.icon  || '/icon-192.png'; // opcional si tenés un ícono
  self.registration.showNotification(title, { body, icon, data: payload?.data || {} });
});

// (Opcional) Al hacer clic en la notificación, enfocar/abrir la app
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification?.data && event.notification.data.url) || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        // Si ya hay una pestaña abierta de tu sitio, enfocarla
        if ('focus' in client) return client.focus();
      }
      // Si no, abrir una nueva
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});
