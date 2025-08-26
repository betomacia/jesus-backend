// index.js
const express = require("express");
const cors = require("cors");
const nodeFetch = require("node-fetch");
require("dotenv").config();
const multer = require("multer");
const { Readable } = require("stream");
const { OpenAI } = require("openai");

const didRouter = require("./routes/did");
const app = express();

// Log simple
app.use((req, _res, next) => {
  const t = new Date().toISOString();
  console.log(`[${t}] ${req.method} ${req.originalUrl}`);
  next();
});

// CORS
const allowedOrigin = process.env.CORS_ORIGIN || "*";
app.use(cors({ origin: allowedOrigin === "*" ? true : allowedOrigin }));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

// D-ID WebRTC
app.use("/api/did", didRouter);

// ==== OpenAI client ====
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ====== Whisper (transcripción) ======
const upload = multer({ limits: { fileSize: 25 * 1024 * 1024 } });
app.post("/api/transcribe", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No se recibió ningún archivo" });
    const fileName = req.file.originalname || "audio.webm";
    const resp = await openai.audio.transcriptions.create({
      file: { name: fileName, data: req.file.buffer },
      model: "whisper-1",
    });
    res.json({ text: (resp.text || "").trim() });
  } catch (err) {
    console.error("Error en transcripción:", err);
    res.status(500).json({ error: "Error transcribiendo audio" });
  }
});

// ====== ElevenLabs TTS (stream) ======
const fetch = (...args) => nodeFetch(...args);

app.all("/api/tts", async (req, res) => {
  try {
    const text =
      req.method === "GET" ? req.query.text ?? "" : (req.body && req.body.text) ?? "";
    if (!text || !String(text).trim()) return res.status(400).json({ error: "no_text" });

    const VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
    const API_KEY = process.env.ELEVENLABS_API_KEY;
    if (!VOICE_ID || !API_KEY) return res.status(500).json({ error: "missing_elevenlabs_env" });

    const controller = new AbortController();
    const timeoutMs = Number(process.env.TTS_TIMEOUT_MS || 30000);
    const to = setTimeout(() => controller.abort(), timeoutMs);

    const url =
      `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream` +
      `?optimize_streaming_latency=4&output_format=mp3_22050_32`;

    const r = await fetch(url, {
      method: "POST",
      headers: { "xi-api-key": API_KEY, "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({
        text: String(text).slice(0, 5000),
        model_id: "eleven_multilingual_v2",
        voice_settings: { stability: 0.3, similarity_boost: 0.7, style: 0, use_speaker_boost: false },
      }),
      signal: controller.signal,
    });
    clearTimeout(to);

    if (!r.ok) {
      const body = await r.text().catch(() => "");
      console.error("elevenlabs stream error", r.status, body);
      return res.status(502).json({ error: "elevenlabs_failed", detail: body });
    }

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Accept-Ranges", "bytes");

    const body = r.body;
    if (body && typeof body.pipe === "function") {
      body.pipe(res);
      body.on("error", (e) => {
        console.error("tts pipe error", e);
        if (!res.headersSent) res.status(500).json({ error: "tts_pipe_failed" });
        else res.end();
      });
    } else if (body && typeof body.getReader === "function") {
      const nodeReadable = Readable.fromWeb(body);
      nodeReadable.pipe(res);
      nodeReadable.on("error", (e) => {
        console.error("tts pipe (fromWeb) error", e);
        if (!res.headersSent) res.status(500).json({ error: "tts_pipe_failed" });
        else res.end();
      });
    } else {
      const buf = await r.buffer();
      res.end(buf);
    }
  } catch (err) {
    console.error("tts stream error", err);
    const msg = (err && err.message) || "";
    const code = msg.includes("The operation was aborted") ? 504 : 500;
    return res.status(code).json({ error: "tts_failed", detail: msg });
  }
});

// ====== Página de prueba de TTS ======
app.get("/api/tts-test", (req, res) => {
  const q = String(req.query.text || "Hola, la paz sea contigo.");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html><meta charset="utf-8"><title>TTS Test</title>
  <h1>TTS ElevenLabs Test</h1>
  <form method="GET" action="/api/tts-test">
    <label>Texto:</label>
    <input type="text" name="text" value="${q.replace(/"/g, "&quot;")}" style="width:420px" />
    <button type="submit">Reproducir</button>
  </form>
  <p>Endpoint: <code>/api/tts?text=...</code></p>
  <audio id="player" controls autoplay src="/api/tts?text=${encodeURIComponent(q)}"></audio>`);
});

// ====== Bienvenida simple ======
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

// ====== INTELIGENCIA: /api/ask con OpenAI ======
app.post("/api/ask", async (req, res) => {
  try {
    const { persona, message, history } = req.body || {};
    if (!persona || !message) {
      return res.status(400).json({
        error: "missing_fields",
        detail: "persona y message son obligatorios"
      });
    }

    const toMessages = (sys, hist = [], userNow = "") => {
      const msgs = [];
      if (sys) msgs.push({ role: "system", content: sys });
      for (const h of hist) {
        if (/^Usuario:/i.test(h)) {
          msgs.push({ role: "user", content: h.replace(/^Usuario:\s*/i, "").trim() });
        } else if (/^Asistente:/i.test(h)) {
          msgs.push({ role: "assistant", content: h.replace(/^Asistente:\s*/i, "").trim() });
        }
      }
      if (userNow) msgs.push({ role: "user", content: userNow });
      return msgs;
    };

    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
    const messages = toMessages(persona, Array.isArray(history) ? history : [], String(message || ""));

    const completion = await openai.chat.completions.create({
      model,
      messages,
      temperature: 0.7,
      max_tokens: 400,
    });

    let text = "";
    if (completion?.choices?.[0]?.message) {
      const msg = completion.choices[0].message;
      if (typeof msg.content === "string") text = msg.content;
      else if (Array.isArray(msg.content)) {
        text = msg.content.map(part => (typeof part === "string" ? part : part?.text || "")).join("").trim();
      }
    }
    text = (text || "").trim();
    if (!text) {
      text = "Estoy aquí contigo. ¿Quieres contarme en una frase qué te inquieta ahora mismo?";
    }

    return res.json({ message: text });
  } catch (err) {
    console.error("OpenAI /api/ask error:", err?.response?.data || err?.message || err);
    const code = err?.status || err?.response?.status || 500;
    return res.status(code).json({ error: "openai_failed", detail: String(err?.message || err) });
  }
});

// Raíz
app.get("/", (_req, res) => { res.send("jesus-backend up ✅"); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
});
