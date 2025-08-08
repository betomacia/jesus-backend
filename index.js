const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const auth = Buffer.from(`${process.env.DID_USERNAME}:${process.env.DID_PASSWORD}`).toString("base64");

let activeSessions = {}; // Para controlar sesiones activas y su tiempo

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
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(500).json({ error: `Error creando sesión: ${text}` });
    }

    const data = await response.json();
    // Guardar info de sesión activa con timestamp actual
    activeSessions[data.streamId] = { lastActivity: Date.now() };

    return res.json({
      streamId: data.id,
      sessionId: data.session_id,
      offer: data.offer,
      iceServers: data.ice_servers,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Error interno" });
  }
});

app.post("/sdp", async (req, res) => {
  const { answer, sessionId, streamId } = req.body;
  if (!answer || !sessionId || !streamId)
    return res.status(400).json({ error: "Faltan datos para SDP" });

  try {
    // Actualizar actividad
    if (activeSessions[streamId]) activeSessions[streamId].lastActivity = Date.now();

    const response = await fetch(`https://api.d-id.com/talks/streams/${streamId}/sdp`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        answer,
        session_id: sessionId,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(500).json({ error: `Error enviando SDP: ${text}` });
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message || "Error interno" });
  }
});

app.post("/ice", async (req, res) => {
  const { candidate, sdpMid, sdpMLineIndex, sessionId, streamId } = req.body;
  if (!candidate || !sessionId || !streamId)
    return res.status(400).json({ error: "Faltan datos para ICE" });

  try {
    // Actualizar actividad
    if (activeSessions[streamId]) activeSessions[streamId].lastActivity = Date.now();

    const response = await fetch(`https://api.d-id.com/talks/streams/${streamId}/ice`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        candidate,
        sdpMid,
        sdpMLineIndex,
        session_id: sessionId,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(500).json({ error: `Error enviando ICE: ${text}` });
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message || "Error interno" });
  }
});

app.post("/talks-stream", async (req, res) => {
  const { streamId, sessionId, text } = req.body;
  if (!streamId || !sessionId || !text)
    return res.status(400).json({ error: "Faltan datos para enviar texto" });

  try {
    // Actualizar actividad
    if (activeSessions[streamId]) activeSessions[streamId].lastActivity = Date.now();

    const response = await fetch(`https://api.d-id.com/talks/streams/${streamId}`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        session_id: sessionId,
        text,
      }),
    });

    if (!response.ok) {
      const textErr = await response.text();
      return res.status(500).json({ error: `Error enviando texto: ${textErr}` });
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message || "Error interno" });
  }
});

// Opcional: cerrar sesión explícitamente (cuando usuario termine conversación)
app.delete("/end-stream-session", async (req, res) => {
  const { streamId, sessionId } = req.body;
  if (!streamId || !sessionId)
    return res.status(400).json({ error: "Faltan datos para cerrar sesión" });

  try {
    delete activeSessions[streamId];
    const response = await fetch(`https://api.d-id.com/talks/streams/${streamId}`, {
      method: "DELETE",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ session_id: sessionId }),
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(500).json({ error: `Error cerrando sesión: ${text}` });
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message || "Error interno" });
  }
});

// Opcional: limpiar sesiones inactivas después de 5 min (ejemplo)
setInterval(() => {
  const now = Date.now();
  for (const id in activeSessions) {
    if (now - activeSessions[id].lastActivity > 5 * 60 * 1000) {
      console.log(`Cerrando sesión inactiva: ${id}`);
      delete activeSessions[id];
      // Aquí puedes hacer DELETE a la API D-ID si quieres cerrar también en D-ID
    }
  }
}, 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor escuchando en http://localhost:${PORT}`));
