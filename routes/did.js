// routes/did.js
const express = require("express");
const router = express.Router();
const nodeFetch = require("node-fetch");
require("dotenv").config();

const _fetch = (...args) =>
  (globalThis.fetch ? globalThis.fetch(...args) : nodeFetch(...args));

/* ========= Helpers de auth D-ID ========= */
function didHeaders() {
  const h = { "Content-Type": "application/json", Accept: "application/json" };
  const API_KEY = process.env.DID_API_KEY || "";
  const USER = process.env.DID_USERNAME || "";
  const PASS = process.env.DID_PASSWORD || "";

  if (API_KEY) {
    // Formato correcto: Basic base64("API_KEY:")
    h.Authorization = "Basic " + Buffer.from(`${API_KEY}:`).toString("base64");
    h["X-DID-Auth-Mode"] = "API_KEY";
  } else if (USER && PASS) {
    // Alternativa: Basic base64("username:password")
    h.Authorization = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");
    h["X-DID-Auth-Mode"] = "USER_PASS";
  } else {
    console.warn("[DID] Falta DID_API_KEY o DID_USERNAME/DID_PASSWORD");
    h["X-DID-Auth-Mode"] = "MISSING";
  }
  return h;
}

/* ========= Autotest de credenciales =========
   GET /api/did/selftest -> llama /v1/credits
============================================= */
router.get("/selftest", async (_req, res) => {
  try {
    const r = await _fetch("https://api.d-id.com/v1/credits", {
      headers: didHeaders(),
    });
    const data = await r.json().catch(() => ({}));
    console.log("[DID] /v1/credits status:", r.status, "auth:", (didHeaders()["X-DID-Auth-Mode"]));
    return res.status(r.ok ? 200 : r.status).json({ status: r.status, authMode: didHeaders()["X-DID-Auth-Mode"], data });
  } catch (e) {
    console.error("[DID] selftest error", e);
    return res.status(500).json({ error: "selftest_failed" });
  }
});

/* ========= Crear stream (offer + ice) =========
   POST /api/did/streams { source_url? }
============================================== */
router.post("/streams", async (req, res) => {
  try {
    const { source_url } = req.body || {};
    const payload = {
      source_url: source_url || "https://raw.githubusercontent.com/betomacia/imagen-jesus/refs/heads/main/jesus.jpg",
    };

    // 1) crear stream
    const r = await _fetch("https://api.d-id.com/v1/talks/streams", {
      method: "POST",
      headers: didHeaders(),
      body: JSON.stringify(payload),
    });

    const createJson = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error("[DID] offer_failed", r.status, createJson);
      return res.status(r.status).json({ error: "offer_failed", detail: createJson });
    }

    // 2) obtener SDP offer + ICE
    const r2 = await _fetch(`https://api.d-id.com/v1/talks/streams/${createJson.id}`, {
      method: "GET",
      headers: didHeaders(),
    });

    const sdpJson = await r2.json().catch(() => ({}));
    if (!r2.ok) {
      console.error("[DID] sdp_fetch_failed", r2.status, sdpJson);
      return res.status(r2.status).json({ error: "sdp_fetch_failed", detail: sdpJson });
    }

    console.log("[DID] stream created:", createJson.id, "auth:", (didHeaders()["X-DID-Auth-Mode"]));
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

/* ========= Enviar ANSWER (SDP) =========
   POST /api/did/streams/:id/sdp { answer, session_id }
======================================= */
router.post("/streams/:id/sdp", async (req, res) => {
  try {
    const { id } = req.params;
    const { answer, session_id } = req.body || {};
    if (!id || !session_id || !answer || !answer.sdp || !answer.type) {
      return res.status(400).json({ error: "missing_fields" });
    }

    const r = await _fetch(`https://api.d-id.com/v1/talks/streams/${id}/sdp`, {
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

/* ========= Enviar ICE =========
   POST /api/did/streams/:id/ice { candidate, session_id }
================================ */
router.post("/streams/:id/ice", async (req, res) => {
  try {
    const { id } = req.params;
    const { candidate, session_id } = req.body || {};
    if (!id || !session_id || !candidate) {
      return res.status(400).json({ error: "missing_fields" });
    }

    const r = await _fetch(`https://api.d-id.com/v1/talks/streams/${id}/ice`, {
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

/* ========= Talk (texto o audio_url) =========
   POST /api/did/streams/:id/talk { session_id, script }
   (script: { type:'text', input:'...' }  ó  { type:'audio', audio_url:'...' })
============================================ */
router.post("/streams/:id/talk", async (req, res) => {
  try {
    const { id } = req.params;
    const { session_id, script } = req.body || {};
    if (!id || !session_id || !script) {
      return res.status(400).json({ error: "missing_fields" });
    }

    const r = await _fetch(`https://api.d-id.com/v1/talks/streams/${id}`, {
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
