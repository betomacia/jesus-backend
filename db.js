// db.js
const { Pool } = require("pg");

// Si la URL es externa (proxy), activamos SSL; si es interna de Railway, sin SSL.
const isExternal = /proxy\.rlwy\.net|amazonaws|heroku|render|fly\.io|azure|googleapis/.test(
  process.env.DATABASE_URL || ""
);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isExternal ? { rejectUnauthorized: false } : false
});

module.exports = { pool };
