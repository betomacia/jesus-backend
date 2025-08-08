// index.js
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const auth = Buffer.from(`${process.env.DID_USERNAME}:${process.env.DID_PASSWORD}`).toString("base64");

// Guardamos el estado de cada stream en memoria (por simplicidad)
const streams = {};

// Crear sesión streaming - POST /create-stream-session
app.post("/create-stream-session", async (req, res) => {
  try {
    const data = {
      source_url: "https://raw.githubusercontent.com/betomacia/imagen-jesus/refs/heads/main/jesus.jpg",
    };

    const response = await fetch("https://api.d-id.com/talks/streams", {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({ error: errorText });
    }

    const json = await response.json();

    // Guardar datos de sesión para este streamId
    streams[json.id] = {
      session_id: json.session_id,
      peerConnectionReady: false,
    };

    res.json(json);
  } catch (error) {
    console.error("Error creando stream session:", error);
    res.status(500).json({ error: error.message || "Error interno" });
  }
});

// Recibir SDP answer - POST /talks/streams/:streamId/sdp
app.post("/talks/streams/:streamId/sdp", async (req, res) => {
  try {
    const streamId = req.params.streamId;
    const { answer, session_id } = req.body;

    if (!streams[streamId]) return res.status(404).json({ error: "Stream no encontrado" });

    const response = await fetch(`https://api.d-id.com/talks/streams/${streamId}/sdp`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ answer, session_id }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({ error: errorText });
    }

    streams[streamId].peerConnectionReady = true;

    res.json({ message: "SDP answer enviada correctamente" });
  } catch (error) {
    console.error("Error enviando SDP answer:", error);
    res.status(500).json({ error: error.message || "Error interno" });
  }
});

// Recibir ICE candidate - POST /talks/streams/:streamId/ice
app.post("/talks/streams/:streamId/ice", async (req, res) => {
  try {
    const streamId = req.params.streamId;
    const { candidate, sdpMid, sdpMLineIndex, session_id } = req.body;

    if (!streams[streamId]) return res.status(404).json({ error: "Stream no encontrado" });

    const response = await fetch(`https://api.d-id.com/talks/streams/${streamId}/ice`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ candidate, sdpMid, sdpMLineIndex, session_id }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({ error: errorText });
    }

    res.json({ message: "ICE candidate enviado correctamente" });
  } catch (error) {
    console.error("Error enviando ICE candidate:", error);
    res.status(500).json({ error: error.message || "Error interno" });
  }
});

// Enviar texto para que el avatar hable - POST /talks/streams/:streamId
app.post("/talks/streams/:streamId", async (req, res) => {
  try {
    const streamId = req.params.streamId;
    const { session_id, script } = req.body;

    if (!streams[streamId]) return res.status(404).json({ error: "Stream no encontrado" });

    const data = {
      session_id,
      script,
      config: { stitch: true },
    };

    const response = await fetch(`https://api.d-id.com/talks/streams/${streamId}`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({ error: errorText });
    }

    const json = await response.json();

    res.json(json);
  } catch (error) {
    console.error("Error enviando texto para hablar:", error);
    res.status(500).json({ error: error.message || "Error interno" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
});
