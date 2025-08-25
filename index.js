// index.js
const express = require("express");
const cors = require("cors");
const compression = require("compression");
const nodeFetch = require("node-fetch"); // fetch Node v2
require("dotenv").config();
const multer = require("multer");
const { Readable } = require("stream");
const { OpenAI } = require("openai");

/* ============ RUTAS D-ID (WebRTC) ============ */
const didRouter = require("./routes/did");

const app = express();

/* ============ MIDDLEWARES ============ */
app.use(compression());
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

const allowedOrigin = process.env.CORS_ORIGIN || "*";
app.use(cors({ origin: allowedOrigin === "*" ? true : allowedOrigin }));

/* ============ LOG SENCILLO ============ */
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});

/* ============ MOUNT RUTAS D-ID BÁSICAS ============ */
app.use("/api/did", didRouter);

const _fetch = (...args) => nodeFetch(...args);
const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL ||
  "https://jesus-backend-production-xxxx.up.railway.app";

/* ============ CONFIG OPENAI ============ */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ====== Transcripción con OpenAI Whisper ====== */
const upload = multer({ limits: { fileSize: 25 * 1024 * 1024 } });

app.post("/api/transcribe", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "no_file" });
    const resp = await openai.audio.transcriptions.create({
      file: { name: req.file.originalname, data: req.file.buffer },
      model: "whisper-1",
    });
    res.json({ text: (resp.text || "").trim() });
  } catch (err) {
    console.error("transcribe error", err);
    res.status(500).json({ error: "transcription_failed" });
  }
});

/* =====================================================
   D-ID TALK STREAM con voz Microsoft Neural (Jorge)
   ===================================================== */
function voiceForLang(lang = "es") {
  // puedes expandir este map si quieres más voces
  const map = {
    es: { voice_id: "es-MX-JorgeNeural", style: "narration-relaxed" },
    en: { voice_id: "en-US-GuyNeural", style: "narration-relaxed" },
    pt: { voice_id: "pt-BR-AntonioNeural", style: "narration-relaxed" },
    it: { voice_id: "it-IT-DiegoNeural", style: "narration-relaxed" },
    de: { voice_id: "de-DE-ConradNeural", style: "narration-relaxed" },
  };
  return map[lang] || map.es;
}

app.post("/api/did/talk-stream", async (req, res) => {
  try {
    const { id, session_id, text, lang, voice_id } = req.body || {};
    if (!id || !session_id || !text) {
      return res.status(400).json({ error: "missing_fields" });
    }

    const chosenVoice =
      voice_id || (voiceForLang(lang || "es")?.voice_id || "es-MX-JorgeNeural");

    const payload = {
      session_id,
      script: {
        type: "text",
        input: String(text).slice(0, 5000),
        provider: {
          type: "microsoft",
          voice_id: chosenVoice,
          style: "narration-relaxed",
          rate: "-5%",
          pitch: "-2st",
        },
      },
    };

    const r = await _fetch(`https://api.d-id.com/talks/streams/${id}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization:
          "Basic " +
          Buffer.from(
            process.env.DID_API_KEY
              ? `${process.env.DID_API_KEY}:`
              : `${process.env.DID_USERNAME}:${process.env.DID_PASSWORD}`
          ).toString("base64"),
      },
      body: JSON.stringify(payload),
    });

    const data = await r.json().catch(() => ({}));
    return res.status(r.ok ? 200 : r.status).json(data);
  } catch (e) {
    console.error("talk-stream error", e);
    res
      .status(500)
      .json({ error: "talk_stream_failed", detail: e?.message || String(e) });
  }
});

/* =====================================================
   Bienvenida dinámica
   ===================================================== */
app.get("/api/welcome", (_req, res) => {
  const greetings = [
    "Buenos días, que la paz de Dios te acompañe hoy.",
    "Buenas tardes, recuerda que Jesús siempre camina a tu lado.",
    "Buenas noches, que el amor del Padre te envuelva en descanso.",
    "La paz sea contigo, ¿cómo te encuentras en este momento?",
  ];
  const randomGreeting = greetings[Math.floor(Math.random() * greetings.length)];
  res.json({ text: randomGreeting });
});

/* =====================================================
   Root
   ===================================================== */
app.get("/", (_req, res) => {
  res.send("jesus-backend up ✅");
});

/* =====================================================
   Start Server
   ===================================================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
});
