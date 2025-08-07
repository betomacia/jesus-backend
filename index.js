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
  console.log("POST /create-stream-session recibido");
  console.log("Datos recibidos para crear sesión:", req.body);

  const { source_url, voice_id } = req.body;

  if (!source_url) {
    console.error("Error: 'source_url' es obligatorio");
    return res.status(400).json({ error: "'source_url' es obligatorio" });
  }

  const data = {
    source_url,
    voice_id: voice_id || "es-ES-AlvaroNeural",
  };

  try {
    console.log("Enviando petición para crear sesión de streaming a D-ID con data:", data);

    const response = await fetch("https://api.d-id.com/talks/streams", {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    });

    console.log("Respuesta D-ID status:", response.status);

    const responseData = await response.json();

    if (!response.ok) {
      console.error("Error respuesta D-ID API:", JSON.stringify(responseData));
      return res.status(response.status).json(responseData);
    }

    console.log("Respuesta D-ID API exitosa:", JSON.stringify(responseData));

    res.json(responseData);

  } catch (error) {
    console.error("Error creando sesión:", error);
    res.status(500).json({ error: error.message || "Error interno" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor escuchando en http://localhost:${PORT}`));
