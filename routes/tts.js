// routes/tts.js
// ElevenLabs TTS router (solo audio). Devuelve audio/mpeg.
// Env:
//   ELEVEN_API_KEY (obligatoria)
//   ELEVEN_VOICE_ID (opcional; por defecto "Rachel")
//   ELEVEN_MODEL (opcional; por defecto "eleven_multilingual_v2")
//   ELEVEN_STABILITY, ELEVEN_SIMILARITY, ELEVEN_STYLE, ELEVEN_SPK_BOOST (opcionales)

const express = require("express");
const nodeFetch = require("node-fetch");

const router = express.Router();
const fetch = (...args) => nodeFetch(...args);

const API_KEY = process.env.ELEVEN_API_KEY || "";
const DEFAULT_VOICE = process.env.ELEVEN_VOICE_ID || "21m00Tcm4TlvDq8ikWAM"; // Rachel
const MODEL = process.env.ELEVEN_MODEL || "eleven_multilingual_v2";

const VS = {
  stability: Number(process.env.ELEVEN_STABILITY ?? 0.4),
  similarity_boost: Number(process.env.ELEVEN_SIMILARITY ?? 0.8),
  style: Number(process.env.ELEVEN_STYLE ?? 0.1),
  use_speaker_boost: process.env.ELEVEN_SPK_BOOST === "false" ? false : true,
};

// Salud
router.get("/health", (_req, res) => {
  res.json({ ok: true, model: MODEL, voice: DEFAULT_VOICE, hasKey: Boolean(API_KEY) });
});

// POST /api/tts  { text, voiceId? }
router.post("/", async (req, res) => {
  try {
    if (!API_KEY) return res.status(501).json({ error: "elevenlabs_key_missing" });

    const { text, voiceId } = req.body || {};
    const t = String(text || "").trim();
    if (!t) return res.status(400).json({ error: "missing_text" });

    const vid = voiceId || DEFAULT_VOICE;
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${vid}?optimize_streaming_latency=0&output_format=mp3_44100_128`;

    const body = {
      text: t,
      model_id: MODEL,
      voice_settings: VS,
    };

    const r = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": API_KEY,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg",
      },
      body: JSON.stringify(body),
    });

    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      return res.status(r.status).json({ error: "elevenlabs_upstream", detail: detail?.slice(0, 1200) || "" });
    }

    const ab = await r.arrayBuffer();
    res.setHeader("Content-Type", "audio/mpeg");
    res.send(Buffer.from(ab));
  } catch (e) {
    console.error("ELEVEN TTS error:", e);
    res.status(500).json({ error: "tts_failed" });
  }
});

module.exports = router;
