// Envío de notificaciones por Firebase Cloud Messaging (HTTP v1, OAuth2)
// ENV requeridas: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY (\n escapados)
// Node 18+ = fetch global
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
  for (const [k, v] of Object.entries(data)) {
    if (v === null || v === undefined) continue;
    out[k] = typeof v === "object" ? JSON.stringify(v) : String(v);
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * webDataOnly=true  => NO manda "notification" en el payload (solo data)
 *                      y deja que el SW muestre el toast (más confiable en Android Chrome).
 */
async function sendToFcmV1({ token, title, body, data, webDataOnly = false }) {
  if (!FB_PROJECT_ID || !FB_CLIENT_EMAIL || !FB_PRIVATE_KEY) {
    return { ok: false, error: "missing_firebase_service_account_envs" };
  }
  try {
    const accessToken = await getAccessToken();
    const url = `https://fcm.googleapis.com/v1/projects/${FB_PROJECT_ID}/messages:send`;

    const msgData = normalizeData({
      ...(data || {}),
      // Pasamos title/body también por data, por si el SW los necesita
      __title: title || "Notificación",
      __body:  body  || "",
    });

    const message = { token, data: msgData };
    if (!webDataOnly) {
      message.notification = { title: title || "Notificación", body: body || "" };
    }

    const payload = { message };
    const r = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const json = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = json?.error?.message || `fcm_v1_http_${r.status}`;
      return { ok: false, error: err, status: r.status, json };
    }
    return { ok: true, messageId: json?.name || null, status: r.status, json };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

async function ensureDevicesTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS devices (
      id                 BIGSERIAL PRIMARY KEY,
      user_id            BIGINT REFERENCES users(id) ON DELETE CASCADE,
      platform           TEXT,
      fcm_token          TEXT NOT NULL,
      device_id          TEXT,
      lang               TEXT,
      tz_offset_minutes  INTEGER,
      app_version        TEXT,
      os_version         TEXT,
      model              TEXT,
      last_seen          TIMESTAMPTZ DEFAULT NOW(),
      created_at         TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_devices_token ON devices(fcm_token);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);`);
  await query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_indexes WHERE indexname = 'uq_devices_user_device_nonnull'
      ) THEN
        EXECUTE 'CREATE UNIQUE INDEX uq_devices_user_device_nonnull ON devices(user_id, device_id) WHERE device_id IS NOT NULL';
      END IF;
    END$$;
  `);
}

async function registerDevice({
  uid, platform = null, fcm_token, device_id = null, lang = null,
  tz_offset_minutes = null, app_version = null, os_version = null, model = null,
}) {
  const r = await query(
    `
    INSERT INTO devices (user_id, platform, fcm_token, device_id, lang, tz_offset_minutes, app_version, os_version, model, last_seen)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
    ON CONFLICT (fcm_token)
    DO UPDATE SET
      user_id = EXCLUDED.user_id,
      platform = COALESCE(EXCLUDED.platform, devices.platform),
      device_id = COALESCE(EXCLUDED.device_id, devices.device_id),
      lang = COALESCE(EXCLUDED.lang, devices.lang),
      tz_offset_minutes = COALESCE(EXCLUDED.tz_offset_minutes, devices.tz_offset_minutes),
      app_version = COALESCE(EXCLUDED.app_version, devices.app_version),
      os_version = COALESCE(EXCLUDED.os_version, devices.os_version),
      model = COALESCE(EXCLUDED.model, devices.model),
      last_seen = NOW()
    RETURNING id, user_id, platform, fcm_token, device_id, lang, tz_offset_minutes, app_version, os_version, model, last_seen, created_at
    `,
    [uid, platform, String(fcm_token), device_id, lang, tz_offset_minutes, app_version, os_version, model]
  );
  return r?.[0];
}

async function listDevicesByUser({ uid, platform = null }) {
  if (platform) {
    return await query(
      `SELECT * FROM devices WHERE user_id=$1 AND platform=$2 ORDER BY last_seen DESC, id DESC`,
      [uid, platform]
    );
  }
  return await query(
    `SELECT * FROM devices WHERE user_id=$1 ORDER BY last_seen DESC, id DESC`,
    [uid]
  );
}

function isInvalidTokenError(resp) {
  const st = resp?.json?.error?.status;
  if (st === 'NOT_FOUND' || st === 'UNREGISTERED' || st === 'INVALID_ARGUMENT') return true;
  const msg = (resp?.json?.error?.message || "").toString();
  if (
    /not a valid fcm registration token/i.test(msg) ||
    /Requested entity was not found/i.test(msg) ||
    /Requested entity has been deleted/i.test(msg) ||
    /registration token.*is invalid/i.test(msg)
  ) return true;
  return false;
}

async function deleteDeviceById(id) {
  try { await query(`DELETE FROM devices WHERE id=$1`, [Number(id)]); } catch {}
  return 1;
}

/** Envío simple a devices seleccionados */
async function sendSimpleToUser({
  user, devices, title = null, body = null, title_i18n = null, body_i18n = null,
  data = null, overrideLang = null, webDataOnly = false,
}) {
  let sent = 0, failed = 0;
  const results = [];

  for (const d of devices) {
    const lang = pickLang({ overrideLang, deviceLang: d.lang, userLang: user?.lang });
    const t = title ?? i18nPick(title_i18n, lang) ?? "Notificación";
    const b = body  ?? i18nPick(body_i18n,  lang) ?? "Tienes un mensaje.";

    const r = await sendToFcmV1({
      token: d.fcm_token,
      title: t,
      body: b,
      data,
      webDataOnly: !!webDataOnly && (d.platform === 'web'), // sólo aplica a web
    });

    if (r.ok) {
      sent++;
      results.push({ device_id: d.device_id, ok: true, messageId: r.messageId || null });
    } else {
      if (isInvalidTokenError(r) && d?.id) {
        await deleteDeviceById(d.id);
        results.push({ device_id: d.device_id, ok: false, pruned: true, error: r.error });
      } else {
        results.push({ device_id: d.device_id, ok: false, error: r.error });
      }
      failed++;
    }
  }

  return { sent, failed, results };
}

function pickLang({ overrideLang, deviceLang, userLang }) {
  return (overrideLang || deviceLang || userLang || "es").slice(0, 5).toLowerCase();
}
function i18nPick(map, lang) {
  if (!map || typeof map !== "object") return null;
  const l = (lang || "es").toLowerCase();
  return map[l] || map[l.split("-")[0]] || map["es"] || map["en"] || null;
}

module.exports = {
  ensureDevicesTable,
  registerDevice,
  listDevicesByUser,
  sendSimpleToUser,
  deleteDeviceById,
};
