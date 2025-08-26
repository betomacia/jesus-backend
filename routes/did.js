// routes/did.js
const express = require("express");
const nodeFetch = require("node-fetch");

const router = express.Router();

// === AUTH & BASE ===
const DID_API_KEY = process.env.DID_API_KEY || "";
const DID_USER = process.env.DID_USERNAME || "";
const DID_PASS = process.env.DID_PASSWORD || "";

// Para Streams usar base sin /v1
const DID_BASE = process.env.DID_BASE || "https://api.d-id.com";

// helper fetch
const fetch = (...args) => nodeFetch(...args);

const authMode = DID_API_KEY
  ? "API_KEY"
  : (DID_USER && DID_PASS ? "USER_PASS" : "MISSING");

const didHeaders = () => {
  const h = { "Content-Type": "application/json", Accept: "application/json" };
  if (authMode === "API_KEY") {
    // API key: Basic base64("APIKEY:")
    h.Authorization = "Basic " + Buffer.from(`${DID_API_KEY}:`).toString("base64");
  } else if (authMode === "USER_PASS") {
    // Usuario/Password: "user:pass"
    h.Authorization = "Basic " + Buffer.from(`${DID_USER}:${DID_PASS}`).toString("base64");
  }
  return h;
};

// Debug rápido de auth/endpoint
router.get("/selftest", async (_req, res) => {
  try {
    const r = await fetch(`${DID_BASE}/credits`, { headers: didHeaders() });
    const data = await r.json().catch(() => ({}));
    res.status(r.ok ? 200 : r.status).json({ status: r.status, authMode, base: DID_BASE, data });
  } catch (e) {
    res.status(500).json({ status: 500, authMode, base: DID_BASE, error: String((e && e.message) || e) });
  }
});

/* ========= 1) CREAR STREAM =========
POST /api/did/streams { source_url }
-> POST https://api.d-id.com/talks/streams
Devuelve: { id, session_id, offer, ice_servers }
*/
router.post("/streams", async (req, res) => {
  try {
    const { source_url } = req.body || {};
    if (!source_url) return res.status(400).json({ error: "missing_source_url" });

    const r = await fetch(`${DID_BASE}/talks/streams`, {
      method: "POST",
      headers: didHeaders(),
      body: JSON.stringify({ source_url })
    });

    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      console.error("[DID] streams create failed", r.status, detail || "");
      return res.status(r.status).json({ error: "streams_create_failed", detail: detail || undefined });
    }

    const data = await r.json().catch(() => ({}));
    // saneamos la respuesta
    const { id, session_id, offer, ice_servers } = data || {};
    if (!session_id || !String(session_id).startsWith("sess_")) {
      console.warn("[DID] WARNING: invalid session_id from upstream:", session_id);
    }
    return res.json({ id, session_id, offer, ice_servers });
  } catch (e) {
    console.error("streams create error", e);
    return res.status(500).json({ error: "streams_create_error" });
  }
});

/* ========= 2) ENVIAR SDP ANSWER =========
POST /api/did/streams/:id/sdp { answer, session_id }
-> POST https://api.d-id.com/talks/streams/{id}/sdp
*/
router.post("/streams/:id/sdp", async (req, res) => {
  try {
    const { id } = req.params;
    const { answer, session_id } = req.body || {};
    if (!id || !answer || !session_id) return res.status(400).json({ error: "missing_fields" });
    if (!String(session_id).startsWith("sess_")) {
      console.warn("[DID] BAD session_id on /sdp POST:", session_id);
    }

    const r = await fetch(`${DID_BASE}/talks/streams/${encodeURIComponent(id)}/sdp`, {
      method: "POST",
      headers: didHeaders(),
      body: JSON.stringify({ answer, session_id })
    });

    const data = await r.json().catch(() => ({}));
    return res.status(r.ok ? 200 : r.status).json(data);
  } catch (e) {
    console.error("sdp post error", e);
    return res.status(500).json({ error: "sdp_failed" });
  }
});

/* ========= 3) ENVIAR ICE (LOCALES) =========
POST /api/did/streams/:id/ice { candidate, sdpMid?, sdpMLineIndex?, session_id }
-> POST https://api.d-id.com/talks/streams/{id}/ice
*/
router.post("/streams/:id/ice", async (req, res) => {
  try {
    const { id } = req.params;
    const { candidate, sdpMid, sdpMLineIndex, session_id } = req.body || {};
    if (!id || !candidate || session_id == null) {
      return res.status(400).json({ error: "missing_fields" });
    }
    if (!String(session_id).startsWith("sess_")) {
      console.warn("[DID] BAD session_id on /ice POST:", session_id);
    }

    const payload = { candidate, session_id };
    if (sdpMid != null) payload.sdpMid = sdpMid;
    if (sdpMLineIndex != null) payload.sdpMLineIndex = sdpMLineIndex;

    const r = await fetch(`${DID_BASE}/talks/streams/${encodeURIComponent(id)}/ice`, {
      method: "POST",
      headers: didHeaders(),
      body: JSON.stringify(payload)
    });

    const data = await r.json().catch(() => ({}));
    return res.status(r.ok ? 200 : r.status).json(data);
  } catch (e) {
    console.error("ice post error", e);
    return res.status(500).json({ error: "ice_failed" });
  }
});

/* ========= 3.b) OBTENER ICE (REMOTOS) =========
GET /api/did/streams/:id/ice?session_id=sess_xxx
-> GET https://api.d-id.com/talks/streams/{id}/ice?session_id=sess_xxx
*/
router.get("/streams/:id/ice", async (req, res) => {
  try {
    const { id } = req.params;
    const raw = req.query.session_id;
    const session_id = raw ? String(raw) : "";

    if (!session_id || !session_id.startsWith("sess_")) {
      console.warn("[DID] BAD session_id on /ice GET:", raw);
      // Devolvemos vacío para no romper el front
      return res.json({ candidates: [] });
    }

    const url = `${DID_BASE}/talks/streams/${encodeURIComponent(id)}/ice?session_id=${encodeURIComponent(session_id)}`;

    const r = await fetch(url, {
      method: "GET",
      headers: didHeaders(),
    });

    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      console.warn("[DID] upstream /ice GET failed", r.status, detail);
      return res.status(r.status).send(detail || "ice get failed");
    }

    const data = await r.json().catch(() => ({ candidates: [] }));
    return res.json(data);
  } catch (e) {
    console.error("ice get error", e);
    return res.status(500).json({ error: "ice_get_failed" });
  }
});

/* ========= 4) HABLAR (texto o audio_url) =========
POST /api/did/streams/:id/talk
  body: { session_id, script: { type:'text', input:'...' } }
  ó    { session_id, script: { type:'audio', audio_url:'...' } }
-> POST https://api.d-id.com/talks/streams/{id}
*/
router.post("/streams/:id/talk", async (req, res) => {
  try {
    const { id } = req.params;
    const { session_id, script } = req.body || {};
    if (!id || !session_id || !script) {
      return res.status(400).json({ error: "missing_fields" });
    }

    const r = await fetch(`${DID_BASE}/talks/streams/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: didHeaders(),
      body: JSON.stringify({ session_id, script })
    });

    const data = await r.json().catch(() => ({}));
    return res.status(r.ok ? 200 : r.status).json(data);
  } catch (e) {
    console.error("talk post error", e);
    return res.status(500).json({ error: "talk_failed" });
  }
});

/* ========= 4.b) COMPAT: /api/did/talk-el (tu front lo usa) =========
POST /api/did/talk-el { id, session_id, text }
-> Proxy a POST /talks/streams/{id} con script text
   (si quieres ElevenLabs real + audio_url, aquí podrías generarlo y pasar type:'audio')
*/
router.post("/talk-el", async (req, res) => {
  try {
    const { id, session_id, text } = req.body || {};
    if (!id || !session_id || !text) {
      return res.status(400).json({ error: "missing_fields" });
    }

    const payload = {
      session_id,
      script: {
        type: "text",
        input: String(text)
      }
    };

    const r = await fetch(`${DID_BASE}/talks/streams/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: didHeaders(),
      body: JSON.stringify(payload)
    });

    const data = await r.json().catch(() => ({}));
    return res.status(r.ok ? 200 : r.status).json(data);
  } catch (e) {
    console.error("talk-el error", e);
    return res.status(500).json({ error: "talk_el_failed" });
  }
});

/* ========= 5) CRÉDITOS (debug) ========= */
router.get("/credits", async (_req, res) => {
  try {
    const r = await fetch(`${DID_BASE}/credits`, { headers: didHeaders() });
    const data = await r.json().catch(() => ({}));
    return res.status(r.ok ? 200 : r.status).json(data);
  } catch (e) {
    console.error("credits error", e);
    return res.status(500).json({ error: "credits_failed" });
  }
});

module.exports = router;
