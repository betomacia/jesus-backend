// index.js
const express = require("express");
const cors = require("cors");
const nodeFetch = require("node-fetch"); // fallback si el runtime no trae fetch global
require("dotenv").config();
const multer = require("multer");
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
const _fetch = (...args) =>
  (globalThis.fetch ? globalThis.fetch(...args) : nodeFetch(...args));

const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL ||
  "https://jesus-backend-production-1cf4.up.railway.app";

/* ====== D-ID AUTH (API KEY o USER/PASS) ====== */
const DID_API_KEY = process.env.DID_API_KEY || "";
const DID_USER = process.env.DID_USERNAME || "";
const DID_PASS = process.env.DID_PASSWORD || "";

const didHeaders = () => {
  const h = { "Content-Type": "application/json", Accept: "application/json" };
  if (DID_API_KEY) {
    h.Authorization = "Basic " + Buffer.from(`${DID_API_KEY}:`).toString("base64");
  } else if (DID_USER && DID_PASS) {
    h.Authorization = "Basic " + Buffer.from(`${DID_USER}:${DID_PASS}`).toString("base64");
  } else {
    console.warn("[WARN] Faltan credenciales D-ID (DID_API_KEY o DID_USERNAME/DID_PASSWORD)");
  }
  return h;
};

/* ====== LEGADO: Crear sesión por USER/PASS (usando didHeaders()) ====== */
const streams = {};
app.post("/create-stream-session", async (_req, res) => {
  try {
    const data = {
      source_url:
        "https://raw.githubusercontent.com/betomacia/imagen-jesus/refs/heads/main/jesus.jpg",
    };

    const createResponse = await _fetch("https://api.d-id.com/talks/streams", {
      method: "POST",
      headers: didHeaders(),
      body: JSON.stringify(data),
    });

    if (!createResponse.ok) {
      const errorText = await createResponse.text();
      return res.status(createResponse.status).json({ error: errorText });
    }

    const createJson = await createResponse.json();

    const sdpResponse = await _fetch(
      `https://api.d-id.com/talks/streams/${createJson.id}`,
      { method: "GET", headers: didHeaders() }
    );

    if (!sdpResponse.ok) {
      const errorText = await sdpResponse.text();
      return res.status(sdpResponse.status).json({ error: errorText });
    }

    const sdpJson = await sdpResponse.json();

    streams[createJson.id] = {
      session_id: createJson.session_id,
      peerConnectionReady: false,
    };

    res.json({
      id: createJson.id,
      session_id: createJson.session_id,
      offer: sdpJson.offer,
      ice_servers: sdpJson.ice_servers || [],
    });
  } catch (error) {
    console.error("Error creando stream session:", error);
    res.status(500).json({ error: error.message || "Error interno creando sesión" });
  }
});

/* ====== EXTRA: Créditos D-ID (debug rápido) ====== */
app.get("/api/did/credits", async (_req, res) => {
  try {
    const r = await _fetch("https://api.d-id.com/credits", { headers: didHeaders() });
    const data = await r.json().catch(() => ({}));
    return res.status(r.ok ? 200 : r.status).json(data);
  } catch (e) {
    console.error("credits error", e);
    return res.status(500).json({ error: "credits_failed" });
  }
});

/* ====== NUEVO: Hablar con D-ID usando AUDIO_URL (ElevenLabs) ======
   Frontend envía: { id, session_id, text }
   Generamos audio_url público a /api/tts y se lo pasamos a D-ID (script.type = 'audio')
=============================================================== */
app.post("/api/did/talk-el", async (req, res) => {
  try {
    const { id, session_id, text } = req.body || {};
    if (!id || !session_id || !text || !String(text).trim()) {
      return res.status(400).json({ error: "missing_fields" });
    }

    // URL pública que D-ID podrá descargar
    const audio_url = `${PUBLIC_BASE_URL}/api/tts?text=${encodeURIComponent(
      String(text).slice(0, 5000) // protección básica
    )}`;

    const payload = { session_id, script: { type: "audio", audio_url } };

    const r = await _fetch(`https://api.d-id.com/talks/streams/${id}`, {
      method: "POST",
      headers: didHeaders(),
      body: JSON.stringify(payload),
    });

    const data = await r.json().catch(() => ({}));
    return res.status(r.ok ? 200 : r.status).json(data);
  } catch (e) {
    console.error("talk-el error", e);
    return res.status(500).json({ error: "talk_el_failed" });
  }
});

/* ====== OpenAI Whisper (Transcripción) ====== */
const upload = multer({ limits: { fileSize: 25 * 1024 * 1024 } });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.post("/api/transcribe", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No se recibió ningún archivo" });
    }

    // OpenAI SDK acepta Buffer directamente
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

    // Opcional: AbortController para timeout (Railway a veces cuelga peticiones externas)
    const controller = new AbortController();
    const timeoutMs = Number(process.env.TTS_TIMEOUT_MS || 30000);
    const t = setTimeout(() => controller.abort(), timeoutMs);

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

    clearTimeout(t);

    if (!r.ok || !r.body) {
      const body = await r.text().catch(() => "");
      console.error("elevenlabs stream error", r.status, body);
      return res.status(502).json({ error: "elevenlabs_failed", detail: body });
    }

    // Cabeceras para entregar MP3 por streaming
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    // Importante para que D-ID y navegadores no “sesguen” el stream
    res.setHeader("Accept-Ranges", "bytes");

    // Pipe del stream remoto al response
    r.body.pipe(res);
    r.body.on("error", (e) => {
      console.error("pipe error", e);
      if (!res.headersSent) {
        res.status(500).json({ error: "tts_pipe_failed" });
      } else {
        res.end();
      }
    });
  } catch (err) {
    console.error("tts stream error", err);
    // Si fue por timeout/abort, devolver 504
    const msg = (err && err.message) || "";
    const code = msg.includes("The operation was aborted") ? 504 : 500;
    return res.status(code).json({ error: "tts_failed", detail: msg });
  }
});

/* ====== Endpoint de prueba para escuchar fácilmente ====== */
app.get("/api/tts-test", (req, res) => {
  // Página mínima que reproduce /api/tts
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
