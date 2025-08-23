/* =========================
   routes/did.js  (D-ID Streams)
   ========================= */
const express = require("express");
const nodeFetch = require("node-fetch"); // fallback si el runtime no trae fetch global
const router = express.Router();

const _fetch = (...args) =>
  (globalThis.fetch ? globalThis.fetch(...args) : nodeFetch(...args));

const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL ||
  "https://jesus-backend-production-1cf4.up.railway.app";

/* ---------- Auth & Base helpers ---------- */
function didAuthMode() {
  if (process.env.DID_API_KEY) return "API_KEY";
  if (process.env.DID_USERNAME && process.env.DID_PASSWORD) return "USER_PASS";
  return "MISSING";
}
function didBase() {
  // Streams requieren API KEY + /v1
  return didAuthMode() === "API_KEY" ? "https://api.d-id.com/v1" : "https://api.d-id.com";
}
function didHeaders() {
  const h = { "Content-Type": "application/json", Accept: "application/json" };
  const { DID_API_KEY, DID_USERNAME, DID_PASSWORD } = process.env;

  if (DID_API_KEY) {
    // Acepta clave 'simple' o del tipo 'usuario:token'
    const raw   = DID_API_KEY.includes(":") ? DID_API_KEY : `${DID_API_KEY}:`;
    const basic = Buffer.from(raw).toString("base64");
    h.Authorization = `Basic ${basic}`;
    h["X-DID-Auth-Mode"] = "API_KEY";
  } else if (DID_USERNAME && DID_PASSWORD) {
    h.Authorization = "Basic " + Buffer.from(`${DID_USERNAME}:${DID_PASSWORD}`).toString("base64");
    h["X-DID-Auth-Mode"] = "USER_PASS";
  } else {
    h["X-DID-Auth-Mode"] = "MISSING";
  }
  return h;
}

console.log(`[BOOT] DID auth mode: ${didAuthMode()} base: ${didBase()}`);

/* ---------- Selftest ---------- */
router.get("/selftest", async (_req, res) => {
  try {
    const r = await _fetch(`${didBase()}/credits`, { headers: didHeaders() });
    const data = await r.json().catch(() => ({}));
    res.status(200).json({
      status: r.status,
      authMode: didAuthMode(),
      base: didBase(),
      data,
    });
  } catch (e) {
    res.status(500).json({ status: 500, authMode: didAuthMode(), base: didBase(), error: "selftest_failed" });
  }
});

/* ---------- Crear stream (Streams/WebRTC) ---------- */
router.post("/streams", async (req, res) => {
  try {
    if (didAuthMode() !== "API_KEY") {
      return res.status(403).json({ error: "need_api_key", detail: "Streams requiere API_KEY; no USER/PASS" });
    }
    const { source_url } = req.body || {};
    const data = {
      source_url:
        source_url ||
        "https://raw.githubusercontent.com/betomacia/jesus-backend/main/public/JESPANOL.jpeg",
    };

    const createResponse = await _fetch(`${didBase()}/talks/streams`, {
      method: "POST",
      headers: didHeaders(),
      body: JSON.stringify(data),
    });

    if (!createResponse.ok) {
      const errorText = await createResponse.text();
      console.error("[DID] streams create failed", createResponse.status, errorText);
      return res.status(createResponse.status).json({
        error: "streams_create_failed",
        detail: tryParse(errorText),
      });
    }

    const createJson = await createResponse.json();

    // Obtener offer + ice
    const sdpResponse = await _fetch(`${didBase()}/talks/streams/${createJson.id}`, {
      method: "GET",
      headers: didHeaders(),
    });

    if (!sdpResponse.ok) {
      const errorText = await sdpResponse.text();
      console.error("[DID] sdp fetch failed", sdpResponse.status, errorText);
      return res.status(sdpResponse.status).json({
        error: "sdp_fetch_failed",
        detail: tryParse(errorText),
      });
    }

    const sdpJson = await sdpResponse.json();

    res.json({
      id: createJson.id,
      session_id: createJson.session_id,
      offer: sdpJson.offer,
      ice_servers: sdpJson.ice_servers || [],
    });
  } catch (error) {
    console.error("streams error", error);
    res.status(500).json({ error: "streams_failed", detail: error?.message || String(error) });
  }
});

/* ---------- Enviar SDP answer ---------- */
router.post("/streams/:id/sdp", async (req, res) => {
  try {
    if (didAuthMode() !== "API_KEY") {
      return res.status(403).json({ error: "need_api_key" });
    }
    const { id } = req.params;
    const { answer, session_id } = req.body || {};
    if (!id || !answer || !session_id) {
      return res.status(400).json({ error: "missing_fields" });
    }

    const r = await _fetch(`${didBase()}/talks/streams/${id}/sdp`, {
      method: "POST",
      headers: didHeaders(),
      body: JSON.stringify({ answer, session_id }),
    });

    const data = await r.json().catch(() => ({}));
    return res.status(r.ok ? 200 : r.status).json(data);
  } catch (e) {
    console.error("sdp post error", e);
    return res.status(500).json({ error: "sdp_failed" });
  }
});

/* ---------- Enviar ICE candidate ---------- */
router.post("/streams/:id/ice", async (req, res) => {
  try {
    if (didAuthMode() !== "API_KEY") {
      return res.status(403).json({ error: "need_api_key" });
    }
    const { id } = req.params;
    const { candidate, session_id } = req.body || {};
    if (!id || !candidate || !session_id) {
      return res.status(400).json({ error: "missing_fields" });
    }

    const r = await _fetch(`${didBase()}/talks/streams/${id}/ice`, {
      method: "POST",
      headers: didHeaders(),
      body: JSON.stringify({ candidate, session_id }),
    });

    const data = await r.json().catch(() => ({}));
    return res.status(r.ok ? 200 : r.status).json(data);
  } catch (e) {
    console.error("ice post error", e);
    return res.status(500).json({ error: "ice_failed" });
  }
});

/* ---------- tts-cache (re-host con Content-Length) ---------- */
const ttsCache = new Map(); // key -> { buf, type, at }
const TTS_TTL_MS = 5 * 60 * 1000;

router.get("/tts-cache/:key", (req, res) => {
  const rec = ttsCache.get(req.params.key);
  if (!rec) return res.status(404).end();
  res.setHeader("Content-Type", rec.type || "audio/mpeg");
  res.setHeader("Cache-Control", "public, max-age=120");
  res.setHeader("Content-Length", String(rec.buf.length));
  res.end(rec.buf);
});

router.head("/tts-cache/:key", (req, res) => {
  const rec = ttsCache.get(req.params.key);
  if (!rec) return res.status(404).end();
  res.setHeader("Content-Type", rec.type || "audio/mpeg");
  res.setHeader("Cache-Control", "public, max-age=120");
  res.setHeader("Content-Length", String(rec.buf.length));
  res.end();
});

// Limpieza básica
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of ttsCache.entries()) {
    if (now - v.at > TTS_TTL_MS) ttsCache.delete(k);
  }
}, 60 * 1000);

/* ---------- Talk (TEXT o AUDIO_URL) con intercept ---------- */
router.post("/streams/:id/talk", async (req, res) => {
  try {
    if (didAuthMode() !== "API_KEY") {
      return res.status(403).json({ error: "need_api_key" });
    }
    const { id } = req.params;
    let { session_id, script } = req.body || {};
    if (!id || !session_id || !script) {
      return res.status(400).json({ error: "missing_fields" });
    }

    // Intercept: si nos pasan audio_url, lo re-hospedamos con Content-Length
    if (script.type === "audio" && script.audio_url) {
      const absUrl = new URL(script.audio_url, PUBLIC_BASE_URL).toString();
      const rr = await _fetch(absUrl, { method: "GET" });
      if (!rr.ok) {
        const txt = await rr.text().catch(() => "");
        console.error("[tts-cache] fetch failed", rr.status, txt);
        return res.status(502).json({ error: "tts_fetch_failed" });
      }
      const type = rr.headers.get("content-type") || "audio/mpeg";
      const abuf = await rr.arrayBuffer();
      const buf  = Buffer.from(abuf);
      const key  = randomKey();
      ttsCache.set(key, { buf, type, at: Date.now() });
      script = { type: "audio", audio_url: `${PUBLIC_BASE_URL}/api/did/tts-cache/${key}` };
    }

    const r = await _fetch(`${didBase()}/talks/streams/${id}`, {
      method: "POST",
      headers: didHeaders(),
      body: JSON.stringify({ session_id, script }),
    });

    const data = await r.json().catch(() => ({}));
    return res.status(r.ok ? 200 : r.status).json(data);
  } catch (e) {
    console.error("talk error", e);
    return res.status(500).json({ error: "talk_failed" });
  }
});

/* ---------- Utils ---------- */
function tryParse(t) {
  try { return JSON.parse(t); } catch { return { message: String(t || "") }; }
}
function randomKey() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

module.exports = router;
