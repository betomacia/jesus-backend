// index.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const auth = Buffer.from(`${process.env.DID_USERNAME}:${process.env.DID_PASSWORD}`).toString("base64");

// Crear sesión streaming
app.post("/create-session", async (req, res) => {
  try {
    const data = {
      source_url: "https://raw.githubusercontent.com/betomacia/imagen-jesus/refs/heads/main/jesus.jpg",
      config: {
        mode: "talk",
      },
    };
    const response = await fetch("https://api.d-id.com/live-stream/sessions", {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    });
    if (!response.ok) {
      const text = await response.text();
      return res.status(500).json({ error: text });
    }
    const session = await response.json();
    res.json(session);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// Enviar texto para que avatar hable en sesión
app.post("/talk/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const { text } = req.body;

  if (!text) return res.status(400).json({ error: "Texto requerido" });

  try {
    const data = {
      script: {
        type: "text",
        input: text,
        provider: { type: "microsoft", voice_id: "es-ES-AlvaroNeural" },
      },
    };
    const response = await fetch(`https://api.d-id.com/live-stream/sessions/${sessionId}/talk`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    });
    if (!response.ok) {
      const textError = await response.text();
      return res.status(500).json({ error: textError });
    }
    const talk = await response.json();
    res.json(talk);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend escuchando en http://localhost:${PORT}`));
