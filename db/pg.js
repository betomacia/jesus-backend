// db/pg.js — conexión a Postgres en Railway
const { Pool } = require("pg");

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error("❌ Falta la variable DATABASE_URL en Railway");
}

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false }, // Railway requiere SSL
});

async function query(text, params) {
  return pool.query(text, params);
}

async function ping() {
  const r = await pool.query("SELECT NOW() as now");
  return r.rows?.[0]?.now;
}

module.exports = { pool, query, ping };
