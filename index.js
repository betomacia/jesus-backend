import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const auth = Buffer.from(`${process.env.DID_USERNAME}:${process.env.DID_PASSWORD}`).toString("base64");

app.post("/generate-video", async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "Texto requerido" });

  const data = {
    source_url: "https://raw.githubusercontent.com/betomacia/imagen-jesus/main/ojos%202.png",
    script: {
      type: "text",
      input: text,
      provider: { type: "microsoft", voice_id: "es-ES-AlvaroNeural" },
      ssml: false,
    },
    config: { stitch: true },
  };

  try {
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
      return res.status(response.status).json({ error: errorText });
    }

    const json = await response.json();
    return res.json(json);
  } catch (error) {
    // Evitar pasar objetos circulares al JSON de error
    const safeError = {
      message: error.message,
      stack: error.stack,
    };
    return res.status(500).json({ error: safeError });
  }
});

app.get("/talk-status/:id", async (req, res) => {
  const talkId = req.params.id;

  try {
    const response = await fetch(`https://api.d-id.com/talks/${talkId}`, {
      headers: { Authorization: `Basic ${auth}` },
    });

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({ error: errorText });
    }

    const json = await response.json();
    return res.json(json);
  } catch (error) {
    const safeError = {
      message: error.message,
      stack: error.stack,
    };
    return res.status(500).json({ error: safeError });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor escuchando en puerto ${PORT}`));
