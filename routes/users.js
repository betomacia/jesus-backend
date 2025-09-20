// routes/users.js
const express = require("express");
const { randomUUID } = require("crypto");
const { pool } = require("./db"); // usamos el pool de Postgres que ya creaste en routes/db.js

const router = express.Router();

// Asegura la tabla (por si /db/init aún no se ejecutó)
async function ensureUsersTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      public_id TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE,
      lang TEXT,
      platform TEXT,            -- 'ios' | 'android' | 'web'
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);
}
ensureUsersTable().catch(console.error);

/**
 * POST /users/register
 * Crea (o devuelve) un usuario:
 * body: { email?, lang?, platform? }
 * Si viene email y ya existe, actualiza lang/platform y devuelve el mismo user_id.
 */
router.post("/register", async (req, res) => {
  try {
    const { email = null, lang = null, platform = null } = req.body || {};

    // normalizamos email si viene
    const mail = email ? String(email).trim().toLowerCase() : null;

    if (mail) {
      // ¿existe?
      const found = await pool.query(
        "SELECT public_id FROM users WHERE email = $1 LIMIT 1",
        [mail]
      );
      if (found.rowCount > 0) {
        const userId = found.rows[0].public_id;
        await pool.query(
          "UPDATE users SET lang = COALESCE($1, lang), platform = COALESCE($2, platform), updated_at = now() WHERE public_id = $3",
          [lang, platform, userId]
        );
        return res.json({ ok: true, user_id: userId, existed: true });
      }
    }

    // crear nuevo
    const userId = randomUUID();
    await pool.query(
      `INSERT INTO users (public_id, email, lang, platform)
       VALUES ($1, $2, $3, $4)`,
      [userId, mail, lang, platform]
    );

    res.json({ ok: true, user_id: userId, existed: false });
  } catch (e) {
    console.error("users.register error:", e);
    res.status(500).json({ ok: false, error: "users_register_failed" });
  }
});

/**
 * GET /users/:id
 * Devuelve datos mínimos del usuario (para debug / verificación rápida)
 */
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const r = await pool.query(
      "SELECT public_id AS user_id, email, lang, platform, created_at, updated_at FROM users WHERE public_id = $1 LIMIT 1",
      [id]
    );
    if (r.rowCount === 0) return res.status(404).json({ ok: false, error: "not_found" });
    res.json({ ok: true, user: r.rows[0] });
  } catch (e) {
    console.error("users.get error:", e);
    res.status(500).json({ ok: false, error: "users_get_failed" });
  }
});

module.exports = router;
