// server/routes/voice.ts
import express from "express";
import fetch from "node-fetch";

const router = express.Router();

// Asigna tus voice_id por idioma en .env
const VOICE_ID_BY_LANG: Record<string, string> = {
  es: process.env.HEYGEN_VOICE_ID_ES || "",
  en: process.env.HEYGEN_VOICE_ID_EN || "",
  pt: process.env.HEYGEN_VOICE_ID_PT || "",
  it: process.env.HEYGEN_VOICE_ID_IT || "",
  de: process.env.HEYGEN_VOICE_ID_DE || "",
  ca: process.env.HEYGEN_VOICE_ID_CA || "",
};

router.post("/tts", async (req, res) => {
  try {
    const { text = "", lang = "es" } = req.body || {};
    const voice_id = VOICE_ID_BY_LANG[lang] || VOICE_ID_BY_LANG.es;
    if (!voice_id) return res.status(500).json({ error: "VOICE_ID no configurado" });

    const rr = await fetch("https://api.heygen.com/v1/voice/tts", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": process.env.HEYGEN_API_KEY || "",
      },
      body: JSON.stringify({
        voice_id,
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
    if (!audioBase64) return res.status(500).json({ error: "Sin audio en respuesta" });

    return res.json({ audioBase64 });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "TTS error" });
  }
});

export default router;
