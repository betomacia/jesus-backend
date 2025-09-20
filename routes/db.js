// routes/db.js
const express = require("express");
const postgres = require("postgres");

// Crea el pool a partir de DATABASE_URL
function buildPool() {
  const cs = process.env.DATABASE_URL;
  if (!cs) throw new Error("Falta DATABASE_URL en variables de entorno.");

  // SSL solo si es proxy público (Railway proxy) o fuerzas PGSSL=true
  const needsSSL =
    /proxy\.rlwy\.net|neon\.tech|render\.com|amazonaws\.com/i.test(cs) ||
    (process.env.PGSSL || "").toLowerCase() === "true";

  const sql = postgres(cs, {
    ssl: needsSSL ? { rejectUnauthorized: false } : undefined,
    max: 5,
    idle_timeout: 30,
  });
  return sql;
}

const sql = buildPool();
const router = express.Router();

// ---------- Health ----------
router.get("/health", async (_req, res) => {
  try {
    const r = await sql`SELECT NOW() AS now`;
    res.json({ ok: true, db_now: r?.[0]?.now ?? null });
  } catch (e) {
    res.status(500).json({ ok: false, error: "db_error", detail: e.message || String(e) });
  }
});

// ---------- Init (crear tablas si no existen) ----------
router.post("/init", async (_req, res) => {
  try {
    await sql.begin(async (tx) => {
      await tx`
        CREATE TABLE IF NOT EXISTS users (
          id          BIGSERIAL PRIMARY KEY,
          email       TEXT UNIQUE NOT NULL,
          lang        TEXT,
          platform    TEXT,
          created_at  TIMESTAMPTZ DEFAULT NOW(),
          updated_at  TIMESTAMPTZ DEFAULT NOW()
        );
      `;
      await tx`
        CREATE TABLE IF NOT EXISTS purchases (
          id          BIGSERIAL PRIMARY KEY,
          user_id     BIGINT REFERENCES users(id) ON DELETE CASCADE,
          provider    TEXT,            -- 'apple' | 'google' | 'stripe' | etc.
          external_id TEXT,            -- id de recibo/orden
          amount_cents INTEGER,
          currency    TEXT,
          created_at  TIMESTAMPTZ DEFAULT NOW()
        );
      `;
      await tx`
        CREATE TABLE IF NOT EXISTS credits (
          id          BIGSERIAL PRIMARY KEY,
          user_id     BIGINT REFERENCES users(id) ON DELETE CASCADE,
          delta       INTEGER NOT NULL,    -- +carga / -consumo
          reason      TEXT,                -- 'purchase' | 'chat' | 'audio' | etc.
          created_at  TIMESTAMPTZ DEFAULT NOW()
        );
      `;
      await tx`
        CREATE TABLE IF NOT EXISTS messages (
          id          BIGSERIAL PRIMARY KEY,
          user_id     BIGINT REFERENCES users(id) ON DELETE CASCADE,
          role        TEXT,                -- 'user' | 'assistant'
          content     TEXT,
          lang        TEXT,
          created_at  TIMESTAMPTZ DEFAULT NOW()
        );
      `;
    });

    res.json({ ok: true, created: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: "db_init_failed", detail: e.message || String(e) });
  }
});

// ---------- Stats simples ----------
router.get("/stats", async (_req, res) => {
  try {
    const u = await sql`SELECT COUNT(*)::int AS c FROM users`;
    const p = await sql`SELECT COUNT(*)::int AS c FROM purchases`;
    const c = await sql`SELECT COALESCE(SUM(delta),0)::int AS s FROM credits`;
    const m = await sql`SELECT COUNT(*)::int AS c FROM messages`;
    res.json({
      ok: true,
      users: u?.[0]?.c ?? 0,
      purchases: p?.[0]?.c ?? 0,
      credits: c?.[0]?.s ?? 0,
      messages: m?.[0]?.c ?? 0,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: "db_stats_failed", detail: e.message || String(e) });
  }
});

// Exportamos **objeto** con router y query
module.exports = { router, query: sql };
