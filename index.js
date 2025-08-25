// index.js — backend robusto para TTS OpenAI streaming + D-ID + Whisper
const express = require("express");
const cors = require("cors");
const compression = require("compression");
const nodeFetch = require("node-fetch"); // v2 (Readable de Node)
require("dotenv").config();
const multer = require("multer");
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

/* ============ COMPRESIÓN ============
   Comprime respuestas (incluye JSON/HTML).
   El audio ya va en binario/stream; se envía tal cual.
===================================== */
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

    // openai@4 acepta Blob/File. En Node, creamos un File-like desde el buffer.
    // Si tu runtime no trae global File, construimos vía objeto { name, type, data }.
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
   • model: gpt-4o-mini-tts
   • Accept (según format):
       mp3  -> audio/mpeg
       opus -> audio/ogg (contiene Opus; ~menor latencia/bitrate)
   • Timeout duro a 8s: si OpenAI tarda, devolvemos 504 y el front puede fallbackear.
============================================================================= */
function normalizeTTSParams(method, req) {
  const src = method === "GET" ? req.query : req.body || {};
  const text = String(src.text || "").trim();
  const voice = String(src.voice || "verse").trim();
  const format = String(src.format || "mp3").toLowerCase().trim();
  const lang = String(src.lang || "es").trim(); // no se usa aquí, pero útil si luego personalizas voz por idioma
  return { text, voice, format, lang };
}

function acceptForFormat(fmt) {
  if (fmt === "opus") return "audio/ogg"; // OGG/Opus
  return "audio/mpeg"; // MP3 por compatibilidad universal
}

app.all("/api/tts-openai-stream", async (req, res) => {
  try {
    const method = req.method.toUpperCase();
    const { text, voice, format } = normalizeTTSParams(method, req);

    if (!text) return res.status(400).json({ error: "no_text" });
    if (!OPENAI_KEY) return res.status(500).json({ error: "missing_openai_key" });

    const accept = acceptForFormat(format);

    // Timeout duro (8s) para no colgar la UX.
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
        // En el endpoint oficial, el formato de salida se infiere por Accept;
        // si quisieras forzar contenedor, puedes incluir "format": "mp3"|"opus"
        // pero con Accept basta para obtener el mime adecuado.
      }),
      agent: httpsAgent,
      signal,
    }).finally(done);

    if (!r.ok || !r.body) {
      const detail = await r.text().catch(() => "");
      console.error("openai tts error", r.status, detail);
      return res.status(r.status || 502).json({ error: "openai_tts_failed", detail });
    }

    // Cabeceras de streaming
    res.setHeader("Content-Type", accept);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Accept-Ranges", "bytes");

    // node-fetch v2 -> r.body es Node Readable
    const body = r.body;
    if (body && typeof body.pipe === "function") {
      body.pipe(res);
      body.on("error", (e) => {
        console.error("tts pipe error", e);
        if (!res.headersSent) res.status(500).json({ error: "tts_pipe_failed" });
        else res.end();
      });
    } else if (body && typeof body.getReader === "function") {
      // WebStream -> convertir a Node Readable
      const nodeReadable = Readable.fromWeb(body);
      nodeReadable.pipe(res);
      nodeReadable.on("error", (e) => {
        console.error("tts pipe (fromWeb) error", e);
        if (!res.headersSent) res.status(500).json({ error: "tts_pipe_failed" });
        else res.end();
      });
    } else {
      // Fallback a buffer completo (menos eficiente pero seguro)
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
   - /api/tts-openai-stream usa Accept según ?format=mp3|opus.
     En front ya estás auto-detectando: Safari=iOS -> mp3, Chrome/Android -> opus.
   - Timeout 8s: UX no se cuelga si OpenAI tiene picos; tu front puede hacer fallback.
   - compression + keep-alive ayudan a bajar TTFB y latencia en general.
   - Mantuvimos rutas D-ID desde ./routes/did (streams/sdp/ice/talk).
====================================================================== */
