// routes/users.js
const express = require("express");
const emailRx = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Tomamos el pool SQL exportado por routes/db.js
const { query: sql } = require("./db");

const router = express.Router();

// -------- Health simple
router.get("/health", async (_req, res) => {
  try {
    const r = await sql`select 1 as ok`;
    res.json({ ok: true, db: r?.[0]?.ok === 1 });
  } catch (e) {
    res.status(500).json({ ok: false, error: "db_error", detail: e.message || String(e) });
  }
});

// -------- Registrar / actualizar usuario por email (UPSERT)
router.post("/register", async (req, res) => {
  try {
    const { email, lang = null, platform = null } = req.body || {};

    if (!email || !emailRx.test(String(email))) {
      return res.status(400).json({ ok: false, error: "email_invalido" });
    }

    const r = await sql`
      INSERT INTO users (email, lang, platform)
      VALUES (${email}, ${lang}, ${platform})
      ON CONFLICT (email) DO UPDATE
        SET lang = EXCLUDED.lang,
            platform = EXCLUDED.platform,
            updated_at = NOW()
      RETURNING id, email, lang, platform, created_at, updated_at
    `;

    const user = r?.[0] || null;
    if (!user) return res.status(500).json({ ok: false, error: "users_register_failed" });

    res.json({ ok: true, user });
  } catch (e) {
    res.status(500).json({ ok: false, error: "users_register_failed", detail: e.message || String(e) });
  }
});

module.exports = router;
