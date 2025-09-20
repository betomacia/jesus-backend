// routes/users.js
const express = require("express");
const { query } = require("./db");

const router = express.Router();

// Health: comprobar conexión a DB
router.get("/health", async (_req, res) => {
  try {
    const { rows } = await query`SELECT NOW() AS now`;
    return res.json({ ok: true, db_now: rows?.[0]?.now || null });
  } catch (e) {
    return res
      .status(500)
      .json({ ok: false, error: "db_error", detail: e?.message || String(e) });
  }
});

// Registrar/actualizar (upsert) usuario por email
router.post("/register", async (req, res) => {
  try {
    const { email, lang = "es", platform = "web" } = req.body || {};
    if (!email) return res.status(400).json({ ok: false, error: "missing_email" });

    const { rows } = await query`
      INSERT INTO users (email, lang, platform)
      VALUES (${email}, ${lang}, ${platform})
      ON CONFLICT (email) DO UPDATE
      SET lang = EXCLUDED.lang,
          platform = EXCLUDED.platform,
          updated_at = NOW()
      RETURNING id, email, lang, platform, created_at, updated_at
    `;

    return res.json({ ok: true, user: rows[0] });
  } catch (e) {
    return res
      .status(500)
      .json({ ok: false, error: "users_register_failed", detail: e?.message || String(e) });
  }
});

module.exports = router;
