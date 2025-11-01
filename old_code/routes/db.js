const express = require("express");
const { Pool } = require("pg");

let _pool = null;
function getPool() {
  if (_pool) return _pool;

  const cs = process.env.DATABASE_URL;
  if (!cs) {
    // No tiramos la app: dejamos que otras rutas (/) sigan vivas.
    throw new Error("DATABASE_URL missing");
  }

  const needsSSL =
    /proxy\.rlwy\.net|neon\.tech|render\.com|amazonaws\.com/i.test(cs) ||
    (process.env.PGSSL || "").toLowerCase() === "true";

  _pool = new Pool({
    connectionString: cs,
    ssl: needsSSL ? { rejectUnauthorized: false } : false,
    max: 8,
    idleTimeoutMillis: 30_000,
  });

  _pool.on("error", (err) => console.error("[PG] pool error:", err));
  return _pool;
}

// Helper: query siempre usa getPool()
async function query(text, params = []) {
  const r = await getPool().query(text, params);
  return r.rows;
}

const router = express.Router();

// Health
router.get("/health", async (_req, res) => {
  try {
    const r = await query("SELECT NOW() AS now");
    res.json({ ok: true, db_now: r?.[0]?.now ?? null, server_now: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ ok: false, error: "db_error", detail: e.message || String(e) });
  }
});

// Init (transaccional)
router.post("/init", async (_req, res) => {
  let client;
  try {
    client = await getPool().connect();
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id BIGSERIAL PRIMARY KEY,
        email TEXT NOT NULL,
        lang TEXT,
        platform TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at  TIMESTAMPTZ DEFAULT NOW();`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMPTZ DEFAULT NOW();`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS lang       TEXT;`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS platform   TEXT;`);
    await client.query(`DROP INDEX IF EXISTS idx_users_email;`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email ON users(email);`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS purchases (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
        provider TEXT,
        external_id TEXT,
        amount_cents INTEGER,
        currency TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await client.query(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_purchases_user ON purchases(user_id);`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS credits (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
        delta INTEGER NOT NULL,
        reason TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await client.query(`ALTER TABLE credits ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_credits_user ON credits(user_id);`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
        role TEXT,
        text TEXT,
        lang TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await client.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();`);
    await client.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS lang TEXT;`);
    await client.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS text TEXT;`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id);`);

    await client.query("COMMIT");
    res.json({ ok: true, created: true });
  } catch (e) {
    try { if (client) await client.query("ROLLBACK"); } catch {}
    res.status(500).json({ ok: false, error: "db_init_failed", detail: e.message || String(e) });
  } finally {
    if (client) client.release();
  }
});

// Stats
router.get("/stats", async (_req, res) => {
  try {
    const u = await query(`SELECT COUNT(*)::int AS c FROM users`);
    const p = await query(`SELECT COUNT(*)::int AS c FROM purchases`);
    const c = await query(`SELECT COALESCE(SUM(delta),0)::int AS s FROM credits`);
    const m = await query(`SELECT COUNT(*)::int AS c FROM messages`);
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

module.exports = { router, query, getPool };
