import express from "express";
import cors from "cors";
import fetch from "node-fetch"; // si no tienes instalado, corre: npm install node-fetch

const app = express();
app.use(cors());
app.use(express.json());

const DID_USERNAME = process.env.DID_USERNAME;
const DID_PASSWORD = process.env.DID_PASSWORD;
const auth = Buffer.from(`${DID_USERNAME}:${DID_PASSWORD}`).toString("base64");

app.post("/generate-video", async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "El texto es requerido" });

  const data = {
    source_url: "https://raw.githubusercontent.com/betomacia/imagen-jesus/main/ojos%202.png", // tu imagen pública
    script: {
      type: "text",
      input: text,
      provider: {
        type: "microsoft",
        voice_id: "es-ES-AlvaroNeural"
      },
      ssml: false
    },
    config: {
      stitch: true
    }
  };

  try {
    const response = await fetch("https://api.d-id.com/talks", {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(data)
    });

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({ error: `D-ID error: ${errorText}` });
    }

    const json = await response.json();
    res.json(json);

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor escuchando en puerto ${PORT}`));
