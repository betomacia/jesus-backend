// index.js — Backend principal estable y modular

const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
require("dotenv").config();

const { query, ping } = require("./db/pg");
const welcomeRouter = require("./routes/welcome");
const askRouter = require("./routes/ask");
const heygenRouter = require("./routes/heygen");

const app = express();
app.use(cors({ origin: true }));
app.use(bodyParser.json());

// ---------- DB Health ----------
app.get("/db/health", async (_req, res) => {
  try {
    const now = await ping();
    res.json({ ok: true, now });
  } catch (e) {
    console.error("DB HEALTH ERROR:", e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// (Opcional) Conteo rápido de usuarios
app.get("/db/test", async (_req, res) => {
  try {
    const r = await query("SELECT COUNT(*)::int AS users FROM users");
    res.json({ users: r.rows?.[0]?.users ?? 0 });
  } catch (e) {
    console.error("DB TEST ERROR:", e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ---------- Rutas ----------
app.use("/api/welcome", welcomeRouter);
app.use("/api/ask", askRouter);
app.use("/api/heygen", heygenRouter);

// ---------- Health ----------
app.get("/", (_req, res) => res.json({ ok: true, service: "backend", ts: Date.now() }));

// ---------- Arranque ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor listo en puerto ${PORT}`));
