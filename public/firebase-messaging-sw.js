// public/firebase-messaging-sw.js
/* Fuerza update del SW */
self.__SW_VERSION__ = 'v9';

/* Compat SDK (robusto en navegadores viejos) */
importScripts('https://www.gstatic.com/firebasejs/9.6.11/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.6.11/firebase-messaging-compat.js');

/* 👇 Pega tu config (la misma que usas en el front) */
firebase.initializeApp({
  apiKey: "TU_API_KEY",
  authDomain: "TU_AUTH_DOMAIN",
  projectId: "TU_PROJECT_ID",
  messagingSenderId: "TU_SENDER_ID",
  appId: "TU_APP_ID",
});

const messaging = firebase.messaging();

/* ⚠️ ÚNICO lugar que muestra la notificación (sin defaults raros) */
messaging.onBackgroundMessage((payload) => {
  const data = payload?.data || {};
  const title = data.__title || payload?.notification?.title || " ";
  const body  = data.__body  || payload?.notification?.body  || "";

  // URL destino (si viene del admin, quedará acá)
  const url = data.url || data.click_action || "/";

  // Tag para evitar “agrupaciones raras” del navegador
  const tag = data.tag || `${data.device_id || 'web'}:${data.ts || Date.now()}`;

  const options = {
    body,
    icon: "/icon-192.png",
    data: { url, ...data },
    tag,
    renotify: false,
    requireInteraction: false,
    actions: [], // sin acciones extra (evita textos raros tipo “Anular suscripción”)
  };

  self.registration.showNotification(title, options);
});

/* Click: enfocar o abrir la app */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification?.data?.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientsArr) => {
      const had = clientsArr.find((c) => "focus" in c);
      if (had) return had.focus();
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});

/* Vida del SW */
self.addEventListener("install", (e) => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

/* ✅ Importante: NO agregues también un `self.addEventListener("push", ...)`. 
   Con esto solo alcanza y evita duplicados/textos hardcodeados.
*/
