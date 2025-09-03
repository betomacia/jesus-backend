// routes/a2e.js — Tokens para Agora (A2E) + endpoints de diagnóstico
const express = require("express");
const { RtcTokenBuilder, RtcRole } = require("agora-access-token");

const router = express.Router();

// Lee las variables de entorno (acepta alias)
const AGORA_APP_ID =
  process.env.AGORA_APP_ID ||
  process.env.AGORA_APPID ||
  "";

const AGORA_APP_CERTIFICATE =
  process.env.AGORA_APP_CERTIFICATE ||
  process.env.AGORA_APP_CERT ||
  "";

const TOKEN_TTL_SECONDS = Number(process.env.A2E_TOKEN_TTL || 3600);

// Utilidad simple para canal/uid
function randChannel() {
  return "jesus-" + Math.random().toString(36).slice(2, 10);
}
function randUid() {
  // Agora Web SDK NG suele usar enteros 1..2^31-1
  return Math.floor(1 + Math.random() * 2147483646);
}

// --- Diagnóstico mínimo
router.get("/ping", (_req, res) => {
  res.json({ ok: true, service: "a2e", time: Date.now() });
});

// --- Diagnóstico de config
router.get("/selftest", (_req, res) => {
  const okId = Boolean(AGORA_APP_ID);
  const okCert = Boolean(AGORA_APP_CERTIFICATE);
  res.status(okId && okCert ? 200 : 500).json({
    ok: okId && okCert,
    hasAppId: okId,
    hasCert: okCert,
    appIdSampleLen: AGORA_APP_ID ? AGORA_APP_ID.length : 0,
    ttlSeconds: TOKEN_TTL_SECONDS,
    note: okId && okCert
      ? "Config OK"
      : "Faltan variables AGORA_APP_ID y/o AGORA_APP_CERTIFICATE"
  });
});

// --- Emisión de token
// body opcional: { channel?: string, uid?: number, lang?: "es"|..., avatarUrl?: string }
router.post("/token", async (req, res) => {
  try {
    if (!AGORA_APP_ID || !AGORA_APP_CERTIFICATE) {
      return res.status(500).json({
        error: "missing_env",
        detail: "Debes configurar AGORA_APP_ID y AGORA_APP_CERTIFICATE en Railway."
      });
    }

    const { channel: chIn, uid: uidIn } = req.body || {};
    const channel = (chIn && String(chIn).trim()) || randChannel();
    const uid = Number.isInteger(uidIn) ? uidIn : randUid();

    const role = RtcRole.PUBLISHER;
    const now = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs = now + TOKEN_TTL_SECONDS;

    const token = RtcTokenBuilder.buildTokenWithUid(
      AGORA_APP_ID,
      AGORA_APP_CERTIFICATE,
      channel,
      uid,
      role,
      privilegeExpiredTs
    );

    return res.json({
      appId: AGORA_APP_ID,
      channel,
      uid,
      token,
      expiresAt: privilegeExpiredTs
    });
  } catch (err) {
    console.error("[A2E] token error:", err && err.message || err);
    return res.status(500).json({
      error: "token_build_failed",
      detail: String(err && err.message || err)
    });
  }
});

module.exports = router;
