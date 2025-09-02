// routes/tts.js
const express = require("express");
const router = express.Router();

// GET /api/tts/selftest  -> comprueba clave y conexión con ElevenLabs
router.get("/selftest", async (_req, res) => {
  try {
    const apiKey = process.env.ELEVEN_API_KEY || "";
    const model  = process.env.ELEVEN_MODEL || "eleven_multilingual_v2";
    const voice  = process.env.ELEVEN_VOICE_ID || "(default)";
    if (!apiKey) return res.status(200).json({ ok: false, hasKey: false, error: "ELEVEN_API_KEY missing" });

    // ping rápido a /voices para verificar credenciales
    const r = await fetch("https://api.elevenlabs.io/v1/voices", {
      method: "GET",
      headers: { "xi-api-key": apiKey, "accept": "application/json" }
    });

    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      return res.status(r.status).json({ ok: false, hasKey: true, error: "upstream", detail: detail?.slice(0, 600) });
    }
    const data = await r.json().catch(() => ({}));
    const voicesCount = Array.isArray(data?.voices) ? data.voices.length : 0;

    res.json({ ok: true, hasKey: true, model, voiceId: voice, voicesCount });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/*
  POST /api/tts
  body: { text: string, voiceId?: string }
  -> audio/mpeg
*/
router.post("/", async (req, res) => {
  try {
    const apiKey = process.env.ELEVEN_API_KEY || "";
    if (!apiKey) return res.status(501).json({ error: "elevenlabs_key_missing" });

    const { text, voiceId } = req.body || {};
    const t = String(text || "").trim();
    if (!t) return res.status(400).json({ error: "missing_text" });

    const model = process.env.ELEVEN_MODEL || "eleven_multilingual_v2";
    const vid   = voiceId || process.env.ELEVEN_VOICE_ID || "21m00Tcm4TlvDq8ikWAM"; // Rachel por defecto

    const body = {
      text: t,
      model_id: model,
      voice_settings: {
        stability: Number(process.env.ELEVEN_STABILITY ?? 0.4),
        similarity_boost: Number(process.env.ELEVEN_SIMILARITY ?? 0.8),
        style: Number(process.env.ELEVEN_STYLE ?? 0.1),
        use_speaker_boost: process.env.ELEVEN_SPK_BOOST === "false" ? false : true
      }
    };

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(vid)}?optimize_streaming_latency=0&output_format=mp3_44100_128`;
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg"
      },
      body: JSON.stringify(body)
    });

    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      return res.status(r.status).json({ error: "elevenlabs_upstream", detail: detail?.slice(0, 1200) || "" });
    }

    const ab = await r.arrayBuffer();
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    res.send(Buffer.from(ab));
  } catch (e) {
    console.error("TTS error:", e);
    res.status(500).json({ error: "tts_failed" });
  }
});

module.exports = router;
