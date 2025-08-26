// routes/did.js
const express = require("express");
const nodeFetch = require("node-fetch");
const router = express.Router();

const DID_API_KEY = process.env.DID_API_KEY || "";
const DID_USER = process.env.DID_USERNAME || "";
const DID_PASS = process.env.DID_PASSWORD || "";

// Para Streams usar base sin /v1
const DID_BASE = process.env.DID_BASE || "https://api.d-id.com";
const fetch = (...args) => nodeFetch(...args);

const authMode = DID_API_KEY
  ? "API_KEY"
  : (DID_USER && DID_PASS ? "USER_PASS" : "MISSING");

const didHeaders = () => {
  const h = { "Content-Type": "application/json", Accept: "application/json" };
  if (authMode === "API_KEY") {
    h.Authorization = "Basic " + Buffer.from(`${DID_API_KEY}:`).toString("base64");
  } else if (authMode === "USER_PASS") {
    h.Authorization = "Basic " + Buffer.from(`${DID_USER}:${DID_PASS}`).toString("base64");
  }
  return h;
};

// ---------- Debug rápido
router.get("/selftest", async (_req, res) => {
  try {
    const r = await fetch(`${DID_BASE}/credits`, { headers: didHeaders() });
    const data = await r.json().catch(() => ({}));
    res.status(r.ok ? 200 : r.status).json({ status: r.status, authMode, base: DID_BASE, data });
  } catch (e) {
    res.status(500).json({ status: 500, authMode, base: DID_BASE, error: String(e?.message || e) });
  }
});

/* ========= 1) CREAR STREAM =========
POST /api/did/streams { source_url }
-> POST https://api.d-id.com/talks/streams
   FIX: robust parsing + session_id fallback
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

    const raw = await r.text(); // <-- leemos texto crudo
    let data = {};
    try { data = JSON.parse(raw); } catch { data = {}; }

    // Campos esperados
    let { id, session_id, offer, ice_servers } = data || {};

    // Hotfix: a veces session_id llega con cookies AWSALB :(
    const headerSession = r.headers.get("x-session-id");
    const regexSession = raw && raw.match(/sess_[A-Za-z0-9_-]+/);
    if (!session_id || !String(session_id).startsWith("sess_")) {
      session_id = headerSession || (regexSession ? regexSession[0] : session_id);
      if (!session_id || !String(session_id).startsWith("sess_")) {
        console.warn("[DID] WARNING: invalid session_id from upstream:", session_id || raw.slice(0, 160));
        return res.status(502).json({
          error: "invalid_upstream_session_id",
          detail: "Upstream returned a non sess_* session_id",
          upstream_status: r.status,
          snippet: raw.slice(0, 200)
        });
      }
    }

    // También normalizamos offer si vino como string
    if (offer && typeof offer === "string") {
      offer = { type: "offer", sdp: offer };
    }

    return res.status(r.ok ? 200 : r.status).json({ id, session_id, offer, ice_servers });
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
      return res.status(400).json({ error: "bad_session_id" });
    }

    const r = await fetch(`${DID_BASE}/talks/streams/${id}/sdp`, {
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

/* ========= 3) ENVIAR ICE LOCAL =========
POST /api/did/streams/:id/ice { candidate, sdpMid?, sdpMLineIndex?, session_id }
-> POST https://api.d-id.com/talks/streams/{id}/ice
*/
router.post("/streams/:id/ice", async (req, res) => {
  try {
    const { id } = req.params;
    const { candidate, sdpMid, sdpMLineIndex, session_id } = req.body || {};
    if (!id || !candidate || !session_id) return res.status(400).json({ error: "missing_fields" });

    if (!String(session_id).startsWith("sess_")) {
      console.warn("[DID] BAD session_id on /ice POST:", session_id);
      return res.status(400).json({ error: "bad_session_id" });
    }

    const payload = { candidate, session_id };
    if (sdpMid != null) payload.sdpMid = sdpMid;
    if (sdpMLineIndex != null) payload.sdpMLineIndex = sdpMLineIndex;

    const r = await fetch(`${DID_BASE}/talks/streams/${id}/ice`, {
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

/* ========= 3.b) RECIBIR ICE REMOTO (POLL) =========
GET /api/did/streams/:id/ice?session_id=sess_...
-> GET https://api.d-id.com/talks/streams/{id}/ice?session_id=...
*/
router.get("/streams/:id/ice", async (req, res) => {
  try {
    const { id } = req.params;
    const session_id = String(req.query.session_id || "");
    if (!id || !session_id) return res.status(400).json({ error: "missing_fields" });
    if (!session_id.startsWith("sess_")) {
      console.warn("[DID] BAD session_id on /ice GET:", session_id);
      return res.status(400).json({ error: "bad_session_id" });
    }

    const url = `${DID_BASE}/talks/streams/${id}/ice?session_id=${encodeURIComponent(session_id)}`;
    const r = await fetch(url, { headers: didHeaders() });

    // D-ID devuelve { candidates: [...] }
    const data = await r.json().catch(() => ({}));
    return res.status(r.ok ? 200 : r.status).json(data);
  } catch (e) {
    console.error("ice get error", e);
    return res.status(500).json({ error: "ice_get_failed" });
  }
});

/* ========= 4) HABLAR (texto o audio_url) =========
POST /api/did/streams/:id/talk  { session_id, script:{...} }
-> POST https://api.d-id.com/talks/streams/{id}
*/
router.post("/streams/:id/talk", async (req, res) => {
  try {
    const { id } = req.params;
    const { session_id, script } = req.body || {};
    if (!id || !session_id || !script) return res.status(400).json({ error: "missing_fields" });
    if (!String(session_id).startsWith("sess_")) {
      console.warn("[DID] BAD session_id on /talk POST:", session_id);
      return res.status(400).json({ error: "bad_session_id" });
    }

    const r = await fetch(`${DID_BASE}/talks/streams/${id}`, {
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

/* ========= 5) CRÉDITOS ========= */
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
