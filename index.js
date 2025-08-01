const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// Reemplaza tu clave D-ID codificada base64 aquí
const DID_AUTH = Buffer.from("Y2VjdGVsZXZpc2lvbkBnbWFpbC5jb20:OQb1VbC-NsJH40EtsnAaW").toString("base64");

app.post("/generar-video", async (req, res) => {
  const { mensaje } = req.body;

  if (!mensaje) {
    return res.status(400).json({ error: "Mensaje requerido" });
  }

  try {
    const respuesta = await axios.post(
      "https://api.d-id.com/talks",
      {
        script: {
          type: "text",
          subtitles: false,
          provider: { type: "microsoft", voice_id: "es-ES-AlvaroNeural" },
          ssml: false,
          input: mensaje
        },
        config: {
          fluent: true,
          pad_audio: 0.5,
          stitch: true
        },
        source_url: "https://d-id-public-bucket.s3.amazonaws.com/demo-assets/jesus-avatar.jpg"
      },
      {
        headers: {
          "Authorization": `Basic ${DID_AUTH}`,
          "Content-Type": "application/json"
        }
      }
    );

    const resultUrl = respuesta.data?.result_url || null;

    if (!resultUrl) {
      return res.status(500).json({ error: "No se recibió URL de video" });
    }

    res.json({ result_url: resultUrl });

  } catch (error) {
    console.error("❌ Error al generar el video:", error.message);

    return res.status(500).json({
      error: "Error generando el video",
      details: error.response?.data?.message || error.message || "Error desconocido"
    });
  }
});

app.listen(8080, () => {
  console.log("✅ Servidor corriendo en el puerto 8080");
});
