// services/push.service.js
// Requiere ENV FCM_SERVER_KEY (Firebase Legacy HTTP)
// En Node 18+ tenemos fetch global.
const { query } = require("../routes/db");

const FCM_URL = "https://fcm.googleapis.com/fcm/send";

async function ensureDevicesTable() {
  // Tabla y índices (incluye índices únicos útiles para upsert)
  await query(`
    CREATE TABLE IF NOT EXISTS devices (
      id               BIGSERIAL PRIMARY KEY,
      user_id          BIGINT REFERENCES users(id) ON DELETE CASCADE,
      platform         TEXT,       -- 'android' | 'ios' | 'web'
      fcm_token        TEXT NOT NULL,
      device_id        TEXT,       -- identificador estable del dispositivo si lo tenés
      lang             TEXT,       -- preferencia del dispositivo
      tz_offset_minutes INTEGER,   -- minutos vs UTC (cliente)
      app_version      TEXT,
      os_version       TEXT,
      model            TEXT,
      last_seen        TIMESTAMPTZ DEFAULT NOW(),
      created_at       TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_devices_token ON devices(fcm_token);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);`);
  // índice único parcial por (user_id, device_id) si device_id no es null
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
  uid, platform = null, fcm_token, device_id = null,
  lang = null, tz_offset_minutes = null, app_version = null, os_version = null, model = null
}) {
  // Upsert por fcm_token (si cambia device_id, se actualiza)
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
    [uid, platform, fcm_token, device_id, lang, tz_offset_minutes, app_version, os_version, model]
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

function pickLang({ overrideLang, deviceLang, userLang }) {
  return (overrideLang || deviceLang || userLang || "es").slice(0, 5).toLowerCase();
}

function i18nPick(map, lang) {
  if (!map || typeof map !== "object") return null;
  const l = (lang || "es").toLowerCase();
  return map[l] || map[l.split("-")[0]] || map["es"] || map["en"] || null;
}

async function sendFCMToToken({ token, title, body, data }) {
  const key = process.env.FCM_SERVER_KEY || "";
  if (!key) throw new Error("missing_FCM_SERVER_KEY");

  const payload = {
    to: token,
    notification: { title, body },
    data: data || {},
    android: { priority: "high" },
    apns: { headers: { "apns-priority": "10" } }
  };

  const r = await fetch(FCM_URL, {
    method: "POST",
    headers: {
      "Authorization": `key=${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload),
  });

  const json = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, json };
}

/**
 * Envía notificaciones a todos los dispositivos del usuario.
 * - Si title/body están dados, se usan tal cual.
 * - Si vienen title_i18n/body_i18n, se eligen según overrideLang > device.lang > user.lang.
 */
async function sendSimpleToUser({
  user, devices, title = null, body = null, title_i18n = null, body_i18n = null, data = null, overrideLang = null
}) {
  const results = [];
  for (const d of devices) {
    const lang = pickLang({ overrideLang, deviceLang: d.lang, userLang: user?.lang });
    const t = title ?? i18nPick(title_i18n, lang) ?? "Notificación";
    const b = body  ?? i18nPick(body_i18n,  lang) ?? "Tienes un mensaje.";
    try {
      const resp = await sendFCMToToken({ token: d.fcm_token, title: t, body: b, data });
      results.push({ device_id: d.device_id, ok: resp.ok, status: resp.status, resp: resp.json });
    } catch (e) {
      results.push({ device_id: d.device_id, ok: false, error: String(e) });
    }
  }
  const sent = results.filter(x => x.ok).length;
  const failed = results.length - sent;
  return { sent, failed, results };
}

module.exports = {
  ensureDevicesTable,
  registerDevice,
  listDevicesByUser,
  sendSimpleToUser,
};
