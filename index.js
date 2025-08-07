const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const dotenv = require("dotenv");

dotenv.config();

process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('unhandledRejection:', reason);
});

const app = express();

app.use(cors());
app.use(express.json());

const auth = Buffer.from(`${process.env.DID_USERNAME}:${process.env.DID_PASSWORD}`).toString("base64");

async function generateVideo(text) {
  const data = {
    source_url: "https://raw.githubusercontent.com/betomacia/imagen-jesus/refs/heads/main/jesus.jpg",
    script: {
      type: "text",
      input: text,
      provider: { type: "microsoft", voice_id: "es-ES-AlvaroNeural" },
      ssml: false,
    },
    config: { stitch: true },
  };

  console.log("Enviando request a D-ID con payload:", JSON.stringify(data));

  const response = await fetch("https://api.d-id.com/talks", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  });

  console.log("Respuesta HTTP D-ID status:", response.status);

  if (!response.ok) {
    const errorText = await response.text();
    console.error("Error response de D-ID:", errorText);
    throw new Error(`D-ID API error: ${errorText}`);
  }

  const json = await response.json();
  console.log("Respuesta JSON de D-ID:", json);
  return json;
}

app.post("/generate-video", async (req, res) => {
  console.log(">>> POST /generate-video recibido");
  console.log("Body:", req.body);

  const { text } = req.body;
  if (!text) {
    console.log("Error: texto no proporcionado");
    return res.status(400).json({ error: "Texto requerido" });
  }

  try {
    console.log("Llamando a generateVideo con texto:", text);
    const videoData = await generateVideo(text);
    console.log("Respuesta de D-ID API:", videoData);

    res.json(videoData);
  } catch (error) {
    console.error("Error generando video:", error);
    res.status(500).json({ error: error.message || "Error interno" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor escuchando en http://localhost:${PORT}`));
