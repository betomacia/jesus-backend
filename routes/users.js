// routes/users.js
const express = require("express");

let query;
// Intento 1: reutilizar el `query` exportado por routes/db
try {
  ({ query } = require("./db"));
} catch (e) {
  query = null;
}

if (!query) {
  // Fallback (solo por si acaso): crea su propio cliente si no vino de ./db
  // Asume que ya tenés instalado `postgres` y que DATABASE_URL existe (como en /db).
  const postgres = require("postgres");
  const cs = process.env.DATABASE_URL;
  if (!cs) throw new Error("DATABASE_URL missing");
  const ssl =
    (process.env.PGSSL || "").toLowerCase() === "true"
      ? { rejectUnauthorized: false }
      : undefined;
  const sql = postgres(cs, { ssl, max: 5, idle_timeout: 30 });
  query = sql;
}

const router = express.Router();

// Health simple
router.get("/health", async (_req, res) => {
  try {
    const rs = await query`SELECT NOW() AS now`;
    return res.json({ ok: true, db_now: rs?.[0]?.now || null });
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

    const rs = await query`
      INSERT INTO users (email, lang, platform)
      VALUES (${email}, ${lang}, ${platform})
      ON CONFLICT (email) DO UPDATE
      SET lang = EXCLUDED.lang,
          platform = EXCLUDED.platform,
          updated_at = NOW()
      RETURNING id, email, lang, platform, created_at, updated_at
    `;

    return res.json({ ok: true, user: rs?.[0] || null });
  } catch (e) {
    return res
      .status(500)
      .json({ ok: false, error: "users_register_failed", detail: e?.message || String(e) });
  }
});

module.exports = router;
