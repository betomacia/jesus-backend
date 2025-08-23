// index.js
const express = require("express");
const cors = require("cors");
const nodeFetch = require("node-fetch"); // fallback si el runtime no trae fetch global
require("dotenv").config();
const multer = require("multer");
const { OpenAI } = require("openai");
const crypto = require("crypto");
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

/* ====== OpenAI Whisper (Transcripción) ====== */
const upload = multer({ limits: { fileSize: 25 * 1024 * 1024 } });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.post("/api/transcribe", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No se recibió ningún archivo" });
    }

    // Nota: el SDK nuevo requiere un objeto File; si tu runtime no lo trae, considera usar form-data.
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

/* =========================================================================
   ElevenLabs TTS - 1) STREAM para navegador (/api/tts)  → BAJA LATENCIA
   =========================================================================
   - GET /api/tts?text=Hola
   - POST /api/tts { "text": "Hola" }
   Maneja tanto Readable (node-fetch) como ReadableStream (Web Fetch en Node 18+)
=========================================================================== */
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
      const bodyText = await r.text().catch(() => "");
      console.error("elevenlabs stream error", r.status, bodyText);
      return res.status(502).json({ error: "elevenlabs_failed", detail: bodyText });
    }

    // Cabeceras para audio "chunked"
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Accept-Ranges", "bytes");

    // Soporte para body como Node Readable o como Web ReadableStream
    const body = r.body;
    if (typeof body.pipe === "function") {
      // Node Readable (node-fetch v2)
      body.pipe(res);
      body.on("error", (e) => {
        console.error("pipe error", e);
        if (!res.headersSent) res.status(500).json({ error: "tts_pipe_failed" });
        else res.end();
      });
    } else if (body.getReader) {
      // Web ReadableStream (fetch nativo de Node 18+)
      const reader = body.getReader();
      const pump = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) res.write(Buffer.from(value));
          }
          res.end();
        } catch (e) {
          console.error("webstream pump error", e);
          if (!res.headersSent) res.status(500).json({ error: "tts_pump_failed" });
          else res.end();
        }
      };
      pump();
    } else if (Readable && Readable.fromWeb) {
      // Alternativa: convertir a Readable Node
      try {
        Readable.fromWeb(body).pipe(res);
      } catch (e) {
        console.error("fromWeb pipe error", e);
        const ab = await r.arrayBuffer();
        res.end(Buffer.from(ab));
      }
    } else {
      // Fallback: leer todo
      const ab = await r.arrayBuffer();
      res.end(Buffer.from(ab));
    }
  } catch (err) {
    console.error("tts stream error", err);
    const msg = (err && err.message) || "";
    const code = msg.includes("The operation was aborted") ? 504 : 500;
    return res.status(code).json({ error: "tts_failed", detail: msg });
  }
});

/* =========================================================================
   ElevenLabs TTS - 2) ARCHIVO COMPLETO para D-ID (/api/tts-file)
   =========================================================================
   Genera un MP3 completo, lo guarda en memoria y devuelve una URL estable
   para que D-ID lo descargue con Content-Length. (Evita silencios en avatar)
=========================================================================== */
const ttsStore = new Map(); // id -> Buffer (MP3)

async function generateTTSFileBuffer(text) {
  const VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
  const API_KEY = process.env.ELEVENLABS_API_KEY;
  if (!VOICE_ID || !API_KEY) throw new Error("missing_elevenlabs_env");

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=mp3_22050_32`;
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
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    throw new Error(`elevenlabs_failed ${r.status}: ${detail}`);
  }
  const ab = await r.arrayBuffer();
  return Buffer.from(ab);
}

app.post("/api/tts-file", async (req, res) => {
  try {
    const text = (req.body && req.body.text) || req.query.text || "";
    if (!text || !String(text).trim()) return res.status(400).json({ error: "no_text" });

    const buf = await generateTTSFileBuffer(String(text));
    const id = crypto.randomUUID();
    ttsStore.set(id, buf);

    const url = `${PUBLIC_BASE_URL}/api/tts-file/${id}.mp3`;
    res.json({ id, url, bytes: buf.length });
  } catch (e) {
    console.error("tts-file error", e);
    res.status(500).json({ error: "tts_file_failed", detail: e?.message || String(e) });
  }
});

app.get("/api/tts-file/:id.mp3", (req, res) => {
  try {
    const id = (req.params.id || "").replace(/\.mp3$/i, "");
    const buf = ttsStore.get(id);
    if (!buf) return res.status(404).json({ error: "not_found" });
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", buf.length);
    res.setHeader("Cache-Control", "no-store");
    res.end(buf);
  } catch (e) {
    console.error("serve tts-file error", e);
    res.status(500).json({ error: "serve_failed" });
  }
});

/* ====== D-ID TALK (usa archivo MP3, NO stream) ====== */
app.post("/api/did/talk-el", async (req, res) => {
  try {
    const { id, session_id, text } = req.body || {};
    if (!id || !session_id || !text || !String(text).trim()) {
      return res.status(400).json({ error: "missing_fields" });
    }

    // 1) Generar MP3 completo y obtener URL pública
    const ttsResp = await _fetch(`${PUBLIC_BASE_URL}/api/tts-file`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: String(text).slice(0, 5000) }),
    });
    if (!ttsResp.ok) {
      const detail = await ttsResp.text().catch(() => "");
      return res.status(502).json({ error: "tts_gen_failed", detail });
    }
    const { url: audio_url } = await ttsResp.json();

    // 2) Enviar a D-ID
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
    return res.status(500).json({ error: "talk_el_failed", detail: e?.message || String(e) });
  }
});

/* ====== Página de prueba rápida ====== */
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
