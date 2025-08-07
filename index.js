const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const dotenv = require("dotenv");

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const auth = Buffer.from(`${process.env.DID_USERNAME}:${process.env.DID_PASSWORD}`).toString("base64");

let currentSessionId = null;

// Crear sesión de streaming
app.post("/create-stream-session", async (req, res) => {
  try {
    console.log("POST /create-stream-session recibido");

    const data = {
      source_url: "https://raw.githubusercontent.com/betomacia/imagen-jesus/refs/heads/main/jesus.jpg",
      voice: {
        provider: "microsoft",
        voice_id: "es-ES-AlvaroNeural"
      }
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
      const errText = await response.text();
      console.error("Error respuesta D-ID API:", errText);
      return res.status(response.status).json({ error: errText });
    }

    const json = await response.json();
    currentSessionId = json.session_id;
    console.log("Streaming session creada con session_id:", currentSessionId);

    res.json({ sessionId: currentSessionId });
  } catch (error) {
    console.error("Error creando sesión streaming:", error);
    res.status(500).json({ error: "Error interno" });
  }
});

// Enviar texto a la sesión streaming para que hable Jesús
app.post("/send-message", async (req, res) => {
  const { sessionId, text } = req.body;

  if (!sessionId || !text) {
    return res.status(400).json({ error: "sessionId y text son requeridos" });
  }

  try {
    console.log(`POST /send-message recibido para sessionId: ${sessionId} texto: ${text}`);

    const data = {
      text,
      voice: {
        provider: "microsoft",
        voice_id: "es-ES-AlvaroNeural"
      }
    };

    const response = await fetch(`https://api.d-id.com/talks/streams/${sessionId}`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("Error respuesta D-ID API:", errText);
      return res.status(response.status).json({ error: errText });
    }

    const json = await response.json();
    console.log("Mensaje enviado correctamente a la sesión streaming");
    res.json(json);
  } catch (error) {
    console.error("Error enviando mensaje streaming:", error);
    res.status(500).json({ error: "Error interno" });
  }
});

// Opcional: info de sesión streaming (puede ayudar en debugging)
app.get("/stream-url/:sessionId", async (req, res) => {
  const { sessionId } = req.params;

  try {
    const response = await fetch(`https://api.d-id.com/talks/streams/${sessionId}`, {
      headers: {
        Authorization: `Basic ${auth}`,
      },
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({ error: errText });
    }

    const json = await response.json();
    res.json(json);
  } catch (error) {
    res.status(500).json({ error: "Error interno" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor escuchando en http://localhost:${PORT}`));
