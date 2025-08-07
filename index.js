import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
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

  // Crear video
  const createResponse = await fetch("https://api.d-id.com/talks", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  });

  if (!createResponse.ok) {
    const errorText = await createResponse.text();
    throw new Error(`D-ID API error (crear): ${errorText}`);
  }

  const createJson = await createResponse.json();
  const talkId = createJson.id;

  // Polling para esperar que el video esté listo
  let status = "";
  let videoUrl = "";

  while (status !== "done") {
    await new Promise((r) => setTimeout(r, 3000)); // esperar 3 segundos

    const statusResponse = await fetch(`https://api.d-id.com/talks/${talkId}`, {
      headers: { Authorization: `Basic ${auth}` },
    });

    if (!statusResponse.ok) {
      const errorText = await statusResponse.text();
      throw new Error(`D-ID API error (status): ${errorText}`);
    }

    const statusJson = await statusResponse.json();
    status = statusJson.status;

    if (status === "done") {
      videoUrl = statusJson.result_url;
    } else if (status === "failed") {
      throw new Error("Falló la generación del video");
    }
  }

  return { id: talkId, status, result_url: videoUrl, text };
}

app.post("/generate-video", async (req, res) => {
  const { text } = req.body;

  if (!text) {
    return res.status(400).json({ error: "Texto requerido" });
  }

  try {
    console.log("POST /generate-video recibido con body:", req.body);

    const videoData = await generateVideo(text);

    console.log("Video generado con éxito:", videoData);

    res.json(videoData);
  } catch (error) {
    console.error("Error generating video:", error);
    res.status(500).json({ error: error.message || "Error interno" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor escuchando en http://localhost:${PORT}`));
