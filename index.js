// index.js
const express = require("express");
const cors = require("cors");
const nodeFetch = require("node-fetch");
require("dotenv").config();
const multer = require("multer");
const { OpenAI } = require("openai");
const { Readable } = require("stream");

/* ============ RUTAS D-ID (WebRTC) ============ */
const didRouter = require("./routes/did");

const app = express();

/* ============ LOG SENCILLO ============ */
app.use((req, _res, next) => {
  const t = new Date().toISOString();
  console.log(`[${t}] ${req.method} ${req.originalUrl}`);
  next();
});

/* ============ CORS ============ */
const allowedOrigin = process.env.CORS_ORIGIN || "*";
app.use(cors({ origin: allowedOrigin === "*" ? true : allowedOrigin }));

// Body parsers
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

/* ============ MONTA /api/did/* (streams, sdp, ice, talk) ============ */
app.use("/api/did", didRouter);

/* ============ ENV & HELPERS ============ */
const _fetch = (...args) => (globalThis.fetch ? globalThis.fetch(...args) : nodeFetch(...args));

const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL || "https://jesus-backend-production-1cf4.up.railway.app";

/* ====== OpenAI Whisper (Transcripción) ====== */
const upload = multer({ limits: { fileSize: 25 * 1024 * 1024 } });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.post("/api/transcribe", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No se recibió ningún archivo" });

    // OpenAI SDK acepta File en Node 18+ con fetch/undici
    const fileName = req.file.originalname || "audio.webm";
    const resp = await openai.audio.transcriptions.create({
      file: new File([req.file.buffer], fileName, { type: req.file.mimetype || "audio/webm" }),
      model: "whisper-1",
    });

    res.json({ text: (resp.text || "").trim() });
  } catch (err) {
    console.error("Error en transcripción:", err);
    res.status(500).json({ error: "Error transcribiendo audio" });
  }
});

/* ====== ElevenLabs TTS (stream) ======
   - GET /api/tts?text=Hola
   - POST /api/tts { "text": "Hola" }
====================================== */
app.all("/api/tts", async (req, res) => {
  try {
    const text = req.method === "GET" ? (req.query.text ?? "") : ((req.body && req.body.text) ?? "");
    if (!text || !String(text).trim()) return res.status(400).json({ error: "no_text" });

    const VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
    const API_KEY = process.env.ELEVENLABS_API_KEY;
    if (!VOICE_ID || !API_KEY) return res.status(500).json({ error: "missing_elevenlabs_env" });

    const controller = new AbortController();
    const timeoutMs = Number(process.env.TTS_TIMEOUT_MS || 30000);
    const tk = setTimeout(() => controller.abort(), timeoutMs);

    const url =
      `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream` +
      `?optimize_streaming_latency=4&output_format=mp3_22050_32`;

    const r = await _fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": API_KEY,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text: String(text).slice(0, 5000),
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability: 0.3,
          similarity_boost: 0.7,
          style: 0,
          use_speaker_boost: false,
        },
      }),
      signal: controller.signal,
    });

    clearTimeout(tk);

    if (!r.ok || !r.body) {
      const body = await r.text().catch(() => "");
      console.error("elevenlabs stream error", r.status, body);
      return res.status(502).json({ error: "elevenlabs_failed", detail: body });
    }

    // Convertir a Readable si viene como Web Stream (Node 18+)
    let nodeReadable;
    try {
      // Undici Response.body es un WebReadableStream
      if (typeof r.body.getReader === "function" && Readable.fromWeb) {
        nodeReadable = Readable.fromWeb(r.body);
      } else {
        nodeReadable = r.body; // Node stream (node-fetch v2)
      }
    } catch {
      nodeReadable = r.body;
    }

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Accept-Ranges", "bytes");

    nodeReadable.pipe(res);
    nodeReadable.on("error", (e) => {
      console.error("tts pipe error", e);
      if (!res.headersSent) res.status(500).json({ error: "tts_pipe_failed" });
      else res.end();
    });
  } catch (err) {
    console.error("tts stream error", err);
    const msg = (err && err.message) || "";
    const code = msg.includes("aborted") ? 504 : 500;
    return res.status(code).json({ error: "tts_failed", detail: msg });
  }
});

/* ====== Endpoint de prueba para escuchar fácilmente ====== */
app.get("/api/tts-test", (req, res) => {
  const q = String(req.query.text || "Hola, la paz sea contigo.");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>TTS Test</title></head>
<body style="font-family:sans-serif;padding:24px">
  <h1>TTS ElevenLabs Test</h1>
  <form method="GET" action="/api/tts-test">
    <label>Texto:</label>
    <input type="text" name="text" value="${q.replace(/"/g, "&quot;")}" style="width: 420px" />
    <button type="submit">Reproducir</button>
  </form>
  <p>Endpoint: <code>/api/tts?text=...</code></p>
  <audio id="player" controls autoplay src="/api/tts?text=${encodeURIComponent(q)}"></audio>
</body>
</html>`);
});

/* ====== Bienvenida ====== */
app.get("/api/welcome", (_req, res) => {
  const greetings = [
    "Buenos días, que la paz de Dios te acompañe hoy.",
    "Buenas tardes, recuerda que Jesús siempre camina a tu lado.",
    "Buenas noches, que el amor del Padre te envuelva en descanso.",
    "La paz sea contigo, ¿cómo te encuentras en este momento?",
    "Que la esperanza y la fe iluminen tu día, ¿qué quisieras compartir hoy?",
    "Jesús está contigo en cada paso, ¿quieres contarme lo que vives ahora?",
    "Eres escuchado y amado, ¿qué tienes en tu corazón hoy?",
  ];
  const randomGreeting = greetings[Math.floor(Math.random() * greetings.length)];
  res.json({ text: randomGreeting });
});

/* ====== Raíz ====== */
app.get("/", (_req, res) => {
  res.send("jesus-backend up ✅");
});

/* ====== Inicio servidor ====== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
});
