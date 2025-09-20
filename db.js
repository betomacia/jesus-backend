// db.js — conexión única a Postgres (Railway)
const { Pool } = require("pg");

// Prioriza DATABASE_URL (Railway/Render/Heroku). También acepta RAILWAY_DATABASE_URL.
const URL =
  process.env.DATABASE_URL ||
  process.env.RAILWAY_DATABASE_URL ||
  null;

const pool = URL
  ? new Pool({
      connectionString: URL,
      // Railway suele requerir SSL; si el URL ya trae ?sslmode=require, igual vale.
      ssl: { rejectUnauthorized: false },
    })
  : new Pool({
      host: process.env.PGHOST || "localhost",
      port: Number(process.env.PGPORT || 5432),
      user: process.env.PGUSER || "postgres",
      password: process.env.PGPASSWORD || "",
      database: process.env.PGDATABASE || "postgres",
      ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : false,
    });

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
};
