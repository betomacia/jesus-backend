// routes/did.js — D-ID Streams proxy con “cookie echo”, captura de cookies y reintentos robustos
const express = require("express");
const nodeFetch = require("node-fetch");

const router = express.Router();

const DID_API_KEY = process.env.DID_API_KEY || "";
const DID_USER = process.env.DID_USERNAME || "";
const DID_PASS = process.env.DID_PASSWORD || "";

// OJO: para Streams la base es SIN /v1
const DID_BASE = process.env.DID_BASE || "https://api.d-id.com";
const fetch = (...args) => nodeFetch(...args);

// === Auth header ===
const authMode = DID_API_KEY
  ? "API_KEY"
  : (DID_USER && DID_PASS ? "USER_PASS" : "MISSING");

const didHeaders = () => {
  const h = { "Content-Type": "application/json", Accept: "application/json" };
  if (authMode === "API_KEY") {
    // Basic base64("APIKEY:")
    h.Authorization = "Basic " + Buffer.from(`${DID_API_KEY}:`).toString("base64");
  } else if (authMode === "USER_PASS") {
    // Basic base64("user:pass")
    h.Authorization = "Basic " + Buffer.from(`${DID_USER}:${DID_PASS}`).toString("base64");
  }
  return h;
};

// === Cookie jar en memoria por streamId (para stickiness del ALB) ===
const cookieJar = new Map(); // streamId -> cookie (string)

// Utilidades
const validSess = (s) => typeof s === "string" && /^sess_/i.test(s);

/** Parsea el header Set-Cookie(s) y arma:
 *  - cookie: "AWSALB=...; AWSALBCORS=...; session_id=sess_..."
 *  - session_id: "sess_..."
 */
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

/** Mezcla/actualiza pares clave=valor de varias cadenas Cookie */
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

/** Toma cookie “eco” desde header o body */
function takeEchoCookie(req) {
  return (req.get("x-did-cookie") || req.body?.cookie || "").trim();
}

/** Extrae session_id=sess_... desde una cookie string */
function sessFromCookieStr(cookieStr) {
  const m = String(cookieStr || "").match(/session_id=(sess_[^;]+)/i);
  return m ? m[1] : "";
}

/** Une todos los Set-Cookie presentes (incluye múltiples y redirecciones) */
function collectSetCookies(...responses) {
  const all = [];
  for (const r of responses) {
    try {
      const raw = r.headers.raw && r.headers.raw()["set-cookie"];
      if (Array.isArray(raw) && raw.length) all.push(...raw);
    } catch {}
    const single = r.headers.get && r.headers.get("set-cookie");
    if (single) all.push(single);
  }
  // Devuelve en una sola cadena para parseo simple
  return all.join(", ");
}

// Selftest
router.get("/selftest", async (_req, res) => {
  try {
    const r = await fetch(`${DID_BASE}/credits`, { headers: didHeaders() });
    const data = await r.json().catch(() => ({}));
    res.status(r.ok ? 200 : r.status).json({ status: r.status, authMode, base: DID_BASE, data });
  } catch (e) {
    res.status(500).json({ status: 500, authMode, base: DID_BASE, error: String(e && e.message || e) });
  }
});

/* =========================================================
   1) CREAR STREAM (REINTENTOS)
   POST /api/did/streams { source_url }
   -> POST https://api.d-id.com/talks/streams
   ========================================================= */
router.post("/streams", async (req, res) => {
  try {
    const { source_url } = req.body || {};
    if (!source_url) return res.status(400).json({ error: "missing_source_url" });

    const baseReq = {
      method: "POST",
      headers: didHeaders(),
      body: JSON.stringify({ source_url }),
      redirect: "manual", // importante para capturar Set-Cookie en 3xx
    };

    const tryOnce = async () => {
      // 1ª llamada (puede ser 3xx con Set-Cookie)
      const r1 = await fetch(`${DID_BASE}/talks/streams`, baseReq);
      let finalResp = r1;
      let cookiesJoined = collectSetCookies(r1);

      // Sigue hasta 3 redirecciones manuales como máximo
      let hops = 0;
      while (finalResp.status >= 300 && finalResp.status < 400 && hops < 3) {
        const loc = finalResp.headers.get("location");
        if (!loc) break;
        const rn = await fetch(loc, baseReq);
        cookiesJoined = collectSetCookies({ headers: { raw: () => ({"set-cookie": []}) }, get: () => "" }, rn, { headers: finalResp.headers, get: finalResp.headers.get }); // asegura incluir prev+nuevo
        finalResp = rn;
        hops++;
      }

      const txt = await finalResp.text().catch(() => "");
      let data = null;
      try { data = txt ? JSON.parse(txt) : null; } catch { data = null; }

      return { finalResp, data, cookiesJoined, raw: txt };
    };

    const MAX_TRIES = 5;
    let lastTxt = "", lastStatus = 0;

    for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
      const { finalResp, data, cookiesJoined, raw } = await tryOnce();
      lastTxt = raw || "";
      lastStatus = finalResp.status;

      if (finalResp.ok && data && data.id && data.offer) {
        // Extrae cookies (incluido session_id si vino en alguna hop)
        const { cookie, session_id: sessFromCookies } = parseSetCookie(cookiesJoined);

        // Corrige session_id si el body viene mal y las cookies lo traen
        if (!validSess(data.session_id) && sessFromCookies) {
          console.warn("[DID] Upstream session_id inválido, corrigiendo:", data.session_id, "->", sessFromCookies);
          data.session_id = sessFromCookies;
        }

        // Si AÚN no hay session_id válido, reintenta (transitorio de ALB)
        if (!validSess(data.session_id || "")) {
          console.warn(`[DID] intento ${attempt}/${MAX_TRIES}: sin session_id (cookies solo ALB). Reintentando…`);
          await new Promise(r => setTimeout(r, 150 * attempt));
          continue;
        }

        // Guarda/une cookie en jar y reenvía al front
        if (cookie) {
          const prev = cookieJar.get(data.id) || "";
          const merged = mergeCookies(prev, cookie);
          cookieJar.set(data.id, merged);
          data.cookie = merged; // devolvemos cookie al front (eco)
        }

        return res.json({ ...data, upstream_status: finalResp.status, attempts: attempt });
      }

      // Si fallo HTTP, breve backoff y reintentar
      await new Promise(r => setTimeout(r, 200 * attempt));
    }

    console.error("[DID] streams create failed", lastStatus, lastTxt || "");
    return res.status(502).json({ error: "streams_create_failed", upstream_status: lastStatus, detail: safeJSON(lastTxt) });
  } catch (e) {
    console.error("streams create error", e);
    return res.status(500).json({ error: "streams_create_error" });
  }
});

/* =========================================================
   2) ENVIAR SDP ANSWER
   POST /api/did/streams/:id/sdp { answer, session_id, cookie? }
   -> POST https://api.d-id.com/talks/streams/{id}/sdp
   ========================================================= */
router.post("/streams/:id/sdp", async (req, res) => {
  try {
    const { id } = req.params;
    let { answer, session_id } = req.body || {};
    if (!id || !answer) return res.status(400).json({ error: "missing_fields" });

    const jarCookie = cookieJar.get(id) || "";
    const echoCookie = takeEchoCookie(req);
    const mergedCookie = mergeCookies(jarCookie, echoCookie);

    // Repara session_id desde cookie si viene vacío/incorrecto
    if (!validSess(session_id || "")) session_id = sessFromCookieStr(mergedCookie);
    if (!session_id) return res.status(400).json({ error: "missing_session_id" });

    const r = await fetch(`${DID_BASE}/talks/streams/${id}/sdp`, {
      method: "POST",
      headers: { ...didHeaders(), ...(mergedCookie ? { Cookie: mergedCookie } : {}) },
      body: JSON.stringify({ answer, session_id })
    });

    // Actualiza cookie jar si upstream setea cookies nuevas
    const setCookie = collectSetCookies(r);
    const pc = parseSetCookie(setCookie);
    if (pc.cookie) cookieJar.set(id, mergeCookies(mergedCookie, pc.cookie));

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
   POST /api/did/streams/:id/ice { candidate, sdpMid?, sdpMLineIndex?, session_id, cookie? }
   -> POST https://api.d-id.com/talks/streams/{id}/ice
   ========================================================= */
router.post("/streams/:id/ice", async (req, res) => {
  try {
    const { id } = req.params;
    let { candidate, sdpMid, sdpMLineIndex, session_id } = req.body || {};
    if (!id || !candidate) return res.status(400).json({ error: "missing_fields" });

    const payload = { candidate, session_id: "" };
    if (sdpMid != null) payload.sdpMid = sdpMid;
    if (sdpMLineIndex != null) payload.sdpMLineIndex = sdpMLineIndex;

    const jarCookie = cookieJar.get(id) || "";
    const echoCookie = takeEchoCookie(req);
    const mergedCookie = mergeCookies(jarCookie, echoCookie);

    if (!validSess(session_id || "")) session_id = sessFromCookieStr(mergedCookie);
    if (!session_id) return res.status(400).json({ error: "missing_session_id" });
    payload.session_id = session_id;

    const r = await fetch(`${DID_BASE}/talks/streams/${id}/ice`, {
      method: "POST",
      headers: { ...didHeaders(), ...(mergedCookie ? { Cookie: mergedCookie } : {}) },
      body: JSON.stringify(payload)
    });

    const setCookie = collectSetCookies(r);
    const pc = parseSetCookie(setCookie);
    if (pc.cookie) cookieJar.set(id, mergeCookies(mergedCookie, pc.cookie));

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
   GET /api/did/streams/:id/ice[?session_id=...]  (+ x-did-cookie)
   -> GET https://api.d-id.com/talks/streams/{id}/ice?session_id=...
   ========================================================= */
router.get("/streams/:id/ice", async (req, res) => {
  try {
    const { id } = req.params;
    let { session_id } = req.query || {};
    if (!id) return res.status(400).json({ error: "missing_id" });

    const jarCookie = cookieJar.get(id) || "";
    const echoCookie = (req.get("x-did-cookie") || "").trim();
    const mergedCookie = mergeCookies(jarCookie, echoCookie);

    if (!validSess(String(session_id || ""))) session_id = sessFromCookieStr(mergedCookie);

    // Si aún no hay sess_, devolvemos OK "vacío"
    if (!session_id) {
      return res.status(200).json({ candidates: [] });
    }

    const url = `${DID_BASE}/talks/streams/${id}/ice?session_id=${encodeURIComponent(String(session_id))}`;
    const r = await fetch(url, {
      method: "GET",
      headers: { ...didHeaders(), ...(mergedCookie ? { Cookie: mergedCookie } : {}) }
    });

    const setCookie = collectSetCookies(r);
    const pc = parseSetCookie(setCookie);
    if (pc.cookie) cookieJar.set(id, mergeCookies(mergedCookie, pc.cookie));

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
   4) HABLAR (texto)
   POST /api/did/streams/:id/talk { session_id, script:{...}, cookie? }
   -> POST https://api.d-id.com/talks/streams/{id}
   ========================================================= */
router.post("/streams/:id/talk", async (req, res) => {
  try {
    const { id } = req.params;
    let { session_id, script } = req.body || {};
    if (!id || !script) return res.status(400).json({ error: "missing_fields" });

    const jarCookie = cookieJar.get(id) || "";
    const echoCookie = takeEchoCookie(req);
    const mergedCookie = mergeCookies(jarCookie, echoCookie);

    if (!validSess(session_id || "")) session_id = sessFromCookieStr(mergedCookie);
    if (!session_id) return res.status(400).json({ error: "missing_session_id" });

    const r = await fetch(`${DID_BASE}/talks/streams/${id}`, {
      method: "POST",
      headers: { ...didHeaders(), ...(mergedCookie ? { Cookie: mergedCookie } : {}) },
      body: JSON.stringify({ session_id, script })
    });

    const setCookie = collectSetCookies(r);
    const pc = parseSetCookie(setCookie);
    if (pc.cookie) cookieJar.set(id, mergeCookies(mergedCookie, pc.cookie));

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
   -> DELETE https://api.d-id.com/talks/streams/{id}
   ========================================================= */
router.delete("/streams/:id", async (req, res) => {
  try {
    const { id } = req.params;
    let { session_id } = req.body || {};
    if (!id) return res.status(400).json({ error: "missing_id" });

    const jarCookie = cookieJar.get(id) || "";
    const echoCookie = takeEchoCookie(req);
    const mergedCookie = mergeCookies(jarCookie, echoCookie);

    if (!validSess(session_id || "")) session_id = sessFromCookieStr(mergedCookie);
    if (!session_id) return res.status(400).json({ error: "missing_session_id" });

    const r = await fetch(`${DID_BASE}/talks/streams/${id}`, {
      method: "DELETE",
      headers: { ...didHeaders(), ...(mergedCookie ? { Cookie: mergedCookie } : {}) },
      body: JSON.stringify({ session_id })
    });

    cookieJar.delete(id); // limpia jar

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
