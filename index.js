const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const auth = Buffer.from(`${process.env.DID_USERNAME}:${process.env.DID_PASSWORD}`).toString("base64");

const streams = {};

app.post("/create-stream-session", async (req, res) => {
  try {
    const data = {
      source_url: "https://raw.githubusercontent.com/betomacia/imagen-jesus/refs/heads/main/jesus.jpg",
    };

    // 1) Crear la sesión streaming
    const createResponse = await fetch("https://api.d-id.com/talks/streams", {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    });

    if (!createResponse.ok) {
      const errorText = await createResponse.text();
      return res.status(createResponse.status).json({ error: errorText });
    }

    const createJson = await createResponse.json();

    // 2) Obtener offer e ice_servers con GET
    const sdpResponse = await fetch(`https://api.d-id.com/talks/streams/${createJson.id}`, {
      method: "GET",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
    });

    if (!sdpResponse.ok) {
      const errorText = await sdpResponse.text();
      return res.status(sdpResponse.status).json({ error: errorText });
    }

    const sdpJson = await sdpResponse.json();

    // Guardar sesión
    streams[createJson.id] = {
      session_id: createJson.session_id,
      peerConnectionReady: false,
    };

    // Enviar al frontend todos los datos necesarios
    res.json({
      id: createJson.id,
      session_id: createJson.session_id,
      offer: sdpJson.offer,
      ice_servers: sdpJson.ice_servers || [],
    });
  } catch (error) {
    console.error("Error creando stream session:", error);
    res.status(500).json({ error: error.message || "Error interno" });
  }
});

// ... los demás endpoints (SDP answer, ICE candidate, enviar texto) igual que antes
const multer = require("multer");
const { OpenAI } = require("openai");

const upload = multer({ limits: { fileSize: 25 * 1024 * 1024 } }); // máximo 25 MB

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// NUEVO ENDPOINT: /api/transcribe
app.post("/api/transcribe", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No se recibió ningún archivo" });
    }

    const file = new File([req.file.buffer], req.file.originalname || "audio.webm", {
      type: req.file.mimetype || "audio/webm",
    });

    const resp = await openai.audio.transcriptions.create({
      file,
      model: "whisper-1",
    });

    res.json({ text: (resp.text || "").trim() });
  } catch (err) {
    console.error("Error en transcripción:", err);
    res.status(500).json({ error: "Error transcribiendo audio" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
});

