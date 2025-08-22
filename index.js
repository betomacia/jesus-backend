// index.js
const express = require("express");
const cors = require("cors");
require("dotenv").config();

// Usa fetch nativo si existe; si no, node-fetch.
const fetch = global.fetch || require("node-fetch");

const multer = require("multer");
const { OpenAI } = require("openai");

const app = express();
app.set("trust proxy", true);

/* =========================
   CORS / JSON
   ========================= */
const allowedOrigin = process.env.CORS_ORIGIN || "*";
app.use(cors({ origin: allowedOrigin === "*" ? true : allowedOrigin }));
app.use(express.json());

/* =========================
   HEALTH/PING
   ========================= */
app.get("/_health", (_req, res) => res.status(200).send("ok"));
app.get("/", (_req, res) => res.send("jesus-backend up ✅"));

/* =========================
   D-ID (crear sesión de stream)
   ========================= */
const DID_USER = process.env.DID_USERNAME || "";
const DID_PASS = process.env.DID_PASSWORD || "";
const didAuth =
  DID_USER && DID_PASS
    ? Buffer.from(`${DID_USER}:${DID_PASS}`).toString("base64")
    : null;

const streams = {}; // opcional, si luego quieres trackear

app.post("/create-stream-session", async (_req, res) => {
  if (!didAuth) return res.status(500).json({ error: "missing_did_credentials" });
  try {
    const data = {
      source_url:
        "https://raw.githubusercontent.com/betomacia/imagen-jesus/refs/heads/main/jesus.jpg",
    };

    // 1) crear
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

    // 2) offer + ice
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
  } catch (err) {
    console.error("Error creando stream session:", err);
    res.status(500).json({ error: "create_stream_failed" });
  }
});

/* =========================
   OpenAI Whisper (Transcripción)
   ========================= */
const upload = multer({ limits: { fileSize: 25 * 1024 * 1024 } }); // 25MB
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.post("/api/transcribe", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "no_file" });
    const fileBlob = new Blob([req.file.buffer], {
      type: req.file.mimetype || "audio/webm",
    });
    const resp = await openai.audio.transcriptions.create({
      file: fileBlob,
      model: "whisper-1",
      // language: "es"
    });
    res.json({ text: (resp.text || "").trim() });
  } catch (err) {
    console.error("transcribe error", err);
    res.status(500).json({ error: "transcribe_failed" });
  }
});

/* =========================
   ElevenLabs TTS (streaming con timeout)
   ========================= */
app.all("/api/tts", async (req, res) => {
  try {
    const text =
      req.method === "GET"
        ? (req.query.text || "")
        : (req.body && req.body.text) || "";
    if (!text || !String(text).trim())
      return res.status(400).json({ error: "no_text" });

    const VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
    const API_KEY = process.env.ELEVENLABS_API_KEY;
    if (!VOICE_ID || !API_KEY)
      return res.status(500).json({ error: "missing_elevenlabs_env" });

    // Timeout 15s
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream?optimize_streaming_latency=4&output_format=mp3_22050_32`;

    const r = await fetch(url, {
      method: "POST",
      signal: controller.signal,
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
    }).catch((e) => {
      if (e.name === "AbortError") {
        return { ok: false, status: 504, body: null, _timeout: true };
      }
      throw e;
    });

    clearTimeout(timer);

    if (!r || !r.ok || !r.body) {
      const bodyText = (!r || r._timeout)
        ? "timeout"
        : await r.text().catch(() => "");
      console.error("elevenlabs stream error", r?._timeout ? 504 : r?.status, bodyText);
      return res
        .status(r?._timeout ? 504 : 502)
        .json({ error: "elevenlabs_failed" });
    }

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Access-Control-Allow-Origin", "*");
    r.body.pipe(res);
  } catch (err) {
    console.error("tts stream error", err);
    return res.status(500).json({ error: "tts_failed" });
  }
});

/* =========================
   ONE-QUESTION (inline)
   ========================= */
const SYS_BASE = `Eres un asistente compasivo y concreto.
Debes devolver EXACTAMENTE UNA PREGUNTA breve y específica que ayude al usuario a avanzar.
No repitas lo que ya dijo. Evita frases genéricas como "¿cómo seguimos hoy?".
La respuesta debe ser SOLO una pregunta terminada en "?"`;

function clampQuestion(s) {
  let t = (s || "").trim();
  if (!t.endsWith("?")) t += "?";
  return t;
}

app.post("/api/openai/one-question", async (req, res) => {
  try {
    const user_text = req.body?.user_text || "";
    if (!user_text) return res.status(400).json({ error: "missing_user_text" });

    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      max_tokens: 100,
      messages: [
        { role: "system", content: SYS_BASE },
        { role: "user", content: user_text },
      ],
    });

    let q = (resp.choices?.[0]?.message?.content || "").trim();
    q = clampQuestion(q);
    res.json({ text: q });
  } catch (err) {
    console.error("one-question error", err);
    res.status(500).json({ error: "one-question_failed" });
  }
});

/* =========================
   START SERVER
   ========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor escuchando en http://0.0.0.0:${PORT}`);
});
