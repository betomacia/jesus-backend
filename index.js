import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { generateVideo, getClipStatus } from "./generateVideo.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

app.post("/generate-video", async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "El texto es requerido" });

  try {
    const videoData = await generateVideo(text);
    return res.json(videoData);
  } catch (error) {
    console.error("Error en /generate-video:", error);
    return res.status(500).json({ error: "Error al generar video." });
  }
});

app.get("/clip-status/:id", async (req, res) => {
  const clipId = req.params.id;
  if (!clipId) return res.status(400).json({ error: "ID es requerido" });

  try {
    const status = await getClipStatus(clipId);
    return res.json(status);
  } catch (error) {
    console.error("Error en /clip-status:", error);
    return res.status(500).json({ error: "Error al consultar estado del clip." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor escuchando en puerto ${PORT}`));
