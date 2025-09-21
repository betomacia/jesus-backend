// public/firebase-messaging-sw.js
self.__SW_VERSION__ = 'v10';

importScripts('https://www.gstatic.com/firebasejs/9.6.11/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.6.11/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "TU_API_KEY",
  authDomain: "TU_AUTH_DOMAIN",
  projectId: "TU_PROJECT_ID",
  messagingSenderId: "TU_SENDER_ID",
  appId: "TU_APP_ID",
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const data = payload?.data || {};
  const title = data.__title || payload?.notification?.title || " ";
  const body  = data.__body  || payload?.notification?.body  || "";
  const url   = data.url || data.click_action || "/";
  const tag   = data.tag || `${data.device_id || 'web'}:${data.ts || Date.now()}`;

  self.registration.showNotification(title, {
    body,
    icon: "/icon-192.png",
    tag,
    data: { url, ...data },
    renotify: false,
    requireInteraction: false,
    actions: [], // sin acciones → no aparecen textos raros de “anular suscripción”
  });
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification?.data?.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientsArr) => {
      const page = clientsArr.find((c) => "focus" in c);
      if (page) return page.focus();
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});

self.addEventListener("install", (e) => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
