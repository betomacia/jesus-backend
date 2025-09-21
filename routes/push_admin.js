// routes/push_admin.js
const express = require("express");
const { query } = require("./db");
const { listDevicesByUser, sendSimpleToUser } = require("../services/push.service");

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

// normaliza y bucketiza por grupos
function groupAndPick(devs) {
  const bucket = { android: [], desktop: [] };

  for (const d of devs) {
    const id = (d.device_id || "");

    // ❌ descartamos explícitamente WEB_BOLT
    if (id.startsWith("WEB_BOLT")) continue;

    if (id.startsWith("ANDROID_CHROME")) bucket.android.push(d);
    else if (id.startsWith("WEB_DESKTOP")) bucket.desktop.push(d);
  }

  const byRecent = (a, b) => {
    const la = new Date(a.last_seen || a.created_at || 0).getTime();
    const lb = new Date(b.last_seen || b.created_at || 0).getTime();
    return lb - la || (b.id - a.id);
  };

  const chosen = [];
  if (bucket.desktop.length) chosen.push([...bucket.desktop].sort(byRecent)[0]);
  if (bucket.android.length) chosen.push([...bucket.android].sort(byRecent)[0]);
  return chosen;
}

/**
 * POST /push/admin-broadcast
 * Body: { lang?, platform?, inactive_days?, emails?, title, body, data? }
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
        SELECT d.*, u.id AS user_id, u.lang AS user_lang
          FROM devices d
          JOIN users u ON u.id = d.user_id
        ${where.length ? "WHERE " + where.join(" AND ") : ""}
      `;
      const rows = await query(sql, params);
      devices = rows || [];
    }

    // por usuario, quedarse sólo con 1 desktop + 1 android (descartando WEB_BOLT)
    const byUser = new Map();
    for (const d of devices) {
      if (!byUser.has(d.user_id)) byUser.set(d.user_id, []);
      byUser.get(d.user_id).push(d);
    }

    let sent = 0, targeted = 0;
    for (const [uid, devs] of byUser) {
      const chosen = groupAndPick(devs);
      targeted += chosen.length;

      const user = { id: uid, lang: (devs[0]?.user_lang || devs[0]?.lang || "es") };
      const report = await sendSimpleToUser({
        user,
        devices: chosen,
        title,
        body,
        title_i18n: null,
        body_i18n: null,
        data: data || null,
        overrideLang: null,
        webDataOnly: true, // web/PWA data-only => muestra lo que mandas y evita duplicados
      });
      sent += (report?.sent || 0);
    }

    return res.json({ ok: true, targeted, users: byUser.size, sent });
  } catch (e) {
    console.error("admin-broadcast error:", e);
    return res
      .status(500)
      .json({ ok: false, error: "admin_broadcast_failed", detail: e.message || String(e) });
  }
});

module.exports = router;
