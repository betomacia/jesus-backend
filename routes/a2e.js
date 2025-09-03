// routes/a2e.js — A2E Streaming Avatar (token + avatars)
// Usa la API oficial de A2E:
//  - GET  /api/v1/streaming-avatar/all_avatars
//  - POST /api/v1/streaming-avatar/agora-token

const express = require("express");
const nodeFetch = require("node-fetch");

const router = express.Router();
const fetch = (...args) => nodeFetch(...args);

// ====== Config ======
const A2E_BASE = (process.env.A2E_BASE || "https://video.a2e.ai").replace(/\/+$/, "");
const A2E_API_KEY = process.env.A2E_API_KEY || "";

// headers Bearer
function a2eHeaders(extra = {}) {
  const h = { Accept: "application/json", "Content-Type": "application/json", ...extra };
  if (A2E_API_KEY) h.Authorization = `Bearer ${A2E_API_KEY}`;
  return h;
}

// ====== Selftest (ya lo tenías OK) ======
router.get("/selftest", async (_req, res) => {
  try {
    const r = await fetch(`${A2E_BASE}/`, { method: "GET" });
    const ct = r.headers.get("content-type") || "";
    const ok = r.ok;
    const txt = await r.text().catch(() => "");
    let sample = txt.slice(0, 400);
    try {
      if (/json/i.test(ct)) sample = JSON.parse(txt);
    } catch {}
    res.status(200).json({
      base: A2E_BASE,
      auth: !!A2E_API_KEY,
      status: r.status,
      content_type: ct,
      sample
    });
  } catch (e) {
    res.status(500).json({ error: "selftest_failed", detail: String(e && e.message || e) });
  }
});

// ====== Avatares disponibles ======
router.get("/avatars", async (_req, res) => {
  try {
    if (!A2E_API_KEY) {
      return res.status(400).json({ error: "missing_A2E_API_KEY" });
    }
    const url = `${A2E_BASE}/api/v1/streaming-avatar/all_avatars`;
    const r = await fetch(url, { method: "GET", headers: a2eHeaders() });
    const txt = await r.text().catch(() => "");
    let data = null; try { data = JSON.parse(txt); } catch {}
    return res.status(r.ok ? 200 : r.status).json(data ?? { raw: txt });
  } catch (e) {
    return res.status(500).json({ error: "a2e_avatars_failed", detail: String(e && e.message || e) });
  }
});

// ====== Token para Streaming Avatar (Agora) ======
/**
 * Body esperado:
 * {
 *   "avatar_id": "xxxxxxxxxxxxxxxxxxxx",   // REQUERIDO por A2E
 *   "expire_seconds": 60                    // opcional (default 60)
 * }
 * Respuesta (A2E):
 * {
 *   code: 0,
 *   data: { token, appId, channel, uid, expire_epoch_timestamp, expire_date_UTC },
 *   trace_id: "..."
 * }
 */
router.post("/token", async (req, res) => {
  try {
    if (!A2E_API_KEY) {
      return res.status(400).json({ error: "missing_A2E_API_KEY" });
    }
    const { avatar_id, expire_seconds } = req.body || {};
    if (!avatar_id) {
      return res.status(400).json({ error: "missing_avatar_id" });
    }

    const url = `${A2E_BASE}/api/v1/streaming-avatar/agora-token`;
    const payload = { avatar_id, expire_seconds: expire_seconds ?? 60 };

    const r = await fetch(url, {
      method: "POST",
      headers: a2eHeaders(),
      body: JSON.stringify(payload)
    });

    const txt = await r.text().catch(() => "");
    let data = null; try { data = JSON.parse(txt); } catch {}

    return res.status(r.ok ? 200 : r.status).json(data ?? { raw: txt });
  } catch (e) {
    return res.status(500).json({ error: "a2e_token_failed", detail: String(e && e.message || e) });
  }
});

module.exports = router;
