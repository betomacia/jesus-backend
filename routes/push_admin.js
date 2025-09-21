// routes/push_admin.js
const express = require("express");
const { query } = require("./db");
const { listDevicesByUser, sendSimpleToUser } = require("../services/push.service");

const router = express.Router();
router.use((req, res, next) => {
  res.set("Content-Type", "application/json; charset=utf-8");
  next();
});

/* ================== PROTECCIÓN PARA ENDPOINTS ADMIN ================== */
// Usa ADMIN_TOOLS_KEY (recomendado) o, si no está, cae a ADMIN_PUSH_KEY para compat
function requireKey(req, res, next) {
  const headerKey = (req.get("x-admin-key") || "").toString();
  const queryKey  = (req.query.key || "").toString();
  const K = process.env.ADMIN_TOOLS_KEY || process.env.ADMIN_PUSH_KEY || "";
  if (!K || (headerKey !== K && queryKey !== K)) {
    return res.status(403).json({ ok: false, error: "unauthorized" });
  }
  next();
}

/* ================== LIMPIEZA DE DEVICES ==================
   POST /push/cleanup-devices?key=MI_CLAVE
   - Ejecuta la limpieza de duplicados / viejos en 4 pasos
   - Devuelve contadores por paso
*/
router.post("/cleanup-devices", requireKey, async (_req, res) => {
  try {
    // 1) Duplicados exactos por token (deja el más nuevo)
    const step1 = await query(`
      DELETE FROM devices d
      USING devices d2
      WHERE d.fcm_token = d2.fcm_token
        AND d.id < d2.id
      RETURNING d.id;
    `);
    const del_token_dups = step1.length || 0;

    // 2) Duplicados por (user_id, device_id) (deja el más nuevo)
    const step2 = await query(`
      DELETE FROM devices d
      USING devices d2
      WHERE d.user_id = d2.user_id
        AND d.device_id IS NOT DISTINCT FROM d2.device_id
        AND d.id < d2.id
      RETURNING d.id;
    `);
    const del_pair_dups = step2.length || 0;

    // 3) Conserva 1 Android y 1 Desktop por usuario (más recientes)
    const step3 = await query(`
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
      RETURNING d.id;
    `);
    const del_extra_per_group = step3.length || 0;

    // 4) Purga muy viejos (ajustable)
    const step4 = await query(`
      DELETE FROM devices
      WHERE last_seen < NOW() - INTERVAL '120 days'
      RETURNING id;
    `);
    const del_old = step4.length || 0;

    return res.json({
      ok: true,
      deleted: {
        token_dups: del_token_dups,
        user_device_dups: del_pair_dups,
        extras_android_desktop: del_extra_per_group,
        very_old: del_old,
      },
      note: "cleanup executed",
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

/* ================== ADMIN BROADCAST EXISTENTE ================== */
// POST /push/admin-broadcast
router.post("/admin-broadcast", async (req, res) => {
  try {
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
      // 1) Target explícito por emails
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
      // 2) Filtro por criterios en devices (con alias para evitar ambigüedad)
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
        // Usa last_seen (o created_at si es null)
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
      devices = rows;
    }

    // Agrupar por usuario y enviar (respeta idioma por user)
    const byUser = new Map();
    for (const d of devices) {
      if (!byUser.has(d.user_id)) byUser.set(d.user_id, []);
      byUser.get(d.user_id).push(d);
    }

    let sent = 0;
    for (const [uid, devs] of byUser) {
      const user = { id: uid, lang: devs[0]?.user_lang || devs[0]?.lang || "es" };
      const report = await sendSimpleToUser({
        user,
        devices: devs,
        title,
        body,
        title_i18n: null,
        body_i18n: null,
        data: data || null,
        overrideLang: null,
      });
      sent += report?.sent || 0;
    }

    return res.json({ ok: true, targeted: devices.length, users: byUser.size, sent });
  } catch (e) {
    console.error("admin-broadcast error:", e);
    return res
      .status(500)
      .json({ ok: false, error: "admin_broadcast_failed", detail: e.message || String(e) });
  }
});

module.exports = router;
