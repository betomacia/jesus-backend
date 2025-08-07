import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const auth = Buffer.from(`${process.env.DID_USERNAME}:${process.env.DID_PASSWORD}`).toString("base64");

// Crear sesión Live Streaming
app.post("/create-stream-session", async (req, res) => {
  try {
    const response = await fetch("https://api.d-id.com/live-stream/sessions", {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        source_url: "https://raw.githubusercontent.com/betomacia/imagen-jesus/refs/heads/main/jesus.jpg",
        voice: { provider: "microsoft", voice_id: "es-ES-AlvaroNeural" },
        lip_sync: true,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({ error: errorText });
    }

    const data = await response.json();
    console.log("Sesión de streaming creada:", data);
    res.json(data); // Enviamos data con id, stream_url, etc.
  } catch (error) {
    console.error("Error creando sesión streaming:", error);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// Enviar texto a sesión streaming para hablar en tiempo real
app.post("/send-text", async (req, res) => {
  const { session_id, text } = req.body;
  if (!session_id || !text) return res.status(400).json({ error: "session_id y text son requeridos" });

  try {
    const response = await fetch(`https://api.d-id.com/live-stream/sessions/${session_id}/talks`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
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
      return res.status(response.status).json({ error: errorText });
    }

    const data = await response.json();
    console.log("Texto enviado a sesión streaming:", data);
    res.json(data);
  } catch (error) {
    console.error("Error enviando texto a streaming:", error);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor escuchando en http://localhost:${PORT}`));
