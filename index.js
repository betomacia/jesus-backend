const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const DID_API_KEY = process.env.DID_API_KEY; // tu clave API base64 o usuario:password base64
const AUTH_HEADER = `Basic ${Buffer.from(DID_API_KEY).toString("base64")}`;

app.post("/stream/create-session", async (req, res) => {
  try {
    console.log("Crear sesión streaming");

    const data = {
      source_url: "https://raw.githubusercontent.com/betomacia/imagen-jesus/refs/heads/main/jesus.jpg",
    };

    const response = await fetch("https://api.d-id.com/talks/streams", {
      method: "POST",
      headers: {
        Authorization: AUTH_HEADER,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Error crear sesión streaming:", errorText);
      return res.status(response.status).json({ error: errorText });
    }

    const json = await response.json();
    console.log("Sesión streaming creada:", json);

    // Retornamos id, session_id, offer y ice_servers para frontend
    res.json(json);
  } catch (error) {
    console.error("Error general crear sesión:", error);
    res.status(500).json({ error: error.message });
  }
});

// Recibir SDP answer del cliente
app.post("/stream/:streamId/sdp", async (req, res) => {
  const { streamId } = req.params;
  const { answer, session_id } = req.body;

  if (!answer || !session_id)
    return res.status(400).json({ error: "answer y session_id son requeridos" });

  try {
    const response = await fetch(`https://api.d-id.com/talks/streams/${streamId}/sdp`, {
      method: "POST",
      headers: {
        Authorization: AUTH_HEADER,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ answer, session_id }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Error enviar SDP answer:", errorText);
      return res.status(response.status).json({ error: errorText });
    }

    const json = await response.json();
    console.log("SDP answer enviado OK:", json);
    res.json(json);
  } catch (error) {
    console.error("Error general SDP answer:", error);
    res.status(500).json({ error: error.message });
  }
});

// Recibir ICE candidates
app.post("/stream/:streamId/ice", async (req, res) => {
  const { streamId } = req.params;
  const { candidate, sdpMid, sdpMLineIndex, session_id } = req.body;

  if (!candidate || !session_id)
    return res.status(400).json({ error: "candidate y session_id son requeridos" });

  try {
    const response = await fetch(`https://api.d-id.com/talks/streams/${streamId}/ice`, {
      method: "POST",
      headers: {
        Authorization: AUTH_HEADER,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ candidate, sdpMid, sdpMLineIndex, session_id }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Error enviar ICE candidate:", errorText);
      return res.status(response.status).json({ error: errorText });
    }

    res.json({ ok: true });
  } catch (error) {
    console.error("Error general ICE candidate:", error);
    res.status(500).json({ error: error.message });
  }
});

// Crear un "talk" en streaming para que hable Jesús
app.post("/stream/:streamId/talk", async (req, res) => {
  const { streamId } = req.params;
  const { session_id, text } = req.body;

  if (!session_id || !text)
    return res.status(400).json({ error: "session_id y text son requeridos" });

  try {
    const data = {
      session_id,
      script: {
        type: "text",
        input: text,
        provider: { type: "microsoft", voice_id: "es-ES-AlvaroNeural" },
        ssml: false,
      },
      config: { stitch: false },
    };

    const response = await fetch(`https://api.d-id.com/talks/streams/${streamId}`, {
      method: "POST",
      headers: {
        Authorization: AUTH_HEADER,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Error crear talk stream:", errorText);
      return res.status(response.status).json({ error: errorText });
    }

    const json = await response.json();
    console.log("Talk stream creado:", json);
    res.json(json);
  } catch (error) {
    console.error("Error general crear talk stream:", error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor escuchando en http://localhost:${PORT}`));
