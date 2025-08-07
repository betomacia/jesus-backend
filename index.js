import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();

// Configurar CORS para aceptar todas las peticiones y manejar OPTIONS
app.use(cors({
  origin: "*", // Puedes cambiarlo por el dominio que uses si quieres más seguridad
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

// Middleware para manejar preflight OPTIONS en todas las rutas
app.options("*", cors());

app.use(express.json());

const auth = Buffer.from(`${process.env.DID_USERNAME}:${process.env.DID_PASSWORD}`).toString("base64");

async function generateVideo(text) {
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
    throw new Error(`D-ID API error: ${errorText}`);
  }

  return await response.json();
}

app.post("/generate-video", async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "Texto requerido" });

  try {
    const videoData = await generateVideo(text);
    res.json(videoData);
  } catch (error) {
    console.error("Error generating video:", error);
    res.status(500).json({ error: error.message || "Error interno" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor escuchando en http://localhost:${PORT}`));
