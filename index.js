// index.js
// =====================================
// Backend mínimo funcional para tu app
// - Express inicializado (evita "app is not defined")
// - /api/tts-openai-stream integrado (tu código, pulido)
// - Stubs para /api/did/*, /api/transcribe, /api/jesus
// =====================================

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const upload = multer();
const path = require("path");

// -------------------------------------
// App base
// -------------------------------------
const app = express();
app.use(cors());
app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: true }));

// Healthcheck
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// =====================================
// /api/tts-openai-stream (robusto)
// =====================================
const { OpenAI } = require("openai");
const { PassThrough } = require("stream");
const http = require("http");
const https = require("https");

// keep-alive para conexiones largas
const httpAgent  = new http.Agent({ keepAlive: true, maxSockets: 50 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });

// Nota: necesitas OPENAI_API_KEY en tus variables de entorno
const openai = new OpenAI({
  apiKey: (process.env.OPENAI_API_KEY || "").trim(),
  // Si usas un proxy/baseURL personalizado, define OPENAI_BASE_URL
  baseURL: process.env.OPENAI_BASE_URL || undefined,
});

app.get("/api/tts-openai-stream", async (req, res) => {
  try {
    const text = String(req.query.text || "");
    const voice = String(req.query.voice || "verse"); // voces: "verse", "alloy", etc. (ajusta a lo que soporte tu cuenta)
    const lang = String(req.query.lang || "es");
    const format = String(req.query.format || "mp3"); // mp3|wav|opus

    if (!text.trim()) return res.status(400).json({ error: "no_text" });
    if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_API_KEY.trim())
      return res.status(500).json({ error: "missing_openai_key" });

    // Cabeceras de audio chunked
    res.setHeader(
      "Content-Type",
      format === "wav" ? "audio/wav" : format === "opus" ? "audio/ogg" : "audio/mpeg"
    );
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Transfer-Encoding", "chunked");
    if (res.flushHeaders) res.flushHeaders();

    // Modelo TTS (ajusta a lo disponible en tu cuenta)
    const model = process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts";
    const audioFormat = format === "wav" ? "wav" : format === "opus" ? "opus" : "mp3";

    // Llamada a OpenAI TTS.
    // El SDK nuevo suele devolver un Response (web-stream) o arrayBuffer.
    const response = await openai.audio.speech.create(
      {
        model,
        voice,      // "verse", "alloy", etc.
        input: text,
        format: audioFormat, // "mp3" | "wav" | "opus"
        language: lang,      // opcional
      },
      {
        // Inyecta agentes keep-alive para estabilidad
        fetch: (url, opts) => {
          const isHttps = url.toString().startsWith("https:");
          return fetch(url, { ...opts, agent: isHttps ? httpsAgent : httpAgent });
        },
      }
    );

    // Normalizamos a Node stream
    const body = response.body || response; // compat
    const passthrough = new PassThrough();

    if (body && typeof body.getReader === "function") {
      // WebStream
      const reader = body.getReader();
      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) passthrough.write(Buffer.from(value));
          }
          passthrough.end();
        } catch (e) {
          console.error("[tts-openai-stream] web reader error", e);
          passthrough.destroy(e);
        }
      })();
    } else if (body && typeof body.pipe === "function") {
      // Node readable
      body.pipe(passthrough);
      body.on("error", (e) => {
        console.error("[tts-openai-stream] pipe error", e);
        passthrough.destroy(e);
      });
    } else if (body && Buffer.isBuffer(body)) {
      // Buffer completo (menos ideal)
      passthrough.end(body);
    } else if (response.arrayBuffer) {
      // Fallback
      const ab = await response.arrayBuffer();
      passthrough.end(Buffer.from(ab));
    } else {
      return res.status(502).json({ error: "no_stream_body" });
    }

    // Enviar al cliente en streaming
    passthrough.pipe(res);
    passthrough.on("error", (e) => {
      console.error("[tts-openai-stream] passthrough error", e);
      if (!res.headersSent) res.status(500).end();
      else res.end();
    });
  } catch (err) {
    console.error("tts-openai-stream fatal:", err?.message || err);
    if (!res.headersSent) {
      const msg = (err && err.message) || "";
      return res.status(502).json({ error: "openai_tts_failed", detail: msg });
    }
    try { res.end(); } catch {}
  }
});

// =====================================
// Stubs (o puntos de integración) para el frontend
// =====================================

// ---- D-ID: negociación WebRTC (placeholder) ----
// Tu frontend hace POST { sdp } y espera { sdp: answer }
app.post("/api/did/connect", async (req, res) => {
  try {
    const { sdp } = req.body || {};
    if (!sdp) return res.status(400).json({ error: "Missing sdp" });

    // TODO: Implementa aquí la negociación real con la API de D-ID
    // usando tus credenciales en variables de entorno:
    //   DID_BASE_URL, DID_USERNAME, DID_PASSWORD, DID_TALK_ID, etc.

    // Por ahora devolvemos un SDP dummy para no romper el flujo.
    // OJO: Esto no establecerá video real, sólo evita errores en el cliente.
    const dummyAnswer =
      "v=0\r\n" +
      "o=- 0 0 IN IP4 127.0.0.1\r\n" +
      "s=DUMMY\r\n" +
      "t=0 0\r\n";
    return res.json({ sdp: dummyAnswer });
  } catch (e) {
    console.error("[/api/did/connect] error:", e);
    return res.status(500).json({ error: "did_connect_failed" });
  }
});

// ---- D-ID: speak/lipsync (placeholder) ----
app.post("/api/did/speak", async (req, res) => {
  try {
    const { text } = req.body || {};
    if (!text) return res.status(400).json({ ok: false, error: "Missing text" });

    // TODO: Llama a tu endpoint de D-ID speak con basic auth.
    // Env vars esperadas (ejemplo):
    // DID_BASE_URL, DID_USERNAME, DID_PASSWORD, DID_TALK_ID, DID_VOICE_ID ...

    return res.json({ ok: true });
  } catch (e) {
    console.error("[/api/did/speak] error:", e);
    return res.status(500).json({ ok: false, error: "did_speak_failed" });
  }
});

// ---- Transcripción (STT). Puedes dejarlo stub o activar Whisper/OpenAI) ----
const fs = require("fs");
const os = require("os");
const { randomUUID } = require("crypto");

app.post("/api/transcribe", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Missing audio file" });

    // Si no tienes clave o quieres stub, responde algo fijo:
    if (!process.env.OPENAI_API_KEY) {
      return res.json({ text: "Hola, esto es un placeholder de transcripción." });
    }

    // ----- Opción: usar Whisper-1 con archivo temporal -----
    const tmpDir = os.tmpdir();
    const tmpPath = path.join(tmpDir, `${randomUUID()}.webm`);
    fs.writeFileSync(tmpPath, req.file.buffer);

    // Algunos SDKs usan esta firma:
    // openai.audio.transcriptions.create({ file, model: "whisper-1" })
    // Según versión del SDK, también puede ser openai.audio.transcriptions.create o openai.audio.transcriptions
    const resp = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tmpPath),
      model: process.env.OPENAI_STT_MODEL || "whisper-1",
      // language: "es", // opcional
      // response_format: "json", // según soporte
    });

    // Limpieza
    try { fs.unlinkSync(tmpPath); } catch {}

    const text =
      (resp && (resp.text || resp.output || resp.transcript || resp.data?.text)) ||
      "";
    return res.json({ text: text || " " });
  } catch (e) {
    console.error("[/api/transcribe] error:", e?.message || e);
    return res.status(200).json({ text: " " }); // evita romper UX del cliente
  }
});

// ---- Backend de "Jesús" (chat). Stub sencillo ----
app.post("/api/jesus", async (req, res) => {
  try {
    const { prompt } = req.body || {};
    if (!prompt) return res.status(400).json({ error: "Missing prompt" });

    // Si tienes OPENAI_API_KEY, puedes responder con un LLM real:
    if (process.env.OPENAI_API_KEY) {
      // Modelo ligero por coste/latencia; ajusta según quieras
      const model = process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini";
      const completion = await openai.chat.completions.create({
        model,
        messages: [
          {
            role: "system",
            content:
              "Eres una figura espiritual llamada Jesús. Respondes con calma, compasión y mensajes universales (no dogmáticos), en español claro y conciso.",
          },
          { role: "user", content: prompt },
        ],
        temperature: 0.7,
      });

      const reply =
        completion.choices?.[0]?.message?.content ||
        "La paz sea contigo. ¿En qué puedo ayudarte?";
      return res.json({ reply });
    }

    // Si no hay clave, responde un texto de ejemplo:
    const reply =
      "La paz sea contigo. Esto es una respuesta de ejemplo. Configura OPENAI_API_KEY para respuestas reales.";
    return res.json({ reply });
  } catch (e) {
    console.error("[/api/jesus] error:", e?.message || e);
    return res.status(200).json({
      reply:
        "Estoy aquí contigo. Ahora mismo no puedo responder con detalle; intenta de nuevo en unos instantes.",
    });
  }
});

// -------------------------------------
// Arranque del servidor
// -------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
});
