/* public/firebase-messaging-sw.js */
// Versión para forzar actualización de SW
const SW_VERSION = "v4";

// Compat
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");

// INIT (igual a tu app)
firebase.initializeApp({
  apiKey: "AIzaSyCWIev2L18k_TugAAIDEYREwsfFn0chdpQ",
  authDomain: "jesus-e7711.firebaseapp.com",
  projectId: "jesus-e7711",
  storageBucket: "jesus-e7711.appspot.com",
  messagingSenderId: "228736362294",
  appId: "1:228736362294:web:d34485861f9daccb9cf597",
  measurementId: "G-9QVKVW3YVD",
});

const messaging = firebase.messaging();

// Garantizar que el SW nuevo tome control ya
self.addEventListener("install", (e) => {
  // console.log("[SW]", SW_VERSION, "install");
  self.skipWaiting();
});
self.addEventListener("activate", (e) => {
  // console.log("[SW]", SW_VERSION, "activate");
  e.waitUntil(self.clients.claim());
});

// Evita duplicados si dos listeners llegaran a disparar casi a la vez
let __lastShown = { ts: 0, title: "", body: "" };
function showToastSafe(title, body, data) {
  const now = Date.now();
  const dup =
    __lastShown.title === title &&
    __lastShown.body === body &&
    now - __lastShown.ts < 1500; // 1.5s
  if (dup) return;

  __lastShown = { ts: now, title, body };
  return self.registration.showNotification(title, {
    body,
    icon: "/icon-192.png",
    data,
  });
}

/**
 * Handler oficial de FCM para 2º plano.
 * Solo mostramos si es data-only (sin payload.notification).
 */
messaging.onBackgroundMessage((payload) => {
  // console.log("[SW:bg] payload", payload);
  if (payload && payload.notification) return; // el navegador mostraría su propia notificación
  const data = payload?.data || {};
  const title = data.__title || "Notificación";
  const body = data.__body || "";
  showToastSafe(title, body, data);
});

/**
 * Fallback: por si onBackgroundMessage no se dispara en ciertos entornos.
 * Solo actuamos si es data-only (sin notification) para no duplicar.
 */
self.addEventListener("push", (event) => {
  try {
    const payload = event?.data ? event.data.json() : {};
    // console.log("[SW:push] raw", payload);
    if (payload && payload.notification) return; // evitar duplicado

    const data = payload?.data || {};
    const title = data.__title || "Notificación";
    const body = data.__body || "";

    event.waitUntil(showToastSafe(title, body, data));
  } catch (e) {
    // console.log("[SW:push] parse error", e);
  }
});

// Click: abrir/enfocar la app
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const rawUrl = event?.notification?.data?.url || "/";

  event.waitUntil(
    (async () => {
      let targetUrl = "/";
      try {
        const u = new URL(rawUrl, self.location.origin);
        if (u.origin === self.location.origin) {
          targetUrl = u.pathname + u.search + u.hash;
        }
      } catch {}

      const clientsList = await clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const c of clientsList) {
        try {
          const cu = new URL(c.url);
          if (cu.origin === self.location.origin) {
            if ("navigate" in c && (cu.pathname + cu.search + cu.hash) !== targetUrl) {
              await c.navigate(targetUrl);
            }
            if ("focus" in c) await c.focus();
            return;
          }
        } catch {}
      }
      if (clients.openWindow) await clients.openWindow(targetUrl);
    })()
  );
});
