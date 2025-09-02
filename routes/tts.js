// routes/tts.js
const express = require("express");
const router = express.Router();

const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY || "";
const DEFAULT_VOICE = process.env.ELEVEN_VOICE_ID || "21m00Tcm4TlvDq8ikWAM";

router.post("/", async (req, res) => {
  try {
    const { text, voiceId } = req.body || {};
    const t = (text || "").toString().trim();
    if (!t) return res.status(400).json({ error: "Falta 'text'." });
    if (!ELEVEN_API_KEY) return res.status(501).json({ error: "ElevenLabs no configurado." });

    const voice = (voiceId || DEFAULT_VOICE).toString();

    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}`, {
      method: "POST",
      headers: {
        "xi-api-key": ELEVEN_API_KEY,
        "accept": "audio/mpeg",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        text: t,
        output_format: "mp3_44100_128",
      }),
    });

    if (!r.ok) {
      const msg = await r.text().catch(() => "");
      return res.status(r.status).json({ error: "ElevenLabs fallo", details: msg || r.statusText });
    }

    const ab = await r.arrayBuffer();
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    res.send(Buffer.from(ab));
  } catch (err) {
    console.error("TTS ERROR:", err);
    res.status(500).json({ error: "Error interno TTS" });
  }
});

module.exports = router; // <- IMPORTANTE
