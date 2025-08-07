import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

const auth = Buffer.from(`${process.env.DID_USERNAME}:${process.env.DID_PASSWORD}`).toString("base64");

app.post("/create-stream-session", async (req, res) => {
  const { text, source_url, voice_id } = req.body;
  console.log("POST /create-stream-session recibido");
  console.log("Datos recibidos para crear sesión:", req.body);

  if (!source_url) {
    console.error("Error: 'source_url' es obligatorio");
    return res.status(400).json({ error: "'source_url' es obligatorio" });
  }

  const data = {
    source_url,
    script: {
      type: "text",
      input: text || "",
      provider: { type: "microsoft", voice_id: voice_id || "es-ES-AlvaroNeural" },
      ssml: false,
    },
  };

  try {
    const response = await fetch("https://api.d-id.com/talks/streams", {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    });

    console.log("Respuesta D-ID status:", response.status);

    if (!response.ok) {
      const errorJson = await response.json();
      console.error("Error respuesta D-ID API:", JSON.stringify(errorJson));
      return res.status(response.status).json(errorJson);
    }

    const json = await response.json();
    console.log("Sesión creada exitosamente:", json);

    res.json(json);
  } catch (error) {
    console.error("Error creando sesión de streaming:", error);
    res.status(500).json({ error: error.message || "Error interno" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor escuchando en http://localhost:${PORT}`));
