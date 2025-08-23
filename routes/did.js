// routes/did.js
const express = require("express");
const router = express.Router();
const fetch = globalThis.fetch || require("node-fetch");

/* ========= CONFIG ========= */
const DID_API_KEY = process.env.DID_API_KEY || "";
const DID_USER = process.env.DID_USERNAME || "";
const DID_PASS = process.env.DID_PASSWORD || "";

/**
 * IMPORTANTE:
 * Para Streams/Talks usa SIEMPRE /v1
 */
const DID_BASE = "https://api.d-id.com/v1";

/* ========= HEADERS ========= */
function didHeaders() {
  const h = { "Content-Type": "application/json", Accept: "application/json" };
  if (DID_API_KEY) {
    // API Key en un solo env; si no trae ":", el backend agrega ":" para Basic user:pass
    const raw = DID_API_KEY.includes(":") ? DID_API_KEY : `${DID_API_KEY}:`;
    h.Authorization = "Basic " + Buffer.from(raw).toString("base64");
  } else if (DID_USER && DID_PASS) {
    h.Authorization = "Basic " + Buffer.from(`${DID_USER}:${DID_PASS}`).toString("base64");
  }
  return h;
}

function authMode() {
  if (DID_API_KEY) return "API_KEY";
  if (DID_USER && DID_PASS) return "USER_PASS";
  return "MISSING";
}

/* ========= SELFTEST ========= */
/**
 * Devuelve modo de auth y prueba /v1/credits (si falla, intenta /credits como fallback).
 */
router.get("/selftest", async (_req, res) => {
  const h = didHeaders();
  let r, data, status, base = DID_BASE;

  try {
    r = await fetch(`${DID_BASE}/credits`, { headers: h });
    status = r.status;
    data = await r.json().catch(() => ({}));

    // Fallback por si la cuenta tuviera legacy en /credits (raro hoy)
    if (status >= 400) {
      base = "https://api.d-id.com";
      r = await fetch(`${base}/credits`, { headers: h });
      status = r.status;
      data = await r.json().catch(() => ({}));
    }
  } catch (e) {
    status = 500;
    data = { error: String(e && e.message || e) };
  }

  res.json({ status, authMode: authMode(), base, data });
});

/* ========= CREDITS ========= */
router.get("/credits", async (_req, res) => {
  try {
    const r = await fetch(`${DID_BASE}/credits`, { headers: didHeaders() });
    const data = await r.json().catch(() => ({}));
    return res.status(r.ok ? 200 : r.status).json(data);
  } catch (e) {
    return res.status(500).json({ error: "credits_failed", detail: String(e?.message || e) });
  }
});

/* ========= STREAMS: CREATE ========= */
/**
 * Body: { source_url: string }  (imagen/placeholder para el avatar)
 * Devuelve: { id, session_id, offer, ice_servers }
 */
router.post("/streams", async (req, res) => {
  try {
    const { source_url } = req.body || {};
    const body = { source_url: source_url || "https://raw.githubusercontent.com/betomacia/jesus-backend/main/public/JESPANOL.jpeg" };

    const rCreate = await fetch(`${DID_BASE}/talks/streams`, {
      method: "POST",
      headers: didHeaders(),
      body: JSON.stringify(body),
    });

    if (!rCreate.ok) {
      const detail = await rCreate.text().catch(() => "");
      console.error("[DID] streams create failed", rCreate.status, detail);
      return res.status(403).json({ error: "streams_create_failed", detail: tryJson(detail) });
    }

    const createJson = await rCreate.json();

    const rGet = await fetch(`${DID_BASE}/talks/streams/${createJson.id}`, {
      method: "GET",
      headers: didHeaders(),
    });

    if (!rGet.ok) {
      const detail = await rGet.text().catch(() => "");
      console.error("[DID] sdp get failed", rGet.status, detail);
      return res.status(403).json({ error: "sdp_fetch_failed", detail: tryJson(detail) });
    }

    const sdpJson = await rGet.json();

    return res.json({
      id: createJson.id,
      session_id: createJson.session_id,
      offer: sdpJson.offer,
      ice_servers: sdpJson.ice_servers || [],
    });
  } catch (e) {
    console.error("streams create error", e);
    return res.status(500).json({ error: "streams_create_error", detail: String(e?.message || e) });
  }
});

/* ========= STREAMS: POST SDP ANSWER ========= */
router.post("/streams/:id/sdp", async (req, res) => {
  try {
    const { id } = req.params;
    const { answer, session_id } = req.body || {};
    const r = await fetch(`${DID_BASE}/talks/streams/${id}/sdp`, {
      method: "POST",
      headers: didHeaders(),
      body: JSON.stringify({ answer, session_id }),
    });
    const data = await r.json().catch(() => ({}));
    return res.status(r.ok ? 200 : r.status).json(data);
  } catch (e) {
    console.error("post sdp error", e);
    return res.status(500).json({ error: "post_sdp_failed" });
  }
});

/* ========= STREAMS: POST ICE ========= */
router.post("/streams/:id/ice", async (req, res) => {
  try {
    const { id } = req.params;
    const { candidate, session_id } = req.body || {};
    const r = await fetch(`${DID_BASE}/talks/streams/${id}/ice`, {
      method: "POST",
      headers: didHeaders(),
      body: JSON.stringify({ candidate, session_id }),
    });
    const data = await r.json().catch(() => ({}));
    return res.status(r.ok ? 200 : r.status).json(data);
  } catch (e) {
    console.error("post ice error", e);
    return res.status(500).json({ error: "post_ice_failed" });
  }
});

/* ========= STREAMS: TALK (texto o audio_url) ========= */
/**
 * Body esperado (pass-through):
 * - Para texto: { session_id, script: { type: "text", input: "<texto>" } }
 * - Para audio_url: { session_id, script: { type: "audio", audio_url: "<URL_publica_mp3>" } }
 */
router.post("/streams/:id/talk", async (req, res) => {
  try {
    const { id } = req.params;
    const payload = req.body || {};
    const r = await fetch(`${DID_BASE}/talks/streams/${id}`, {
      method: "POST",
      headers: didHeaders(),
      body: JSON.stringify(payload),
    });
    const data = await r.json().catch(() => ({}));
    return res.status(r.ok ? 200 : r.status).json(data);
  } catch (e) {
    console.error("streams talk error", e);
    return res.status(500).json({ error: "streams_talk_failed" });
  }
});

/* ========= UTIL ========= */
function tryJson(s) {
  try { return JSON.parse(s); } catch { return s; }
}

module.exports = router;
