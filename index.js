const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch"); // puedes usar fetch nativo en Node 18+ si prefieres
require("dotenv").config();
const multer = require("multer");
const { OpenAI } = require("openai");

/* ⬇️ NUEVO: router de D-ID (usuario/contraseña vía Railway) */
const didRouter = require("./routes/did");

const app = express();

/* ===== CORS ===== */
const allowedOrigin = process.env.CORS_ORIGIN || "*";
app.use(
  cors({
    origin: allowedOrigin === "*" ? true : allowedOrigin,
  })
);
app.use(express.json());

/* 🔎 Logger de requests (debug) — para ver si “llega algo” al backend */
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});

/* ⬇️ NUEVO: monta /api/did/* (streams, sdp, ice, talk) */
app.use("/api/did", didRouter);

/* ====== D-ID (LEGACY: create-stream-session con user/pass) ====== */
/* Nota: no es necesario si ya usas /api/did/*, pero lo dejamos por compatibilidad */
const DID_USER = process.env.DID_USERNAME || "";
const DID_PASS = process.env.DID_PASSWORD || "";
const didAuth =
  DID_USER && DID_PASS
    ? Buffer.from(`${DID_USER}:${DID_PASS}`).toString("base64")
    : null;

const streams = {};

app.post("/create-stream-session", async (req, res) => {
  if (!didAuth) {
    return res.status(500).json({ error: "missing_did_credentials" });
  }
  try {
    const data = {
      source_url:
        "https://raw.githubusercontent.com/betomacia/imagen-jesus/refs/heads/main/jesus.jpg",
    };

    const createResponse = await fetch("https://api.d-id.com/talks/streams", {
      method: "POST",
      headers: {
        Authorization: `Basic ${didAuth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    });

    if (!createResponse.ok) {
      const errorText = await createResponse.text();
      return res.status(createResponse.status).json({ error: errorText });
    }

    const createJson = await createResponse.json();

    const sdpResponse = await fetch(
      `https://api.d-id.com/talks/streams/${createJson.id}`,
      {
        method: "GET",
        headers: {
          Authorization: `Basic ${didAuth}`,
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

/* ====== ElevenLabs TTS ====== */
app.all("/api/tts", async (req, res) => {
  try {
    const text =
      req.method === "GET" ? (req.query.text || "") : (req.body?.text || "");
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

    const r = await fetch(url, {
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

/* ====== Endpoint raíz ====== */
app.get("/", (_req, res) => {
  res.send("jesus-backend up ✅");
});

/* ====== Inicio servidor ====== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
});
