// index.js
require('dotenv').config();

console.log("DID_USERNAME:", process.env.DID_USERNAME ? "✅ definido" : "❌ no definido");
console.log("DID_PASSWORD:", process.env.DID_PASSWORD ? "✅ definido" : "❌ no definido");

const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();

const corsOptions = {
  origin: "*", // Cambia a tu dominio frontend para mayor seguridad
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};
app.use(cors(corsOptions));
app.use(express.json());

const auth = Buffer.from(`${process.env.DID_USERNAME}:${process.env.DID_PASSWORD}`).toString("base64");

async function generateVideo(text) {
  console.log("Enviando petición a D-ID con texto:", text);

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

  const response = await fetch("https://api.d-id.com/talks", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("Error en API D-ID:", errorText);
    throw new Error(`D-ID API error: ${errorText}`);
  }

  const json = await response.json();
  console.log("Respuesta D-ID API:", json);
  return json;
}

async function pollTalkStatus(talkId) {
  let status = "";
  let attempts = 0;
  while (status !== "done" && attempts < 60) { // max 60 intentos ~5 min
    attempts++;
    console.log(`Intento #${attempts} para talkId ${talkId}`);

    const res = await fetch(`https://api.d-id.com/talks/${talkId}`, {
      headers: { Authorization: `Basic ${auth}` },
    });

    if (!res.ok) {
      const errorText = await res.text();
      console.error(`Error consultando estado video: ${res.status} ${errorText}`);
      throw new Error(`Error consultando estado video: ${res.status} ${errorText}`);
    }

    const json = await res.json();
    status = json.status;
    console.log(`Estado actual de talkId ${talkId}: ${status}`);

    if (status === "done") {
      console.log(`Video listo para talkId ${talkId}, URL: ${json.result_url}`);
      return json.result_url;
    }

    if (status === "failed") {
      throw new Error("Falló la generación del video");
    }

    await new Promise((r) => setTimeout(r, 5000)); // espera 5 seg
  }

  throw new Error("Timeout esperando video listo");
}

app.post("/generate-video", async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "Texto requerido" });

  try {
    console.log("POST /generate-video recibido con body:", req.body);

    const talkData = await generateVideo(text);

    const videoUrl = await pollTalkStatus(talkData.id);

    res.json({
      videoUrl,
      text,
    });
  } catch (error) {
    console.error("Error generando video:", error);
    res.status(500).json({ error: error.message || "Error interno" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
  setInterval(() => console.log("Servidor vivo... " + new Date().toISOString()), 60000);
});
