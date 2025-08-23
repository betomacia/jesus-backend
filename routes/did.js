// routes/did.js
const express = require("express");
const router = express.Router();

/* ====== Auth headers D-ID ====== */
const DID_API_KEY = process.env.DID_API_KEY || "";
const DID_USERNAME = process.env.DID_USERNAME || "";
const DID_PASSWORD = process.env.DID_PASSWORD || "";

function didHeaders() {
  const h = { "Content-Type": "application/json", Accept: "application/json" };
  if (DID_API_KEY) {
    h.Authorization = "Basic " + Buffer.from(`${DID_API_KEY}:`).toString("base64");
  } else if (DID_USERNAME && DID_PASSWORD) {
    h.Authorization = "Basic " + Buffer.from(`${DID_USERNAME}:${DID_PASSWORD}`).toString("base64");
  } else {
    console.warn("[WARN] Faltan credenciales D-ID (DID_API_KEY o DID_USERNAME/DID_PASSWORD)");
  }
  return h;
}

/* ====== Crear stream y devolver offer/ice_servers ====== */
router.post("/streams", async (req, res) => {
  try {
    const source_url = (req.body && req.body.source_url) || "";
    if (!source_url) return res.status(400).json({ error: "missing_source_url" });

    const createR = await fetch("https://api.d-id.com/talks/streams", {
      method: "POST",
      headers: didHeaders(),
      body: JSON.stringify({ source_url }),
    });

    if (!createR.ok) {
      const txt = await createR.text().catch(() => "");
      return res.status(createR.status).json({ error: "create_failed", detail: txt });
    }
    const createJson = await createR.json();

    const sdpR = await fetch(`https://api.d-id.com/talks/streams/${createJson.id}`, {
      method: "GET",
      headers: didHeaders(),
    });

    if (!sdpR.ok) {
      const txt = await sdpR.text().catch(() => "");
      return res.status(sdpR.status).json({ error: "offer_failed", detail: txt });
    }
    const sdpJson = await sdpR.json();

    res.json({
      id: createJson.id,
      session_id: createJson.session_id,
      offer: sdpJson.offer,
      ice_servers: sdpJson.ice_servers || [],
    });
  } catch (e) {
    console.error("streams error", e);
    res.status(500).json({ error: "streams_exception" });
  }
});

/* ====== Enviar ANSWER (SDP) del navegador ====== */
router.post("/streams/:id/sdp", async (req, res) => {
  try {
    const { id } = req.params;
    const { answer, session_id } = req.body || {};
    if (!id || !answer || !session_id) return res.status(400).json({ error: "missing_fields" });

    const sdpR = await fetch(`https://api.d-id.com/talks/streams/${id}/sdp`, {
      method: "POST",
      headers: didHeaders(),
      body: JSON.stringify({ answer, session_id }),
    });

    const data = await sdpR.json().catch(() => ({}));
    return res.status(sdpR.ok ? 200 : sdpR.status).json(data);
  } catch (e) {
    console.error("sdp error", e);
    res.status(500).json({ error: "sdp_exception" });
  }
});

/* ====== Reenviar ICE candidates ====== */
router.post("/streams/:id/ice", async (req, res) => {
  try {
    const { id } = req.params;
    const { candidate, session_id } = req.body || {};
    if (!id || !candidate || !session_id) return res.status(400).json({ error: "missing_fields" });

    const iceR = await fetch(`https://api.d-id.com/talks/streams/${id}/ice`, {
      method: "POST",
      headers: didHeaders(),
      body: JSON.stringify({ candidate, session_id }),
    });

    if (!iceR.ok) {
      const txt = await iceR.text().catch(() => "");
      return res.status(iceR.status).json({ error: "ice_failed", detail: txt });
    }
    return res.json({ ok: true });
  } catch (e) {
    console.error("ice error", e);
    res.status(500).json({ error: "ice_exception" });
  }
});

module.exports = router;
