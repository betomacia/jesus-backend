// routes/users.js
const express = require("express");
const { pool } = require("./db"); // usamos el Pool de pg exportado por routes/db.js

const router = express.Router();

// Health simple: prueba de SELECT y devuelve ok
router.get("/health", async (_req, res) => {
  try {
    const r = await pool.query("SELECT NOW() AS now");
    res.json({ ok: true, db: true, now: r.rows?.[0]?.now ?? null });
  } catch (e) {
    res.status(500).json({ ok: false, error: "db_error", detail: e.message || String(e) });
  }
});

// Registrar/actualizar (upsert) por email
router.post("/register", async (req, res) => {
  try {
    const { email, lang = null, platform = null } = req.body || {};
    const em = String(email || "").trim().toLowerCase();
    if (!em) return res.status(400).json({ ok: false, error: "missing_email" });

    const q = `
      INSERT INTO users (email, lang, platform)
      VALUES ($1, $2, $3)
      ON CONFLICT (email)
      DO UPDATE SET
        lang = COALESCE(EXCLUDED.lang, users.lang),
        platform = COALESCE(EXCLUDED.platform, users.platform),
        updated_at = NOW()
      RETURNING id, email, lang, platform, created_at, updated_at;
    `;
    const r = await pool.query(q, [em, lang, platform]);
    res.json({ ok: true, user: r.rows[0] });
  } catch (e) {
    res.status(500).json({ ok: false, error: "users_register_failed", detail: e.message || String(e) });
  }
});

module.exports = router;
