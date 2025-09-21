// services/push.service.js
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

/** NO metemos defaults; solo serializamos lo que venga en data */
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
 * Envía al endpoint v1 de FCM.
 * - Para 'webDataOnly=true' NO incluimos 'notification' (solo 'data').
 * - Para 'webDataOnly=false' SÍ incluimos 'notification' (Android nativo).
 * - JAMÁS agregamos __title/__body por defecto: si caller no manda title/body, no inventamos texto.
 */
async function sendToFcmV1({ token, title, body, data, webDataOnly = false }) {
  if (!FB_PROJECT_ID || !FB_CLIENT_EMAIL || !FB_PRIVATE_KEY) {
    return { ok: false, error: "missing_firebase_service_account_envs" };
  }
  try {
    const accessToken = await getAccessToken();
    const url = `https://fcm.googleapis.com/v1/projects/${FB_PROJECT_ID}/messages:send`;

    const message = {
      token,
      data: normalizeData(data) // <- solo lo que venga, sin defaults
    };

    if (!webDataOnly) {
      // Android nativo: acá sí se respeta EXACTO el title/body que mande el admin
      // (si vinieran vacíos, igual los mandamos vacíos)
      message.notification = {
        title: title ?? "",
        body:  body  ?? ""
      };
    }

    const r = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
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
        SELECT 1
        FROM information_schema.table_constraints
        WHERE table_name='devices'
          AND constraint_name='uq_devices_user_device'
          AND constraint_type='UNIQUE'
      ) THEN
        ALTER TABLE devices
          ADD CONSTRAINT uq_devices_user_device UNIQUE (user_id, device_id);
      END IF;
    END$$;
  `);

  await query(`DROP INDEX IF EXISTS uq_devices_user_device_nonnull;`);
}

/**
 * UPSERT con manejo de colisión cruzada.
 */
async function registerDevice({
  uid, platform = null, fcm_token, device_id = null, lang = null,
  tz_offset_minutes = null, app_version = null, os_version = null, model = null,
}) {
  const plat = platform ? String(platform).trim().toLowerCase() : null;
  const tok  = String(fcm_token);
  const did  = device_id ? String(device_id) : null;

  async function upsertByPair() {
    const r = await query(
      `
      INSERT INTO devices (
        user_id, platform, fcm_token, device_id, lang, tz_offset_minutes,
        app_version, os_version, model, last_seen
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
      ON CONFLICT (user_id, device_id)
      DO UPDATE SET
        platform = COALESCE(EXCLUDED.platform, devices.platform),
        fcm_token = EXCLUDED.fcm_token,
        lang = COALESCE(EXCLUDED.lang, devices.lang),
        tz_offset_minutes = COALESCE(EXCLUDED.tz_offset_minutes, devices.tz_offset_minutes),
        app_version = COALESCE(EXCLUDED.app_version, devices.app_version),
        os_version = COALESCE(EXCLUDED.os_version, devices.os_version),
        model = COALESCE(EXCLUDED.model, devices.model),
        last_seen = NOW()
      RETURNING id, user_id, platform, fcm_token, device_id, lang, tz_offset_minutes,
                app_version, os_version, model, last_seen, created_at
      `,
      [uid, plat, tok, did, lang, tz_offset_minutes, app_version, os_version, model]
    );
    return r?.[0];
  }

  async function upsertByToken() {
    const r = await query(
      `
      INSERT INTO devices (
        user_id, platform, fcm_token, device_id, lang, tz_offset_minutes,
        app_version, os_version, model, last_seen
      )
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
      RETURNING id, user_id, platform, fcm_token, device_id, lang, tz_offset_minutes,
                app_version, os_version, model, last_seen, created_at
      `,
      [uid, plat, tok, did, lang, tz_offset_minutes, app_version, os_version, model]
    );
    return r?.[0];
  }

  if (did) {
    try {
      return await upsertByPair();
    } catch (e) {
      const msg = (e && e.message) || "";
      if (/uq_devices_token|unique.*fcm_token|duplicate key.*fcm_token/i.test(msg)) {
        await query(
          `DELETE FROM devices
             WHERE fcm_token = $1
               AND (user_id <> $2 OR device_id IS DISTINCT FROM $3)`,
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
      const msg = (e && e.message) || "";
      if (/uq_devices_user_device|unique.*user_id.*device_id/i.test(msg)) {
        const r = await query(
          `
          UPDATE devices
             SET platform = COALESCE($2, platform),
                 fcm_token = $3,
                 lang = COALESCE($4, lang),
                 tz_offset_minutes = COALESCE($5, tz_offset_minutes),
                 app_version = COALESCE($6, app_version),
                 os_version = COALESCE($7, os_version),
                 model = COALESCE($8, model),
                 last_seen = NOW()
           WHERE user_id = $1
          RETURNING id, user_id, platform, fcm_token, device_id, lang, tz_offset_minutes,
                    app_version, os_version, model, last_seen, created_at
          `,
          [uid, plat, tok, lang, tz_offset_minutes, app_version, os_version, model]
        );
        return r?.[0];
      }
      throw e;
    }
  }
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

async function listDevicesForBroadcast({
  platform = null,
  lastSeenDays = 30,
  groupByUser = true,
  preferPrefix = "ANDROID_CHROME",
  limit = 1000,
}) {
  const whereClauses = [];
  const params = [];

  if (platform) {
    params.push(String(platform).toLowerCase());
    whereClauses.push(`platform = $${params.length}`);
  }
  if (Number.isFinite(+lastSeenDays) && +lastSeenDays >= 0) {
    params.push(+lastSeenDays);
    whereClauses.push(`last_seen >= NOW() - ($${params.length} * INTERVAL '1 day')`);
  }

  const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(" AND ")}` : "";

  if (groupByUser) {
    params.push(String(preferPrefix));
    const prefIdx = params.length;

    params.push(Math.min(Math.max(parseInt(limit, 10) || 1000, 1), 10000));
    const limIdx = params.length;

    const rows = await query(
      `
      WITH base AS (
        SELECT d.*,
               CASE WHEN d.device_id ILIKE ($${prefIdx} || '%') THEN 0 ELSE 1 END AS pref
          FROM devices d
          ${whereSql}
      )
      SELECT DISTINCT ON (user_id)
             id, user_id, platform, device_id, fcm_token, lang, tz_offset_minutes,
             app_version, os_version, model, last_seen, created_at
        FROM base
       ORDER BY user_id, pref ASC, last_seen DESC, id DESC
       LIMIT $${limIdx}
      `,
      params
    );
    return rows || [];
  } else {
    params.push(Math.min(Math.max(parseInt(limit, 10) || 1000, 1), 10000));
    const rows = await query(
      `
      SELECT id, user_id, platform, device_id, fcm_token, lang, tz_offset_minutes,
             app_version, os_version, model, last_seen, created_at
        FROM devices
        ${whereSql}
       ORDER BY last_seen DESC, id DESC
       LIMIT $${params.length}
      `,
      params
    );
    return rows || [];
  }
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

/**
 * Política final:
 * - WEB => SIEMPRE data-only (webDataOnly=true); no 'notification' (lo dibuja SW) y no inventamos textos.
 * - ANDROID (nativo) => webDataOnly=false; se manda 'notification' con title/body EXACTOS del admin.
 */
async function sendSimpleToUser({
  user, devices, title = null, body = null, title_i18n = null, body_i18n = null,
  data = null, overrideLang = null, webDataOnly = false,
}) {
  let sent = 0, failed = 0;
  const results = [];
  for (const d of devices) {
    const lang = (overrideLang || d.lang || user?.lang || "es").slice(0, 5).toLowerCase();
    const resolvedTitle =
      title != null ? title
      : (title_i18n?.[lang] || title_i18n?.[lang.split("-")[0]] ?? null);
    const resolvedBody  =
      body  != null ? body
      : (body_i18n?.[lang]  || body_i18n?.[lang.split("-")[0]]  ?? null);

    const plat = String(d.platform || "").toLowerCase();
    const isWeb = (plat === "web");
    const isAndroid = (plat === "android");

    // Para diagnóstico (opcional): agregamos una marca liviana
    const dataWithMark = { ...(data || {}), __sender: "admin" };

    const r = await sendToFcmV1({
      token: d.fcm_token,
      title: resolvedTitle,  // Android usará exactamente esto
      body:  resolvedBody,
      data:  dataWithMark,   // Web lo leerá y lo dibujará tu SW si corresponde
      webDataOnly: isWeb ? true : (isAndroid ? false : !!webDataOnly),
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

module.exports = {
  ensureDevicesTable,
  registerDevice,
  listDevicesByUser,
  listDevicesForBroadcast,
  sendSimpleToUser,
  deleteDeviceById,
};
