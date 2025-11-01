// db/pg.js
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // Railway te da esta var
  ssl: process.env.PGSSL === "false" ? false : { rejectUnauthorized: false }
});

async function query(text, params) {
  const client = await pool.connect();
  try {
    const res = await client.query(text, params);
    return res;
  } finally {
    client.release();
  }
}

async function ping() {
  const r = await query("SELECT NOW() as now");
  return r.rows[0].now;
}

module.exports = { pool, query, ping };
