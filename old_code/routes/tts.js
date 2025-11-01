// routes/tts.js
const express = require("express");
const router = express.Router();

// Usa fetch nativo (Node 18+). Si quieres compatibilidad con Node <18, descomenta:
// const fetch = global.fetch || ((...a) => import("node-fetch").then(({default: f}) => f(...a)));

const API_BASE = "https://api.elevenlabs.io/v1";
const DEFAULT_MODEL = process.env.ELEVEN_MODEL || "eleven_multilingual_v2";
// Voz fallback conocida (Rachel). Puedes cambiarla por otra pública si prefieres.
const FALLBACK_VOICE_ID = process.env.ELEVEN_VOICE_FALLBACK || "21m00Tcm4TlvDq8ikWAM";

function getKey() {
  return process.env.ELEVEN_API_KEY || "";
}
function keyPreview(k) {
  return k ? `${k.slice(0, 4)}… (${k.length} chars)` : "";
}
function cfgVoiceId() {
  return process.env.ELEVEN_VOICE_ID || "";
}

// --- Utilidad: verifica si una voz existe / es accesible con tu key ---
async function checkVoiceExists(apiKey, voiceId) {
  try {
    const r = await fetch(`${API_BASE}/voices/${encodeURIComponent(voiceId)}`, {
      method: "GET",
      headers: { "xi-api-key": apiKey, Accept: "application/json" },
    });
    if (r.status === 404) return false;
    return r.ok;
  } catch {
    return false;
  }
}

// --- Selftest: comprueba key y disponibilidad de la voz configurada ---
router.get("/selftest", async (_req, res) => {
  const apiKey = getKey();
  const hasKey = !!apiKey;
  const voiceId = cfgVoiceId();
  let voiceOk = false;

  if (hasKey && voiceId) {
    voiceOk = await checkVoiceExists(apiKey, voiceId);
  }

  res.json({
    ok: hasKey,
    hasKey,
    keyPreview: keyPreview(apiKey),
    model: DEFAULT_MODEL,
    voiceId: voiceId || "(none)",
    voiceOk: voiceId ? voiceOk : null,
    fallbackVoice: FALLBACK_VOICE_ID,
  });
});

// --- Llamada al TTS upstream (una voz) ---
async function callTTS({ apiKey, voiceId, text }) {
  const url = `${API_BASE}/text-to-speech/${encodeURIComponent(
    voiceId
  )}?optimize_streaming_latency=0&output_format=mp3_44100_128`;

  const body = {
    text: String(text || ""),
    model_id: DEFAULT_MODEL,
    voice_settings: {
      stability: Number(process.env.ELEVEN_STABILITY ?? 0.4),
      similarity_boost: Number(process.env.ELEVEN_SIMILARITY ?? 0.8),
      style: Number(process.env.ELEVEN_STYLE ?? 0.1),
      use_speaker_boost: process.env.ELEVEN_SPK_BOOST === "false" ? false : true,
    },
  };

  const r = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify(body),
  });

  return r;
}

// --- Endpoint principal: POST /api/tts ---
router.post("/", async (req, res) => {
  try {
    const apiKey = getKey();
    if (!apiKey) return res.status(501).json({ error: "elevenlabs_key_missing" });

    const { text, voiceId } = req.body || {};
    const t = String(text || "").trim();
    if (!t) return res.status(400).json({ error: "missing_text" });

    // 1) Primer intento con voiceId de la petición o el configurado (si hay), si no, directamente con fallback
    const firstVoice = (voiceId || cfgVoiceId() || FALLBACK_VOICE_ID).trim();

    let r = await callTTS({ apiKey, voiceId: firstVoice, text: t });

    // 2) Si la voz no existe (404), intenta con la voz fallback
    if (r.status === 404 && firstVoice !== FALLBACK_VOICE_ID) {
      console.warn(`[TTS] Voice not found (${firstVoice}). Falling back to ${FALLBACK_VOICE_ID}`);
      r = await callTTS({ apiKey, voiceId: FALLBACK_VOICE_ID, text: t });
      if (!r.ok) {
        const detail = await r.text().catch(() => "");
        return res
          .status(r.status)
          .json({ error: "elevenlabs_upstream_after_fallback", detail: detail?.slice(0, 1200) || "" });
      }
      const ab = await r.arrayBuffer();
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("X-TTS-Fallback", "1");
      return res.send(Buffer.from(ab));
    }

    // 3) Cualquier otro error upstream
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      return res
        .status(r.status)
        .json({ error: "elevenlabs_upstream", detail: detail?.slice(0, 1200) || "" });
    }

    // 4) OK normal
    const ab = await r.arrayBuffer();
    res.setHeader("Content-Type", "audio/mpeg");
    return res.send(Buffer.from(ab));
  } catch (e) {
    console.error("TTS error:", e);
    return res.status(500).json({ error: "tts_failed" });
  }
});

module.exports = router;
