// routes/a2e.js — Proxy A2E (COMPLETAR con tu proveedor)
// Debe devolver: { appId, channel, token, uid } en /token
const express = require("express");
const fetch = (...args) => import("node-fetch").then(({default: f}) => f(...args));

const router = express.Router();

const A2E_API_KEY = process.env.A2E_API_KEY || ""; // <-- pon tu API key
const A2E_BASE = process.env.A2E_BASE || "https://api.a2e.example"; // <-- URL base real

// 1) Token / sesión (avatar_url y lang opcionales)
router.post("/token", async (req, res) => {
  try {
    const { avatar_url, lang } = req.body || {};
    // TODO: Llama a tu endpoint A2E de "create/join" y retorna appId/channel/token/uid
    // Debe guardar cualquier sessionId si A2E lo requiere (en memoria por canal)

    // EJEMPLO FICTICIO (reemplaza con A2E real):
    const r = await fetch(`${A2E_BASE}/session/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${A2E_API_KEY}` },
      body: JSON.stringify({ avatar_url, lang })
    });
    if (!r.ok) return res.status(r.status).json({ error: "a2e_session_failed" });
    const data = await r.json();

    // Normaliza nombres esperados por el front:
    return res.json({
      appId: data.appId,
      channel: data.channelName || data.channel,
      token: data.rtcToken || data.token,
      uid: data.uid || data.userId || 0,
    });
  } catch (e) {
    console.error("A2E token error", e);
    res.status(500).json({ error: "a2e_token_error" });
  }
});

// 2) Hablar (texto → TTS avatar en A2E)
router.post("/speak", async (req, res) => {
  try {
    const { channel, text } = req.body || {};
    if (!channel || !text) return res.status(400).json({ error: "missing_fields" });

    // TODO: Llama al endpoint A2E para "speak" en ese canal
    const r = await fetch(`${A2E_BASE}/session/${encodeURIComponent(channel)}/speak`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${A2E_API_KEY}` },
      body: JSON.stringify({ text })
    });
    const txt = await r.text();
    try { return res.status(r.ok ? 200 : r.status).json(JSON.parse(txt)); }
    catch { return res.status(r.ok ? 200 : r.status).send(txt); }
  } catch (e) {
    console.error("A2E speak error", e);
    res.status(500).json({ error: "a2e_speak_error" });
  }
});

// 3) Salir / limpiar
router.post("/leave", async (req, res) => {
  try {
    const { channel } = req.body || {};
    if (!channel) return res.status(400).json({ error: "missing_channel" });

    // TODO: Endpoint de cierre si A2E lo requiere
    // Aquí simplemente respondemos 200
    return res.json({ ok: true });
  } catch (e) {
    console.error("A2E leave error", e);
    res.status(500).json({ error: "a2e_leave_error" });
  }
});

module.exports = router;
