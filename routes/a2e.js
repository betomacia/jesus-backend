// routes/a2e.js — Proxy A2E (avatar) + generación de token RTC de respaldo
const express = require("express");
const fetch = (...a) => import("node-fetch").then(({default: f}) => f(...a));
const { RtcRole, RtcTokenBuilder } = require("agora-access-token");

const router = express.Router();

/* ========= Config por variables de entorno =========
   - A2E_API_KEY:    API key del proveedor de A2E
   - A2E_BASE:       Base URL del proveedor (ej: https://api.a2e.ai) — AJÚSTALA
   - AGORA_APP_ID:   Tu App ID de Agora (solo por si el proveedor no devuelve token)
   - AGORA_APP_CERT: Tu App Certificate de Agora (idem)
*/
const A2E_API_KEY    = process.env.A2E_API_KEY || "";
const A2E_BASE       = (process.env.A2E_BASE || "").replace(/\/+$/,""); // sin slash final
const AGORA_APP_ID   = process.env.AGORA_APP_ID || "";
const AGORA_APP_CERT = process.env.AGORA_APP_CERT || "";

// Helper: headers para llamar al proveedor A2E
function a2eHeaders() {
  const h = { "Content-Type": "application/json", Accept: "application/json" };
  if (A2E_API_KEY) h.Authorization = `Bearer ${A2E_API_KEY}`;
  return h;
}
function log(...a){ try{ console.log("[A2E]", ...a);}catch{} }
function warn(...a){ try{ console.warn("[A2E]", ...a);}catch{} }

// ====== 0) Self-test
router.get("/selftest", async (_req, res) => {
  try {
    const info = { A2E_BASE, hasA2EKey: !!A2E_API_KEY, hasAgora: !!(AGORA_APP_ID && AGORA_APP_CERT) };
    // opcional: ping al proveedor si hay base
    if (A2E_BASE) {
      try {
        const r = await fetch(`${A2E_BASE}/status`, { headers: a2eHeaders() });
        info.upstream = { ok: r.ok, status: r.status };
      } catch (e) { info.upstream = { ok: false, error: String(e && e.message || e) }; }
    }
    res.json({ ok: true, info });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
});

// ====== 1) Crear/obtener credenciales para el avatar (token/join info)
router.post("/token", async (req, res) => {
  try {
    const { avatar_url, lang } = req.body || {};
    // 1A) Si tienes proveedor A2E, intenta crear sesión y obtener join info
    if (A2E_BASE && A2E_API_KEY) {
      try {
        // *** AJUSTA ESTA RUTA SEGÚN TU PROVEEDOR A2E ***
        const r = await fetch(`${A2E_BASE}/v1/sessions`, {
          method: "POST",
          headers: a2eHeaders(),
          body: JSON.stringify({
            avatar_url,
            lang,
            // Opcional: voz/estilo
            voice: { gender: "male", style: "calm_spiritual_neutral" }
          })
        });
        const data = await r.json().catch(() => ({}));
        if (r.ok && data && data.agora) {
          // Esperamos algo así del upstream (ajusta si difiere):
          // data.agora = { appId, channel, token, uid }
          return res.json({
            appId:   data.agora.appId,
            channel: data.agora.channel,
            token:   data.agora.token,
            uid:     data.agora.uid
          });
        } else {
          warn("Upstream /sessions no devolvió agora join info", { status: r.status, data });
        }
      } catch (e) {
        warn("Error creando sesión A2E:", e);
      }
    }

    // 1B) Respaldo: generar token RTC local (no habrá video si el proveedor no publica)
    if (!AGORA_APP_ID || !AGORA_APP_CERT) {
      return res.status(502).json({ error: "no_upstream_and_no_agora", detail: "Configura A2E_BASE/A2E_API_KEY o AGORA_APP_ID/AGORA_APP_CERT" });
    }
    const channel = `a2e_${Date.now().toString(36)}`;
    const uid = 0; // dejar que Agora asigne
    const role = RtcRole.SUBSCRIBER; // client es audiencia
    const expireSeconds = 60 * 60; // 1 hora
    const now = Math.floor(Date.now()/1000);
    const privilegeExpire = now + expireSeconds;
    const token = RtcTokenBuilder.buildTokenWithUid(
      AGORA_APP_ID, AGORA_APP_CERT, channel, uid, role, privilegeExpire
    );
    log("Token RTC local emitido para canal", channel);
    return res.json({ appId: AGORA_APP_ID, channel, token, uid });
  } catch (e) {
    console.error("a2e/token error", e);
    res.status(500).json({ error: "token_failed" });
  }
});

// ====== 2) Enviar texto para que el avatar hable
router.post("/speak", async (req, res) => {
  try {
    const { channel, text } = req.body || {};
    if (!channel || !text) return res.status(400).json({ error: "missing_fields" });

    if (!A2E_BASE || !A2E_API_KEY) {
      // Sin upstream, solo logueamos para depurar
      log("SPEAK (sin upstream):", { channel, text: text.slice(0, 80) });
      return res.json({ ok: true, mocked: true });
    }

    // *** AJUSTA ESTA RUTA SEGÚN TU PROVEEDOR A2E ***
    const r = await fetch(`${A2E_BASE}/v1/sessions/${encodeURIComponent(channel)}/speak`, {
      method: "POST",
      headers: a2eHeaders(),
      body: JSON.stringify({ text })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      warn("Upstream /speak error", r.status, data);
      return res.status(r.status).json(data);
    }
    return res.json(data || { ok: true });
  } catch (e) {
    console.error("a2e/speak error", e);
    res.status(500).json({ error: "speak_failed" });
  }
});

// ====== 3) Terminar sesión/avatar
router.post("/leave", async (req, res) => {
  try {
    const { channel } = req.body || {};
    if (!channel) return res.status(400).json({ error: "missing_channel" });

    if (!A2E_BASE || !A2E_API_KEY) {
      log("LEAVE (sin upstream):", channel);
      return res.json({ ok: true, mocked: true });
    }

    // *** AJUSTA ESTA RUTA SEGÚN TU PROVEEDOR A2E ***
    const r = await fetch(`${A2E_BASE}/v1/sessions/${encodeURIComponent(channel)}`, {
      method: "DELETE",
      headers: a2eHeaders()
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      warn("Upstream /leave error", r.status, data);
      return res.status(r.status).json(data);
    }
    return res.json(data || { ok: true });
  } catch (e) {
    console.error("a2e/leave error", e);
    res.status(500).json({ error: "leave_failed" });
  }
});

module.exports = router;
