// routes/db.js
const express = require("express");
const { Pool } = require("pg");

const router = express.Router();

// Detecta si Railway interno (sin SSL) o externo (con SSL)
function buildPool() {
  const cs = process.env.DATABASE_URL;
  if (!cs) throw new Error("Falta DATABASE_URL en variables de entorno.");

  const isRailwayInternal = /railway\.internal:\d+\/railway/i.test(cs);
  return new Pool({
    connectionString: cs,
    ssl: isRailwayInternal ? false : { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
}

const pool = buildPool();

// GET /db/health  — prueba conexión
router.get("/health", async (_req, res) => {
  try {
    const r = await pool.query("SELECT NOW() as now");
    return res.json({
      ok: true,
      db_now: r.rows[0].now,
      server_now: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[DB][HEALTH] ", err);
    return res.status(500).json({ ok: false, error: "db_health_error" });
  }
});

// POST /db/init  — crea tablas mínimas si no existen
router.post("/init", async (_req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Usuarios
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id BIGSERIAL PRIMARY KEY,
        external_id TEXT UNIQUE,          -- opcional: id del frontend/app store
        email TEXT,
        lang TEXT,                        -- es | en | pt | ...
        country TEXT,
        platform TEXT,                    -- ios | android | web
        notification_token TEXT,          -- token push (FCM/APNs)
        marketing_consent BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        last_active_at TIMESTAMPTZ
      );
    `);

    // Compras / Suscripciones
    await client.query(`
      CREATE TABLE IF NOT EXISTS purchases (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
        provider TEXT,                    -- apple | google | stripe | ...
        product_id TEXT,
        price_cents INTEGER,
        currency TEXT,
        purchased_at TIMESTAMPTZ DEFAULT NOW(),
        receipt JSONB
      );
    `);

    // Créditos (histórico de movimientos)
    await client.query(`
      CREATE TABLE IF NOT EXISTS credits (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
        delta INTEGER NOT NULL,           -- +agrega / -consume
        reason TEXT,                      -- "buy", "gift", "chat", "audio", "video"
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Mensajes (para memoria 90 días)
    await client.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
        role TEXT CHECK (role IN ('user','assistant')) NOT NULL,
        text TEXT NOT NULL,
        ts TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Índices útiles
    await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_user_ts ON messages (user_id, ts DESC);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_credits_user_created ON credits (user_id, created_at DESC);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_purchases_user ON purchases (user_id);`);

    await client.query("COMMIT");
    return res.json({ ok: true, created: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[DB][INIT] ", err);
    return res.status(500).json({ ok: false, error: "db_init_error" });
  } finally {
    client.release();
  }
});

// GET /db/stats — cuenta filas (rápido para ver que todo anda)
router.get("/stats", async (_req, res) => {
  try {
    const q = (sql) => pool.query(sql).then(r => Number(r.rows[0].n || 0));
    const [users, purchases, credits, messages] = await Promise.all([
      q("SELECT COUNT(*)::int AS n FROM users"),
      q("SELECT COUNT(*)::int AS n FROM purchases"),
      q("SELECT COUNT(*)::int AS n FROM credits"),
      q("SELECT COUNT(*)::int AS n FROM messages"),
    ]);
    return res.json({ ok: true, users, purchases, credits, messages });
  } catch (err) {
    console.error("[DB][STATS] ", err);
    return res.status(500).json({ ok: false, error: "db_stats_error" });
  }
});

module.exports = router;
