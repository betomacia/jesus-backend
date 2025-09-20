// routes/users.js
const express = require("express");
const { randomUUID } = require("crypto");
const { pool } = require("./db");

const router = express.Router();

// Asegura tabla e índices (una vez)
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
  // Índices por si la tabla venía de antes sin unique en email/public_id
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON users(email) WHERE email IS NOT NULL;`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_public_id_key ON users(public_id);`);
}
ensureUsersTable().catch(console.error);

/**
 * GET /users/health  -> comprobación rápida
 */
router.get("/health", async (_req, res) => {
  try {
    const r = await pool.query("SELECT now() AS db_now");
    res.json({ ok: true, db_now: r.rows[0].db_now });
  } catch (e) {
    res.status(500).json({ ok: false, error: "db_error", detail: String(e?.message || e) });
  }
});

/**
 * POST /users/register
 * Crea o devuelve usuario.
 * body: { email?, lang?, platform? }
 * - Si viene email: UPSERT por email (único).
 * - Si NO viene email: crea uno nuevo por public_id aleatorio.
 */
router.post("/register", async (req, res) => {
  const client = await pool.connect();
  try {
    const { email = null, lang = null, platform = null } = req.body || {};
    const mail = email ? String(email).trim().toLowerCase() : null;

    let userId;

    if (mail) {
      // UPSERT por email
      const upsert = await client.query(
        `
        INSERT INTO users (public_id, email, lang, platform)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (email) DO UPDATE
          SET lang = COALESCE(EXCLUDED.lang, users.lang),
              platform = COALESCE(EXCLUDED.platform, users.platform),
              updated_at = now()
        RETURNING public_id;
        `,
        [randomUUID(), mail, lang, platform]
      );
      userId = upsert.rows[0].public_id;
      return res.json({ ok: true, user_id: userId });
    }

    // Sin email: creamos siempre un nuevo registro
    userId = randomUUID();
    await client.query(
      `
      INSERT INTO users (public_id, email, lang, platform)
      VALUES ($1, NULL, $2, $3)
      `,
      [userId, lang, platform]
    );

    res.json({ ok: true, user_id: userId });
  } catch (e) {
    console.error("users.register error:", e);
    // Intentamos dar un error más claro
    const msg = String(e?.message || e);
    if (msg.includes("unique") || msg.includes("duplicate key")) {
      return res.status(409).json({ ok: false, error: "duplicate", detail: msg });
    }
    res.status(500).json({ ok: false, error: "users_register_failed", detail: msg });
  } finally {
    client.release();
  }
});

/**
 * GET /users/:id  -> datos mínimos del usuario
 */
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const r = await pool.query(
      `
      SELECT public_id AS user_id, email, lang, platform, created_at, updated_at
      FROM users
      WHERE public_id = $1
      LIMIT 1
      `,
      [id]
    );
    if (r.rowCount === 0) return res.status(404).json({ ok: false, error: "not_found" });
    res.json({ ok: true, user: r.rows[0] });
  } catch (e) {
    console.error("users.get error:", e);
    res.status(500).json({ ok: false, error: "users_get_failed", detail: String(e?.message || e) });
  }
});

module.exports = router;
