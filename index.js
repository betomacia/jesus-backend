// index.js
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
require("dotenv").config();
const multer = require("multer");
const { OpenAI } = require("openai");

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
app.use(express.json());

/* ============ ENV & HELPERS ============ */
const _fetch = (...args) =>
  (globalThis.fetch ? globalThis.fetch(...args) : fetch(...args));

const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL ||
  "https://jesus-backend-production-1cf4.up.railway.app";

/* ====== D-ID AUTH ====== */
const DID_API_KEY = process.env.DID_API_KEY || "";
if (!DID_API_KEY) {
  console.warn("[WARN] DID_API_KEY no está definida en Railway > Variables.");
}
const didHeaders = () => ({
  Authorization: "Basic " + Buffer.from(`${DID_API_KEY}:`).toString("base64"),
  "Content-Type": "application/json",
});

/* ---------------------------------------------------
   D-ID WEBRTC: implementado aquí (sin routes/did)
   --------------------------------------------------- */

/** Crear stream (oferta remota + ice servers) */
app.post("/api/did/streams", async (req, res) => {
  try {
    const source_url =
      (req.body && req.body.source_url) ||
      "https://raw.githubusercontent.com/betomacia/jesus-backend/main/public/JESPANOL.jpeg";

    // 1) crear stream
    const r1 = await _fetch("https://api.d-id.com/talks/streams", {
      method: "POST",
      headers: didHeaders(),
      body: JSON.stringify({ source_url }),
    });
    if (!r1.ok) {
      const txt = await r1.text().catch(() => "");
      return res.status(r1.status).send(txt || '{"message":"Create failed"}');
    }
    const j1 = await r1.json();

    // 2) obtener oferta/ICE
    const r2 = await _fetch(`https://api.d-id.com/talks/streams/${j1.id}`, {
      method: "GET",
      headers: didHeaders(),
    });
    if (!r2.ok) {
      const txt = await r2.text().catch(() => "");
      return res.status(r2.status).send(txt || '{"message":"SDP get failed"}');
    }
    const j2 = await r2.json();

    return res.json({
      id: j1.id,
      session_id: j1.session_id,
      offer: j2.offer,
      ice_servers: j2.ice_servers || [],
    });
  } catch (e) {
    console.error("streams create error", e);
    return res.status(500).json({ message: "streams_create_error" });
  }
});

/** Enviar ANSWER local */
app.post("/api/did/streams/:id/sdp", async (req, res) => {
  try {
    const { id } = req.params;
    const { answer, session_id } = req.body || {};
    if (!id || !answer || !session_id) {
      return res.status(400).json({ message: "missing_fields" });
    }
    const r = await _fetch(`https://api.d-id.com/talks/streams/${id}/sdp`, {
      method: "POST",
      headers: didHeaders(),
      body: JSON.stringify({ answer, session_id }),
    });
    const txt = await r.text().catch(() => "");
    return res.status(r.ok ? 200 : r.status).send(txt || "{}");
  } catch (e) {
    console.error("post sdp error", e);
    return res.status(500).json({ message: "sdp_failed" });
  }
});

/** Enviar ICE local */
app.post("/api/did/streams/:id/ice", async (req, res) => {
  try {
    const { id } = req.params;
    const { candidate, session_id } = req.body || {};
    if (!id || !candidate || !session_id) {
      return res.status(400).json({ message: "missing_fields" });
    }
    const r = await _fetch(`https://api.d-id.com/talks/streams/${id}/ice`, {
      method: "POST",
      headers: didHeaders(),
      body: JSON.stringify({ candidate, session_id }),
    });
    const txt = await r.text().catch(() => "");
    return res.status(r.ok ? 200 : r.status).send(txt || "{}");
  } catch (e) {
    console.error("post ice error", e);
    return res.status(500).json({ message: "ice_failed" });
  }
});

/** Hablar con texto (script.type = 'text') */
app.post("/api/did/streams/:id/talk", async (req, res) => {
  try {
    const { id } = req.params;
    const { session_id, script } = req.body || {};
    if (!id || !session_id || !script) {
      return res.status(400).json({ message: "missing_fields" });
    }
    const r = await _fetch(`https://api.d-id.com/talks/streams/${id}`, {
      method: "POST",
      headers: didHeaders(),
      body: JSON.stringify({ session_id, script }),
    });
    const txt = await r.text().catch(() => "");
    return res.status(r.ok ? 200 : r.status).send(txt || "{}");
  } catch (e) {
    console.error("talk text error", e);
    return res.status(500).json({ message: "talk_failed" });
  }
});

/** Créditos D-ID (debug) */
app.get("/api/did/credits", async (_req, res) => {
  try {
    const r = await _fetch("https://api.d-id.com/credits", {
      headers: didHeaders(),
    });
    const data = await r.json().catch(() => ({}));
    return res.status(r.ok ? 200 : r.status).json(data);
  } catch (e) {
    console.error("credits error", e);
    return res.status(500).json({ error: "credits_failed" });
  }
});

/** Hablar con D-ID usando AUDIO_URL (ElevenLabs) */
app.post("/api/did/talk-el", async (req, res) => {
  try {
    const { id, session_id, text } = req.body || {};
    if (!id || !session_id || !text) {
      return res.status(400).json({ error: "missing_fields" });
    }
    const audio_url = `${PUBLIC_BASE_URL}/api/tts?text=${encodeURIComponent(
      String(text)
    )}`;
    const payload = {
      session_id,
      script: { type: "audio", audio_url },
    };
    const r = await _fetch(`https://api.d-id.com/talks/streams/${id}`, {
      method: "POST",
      headers: didHeaders(),
      body: JSON.stringify(payload),
    });
    const txt = await r.text().catch(() => "");
    return res.status(r.ok ? 200 : r.status).send(txt || "{}");
  } catch (e) {
    console.error("talk-el error", e);
    return res.status(500).json({ error: "talk_el_failed" });
  }
});

/* ---------------------------------------------------
   OpenAI Whisper (opcional)
   --------------------------------------------------- */
const upload = multer({ limits: { fileSize: 25 * 1024 * 1024 } });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.post("/api/transcribe", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No se recibió ningún archivo" });
    }
    const fileBlob = new Blob([req.file.buffer], {
      type: req.file.mimetype || "audio/webm",
    });
    const resp = await openai.audio.transcriptions.create({
      file: fileBlob,
      model: "whisper-1",
    });
    res.json({ text: (resp.text || "").trim() });
  } catch (err) {
    console.error("Error en transcripción:", err);
    res.status(500).json({ error: "Error transcribiendo audio" });
  }
});

/* ---------------------------------------------------
   ElevenLabs TTS (stream)
   --------------------------------------------------- */
app.all("/api/tts", async (req, res) => {
  try {
    const text =
      req.method === "GET" ? req.query.text || "" : req.body?.text || "";
    if (!text || !String(text).trim()) {
      return res.status(400).json({ error: "no_text" });
    }
    const VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
    const API_KEY = process.env.ELEVENLABS_API_KEY;
    if (!VOICE_ID || !API_KEY) {
      return res.status(500).json({ error: "missing_elevenlabs_env" });
    }

    const url =
      `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream` +
      `?optimize_streaming_latency=4&output_format=mp3_22050_32`;

    const r = await _fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: String(text),
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability: 0.3,
          similarity_boost: 0.7,
          style: 0,
          use_speaker_boost: false,
        },
      }),
    });

    if (!r.ok || !r.body) {
      const body = await r.text().catch(() => "");
      console.error("elevenlabs stream error", r.status, body);
      return res.status(502).json({ error: "elevenlabs_failed" });
    }

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    r.body.pipe(res);
  } catch (err) {
    console.error("tts stream error", err);
    return res.status(500).json({ error: "tts_failed" });
  }
});

/* ---------------------------------------------------
   Otros
   --------------------------------------------------- */
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

app.get("/", (_req, res) => {
  res.send("jesus-backend up ✅");
});

/* ============ INICIO SERVIDOR ============ */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
});
