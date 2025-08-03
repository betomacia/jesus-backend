import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { generateVideo, getClipStatus } from "./generateVideo.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Endpoint para generar video a partir de texto
app.post("/generate-video", async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "El texto es requerido" });

  try {
    const videoData = await generateVideo(text);
    res.json(videoData);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Endpoint para consultar estado del video generado
app.get("/clip-status/:id", async (req, res) => {
  const clipId = req.params.id;
  try {
    const status = await getClipStatus(clipId);
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor escuchando en puerto ${PORT}`));
