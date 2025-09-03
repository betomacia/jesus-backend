// routes/a2e.js — A2E Streaming Avatar (Agora) con fallback de base US→CN
// Endpoints expuestos:
//   GET  /api/a2e/selftest
//   GET  /api/a2e/avatars
//   POST /api/a2e/token         { avatar_id, expire_seconds?=60 }
//   POST /api/a2e/talk          { channel, text, lang?, voice? }
//   POST /api/a2e/leave         { channel, uid }
// Lee variables de entorno:
//   A2E_API_KEY           (Bearer ***)
//   A2E_BASE              (opc. una sola base, ej. https://video.a2e.ai)
//   A2E_BASES             (opc. lista CSV, ej. "https://video.a2e.ai,https://video.a2e.com.cn")

const express = require("express");
const nodeFetch = require("node-fetch");

const router = express.Router();
const fetch = (...args) => nodeFetch(...args);

// === Config ===
const A2E_API_KEY = process.env.A2E_API_KEY || "";

// Lista de bases a probar: A2E_BASES (CSV) > A2E_BASE > default [US, CN]
const basesFromCsv = (process.env.A2E_BASES || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean)
  .map(s => s.replace(/\/+$/, ""));

const fallbackBases = basesFromCsv.length
  ? basesFromCsv
  : (process.env.A2E_BASE
      ? [process.env.A2E_BASE.replace(/\/+$/, "")]
      : ["https://video.a2e.ai", "https://video.a2e.com.cn"]);

function authHeaders(extra = {}) {
  const h = { "Content-Type": "application/json", Accept: "application/json", ...extra };
  if (A2E_API_KEY) h.Authorization = `Bearer ${A2E_API_KEY}`;
  return h;
}

async function tryFetchJsonAcrossBases(method, path, bodyObj = null, opts = {}) {
  const bodiestr = bodyObj ? JSON.stringify(bodyObj) : undefined;
  const results = [];
  for (const base of fallbackBases) {
    const url = `${base}${path.startsWith("/") ? "" : "/"}${path}`;
    try {
      const r = await fetch(url, {
        method,
        headers: authHeaders(opts.headers || {}),
        body: bodiestr
      });
      const ct = String(r.headers.get("content-type") || "");
      const raw = await r.text();
      let data = null;
      try { data = ct.includes("application/json") ? JSON.parse(raw) : null; } catch {}
      // OK cuando HTTP 200–299 y (si existe "code") es 0
      const ok = r.ok && (!data || data.code === undefined || data.code === 0);
      results.push({ base, url, status: r.status, ok, data: data ?? raw });

      // Criterio de fallback: si ok → devolvemos, si no, continuamos probando
      if (ok) return { base, status: r.status, data: data ?? raw };
      // Error 1001 (capacidad ocupada) => probamos siguiente base
      if (data && data.code === 1001) continue;
      // 5xx => probamos siguiente base
      if (r.status >= 500) continue;
      // Para 4xx distintos a 1001, devolvemos de una
      return { base, status: r.status, data: data ?? raw };
    } catch (e) {
      results.push({ base, error: String(e && e.message || e) });
      // Probar siguiente base
      continue;
    }
  }
  // Si ninguna base funcionó, devolvemos el último resultado para depurar
  const last = results[results.length - 1] || { status: 502, data: { error: "no_base_ok" } };
  return { base: last.base || "(none)", status: last.status || 502, data: last.data || { error: "no_base_ok", results } };
}

// ============== Utilidades simples para front-testing ==============
router.get("/selftest", async (_req, res) => {
  try {
    // Probamos GET a la raíz de la primera base
    const base = fallbackBases[0];
    const r = await fetch(base + "/", { headers: authHeaders() });
    const ct = String(r.headers.get("content-type") || "");
    const raw = await r.text();
    let sample = raw;
    try { if (ct.includes("application/json")) sample = JSON.parse(raw); } catch {}
    res.json({
      base,
      auth: !!A2E_API_KEY,
      status: r.status,
      content_type: ct,
      sample: sample && typeof sample === "string" ? sample.slice(0, 400) : sample
    });
  } catch (e) {
    res.status(500).json({ error: "selftest_failed", detail: String(e && e.message || e) });
  }
});

router.get("/avatars", async (_req, res) => {
  // Doc A2E: /api/v1/streaming-avatar/all_avatars
  const r = await tryFetchJsonAcrossBases("GET", "/api/v1/streaming-avatar/all_avatars");
  return res.status(r.status || 500).json(r.data);
});

// ============== Token (Agora) ==============
router.post("/token", async (req, res) => {
  try {
    const { avatar_id, expire_seconds = 60 } = req.body || {};
    if (!avatar_id) return res.status(400).json({ error: "missing_avatar_id" });

    const r = await tryFetchJsonAcrossBases("POST", "/api/v1/streaming-avatar/agora-token", {
      avatar_id,
      expire_seconds: Math.max(15, Math.min(3600, Number(expire_seconds) || 60))
    });

    return res.status(r.status || 500).json(r.data);
  } catch (e) {
    return res.status(500).json({ error: "a2e_token_failed", detail: String(e && e.message || e) });
  }
});

// ============== Hablar ==============
router.post("/talk", async (req, res) => {
  try {
    // Doc A2E: /api/v1/streaming-avatar/talk
    // payload típico: { channel, text, lang?, voice? }
    const { channel, text, lang = "es", voice = "male_neutral" } = req.body || {};
    if (!channel || !text) return res.status(400).json({ error: "missing_fields" });

    const r = await tryFetchJsonAcrossBases("POST", "/api/v1/streaming-avatar/talk", {
      channel, text, lang, voice
    });
    return res.status(r.status || 500).json(r.data);
  } catch (e) {
    return res.status(500).json({ error: "a2e_talk_failed", detail: String(e && e.message || e) });
  }
});

// ============== Cerrar sala (dejar de consumir) ==============
router.post("/leave", async (req, res) => {
  try {
    // Doc A2E: /api/v1/streaming-avatar/leave-room
    // payload: { channel, uid }
    const { channel, uid } = req.body || {};
    if (!channel || !uid) return res.status(400).json({ error: "missing_fields" });

    const r = await tryFetchJsonAcrossBases("POST", "/api/v1/streaming-avatar/leave-room", { channel, uid });
    return res.status(r.status || 500).json(r.data);
  } catch (e) {
    return res.status(500).json({ error: "a2e_leave_failed", detail: String(e && e.message || e) });
  }
});

module.exports = router;
