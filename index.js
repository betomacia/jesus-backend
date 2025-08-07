import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const auth = Buffer.from(`${process.env.DID_USERNAME}:${process.env.DID_PASSWORD}`).toString("base64");

// Guardamos sesiones activas con sus peer connections (opcional si usas almacenamiento)
const sessions = new Map();

app.post("/create-stream-session", async (req, res) => {
  try {
    const response = await fetch("https://api.d-id.com/talks/streams", {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        source_url: "https://raw.githubusercontent.com/betomacia/imagen-jesus/refs/heads/main/jesus.jpg",
        voice: {
          provider: "microsoft",
          voice_id: "es-ES-AlvaroNeural",
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({ error: errorText });
    }

    const data = await response.json();
    sessions.set(data.id, {}); // Puedes guardar info adicional si quieres
    console.log("Stream session creada:", data.id);
    res.json(data);
  } catch (err) {
    console.error("Error creando sesión de streaming:", err);
    res.status(500).json({ error: "Error interno" });
  }
});

app.post("/signal/offer", async (req, res) => {
  const { session_id, offer } = req.body;
  try {
    const response = await fetch(`https://api.d-id.com/talks/streams/${session_id}/offer`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ offer }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({ error: errorText });
    }

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error("Error en /signal/offer:", err);
    res.status(500).json({ error: "Error interno" });
  }
});

app.post("/signal/ice", async (req, res) => {
  const { session_id, candidate } = req.body;
  try {
    const response = await fetch(`https://api.d-id.com/talks/streams/${session_id}/ice-candidate`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ candidate }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({ error: errorText });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Error en /signal/ice:", err);
    res.status(500).json({ error: "Error interno" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor escuchando en http://localhost:${PORT}`));
