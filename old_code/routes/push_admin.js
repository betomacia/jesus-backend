// routes/push_admin.js
const express = require("express");
const { query } = require("./db");
const { sendSimpleToUser } = require("../services/push.service");

const router = express.Router();

const ADMIN_PUSH_KEY = process.env.ADMIN_PUSH_KEY || null;
function okAdmin(req) {
  const headerKey = (req.get("x-admin-key") || "").toString();
  const paramKey  = (req.query && req.query.admin_key) ? String(req.query.admin_key) : "";
  return ADMIN_PUSH_KEY && (headerKey === ADMIN_PUSH_KEY || paramKey === ADMIN_PUSH_KEY);
}

router.use((_, res, next) => {
  res.set("Content-Type", "application/json; charset=utf-8");
  next();
});

/**
 * POST /push/admin-broadcast
 * Body: { lang?, platform?, inactive_days?, emails?, title, body, data? }
 * - Excluye WEB_BOLT
 * - Toma 1 Desktop (WEB_DESKTOP*) + 1 Android (ANDROID_CHROME*) por usuario (los más recientes)
 * - Envía data-only a web/PWA para evitar duplicados y siempre respetar tu título/cuerpo
 */
router.post("/admin-broadcast", async (req, res) => {
  try {
    if (!okAdmin(req)) return res.status(401).json({ ok: false, error: "unauthorized_admin" });

    const {
      lang = null,
      platform = null,            // opcional: 'web'|'android'|'ios' (no es necesario)
      inactive_days = null,       // opcional
      emails = null,              // opcional: array de emails target
      title = null,
      body = null,
      data = null,
    } = req.body || {};

    if (!title || !body) {
      return res.status(400).json({ ok: false, error: "title_and_body_required" });
    }

    // --- Parámetros y filtros base
    const params = [];
    let whereUser = "";   // para limitar por emails
    let whereExtra = "";  // lang/platform/inactive_days

    if (Array.isArray(emails) && emails.length) {
      params.push(emails.map(e => String(e).trim().toLowerCase()));
      whereUser = `WHERE u.email = ANY($${params.length}::text[])`;
    }

    const extra = [];
    if (lang) {
      params.push(String(lang));
      extra.push(`d.lang = $${params.length}`);
    }
    if (platform) {
      params.push(String(platform));
      extra.push(`d.platform = $${params.length}`);
    }
    if (inactive_days && Number(inactive_days) > 0) {
      params.push(Number(inactive_days));
      extra.push(`COALESCE(d.last_seen, d.created_at) <= NOW() - ($${params.length}::int * INTERVAL '1 day')`);
    }
    // ❌ excluir explícitamente WEB_BOLT
    extra.push(`(d.device_id IS NULL OR d.device_id NOT ILIKE 'WEB_BOLT%')`);

    if (extra.length) {
      whereExtra = `AND ${extra.join(" AND ")}`;
    }

    // --- Selección **en SQL**: 1 desktop + 1 android por usuario, más recientes
    const sql = `
      WITH targets AS (
        SELECT u.id AS user_id, u.lang AS user_lang
          FROM users u
          ${whereUser}
      ),
      devs AS (
        SELECT
          d.*,
          t.user_id,
          t.user_lang,
          CASE
            WHEN d.device_id ILIKE 'ANDROID_CHROME%' THEN 'android'
            WHEN d.device_id ILIKE 'WEB_DESKTOP%'    THEN 'desktop'
            ELSE NULL
          END AS grp
        FROM devices d
        JOIN targets t ON t.user_id = d.user_id
        WHERE 1=1
          ${whereExtra}
      ),
      ranked AS (
        SELECT
          d.*,
          ROW_NUMBER() OVER (
            PARTITION BY d.user_id, d.grp
            ORDER BY COALESCE(d.last_seen, d.created_at) DESC, d.id DESC
          ) AS rn
        FROM devs d
        WHERE d.grp IS NOT NULL   -- sólo android/desktop
      )
      SELECT *
        FROM ranked
       WHERE rn = 1
       ORDER BY user_id, grp;     -- como mucho 2 por usuario (android y/o desktop)
    `;

    const devices = await query(sql, params); // ya vienen filtrados y rankeados

    // Agrupamos por usuario (máx 2 devices por user) y enviamos
    const byUser = new Map();
    for (const d of devices) {
      if (!byUser.has(d.user_id)) byUser.set(d.user_id, { lang: d.user_lang || d.lang || "es", list: [] });
      byUser.get(d.user_id).list.push(d);
    }

    let sent = 0;
    let targeted = devices.length;

    for (const [uid, pack] of byUser) {
      const user = { id: uid, lang: pack.lang || "es" };
      const devs = pack.list;

      const report = await sendSimpleToUser({
        user,
        devices: devs,
        title,
        body,
        title_i18n: null,
        body_i18n: null,
        data: data || null,
        overrideLang: null,
        webDataOnly: true, // web/PWA data-only → muestra exactamente tu título/cuerpo y evita duplicados
      });
      sent += (report?.sent || 0);
    }

    return res.json({ ok: true, targeted, users: byUser.size, sent });
  } catch (e) {
    console.error("admin-broadcast error:", e);
    return res.status(500).json({ ok: false, error: "admin_broadcast_failed", detail: e.message || String(e) });
  }
});

module.exports = router;
