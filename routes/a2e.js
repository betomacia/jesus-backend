// routes/a2e.js — A2E Streaming Avatar (Agora) con fallback US↔CN y reintentos
// Endpoints:
//   GET  /api/a2e/selftest
//   GET  /api/a2e/avatars
//   POST /api/a2e/token         { avatar_id, expire_seconds?=60 }
//   POST /api/a2e/talk          { channel, text, lang?, voice? }
//   POST /api/a2e/leave         { channel, uid }
//
// ENV requeridas:
//   A2E_API_KEY   -> Bearer *** (de tu cuenta A2E)
//   (opcional) A2E_BASES  -> CSV de bases en orden de preferencia
//           ej: "https://video.a2e.com.cn,https://video.a2e.ai"
//   (opcional) A2E_BASE   -> base única (si no usas A2E_BASES)

const express = require("express");
const nodeFetch = require("node-fetch");
const router = express.Router();
const fetch = (...args) => nodeFetch(...args);

// === Config ===
const A2E_API_KEY = process.env.A2E_API_KEY || "";

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

// Intenta la llamada en varias bases y con reintentos si code=1001 (capacidad ocupada)
async function tryFetchJsonAcrossBases(method, path, bodyObj = null, opts = {}) {
  const bodiestr = bodyObj ? JSON.stringify(bodyObj) : undefined;
  const maxRetriesPerBase = opts.maxRetriesPerBase ?? 1; // 0/1/2 reintentos rápidos
  const delay = (ms) => new Promise(r => setTimeout(r, ms));

  for (const base of fallbackBases) {
    const url = `${base}${path.startsWith("/") ? "" : "/"}${path}`;
    let attempt = 0;

    while (attempt <= maxRetriesPerBase) {
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

        const ok = r.ok && (!data || data.code === undefined || data.code === 0);
        if (ok) {
          return { base, status: r.status, data: data ?? raw, ok: true };
        }

        // Manejo de saturación (code 1001): reintento en la MISMA base o pasar a la siguiente
        const code = data && typeof data.code === "number" ? data.code : null;
        if (code === 1001) {
          if (attempt < maxRetriesPerBase) {
            await delay(400 + attempt * 300);
            attempt++;
            continue; // reintenta misma base
          }
          // pasar a la siguiente base
          break;
        }

        // 5xx: probar siguiente base
        if (r.status >= 500) break;

        // 4xx distinto a 1001 -> devolver tal cual
        return { base, status: r.status, data: data ?? raw, ok: false };
      } catch (e) {
        // error de red: siguiente base
        break;
      }
    }
    // probamos siguiente base
  }
  return { base: "(none)", status: 502, data: { code: -1, msg: "no_base_ok" }, ok: false };
}

// ============== Utilidades para probar ==============
router.get("/selftest", async (_req, res) => {
  try {
    const base = fallbackBases[0];
    const r = await fetch(base + "/", { headers: authHeaders() });
    const ct = String(r.headers.get("content-type") || "");
    const raw = await r.text();
    let sample = raw;
    try { if (ct.includes("application/json")) sample = JSON.parse(raw); } catch {}
    res.json({
      bases: fallbackBases,
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
  const r = await tryFetchJsonAcrossBases("GET", "/api/v1/streaming-avatar/all_avatars");
  return res.status(r.status || 500).json({
    ...r.data,
    __meta: { used_base: r.base, ok: r.ok }
  });
});

// ============== Token (Agora) ==============
router.post("/token", async (req, res) => {
  try {
    const { avatar_id, expire_seconds = 60 } = req.body || {};
    if (!avatar_id) return res.status(400).json({ error: "missing_avatar_id" });

    const r = await tryFetchJsonAcrossBases(
      "POST",
      "/api/v1/streaming-avatar/agora-token",
      {
        avatar_id,
        expire_seconds: Math.max(15, Math.min(300, Number(expire_seconds) || 60)) // cap a 5 min
      },
      { maxRetriesPerBase: 1 }
    );

    return res.status(r.status || 500).json({
      ...r.data,
      __meta: { used_base: r.base, ok: r.ok }
    });
  } catch (e) {
    return res.status(500).json({ error: "a2e_token_failed", detail: String(e && e.message || e) });
  }
});

// ============== Hablar ==============
router.post("/talk", async (req, res) => {
  try {
    const { channel, text, lang = "es", voice = "male_neutral" } = req.body || {};
    if (!channel || !text) return res.status(400).json({ error: "missing_fields" });

    const r = await tryFetchJsonAcrossBases(
      "POST",
      "/api/v1/streaming-avatar/talk",
      { channel, text, lang, voice }
    );
    return res.status(r.status || 500).json({
      ...r.data,
      __meta: { used_base: r.base, ok: r.ok }
    });
  } catch (e) {
    return res.status(500).json({ error: "a2e_talk_failed", detail: String(e && e.message || e) });
  }
});

// ============== Cerrar sala (liberar monedas) ==============
router.post("/leave", async (req, res) => {
  try {
    const { channel, uid } = req.body || {};
    if (!channel || !uid) return res.status(400).json({ error: "missing_fields" });

    const r = await tryFetchJsonAcrossBases(
      "POST",
      "/api/v1/streaming-avatar/leave-room",
      { channel, uid }
    );
    return res.status(r.status || 500).json({
      ...r.data,
      __meta: { used_base: r.base, ok: r.ok }
    });
  } catch (e) {
    return res.status(500).json({ error: "a2e_leave_failed", detail: String(e && e.message || e) });
  }
});

module.exports = router;
