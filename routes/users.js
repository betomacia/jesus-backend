// routes/users.js
const express = require("express");
const { query } = require("./db");

const router = express.Router();

// ---------- Health ----------
router.get("/health", async (_req, res) => {
  try {
    const r = await query("SELECT NOW() AS now");
    res.json({ ok: true, db: true, now: r?.[0]?.now ?? null });
  } catch (e) {
    res.status(500).json({ ok: false, error: "db_error", detail: e.message || String(e) });
  }
});

// ---------- Registrar / Upsert por email ----------
router.post("/register", async (req, res) => {
  try {
    const { email = "", lang = null, platform = null } = req.body || {};
    const em = String(email || "").trim().toLowerCase();
    if (!em) return res.status(400).json({ ok: false, error: "missing_email" });

    const rows = await query(
      `
      INSERT INTO users (email, lang, platform)
      VALUES ($1, $2, $3)
      ON CONFLICT (email) DO UPDATE SET
        lang       = COALESCE(EXCLUDED.lang, users.lang),
        platform   = COALESCE(EXCLUDED.platform, users.platform),
        updated_at = NOW()
      RETURNING id, email, lang, platform, created_at, updated_at;
      `,
      [em, lang, platform]
    );

    res.json({ ok: true, user: rows[0] });
  } catch (e) {
    res.status(500).json({ ok: false, error: "users_register_failed", detail: e.message || String(e) });
  }
});

// Helper: obtener user_id por query/body (user_id o email)
async function resolveUserId(req) {
  const rawId = req.query.user_id ?? req.body?.user_id;
  const user_id = rawId ? Number(rawId) : null;
  if (user_id) return user_id;

  const email = (req.query.email || req.body?.email || "").toString().trim().toLowerCase();
  if (!email) return null;

  const r = await query(`SELECT id FROM users WHERE email = $1`, [email]);
  return r?.[0]?.id || null;
}

// ---------- Créditos: sumar (positivo o negativo) ----------
router.post("/credit/add", async (req, res) => {
  try {
    const uid = await resolveUserId(req);
    if (!uid) return res.status(400).json({ ok: false, error: "missing_user" });

    const delta = parseInt(req.body?.delta, 10);
    if (!Number.isFinite(delta) || delta === 0) {
      return res.status(400).json({ ok: false, error: "invalid_delta" });
    }

    const reason = (req.body?.reason ? String(req.body.reason).slice(0, 80) : null);

    await query(
      `INSERT INTO credits (user_id, delta, reason) VALUES ($1, $2, $3)`,
      [uid, delta, reason]
    );

    const bal = await query(
      `SELECT COALESCE(SUM(delta),0)::int AS balance FROM credits WHERE user_id = $1`,
      [uid]
    );

    res.json({ ok: true, user_id: uid, balance: bal?.[0]?.balance ?? 0 });
  } catch (e) {
    res.status(500).json({ ok: false, error: "credit_add_failed", detail: e.message || String(e) });
  }
});

// ---------- Créditos: consultar balance ----------
router.get("/credit/balance", async (req, res) => {
  try {
    const uid = await resolveUserId(req);
    if (!uid) return res.status(400).json({ ok: false, error: "missing_user" });

    const bal = await query(
      `SELECT COALESCE(SUM(delta),0)::int AS balance FROM credits WHERE user_id = $1`,
      [uid]
    );

    res.json({ ok: true, user_id: uid, balance: bal?.[0]?.balance ?? 0 });
  } catch (e) {
    res.status(500).json({ ok: false, error: "credit_balance_failed", detail: e.message || String(e) });
  }
});

/* ============================
   MENSAJES (memoria 90 días)
   ============================ */

// Agregar mensaje
router.post("/message/add", async (req, res) => {
  try {
    const uid = await resolveUserId(req);
    if (!uid) return res.status(400).json({ ok: false, error: "missing_user" });

    const role = String(req.body?.role || "").toLowerCase();
    if (!["user", "assistant"].includes(role)) {
      return res.status(400).json({ ok: false, error: "invalid_role" });
    }

    const content = String(req.body?.content || "").trim().slice(0, 8000);
    if (!content) return res.status(400).json({ ok: false, error: "empty_content" });

    const lang = req.body?.lang ? String(req.body.lang).slice(0, 8) : null;

    // Permitir timestamp opcional desde el cliente (hora del dispositivo)
    let at = null;
    if (req.body?.at) {
      const d = new Date(req.body.at);
      if (!isNaN(d.getTime())) at = d.toISOString();
    }

    const rows = await query(
      `
      INSERT INTO messages (user_id, role, content, lang, created_at)
      VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, NOW()))
      RETURNING id, created_at;
      `,
      [uid, role, content, lang, at]
    );

    res.json({ ok: true, id: rows[0].id, created_at: rows[0].created_at });
  } catch (e) {
    res.status(500).json({ ok: false, error: "message_add_failed", detail: e.message || String(e) });
  }
});

// Listar mensajes recientes (por defecto 90 días)
router.get("/message/recent", async (req, res) => {
  try {
    const uid = await resolveUserId(req);
    if (!uid) return res.status(400).json({ ok: false, error: "missing_user" });

    const days = Math.max(1, Math.min(365, parseInt(req.query.days ?? "90", 10)));
    const limit = Math.max(1, Math.min(200, parseInt(req.query.limit ?? "50", 10)));

    const cutoff = new Date(Date.now() - days * 86400 * 1000).toISOString();

    const rows = await query(
      `
      SELECT id, role, content, lang, created_at
      FROM messages
      WHERE user_id = $1 AND created_at >= $2::timestamptz
      ORDER BY created_at DESC
      LIMIT $3;
      `,
      [uid, cutoff, limit]
    );

    res.json({ ok: true, user_id: uid, days, count: rows.length, messages: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: "message_recent_failed", detail: e.message || String(e) });
  }
});

// Limpieza (borra > days). Global o por usuario/email
router.post("/message/cleanup", async (req, res) => {
  try {
    const days = Math.max(1, Math.min(365, parseInt(req.body?.days ?? "90", 10)));
    const cutoff = new Date(Date.now() - days * 86400 * 1000).toISOString();

    let uid = null;
    // opcional: limitar a un usuario
    const rawId = req.body?.user_id;
    if (rawId) uid = Number(rawId);
    if (!uid && req.body?.email) {
      const em = String(req.body.email).trim().toLowerCase();
      const r = await query(`SELECT id FROM users WHERE email = $1`, [em]);
      uid = r?.[0]?.id || null;
    }

    let del;
    if (uid) {
      del = await query(
        `DELETE FROM messages WHERE user_id = $1 AND created_at < $2::timestamptz RETURNING id`,
        [uid, cutoff]
      );
    } else {
      del = await query(
        `DELETE FROM messages WHERE created_at < $1::timestamptz RETURNING id`,
        [cutoff]
      );
    }

    res.json({ ok: true, days, deleted: del.length, scope: uid ? { user_id: uid } : "all" });
  } catch (e) {
    res.status(500).json({ ok: false, error: "message_cleanup_failed", detail: e.message || String(e) });
  }
});

module.exports = router;
