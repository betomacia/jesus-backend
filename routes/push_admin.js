// routes/push_admin.js
const express = require("express");
const { query } = require("./db");
const { listDevicesByUser, sendSimpleToUser } = require("../services/push.service");

const router = express.Router();

// ---------- util: admin key ----------
const ADMIN_PUSH_KEY = process.env.ADMIN_PUSH_KEY || null;
function okAdmin(req) {
  const headerKey = (req.get("x-admin-key") || "").toString();
  const paramKey  = (req.query && req.query.admin_key) ? String(req.query.admin_key) : "";
  return ADMIN_PUSH_KEY && (headerKey === ADMIN_PUSH_KEY || paramKey === ADMIN_PUSH_KEY);
}

// ---------- headers JSON ----------
router.use((req, res, next) => {
  res.set("Content-Type", "application/json; charset=utf-8");
  next();
});

/**
 * POST /push/admin-broadcast
 * Body: { lang?, platform?, inactive_days?, emails?, title, body, data? }
 * (se agrupa por usuario para respetar idioma)
 */
router.post("/admin-broadcast", async (req, res) => {
  try {
    if (!okAdmin(req)) return res.status(401).json({ ok: false, error: "unauthorized_admin" });

    const {
      lang = null,
      platform = null,
      inactive_days = null,
      emails = null,
      title = null,
      body = null,
      data = null,
    } = req.body || {};

    if (!title || !body) {
      return res.status(400).json({ ok: false, error: "title_and_body_required" });
    }

    let devices = [];

    if (Array.isArray(emails) && emails.length) {
      // target explícito por emails
      const rows = await query(
        `SELECT id FROM users WHERE email = ANY($1::text[])`,
        [emails.map((e) => String(e).trim().toLowerCase())]
      );
      const uids = rows.map((r) => r.id);
      if (!uids.length) return res.json({ ok: true, targeted: 0, sent: 0 });

      for (const uid of uids) {
        const devs = await listDevicesByUser({ uid, platform: platform || null });
        devices.push(...devs);
      }
    } else {
      // filtro por devices + join users
      const where = [];
      const params = [];
      let i = 1;

      if (lang) {
        where.push(`d.lang = $${i++}`);
        params.push(String(lang));
      }
      if (platform) {
        where.push(`d.platform = $${i++}`);
        params.push(String(platform));
      }
      if (inactive_days && Number(inactive_days) > 0) {
        where.push(
          `COALESCE(d.last_seen, d.created_at) <= NOW() - ($${i++}::int * INTERVAL '1 day')`
        );
        params.push(Number(inactive_days));
      }

      const sql = `
        SELECT
          d.*,
          u.id   AS user_id,
          u.lang AS user_lang
        FROM devices d
        JOIN users   u ON u.id = d.user_id
        ${where.length ? "WHERE " + where.join(" AND ") : ""}
      `;
      const rows = await query(sql, params);
      devices = rows || [];
    }

    // agrupar por usuario y enviar
    const byUser = new Map();
    for (const d of devices) {
      if (!byUser.has(d.user_id)) byUser.set(d.user_id, []);
      byUser.get(d.user_id).push(d);
    }

    let sent = 0;
    for (const [uid, devs] of byUser) {
      const user = { id: uid, lang: (devs[0] && (devs[0].user_lang || devs[0].lang)) || "es" };
      const report = await sendSimpleToUser({
        user,
        devices: devs,
        title,
        body,
        title_i18n: null,
        body_i18n: null,
        data: data || null,
        overrideLang: null,
        webDataOnly: true, // evita toasts duplicados en web
      });
      sent += (report && report.sent) ? report.sent : 0;
    }

    return res.json({ ok: true, targeted: devices.length, users: byUser.size, sent });
  } catch (e) {
    console.error("admin-broadcast error:", e);
    return res
      .status(500)
      .json({ ok: false, error: "admin_broadcast_failed", detail: e.message || String(e) });
  }
});

/**
 * LIMPIEZA de devices (expuesta para correr desde el navegador).
 * Requiere admin key. Acepta GET (con ?admin_key=) y POST (header X-Admin-Key).
 *
 * GET/POST /push/cleanup-devices
 * Respuesta: { ok:true, steps:{...} }
 */
async function runCleanup() {
  // 1) duplicados exactos por token (deja el más nuevo)
  const r1 = await query(`
    WITH dups AS (
      SELECT d.id
      FROM devices d
      JOIN devices d2
        ON d.fcm_token = d2.fcm_token
       AND d.id < d2.id
    )
    DELETE FROM devices WHERE id IN (SELECT id FROM dups)
    RETURNING id
  `);

  // 2) duplicados por (user_id, device_id) (deja el más nuevo)
  const r2 = await query(`
    WITH dups AS (
      SELECT d.id
      FROM devices d
      JOIN devices d2
        ON d.user_id = d2.user_id
       AND (d.device_id IS NOT DISTINCT FROM d2.device_id)
       AND d.id < d2.id
    )
    DELETE FROM devices WHERE id IN (SELECT id FROM dups)
    RETURNING id
  `);

  // 3) conserva 1 Android y 1 Desktop por usuario (más recientes)
  const r3 = await query(`
    WITH ranked AS (
      SELECT id,
             user_id,
             CASE
               WHEN device_id ILIKE 'ANDROID_CHROME%' THEN 'android'
               WHEN device_id ILIKE 'WEB_DESKTOP%'    THEN 'desktop'
               ELSE 'other'
             END AS grp,
             ROW_NUMBER() OVER (
               PARTITION BY user_id,
                            CASE
                              WHEN device_id ILIKE 'ANDROID_CHROME%' THEN 'android'
                              WHEN device_id ILIKE 'WEB_DESKTOP%'    THEN 'desktop'
                              ELSE 'other'
                            END
               ORDER BY last_seen DESC, id DESC
             ) rn
      FROM devices
    )
    DELETE FROM devices d
    USING ranked r
    WHERE d.id = r.id
      AND r.grp IN ('android','desktop')
      AND r.rn > 1
    RETURNING d.id
  `);

  // 4) purge viejos
  const r4 = await query(`
    DELETE FROM devices
     WHERE last_seen < NOW() - INTERVAL '120 days'
    RETURNING id
  `);

  return {
    step1_deleted_by_token: (r1 || []).length,
    step2_deleted_by_user_device: (r2 || []).length,
    step3_kept_one_android_one_desktop: (r3 || []).length,
    step4_purged_old: (r4 || []).length,
  };
}

router.all("/cleanup-devices", async (req, res) => {
  try {
    if (!okAdmin(req)) return res.status(401).json({ ok: false, error: "unauthorized_admin" });

    const steps = await runCleanup();
    return res.json({ ok: true, steps });
  } catch (e) {
    console.error("cleanup-devices error:", e);
    return res.status(500).json({ ok: false, error: "cleanup_failed", detail: e.message || String(e) });
  }
});

module.exports = router;
