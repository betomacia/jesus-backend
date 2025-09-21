// public/firebase-messaging-sw.js
/* eslint-disable no-undef */
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyCWIev2L18k_TugAAIDEYREwsfFn0chdpQ",
  authDomain: "jesus-e7711.firebaseapp.com",
  projectId: "jesus-e7711",
  storageBucket: "jesus-e7711.firebasestorage.app",
  messagingSenderId: "228736362294",
  appId: "1:228736362294:web:d34485861f9daccb9cf597",
  measurementId: "G-9QVKVW3YVD"
});

self.addEventListener('install', () => {
  // tomar control de inmediato (evita “Este sitio se actualizó en segundo plano” en algunos casos)
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

const messaging = firebase.messaging();

/**
 * 📌 Manejamos *data-only* y también notification.*
 * Backend envía __title/__body dentro de data cuando webDataOnly=true.
 */
messaging.onBackgroundMessage((payload) => {
  try {
    const d = payload && payload.data ? payload.data : {};

    // Preferimos los campos de data (__title/__body). Si no, caemos a notification.*
    const title =
      (d.__title) ||
      (payload.notification && payload.notification.title) ||
      "";

    const body =
      (d.__body) ||
      (payload.notification && payload.notification.body) ||
      "";

    // Si no hay título ni cuerpo, no mostramos nada (evita “Notificación” por defecto)
    if (!title && !body) return;

    const icon = d.icon || '/icon-192.png';

    const options = {
      body,
      icon,
      data: d,                 // dejamos data para usar en el click
      tag: d.tag || undefined, // si querés colapsar por tag
      renotify: false,
    };

    self.registration.showNotification(title, options);
  } catch (e) {
    // silencioso
  }
});

/**
 * Click: si viene una URL en data.url, la abrimos o enfocamos.
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification && event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const same = allClients.find(c => c.url.includes(url));
    if (same) return same.focus();
    if (self.clients && self.clients.openWindow) {
      return self.clients.openWindow(url);
    }
  })());
});
