// routes/did.js — D-ID Streams proxy con ElevenLabs y session store robusto
const express = require("express");
const nodeFetch = require("node-fetch");

const router = express.Router();
const fetch = (...args) => nodeFetch(...args);

// ==== Credenciales D-ID ====
const DID_API_KEY = process.env.DID_API_KEY || "";
const DID_USER = process.env.DID_USERNAME || "";
const DID_PASS = process.env.DID_PASSWORD || "";
// OJO: para Streams la base es SIN /v1
const DID_BASE = process.env.DID_BASE || "https://api.d-id.com";

// ==== ElevenLabs (para que D-ID use tu propia voz) ====
const ELEVEN_API_KEY =
  process.env.ELEVENLABS_API_KEY ||
  process.env.ELEVEN_API_KEY ||
  process.env.ELEVEN_API ||
  "";
const ELEVEN_VOICE_ID =
  process.env.ELEVENLABS_VOICE_ID ||
  process.env.ELEVEN_VOICE_ID ||
  "";
const ELEVEN_MODEL_ID = process.env.ELEVEN_MODEL_ID || "eleven_flash_v2_5";

// === Auth header D-ID ===
const authMode = DID_API_KEY
  ? "API_KEY"
  : (DID_USER && DID_PASS ? "USER_PASS" : "MISSING");

function didHeaders() {
  const h = { "Content-Type": "application/json", Accept: "application/json" };
  if (authMode === "API_KEY") {
    h.Authorization = "Basic " + Buffer.from(`${DID_API_KEY}:`).toString("base64");
  } else if (authMode === "USER_PASS") {
    h.Authorization = "Basic " + Buffer.from(`${DID_USER}:${DID_PASS}`).toString("base64");
  }
  // Permite a D-ID usar TU cuenta de ElevenLabs
  if (ELEVEN_API_KEY) {
    h["x-api-key-external"] = JSON.stringify({ elevenlabs: ELEVEN_API_KEY });
  }
  return h;
}

// === Memorias en backend (por stream) ===
// 1) Cookie jar (stickiness + session_id si viene en cookie)
const cookieJar = new Map(); // streamId -> cookie string
// 2) Session store explícito (si el body trae session_id, lo guardamos SIEMPRE)
const sessionStore = new Map(); // streamId -> session_id

const validSess = (s) => typeof s === "string" && /^sess_/i.test(s);

// Helpers cookies
function parseSetCookie(setCookieHeader) {
  const out = { cookie: "", session_id: "" };
  if (!setCookieHeader) return out;
  const sess = setCookieHeader.match(/session_id=(sess_[^;,\s]+)/i);
  const alb = setCookieHeader.match(/AWSALB=[^;]+/);
  const cors = setCookieHeader.match(/AWSALBCORS=[^;]+/);
  const parts = [];
  if (alb) parts.push(alb[0]);
  if (cors) parts.push(cors[0]);
  if (sess) { parts.push(`session_id=${sess[1]}`); out.session_id = sess[1]; }
  out.cookie = parts.join("; ");
  return out;
}
function mergeCookies(...cookieStrings) {
  const map = new Map();
  for (const s of cookieStrings) {
    if (!s) continue;
    for (const part of s.split(/;\s*/)) {
      const m = part.match(/^([^=]+)=(.+)$/);
      if (m) map.set(m[1], m[2]);
    }
  }
  return Array.from(map.entries()).map(([k,v]) => `${k}=${v}`).join("; ");
}

// Devuelve session_id robusto: body → cookie → store
function resolveSessionId(streamId, provided) {
  if (validSess(provided)) return provided;

  const cookie = cookieJar.get(streamId) || "";
  const m = cookie.match(/session_id=(sess_[^;]+)/i);
  if (m && validSess(m[1])) return m[1];

  const stored = sessionStore.get(streamId);
  if (validSess(stored)) return stored;

  return ""; // no disponible todavía
}

// Selftest
router.get("/selftest", async (_req, res) => {
  try {
    const r = await fetch(`${DID_BASE}/credits`, { headers: didHeaders() });
    const data = await r.json().catch(() => ({}));
    res.status(r.ok ? 200 : r.status).json({
      status: r.status, authMode, base: DID_BASE,
      elevenVoice: ELEVEN_VOICE_ID ? "configured" : "missing",
      elevenModel: ELEVEN_MODEL_ID,
      data
    });
  } catch (e) {
    res.status(500).json({ status: 500, authMode, base: DID_BASE, error: String(e && e.message || e) });
  }
});

/* =========================================================
   1) CREAR STREAM
   POST /api/did/streams { source_url }
   ========================================================= */
router.post("/streams", async (req, res) => {
  try {
    const { source_url } = req.body || {};
    if (!source_url) return res.status(400).json({ error: "missing_source_url" });

    const baseReq = {
      method: "POST",
      headers: didHeaders(),
      body: JSON.stringify({ source_url }),
      redirect: "manual",
    };

    const doRequest = async (url) => {
      let r = await fetch(url, baseReq);
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get("location");
        if (loc) r = await fetch(loc, baseReq);
      }
      return r;
    };

    let attempt = 0, maxAttempts = 3, lastStatus = 0, lastBody = "";
    let r = await doRequest(`${DID_BASE}/talks/streams`);

    while (attempt < maxAttempts) {
      lastStatus = r.status;
      const setCookie = r.headers.get("set-cookie") || "";
      const txt = await r.text().catch(() => "");
      lastBody = txt;

      let data = null;
      try { data = txt ? JSON.parse(txt) : null; } catch { data = null; }

      if (r.ok && data && data.id && data.offer) {
        // cookies
        const { cookie, session_id: sessFromCookie } = parseSetCookie(setCookie);
        if (cookie) {
          const prev = cookieJar.get(data.id) || "";
          cookieJar.set(data.id, mergeCookies(prev, cookie));
        }
        // guarda session_id confiable
        const sessBody = data.session_id && validSess(data.session_id) ? data.session_id : "";
        const sess = sessBody || sessFromCookie || "";
        if (validSess(sess)) sessionStore.set(data.id, sess);
        // si upstream devolvió mal session_id, lo corregimos antes de enviar
        if (!validSess(data.session_id) && validSess(sess)) data.session_id = sess;

        return res.json({ ...data, cookie: (cookie || undefined), upstream_status: lastStatus });
      }

      attempt++;
      if (attempt >= maxAttempts) break;
      await new Promise(r => setTimeout(r, 250 * attempt));
      r = await doRequest(`${DID_BASE}/talks/streams`);
    }

    console.error("[DID] streams create failed", lastStatus, lastBody || "");
    return res.status(502).json({ error: "streams_create_failed", upstream_status: lastStatus, detail: safeJSON(lastBody) });
  } catch (e) {
    console.error("streams create error", e);
    return res.status(500).json({ error: "streams_create_error" });
  }
});

/* =========================================================
   2) ENVIAR SDP ANSWER
   POST /api/did/streams/:id/sdp { answer, session_id }
   ========================================================= */
router.post("/streams/:id/sdp", async (req, res) => {
  try {
    const { id } = req.params;
    let { answer, session_id } = req.body || {};
    if (!id || !answer) return res.status(400).json({ error: "missing_fields" });

    const cookie = cookieJar.get(id) || "";
    session_id = resolveSessionId(id, session_id);
    if (!validSess(session_id)) return res.status(400).json({ error: "missing_session_id" });

    const r = await fetch(`${DID_BASE}/talks/streams/${id}/sdp`, {
      method: "POST",
      headers: { ...didHeaders(), ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify({ answer, session_id })
    });

    const setCookie = r.headers.get("set-cookie") || "";
    const pc = parseSetCookie(setCookie);
    if (pc.cookie) cookieJar.set(id, mergeCookies(cookie, pc.cookie));
    if (validSess(pc.session_id)) sessionStore.set(id, pc.session_id);

    const txt = await r.text().catch(() => "");
    const data = parseJSON(txt);
    return res.status(r.ok ? 200 : r.status).json(data ?? { raw: txt });
  } catch (e) {
    console.error("sdp post error", e);
    return res.status(500).json({ error: "sdp_failed" });
  }
});

/* =========================================================
   3) ENVIAR ICE (local -> upstream)
   POST /api/did/streams/:id/ice { candidate, sdpMid?, sdpMLineIndex?, session_id }
   ========================================================= */
router.post("/streams/:id/ice", async (req, res) => {
  try {
    const { id } = req.params;
    let { candidate, sdpMid, sdpMLineIndex, session_id } = req.body || {};
    if (!id || !candidate) return res.status(400).json({ error: "missing_fields" });

    const payload = { candidate, session_id: "" };
    if (sdpMid != null) payload.sdpMid = sdpMid;
    if (sdpMLineIndex != null) payload.sdpMLineIndex = sdpMLineIndex;

    const cookie = cookieJar.get(id) || "";
    session_id = resolveSessionId(id, session_id);
    if (!validSess(session_id)) return res.status(400).json({ error: "missing_session_id" });
    payload.session_id = session_id;

    const r = await fetch(`${DID_BASE}/talks/streams/${id}/ice`, {
      method: "POST",
      headers: { ...didHeaders(), ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(payload)
    });

    const setCookie = r.headers.get("set-cookie") || "";
    const pc = parseSetCookie(setCookie);
    if (pc.cookie) cookieJar.set(id, mergeCookies(cookie, pc.cookie));
    if (validSess(pc.session_id)) sessionStore.set(id, pc.session_id);

    const txt = await r.text().catch(() => "");
    const data = parseJSON(txt);
    return res.status(r.ok ? 200 : r.status).json(data ?? { raw: txt });
  } catch (e) {
    console.error("ice post error", e);
    return res.status(500).json({ error: "ice_failed" });
  }
});

/* =========================================================
   3b) OBTENER ICE REMOTO
   GET /api/did/streams/:id/ice[?session_id=...]
   ========================================================= */
router.get("/streams/:id/ice", async (req, res) => {
  try {
    const { id } = req.params;
    let { session_id } = req.query || {};
    if (!id) return res.status(400).json({ error: "missing_id" });

    const cookie = cookieJar.get(id) || "";
    session_id = resolveSessionId(id, String(session_id || ""));

    if (!validSess(session_id)) {
      // aún no disponible: devolvemos vacío para que el front siga intentando sin ruido
      return res.status(200).json({ candidates: [] });
    }

    const url = `${DID_BASE}/talks/streams/${id}/ice?session_id=${encodeURIComponent(String(session_id))}`;
    const r = await fetch(url, {
      method: "GET",
      headers: { ...didHeaders(), ...(cookie ? { Cookie: cookie } : {}) }
    });

    const setCookie = r.headers.get("set-cookie") || "";
    const pc = parseSetCookie(setCookie);
    if (pc.cookie) cookieJar.set(id, mergeCookies(cookie, pc.cookie));
    if (validSess(pc.session_id)) sessionStore.set(id, pc.session_id);

    const txt = await r.text().catch(() => "");
    try {
      const data = JSON.parse(txt);
      return res.status(r.ok ? 200 : r.status).json(data);
    } catch {
      const candidates = txt
        .split(/\r?\n/)
        .map(s => { try { return JSON.parse(s); } catch { return null; } })
        .filter(Boolean)
        .flatMap(obj => Array.isArray(obj?.candidates) ? obj.candidates : []);
      return res.status(200).json({ candidates });
    }
  } catch (e) {
    console.error("ice get error", e);
    return res.status(200).json({ candidates: [] });
  }
});

/* =========================================================
   4) HABLAR (texto) — inyecta ElevenLabs si no viene provider
   POST /api/did/streams/:id/talk { session_id, script:{...} }
   ========================================================= */
router.post("/streams/:id/talk", async (req, res) => {
  try {
    const { id } = req.params;
    let { session_id, script } = req.body || {};
    if (!id || !script) return res.status(400).json({ error: "missing_fields" });

    // Inyección de ElevenLabs por defecto si es texto
    if (script && script.type === "text") {
      const isEleven = script.provider && script.provider.type === "elevenlabs";
      if (!isEleven && ELEVEN_VOICE_ID) {
        script.provider = {
          type: "elevenlabs",
          voice_id: ELEVEN_VOICE_ID,
          voice_config: {
            model_id: ELEVEN_MODEL_ID,
            stability: 0.5,
            similarity_boost: 0.75
          }
        };
      } else if (isEleven) {
        const vc = script.provider.voice_config || {};
        script.provider.voice_config = {
          model_id: vc.model_id || ELEVEN_MODEL_ID,
          stability: vc.stability ?? 0.5,
          similarity_boost: vc.similarity_boost ?? 0.75
        };
      }
    }

    const cookie = cookieJar.get(id) || "";
    session_id = resolveSessionId(id, session_id);
    if (!validSess(session_id)) return res.status(400).json({ error: "missing_session_id" });

    const r = await fetch(`${DID_BASE}/talks/streams/${id}`, {
      method: "POST",
      headers: { ...didHeaders(), ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify({ session_id, script })
    });

    const setCookie = r.headers.get("set-cookie") || "";
    const pc = parseSetCookie(setCookie);
    if (pc.cookie) cookieJar.set(id, mergeCookies(cookie, pc.cookie));
    if (validSess(pc.session_id)) sessionStore.set(id, pc.session_id);

    const txt = await r.text().catch(() => "");
    const data = parseJSON(txt);
    return res.status(r.ok ? 200 : r.status).json(data ?? { raw: txt });
  } catch (e) {
    console.error("talk post error", e);
    return res.status(500).json({ error: "talk_failed" });
  }
});

/* =========================================================
   5) CERRAR STREAM
   DELETE /api/did/streams/:id  { session_id }
   ========================================================= */
router.delete("/streams/:id", async (req, res) => {
  try {
    const { id } = req.params;
    let { session_id } = req.body || {};
    if (!id) return res.status(400).json({ error: "missing_id" });

    const cookie = cookieJar.get(id) || "";
    session_id = resolveSessionId(id, session_id);
    if (!validSess(session_id)) return res.status(400).json({ error: "missing_session_id" });

    const r = await fetch(`${DID_BASE}/talks/streams/${id}`, {
      method: "DELETE",
      headers: { ...didHeaders(), ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify({ session_id })
    });

    cookieJar.delete(id);
    sessionStore.delete(id);

    const txt = await r.text().catch(() => "");
    const data = parseJSON(txt);
    return res.status(r.ok ? 200 : r.status).json(data ?? { raw: txt });
  } catch (e) {
    console.error("delete stream error", e);
    return res.status(500).json({ error: "delete_stream_failed" });
  }
});

/* =========================================================
   6) CRÉDITOS (debug)
   ========================================================= */
router.get("/credits", async (_req, res) => {
  try {
    const r = await fetch(`${DID_BASE}/credits`, { headers: didHeaders() });
    const txt = await r.text().catch(() => "");
    const data = parseJSON(txt);
    return res.status(r.ok ? 200 : r.status).json(data ?? { raw: txt });
  } catch (e) {
    console.error("credits error", e);
    return res.status(500).json({ error: "credits_failed" });
  }
});

/* Helpers */
function parseJSON(s) { try { return JSON.parse(s); } catch { return null; } }
function safeJSON(s) { try { return JSON.parse(s); } catch { return s; } }

module.exports = router;
