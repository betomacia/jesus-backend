// Usa compat en el Service Worker (recomendado)
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

// PEGÁ tu misma config aquí
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

// Opcional: cómo mostrar notificaciones cuando la página está en 2º plano
messaging.onBackgroundMessage((payload) => {
  const title = payload?.notification?.title || 'Notificación';
  const body  = payload?.notification?.body  || '';
  self.registration.showNotification(title, { body });
});
