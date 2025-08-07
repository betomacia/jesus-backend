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
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "Texto requerido" });

  console.log("POST /create-stream-session recibido");
  console.log("Texto recibido:", text);

  try {
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

    const response = await fetch("https://api.d-id.com/talks/streams", {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Error respuesta D-ID API:", errorText);
      return res.status(response.status).json({ error: errorText });
    }

    const json = await response.json();

    console.log("Respuesta D-ID API:", json);
    res.json(json);
  } catch (error) {
    console.error("Error creando sesión streaming:", error);
    res.status(500).json({ error: error.message || "Error interno" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor escuchando en http://localhost:${PORT}`));
