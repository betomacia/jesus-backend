// routes/avatar.js — Avatar Propio con GPU L4
const express = require("express");
const fetch = require("node-fetch");

const router = express.Router();

// Configuración del servidor de avatar
const AVATAR_SERVER_URL = process.env.AVATAR_SERVER_URL || "http://localhost:8765";
const AVATAR_API_KEY = process.env.AVATAR_API_KEY || "";

// ElevenLabs para TTS (reutilizamos la integración existente)
const ELEVEN_API_KEY = process.env.ELEVENLABS_API_KEY || process.env.ELEVEN_API_KEY || "";
const ELEVEN_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || process.env.ELEVEN_VOICE_ID || "";
const ELEVEN_MODEL_ID = process.env.ELEVEN_MODEL_ID || "eleven_flash_v2_5";

// Headers para el avatar server
function avatarHeaders() {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (AVATAR_API_KEY) {
    headers.Authorization = `Bearer ${AVATAR_API_KEY}`;
  }
  return headers;
}

/* =========================================================
   SELFTEST - Verificar que el servidor de avatar está activo
   ========================================================= */
router.get("/selftest", async (_req, res) => {
  try {
    const r = await fetch(`${AVATAR_SERVER_URL}/health`, {
      headers: avatarHeaders(),
    });
    const data = await r.json().catch(() => ({}));

    res.status(r.ok ? 200 : r.status).json({
      status: r.status,
      avatar_server: AVATAR_SERVER_URL,
      server_status: data,
      tts_configured: ELEVEN_API_KEY ? "yes" : "no",
    });
  } catch (e) {
    res.status(500).json({
      status: 500,
      avatar_server: AVATAR_SERVER_URL,
      error: String(e && e.message) || String(e),
    });
  }
});

/* =========================================================
   STATUS - Estado detallado del servidor
   ========================================================= */
router.get("/status", async (_req, res) => {
  try {
    const r = await fetch(`${AVATAR_SERVER_URL}/status`, {
      headers: avatarHeaders(),
    });
    const data = await r.json().catch(() => ({}));

    res.status(r.ok ? 200 : r.status).json(data);
  } catch (e) {
    res.status(500).json({
      error: "status_failed",
      detail: String(e && e.message) || String(e),
    });
  }
});

/* =========================================================
   1) CREAR STREAM
   POST /api/avatar/streams
   Body: { portrait_id: "jesus_1" } o { portrait_path: "/path/to/portrait.jpg" }
   ========================================================= */
router.post("/streams", async (req, res) => {
  try {
    const { portrait_id, portrait_path } = req.body || {};

    // Por defecto usar el portrait de Jesús
    const payload = {
      portrait_id: portrait_id || "jesus_default",
      portrait_path: portrait_path || undefined,
    };

    const r = await fetch(`${AVATAR_SERVER_URL}/streams`, {
      method: "POST",
      headers: avatarHeaders(),
      body: JSON.stringify(payload),
    });

    const data = await r.json().catch(() => ({}));

    if (!r.ok) {
      console.error("[AVATAR] stream create failed:", data);
      return res.status(r.status).json({
        error: "stream_create_failed",
        detail: data,
      });
    }

    // Retornar en formato compatible con D-ID
    res.json({
      id: data.id,
      session_id: data.session_id,
      offer: data.offer,
      created_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error("[AVATAR] stream create error:", e);
    res.status(500).json({
      error: "stream_create_error",
      detail: String(e && e.message) || String(e),
    });
  }
});

/* =========================================================
   2) ENVIAR SDP ANSWER
   POST /api/avatar/streams/:id/sdp
   Body: { answer: {...}, session_id: "sess_xxx" }
   ========================================================= */
router.post("/streams/:id/sdp", async (req, res) => {
  try {
    const { id } = req.params;
    const { answer, session_id } = req.body || {};

    if (!id || !answer) {
      return res.status(400).json({ error: "missing_fields" });
    }

    const r = await fetch(`${AVATAR_SERVER_URL}/streams/${id}/sdp`, {
      method: "POST",
      headers: avatarHeaders(),
      body: JSON.stringify({ answer, session_id }),
    });

    const data = await r.json().catch(() => ({}));

    res.status(r.ok ? 200 : r.status).json(data);
  } catch (e) {
    console.error("[AVATAR] sdp error:", e);
    res.status(500).json({
      error: "sdp_failed",
      detail: String(e && e.message) || String(e),
    });
  }
});

/* =========================================================
   3) ENVIAR ICE CANDIDATE
   POST /api/avatar/streams/:id/ice
   Body: { candidate: "...", sdpMid: "...", session_id: "sess_xxx" }
   ========================================================= */
router.post("/streams/:id/ice", async (req, res) => {
  try {
    const { id } = req.params;
    const { candidate, sdpMid, sdpMLineIndex, session_id } = req.body || {};

    if (!id || !candidate) {
      return res.status(400).json({ error: "missing_fields" });
    }

    const r = await fetch(`${AVATAR_SERVER_URL}/streams/${id}/ice`, {
      method: "POST",
      headers: avatarHeaders(),
      body: JSON.stringify({ candidate, sdpMid, sdpMLineIndex, session_id }),
    });

    const data = await r.json().catch(() => ({}));

    res.status(r.ok ? 200 : r.status).json(data);
  } catch (e) {
    console.error("[AVATAR] ice error:", e);
    res.status(500).json({
      error: "ice_failed",
      detail: String(e && e.message) || String(e),
    });
  }
});

/* =========================================================
   3b) OBTENER ICE REMOTO (GET)
   GET /api/avatar/streams/:id/ice?session_id=...
   ========================================================= */
router.get("/streams/:id/ice", async (req, res) => {
  try {
    const { id } = req.params;
    const { session_id } = req.query || {};

    if (!id) {
      return res.status(400).json({ error: "missing_id" });
    }

    const url = `${AVATAR_SERVER_URL}/streams/${id}/ice?session_id=${
      encodeURIComponent(String(session_id || ""))
    }`;

    const r = await fetch(url, {
      method: "GET",
      headers: avatarHeaders(),
    });

    const data = await r.json().catch(() => ({ candidates: [] }));

    res.status(r.ok ? 200 : r.status).json(data);
  } catch (e) {
    console.error("[AVATAR] ice get error:", e);
    res.status(200).json({ candidates: [] });
  }
});

/* =========================================================
   4) HABLAR (talk)
   POST /api/avatar/streams/:id/talk
   Body: {
     session_id: "sess_xxx",
     script: {
       type: "text",
       input: "Hola, soy Jesús",
       provider: {...}  // opcional, usa ElevenLabs por defecto
     }
   }
   ========================================================= */
router.post("/streams/:id/talk", async (req, res) => {
  try {
    const { id } = req.params;
    let { session_id, script } = req.body || {};

    if (!id || !script) {
      return res.status(400).json({ error: "missing_fields" });
    }

    // Si es texto, primero convertir a audio con ElevenLabs
    if (script.type === "text" && script.input) {
      try {
        const audioUrl = await generateTTS(script.input, script.provider);
        // Cambiar script a tipo audio
        script = {
          type: "audio",
          audio_url: audioUrl,
        };
      } catch (ttsError) {
        console.error("[AVATAR] TTS error:", ttsError);
        return res.status(500).json({
          error: "tts_failed",
          detail: String(ttsError && ttsError.message) || String(ttsError),
        });
      }
    }

    // Enviar al servidor de avatar
    const r = await fetch(`${AVATAR_SERVER_URL}/streams/${id}/talk`, {
      method: "POST",
      headers: avatarHeaders(),
      body: JSON.stringify({ session_id, script }),
    });

    const data = await r.json().catch(() => ({}));

    res.status(r.ok ? 200 : r.status).json(data);
  } catch (e) {
    console.error("[AVATAR] talk error:", e);
    res.status(500).json({
      error: "talk_failed",
      detail: String(e && e.message) || String(e),
    });
  }
});

/* =========================================================
   5) CERRAR STREAM
   DELETE /api/avatar/streams/:id
   Body: { session_id: "sess_xxx" }
   ========================================================= */
router.delete("/streams/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { session_id } = req.body || {};

    if (!id) {
      return res.status(400).json({ error: "missing_id" });
    }

    const r = await fetch(`${AVATAR_SERVER_URL}/streams/${id}`, {
      method: "DELETE",
      headers: avatarHeaders(),
      body: JSON.stringify({ session_id }),
    });

    const data = await r.json().catch(() => ({}));

    res.status(r.ok ? 200 : r.status).json(data);
  } catch (e) {
    console.error("[AVATAR] delete error:", e);
    res.status(500).json({
      error: "delete_failed",
      detail: String(e && e.message) || String(e),
    });
  }
});

/* =========================================================
   HELPER: Generar TTS con ElevenLabs
   ========================================================= */
async function generateTTS(text, providerConfig) {
  if (!ELEVEN_API_KEY) {
    throw new Error("ELEVENLABS_API_KEY not configured");
  }

  const voiceId = providerConfig?.voice_id || ELEVEN_VOICE_ID;
  const modelId = providerConfig?.voice_config?.model_id || ELEVEN_MODEL_ID;

  if (!voiceId) {
    throw new Error("voice_id not configured");
  }

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`;

  const payload = {
    text: text,
    model_id: modelId,
    voice_settings: {
      stability: providerConfig?.voice_config?.stability ?? 0.5,
      similarity_boost: providerConfig?.voice_config?.similarity_boost ?? 0.75,
      style: 0.0,
      use_speaker_boost: true,
    },
  };

  const r = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVEN_API_KEY,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify(payload),
  });

  if (!r.ok) {
    const errorText = await r.text().catch(() => "");
    throw new Error(`ElevenLabs TTS failed: ${r.status} ${errorText}`);
  }

  // Retornar URL del audio generado
  // En producción, guardar en S3/CDN y retornar URL pública
  // Por ahora, generar data URL (base64)
  const buffer = await r.arrayBuffer();
  const base64 = Buffer.from(buffer).toString("base64");
  return `data:audio/mpeg;base64,${base64}`;
}

module.exports = router;
