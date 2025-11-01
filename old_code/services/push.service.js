// services/push.service.js
const { query } = require("../routes/db");
const { JWT } = require("google-auth-library");

// --- ENV FIREBASE (Service Account) ---
const FB_PROJECT_ID   = process.env.FIREBASE_PROJECT_ID || "";
const FB_CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL || "";
const FB_PRIVATE_KEY  = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

const SCOPES = ["https://www.googleapis.com/auth/firebase.messaging"];

// Cache de token IAM
let cachedToken = { token: null, exp: 0 };

// ============================
// IAM Access Token para FCM v1
// ============================
async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken.token && cachedToken.exp - 60 > now) return cachedToken.token;

  const jwt = new JWT({ email: FB_CLIENT_EMAIL, key: FB_PRIVATE_KEY, scopes: SCOPES });
  const a = await jwt.authorize();
  const access_token = a && a.access_token ? a.access_token : null;
  const expiry_date  = a && a.expiry_date ? a.expiry_date : (Date.now() + 55 * 60 * 1000);

  cachedToken.token = access_token;
  cachedToken.exp   = Math.floor(expiry_date / 1000);
  return access_token;
}

// ============================
// Normaliza data a strings
// ============================
function normalizeData(data) {
  if (!data) return undefined;
  const out = {};
  Object.keys(data).forEach(function (k) {
    const v = data[k];
    if (v === null || typeof v === "undefined") return;
    out[k] = (typeof v === "object") ? JSON.stringify(v) : String(v);
  });
  return Object.keys(out).length ? out : undefined;
}

/**
 * Envía por FCM v1.
 * - NO inventa títulos/cuerpos por defecto. Si no se pasan, van "".
 * - Si webDataOnly=false adjunta message.notification (Android sistema).
 */
async function sendToFcmV1(params) {
  const token = params && params.token ? params.token : null;
  const title = (typeof (params && params.title) !== "undefined") ? String(params.title || "") : "";
  const body  = (typeof (params && params.body)  !== "undefined") ? String(params.body  || "") : "";
  const data  = params && params.data ? params.data : null;
  const webDataOnly = !!(params && params.webDataOnly);

  if (!FB_PROJECT_ID || !FB_CLIENT_EMAIL || !FB_PRIVATE_KEY) {
    return { ok: false, error: "missing_firebase_service_account_envs" };
  }

  try {
    const accessToken = await getAccessToken();
    const url = "https://fcm.googleapis.com/v1/projects/" + FB_PROJECT_ID + "/messages:send";

    const msgData = normalizeData({
      __title: title,   // ← sin defaults
      __body:  body,    // ← sin defaults
      ...(data || {})
    });

    const message = { token: token, data: msgData };
    if (!webDataOnly) {
      message.notification = { title: title, body: body };
    }

    const r = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + accessToken,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ message: message })
    });

    let json = {};
    try { json = await r.json(); } catch (_e) {}

    if (!r.ok) {
      const err = json && json.error && json.error.message ? json.error.message : ("fcm_v1_http_" + r.status);
      return { ok: false, error: err, status: r.status, json: json };
    }
    return { ok: true, messageId: (json && json.name) || null, status: r.status, json: json };
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    return { ok: false, error: msg };
  }
}

// ============================
// Esquema devices
// ============================
async function ensureDevicesTable() {
  await query(
    "CREATE TABLE IF NOT EXISTS devices (" +
      "id BIGSERIAL PRIMARY KEY," +
      "user_id BIGINT REFERENCES users(id) ON DELETE CASCADE," +
      "platform TEXT," +
      "fcm_token TEXT NOT NULL," +
      "device_id TEXT," +
      "lang TEXT," +
      "tz_offset_minutes INTEGER," +
      "app_version TEXT," +
      "os_version TEXT," +
      "model TEXT," +
      "last_seen TIMESTAMPTZ DEFAULT NOW()," +
      "created_at TIMESTAMPTZ DEFAULT NOW()" +
    ");"
  );

  await query("CREATE UNIQUE INDEX IF NOT EXISTS uq_devices_token ON devices(fcm_token);");
  await query("CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);");

  // Única real por (user_id, device_id)
  await query(
    "DO $$ " +
    "BEGIN " +
    "  IF NOT EXISTS ( " +
    "    SELECT 1 FROM information_schema.table_constraints " +
    "    WHERE table_name='devices' " +
    "      AND constraint_name='uq_devices_user_device' " +
    "      AND constraint_type='UNIQUE' " +
    "  ) THEN " +
    "    ALTER TABLE devices ADD CONSTRAINT uq_devices_user_device UNIQUE (user_id, device_id); " +
    "  END IF; " +
    "END$$;"
  );

  // Limpia índice parcial viejo si existiera
  await query("DROP INDEX IF EXISTS uq_devices_user_device_nonnull;");
}

/**
 * UPSERT robusto:
 * - Si hay choque por token único, borra el viejo y reintenta.
 * - Si no hay device_id, consolida por fcm_token.
 */
async function registerDevice(params) {
  const uid  = params && params.uid ? params.uid : null;
  const plat = params && params.platform ? String(params.platform).trim().toLowerCase() : null;
  const tok  = String(params && params.fcm_token ? params.fcm_token : "");
  const did  = params && params.device_id ? String(params.device_id) : null;
  const lang = params && params.lang ? params.lang : null;
  const tz   = (params && params.tz_offset_minutes != null) ? params.tz_offset_minutes : null;
  const appv = params && params.app_version ? params.app_version : null;
  const osv  = params && params.os_version  ? params.os_version  : null;
  const model= params && params.model       ? params.model       : null;

  async function upsertByPair() {
    const rows = await query(
      "INSERT INTO devices (user_id, platform, fcm_token, device_id, lang, tz_offset_minutes, app_version, os_version, model, last_seen) " +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW()) " +
      "ON CONFLICT (user_id, device_id) DO UPDATE SET " +
      "  platform = COALESCE(EXCLUDED.platform, devices.platform)," +
      "  fcm_token = EXCLUDED.fcm_token," +
      "  lang = COALESCE(EXCLUDED.lang, devices.lang)," +
      "  tz_offset_minutes = COALESCE(EXCLUDED.tz_offset_minutes, devices.tz_offset_minutes)," +
      "  app_version = COALESCE(EXCLUDED.app_version, devices.app_version)," +
      "  os_version = COALESCE(EXCLUDED.os_version, devices.os_version)," +
      "  model = COALESCE(EXCLUDED.model, devices.model)," +
      "  last_seen = NOW()" +
      "RETURNING id, user_id, platform, fcm_token, device_id, lang, tz_offset_minutes, app_version, os_version, model, last_seen, created_at",
      [uid, plat, tok, did, lang, tz, appv, osv, model]
    );
    return rows && rows[0] ? rows[0] : null;
  }

  async function upsertByToken() {
    const rows = await query(
      "INSERT INTO devices (user_id, platform, fcm_token, device_id, lang, tz_offset_minutes, app_version, os_version, model, last_seen) " +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW()) " +
      "ON CONFLICT (fcm_token) DO UPDATE SET " +
      "  user_id = EXCLUDED.user_id," +
      "  platform = COALESCE(EXCLUDED.platform, devices.platform)," +
      "  device_id = COALESCE(EXCLUDED.device_id, devices.device_id)," +
      "  lang = COALESCE(EXCLUDED.lang, devices.lang)," +
      "  tz_offset_minutes = COALESCE(EXCLUDED.tz_offset_minutes, devices.tz_offset_minutes)," +
      "  app_version = COALESCE(EXCLUDED.app_version, devices.app_version)," +
      "  os_version = COALESCE(EXCLUDED.os_version, devices.os_version)," +
      "  model = COALESCE(EXCLUDED.model, devices.model)," +
      "  last_seen = NOW()" +
      "RETURNING id, user_id, platform, fcm_token, device_id, lang, tz_offset_minutes, app_version, os_version, model, last_seen, created_at",
      [uid, plat, tok, did, lang, tz, appv, osv, model]
    );
    return rows && rows[0] ? rows[0] : null;
  }

  if (did) {
    try {
      return await upsertByPair();
    } catch (e) {
      const msg = (e && e.message) ? e.message : "";
      if (/uq_devices_token|unique.*fcm_token|duplicate key.*fcm_token/i.test(msg)) {
        await query(
          "DELETE FROM devices WHERE fcm_token = $1 AND (user_id <> $2 OR device_id IS DISTINCT FROM $3)",
          [tok, uid, did]
        );
        return await upsertByPair();
      }
      throw e;
    }
  } else {
    try {
      return await upsertByToken();
    } catch (e) {
      const msg = (e && e.message) ? e.message : "";
      if (/uq_devices_user_device|unique.*user_id.*device_id/i.test(msg)) {
        const rows = await query(
          "UPDATE devices SET " +
          "  platform = COALESCE($2, platform)," +
          "  fcm_token = $3," +
          "  lang = COALESCE($4, lang)," +
          "  tz_offset_minutes = COALESCE($5, tz_offset_minutes)," +
          "  app_version = COALESCE($6, app_version)," +
          "  os_version = COALESCE($7, os_version)," +
          "  model = COALESCE($8, model)," +
          "  last_seen = NOW() " +
          "WHERE user_id = $1 " +
          "RETURNING id, user_id, platform, fcm_token, device_id, lang, tz_offset_minutes, app_version, os_version, model, last_seen, created_at",
          [uid, plat, tok, lang, tz, appv, osv, model]
        );
        return rows && rows[0] ? rows[0] : null;
      }
      throw e;
    }
  }
}

// ============================
// Listados de devices
// ============================
async function listDevicesByUser(params) {
  const uid = params && params.uid ? params.uid : null;
  const platform = params && params.platform ? params.platform : null;

  if (platform) {
    return await query(
      "SELECT * FROM devices WHERE user_id=$1 AND platform=$2 ORDER BY last_seen DESC, id DESC",
      [uid, platform]
    );
  }
  return await query(
    "SELECT * FROM devices WHERE user_id=$1 ORDER BY last_seen DESC, id DESC",
    [uid]
  );
}

async function listDevicesForBroadcast(params) {
  const platform = params && params.platform ? String(params.platform).toLowerCase() : null;
  const lastSeenDays = (params && params.lastSeenDays != null) ? +params.lastSeenDays : 30;
  const groupByUser = !!(params && params.groupByUser);
  const preferPrefix = params && params.preferPrefix ? String(params.preferPrefix) : "ANDROID_CHROME";
  const limit = Math.min(Math.max(parseInt((params && params.limit) || 1000, 10) || 1000, 1), 10000);

  const whereClauses = [];
  const p = [];

  if (platform) {
    p.push(platform);
    whereClauses.push("platform = $" + p.length);
  }
  if (isFinite(lastSeenDays) && lastSeenDays >= 0) {
    p.push(lastSeenDays);
    whereClauses.push("last_seen >= NOW() - ($" + p.length + " * INTERVAL '1 day')");
  }

  const whereSql = whereClauses.length ? ("WHERE " + whereClauses.join(" AND ")) : "";

  if (groupByUser) {
    p.push(preferPrefix);
    const prefIdx = p.length;
    p.push(limit);
    const limIdx = p.length;

    const sql =
      "WITH base AS (" +
      "  SELECT d.*, CASE WHEN d.device_id ILIKE ($" + prefIdx + " || '%') THEN 0 ELSE 1 END AS pref " +
      "  FROM devices d " + whereSql +
      ") " +
      "SELECT DISTINCT ON (user_id) " +
      "  id, user_id, platform, device_id, fcm_token, lang, tz_offset_minutes, app_version, os_version, model, last_seen, created_at " +
      "FROM base " +
      "ORDER BY user_id, pref ASC, last_seen DESC, id DESC " +
      "LIMIT $" + limIdx;

    const rows = await query(sql, p);
    return rows || [];
  } else {
    p.push(limit);
    const sql =
      "SELECT id, user_id, platform, device_id, fcm_token, lang, tz_offset_minutes, app_version, os_version, model, last_seen, created_at " +
      "FROM devices " + whereSql + " " +
      "ORDER BY last_seen DESC, id DESC " +
      "LIMIT $" + p.length;
    const rows = await query(sql, p);
    return rows || [];
  }
}

// ============================
// Helpers envío / errores
// ============================
function isInvalidTokenError(resp) {
  const st = resp && resp.json && resp.json.error ? resp.json.error.status : null;
  if (st === "NOT_FOUND" || st === "UNREGISTERED" || st === "INVALID_ARGUMENT") return true;
  const msg = resp && resp.json && resp.json.error && resp.json.error.message ? String(resp.json.error.message) : "";
  if (/not a valid fcm registration token/i.test(msg)) return true;
  if (/Requested entity was not found/i.test(msg)) return true;
  if (/Requested entity has been deleted/i.test(msg)) return true;
  if (/registration token.*is invalid/i.test(msg)) return true;
  return false;
}

async function deleteDeviceById(id) {
  try { await query("DELETE FROM devices WHERE id=$1", [Number(id)]); } catch (_e) {}
  return 1;
}

/** Dedupe defensivo: deja 1 android y 1 desktop por usuario (más recientes) */
function dedupeDevices(devices) {
  const byToken = new Map();
  const byPair  = new Map();

  for (let i = 0; i < devices.length; i++) {
    const d = devices[i];
    const keyTok  = String(d.fcm_token || "");
    const keyPair = String(d.user_id || "0") + "|" + String(d.device_id || "-");

    if (!byToken.has(keyTok)) byToken.set(keyTok, d);
    else {
      const prev = byToken.get(keyTok);
      const newer = (String(d.last_seen || "") > String(prev.last_seen || ""));
      if (newer) byToken.set(keyTok, d);
    }

    if (!byPair.has(keyPair)) byPair.set(keyPair, d);
    else {
      const prev = byPair.get(keyPair);
      const newer = (String(d.last_seen || "") > String(prev.last_seen || ""));
      if (newer) byPair.set(keyPair, d);
    }
  }

  const merged = new Map();
  function groupOf(dev) {
    const id = String(dev.device_id || "");
    if (id.indexOf("ANDROID_CHROME") === 0) return "android";
    if (id.indexOf("WEB_DESKTOP") === 0) return "desktop";
    return "other";
  }

  const all = [].concat(Array.from(byToken.values()), Array.from(byPair.values()));
  for (let i = 0; i < all.length; i++) {
    const d = all[i];
    const key = groupOf(d) + "|" + String(d.user_id || "0");
    if (!merged.has(key)) merged.set(key, d);
    else {
      const prev = merged.get(key);
      const newer = (String(d.last_seen || "") > String(prev.last_seen || ""));
      if (newer) merged.set(key, d);
    }
  }
  return Array.from(merged.values());
}

// ============================
// Envío a usuario (filtra WEB_BOLT, dedupe, respeta títulos)
// ============================
async function sendSimpleToUser(params) {
  const user = params && params.user ? params.user : {};
  const devicesIn = Array.isArray(params && params.devices) ? params.devices : [];
  const title = (typeof (params && params.title) !== "undefined") ? params.title : null;
  const body  = (typeof (params && params.body)  !== "undefined") ? params.body  : null;
  const title_i18n = params && params.title_i18n ? params.title_i18n : null;
  const body_i18n  = params && params.body_i18n  ? params.body_i18n  : null;
  const data = params && params.data ? params.data : null;
  const overrideLang = params && params.overrideLang ? params.overrideLang : null;
  const webDataOnly  = !!(params && params.webDataOnly);

  // 0) Filtro: fuera WEB_BOLT + duplicados exactos (platform|device_id|token)
  const filtered = [];
  const seen = new Set();
  for (let i = 0; i < devicesIn.length; i++) {
    const d = devicesIn[i];
    const did = String(d.device_id || "");
    if (/^WEB_BOLT/i.test(did)) continue; // descarta Bolt
    const key = [String(d.platform || "").toLowerCase(), did, String(d.fcm_token || "")].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    filtered.push(d);
  }

  // 1) Dedupe: deja 1 android + 1 desktop por usuario (más recientes)
  const deduped = dedupeDevices(filtered);

  let sent = 0, failed = 0;
  const results = [];

  for (let i = 0; i < deduped.length; i++) {
    const d = deduped[i];
    const rawLang = overrideLang || d.lang || user.lang || "es";
    const lang = String(rawLang || "es").slice(0, 5).toLowerCase();

    // Usa exactamente lo que llega del admin (sin textos de prueba)
    let t = "";
    if (title !== null) t = String(title);
    else if (title_i18n && (title_i18n[lang] || title_i18n[lang.split("-")[0]])) {
      t = String(title_i18n[lang] || title_i18n[lang.split("-")[0]]);
    }

    let b = "";
    if (body !== null) b = String(body);
    else if (body_i18n && (body_i18n[lang] || body_i18n[lang.split("-")[0]])) {
      b = String(body_i18n[lang] || body_i18n[lang.split("-")[0]]);
    }

    const isWeb = String(d.platform || "").toLowerCase() === "web";
    const useWebDataOnly = isWeb ? true : !!(webDataOnly);

    const r = await sendToFcmV1({
      token: d.fcm_token,
      title: t,
      body: b,
      data: data,
      webDataOnly: useWebDataOnly
    });

    if (r && r.ok) {
      sent++;
      results.push({ user_id: d.user_id, device_id: d.device_id, ok: true, messageId: r.messageId || null });
    } else {
      if (isInvalidTokenError(r) && d && d.id) {
        await deleteDeviceById(d.id);
        results.push({ user_id: d.user_id, device_id: d.device_id, ok: false, pruned: true, error: (r && r.error) || "send_error" });
      } else {
        results.push({ user_id: d.user_id, device_id: d.device_id, ok: false, error: (r && r.error) || "send_error" });
      }
      failed++;
    }
  }

  return { sent: sent, failed: failed, results: results };
}

module.exports = {
  ensureDevicesTable,
  registerDevice,
  listDevicesByUser,
  listDevicesForBroadcast,
  sendSimpleToUser,
  deleteDeviceById,
};
