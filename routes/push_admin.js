const express = require("express");
const { query } = require("./db");
const { listDevicesByUser, sendSimpleToUser } = require("../services/push.service");

const router = express.Router();
router.use((req,res,next)=>{res.set("Content-Type","application/json; charset=utf-8");next();});

// POST /push/admin-broadcast
router.post("/admin-broadcast", async (req, res) => {
  try {
    const { lang=null, platform=null, inactive_days=null, emails=null,
            title=null, body=null, data=null } = req.body || {};
    if (!title || !body) return res.status(400).json({ ok:false, error:"title_and_body_required" });

    let devices = [];

    if (Array.isArray(emails) && emails.length) {
      // Busca user ids
      const rows = await query(
        `SELECT id FROM users WHERE email = ANY($1::text[])`,
        [emails.map(e => String(e).trim().toLowerCase())]
      );
      const uids = rows.map(r => r.id);
      if (!uids.length) return res.json({ ok:true, targeted:0, sent:0 });

      // Junta todos los devices de esos usuarios (reusa tu servicio)
      for (const uid of uids) {
        const devs = await listDevicesByUser({ uid, platform: platform || null });
        devices.push(...devs);
      }
    } else {
      // Filtro directo por criterios en tabla devices
      const where = [];
      const params = [];
      let i = 1;

      if (lang)       { where.push(`lang = $${i++}`); params.push(String(lang)); }
      if (platform)   { where.push(`platform = $${i++}`); params.push(String(platform)); }
      if (inactive_days && Number(inactive_days) > 0) {
        where.push(`last_active <= NOW() - ($${i++}::int * INTERVAL '1 day')`);
        params.push(Number(inactive_days));
      }

      const sql = `
        SELECT d.*, u.id AS user_id, u.lang AS user_lang
          FROM devices d
          JOIN users u ON u.id = d.user_id
         ${where.length ? "WHERE " + where.join(" AND ") : ""}
      `;
      const rows = await query(sql, params);
      devices = rows;
    }

    // Agrupar por usuario para usar sendSimpleToUser (reusa localización)
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
        overrideLang: null
      });
      sent += report?.sent || 0;
    }

    return res.json({ ok: true, targeted: devices.length, users: byUser.size, sent });
  } catch (e) {
    console.error("admin-broadcast error:", e);
    res.status(500).json({ ok:false, error:"admin_broadcast_failed", detail: e.message || String(e) });
  }
});

module.exports = router;
