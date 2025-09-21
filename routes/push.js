// routes/push.js
const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const webpush = require("web-push");

const router = express.Router();

/**
 * ⚠️ IMPORTANTE
 * Este módulo implementa Web Push (VAPID) **separado de FCM**.
 * Para evitar DOBLE notificación y textos “de prueba”,
 * queda deshabilitado por defecto. Actívalo con ENABLE_WEB_PUSH=1.
 */
const ENABLE_WEB_PUSH = process.env.ENABLE_WEB_PUSH === "1";

// --- VAPID ---
const VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY  || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT     = process.env.VAPID_SUBJECT     || "mailto:jesusespanol@movilive.com";

// Unificamos con el resto del backend
const ADMIN_KEY = process.env.ADMIN_PUSH_KEY || process.env.ADMIN_KEY || "";

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

// --- almacenamiento simple en archivo ---
const DATA_DIR  = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const SUBS_PATH = path.join(DATA_DIR, "push_subs.json");

async function ensureData() {
  await fs.mkdir(DATA_DIR, { recursive: true }).catch(() => {});
  try {
    await fs.access(SUBS_PATH);
  } catch {
    await fs.writeFile(SUBS_PATH, "[]", "utf8");
  }
}
async function readSubs() {
  await ensureData();
  const raw = await fs.readFile(SUBS_PATH, "utf8");
  try { return JSON.parse(raw) || []; } catch { return []; }
}
async function writeSubs(list) {
  await ensureData();
  await fs.writeFile(SUBS_PATH, JSON.stringify(list, null, 2), "utf8");
}

const isSubValid = (s) =>
  s && typeof s.endpoint === "string" &&
  s.keys && typeof s.keys.p256dh === "string" && typeof s.keys.auth === "string";

// Middleware: si no está habilitado, todas estas rutas responden 410 (Gone)
router.use((req, res, next) => {
  if (!ENABLE_WEB_PUSH) {
    return res.status(410).json({ ok: false, error: "web_push_disabled" });
  }
  return next();
});

// POST /push/subscribe
router.post("/subscribe", async (req, res) => {
  try {
    const sub = req.body;
    if (!isSubValid(sub)) return res.status(400).json({ ok: false, error: "bad_subscription" });

    const list = await readSubs();
    const idx = list.findIndex((x) => x.endpoint === sub.endpoint);
    if (idx >= 0) list[idx] = sub;
    else list.push(sub);

    await writeSubs(list);
    res.json({ ok: true });
  } catch (e) {
    console.error("subscribe error:", e);
    res.status(500).json({ ok: false, error: "subscribe_failed" });
  }
});

// GET /push/status
router.get("/status", async (_req, res) => {
  const list = await readSubs();
  res.json({
    ok: true,
    count: list.length,
    hasVapid: Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY)
  });
});

// POST /push/broadcast — protegido con X-Admin-Key: ADMIN_PUSH_KEY
router.post("/broadcast", async (req, res) => {
  try {
    const adminKey = req.headers["x-admin-key"];
    if (!ADMIN_KEY || adminKey !== ADMIN_KEY) {
      return res.status(403).json({ ok: false, error: "forbidden" });
    }
    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
      return res.status(500).json({ ok: false, error: "missing_vapid" });
    }

    // 🚫 Sin defaults: si no mandan title/body => 400
    const { title, body, url = "/", data = null } = req.body || {};
    if (typeof title === "undefined" || typeof body === "undefined") {
      return res.status(400).json({ ok: false, error: "title_and_body_required" });
    }

    // Estructura que espera tu SW: __title / __body + data
    const payload = JSON.stringify({
      __title: String(title || ""),
      __body:  String(body  || ""),
      url: url || "/",
      ...(data && typeof data === "object" ? { data } : {})
    });

    const list = await readSubs();
    let sent = 0;
    const keep = [];

    for (const sub of list) {
      try {
        await webpush.sendNotification(sub, payload);
        sent++;
        keep.push(sub); // sigue válido
      } catch (err) {
        // 404/410 => endpoint inválido, se elimina
        if (err && (err.statusCode === 404 || err.statusCode === 410)) {
          // no agregar a keep => se remueve
        } else {
          // otros errores: conservamos la sub, registramos el error
          console.warn("webpush error:", err?.statusCode, err?.body || err?.message);
          keep.push(sub);
        }
      }
    }

    // persistimos depurados
    await writeSubs(keep);

    res.json({ ok: true, sent, removed: list.length - keep.length });
  } catch (e) {
    console.error("broadcast error:", e);
    res.status(500).json({ ok: false, error: "broadcast_failed" });
  }
});

module.exports = router;
