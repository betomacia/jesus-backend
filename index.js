const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const DID_API_KEY = process.env.DID_API_KEY || ""; // Tu API key de D-ID
const AUTH_HEADER = `Basic ${Buffer.from(DID_API_KEY + ":").toString("base64")}`;

app.post("/create-stream-session", async (req, res) => {
  try {
    const response = await fetch("https://api.d-id.com/talks/streams", {
      method: "POST",
      headers: {
        Authorization: AUTH_HEADER,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        source_url:
          "https://raw.githubusercontent.com/betomacia/imagen-jesus/refs/heads/main/jesus.jpg",
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).send(text);
    }

    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/streams/:streamId/sdp", async (req, res) => {
  const { streamId } = req.params;
  try {
    const response = await fetch(`https://api.d-id.com/talks/streams/${streamId}/sdp`, {
      method: "POST",
      headers: {
        Authorization: AUTH_HEADER,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(req.body),
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).send(text);
    }

    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/streams/:streamId/ice", async (req, res) => {
  const { streamId } = req.params;
  try {
    const response = await fetch(`https://api.d-id.com/talks/streams/${streamId}/ice`, {
      method: "POST",
      headers: {
        Authorization: AUTH_HEADER,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(req.body),
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).send(text);
    }

    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/streams/:streamId/start", async (req, res) => {
  const { streamId } = req.params;
  try {
    const response = await fetch(`https://api.d-id.com/talks/streams/${streamId}`, {
      method: "POST",
      headers: {
        Authorization: AUTH_HEADER,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(req.body),
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).send(text);
    }

    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
