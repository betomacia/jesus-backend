// routes/a2e.js — Proxy A2E Streaming Avatar (Agora)
const express = require("express");
const nodeFetch = require("node-fetch");
const router = express.Router();
const fetch = (...args) => nodeFetch(...args);

// === ENV ===
const A2E_BASE = process.env.A2E_BASE || "https://video.a2e.ai";
const A2E_API_KEY = process.env.A2E_API_KEY || "";
const A2E_AVATAR_ID = process.env.A2E_AVATAR_ID || "";

// Helpers
function a2eHeaders() {
  if (!A2E_API_KEY) throw new Error("Missing A2E_API_KEY");
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${A2E_API_KEY}`,
  };
}

// Selftest
router.get("/selftest", async (_req, res) => {
  try {
    // ping light: no endpoint “ping”, probamos path público
    res.json({
      ok: true,
      base: A2E_BASE,
      avatarDefault: !!A2E_AVATAR_ID,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/* =========================================================
   1) TOKEN (Agora)
   POST /api/a2e/token { avatar_id?, expire_seconds? }
   -> POST {A2E_BASE}/api/v1/streaming-avatar/agora-token
   ========================================================= */
router.post("/token", async (req, res) => {
  try {
    const { avatar_id, expire_seconds } = req.body || {};
    const body = {
      avatar_id: avatar_id || A2E_AVATAR_ID,
      expire_seconds: Math.max(60, Math.min(+expire_seconds || 600, 7200)),
    };
    const r = await fetch(`${A2E_BASE}/api/v1/streaming-avatar/agora-token`, {
      method: "POST",
      headers: a2eHeaders(),
      body: JSON.stringify(body),
    });
    const txt = await r.text().catch(() => "");
    let data = null; try { data = JSON.parse(txt); } catch {}
    return res.status(r.ok ? 200 : r.status).json(data ?? { raw: txt });
  } catch (e) {
    return res.status(500).json({ error: "token_failed", detail: String(e?.message || e) });
  }
});

/* =========================================================
   2) SPEAK (texto → TTS + labios en A2E)
   POST /api/a2e/speak { channel, text }
   -> POST {A2E_BASE}/api/v1/streaming-avatar/speak
   ========================================================= */
router.post("/speak", async (req, res) => {
  try {
    const { channel, text } = req.body || {};
    if (!channel || !text) return res.status(400).json({ error: "missing_fields" });
    const r = await fetch(`${A2E_BASE}/api/v1/streaming-avatar/speak`, {
      method: "POST",
      headers: a2eHeaders(),
      body: JSON.stringify({ channel, text }),
    });
    const txt = await r.text().catch(() => "");
    let data = null; try { data = JSON.parse(txt); } catch {}
    return res.status(r.ok ? 200 : r.status).json(data ?? { raw: txt });
  } catch (e) {
    return res.status(500).json({ error: "speak_failed", detail: String(e?.message || e) });
  }
});

/* =========================================================
   3) LEAVE (cerrar sala)
   POST /api/a2e/leave { channel }
   -> POST {A2E_BASE}/api/v1/streaming-avatar/leave-room
   ========================================================= */
router.post("/leave", async (req, res) => {
  try {
    const { channel } = req.body || {};
    if (!channel) return res.status(400).json({ error: "missing_channel" });
    const r = await fetch(`${A2E_BASE}/api/v1/streaming-avatar/leave-room`, {
      method: "POST",
      headers: a2eHeaders(),
      body: JSON.stringify({ channel }),
    });
    const txt = await r.text().catch(() => "");
    let data = null; try { data = JSON.parse(txt); } catch {}
    return res.status(r.ok ? 200 : r.status).json(data ?? { raw: txt });
  } catch (e) {
    return res.status(500).json({ error: "leave_failed", detail: String(e?.message || e) });
  }
});

module.exports = router;
