// server/routes/voice.ts
import express from "express";
import fetch from "node-fetch";

const router = express.Router();

/**
 * Requiere en .env:
 *   HEYGEN_API_KEY=sk-xxxxxxxxxxxxxxxx
 *   HEYGEN_VOICE_ID=voice_yyyyyyyyyyyyyy   // ÚNICO voice_id multilingüe
 */

router.post("/tts", async (req, res) => {
  try {
    const { text = "", lang = "es" } = req.body || {};
    const apiKey = process.env.HEYGEN_API_KEY || "";
    const voiceId = process.env.HEYGEN_VOICE_ID || "";

    if (!apiKey) return res.status(500).json({ error: "Falta HEYGEN_API_KEY" });
    if (!voiceId) return res.status(500).json({ error: "Falta HEYGEN_VOICE_ID" });
    if (!text.trim()) return res.status(400).json({ error: "Texto vacío" });

    const rr = await fetch("https://api.heygen.com/v1/voice/tts", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": apiKey,
      },
      body: JSON.stringify({
        voice_id: voiceId,
        text,
        format: "mp3",
      }),
    });

    if (!rr.ok) {
      const body = await rr.text();
      return res.status(rr.status).json({ error: "Heygen TTS fail", body });
    }

    const data = await rr.json().catch(() => ({}));
    const audioBase64 = data?.audio || data?.data || "";

    if (!audioBase64) {
      return res.status(500).json({ error: "Sin audio en respuesta de Heygen" });
    }

    return res.json({ audioBase64, lang });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "Error TTS" });
  }
});

export default router;
