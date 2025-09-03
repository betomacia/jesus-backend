// routes/a2e.js — A2E WebRTC proxy (sin Agora)
// Interfaz: /api/a2e/streams -> sdp -> ice (post/get) -> talk -> delete
// Ajustable por ENV. Incluye "compat mode" en bodies y logs con DEBUG_A2E=1

const express = require("express");
const nodeFetch = require("node-fetch");

const router = express.Router();
const fetch = (...args) => nodeFetch(...args);

// ===============================
// Config por variables de entorno
// ===============================
const A2E_BASE = (process.env.A2E_BASE || "").replace(/\/+$/, ""); // ej: https://video.a2e.ai
const A2E_API_KEY = process.env.A2E_API_KEY || "";
const DEBUG = String(process.env.DEBUG_A2E || "0") === "1";

// Modo auth: bearer | x-api-key | basic
const A2E_AUTH_MODE = (process.env.A2E_AUTH_MODE || "bearer").toLowerCase();
const A2E_BASIC_USER = process.env.A2E_BASIC_USER || "";
const A2E_BASIC_PASS = process.env.A2E_BASIC_PASS || "";

// Paths REST (ajusta si tu A2E usa otros)
const A2E_CREATE_PATH   = process.env.A2E_CREATE_PATH   || "/streams";
const A2E_SDP_PATH      = process.env.A2E_SDP_PATH      || "/streams/{id}/sdp";
const A2E_ICE_POST_PATH = process.env.A2E_ICE_POST_PATH || "/streams/{id}/ice";
const A2E_ICE_GET_PATH  = process.env.A2E_ICE_GET_PATH  || "/streams/{id}/ice{query}";
const A2E_TALK_PATH     = process.env.A2E_TALK_PATH     || "/streams/{id}";
const A2E_DELETE_PATH   = process.env.A2E_DELETE_PATH   || "/streams/{id}";

// Header name para api-key si no es Bearer
const A2E_API_KEY_HEADER = process.env.A2E_API_KEY_HEADER || "x-api-key";

// Voz/lenguaje por defecto si el proveedor lo permite
const A2E_DEFAULT_VOICE = process.env.A2E_DEFAULT_VOICE || "male_calm";
const A2E_DEFAULT_LANG  = process.env.A2E_DEFAULT_LANG  || "es";

// ===============================
// Helpers
// ===============================
function a2eHeaders(extra = {}) {
  const h = { Accept: "application/json", "Content-Type": "application/json", ...extra };
  if (A2E_AUTH_MODE === "bearer" && A2E_API_KEY) {
    h.Authorization = `Bearer ${A2E_API_KEY}`;
  } else if (A2E_AUTH_MODE === "x-api-key" && A2E_API_KEY) {
    h[A2E_API_KEY_HEADER] = A2E_API_KEY;
  } else if (A2E_AUTH_MODE === "basic") {
    if (A2E_BASIC_USER || A2E_BASIC_PASS) {
      h.Authorization = "Basic " + Buffer.from(`${A2E_BASIC_USER}:${A2E_BASIC_PASS}`).toString("base64");
    }
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
function pathJoin(base, path) {
  return `${base}${path.startsWith("/") ? "" : "/"}${path}`;
}
function fillPath(tpl, params = {}) {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(params[k] ?? ""));
}

// Simple store si tu A2E no usa cookies ALB/“sess_…”
const sessStore = new Map(); // id -> session_id

// ===============================
// Selftest
// ===============================
router.get("/selftest", async (_req, res) => {
  try {
    if (!mustBaseOK(res)) return;
    const url = pathJoin(A2E_BASE, "/");
    if (DEBUG) console.log("[A2E] SELFTEST", url);
    const r = await fetch(url, { method: "GET", headers: a2eHeaders() });
    const txt = await r.text().catch(() => "");
    let data = null; try { data = JSON.parse(txt); } catch {}
    res.status(r.ok ? 200 : r.status).json({
      base: A2E_BASE,
      auth_mode: A2E_AUTH_MODE,
      ok: r.ok,
      status: r.status,
      sample: data || txt.slice(0, 400)
    });
  } catch (e) {
    res.status(500).json({ error: "selftest_failed", detail: String(e && e.message || e) });
  }
});

// =========================================================
// 1) CREAR STREAM
// POST /api/a2e/streams { avatar_url?, lang? }
// Body compat: envia varias claves posibles (source_url, avatar_url, photo, image_url, language…)
// Espera: { id, offer, ice_servers, session_id? }
// =========================================================
router.post("/streams", async (req, res) => {
  try {
    if (!mustBaseOK(res)) return;
    const { avatar_url, lang } = req.body || {};
    const url = pathJoin(A2E_BASE, A2E_CREATE_PATH);

    const language = (lang || A2E_DEFAULT_LANG || "es").toLowerCase();
    const photo = avatar_url || "";

    const compatBody = {
      // claves "compatibles" con varios vendors
      source_url: photo,
      avatar_url: photo,
      image_url: photo,
      photo_url: photo,
      photo,
      avatar: photo,
      lang: language,
      language
    };

    if (DEBUG) console.log("[A2E] CREATE ->", url, compatBody);
    const r = await fetch(url, {
      method: "POST",
      headers: a2eHeaders(),
      body: JSON.stringify(compatBody)
    });

    const txt = await r.text().catch(() => "");
    if (DEBUG) console.log("[A2E] CREATE status", r.status, txt.slice(0, 400));
    let data = null; try { data = JSON.parse(txt); } catch {}

    if (r.ok && data && data.id && data.offer) {
      if (data.session_id) sessStore.set(data.id, data.session_id);
      return res.json(data);
    }
    return res.status(r.status || 502).json(data ?? { raw: txt });
  } catch (e) {
    return res.status(500).json({ error: "a2e_streams_create_error", detail: String(e && e.message || e) });
  }
});

// =========================================================
// 2) ENVIAR SDP ANSWER
// POST /api/a2e/streams/:id/sdp { answer, session_id? }
// =========================================================
router.post("/streams/:id/sdp", async (req, res) => {
  try {
    if (!mustBaseOK(res)) return;
    const { id } = req.params;
    let { answer, session_id } = req.body || {};
    if (!id || !answer) return res.status(400).json({ error: "missing_fields" });

    session_id = session_id || sessStore.get(id) || "";

    const url = pathJoin(A2E_BASE, fillPath(A2E_SDP_PATH, { id }));
    if (DEBUG) console.log("[A2E] SDP ->", url, { hasAnswer: !!answer, session_id: session_id ? "(set)" : "" });

    const r = await fetch(url, {
      method: "POST",
      headers: a2eHeaders(),
      body: JSON.stringify({ answer, session_id })
    });

    const txt = await r.text().catch(() => "");
    if (DEBUG) console.log("[A2E] SDP status", r.status, txt.slice(0, 200));
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
// =========================================================
router.post("/streams/:id/ice", async (req, res) => {
  try {
    if (!mustBaseOK(res)) return;
    const { id } = req.params;
    let { candidate, sdpMid, sdpMLineIndex, session_id } = req.body || {};
    if (!id || !
