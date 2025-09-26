import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// 🎬 Endpoint principal: texto → audio → video
app.post("/api/avatar", async (req, res) => {
  try {
    const { text, userId = "anon" } = req.body;
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "Missing or invalid text" });
    }

    console.log("Texto recibido:", text);

    // 🔁 Paso A: generar audio con HeyGen
    const heygenRes = await fetch("https://api.heygen.com/v1/audio/generate", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.HEYGEN_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        voice_id: process.env.HEYGEN_VOICE_ID,
        script: text,
        language: "es-AR"
      })
    });

    const heygenData = await heygenRes.json();
    const audioUrl = heygenData?.audio_url;
    console.log("Audio URL:", audioUrl);
    if (!audioUrl) throw new Error("No se pudo generar el audio");

    // 🔁 Paso B: enviar audio al servidor avatar
    const avatarRes = await fetch("http://34.67.119.151:8083/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audioUrl, userId })
    });

    if (!avatarRes.ok) throw new Error("Servidor avatar falló");

    const buffer = await avatarRes.arrayBuffer();
    res.setHeader("Content-Type", "video/mp4");
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error("Error en /api/avatar:", err);
    res.status(500).json({ error: "No se pudo generar el video", details: err.message });
  }
});

// 🔊 Endpoint de prueba: texto → audio
app.post("/api/audio", async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "Missing or invalid text" });
    }

    console.log("Texto recibido para audio:", text);

    const heygenRes = await fetch("https://api.heygen.com/v1/audio/generate", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.HEYGEN_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        voice_id: process.env.HEYGEN_VOICE_ID,
        script: text,
        language: "es-AR"
      })
    });

    const { audio_url } = await heygenRes.json();
    console.log("Audio generado:", audio_url);
    if (!audio_url) throw new Error("No se pudo generar el audio");

    res.json({ audioUrl: audio_url });
  } catch (err) {
    console.error("Error en /api/audio:", err);
    res.status(500).json({ error: "No se pudo generar el audio", details: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Railway backend corriendo en puerto ${PORT}`);
});
