const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const auth = Buffer.from(`${process.env.DID_USERNAME}:${process.env.DID_PASSWORD}`).toString("base64");

// Crear sesión de streaming en D-ID
app.post("/create-stream-session", async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "Texto requerido" });

  try {
    console.log("POST /create-stream-session recibido con texto:", text);

    const data = {
      source_url: "https://raw.githubusercontent.com/betomacia/imagen-jesus/refs/heads/main/jesus.jpg",
      script: {
        type: "text",
        input: text,
        provider: { type: "microsoft", voice_id: "es-ES-AlvaroNeural" },
        ssml: false,
      },
      config: {
        stitch: true,
        // live streaming config: para crear sesión de streaming en D-ID
        type: "stream",
      },
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
      console.error("Error creando sesión:", errorText);
      return res.status(response.status).json({ error: errorText });
    }

    const json = await response.json();
    console.log("Sesión streaming creada:", json);

    res.json(json);
  } catch (error) {
    console.error("Error en create-stream-session:", error);
    res.status(500).json({ error: error.message || "Error interno" });
  }
});

// Enviar texto para que sesión active la respuesta (usar en frontend para enviar nuevas frases)
app.post("/stream/send-text", async (req, res) => {
  const { talkId, text } = req.body;
  if (!talkId || !text)
    return res.status(400).json({ error: "talkId y text son requeridos" });

  try {
    console.log(`POST /stream/send-text para talkId: ${talkId} con texto: ${text}`);

    const data = {
      script: {
        type: "text",
        input: text,
        provider: { type: "microsoft", voice_id: "es-ES-AlvaroNeural" },
        ssml: false,
      },
    };

    const response = await fetch(`https://api.d-id.com/talks/streams/${talkId}/script`, {
      method: "PUT",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Error enviando texto a sesión:", errorText);
      return res.status(response.status).json({ error: errorText });
    }

    const json = await response.json();
    console.log("Texto enviado a sesión:", json);

    res.json(json);
  } catch (error) {
    console.error("Error en stream/send-text:", error);
    res.status(500).json({ error: error.message || "Error interno" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Servidor escuchando en http://localhost:${PORT}`)
);
