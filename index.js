// routes/did.js
const express = require("express");
const router = express.Router();
const nodeFetch = require("node-fetch");
require("dotenv").config();

const _fetch = (...args) =>
  (globalThis.fetch ? globalThis.fetch(...args) : nodeFetch(...args));

/* ========= ENV ========= */
const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL ||
  "https://jesus-backend-production-1cf4.up.railway.app";

const DID_API_KEY = process.env.DID_API_KEY || "";
const DID_USER    = process.env.DID_USERNAME || "";
const DID_PASS    = process.env.DID_PASSWORD || "";

const EL_API_KEY  = process.env.ELEVENLABS_API_KEY || "";
const EL_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "";

/* ========= Selección dinámica de base D-ID =========
   - API key -> v1
   - USER/PASS -> legacy (sin /v1)
*/
function didBase() {
  return DID_API_KEY ? "https://api.d-id.com/v1" : "https://api.d-id.com";
}
function creditsUrl() {
  return DID_API_KEY ? "https://api.d-id.com/v1/credits" : "https://api.d-id.com/credits";
}

/* ========= Helpers de auth D-ID ========= */
function didHeaders() {
  const h = { "Content-Type": "application/json", Accept: "application/json" };
  if (DID_API_KEY) {
    // API Key -> Basic base64("API_KEY:")
    h.Authorization = "Basic " + Buffer.from(`${DID_API_KEY}:`).toString("base64");
    h["X-DID-Auth-Mode"] = "API_KEY";
  } else if (DID_USER && DID_PASS) {
    // Legacy USER/PASS -> Basic base64("user:pass")
    h.Authorization = "Basic " + Buffer.from(`${DID_USER}:${DID_PASS}`).toString("base64");
    h["X-DID-Auth-Mode"] = "USER_PASS";
  } else {
    h["X-DID-Auth-Mode"] = "MISSING";
  }
  return h;
}

/* ========= Selftest credenciales ========= */
router.get("/selftest", async (_req, res) => {
  try {
    const r = await _fetch(creditsUrl(), { headers: didHeaders() });
    const data = await r.json().catch(() => ({}));
    const mode = didHeaders()["X-DID-Auth-Mode"];
    console.log("[DID] selftest status:", r.status, "auth:", mode, "base:", didBase());
    return res.status(r.ok ? 200 : r.status).json({ status: r.status, authMode: mode, base: didBase(), data });
  } catch (e) {
    console.error("[DID] selftest error", e);
    return res.status(500).json({ error: "selftest_failed" });
  }
});

/* ========= Crear stream (offer + ice) ========= */
router.post("/streams", async (req, res) => {
  try {
    const { source_url } = req.body || {};
    const payload = {
      source_url:
        source_url ||
        "https://raw.githubusercontent.com/betomacia/jesus-backend/main/public/JESPANOL.jpeg",
    };

    const r = await _fetch(`${didBase()}/talks/streams`, {
      method: "POST",
      headers: didHeaders(),
      body: JSON.stringify(payload),
    });
    const createJson = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error("[DID] offer_failed", r.status, createJson);
      return res.status(r.status).json({ error: "offer_failed", detail: createJson });
    }

    const r2 = await _fetch(`${didBase()}/talks/streams/${createJson.id}`, {
      method: "GET",
      headers: didHeaders(),
    });
    const sdpJson = await r2.json().catch(() => ({}));
    if (!r2.ok) {
      console.error("[DID] sdp_fetch_failed", r2.status, sdpJson);
      return res.status(r2.status).json({ error: "sdp_fetch_failed", detail: sdpJson });
    }

    console.log("[DID] stream created:", createJson.id, "auth:", didHeaders()["X-DID-Auth-Mode"]);
    return res.json({
      id: createJson.id,
      session_id: createJson.session_id,
      offer: sdpJson.offer,
      ice_servers: sdpJson.ice_servers || [],
    });
  } catch (e) {
    console.error("[DID] streams error", e);
    return res.status(500).json({ error: "streams_failed" });
  }
});

/* ========= Enviar ANSWER (SDP) ========= */
router.post("/streams/:id/sdp", async (req, res) => {
  try {
    const { id } = req.params;
    const { answer, session_id } = req.body || {};
    if (!id || !session_id || !answer || !answer.sdp || !answer.type) {
      return res.status(400).json({ error: "missing_fields" });
    }

    const r = await _fetch(`${didBase()}/talks/streams/${id}/sdp`, {
      method: "POST",
      headers: didHeaders(),
      body: JSON.stringify({ answer, session_id }),
    });

    const data = await r.json().catch(() => ({}));
    return res.status(r.ok ? 200 : r.status).json(data);
  } catch (e) {
    console.error("[DID] sdp post error", e);
    return res.status(500).json({ error: "sdp_failed" });
  }
});

/* ========= Enviar ICE ========= */
router.post("/streams/:id/ice", async (req, res) => {
  try {
    const { id } = req.params;
    const { candidate, session_id } = req.body || {};
    if (!id || !session_id || !candidate) {
      return res.status(400).json({ error: "missing_fields" });
    }

    const r = await _fetch(`${didBase()}/talks/streams/${id}/ice`, {
      method: "POST",
      headers: didHeaders(),
      body: JSON.stringify({ candidate, session_id }),
    });

    const data = await r.json().catch(() => ({}));
    return res.status(r.ok ? 200 : r.status).json(data);
  } catch (e) {
    console.error("[DID] ice post error", e);
    return res.status(500).json({ error: "ice_failed" });
  }
});

/* ========= Cache in-memory de MP3 (para D-ID) ========= */
const ttsCache = new Map(); // key -> { buf:Buffer, len:number, ctype:string, ts:number }
function makeKey(text) {
  const raw = Buffer.from(`${EL_VOICE_ID}|${text}`, "utf8").toString("base64");
  return raw.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/,"");
}

/* Sirve el MP3 con Content-Length (GET/HEAD) */
router.all("/tts-cache/:key", async (req, res) => {
  const { key } = req.params || {};
  const item = key ? ttsCache.get(key) : null;
  if (!item) return res.status(404).end();

  res.setHeader("Content-Type", item.ctype || "audio/mpeg");
  res.setHeader("Content-Length", String(item.len));
  res.setHeader("Cache-Control", "public, max-age=600");
  res.setHeader("Accept-Ranges", "bytes");

  if (req.method === "HEAD") return res.status(200).end();
  return res.status(200).end(item.buf);
});

/* Genera MP3 completo (no stream) desde ElevenLabs */
async function elevenMp3Buffer(text) {
  if (!EL_API_KEY || !EL_VOICE_ID) throw new Error("missing_elevenlabs_env");
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${EL_VOICE_ID}`;
  const r = await _fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": EL_API_KEY,
      "Content-Type": "application/json",
      "Accept": "audio/mpeg",
    },
    body: JSON.stringify({
      text: String(text).slice(0, 5000),
      model_id: "eleven_multilingual_v2",
      voice_settings: {
        stability: 0.3,
        similarity_boost: 0.7,
        style: 0,
        use_speaker_boost: false,
      },
    }),
  });
  if (!r.ok) {
    const body = await r.text().catch(()=> "");
    throw new Error(`elevenlabs_failed ${r.status}: ${body}`);
  }
  const buf = await r.buffer(); // node-fetch v2
  return buf;
}

/* ========= Talk (texto o audio_url) =========
   Intercepta audio_url de /api/tts?text=...  -> genera MP3 con Content-Length
============================================ */
router.post("/streams/:id/talk", async (req, res) => {
  try {
    const { id } = req.params;
    let { session_id, script } = req.body || {};
    if (!id || !session_id || !script) {
      return res.status(400).json({ error: "missing_fields" });
    }

    // Interceptar cuando el front-end pasa nuestro /api/tts?text=...
    if (script.type === "audio" && typeof script.audio_url === "string") {
      try {
        const u = new URL(script.audio_url, PUBLIC_BASE_URL);
        if (u.pathname.startsWith("/api/tts") && u.searchParams.get("text")) {
          const text = decodeURIComponent(u.searchParams.get("text"));
          console.log("[DID] Intercept audio_url -> generar MP3 fijo (len) len(text)=", text.length);

          const buf = await elevenMp3Buffer(text);
          const key = makeKey(text);
          ttsCache.set(key, { buf, len: buf.length, ctype: "audio/mpeg", ts: Date.now() });

          const cachedUrl = `${PUBLIC_BASE_URL}/api/did/tts-cache/${key}`;
          script = { type: "audio", audio_url: cachedUrl };
          console.log("[DID] audio_url reescrito a", cachedUrl);
        }
      } catch (e) {
        console.warn("[DID] no se pudo interceptar audio_url, sigo con el original:", e.message);
      }
    }

    const r = await _fetch(`${didBase()}/talks/streams/${id}`, {
      method: "POST",
      headers: didHeaders(),
      body: JSON.stringify({ session_id, script }),
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) console.error("[DID] talk failed", r.status, data);
    return res.status(r.ok ? 200 : r.status).json(data);
  } catch (e) {
    console.error("[DID] talk error", e);
    return res.status(500).json({ error: "talk_failed", detail: String(e.message || e) });
  }
});

module.exports = router;
