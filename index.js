import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

const auth = Buffer.from(`${process.env.DID_USERNAME}:${process.env.DID_PASSWORD}`).toString("base64");

// Función para hacer polling internamente en backend con logs
async function pollTalkStatus(talkId) {
  let status = "";
  let attempts = 0;
  console.log(`Iniciando polling para talkId: ${talkId}`);

  while (status !== "done") {
    attempts++;
    console.log(`Intento #${attempts} para talkId ${talkId}`);

    const res = await fetch(`https://api.d-id.com/talks/${talkId}`, {
      headers: { Authorization: `Basic ${auth}` },
    });

    if (!res.ok) {
      const errorText = await res.text();
      console.error(`Error consultando estado de video (status ${res.status}): ${errorText}`);
      throw new Error(`Error consultando estado de video: ${res.status} ${errorText}`);
    }

    const json = await res.json();
    status = json.status;
    console.log(`Estado actual de talkId ${talkId}: ${status}`);

    if (status === "done") {
      console.log(`Video listo para talkId ${talkId}, URL: ${json.result_url}`);
      return json.result_url;
    }
    if (status === "failed") {
      console.error(`Generación de video fallida para talkId ${talkId}`);
      throw new Error("Falló la generación del video");
    }

    // Espera 5 segundos antes del siguiente intento
    await new Promise((r) => setTimeout(r, 5000));
  }
}

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

  console.log("Enviando petición para crear charla a D-ID con texto:", text);

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
    console.error("Error al crear charla en D-ID:", errorText);
    throw new Error(`D-ID API error: ${errorText}`);
  }

  const json = await response.json();
  console.log("Charla creada con ID:", json.id);
  return json;
}

app.post("/generate-video", async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "Texto requerido" });

  try {
    console.log("POST /generate-video recibido con body:", req.body);

    // Crear charla
    const talkData = await generateVideo(text);

    // Polling para obtener el video listo
    const videoUrl = await pollTalkStatus(talkData.id);

    // Responder con URL y texto
    res.json({
      videoUrl,
      text,
    });
  } catch (error) {
    console.error("Error generando video:", error);
    res.status(500).json({ error: error.message || "Error interno" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor escuchando en http://localhost:${PORT}`));
