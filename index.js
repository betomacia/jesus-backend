// index.js
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch"); // fallback si el runtime no trae fetch global
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
app.use(express.json());

/* ============ MONTA /api/did/* (streams, sdp, ice, talk TEXT/AUDIO) ============ */
app.use("/api/did", didRouter);

/* ============ ENV & HELPERS ============ */
const _fetch = (...args) => (globalThis.fetch ? globalThis.fetch(...args) : fetch(...args));

const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL || "https://jesus-backend-production-1cf4.up.railway.app";

/* ====== D-ID API KEY (para endpoints extra) ====== */
const DID_API_KEY = process.env.DID_API_KEY || "";
if (!DID_API_KEY) {
  console.warn("[WARN] DID_API_KEY no está definida. Agrégala en Railway > Variables.");
}
const didHeaders = () => ({
  Authorization: "Basic " + Buffer.from(`${DID_API_KEY}:`).toString("base64"),
  "Content-Type": "application/json",
});

/* ====== (Opcional) Credenciales LEGADO USER/PASS ====== */
const DID_USER = process.env.DID_USERNAME || "";
const DID_PASS = process.env.DID_PASSWORD || "";
const didAuthBasic =
  DID_USER && DID_PASS ? Buffer.from(`${DID_USER}:${DID_PASS}`).toString("base64") : null;

/* ====== (Legado) Crear sesión por USER/PASS (puedes ignorar si no lo usas) ====== */
const streams = {};
app.post("/create-stream-session", async (_req, res) => {
  if (!didAuthBasic) {
    return res.status(500).json({ error: "missing_did_credentials" });
  }
  try {
    const data = {
      source_url:
        "https://raw.githubusercontent.com/betomacia/imagen-jesus/refs/heads/main/jesus.jpg",
    };

    const createResponse = await _fetch("https://api.d-id.com/talks/streams", {
      method: "POST",
      headers: {
        Authorization: `Basic ${didAuthBasic}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    });

    if (!createResponse.ok) {
      const errorText = await createResponse.text();
      return res.status(createResponse.status).json({ error: errorText });
    }

    const createJson = await createResponse.json();

    const sdpResponse = await _fetch(
      `https://api.d-id.com/talks/streams/${createJson.id}`,
      {
        method: "GET",
        headers: {
          Authorization: `Basic ${didAuthBasic}`,
          "Content-Type": "application/json",
        },
      }
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
    res
      .status(500)
      .json({ error: error.message || "Error interno creando sesión" });
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
   El backend genera un audio_url público (nuestro /api/tts con ?text=...)
   y se lo pasa a D-ID como script.type = 'audio'
=============================================================== */
app.post("/api/did/talk-el", async (req, res) => {
  try {
    const { id, session_id, text } = req.body || {};
    if (!id || !session_id || !text) {
      return res.status(400).json({ error: "missing_fields" });
    }

    // URL pública que D-ID podrá descargar
    const audio_url = `${PUBLIC_BASE_URL}/api/tts?text=${encodeURIComponent(String(text))}`;

    const payload = {
      session_id,
      script: { type: "audio", audio_url },
      // driver_url opcional; lo dejamos simple para que use el lip-sync por defecto
    };

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

/* ====== ElevenLabs TTS (stream) ====== */
app.all("/api/tts", async (req, res) => {
  try {
    const text =
      req.method === "GET"
        ? (req.query.text || "")
        : (req.body?.text || "");
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
