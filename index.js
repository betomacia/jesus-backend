import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// 🔊 Endpoint de prueba: texto → audio desde HeyGen
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

    const rawText = await heygenRes.text();
    console.log("Respuesta cruda de HeyGen:", rawText);

    let heygenData;
    try {
      heygenData = JSON.parse(rawText);
    } catch (parseErr) {
      throw new Error("La respuesta de HeyGen no es JSON válido");
    }

    const audioUrl = heygenData?.audio_url;
    if (!audioUrl) {
      console.error("Respuesta sin audio_url:", heygenData);
      throw new Error("No se pudo generar el audio");
    }

    res.json({ audioUrl });
  } catch (err) {
    console.error("Error en /api/audio:", err);
    res.status(500).json({ error: "No se pudo generar el audio", details: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🔊 Railway backend corriendo en puerto ${PORT}`);
});
