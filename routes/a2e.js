// routes/a2e.js — A2E WebRTC proxy (sin Agora)
// Interfaz tipo /api/did: create -> sdp -> ice (post/get) -> talk -> delete
// Incluye selftest y un "guesser" de rutas para diagnosticar 405.

const express = require("express");
const nodeFetch = require("node-fetch");

const router = express.Router();
const fetch = (...args) => nodeFetch(...args);

// ===============================
// Config por variables de entorno
// ===============================
const A2E_BASE = (process.env.A2E_BASE || "").replace(/\/+$/, ""); // p.ej. https://video.a2e.ai
const A2E_API_KEY = process.env.A2E_API_KEY || "";

// Modo auth: bearer | x-api-key | basic
const A2E_AUTH_MODE = (process.env.A2E_AUTH_MODE || "bearer").toLowerCase();
const A2E_BASIC_USER = process.env.A2E_BASIC_USER || "";
const A2E_BASIC_PASS = process.env.A2E_BASIC_PASS || "";

// Paths REST (overrides opcionales)
const A2E_CREATE_PATH   = process.env.A2E_CREATE_PATH   || "/streams";                // POST
const A2E_SDP_PATH      = process.env.A2E_SDP_PATH      || "/streams/{id}/sdp";       // POST
const A2E_ICE_POST_PATH = process.env.A2E_ICE_POST_PATH || "/streams/{id}/ice";       // POST
const A2E_ICE_GET_PATH  = process.env.A2E_ICE_GET_PATH  || "/streams/{id}/ice{query}";// GET
const A2E_TALK_PATH     = process.env.A2E_TALK_PATH     || "/streams/{id}";           // POST
const A2E_DELETE_PATH   = process.env.A2E_DELETE_PATH   || "/streams/{id}";           // DELETE

// Header name para api-key si no es Bearer
const A2E_API_KEY_HEADER = process.env.A2E_API_KEY_HEADER || "x-api-key";

// ===============================
// Helpers de auth y cabeceras
// ===============================
function a2eHeaders(extra = {}) {
  const h = { Accept: "application/json", "Content-Type": "application/json", ...extra };
  if (A2E_AUTH_MODE === "bearer" && A2E_API_KEY) {
    h.Authorization = `Bearer ${A2E_API_KEY}`;
  } else if (A2E_AUTH_MODE === "x-api-key" && A2E_API_KEY) {
    h[A2E_API_KEY_HEADER] = A2E_API_KEY;
  } else if (A2E_AUTH_MODE === "basic") {
    h.Authorization = "Basic " + Buffer.from(`${A2E_BASIC_USER}:${A2E_BASIC_PASS}`).toString("base64");
  }
  return h;
}
function mustBaseOK(res) {
  if (!A2E_BASE) {
    res.status(500).json({ error: "A2E_BASE_missing", hint: "Define A2E_BASE en variables de entorno" });
    return false;
  }
  return true;
}
function pathJoin(base, p) { return `${base}${p.startsWith("/") ? "" : "/"}${p}`; }
function fillPath(tpl, params = {}) {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(params[k] ?? ""));
}

// Simple store si tu A2E no usa cookies/ALB ni session_id
const sessStore = new Map(); // id -> session_id

// ===============================
// Selftest: verifica base/auth rápido
// ===============================
router.get("/selftest", async (_req, res) => {
  try {
    if (!mustBaseOK(res)) return;
    const url = pathJoin(A2E_BASE, "/");
    const r = await fetch(url, { method: "GET", headers: a2eHeaders() });
    const allow = r.headers.get("allow") || "";
    const txt = await r.text().catch(() => "");
    let data = null; try { data = JSON.parse(txt); } catch {}
    res.status(r.ok ? 200 : r.status).json({
      base: A2E_BASE,
      auth_mode: A2E_AUTH_MODE,
      ok: r.ok,
      status: r.status,
      allow,
      sample: data || txt.slice(0, 400)
    });
  } catch (e) {
    res.status(500).json({ error: "selftest_failed", detail: String(e && e.message || e) });
  }
});

// ===============================
// Guesser: prueba rutas típicas
// ===============================
router.post("/guess-paths", async (req, res) => {
  try {
    if (!mustBaseOK(res)) return;
    const { avatar_url, lang } = req.body || {};
    const candidates = [
      // más comunes
      "/streams", "/v1/streams", "/api/streams",
      "/webrtc/streams", "/v1/webrtc/streams",
      "/talks/streams", "/v1/talks/streams",
      // por si usan “sessions”
      "/sessions", "/v1/sessions", "/webrtc/sessions",
    ];

    const results = [];
    for (const p of candidates) {
      const url = pathJoin(A2E_BASE, p);
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: a2eHeaders(),
          body: JSON.stringify({ avatar_url, lang, source_url: avatar_url })
        });
        const allow = r.headers.get("allow") || "";
        const ct = r.headers.get("content-type") || "";
        const txt = await r.text().catch(() => "");
        let data = null; try { data = JSON.parse(txt); } catch {}
        results.push({
          path: p, status: r.status, ok: r.ok, allow, content_type: ct,
          has_offer: !!data?.offer, has_id: !!data?.id,
          sample: data || txt.slice(0, 240)
        });
        if (r.ok && data?.id && data?.offer) break; // ya está
      } catch (e) {
        results.push({ path: p, error: String(e && e.message || e) });
      }
    }
    res.json({ base: A2E_BASE, results });
  } catch (e) {
    res.status(500).json({ error: "guess_failed", detail: String(e && e.message || e) });
  }
});

// =========================================================
// 1) CREAR STREAM
// POST /api/a2e/streams { avatar_url?, lang? }
// -> POST {A2E_BASE}{A2E_CREATE_PATH}
// Debe devolver al menos: { id, offer, ice_servers, session_id? }
// =========================================================
router.post("/streams", async (req, res) => {
  try {
    if (!mustBaseOK(res)) return;
    const { avatar_url, lang } = req.body || {};
    const url = pathJoin(A2E_BASE, A2E_CREATE_PATH);

    const body = JSON.stringify({ source_url: avatar_url, avatar_url, lang });
    const r = await fetch(url, { method: "POST", headers: a2eHeaders(), body });

    const allow = r.headers.get("allow") || "";
    const txt = await r.text().catch(() => "");
    let data = null; try { data = JSON.parse(txt); } catch {}

    if (r.ok && data && data.id && data.offer) {
      if (data.session_id) sessStore.set(data.id, data.session_id);
      res.setHeader("X-Upstream-URL", url);
      return res.json(data);
    }
    res.setHeader("X-Upstream-URL", url);
    res.setHeader("X-Upstream-Allow", allow);
    return res.status(r.status || 502).json(data ?? { raw: txt });
  } catch (e) {
    return res.status(500).json({ error: "a2e_streams_create_error", detail: String(e && e.message || e) });
  }
});

// =========================================================
// 2) ENVIAR SDP ANSWER
// POST /api/a2e/streams/:id/sdp { answer, session_id? }
// -> POST {A2E_BASE}{A2E_SDP_PATH}
// =========================================================
router.post("/streams/:id/sdp", async (req, res) => {
  try {
    if (!mustBaseOK(res)) return;
    const { id } = req.params;
    let { answer, session_id } = req.body || {};
    if (!id || !answer) return res.status(400).json({ error: "missing_fields" });

    session_id = session_id || sessStore.get(id) || "";
    const url = pathJoin(A2E_BASE, fillPath(A2E_SDP_PATH, { id }));
    const r = await fetch(url, {
      method: "POST",
      headers: a2eHeaders(),
      body: JSON.stringify({ answer, session_id })
    });

    const txt = await r.text().catch(() => "");
    let data = null; try { data = JSON.parse(txt); } catch {}
    if (r.ok && data && data.session_id && !sessStore.get(id)) {
      sessStore.set(id, data.session_id);
    }
    return res.status(r.ok ? 200 : r.status).json(data ?? { raw: txt });
  } catch (e) {
    return res.status(500).json({ error: "a2e_sdp_failed", detail: String(e && e.message || e) });
  }
});

// =========================================================
// 3) ENVIAR ICE (local)
// POST /api/a2e/streams/:id/ice { candidate, sdpMid?, sdpMLineIndex?, session_id? }
// -> POST {A2E_BASE}{A2E_ICE_POST_PATH}
// =========================================================
router.post("/streams/:id/ice", async (req, res) => {
  try {
    if (!mustBaseOK(res)) return;
    const { id } = req.params;
    let { candidate, sdpMid, sdpMLineIndex, session_id } = req.body || {};
    if (!id || !candidate) return res.status(400).json({ error: "missing_fields" });

    session_id = session_id || sessStore.get(id) || "";
    const payload = { candidate, session_id };
    if (sdpMid != null) payload.sdpMid = sdpMid;
    if (sdpMLineIndex != null) payload.sdpMLineIndex = sdpMLineIndex;

    const url = pathJoin(A2E_BASE, fillPath(A2E_ICE_POST_PATH, { id }));
    const r = await fetch(url, {
      method: "POST",
      headers: a2eHeaders(),
      body: JSON.stringify(payload)
    });
    const txt = await r.text().catch(() => "");
    let data = null; try { data = JSON.parse(txt); } catch {}
    return res.status(r.ok ? 200 : r.status).json(data ?? { raw: txt });
  } catch (e) {
    return res.status(500).json({ error: "a2e_ice_post_failed", detail: String(e && e.message || e) });
  }
});

// =========================================================
// 3b) OBTENER ICE (remoto)
// GET /api/a2e/streams/:id/ice[?session_id=...]
// -> GET {A2E_BASE}{A2E_ICE_GET_PATH}?session_id=...
// =========================================================
router.get("/streams/:id/ice", async (req, res) => {
  try {
    if (!mustBaseOK(res)) return;
    const { id } = req.params;
    let { session_id } = req.query || {};
    if (!id) return res.status(400).json({ error: "missing_id" });

    session_id = String(session_id || sessStore.get(id) || "");
    const q = session_id ? `?session_id=${encodeURIComponent(session_id)}` : "";
    const url = pathJoin(A2E_BASE, fillPath(A2E_ICE_GET_PATH, { id, query: q }));

    const r = await fetch(url, { method: "GET", headers: a2eHeaders() });
    const txt = await r.text().catch(() => "");

    try {
      const data = JSON.parse(txt);
      return res.status(r.ok ? 200 : r.status).json(data);
    } catch {
      const candidates = txt
        .split(/\r?\n/)
        .map((s) => { try { return JSON.parse(s); } catch { return null; } })
        .filter(Boolean)
        .flatMap((obj) => Array.isArray(obj?.candidates) ? obj.candidates : []);
      return res.status(200).json({ candidates });
    }
  } catch (e) {
    return res.status(200).json({ candidates: [] });
  }
});

// =========================================================
// 4) HABLAR (texto)
// POST /api/a2e/streams/:id/talk { session_id?, script:{ type:"text", input:"..." } }
// -> POST {A2E_BASE}{A2E_TALK_PATH}
// =========================================================
router.post("/streams/:id/talk", async (req, res) => {
  try {
    if (!mustBaseOK(res)) return;
    const { id } = req.params;
    let { session_id, script } = req.body || {};
    if (!id || !script) return res.status(400).json({ error: "missing_fields" });

    session_id = session_id || sessStore.get(id) || "";

    const url = pathJoin(A2E_BASE, fillPath(A2E_TALK_PATH, { id }));
    const r = await fetch(url, {
      method: "POST",
      headers: a2eHeaders(),
      body: JSON.stringify({ session_id, script })
    });
    const txt = await r.text().catch(() => "");
    let data = null; try { data = JSON.parse(txt); } catch {}
    return res.status(r.ok ? 200 : r.status).json(data ?? { raw: txt });
  } catch (e) {
    return res.status(500).json({ error: "a2e_talk_failed", detail: String(e && e.message || e) });
  }
});

// =========================================================
// 5) CERRAR STREAM
// DELETE /api/a2e/streams/:id { session_id? }
// =========================================================
router.delete("/streams/:id", async (req, res) => {
  try {
    if (!mustBaseOK(res)) return;
    const { id } = req.params;
    let { session_id } = req.body || {};
    if (!id) return res.status(400).json({ error: "missing_id" });

    session_id = session_id || sessStore.get(id) || "";

    const url = pathJoin(A2E_BASE, fillPath(A2E_DELETE_PATH, { id }));
    const r = await fetch(url, {
      method: "DELETE",
      headers: a2eHeaders(),
      body: JSON.stringify({ session_id })
    });

    sessStore.delete(id);

    const txt = await r.text().catch(() => "");
    let data = null; try { data = JSON.parse(txt); } catch {}
    return res.status(r.ok ? 200 : r.status).json(data ?? { raw: txt });
  } catch (e) {
    return res.status(500).json({ error: "a2e_delete_failed", detail: String(e && e.message || e) });
  }
});

module.exports = router;
