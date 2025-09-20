// routes/users.js
const express = require("express");
const router = express.Router();

// Importa el helper de consultas desde routes/db.js
const { query } = require("./db");

// Salud de la ruta + DB
router.get("/health", async (_req, res) => {
  try {
    const r = await query("SELECT now()");
    res.json({ ok: true, now: r.rows[0].now });
  } catch (e) {
    res.status(500).json({ ok: false, error: "db_error", detail: e.message });
  }
});

// Registrar (upsert) por email y devolver user_id
router.post("/register", async (req, res) => {
  try {
    const { email, lang = "es", platform = "web" } = req.body || {};
    if (!email) {
      return res.status(400).json({ ok: false, error: "email_required" });
    }

    // Inserta o actualiza y devuelve el user_id
    const sql = `
      INSERT INTO users (email, lang, platform)
      VALUES ($1, $2, $3)
      ON CONFLICT (email)
      DO UPDATE SET lang = EXCLUDED.lang, platform = EXCLUDED.platform
      RETURNING user_id;
    `;
    const r = await query(sql, [email, lang, platform]);
    res.json({ ok: true, user_id: r.rows[0].user_id });
  } catch (e) {
    res.status(500).json({ ok: false, error: "users_register_failed", detail: e.message });
  }
});

// Obtener un usuario por id
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const r = await query(
      `SELECT user_id, email, lang, platform, created_at
         FROM users
        WHERE user_id = $1`,
      [id]
    );
    if (r.rowCount === 0) {
      return res.status(404).json({ ok: false, error: "not_found" });
    }
    res.json({ ok: true, user: r.rows[0] });
  } catch (e) {
    res.status(500).json({ ok: false, error: "users_get_failed", detail: e.message });
  }
});

module.exports = router;
