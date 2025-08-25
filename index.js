// index.js — backend robusto para TTS OpenAI streaming + D-ID + Whisper + OpenAI→D-ID audio
const express = require("express");
const cors = require("cors");
const compression = require("compression");
require("dotenv").config();
const multer = require("multer");
const nodeFetch = require("node-fetch"); // v2 (Readable de Node)
const { Readable } = require("stream");
const https = require("https");
const { OpenAI } = require("openai");

/* ============ RUTAS D-ID (WebRTC) ============ */
const didRouter = require("./routes/did");

/* ============ APP ============ */
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

/* ============ COMPRESIÓN ============ */
app.use(compression({ threshold: 0 }));

/* ============ BODY PARSERS ============ */
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

/* ============ MONTA /api/did/* (streams, sdp, ice, talk TEXT/AUDIO) ============ */
app.use("/api/did", didRouter);

/* ============ HELPERS GLOBALES ============ */
const fetch = (...args) => nodeFetch(...args); // forzamos node-fetch v2

const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL ||
  "https://jesus-backend-production-1cf4.up.railway.app";

/* ============ KEEP-ALIVE AGENT ============ */
const httpsAgent = new https.Agent({ keepAlive: true });

function withAbortTimeout(ms) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(t) };
}

/* ============ OPENAI (key normalizada) ============ */
const RAW_OPENAI_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_KEY = RAW_OPENAI_KEY.replace(/\r|\n/g, "").trim();

if (!OPENAI_KEY) {
  console.warn("[WARN] OPENAI_API_KEY vacío o no seteado");
}

const openai = new OpenAI({ apiKey: OPENAI_KEY });

/* ============ WHISPER (Transcripción) ============ */
const upload = multer({ limits: { fileSize: 25 * 1024 * 1024 } });

app.post("/api/transcribe", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No se recibió ningún archivo" });

    const fileName = req.file.originalname || "audio.webm";
    const resp = await openai.audio.transcriptions.create({
      file: { name: fileName, data: req.file.buffer, type: req.file.mimetype || "audio/webm" },
      model: "whisper-1",
    });

    res.json({ text: (resp.text || "").trim() });
  } catch (err) {
    console.error("Error en transcripción:", err);
    res.status(500).json({ error: "Error transcribiendo audio" });
  }
});

/* =============================================================================
   OPENAI TTS STREAMING — /api/tts-openai-stream
   - GET  /api/tts-openai-stream?text=Hola&voice=verse&format=mp3|opus&lang=es
   - POST /api/tts-openai-stream { text, voice?, format?, lang? }
   model: gpt-4o-mini-tts
============================================================================= */
function normalizeTTSParams(method, req) {
  const src = method === "GET" ? req.query : req.body || {};
  const text = String(src.text || "").trim();
  const voice = String(src.voice || "verse").trim();
  const format = String(src.format || "mp3").toLowerCase().trim();
  const lang = String(src.lang || "es").trim();
  return { text, voice, format, lang };
}

function acceptForFormat(fmt) {
  if (fmt === "opus") return "audio/ogg"; // OGG (Opus)
  return "audio/mpeg"; // MP3
}

app.all("/api/tts-openai-stream", async (req, res) => {
  try {
    const method = req.method.toUpperCase();
    const { text, voice, format } = normalizeTTSParams(method, req);

    if (!text) return res.status(400).json({ error: "no_text" });
    if (!OPENAI_KEY) return res.status(500).json({ error: "missing_openai_key" });

    const accept = acceptForFormat(format);
    const { signal, done } = withAbortTimeout(Number(process.env.OPENAI_TTS_TIMEOUT_MS || 8000));

    const r = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_KEY}`,
        "Content-Type": "application/json",
        Accept: accept,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini-tts",
        voice: voice,
        input: text.slice(0, 5000),
      }),
      agent: httpsAgent,
      signal,
    }).finally(done);

    if (!r.ok || !r.body) {
      const detail = await r.text().catch(() => "");
      console.error("openai tts error", r.status, detail);
      return res.status(r.status || 502).json({ error: "openai_tts_failed", detail });
    }

    res.setHeader("Content-Type", accept);
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
  } catch (e) {
    const aborted = e && (e.name === "AbortError" || String(e).includes("aborted"));
    if (aborted) {
      console.error("openai tts timeout");
      return res.status(504).json({ error: "openai_tts_timeout" });
    }
    console.error("openai tts fatal", e);
    return res.status(500).json({ error: "openai_tts_failed_generic", detail: String(e?.message || e) });
  }
});

/* =========================
   Endpoint de prueba rápida de TTS
   ========================= */
app.get("/api/tts-openai-test", (req, res) => {
  const q = String(req.query.text || "Hola, la paz sea contigo.");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>TTS OpenAI Test</title></head>
<body style="font-family:sans-serif;padding:24px">
  <h1>TTS OpenAI Test</h1>
  <form method="GET" action="/api/tts-openai-test">
    <label>Texto:</label>
    <input type="text" name="text" value="${q.replace(/"/g, "&quot;")}" style="width: 420px" />
    <button type="submit">Reproducir</button>
  </form>
  <p>Endpoint: <code>/api/tts-openai-stream?text=...</code></p>
  <audio id="player" controls autoplay src="/api/tts-openai-stream?format=mp3&voice=verse&text=${encodeURIComponent(q)}"></audio>
</body>
</html>`);
});

/* =========================
   Diag simple para Chat (SDK)
   ========================= */
app.get("/api/diag/openai", async (_req, res) => {
  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "Di solo: OK" }],
    });
    res.json({ ok: true, message: resp.choices?.[0]?.message?.content || "" });
  } catch (e) {
    console.error("diag/openai error:", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/* =========================================================================
   OpenAI MP3 buffer + servidor temporal para D-ID (audio_url)
   - /api/tmp-audio/:id.mp3 sirve el buffer en memoria
   - openaiTTSBuffer(text) genera MP3 con OpenAI
   - /api/did/talk-openai-audio: orquesta OpenAI→D-ID (script.type=audio)
========================================================================= */
const tmpStore = new Map(); // id -> Buffer

app.get("/api/tmp-audio/:id.mp3", (req, res) => {
  try {
    const id = String(req.params.id || "");
    const buf = tmpStore.get(id);
    if (!buf) return res.status(404).json({ error: "not_found" });
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", buf.length);
    res.setHeader("Cache-Control", "no-store");
    res.end(buf);
  } catch (e) {
    console.error("serve tmp-audio error", e);
    res.status(500).json({ error: "serve_failed" });
  }
});

async function openaiTTSBuffer(text, voice = "verse") {
  const { signal, done } = withAbortTimeout(Number(process.env.OPENAI_TTS_TIMEOUT_MS || 8000));
  try {
    const r = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_KEY}`,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini-tts",
        voice,
        input: String(text).slice(0, 5000),
      }),
      agent: httpsAgent,
      signal,
    });
    done();
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      throw new Error(`openai_tts_failed ${r.status}: ${detail}`);
    }
    const buf = await r.buffer();
    return buf;
  } catch (e) {
    done();
    throw e;
  }
}

/**
 * POST /api/did/talk-openai-audio
 * body: { id, session_id, text, voice? }
 * Genera MP3 con OpenAI y lo entrega a D-ID (script.type="audio") para animación.
 */
app.post("/api/did/talk-openai-audio", async (req, res) => {
  try {
    const { id, session_id, text, voice } = req.body || {};
    if (!id || !session_id || !text || !String(text).trim()) {
      return res.status(400).json({ error: "missing_fields" });
    }

    // 1) TTS con OpenAI (MP3)
    const buf = await openaiTTSBuffer(String(text), voice || "verse");

    // 2) Publica el MP3 temporal para que D-ID lo lea
    const audioId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    tmpStore.set(audioId, buf);
    // (Opcional: limpiar viejos cada X minutos)
    const audioUrl = `${PUBLIC_BASE_URL}/api/tmp-audio/${audioId}.mp3`;

    // 3) POST a D-ID (script.type=audio)
    const didHeaders = {};
    if (process.env.DID_API_KEY) {
      didHeaders.Authorization = "Basic " + Buffer.from(`${process.env.DID_API_KEY}:`).toString("base64");
    } else if (process.env.DID_USERNAME && process.env.DID_PASSWORD) {
      didHeaders.Authorization = "Basic " + Buffer.from(`${process.env.DID_USERNAME}:${process.env.DID_PASSWORD}`).toString("base64");
    } else {
      console.warn("[D-ID] Faltan credenciales");
    }

    const rr = await fetch(`https://api.d-id.com/talks/streams/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...didHeaders,
      },
      body: JSON.stringify({
        session_id,
        script: {
          type: "audio",
          audio_url: audioUrl
        }
      }),
      agent: httpsAgent,
    });

    const data = await rr.json().catch(() => ({}));
    if (!rr.ok) {
      console.error("D-ID talk-openai-audio error", rr.status, data);
      return res.status(rr.status).json(data);
    }

    return res.json({ ok: true, data });
  } catch (e) {
    console.error("talk-openai-audio fatal", e);
    return res.status(500).json({ error: "talk_openai_audio_failed", detail: String(e?.message || e) });
  }
});

/* =========================
   Bienvenida dinámica
   ========================= */
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

/* =========================
   Raíz
   ========================= */
app.get("/", (_req, res) => {
  res.send("jesus-backend up ✅");
});

/* =========================
   Inicio servidor
   ========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
});

/* ======================================================================
   NOTAS:
   - OPENAI_API_KEY se normaliza (.replace(/\r|\n/g,'').trim()) para evitar
     el error "is not a legal HTTP header value".
   - /api/tts-openai-stream: Accept según ?format=mp3|opus (front autodetecta).
   - /api/did/talk-openai-audio: genera MP3 con OpenAI y D-ID lo usa para animar.
   - compression + keep-alive + timeouts cortos => menor latencia y UX estable.
   - Asegura PUBLIC_BASE_URL (https) accesible públicamente para audio_url de D-ID.
====================================================================== */
