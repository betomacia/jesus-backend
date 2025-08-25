// index.js
const express = require("express");
const cors = require("cors");
const nodeFetch = require("node-fetch"); // v2
require("dotenv").config();
const multer = require("multer");
const { Readable } = require("stream");
const { OpenAI } = require("openai");

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
app.use(
  cors({
    origin: allowedOrigin === "*" ? true : allowedOrigin,
  })
);

// Body parsers
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

/* ============ MONTA /api/did/* (streams, sdp, ice, talk TEXT/AUDIO) ============ */
app.use("/api/did", didRouter);

/* ============ ENV & HELPERS ============ */
const fetch = (...args) => nodeFetch(...args); // fuerza node-fetch v2

const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL ||
  "https://jesus-backend-production-1cf4.up.railway.app";

/* ====== OpenAI SDK ====== */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ======================================================================
   A) CHAT PROXY — /api/guidance  (robusto y sin CORS/clave en el front)
   ====================================================================== */
app.post("/api/guidance", async (req, res) => {
  try {
    const { persona, prompt, history } = req.body || {};
    if (!persona || !prompt) {
      return res.status(400).json({ error: "missing_fields", need: ["persona", "prompt"] });
    }
    if (!process.env.OPENAI_API_KEY) {
      return res.status(501).json({ error: "missing_openai_key" });
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.6,
      messages: [
        { role: "system", content: persona },
        ...(Array.isArray(history)
          ? history.slice(-8).map((h) => ({ role: "system", content: `[HIST] ${h}` }))
          : []),
        { role: "user", content: prompt },
      ],
    });

    const message = completion.choices?.[0]?.message?.content?.trim() || "";
    return res.json({ message });
  } catch (e) {
    const status = e?.status || e?.response?.status || 500;
    let detail = e?.message || "";
    if (e?.response?.text) {
      try {
        detail = await e.response.text();
      } catch {}
    }
    console.error("openai chat error:", status, detail);
    return res.status(status).json({ error: "openai_chat_failed", detail });
  }
});

/* =======================================================================================
   B) TTS OPENAI STREAM (baja latencia) — /api/tts-openai-stream  (mp3/opus/aac/wav)
   ======================================================================================= */
app.all("/api/tts-openai-stream", async (req, res) => {
  try {
    const text = req.method === "GET" ? (req.query.text ?? "") : (req.body?.text ?? "");
    const voice = req.method === "GET" ? (req.query.voice ?? "verse") : (req.body?.voice ?? "verse");
    const format = (req.method === "GET" ? (req.query.format ?? "mp3") : (req.body?.format ?? "mp3")).toString();

    const input = String(text || "").trim();
    if (!input) return res.status(400).json({ error: "no_text" });
    if (!process.env.OPENAI_API_KEY) return res.status(501).json({ error: "missing_openai_key" });

    const endpoint = "https://api.openai.com/v1/audio/speech";
    const accept =
      format === "opus" ? "audio/ogg" :
      format === "aac"  ? "audio/aac" :
      format === "wav"  ? "audio/wav" :
                          "audio/mpeg";

    const r = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
        Accept: accept, // clave para streaming progresivo
      },
      body: JSON.stringify({
        model: "gpt-4o-mini-tts",
        voice: String(voice),
        input,
        format, // mp3 | opus | aac | wav
      }),
    });

    if (!r.ok || !r.body) {
      const detail = await r.text().catch(() => "");
      console.error("openai tts stream error", r.status, detail);
      return res.status(r.status || 502).json({ error: "openai_tts_failed", detail });
    }

    const contentType =
      format === "opus" ? "audio/ogg" :
      format === "aac"  ? "audio/aac" :
      format === "wav"  ? "audio/wav" :
                          "audio/mpeg";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "no-store");

    // node-fetch v2: body es Readable
    const body = r.body;
    body.pipe(res);
    body.on("error", (e) => {
      console.error("tts pipe error", e);
      if (!res.headersSent) res.status(500).json({ error: "tts_pipe_failed" });
      else res.end();
    });
  } catch (e) {
    console.error("tts-openai-stream fatal", e?.message || e);
    return res.status(500).json({ error: "openai_tts_failed_generic" });
  }
});

/* =======================================================================================
   C) TRANSCRIPCIÓN (Whisper) — /api/transcribe
   ======================================================================================= */
const upload = multer({ limits: { fileSize: 25 * 1024 * 1024 } });

app.post("/api/transcribe", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No se recibió ningún archivo" });
    }
    const fileName = req.file.originalname || "audio.webm";

    // En tu versión te funcionaba así; lo conservamos:
    const resp = await openai.audio.transcriptions.create({
      file: { name: fileName, data: req.file.buffer }, // Buffer directo
      model: "whisper-1",
    });

    res.json({ text: (resp.text || "").trim() });
  } catch (err) {
    console.error("Error en transcripción:", err);
    res.status(500).json({ error: "Error transcribiendo audio" });
  }
});

/* =======================================================================================
   D) ElevenLabs TTS (compatibilidad) — /api/tts  (opcional)
   ======================================================================================= */
app.all("/api/tts", async (req, res) => {
  try {
    const text =
      req.method === "GET" ? req.query.text ?? "" : (req.body && req.body.text) ?? "";
    if (!text || !String(text).trim()) {
      return res.status(400).json({ error: "no_text" });
    }

    const VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
    const API_KEY = process.env.ELEVENLABS_API_KEY;

    if (!VOICE_ID || !API_KEY) {
      return res.status(500).json({ error: "missing_elevenlabs_env" });
    }

    // Timeout opcional
    const controller = new AbortController();
    const timeoutMs = Number(process.env.TTS_TIMEOUT_MS || 30000);
    const to = setTimeout(() => controller.abort(), timeoutMs);

    const url =
      `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream` +
      `?optimize_streaming_latency=4&output_format=mp3_22050_32`;

    const r = await fetch(url, {
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

    clearTimeout(to);

    if (!r.ok) {
      const body = await r.text().catch(() => "");
      console.error("elevenlabs stream error", r.status, body);
      return res.status(502).json({ error: "elevenlabs_failed", detail: body });
    }

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Accept-Ranges", "bytes");

    const body = r.body; // Readable
    if (body && typeof body.pipe === "function") {
      body.pipe(res);
      body.on("error", (e) => {
        console.error("tts pipe error", e);
        if (!res.headersSent) res.status(500).json({ error: "tts_pipe_failed" });
        else res.end();
      });
    } else if (body && typeof body.getReader === "function" && Readable.fromWeb) {
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

/* =======================================================================================
   E) Páginas/utilidades de prueba
   ======================================================================================= */
app.get("/api/tts-test", (req, res) => {
  const q = String(req.query.text || "Hola, la paz sea contigo.");
  const fmt = String(req.query.format || "mp3");
  const voice = String(req.query.voice || "verse");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>TTS OpenAI Stream Test</title></head>
<body style="font-family:sans-serif;padding:24px">
  <h1>TTS OpenAI Stream Test</h1>
  <form method="GET" action="/api/tts-test">
    <label>Texto:</label>
    <input type="text" name="text" value="${q.replace(/"/g, "&quot;")}" style="width: 420px" />
    <label>Formato:</label>
    <select name="format">
      <option ${fmt==="mp3"?"selected":""}>mp3</option>
      <option ${fmt==="opus"?"selected":""}>opus</option>
      <option ${fmt==="aac"?"selected":""}>aac</option>
      <option ${fmt==="wav"?"selected":""}>wav</option>
    </select>
    <label>Voz:</label>
    <input type="text" name="voice" value="${voice.replace(/"/g, "&quot;")}" />
    <button type="submit">Reproducir</button>
  </form>
  <p>Endpoint (stream): <code>/api/tts-openai-stream?text=...&voice=${voice}&format=${fmt}</code></p>
  <audio id="player" controls autoplay src="/api/tts-openai-stream?text=${encodeURIComponent(q)}&voice=${encodeURIComponent(voice)}&format=${encodeURIComponent(fmt)}"></audio>
</body>
</html>`);
});

/* ====== Endpoint: Bienvenida dinámica ====== */
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
