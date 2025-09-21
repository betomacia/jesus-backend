// public/firebase-messaging-sw.js
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

const messaging = firebase.messaging();

// Data-only o mixta: prioriza data.__title/__body; si no hay, usa notification
messaging.onBackgroundMessage((payload) => {
  const d = payload && payload.data ? payload.data : {};
  const title =
    (d.__title && String(d.__title)) ||
    (payload.notification && payload.notification.title) ||
    "Notificación";

  const body =
    (d.__body && String(d.__body)) ||
    (payload.notification && payload.notification.body) ||
    "";

  const icon = d.icon || "/icon-192.png";

  const ndata = {};
  // Copiamos todo data para usarlo en click
  if (payload && payload.data) {
    Object.keys(payload.data).forEach((k) => (ndata[k] = payload.data[k]));
  }

  self.registration.showNotification(title, {
    body,
    icon,
    data: ndata,
  });
});

// Click: si viene data.url la abrimos/enfocamos
self.addEventListener("notificationclick", (event) => {
  const url = (event.notification && event.notification.data && event.notification.data.url) || "/";
  event.notification.close();

  event.waitUntil((async () => {
    const allClients = await clients.matchAll({ type: "window", includeUncontrolled: true });
    const found = allClients.find((c) => c.url.includes(url));
    if (found) {
      found.focus();
      return;
    }
    await clients.openWindow(url);
  })());
});
