const express = require("express");
const { query } = require("./db");

// Servicios (modulares)
const {
  findUserByEmail,
  upsertUser,
  ensureUserId,
} = require("../services/user.service");

const {
  addCredit,
  getBalance,
  spend,
} = require("../services/credit.service");

const {
  addMessage,
  getHistory,
  deleteById,
  deleteMany,
  deleteBefore,
} = require("../services/message.service");

const {
  ensureDevicesTable,
  registerDevice,
  listDevicesByUser,
  sendSimpleToUser,
  listDevicesForBroadcast, // 👈 NUEVO
} = require("../services/push.service");

const router = express.Router();
const ADMIN_PUSH_KEY = process.env.ADMIN_PUSH_KEY || null;

/* ====== CORS para TODO /users (incluye preflight) ====== */
router.use((req, res, next) => {
  const origin = req.headers.origin || "*";
  res.header("Access-Control-Allow-Origin", origin);
  res.header("Vary", "Origin");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  // 👇 añadimos X-Admin-Key
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-User-Email, X-Admin-Key");
  res.header("Access-Control-Max-Age", "600"); // cachea preflight unos minutos

  if (req.method === "OPTIONS") {
    // Preflight: responder sin cuerpo JSON
    return res.status(204).end();
  }
  next();
});

/* ====== Fuerza respuestas JSON en UTF-8 para TODO este router ====== */
router.use((req, res, next) => {
  res.set("Content-Type", "application/json; charset=utf-8");
  next();
});

/* ====== Middleware simple de Admin (Header: X-Admin-Key) ====== */
function requireAdmin(req, res, next) {
  const key = (req.get("x-admin-key") || "").toString();
  if (!ADMIN_PUSH_KEY || key !== ADMIN_PUSH_KEY) {
    return res.status(401).json({ ok: false, error: "unauthorized_admin" });
  }
  next();
}

/* ============== Health & Register ============== */
router.get("/health", async (_req, res) => {
  try {
    const r = await query(`SELECT NOW() AS now`);
    res.json({ ok: true, db: true, now: r?.[0]?.now ?? null });
  } catch (e) {
    res.status(500).json({ ok: false, error: "db_error", detail: e.message || String(e) });
  }
});

router.post("/register", async (req, res) => {
  try {
    const { email, lang = null, platform = null } = req.body || {};
    const normEmail = String(email || "").trim().toLowerCase();
    if (!normEmail) return res.status(400).json({ ok: false, error: "email_required" });

    const user = await upsertUser(normEmail, lang, platform ? String(platform).trim().toLowerCase() : null);
    res.json({ ok: true, user });
  } catch (e) {
    res.status(500).json({ ok: false, error: "users_register_failed", detail: e.message || String(e) });
  }
});

/* ============== Créditos ============== */
router.post("/credit/add", async (req, res) => {
  try {
    const {
      user_id = null,
      email = null,
      delta = 0,
      reason = null,
      lang = null,
      platform = null,
    } = req.body || {};

    const uid = await ensureUserId({
      user_id,
      email: email ? String(email).trim().toLowerCase() : null,
      lang,
      platform: platform ? String(platform).trim().toLowerCase() : null,
    });
    const amount = Number.parseInt(delta, 10) || 0;

    const balance = await addCredit({ uid, delta: amount, reason: reason || null });
    res.json({ ok: true, user_id: uid, balance });
  } catch (e) {
    res.status(500).json({ ok: false, error: "credit_add_failed", detail: e.message || String(e) });
  }
});

router.get("/credit/balance", async (req, res) => {
  try {
    const { user_id = null, email = null } = req.query || {};
    let uid = user_id ? Number(user_id) : null;

    if (!uid && email) {
      const u = await findUserByEmail(String(email).trim().toLowerCase());
      if (!u) return res.json({ ok: true, user_id: null, balance: 0 });
      uid = u.id;
    }
    if (!uid) return res.status(400).json({ ok: false, error: "user_id_or_email_required" });

    const balance = await getBalance({ uid });
    res.json({ ok: true, user_id: uid, balance });
  } catch (e) {
    res.status(500).json({ ok: false, error: "credit_balance_failed", detail: e.message || String(e) });
  }
});

router.post("/credit/spend", async (req, res) => {
  try {
    const {
      user_id = null,
      email = null,
      amount = 1,
      reason = "spend",
      lang = null,
      platform = null,
    } = req.body || {};

    const uid = await ensureUserId({
      user_id,
      email: email ? String(email).trim().toLowerCase() : null,
      lang,
      platform: platform ? String(platform).trim().toLowerCase() : null,
    });
    const amt = Math.max(1, Number.parseInt(amount, 10) || 1);
    const r = await spend({ uid, amount: amt, reason: String(reason || "spend") });

    if (r && r.ok === false) {
      return res.json(r);
    }
    res.json({ ok: true, user_id: uid, spent: r.spent, reason: String(reason || "spend"), balance: r.balance });
  } catch (e) {
    res.status(500).json({ ok: false, error: "credit_spend_failed", detail: e.message || String(e) });
  }
});

/* ============== Mensajes (90 días calendario) ============== */
router.post("/message/add", async (req, res) => {
  try {
    const {
      user_id = null,
      email = null,
      role,
      content,
      text,
      lang = null,
      client_ts = null,
    } = req.body || {};

    const uid = await ensureUserId({
      user_id,
      email: email ? String(email).trim().toLowerCase() : null,
    });

    let msgText;
    if (typeof text === "string") msgText = text;
    else if (typeof content === "string") msgText = content;
    else msgText = String(text ?? content ?? "");

    if (!msgText.trim()) {
      return res.status(400).json({ ok: false, error: "message_text_required" });
    }

    const r = await addMessage({
      uid,
      role: (role || "user").toString(),
      text: msgText,
      lang: lang || null,
      client_ts: client_ts || null,
    });

    res.json({ ok: true, id: r?.id ?? null, created_at: r?.created_at ?? null });
  } catch (e) {
    res.status(500).json({ ok: false, error: "message_add_failed", detail: e.message || String(e) });
  }
});

router.get("/message/history", async (req, res) => {
  try {
    const { user_id = null, email = null } = req.query || {};
    let uid = user_id ? Number(user_id) : null;

    if (!uid && email) {
      const u = await findUserByEmail(String(email).trim().toLowerCase());
      if (!u) return res.json({ ok: true, user_id: null, items: [] });
      uid = u.id;
    }
    if (!uid) return res.status(400).json({ ok: false, error: "user_id_or_email_required" });

    const rawLimit = Number.parseInt(req.query.limit, 10);
    const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 50, 1), 200);

    const items = await getHistory({ uid, limit });
    res.json({ ok: true, user_id: uid, items });
  } catch (e) {
    res.status(500).json({ ok: false, error: "message_history_failed", detail: e.message || String(e) });
  }
});

router.post("/message/delete", async (req, res) => {
  try {
    const {
      email = null,
      user_id = null,
      id = null,
      ids = null,
      before = null,
    } = req.body || {};

    let uid = user_id ? Number(user_id) : null;
    if (!uid && email) {
      const u = await findUserByEmail(String(email).trim().toLowerCase());
      if (!u) return res.status(404).json({ ok: false, error: "user_not_found" });
      uid = u.id;
    }
    if (!uid) return res.status(400).json({ ok: false, error: "user_id_or_email_required" });

    if (id) {
      const deleted_id = await deleteById({ uid, id: Number(id) });
      return res.json({ ok: true, deleted_id });
    }

    if (Array.isArray(ids) && ids.length > 0) {
      const arr = ids.map((n) => Number(n)).filter((n) => Number.isInteger(n));
      if (!arr.length) return res.status(400).json({ ok: false, error: "bad_ids" });
      const { deleted, ids: deleted_ids } = await deleteMany({ uid, ids: arr });
      return res.json({ ok: true, deleted, deleted_ids });
    }

    if (before) {
      const ts = new Date(before);
      if (isNaN(ts)) return res.status(400).json({ ok: false, error: "bad_before" });
      const deleted = await deleteBefore({ uid, iso: ts.toISOString() });
      return res.json({ ok: true, deleted });
    }

    return res.status(400).json({ ok: false, error: "missing_params" });
  } catch (e) {
    res.status(500).json({ ok: false, error: "message_delete_failed", detail: e.message || String(e) });
  }
});

/* ============== Dispositivos & Push ============== */
// ✅ Registra aunque la app no mande email, usando fallback.
//    Normaliza platform a 'web' si no viene (Android Chrome WebPush suele ser web).
router.post("/push/register", async (req, res) => {
  try {
    await ensureDevicesTable();

    const {
      user_id = null,
      email = null,
      platform = null,
      fcm_token = null,
      device_id = null,
      lang = null,
      tz_offset_minutes = null,
      app_version = null,
      os_version = null,
      model = null,
    } = req.body || {};

    if (!fcm_token) {
      return res.status(400).json({ ok: false, error: "fcm_token_required" });
    }

    const DEFAULT_TEST_EMAIL = process.env.DEFAULT_TEST_EMAIL || "info@movilive.com";
    const resolvedEmail = (email || req.get("x-user-email") || DEFAULT_TEST_EMAIL || "")
      .toString()
      .trim()
      .toLowerCase();

    if (!user_id && !resolvedEmail) {
      return res.status(400).json({ ok: false, error: "user_id_or_email_required" });
    }

    const plat = platform ? String(platform).trim().toLowerCase() : "web";

    const uid = await ensureUserId({
      user_id,
      email: resolvedEmail,
      lang,
      platform: plat,
    });

    const device = await registerDevice({
      uid,
      platform: plat,
      fcm_token: String(fcm_token),
      device_id: device_id ? String(device_id) : null,
      lang: lang || null,
      tz_offset_minutes: Number.isFinite(+tz_offset_minutes) ? +tz_offset_minutes : null,
      app_version: app_version || null,
      os_version: os_version || null,
      model: model || null,
    });

    res.json({ ok: true, device });
  } catch (e) {
    res.status(500).json({ ok: false, error: "push_register_failed", detail: e.message || String(e) });
  }
});

router.get("/push/devices", async (req, res) => {
  try {
    await ensureDevicesTable();

    const { user_id = null, email = null, platform = null } = req.query || {};
    const uid = await ensureUserId({
      user_id,
      email: email ? String(email).trim().toLowerCase() : null,
    });

    const plat = platform ? String(platform).trim().toLowerCase() : null;
    const devs = await listDevicesByUser({
      uid,
      platform: plat || null,
    });

    res.json({ ok: true, user_id: uid, devices: devs });
  } catch (e) {
    res.status(500).json({ ok: false, error: "push_devices_failed", detail: e.message || String(e) });
  }
});

/* === Desregistrar token/dispositivo === */
router.post("/push/unregister", async (req, res) => {
  try {
    await ensureDevicesTable();

    const {
      user_id = null,
      email = null,
      platform = null,   // opcional: 'web' | 'android' | 'ios'
      fcm_token = null,  // opción A (recomendada)
      device_id = null,  // opción B (si no tienes el token)
    } = req.body || {};

    // uid es opcional para borrar por token, pero lo aceptamos para acotar
    let uid = null;
    if (user_id || email) {
      uid = await ensureUserId({
        user_id,
        email: email ? String(email).trim().toLowerCase() : null,
      });
    }

    let deletedRows = [];
    if (fcm_token) {
      const params = [String(fcm_token)];
      let where = `fcm_token = $1`;

      if (uid) {
        params.push(uid);
        where += ` AND user_id = $2`;
      }
      if (platform) {
        const plat = String(platform).trim().toLowerCase();
        params.push(plat);
        where += ` AND platform = $${params.length}`;
      }

      deletedRows = await query(
        `DELETE FROM devices WHERE ${where}
         RETURNING id, user_id, platform, device_id, fcm_token`,
        params
      );
    } else if (device_id) {
      if (!uid) {
        return res.status(400).json({ ok: false, error: "user_id_or_email_required_for_device_id" });
      }
      const params = [uid, String(device_id)];
      let where = `user_id = $1 AND device_id = $2`;
      if (platform) {
        const plat = String(platform).trim().toLowerCase();
        params.push(plat);
        where += ` AND platform = $${params.length}`;
      }

      deletedRows = await query(
        `DELETE FROM devices WHERE ${where}
         RETURNING id, user_id, platform, device_id, fcm_token`,
        params
      );
    } else {
      return res.status(400).json({ ok: false, error: "fcm_token_or_device_id_required" });
    }

    res.json({
      ok: true,
      deleted: deletedRows.length,
      devices: deletedRows.map((r) => ({
        id: r.id,
        user_id: r.user_id,
        platform: r.platform,
        device_id: r.device_id,
        fcm_token: r.fcm_token,
      })),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: "push_unregister_failed", detail: e.message || String(e) });
  }
});

/* ============== Envío simple (con filtros) ============== */
router.post("/push/send-simple", async (req, res) => {
  try {
    await ensureDevicesTable();

    const {
      user_id = null,
      email = null,
      title = null,
      body = null,
      title_i18n = null,
      body_i18n = null,
      data = null,
      platform = null,     // 'web' | 'android' | 'ios' (opcional)
      lang = null,         // override opcional
      device_id = null,    // filtrar un device específico
      fcm_token = null,    // o filtrar por token exacto
      webDataOnly = true,  // por defecto evitar doble toast en Web
    } = req.body || {};

    // Resolver usuario
    const uid = await ensureUserId({
      user_id,
      email: email ? String(email).trim().toLowerCase() : null,
    });

    const user = (await query(`SELECT id, lang FROM users WHERE id=$1`, [uid]))[0] || {};

    // Normalizar platform si viene
    const plat = platform ? String(platform).trim().toLowerCase() : null;
    const allowed = new Set(["web", "android", "ios"]);
    const platFilter = plat && allowed.has(plat) ? plat : null;

    // Traer devices base
    let devices = await listDevicesByUser({ uid, platform: platFilter });

    // Filtros finos
    if (device_id) {
      const did = String(device_id).trim();
      devices = devices.filter(d => String(d.device_id || "") === did);
    }
    if (fcm_token) {
      const tok = String(fcm_token).trim();
      devices = devices.filter(d => String(d.fcm_token) === tok);
    }

    if (!devices.length) {
      return res.status(404).json({ ok: false, error: "no_devices_for_user" });
    }

    const report = await sendSimpleToUser({
      user,
      devices,
      title: title || null,
      body: body || null,
      title_i18n: title_i18n || null,
      body_i18n: body_i18n || null,
      data: data || null,
      overrideLang: lang || null,
      webDataOnly: !!webDataOnly,
    });

    res.json({ ok: true, user_id: uid, targeted: devices.length, ...report });
  } catch (e) {
    res.status(500).json({ ok: false, error: "push_send_failed", detail: e.message || String(e) });
  }
});

/* ========= ENVÍO ADMIN A 1+ USUARIOS ESPECÍFICOS =========
   POST /users/push/admin-send
   Headers: X-Admin-Key: <clave>
   Body:
   {
     emails: ["a@b.com","c@d.com"],   // ó user_ids: [1,2] (uno de los dos)
     platform: "web"|"android"|"ios", // opcional
     device_id: "ANDROID_CHROME_XXXX",// opcional (si querés 1 device)
     fcm_token: "token...",           // opcional (envío directo por token)
     title, body, title_i18n, body_i18n, data,
     webDataOnly: true
   }
*/
router.post("/push/admin-send", requireAdmin, async (req, res) => {
  try {
    await ensureDevicesTable();
    const {
      emails = null,
      user_ids = null,
      platform = null,
      device_id = null,
      fcm_token = null,
      title = null,
      body = null,
      title_i18n = null,
      body_i18n = null,
      data = null,
      webDataOnly = true,
    } = req.body || {};

    // Resolver lista de usuarios
    let users = [];
    if (Array.isArray(user_ids) && user_ids.length) {
      const ids = user_ids.filter((x) => Number.isFinite(+x)).map((x) => +x);
      if (!ids.length) return res.status(400).json({ ok: false, error: "bad_user_ids" });
      users = await query(`SELECT id, lang FROM users WHERE id = ANY($1)`, [ids]);
    } else if (Array.isArray(emails) && emails.length) {
      const norm = emails.map((e) => String(e || "").trim().toLowerCase()).filter(Boolean);
      if (!norm.length) return res.status(400).json({ ok: false, error: "bad_emails" });
      users = await query(`SELECT id, lang FROM users WHERE email = ANY($1)`, [norm]);
    } else if (fcm_token) {
      // Envío directo por token (sin usuarios)
      const devices = [{ user_id: null, id: null, platform: platform || "web", device_id: device_id || null, fcm_token: String(fcm_token), lang: "es" }];
      const report = await sendSimpleToUser({
        user: {}, devices,
        title, body, title_i18n, body_i18n, data,
        overrideLang: null, webDataOnly: !!webDataOnly,
      });
      return res.json({ ok: true, targeted: devices.length, ...report });
    } else {
      return res.status(400).json({ ok: false, error: "emails_or_user_ids_or_fcm_token_required" });
    }

    if (!users.length) return res.status(404).json({ ok: false, error: "users_not_found" });

    const plat = platform ? String(platform).trim().toLowerCase() : null;
    const allowed = new Set(["web", "android", "ios"]);
    const platFilter = plat && allowed.has(plat) ? plat : null;

    // Traer devices por usuario (aplicando filtros finos si vienen)
    let targetedDevices = [];
    for (const u of users) {
      let devs = await listDevicesByUser({ uid: u.id, platform: platFilter });
      if (device_id) devs = devs.filter(d => String(d.device_id || "") === String(device_id));
      if (fcm_token) devs = devs.filter(d => String(d.fcm_token) === String(fcm_token));
      if (devs.length) targetedDevices.push({ user: u, devices: devs });
    }

    if (!targetedDevices.length) {
      return res.status(404).json({ ok: false, error: "no_devices_for_target_users" });
    }

    // Enviar por usuario para respetar lang
    let sent = 0, failed = 0, targeted = 0;
    const summary = [];
    for (const td of targetedDevices) {
      const r = await sendSimpleToUser({
        user: td.user,
        devices: td.devices,
        title, body, title_i18n, body_i18n, data,
        overrideLang: null,
        webDataOnly: !!webDataOnly,
      });
      sent   += r.sent;
      failed += r.failed;
      targeted += td.devices.length;
      summary.push({ user_id: td.user.id, sent: r.sent, failed: r.failed, results: r.results });
    }

    res.json({ ok: true, targeted, sent, failed, by_user: summary });
  } catch (e) {
    res.status(500).json({ ok: false, error: "admin_send_failed", detail: e.message || String(e) });
  }
});

/* ========= BROADCAST ADMIN (segmentable) =========
   POST /users/push/admin-broadcast
   Headers: X-Admin-Key: <clave>
   Body:
   {
     platform: "web"|"android"|"ios",  // opcional (default: todos)
     lastSeenDays: 30,                 // opcional (default 30)
     groupByUser: true,                // default true => 1 device por usuario
     preferPrefix: "ANDROID_CHROME",   // prioriza ese device_id
     limit: 500,                       // límite duro de dispositivos
     title, body, title_i18n, body_i18n, data,
     webDataOnly: true
   }
*/
router.post("/push/admin-broadcast", requireAdmin, async (req, res) => {
  try {
    await ensureDevicesTable();

    const {
      platform = null,
      lastSeenDays = 30,
      groupByUser = true,
      preferPrefix = "ANDROID_CHROME",
      limit = 500,
      title = null,
      body = null,
      title_i18n = null,
      body_i18n = null,
      data = null,
      webDataOnly = true,
    } = req.body || {};

    // 1) Resolver candidatos
    const devs = await listDevicesForBroadcast({
      platform: platform ? String(platform).trim().toLowerCase() : null,
      lastSeenDays: Number.isFinite(+lastSeenDays) ? +lastSeenDays : 30,
      groupByUser: !!groupByUser,
      preferPrefix: String(preferPrefix || "ANDROID_CHROME"),
      limit: Math.min(Math.max(parseInt(limit, 10) || 500, 1), 10000),
    });

    if (!devs || !devs.length) {
      return res.status(404).json({ ok: false, error: "no_devices_for_broadcast" });
    }

    // 2) Traer langs de usuarios involucrados (si groupByUser)
    let usersById = {};
    if (groupByUser) {
      const ids = [...new Set(devs.map(d => d.user_id).filter(Boolean))];
      if (ids.length) {
        const rows = await query(`SELECT id, lang FROM users WHERE id = ANY($1)`, [ids]);
        for (const r of rows) usersById[r.id] = r;
      }
    }

    // 3) Enviar por usuario (si groupByUser), o en un batch único
    let sent = 0, failed = 0, targeted = devs.length;
    const results = [];

    if (groupByUser) {
      // agrupar
      const map = new Map();
      for (const d of devs) {
        if (!map.has(d.user_id)) map.set(d.user_id, []);
        map.get(d.user_id).push(d);
      }
      for (const [uid, arr] of map.entries()) {
        const user = usersById[uid] || {};
        const r = await sendSimpleToUser({
          user,
          devices: arr,
          title, body, title_i18n, body_i18n, data,
          overrideLang: null,
          webDataOnly: !!webDataOnly,
        });
        sent += r.sent; failed += r.failed;
        results.push({ user_id: uid, sent: r.sent, failed: r.failed, results: r.results });
      }
    } else {
      // un solo batch con user genérico
      const r = await sendSimpleToUser({
        user: {},
        devices: devs,
        title, body, title_i18n, body_i18n, data,
        overrideLang: null,
        webDataOnly: !!webDataOnly,
      });
      sent = r.sent; failed = r.failed;
      results.push(...r.results);
    }

    res.json({ ok: true, targeted, sent, failed, results });
  } catch (e) {
    res.status(500).json({ ok: false, error: "admin_broadcast_failed", detail: e.message || String(e) });
  }
});

/* ============== Broadcast (compat) ============== */
/**
 * POST /users/push/broadcast  (compat: acepta X-Admin-Key o admin_key en body)
 * Body:
 *  admin_key?: string (si no se manda header X-Admin-Key)
 *  title, body, data
 *  platform?: 'web'|'android'|'ios' (default: null = todas)
 *  last_seen_days?: number (default: 30)
 *  group_by_user?: boolean (default: true)   // 1 device por usuario
 *  prefer_prefix?: string (default: 'ANDROID_CHROME') // prioridad por device_id
 *  limit?: number (default: 1000)
 *  webDataOnly?: boolean (default: true)
 */
router.post("/push/broadcast", async (req, res) => {
  try {
    // Permite header o body
    const headerKey = (req.get("x-admin-key") || "").toString();
    const bodyKey = (req.body?.admin_key || "").toString();
    const authed = ADMIN_PUSH_KEY && (headerKey === ADMIN_PUSH_KEY || bodyKey === ADMIN_PUSH_KEY);
    if (!authed) {
      return res.status(403).json({ ok: false, error: "forbidden" });
    }

    await ensureDevicesTable();

    const {
      title = "Notificación",
      body  = "Tienes un mensaje.",
      data  = null,

      platform       = null,
      last_seen_days = 30,
      group_by_user  = true,
      prefer_prefix  = "ANDROID_CHROME",
      limit          = 1000,
      webDataOnly    = true,
    } = req.body || {};

    const devices = await listDevicesForBroadcast({
      platform: platform ? String(platform).trim().toLowerCase() : null,
      lastSeenDays: Number.isFinite(+last_seen_days) ? +last_seen_days : 30,
      groupByUser: !!group_by_user,
      preferPrefix: String(prefer_prefix || "ANDROID_CHROME"),
      limit: Math.min(Math.max(parseInt(limit, 10) || 1000, 1), 10000),
    });

    if (!devices.length) {
      return res.json({ ok: true, targeted: 0, sent: 0, failed: 0, results: [] });
    }

    // Mapear usuarios y traer sus langs
    const userIds = [...new Set(devices.map(d => d.user_id))];
    const users = await query(`SELECT id, lang FROM users WHERE id = ANY($1)`, [userIds]);
    const userMap = new Map(users.map(u => [u.id, u]));

    let sent = 0, failed = 0;
    const sample = [];

    // Enviar usuario por usuario (permite i18n por user.lang)
    for (const uid of userIds) {
      const user = userMap.get(uid) || { id: uid, lang: 'es' };
      const devs = devices.filter(d => d.user_id === uid);

      const report = await sendSimpleToUser({
        user,
        devices: devs,
        title,
        body,
        data,
        overrideLang: null,
        webDataOnly: !!webDataOnly,
        title_i18n: null,
        body_i18n: null,
      });

      sent   += report.sent;
      failed += report.failed;

      for (const r of report.results) {
        if (sample.length < 100) {
          sample.push({ user_id: uid, ...r });
        }
      }
    }

    return res.json({ ok: true, targeted: devices.length, sent, failed, sample });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "broadcast_failed", detail: e.message || String(e) });
  }
});

module.exports = router;
