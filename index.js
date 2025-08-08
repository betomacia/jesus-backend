const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json());

const auth = Buffer.from(`${process.env.DID_USERNAME}:${process.env.DID_PASSWORD}`).toString("base64");

// Crear sesión de streaming (POST /create-stream-session)
app.post("/create-stream-session", async (req, res) => {
  try {
    console.log("POST /create-stream-session recibido", req.body);

    const response = await fetch("https://api.d-id.com/talks/streams", {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        source_url: "https://raw.githubusercontent.com/betomacia/imagen-jesus/main/jesus.jpg",
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Error creando sesión:", errorText);
      return res.status(response.status).json({ error: errorText });
    }

    const json = await response.json();
    console.log("Sesión creada:", json);
    res.json(json);
  } catch (error) {
    console.error("Error en /create-stream-session:", error);
    res.status(500).json({ error: error.message });
  }
});

// Recibir SDP answer del cliente (POST /streams/:streamId/sdp)
app.post("/streams/:streamId/sdp", async (req, res) => {
  try {
    const streamId = req.params.streamId;
    const { answer, session_id } = req.body;

    console.log(`POST /streams/${streamId}/sdp recibido`, req.body);

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
      console.error("Error enviando SDP answer:", errorText);
      return res.status(response.status).json({ error: errorText });
    }

    const json = await response.json();
    console.log("SDP answer aceptado:", json);
    res.json(json);
  } catch (error) {
    console.error("Error en /streams/:streamId/sdp:", error);
    res.status(500).json({ error: error.message });
  }
});

// Recibir ICE candidates (POST /streams/:streamId/ice)
app.post("/streams/:streamId/ice", async (req, res) => {
  try {
    const streamId = req.params.streamId;
    const { candidate, sdpMid, sdpMLineIndex, session_id } = req.body;

    console.log(`POST /streams/${streamId}/ice recibido`, req.body);

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
      console.error("Error enviando ICE candidate:", errorText);
      return res.status(response.status).json({ error: errorText });
    }

    const json = await response.json();
    res.json(json);
  } catch (error) {
    console.error("Error en /streams/:streamId/ice:", error);
    res.status(500).json({ error: error.message });
  }
});

// Crear talk stream (POST /streams/:streamId/talk)
app.post("/streams/:streamId/talk", async (req, res) => {
  try {
    const streamId = req.params.streamId;
    const { session_id, text } = req.body;

    console.log(`POST /streams/${streamId}/talk recibido`, req.body);

    const response = await fetch(`https://api.d-id.com/talks/streams/${streamId}`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        session_id,
        script: {
          type: "text",
          input: text,
          provider: { type: "microsoft", voice_id: "es-ES-AlvaroNeural" },
          ssml: false,
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Error creando talk stream:", errorText);
      return res.status(response.status).json({ error: errorText });
    }

    const json = await response.json();
    res.json(json);
  } catch (error) {
    console.error("Error en /streams/:streamId/talk:", error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
});
