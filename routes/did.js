// routes/did.js
// Router D-ID: streams WebRTC + SDP/ICE + talk-stream (TTS Microsoft)
// Requiere variables de entorno:
//   DID_API_KEY  (o DID_USERNAME / DID_PASSWORD)

const express = require("express");
const nodeFetch = require("node-fetch"); // v2
const router = express.Router();

const fetch = (...args) => nodeFetch(...args);

// ===== ENV =====
const DID_API_KEY = process.env.DID_API_KEY || "";
const DID_USER = process.env.DID_USERNAME || "";
const DID_PASS = process.env.DID_PASSWORD || "";

// ===== Headers helper =====
function didHeaders(extra = {}) {
  const h = {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...extra,
  };
  if (DID_API_KEY) {
    h.Authorization = "Basic " + Buffer.from(`${DID_API_KEY}:`).toString("base64");
  } else if (DID_USER && DID_PASS) {
    h.Authorization = "Basic " + Buffer.from(`${DID_USER}:${DID_PASS}`).toString("base64");
  } else {
    console.warn("[D-ID] Faltan credenciales: DID_API_KEY o DID_USERNAME/DID_PASSWORD");
  }
  return h;
}

// ===== Voz por idioma (Microsoft Neural, tono “narration-relaxed”) =====
function voiceForLang(lang = "es") {
  const map = {
    es: { voice_id: "es-ES-AlvaroNeural", style: "narration-relaxed" },
    en: { voice_id: "en-US-GuyNeural", style: "narration-relaxed" },
    pt: { voice_id: "pt-BR-AntonioNeural", style: "narration-relaxed" },
    it: { voice_id: "it-IT-DiegoNeural", style: "narration-relaxed" },
    de: { voice_id: "de-DE-ConradNeural", style: "narration-relaxed" },
  };
  return map[lang] || map.es;
}

/* ============================================================================
   POST /api/did/streams
   Crea un stream WebRTC con una imagen (source_url) para recibir audio+video
============================================================================ */
router.post("/streams", async (req, res) => {
  try {
    const { source_url } = req.body || {};
    if (!source_url) {
      return res.status(400).json({ error: "missing_source_url" });
    }

    const payload = {
      source_url,
      // Opcionalmente puedes fijar resolución/fps/voice_config aquí.
      // config: { stitch: true }
    };

    const r = await fetch("https://api.d-id.com/talks/streams", {
      method: "POST",
      headers: didHeaders(),
      body: JSON.stringify(payload),
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error("D-ID create stream error", r.status, data);
      return res.status(r.status).json(data);
    }

    // Esperamos: { id, session_id, offer, ice_servers, ... }
    return res.json({
      id: data.id,
      session_id: data.session_id,
      offer: data.offer,
      ice_servers: data.ice_servers || [],
    });
  } catch (e) {
    console.error("streams create error", e);
    return res.status(500).json({ error: "streams_create_failed", detail: String(e?.message || e) });
  }
});

/* ============================================================================
   POST /api/did/streams/:id/sdp
   Envía la ANSWER del cliente al stream
============================================================================ */
router.post("/streams/:id/sdp", async (req, res) => {
  try {
    const { id } = req.params || {};
    const { answer, session_id } = req.body || {};
    if (!id || !session_id || !answer) {
      return res.status(400).json({ error: "missing_fields" });
    }

    const payload = { session_id, answer };

    const r = await fetch(`https://api.d-id.com/talks/streams/${id}/sdp`, {
      method: "POST",
      headers: didHeaders(),
      body: JSON.stringify(payload),
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error("D-ID SDP error", r.status, data);
      return res.status(r.status).json(data);
    }

    return res.json(data);
  } catch (e) {
    console.error("sdp post error", e);
    return res.status(500).json({ error: "sdp_failed", detail: String(e?.message || e) });
  }
});

/* ============================================================================
   POST /api/did/streams/:id/ice
   Envía un ICE candidate al stream
============================================================================ */
router.post("/streams/:id/ice", async (req, res) => {
  try {
    const { id } = req.params || {};
    const { candidate, session_id } = req.body || {};
    if (!id || !session_id || !candidate) {
      return res.status(400).json({ error: "missing_fields" });
    }

    const payload = { session_id, candidate };

    const r = await fetch(`https://api.d-id.com/talks/streams/${id}/ice`, {
      method: "POST",
      headers: didHeaders(),
      body: JSON.stringify(payload),
    });

    // D-ID puede devolver 204/empty en algunos casos
    let data = {};
    try { data = await r.json(); } catch {}
    if (!r.ok) {
      console.error("D-ID ICE error", r.status, data);
      return res.status(r.status).json(data);
    }

    return res.json(data || { ok: true });
  } catch (e) {
    console.error("ice post error", e);
    return res.status(500).json({ error: "ice_failed", detail: String(e?.message || e) });
  }
});

/* ============================================================================
   POST /api/did/talk-stream
   Inyecta TEXTO -> TTS Microsoft (voz suave) al stream activo (boca/voz)
   body: { id, session_id, text, lang? }
============================================================================ */
router.post("/talk-stream", async (req, res) => {
  try {
    const { id, session_id, text, lang } = req.body || {};
    if (!id || !session_id || !text || !String(text).trim()) {
      return res.status(400).json({ error: "missing_fields" });
    }

    const prov = voiceForLang(String(lang || "es").toLowerCase());

    const payload = {
      session_id,
      script: {
        type: "text",
        input: String(text).slice(0, 5000),
        provider: {
          type: "microsoft",
          voice_id: prov.voice_id,
          // Si tu cuenta no soporta "style", coméntalo:
          style: prov.style,
        },
      },
    };

    const r = await fetch(`https://api.d-id.com/talks/streams/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: didHeaders(),
      body: JSON.stringify(payload),
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error("D-ID talk-stream error", r.status, data);
      return res.status(r.status).json(data);
    }

    return res.json(data);
  } catch (e) {
    console.error("talk-stream fatal", e);
    return res.status(500).json({ error: "talk_stream_failed", detail: String(e?.message || e) });
  }
});

module.exports = router;
