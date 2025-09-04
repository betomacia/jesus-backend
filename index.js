// index.js — Backend + rutas A2E/D-ID/TTS/ASK + estático /public (con inspector de rutas)
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const path = require("path");
const fs = require("fs");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ====== ESTÁTICO /public ======
const PUBLIC_DIR = path.join(__dirname, "public");
app.use(
  "/public",
  express.static(PUBLIC_DIR, {
    maxAge: "7d",
    immutable: true,
    fallthrough: true,
  })
);

// ====== Routers externos ======
const didRouterRaw = require("./routes/did");
const ttsRouterRaw = require("./routes/tts");

// DEBUG: verifica existencia física del archivo a2e.js
const a2eFullPath = path.join(__dirname, "routes", "a2e.js");
console.log("[BOOT] __dirname =", __dirname);
console.log("[BOOT] a2e.js path =", a2eFullPath, "exists:", fs.existsSync(a2eFullPath));

const a2eRouterRaw = require("./routes/a2e");

const didRouter = didRouterRaw?.default || didRouterRaw;
const ttsRouter = ttsRouterRaw?.default || ttsRouterRaw;
const a2eRouter = a2eRouterRaw?.default || a2eRouterRaw;

app.use("/api/did", didRouter);
app.use("/api/tts", ttsRouter);

console.log("[BOOT] mounting /api/a2e");
app.use("/api/a2e", a2eRouter);

// Healthcheck
app.get("/health", (_req, res) => res.json({ ok: true }));

// ===== Inspector de rutas (debug) =====
app.get("/api/_debug/routes", (req, res) => {
  const routes = [];
  app._router.stack.forEach((m1) => {
    if (m1.route && m1.route.path) {
      routes.push({ method: Object.keys(m1.route.methods)[0]?.toUpperCase(), path: m1.route.path });
    } else if (m1.name === 'router' && m1.handle?.stack) {
      m1.handle.stack.forEach((m2) => {
        if (m2.route && m2.route.path) {
          routes.push({
            base: m1.regexp?.toString(),
            method: Object.keys(m2.route.methods)[0]?.toUpperCase(),
            path: m2.route.path,
          });
        }
      });
    }
  });
  res.json({ cwd: process.cwd(), dirname: __dirname, routes });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Servidor listo en puerto ${PORT}`);
});
