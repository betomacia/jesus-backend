// routes/a2e.js — Token server para A2E (Agora RTC)
const express = require("express");
const { RtcTokenBuilder, RtcRole } = require("agora-access-token");
const crypto = require("crypto");

const router = express.Router();

// === Variables de entorno requeridas ===
const AGORA_APP_ID = process.env.AGORA_APP_ID || process.env.A2E_APP_ID || "";
const AGORA_APP_CERTIFICATE = process.env.AGORA_APP_CERTIFICATE || process.env.A2E_APP_CERTIFICATE || "";

// Opcionales
const CHANNEL_PREFIX = process.env.A2E_CHANNEL_PREFIX || "jesus";
const TOKEN_TTL_SECONDS = parseInt(process.env.A2E_TOKEN_TTL_SECONDS || "3600", 10); // 1 hora

function okEnv() {
  return Boolean(AGORA_APP_ID && AGORA_APP_CERTIFICATE);
}

// --- Helpers
function randHex(n = 6) {
  return crypto.randomBytes(Math.ceil(n / 2)).toString("hex").slice(0, n);
}
function randUid() {
  // Agora UID numérico (1 .. 2^31-1). Evita 0.
  return Math.floor(Math.random() * 2147483646) + 1;
}

// === Self test ===
router.get("/selftest", (_req, res) => {
  res.json({
    provider: "a2e",
    hasAppId: !!AGORA_APP_ID,
    hasCert: !!AGORA_APP_CERTIFICATE,
    ttl: TOKEN_TTL_SECONDS,
    prefix: CHANNEL_PREFIX
  });
});

// === Token ===
// Body típico: { avatarUrl?: string, lang?: "es"|"en"|..., channel?: string }
router.post("/token", async (req, res) => {
  try {
    if (!okEnv()) {
      return res.status(500).json({ error: "missing_agora_env", need: ["AGORA_APP_ID", "AGORA_APP_CERTIFICATE"] });
    }

    const { channel: chReq } = req.body || {};
    const channel = (chReq && String(chReq).trim()) || `${CHANNEL_PREFIX}-${randHex(8)}`;
    const uid = randUid();
    const role = RtcRole.PUBLISHER; // queremos enviar/recibir audio/video
    const expireAt = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;

    const token = RtcTokenBuilder.buildTokenWithUid(
      AGORA_APP_ID,
      AGORA_APP_CERTIFICATE,
      channel,
      uid,
      role,
      expireAt
    );

    return res.json({
      provider: "a2e",
      appId: AGORA_APP_ID,
      channel,
      uid,
      token,
      expireAt
    });
  } catch (e) {
    console.error("[A2E] token error", e);
    return res.status(500).json({ error: "a2e_token_failed", detail: String(e && e.message || e) });
  }
});

// (Opcional) endpoint para “hablar” si luego integras TTS del lado servidor
// router.post("/speak", async (req, res) => { ... });

module.exports = router;
