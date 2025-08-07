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
  try {
    console.log("Datos recibidos para crear sesión:", req.body);

    const response = await fetch("https://api.d-id.com/talks/streams", {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(req.body),
    });

    console.log("Respuesta D-ID status:", response.status);

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Error respuesta D-ID API:", errorText);
      return res.status(500).json({ error: errorText });
    }

    const data = await response.json();
    console.log("Sesión creada con éxito:", data);

    res.json(data);
  } catch (error) {
    console.error("Error creando sesión:", error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor escuchando en http://localhost:${PORT}`));
