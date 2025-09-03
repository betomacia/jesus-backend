// routes/a2e.js — Proxy A2E Streaming Avatar (con Agora) alineado con docs oficiales
// Endpoints A2E usados:
//   - GET  /api/v1/streaming-avatar/all_avatars
//   - POST /api/v1/streaming-avatar/agora-token   (=> { token, appId, channel, uid, ... })
//   - POST /api/v1/streaming-avatar/speak         (body: { channel, text })
//   - POST /api/v1/streaming-avatar/leave         (body: { channel })

const express = require("express");
const nodeFetch = require("node-fetch");

const router = express.Router();
const fetch = (...args) => nodeFetch(...args);

// ===== Config =====
const A2E_BASE = (process.env.A2E_BASE || "https://video.a2e.ai").replace(/\/+$/, "");
const A2E_API_KEY = process.env.A2E_API_KEY || "";
const A2E_TOKEN_TTL = Number(process.env.A2E_TOKEN_TTL || 3600); // segundos

// (Opcional) mapear avatar por idioma si no mandas avatarId desde el front:
const AV_BY_LANG = {
  es: process.env.A2E_AVATAR_ID_ES || "",
  en: process.env.A2E_AVATAR_ID_EN || "",
  pt: process.env.A2E_AVATAR_ID_PT || "",
  it: process.env.A2E_AVATAR_ID_IT || "",
  de: process.env.A2E_AVATAR_ID_DE || "",
  ca: process.env.A2E_AVATAR_ID_CA || "",
};

function a2eHeaders(extra = {}) {
  const h = { Accept: "application/json", "Content-Type": "application/json", ...extra };
  if (A2E_API_KEY) h.Authorization = `Bearer ${A2E_API_KEY}`;
  return h;
}
function needKey(res) {
  if (!A2E_API_KEY) {
    res.status(500).json({ error: "A2E_API_KEY_missing", hint: "Configura A2E_API_KEY en Railway" });
    return false;
  }
  return true;
}

// ---------- Selftest ----------
router.get("/selftest", async (_req, res) => {
  try {
    const r = await fetch(`${A2E_BASE}/`, { method: "GET" });
    const txt = await r.text().catch(() => "");
    res.status(r.ok ? 200 : r.status).json({
      base: A2E_BASE,
      auth: !!A2E_API_KEY,
      status: r.status,
      content_type: r.headers.get("content-type") || "",
      sample: txt.slice(0, 220)
    });
  } catch (e) {
    res.status(500).json({ error: "selftest_failed", detail: String(e && e.message || e) });
  }
});

// ---------- Listar avatares ----------
router.get("/avatars", async (_req, res) => {
  if (!needKey(res)) return;
  try {
    const url = `${A2E_BASE}/api/v1/streaming-avatar/all_avatars`;
    const r = await fetch(url, { headers: a2eHeaders() });
    const txt = await r.text().catch(() => "");
    let data = null; try { data = JSON.parse(txt); } catch {}
    res.status(r.ok ? 200 : r.status).json(data ?? { raw: txt });
  } catch (e) {
    res.status(500).json({ error: "avatars_failed", detail: String(e && e.message || e) });
  }
});

// ---------- Obtener token de streaming (Agora) ----------
router.post("/token", async (req, res) => {
  if (!needKey(res)) return;
  try {
    const { avatarId, avatar_id, lang, expire_seconds } = req.body || {};
    const chosen =
      (avatarId || avatar_id || (lang ? AV_BY_LANG[String(lang)] : "") || "").trim();

    if (!chosen) {
      return res.status(400).json({
        error: "missing_avatar_id",
        hint: "Pasa avatarId en el body o configura A2E_AVATAR_ID_<LANG> en el backend"
      });
    }

    const body = {
      avatar_id: chosen,
      expire_seconds: Number(expire_seconds || A2E_TOKEN_TTL || 60)
    };
    const url = `${A2E_BASE}/api/v1/streaming-avatar/agora-token`;
    const r = await fetch(url, { method: "POST", headers: a2eHeaders(), body: JSON.stringify(body) });
    const txt = await r.text().catch(() => "");
    let data = null; try { data = JSON.parse(txt); } catch {}

    // Esperado data: { token, appId, channel, uid, ... }
    return res.status(r.ok ? 200 : r.status).json(data ?? { raw: txt });
  } catch (e) {
    res.status(500).json({ error: "token_failed", detail: String(e && e.message || e) });
  }
});

// ---------- Hacer hablar al avatar (en el canal) ----------
router.post("/speak", async (req, res) => {
  if (!needKey(res)) return;
  try {
    const { channel, text } = req.body || {};
    if (!channel || !text) return res.status(400).json({ error: "missing_fields", need: ["channel","text"] });

    const url = `${A2E_BASE}/api/v1/streaming-avatar/speak`;
    const r = await fetch(url, {
      method: "POST",
      headers: a2eHeaders(),
      body: JSON.stringify({ channel, text })
    });
    const txt = await r.text().catch(() => "");
    let data = null; try { data = JSON.parse(txt); } catch {}
    res.status(r.ok ? 200 : r.status).json(data ?? { raw: txt });
  } catch (e) {
    res.status(500).json({ error: "speak_failed", detail: String(e && e.message || e) });
  }
});

// ---------- Salir del canal ----------
router.post("/leave", async (req, res) => {
  if (!needKey(res)) return;
  try {
    const { channel } = req.body || {};
    if (!channel) return res.status(400).json({ error: "missing_channel" });

    const url = `${A2E_BASE}/api/v1/streaming-avatar/leave`;
    const r = await fetch(url, {
      method: "POST",
      headers: a2eHeaders(),
      body: JSON.stringify({ channel })
    });
    const txt = await r.text().catch(() => "");
    let data = null; try { data = JSON.parse(txt); } catch {}
    res.status(r.ok ? 200 : r.status).json(data ?? { raw: txt });
  } catch (e) {
    res.status(500).json({ error: "leave_failed", detail: String(e && e.message || e) });
  }
});

module.exports = router;
