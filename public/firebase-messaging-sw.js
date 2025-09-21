/* public/firebase-messaging-sw.js */
/* FCM v9 compat en SW */
importScripts("https://www.gstatic.com/firebasejs/9.6.11/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/9.6.11/firebase-messaging-compat.js");

/* ⚠️ PONÉ TU CONFIG REAL */
firebase.initializeApp({
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID",
});

const messaging = firebase.messaging();

/**
 * Helper: arma opciones de notificación SOLO con lo que llega en data.
 * Nada de “Notificación” ni “Tienes un mensaje.” por defecto.
 */
function buildOptionsFromData(data) {
  const title = (data && data.__title) ? String(data.__title) : "";
  const body  = (data && data.__body)  ? String(data.__body)  : "";
  const icon  = data && data.icon ? data.icon : "/icon-192.png";

  // Si no vino título NI cuerpo => no mostramos nada (evita “Notificación” genérica)
  if (!title && !body) return null;

  const opts = {
    body,
    icon,
    badge: "/icon-192.png",
    data: data || {},
    tag: (data && data.tag) || (data && data.__tag) || "fcm-msg",   // colapsa duplicados
    renotify: false,
  };
  return { title, opts };
}

/* FCM: background messages (cuando no hay foco) */
messaging.onBackgroundMessage((payload) => {
  const data = (payload && payload.data) || {};
  const built = buildOptionsFromData(data);
  if (!built) return; // no title/body => no mostrar nada
  self.registration.showNotification(built.title, built.opts);
});

/* Por si el navegador entrega como push “crudo” */
self.addEventListener("push", (event) => {
  try {
    const json = event.data ? event.data.json() : null;
    const data = (json && (json.data || json)) || {};
    const built = buildOptionsFromData(data);
    if (!built) return;
    event.waitUntil(self.registration.showNotification(built.title, built.opts));
  } catch (e) {
    // silencioso
  }
});

/* Click: abrir o enfocar pestaña */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && (event.notification.data.url || event.notification.data.__url)) || "/";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clis) => {
      for (const c of clis) {
        if (c.url.includes(url) && "focus" in c) return c.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
