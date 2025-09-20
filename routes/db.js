// routes/db.js
const express = require("express");
const { Pool } = require("pg");

/** Construye el Pool desde DATABASE_URL */
function buildPool() {
  const cs = process.env.DATABASE_URL;
  if (!cs) throw new Error("Falta DATABASE_URL en variables de entorno.");

  // SSL solo si es proxy público o fuerzas PGSSL=true
  const needsSSL =
    /proxy\.rlwy\.net|neon\.tech|render\.com|amazonaws\.com/i.test(cs) ||
    (process.env.PGSSL || "").toLowerCase() === "true";

  const pool = new Pool({
    connectionString: cs,
    ssl: needsSSL ? { rejectUnauthorized: false } : false,
    max: 8,
    idleTimeoutMillis: 30_000,
  });

  pool.on("error", (err) => {
    console.error("[PG] error en cliente/pool:", err);
  });

  return pool;
}

const pool = buildPool();
const router = express.Router();

/** Helper: query(text, params) => rows */
async function query(text, params = []) {
  const r = await pool.query(text, params);
  return r.rows;
}

// ---------- Health ----------
router.get("/health", async (_req, res) => {
  try {
    const r = await query("SELECT NOW() AS now");
    res.json({ ok: true, db_now: r?.[0]?.now ?? null, server_now: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ ok: false, error: "db_error", detail: e.message || String(e) });
  }
});

// ---------- Init (crear/ajustar tablas) ----------
router.post("/init", async (_req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // users
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id          BIGSERIAL PRIMARY KEY,
        email       TEXT NOT NULL,
        lang        TEXT,
        platform    TEXT,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at  TIMESTAMPTZ DEFAULT NOW();`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMPTZ DEFAULT NOW();`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS lang       TEXT;`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS platform   TEXT;`);
    await client.query(`DROP INDEX IF EXISTS idx_users_email;`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email ON users(email);`);

    // purchases
    await client.query(`
      CREATE TABLE IF NOT EXISTS purchases (
        id            BIGSERIAL PRIMARY KEY,
        user_id       BIGINT REFERENCES users(id) ON DELETE CASCADE,
        provider      TEXT,
        external_id   TEXT,
        amount_cents  INTEGER,
        currency      TEXT,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await client.query(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_purchases_user ON purchases(user_id);`);

    // credits
    await client.query(`
      CREATE TABLE IF NOT EXISTS credits (
        id          BIGSERIAL PRIMARY KEY,
        user_id     BIGINT REFERENCES users(id) ON DELETE CASCADE,
        delta       INTEGER NOT NULL,
        reason      TEXT,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await client.query(`ALTER TABLE credits ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_credits_user ON credits(user_id);`);

    // messages
    await client.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id          BIGSERIAL PRIMARY KEY,
        user_id     BIGINT REFERENCES users(id) ON DELETE CASCADE,
        role        TEXT,
        content     TEXT,
        lang        TEXT,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    // Asegurar columnas presentes
    await client.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS role TEXT;`);
    await client.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS content TEXT;`);
    await client.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS lang TEXT;`);
    await client.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id);`);

    // Migraciones de columnas legadas: "message" o "text" -> "content"
    await client.query(`
      DO $$
      BEGIN
        -- message -> content
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name='messages' AND column_name='message'
        ) AND NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name='messages' AND column_name='content'
        ) THEN
          EXECUTE 'ALTER TABLE messages RENAME COLUMN message TO content';
        END IF;

        -- text -> content
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name='messages' AND column_name='text'
        ) AND NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name='messages' AND column_name='content'
        ) THEN
          EXECUTE 'ALTER TABLE messages RENAME COLUMN text TO content';
        END IF;

        -- Si existen ambas (text y content), elimina la heredada "text"
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name='messages' AND column_name='text'
        ) AND EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name='messages' AND column_name='content'
        ) THEN
          -- por si tenía NOT NULL
          EXECUTE 'ALTER TABLE messages ALTER COLUMN text DROP NOT NULL';
          EXECUTE 'ALTER TABLE messages DROP COLUMN text';
        END IF;
      END $$;
    `);

    await client.query("COMMIT");
    res.json({ ok: true, created: true });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    res.status(500).json({ ok: false, error: "db_init_failed", detail: e.message || String(e) });
  } finally {
    client.release();
  }
});

// ---------- Stats simples ----------
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

module.exports = { router, query, pool };
