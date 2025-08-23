// routes/did.js
const express = require("express");
const router = express.Router();
const nodeFetch = require("node-fetch");
const _fetch = (...args) => (globalThis.fetch ? globalThis.fetch(...args) : nodeFetch(...args));

require("dotenv").config();

/* ============ Helpers de auth D-ID ============ */
function didHeaders() {
  const h = { "Content-Type": "application/json", Accept: "application/json" };
  const API_KEY = process.env.DID_API_KEY || "";
  const USER = process.env.DID_USERNAME || "";
  const PASS = process.env.DID_PASSWORD || "";

  if (API_KEY) {
    // D-ID requiere Basic con base64("API_KEY:")
    h.Authorization = "Basic " + Buffer.from(`${API_KEY}:`).toString("base64");
  } else if (USER && PASS) {
    h.Authorization = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");
  } else {
    console.warn("[DID] Falta DID_API_KEY o DID_USERNAME/DID_PASSWORD");
  }
  return h;
}

/* ============ Crear stream y traer SDP remoto (offer) ============ */
router.post("/streams", async (req, res) => {
  try {
    const { source_url } = req.body || {};
    const payload = {
      source_url:
        source_url ||
        "https://raw.githubusercontent.com/betomacia/imagen-jesus/refs/heads/main/jesus.jpg",
    };

    // 1) Crear stream
    const r = await _fetch("https://api.d-id.com/talks/streams", {
      method: "POST",
      headers: didHeaders(),
      body: JSON.stringify(payload),
    });
    const createJson = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error("[DID] offer_failed", createJson);
      return res
        .status(r.status)
        .json({ error: "offer_failed", detail: JSON.stringify(createJson) });
    }

    // 2) Obtener SDP offer + ICE
    const r2 = await _fetch(`https://api.d-id.com/talks/streams/${createJson.id}`, {
      method: "GET",
      headers: didHeaders(),
    });
    const sdpJson = await r2.json().catch(() => ({}));
    if (!r2.ok) {
      console.error("[DID] sdp_fetch_failed", sdpJson);
      return res
        .status(r2.status)
        .json({ error: "sdp_fetch_failed", detail: JSON.stringify(sdpJson) });
    }

    return res.json({
      id: createJson.id,
      session_id: createJson.session_id,
      offer: sdpJson.offer,
      ice_servers: sdpJson.ice_servers || [],
    });
  } catch (e) {
    console.error("[DID] streams error", e);
    return res.status(500).json({ error: "streams_failed" });
  }
});

/* ============ Enviar ANSWER (SDP local) ============ */
router.post("/streams/:id/sdp", async (req, res) => {
  try {
    const { id } = req.params;
    const { answer, session_id } = req.body || {};
    if (!id || !session_id || !answer || !answer.sdp || !answer.type) {
      return res.status(400).json({ error: "missing_fields" });
    }

    const r = await _fetch(`https://api.d-id.com/talks/streams/${id}/sdp`, {
      method: "POST",
      headers: didHeaders(),
      body: JSON.stringify({ answer, session_id }),
    });

    const data = await r.json().catch(() => ({}));
    return res.status(r.ok ? 200 : r.status).json(data);
  } catch (e) {
    console.error("[DID] sdp post error", e);
    return res.status(500).json({ error: "sdp_failed" });
  }
});

/* ============ Enviar ICE candidates ============ */
router.post("/streams/:id/ice", async (req, res) => {
  try {
    const { id } = req.params;
    const { candidate, session_id } = req.body || {};
    if (!id || !session_id || !candidate) {
      return res.status(400).json({ error: "missing_fields" });
    }

    const r = await _fetch(`https://api.d-id.com/talks/streams/${id}/ice`, {
      method: "POST",
      headers: didHeaders(),
      body: JSON.stringify({ candidate, session_id }),
    });

    const data = await r.json().catch(() => ({}));
    return res.status(r.ok ? 200 : r.status).json(data);
  } catch (e) {
    console.error("[DID] ice post error", e);
    return res.status(500).json({ error: "ice_failed" });
  }
});

/* ============ Talk con texto (opcional) ============ */
router.post("/streams/:id/talk", async (req, res) => {
  try {
    const { id } = req.params;
    const { session_id, script } = req.body || {};
    if (!id || !session_id || !script) {
      return res.status(400).json({ error: "missing_fields" });
    }

    const r = await _fetch(`https://api.d-id.com/talks/streams/${id}`, {
      method: "POST",
      headers: didHeaders(),
      body: JSON.stringify({ session_id, script }),
    });

    const data = await r.json().catch(() => ({}));
    return res.status(r.ok ? 200 : r.status).json(data);
  } catch (e) {
    console.error("[DID] talk error", e);
    return res.status(500).json({ error: "talk_failed" });
  }
});

module.exports = router;
