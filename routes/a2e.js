// routes/a2e.js — Proxy A2E (Agora + Direct Speak)
// Requiere env:
//   A2E_BASE=https://video.a2e.ai
//   A2E_API_KEY=BearerTokenDeA2E
//
// Endpoints expuestos por tu backend:
//   GET  /api/a2e/selftest            -> prueba base y auth
//   GET  /api/a2e/avatars             -> lista avatares de A2E
//   POST /api/a2e/token               -> pide token Agora (appId, channel, token, uid)
//   POST /api/a2e/talk                -> Direct Speak (manda texto al avatar)

const express = require("express");
const fetch = (...args) => import("node-fetch").then(({default: f}) => f(...args));

const router = express.Router();

// ========= Config =========
const A2E_BASE = (process.env.A2E_BASE || "").replace(/\/+$/, ""); // ej: https://video.a2e.ai
const A2E_API_KEY = process.env.A2E_API_KEY || "";

// modo auth (normalmente bearer)
const A2E_AUTH_MODE = (process.env.A2E_AUTH_MODE || "bearer").toLowerCase();
const A2E_API_KEY_HEADER = process.env.A2E_API_KEY_HEADER || "Authorization";

// Endpoints reales de A2E (configurables)
const A2E_AVATARS_PATH = process.env.A2E_AVATARS_PATH || "/api/v1/streaming-avatar/all_avatars";
const A2E_TOKEN_PATH   = process.env.A2E_TOKEN_PATH   || "/api/v1/streaming-avatar/agora-token";
// Direct Speak: dejamos 2 candidatos comunes y probamos en orden
const A2E_SPEAK_PATHS  = (process.env.A2E_SPEAK_PATHS || "/api/v1/streaming-avatar/direct-speak,/api/v1/streaming-avatar/speak")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// ========= Helpers =========
function a2eHeaders(extra={}) {
  const h = { Accept: "application/json", "Content-Type": "application/json", ...extra };
  if (A2E_AUTH_MODE === "bearer" && A2E_API_KEY) {
    h[A2E_API_KEY_HEADER] = `Bearer ${A2E_API_KEY}`;
  } else if (A2E_AUTH_MODE === "x-api-key" && A2E_API_KEY) {
    h["x-api-key"] = A2E_API_KEY;
  }
  return h;
}
function mustBaseOK(res) {
  if (!A2E_BASE) {
    res.status(500).json({ error: "A2E_BASE_missing", hint: "Define A2E_BASE" });
    return false;
  }
  return true;
}
const join = (b, p) => `${b}${p.startsWith("/") ? "" : "/"}${p}`;

// ========= Health / auto-test =========
router.get("/selftest", async (_req, res) => {
  try {
    if (!mustBaseOK(res)) return;
    const r = await fetch(join(A2E_BASE, "/"), { method: "GET", headers: a2eHeaders() });
    const txt = await r.text().catch(() => "");
    res.json({
      base: A2E_BASE,
      auth: !!A2E_API_KEY,
      status: r.status,
      content_type: r.headers.get("content-type") || "",
      sample: txt.slice(0, 240)
    });
  } catch (e) {
    res.status(500).json({ error: "selftest_failed", detail: String(e?.message || e) });
  }
});

// ========= Avatares =========
router.get("/avatars", async (_req, res) => {
  try {
    if (!mustBaseOK(res)) return;
    const r = await fetch(join(A2E_BASE, A2E_AVATARS_PATH), { method: "GET", headers: a2eHeaders() });
    const txt = await r.text().catch(() => "");
    let data = null; try { data = JSON.parse(txt); } catch {}
    res.status(r.ok ? 200 : r.status).json(data ?? { raw: txt });
  } catch (e) {
    res.status(500).json({ error: "avatars_failed", detail: String(e?.message || e) });
  }
});

// ========= Token Agora =========
router.post("/token", async (req, res) => {
  try {
    if (!mustBaseOK(res)) return;
    const { avatar_id, expire_seconds = 60 } = req.body || {};
    if (!avatar_id) return res.status(400).json({ error: "missing_avatar_id" });

    const r = await fetch(join(A2E_BASE, A2E_TOKEN_PATH), {
      method: "POST",
      headers: a2eHeaders(),
      body: JSON.stringify({ avatar_id, expire_seconds })
    });
    const txt = await r.text().catch(() => "");
    let data = null; try { data = JSON.parse(txt); } catch {}

    // A2E suele devolver { code, data?, msg? } con 200 aunque haya error
    if (r.ok) {
      if (data && typeof data.code === "number" && data.code !== 0) {
        return res.status(502).json(data);
      }
      return res.json(data ?? { raw: txt });
    }
    return res.status(r.status).json(data ?? { raw: txt });
  } catch (e) {
    res.status(500).json({ error: "token_failed", detail: String(e?.message || e) });
  }
});

// ========= Direct Speak =========
// Front te llamará a /api/a2e/talk { text, lang? }
// Probamos contra la primera ruta válida en A2E_SPEAK_PATHS
router.post("/talk", async (req, res) => {
  try {
    if (!mustBaseOK(res)) return;
    const { text, lang } = req.body || {};
    if (!text) return res.status(400).json({ error: "missing_text" });

    let lastErr = null;
    for (const p of A2E_SPEAK_PATHS) {
      try {
        const r = await fetch(join(A2E_BASE, p), {
          method: "POST",
          headers: a2eHeaders(),
          body: JSON.stringify({ text, lang })
        });
        const txt = await r.text().catch(() => "");
        let data = null; try { data = JSON.parse(txt); } catch {}

        if (r.ok) {
          // De nuevo, A2E suele empaquetar {code,msg}
          if (data && typeof data.code === "number" && data.code !== 0) {
            lastErr = data;
            continue;
          }
          return res.json(data ?? { raw: txt });
        } else {
          lastErr = data ?? { raw: txt, status: r.status };
        }
      } catch (e) {
        lastErr = { error: "speak_attempt_failed", detail: String(e?.message || e), path: p };
        // probamos siguiente
      }
    }
    return res.status(502).json(lastErr || { error: "all_speak_paths_failed" });
  } catch (e) {
    res.status(500).json({ error: "talk_failed", detail: String(e?.message || e) });
  }
});

module.exports = router;
