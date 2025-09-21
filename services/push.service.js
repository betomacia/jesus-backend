const { query } = require("../routes/db");
const { JWT } = require("google-auth-library");

const FB_PROJECT_ID   = process.env.FIREBASE_PROJECT_ID || "";
const FB_CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL || "";
const FB_PRIVATE_KEY  = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

const SCOPES = ["https://www.googleapis.com/auth/firebase.messaging"];
let cachedToken = { token: null, exp: 0 };

async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken.token && cachedToken.exp - 60 > now) return cachedToken.token;
  const jwt = new JWT({ email: FB_CLIENT_EMAIL, key: FB_PRIVATE_KEY, scopes: SCOPES });
  const { access_token, expiry_date } = await jwt.authorize();
  cachedToken.token = access_token;
  cachedToken.exp   = Math.floor((expiry_date || (Date.now() + 55 * 60 * 1000)) / 1000);
  return access_token;
}

function normalizeData(data) {
  if (!data) return undefined;
  const out = {};
  for (const k in data) {
    if (!Object.prototype.hasOwnProperty.call(data, k)) continue;
    const v = data[k];
    if (v === null || v === undefined) continue;
    out[k] = typeof v === "object" ? JSON.stringify(v) : String(v);
  }
  return Object.keys(out).length ? out : undefined;
}

async function sendToFcmV1({ token, title, body, data, webDataOnly }) {
  if (!FB_PROJECT_ID || !FB_CLIENT_EMAIL || !FB_PRIVATE_KEY) {
    return { ok: false, error: "missing_firebase_service_account_envs" };
  }
  try {
    const accessToken = await getAccessToken();
    const url = "https://fcm.googleapis.com/v1/projects/" + FB_PROJECT_ID + "/messages:send";

    // Enviamos SIEMPRE __title/__body en data para que Web los respete en SW
    const msgData = normalizeData({
      ...(data || {}),
      __title: title ? title : "Notificación",
      __body:  body  ? body  : ""
    });

    const message = { token: token, data: msgData };
    if (!webDataOnly) {
      message.notification = { title: title ? title : "Notificación", body: body ? body : "" };
    }

    const r = await fetch(url, {
      method: "POST",
      headers: { Authorization: "Bearer " + accessToken, "Content-Type": "application/json" },
      body: JSON.stringify({ message })
    });

    const json = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = (json && json.error && json.error.message) ? json.error.message : ("fcm_v1_http_" + r.status);
      return { ok: false, error: err, status: r.status, json };
    }
    return { ok: true, messageId: (json && json.name) ? json.name : null, status: r.status, json };
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    return { ok: false, error: msg };
  }
}

async function ensureDevicesTable() {
  await query(
    "CREATE TABLE IF NOT EXISTS devices (" +
    "  id                 BIGSERIAL PRIMARY KEY," +
    "  user_id            BIGINT REFERENCES users(id) ON DELETE CASCADE," +
    "  platform           TEXT," +
    "  fcm_token          TEXT NOT NULL," +
    "  device_id          TEXT," +
    "  lang               TEXT," +
    "  tz_offset_minutes  INTEGER," +
    "  app_version        TEXT," +
    "  os_version         TEXT," +
    "  model              TEXT," +
    "  last_seen          TIMESTAMPTZ DEFAULT NOW()," +
    "  created_at         TIMESTAMPTZ DEFAULT NOW()" +
    ");"
  );

  await query("CREATE UNIQUE INDEX IF NOT EXISTS uq_devices_token ON devices(fcm_token);");
  await query("CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);");

  // Única REAL por (user_id, device_id)
  await query(
    "DO $$ " +
    "BEGIN " +
    "  IF NOT EXISTS ( " +
    "    SELECT 1 FROM information_schema.table_constraints " +
    "    WHERE table_name='devices' " +
    "      AND constraint_name='uq_devices_user_device' " +
    "      AND constraint_type='UNIQUE' " +
    "  ) THEN " +
    "    ALTER TABLE devices " +
    "      ADD CONSTRAINT uq_devices_user_device UNIQUE (user_id, device_id); " +
    "  END IF; " +
    "END$$;"
  );

  // Limpiar índice parcial viejo si quedara
  await query("DROP INDEX IF EXISTS uq_devices_user_device_nonnull;");
}

/**
 * UPSERT robusto con manejo de colisión cruzada:
 * 1) Intento por (user_id, device_id)
 * 2) Si falla por uq_devices_token => borro la fila que tiene ese token y reintento
 * 3) Sin device_id => upsert por fcm_token
 */
async function registerDevice({
  uid, platform = null, fcm_token, device_id = null, lang = null,
  tz_offset_minutes = null, app_version = null, os_version = null, model = null
}) {
  const plat = platform ? String(platform).trim().toLowerCase() : null;
  const tok  = String(fcm_token);
  const did  = device_id ? String(device_id) : null;

  async function upsertByPair() {
    const r = await query(
      "INSERT INTO devices (" +
      "  user_id, platform, fcm_token, device_id, lang, tz_offset_minutes," +
      "  app_version, os_version, model, last_seen" +
      ") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW()) " +
      "ON CONFLICT (user_id, device_id) " +
      "DO UPDATE SET " +
      "  platform = COALESCE(EXCLUDED.platform, devices.platform)," +
      "  fcm_token = EXCLUDED.fcm_token," +
      "  lang = COALESCE(EXCLUDED.lang, devices.lang)," +
      "  tz_offset_minutes = COALESCE(EXCLUDED.tz_offset_minutes, devices.tz_offset_minutes)," +
      "  app_version = COALESCE(EXCLUDED.app_version, devices.app_version)," +
      "  os_version = COALESCE(EXCLUDED.os_version, devices.os_version)," +
      "  model = COALESCE(EXCLUDED.model, devices.model)," +
      "  last_seen = NOW() " +
      "RETURNING id, user_id, platform, fcm_token, device_id, lang, tz_offset_minutes," +
      "          app_version, os_version, model, last_seen, created_at",
      [uid, plat, tok, did, lang, tz_offset_minutes, app_version, os_version, model]
    );
    return r && r[0] ? r[0] : null;
  }

  async function upsertByToken() {
    const r = await query(
      "INSERT INTO devices (" +
      "  user_id, platform, fcm_token, device_id, lang, tz_offset_minutes," +
      "  app_version, os_version, model, last_seen" +
      ") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW()) " +
      "ON CONFLICT (fcm_token) " +
      "DO UPDATE SET " +
      "  user_id = EXCLUDED.user_id," +
      "  platform = COALESCE(EXCLUDED.platform, devices.platform)," +
      "  device_id = COALESCE(EXCLUDED.device_id, devices.device_id)," +
      "  lang = COALESCE(EXCLUDED.lang, devices.lang)," +
      "  tz_offset_minutes = COALESCE(EXCLUDED.tz_offset_minutes, devices.tz_offset_minutes)," +
      "  app_version = COALESCE(EXCLUDED.app_version, devices.app_version)," +
      "  os_version = COALESCE(EXCLUDED.os_version, devices.os_version)," +
      "  model = COALESCE(EXCLUDED.model, devices.model)," +
      "  last_seen = NOW() " +
      "RETURNING id, user_id, platform, fcm_token, device_id, lang, tz_offset_minutes," +
      "          app_version, os_version, model, last_seen, created_at",
      [uid, plat, tok, did, lang, tz_offset_minutes, app_version, os_version, model]
    );
    return r && r[0] ? r[0] : null;
  }

  if (did) {
    try {
      return await upsertByPair();
    } catch (e) {
      const msg = e && e.message ? e.message : "";
      if (/uq_devices_token|unique.*fcm_token|duplicate key.*fcm_token/i.test(msg)) {
        await query(
          "DELETE FROM devices " +
          " WHERE fcm_token = $1 " +
          "   AND (user_id <> $2 OR device_id IS DISTINCT FROM $3)",
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
      const msg = e && e.message ? e.message : "";
      if (/uq_devices_user_device|unique.*user_id.*device_id/i.test(msg)) {
        const r = await query(
          "UPDATE devices " +
          "   SET platform = COALESCE($2, platform)," +
          "       fcm_token = $3," +
          "       lang = COALESCE($4, lang)," +
          "       tz_offset_minutes = COALESCE($5, tz_offset_minutes)," +
          "       app_version = COALESCE($6, app_version)," +
          "       os_version = COALESCE($7, os_version)," +
          "       model = COALESCE($8, model)," +
          "       last_seen = NOW() " +
          " WHERE user_id = $1 " +
          "RETURNING id, user_id, platform, fcm_token, device_id, lang, tz_offset_minutes," +
          "          app_version, os_version, model, last_seen, created_at",
          [uid, plat, tok, lang, tz_offset_minutes, app_version, os_version, model]
        );
        return r && r[0] ? r[0] : null;
      }
      throw e;
    }
  }
}

async function listDevicesByUser({ uid, platform = null }) {
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

/**
 * Listado para broadcast SEGMENTABLE:
 *  - platform?: 'web'|'android'|'ios'
 *  - lastSeenDays?: number
 *  - groupByUser?: boolean  (si true, devolvemos máx. 1 device POR PLATAFORMA por usuario)
 *  - preferPrefix?: string  (prioridad por device_id que empiece así)
 *  - limit?: number
 *  - excludeEmbedded?: boolean (default: true) => filtra WEB_BOLT
 */
async function listDevicesForBroadcast({
  platform = null,
  lastSeenDays = 30,
  groupByUser = true,
  preferPrefix = "ANDROID_CHROME",
  limit = 1000,
  excludeEmbedded = true
}) {
  const whereClauses = [];
  const params = [];

  if (platform) {
    params.push(String(platform).toLowerCase());
    whereClauses.push("platform = $" + params.length);
  }
  if (Number.isFinite(+lastSeenDays) && +lastSeenDays >= 0) {
    params.push(+lastSeenDays);
    whereClauses.push("last_seen >= NOW() - ($" + params.length + " * INTERVAL '1 day')");
  }
  if (excludeEmbedded) {
    // Excluir DEL LADO DEL SERVIDOR cualquier device embebido
    whereClauses.push("(device_id IS NULL OR device_id NOT ILIKE 'WEB_BOLT%')");
  }

  const whereSql = whereClauses.length ? ("WHERE " + whereClauses.join(" AND ")) : "";

  if (groupByUser) {
    // Distinct por usuario + plataforma (web/android/ios), priorizando preferPrefix dentro de cada plataforma
    params.push(String(preferPrefix));
    const prefIdx = params.length;

    params.push(Math.min(Math.max(parseInt(limit, 10) || 1000, 1), 10000));
    const limIdx = params.length;

    const rows = await query(
      "WITH base AS ( " +
      "  SELECT d.*, " +
      "         CASE WHEN d.device_id ILIKE ($" + prefIdx + " || '%') THEN 0 ELSE 1 END AS pref, " +
      "         LOWER(COALESCE(d.platform, '')) AS plat " +
      "    FROM devices d " +
      "    " + whereSql +
      "), ranked AS ( " +
      "  SELECT base.*, " +
      "         ROW_NUMBER() OVER (PARTITION BY user_id, plat ORDER BY pref ASC, last_seen DESC, id DESC) AS rn " +
      "    FROM base " +
      ") " +
      "SELECT id, user_id, platform, device_id, fcm_token, lang, tz_offset_minutes, " +
      "       app_version, os_version, model, last_seen, created_at " +
      "  FROM ranked " +
      " WHERE rn = 1 " +
      " ORDER BY last_seen DESC, id DESC " +
      " LIMIT $" + limIdx,
      params
    );
    return rows || [];
  } else {
    params.push(Math.min(Math.max(parseInt(limit, 10) || 1000, 1), 10000));
    const rows = await query(
      "SELECT id, user_id, platform, device_id, fcm_token, lang, tz_offset_minutes, " +
      "       app_version, os_version, model, last_seen, created_at " +
      "  FROM devices " +
      "  " + whereSql +
      " ORDER BY last_seen DESC, id DESC " +
      " LIMIT $" + params.length,
      params
    );
    return rows || [];
  }
}

function isInvalidTokenError(resp) {
  const st = resp && resp.json && resp.json.error ? resp.json.error.status : null;
  if (st === "NOT_FOUND" || st === "UNREGISTERED" || st === "INVALID_ARGUMENT") return true;
  const msg = resp && resp.json && resp.json.error && resp.json.error.message ? String(resp.json.error.message) : "";
  if (
    /not a valid fcm registration token/i.test(msg) ||
    /Requested entity was not found/i.test(msg) ||
    /Requested entity has been deleted/i.test(msg) ||
    /registration token.*is invalid/i.test(msg)
  ) return true;
  return false;
}

async function deleteDeviceById(id) {
  try { await query("DELETE FROM devices WHERE id=$1", [Number(id)]); } catch (e) {}
  return 1;
}

async function sendSimpleToUser({
  user, devices, title = null, body = null, title_i18n = null, body_i18n = null,
  data = null, overrideLang = null, webDataOnly = false
}) {
  let sent = 0, failed = 0;
  const results = [];
  for (let i = 0; i < devices.length; i++) {
    const d = devices[i];
    const baseLang = overrideLang ? overrideLang : (d.lang ? d.lang : (user && user.lang ? user.lang : "es"));
    const lang = String(baseLang).slice(0, 5).toLowerCase();
    const langShort = lang.split("-")[0];

    const t = title !== null && title !== undefined
      ? title
      : (title_i18n && (title_i18n[lang] || title_i18n[langShort])) ? (title_i18n[lang] || title_i18n[langShort]) : "Notificación";

    const b = body !== null && body !== undefined
      ? body
      : (body_i18n && (body_i18n[lang] || body_i18n[langShort])) ? (body_i18n[lang] || body_i18n[langShort]) : "Tienes un mensaje.";

    const isWeb = String(d.platform || "").toLowerCase() === "web";
    const useWebDataOnly = isWeb ? true : !!webDataOnly;

    const r = await sendToFcmV1({
      token: d.fcm_token,
      title: t,
      body: b,
      data: data || null,
      webDataOnly: useWebDataOnly
    });

    if (r.ok) {
      sent++;
      results.push({ device_id: d.device_id, ok: true, messageId: r.messageId || null });
    } else {
      if (isInvalidTokenError(r) && d && d.id) {
        await deleteDeviceById(d.id);
        results.push({ device_id: d.device_id, ok: false, pruned: true, error: r.error });
      } else {
        results.push({ device_id: d.device_id, ok: false, error: r.error });
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
  listDevicesForBroadcast, // export
  sendSimpleToUser,
  deleteDeviceById
};
