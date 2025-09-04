// index.js — Backend + rutas A2E/D-ID/TTS/ASK + estático /public
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const path = require("path");
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
const a2eRouterRaw = require("./routes/a2e");

const didRouter = didRouterRaw?.default || didRouterRaw;
const ttsRouter = ttsRouterRaw?.default || ttsRouterRaw;
const a2eRouter = a2eRouterRaw?.default || a2eRouterRaw;

app.use("/api/did", didRouter);
app.use("/api/tts", ttsRouter);
app.use("/api/a2e", a2eRouter);

// Healthcheck
app.get("/health", (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Servidor listo en puerto ${PORT}`);
});
