// routes/tts.js
const express = require("express");
const fetch = require("node-fetch");

const router = express.Router();

// Acepta alias de variable para evitar errores de nombre
function getApiKey() {
  return (
    process.env.ELEVEN_API_KEY ||
    process.env.ELEVENLABS_API_KEY ||
    process.env.ELEVEN_LABS_API_KEY ||
    process.env.NEXT_PUBLIC_ELEVEN_API_KEY ||
    ""
  );
}

function getVoiceId() {
  return (
    process.env.ELEVEN_VOICE_ID ||
    process.env.ELEVENLABS_VOICE_ID ||
    "21m00Tcm4TlvDq8ikWAM" // voz por defecto
  );
}

router.get("/selftest", (_req, res) => {
  const key = getApiKey();
  res.json({
    ok: !!key,
    hasKey: !!key,
    // máscara de 4 chars para depurar sin filtrar la clave
    keyPreview: key ? `${key.slice(0, 4)}… (${key.length} chars)` : null,
    model: process.env.ELEVEN_MODEL || "eleven_multilingual_v2",
    voiceId: getVoiceId(),
  });
});

// POST /api/tts  { text, voiceId? } -> audio/mpeg
router.post("/", async (req, res) => {
  try {
    const API_KEY = getApiKey();
    if (!API_KEY) return res.status(501).json({ error: "ELEVEN_API_KEY missing" });

    const { text, voiceId } = req.body || {};
    const t = String(text || "").trim();
    if (!t) return res.status(400).json({ error: "missing_text" });

    const vid = voiceId || getVoiceId();
    const model = process.env.ELEVEN_MODEL || "eleven_multilingual_v2";

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(
      vid
    )}?optimize_streaming_latency=0&output_format=mp3_44100_128`;

    const r = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": API_KEY,
        Accept: "audio/mpeg",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: t,
        model_id: model,
        voice_settings: {
          stability: Number(process.env.ELEVEN_STABILITY ?? 0.4),
          similarity_boost: Number(process.env.ELEVEN_SIMILARITY ?? 0.8),
          style: Number(process.env.ELEVEN_STYLE ?? 0.1),
          use_speaker_boost: process.env.ELEVEN_SPK_BOOST === "false" ? false : true,
        },
      }),
    });

    if (!r.ok) {
      const msg = await r.text().catch(() => "");
      return res
        .status(r.status)
        .json({ error: "elevenlabs_upstream", detail: msg?.slice(0, 800) || r.statusText });
    }

    const ab = await r.arrayBuffer();
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    res.send(Buffer.from(ab));
  } catch (e) {
    console.error("TTS route error:", e);
    res.status(500).json({ error: "tts_failed" });
  }
});

module.exports = router;
