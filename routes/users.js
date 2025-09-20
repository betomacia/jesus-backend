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

module.exports = router;
