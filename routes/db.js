// routes/db.js
const express = require("express");
const { pool } = require("../db");

const router = express.Router();

router.get("/health", async (_req, res) => {
  try {
    const r = await pool.query("SELECT now() AS now");
    res.json({ ok: true, now: r.rows[0].now });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
