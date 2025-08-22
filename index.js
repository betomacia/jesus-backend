const express = require("express");
const cors = require("cors");
require("dotenv").config();

// Usa fetch nativo de Node 18+; si estás en Node 16, mantén node-fetch:
const fetch = global.fetch || require("node-fetch");

const multer = require("multer");
const { OpenAI } = require("openai");

const app = express();
app.set('trust proxy', true);

/* ===== CORS ===== */
const allowedOrigin = process.env.CORS_ORIGIN || "*";
app.use(cors({ origin: allowedOrigin === "*" ? true : allowedOrigin }));
app.use(express.json());

/* ===== Salud / ping ===== */
app.get("/_health", (_req, res) => res.status(200).send("ok"));
app.get("/", (_req, res) => res.send("jesus-backend up ✅"));

/* ===== Whisper ===== */
const upload = multer({ limits: { fileSize: 25 * 1024 * 1024 } }); // 25MB
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.post("/api/transcribe", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "no_file" });
    const fileBlob = new Blob([req.file.buffer], { type: req.file.mimetype || "audio/webm" });
    const resp = await openai.audio.transcriptions.create({ file: fileBlob, model: "whisper-1" });
    res.json({ text: (resp.text || "").trim() });
  } catch (err) {
    console.error("transcribe error", err);
    res.status(500).json({ error: "transcribe_failed" });
  }
});

/* ===== ElevenLabs TTS con timeout ===== */
app.all("/api/tts", async (req, res) => {
  try {
    const text = req.method === "GET" ? (req.query.text || "") : (req.body?.text || "");
    if (!text || !String(text).trim()) return res.status(400).json({ error: "no_text" });

    const VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
    const API_KEY  = process.env.ELEVENLABS_API_KEY;
    if (!VOICE_ID || !API_KEY) return res.status(500).json({ error: "missing_elevenlabs_env" });

    // Timeout defensivo (15s)
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 15000);

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

    clearTimeout(t);

    if (!r || !r.ok || !r.body) {
      const bodyText = (!r || r._timeout) ? "timeout" : (await r.text().catch(() => ""));
      console.error("elevenlabs stream error", r?._timeout ? 504 : r?.status, bodyText);
      return res.status(r?._timeout ? 504 : 502).json({ error: "elevenlabs_failed", status: r?._timeout ? 504 : (r?.status || 0), body: bodyText });
    }

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Access-Control-Allow-Origin", "*");

    // Pipe directo (streaming)
    r.body.pipe(res);
  } catch (err) {
    console.error("tts stream error", err);
    return res.status(500).json({ error: "tts_failed" });
  }
});

/* ===== Inicio servidor ===== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor escuchando en http://0.0.0.0:${PORT}`);
});
