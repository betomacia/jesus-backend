// routes/did.js
const express = require("express");
const router = express.Router();
const nodeFetch = require("node-fetch");
const crypto = require("crypto");

const _fetch = (...args) =>
  (globalThis.fetch ? globalThis.fetch(...args) : nodeFetch(...args));

/* ====== ENV ====== */
const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL ||
  "https://jesus-backend-production-1cf4.up.railway.app";

const DID_API_KEY = process.env.DID_API_KEY || "";
const DID_USER = process.env.DID_USERNAME || "";
const DID_PASS = process.env.DID_PASSWORD || "";

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "";
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "";

/* ====== Modo de auth y base ====== */
function didAuthMode() {
  if (DID_API_KEY) return "API_KEY";
  if (DID_USER && DID_PASS) return "USER_PASS";
  return "MISSING";
}
function didBase() {
  // v1 para API KEY; legacy base para USER_PASS
  return didAuthMode() === "API_KEY" ? "https://api.d-id.com/v1" : "https://api.d-id.com";
}

/* ====== Cabeceras ====== */
function didHeaders() {
  const h = { "Content-Type": "application/json", Accept: "application/json" };
  if (DID_API_KEY) {
    // Soporta "simple" o "usuario:token"
    const raw = DID_API_KEY.includes(":") ? DID_API_KEY : `${DID_API_KEY}:`;
    const basic = Buffer.from(raw).toString("base64");
    h.Authorization = `Basic ${basic}`;
    h["X-DID-Auth-Mode"] = "API_KEY";
  } else if (DID_USER && DID_PASS) {
    h.Authorization = "Basic " + Buffer.from(`${DID_USER}:${DID_PASS}`).toString("base64");
    h["X-DID-Auth-Mode"] = "USER_PASS";
  } else {
    console.warn("[DID] WARN: faltan credenciales DID");
    h["X-DID-Auth-Mode"] = "MISSING";
  }
  return h;
}

console.log(
  `[BOOT] DID auth mode: ${didAuthMode()} base: ${didBase()} public: ${PUBLIC_BASE_URL}`
);

/* ====== Cache de MP3 para D-ID (Content-Length) ====== */
const ttsCache = new Map(); // key -> Buffer

async function generateMp3BufferFromText(text) {
  if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) {
    throw new Error("missing_elevenlabs_env");
  }
  const url =
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream` +
    `?optimize_streaming_latency=4&output_format=mp3_22050_32`;

  const r = await _fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVENLABS_API_KEY,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
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
    const txt = await r.text().catch(() => "");
    throw new Error(`elevenlabs_failed ${r.status} ${txt}`);
  }

  // Soportar global fetch (arrayBuffer) y node-fetch v2 (buffer)
  if (typeof r.arrayBuffer === "function") {
    const ab = await r.arrayBuffer();
    return Buffer.from(ab);
  } else if (typeof r.buffer === "function") {
    return await r.buffer();
  } else {
    // fallback stream→buffer
    const chunks = [];
    return await new Promise((resolve, reject) => {
      r.body.on("data", (c) => chunks.push(c));
      r.body.on("end", () => resolve(Buffer.concat(chunks)));
      r.body.on("error", reject);
    });
  }
}

// Sirve el MP3 con Content-Length (D-ID lo requiere)
router.get("/tts-cache/:key", async (req, res) => {
  const key = req.params.key;
  const buf = ttsCache.get(key);
  if (!buf) return res.status(404).json({ error: "not_found" });

  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Content-Length", String(buf.length));
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.end(buf);
});

/* ====== Selftest y créditos ====== */
router.get("/selftest", async (_req, res) => {
  try {
    const base = didBase();
    const r = await _fetch(`${base}/credits`, { headers: didHeaders() });
    const data = await r.json().catch(() => ({}));
    return res.status(r.status).json({
      status: r.status,
      authMode: didAuthMode(),
      base,
      data,
    });
  } catch (e) {
    return res.status(500).json({ status: 500, authMode: didAuthMode(), error: String(e) });
  }
});

router.get("/credits", async (_req, res) => {
  try {
    const base = didBase();
    const r = await _fetch(`${base}/credits`, { headers: didHeaders() });
    const data = await r.json().catch(() => ({}));
    return res.status(r.ok ? 200 : r.status).json(data);
  } catch (e) {
    console.error("credits error", e);
    return res.status(500).json({ error: "credits_failed" });
  }
});

/* ====== Crear stream WebRTC ====== */
router.post("/streams", async (req, res) => {
  try {
    const { source_url } = req.body || {};
    const src =
      source_url ||
      "https://raw.githubusercontent.com/betomacia/jesus-backend/main/public/JESPANOL.jpeg";

    const base = didBase();
    const h = didHeaders();

    // 1) Crear el stream
    const createResponse = await _fetch(`${base}/talks/streams`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ source_url: src }),
    });

    const createJson = await createResponse.json().catch(() => ({}));
    if (!createResponse.ok) {
      console.error("[DID] streams create failed", createResponse.status, createJson);
      return res.status(createResponse.status).json({ error: "streams_create_failed", detail: createJson });
    }

    // 2) Obtener oferta/ICE (en algunos planes viene directo en el create; lo pedimos igual)
    const sdpResponse = await _fetch(`${base}/talks/streams/${createJson.id}`, {
      method: "GET",
      headers: h,
    });

    const sdpJson = await sdpResponse.json().catch(() => ({}));
    if (!sdpResponse.ok) {
      console.error("[DID] sdp fetch failed", sdpResponse.status, sdpJson);
      return res.status(sdpResponse.status).json({ error: "sdp_fetch_failed", detail: sdpJson });
    }

    console.log(`[DID] stream created: ${createJson.id} auth: ${didAuthMode()}`);

    return res.json({
      id: createJson.id,
      session_id: createJson.session_id,
      offer: sdpJson.offer || createJson.offer,
      ice_servers: sdpJson.ice_servers || createJson.ice_servers || [],
    });
  } catch (e) {
    console.error("streams error", e);
    return res.status(500).json({ error: "streams_failed" });
  }
});

/* ====== Enviar SDP de answer ====== */
router.post("/streams/:id/sdp", async (req, res) => {
  try {
    const { id } = req.params;
    const { answer, session_id } = req.body || {};
    if (!id || !answer || !session_id) {
      return res.status(400).json({ error: "missing_fields" });
    }

    const base = didBase();
    const r = await _fetch(`${base}/talks/streams/${id}/sdp`, {
      method: "POST",
      headers: didHeaders(),
      body: JSON.stringify({ answer, session_id }),
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error("[DID] send sdp failed", r.status, data);
      return res.status(r.status).json({ error: "sdp_failed", detail: data });
    }
    return res.json(data);
  } catch (e) {
    console.error("sdp post error", e);
    return res.status(500).json({ error: "sdp_failed" });
  }
});

/* ====== Enviar ICE candidate ====== */
router.post("/streams/:id/ice", async (req, res) => {
  try {
    const { id } = req.params;
    const { candidate, session_id } = req.body || {};
    if (!id || !candidate || !session_id) {
      return res.status(400).json({ error: "missing_fields" });
    }

    const base = didBase();
    await _fetch(`${base}/talks/streams/${id}/ice`, {
      method: "POST",
      headers: didHeaders(),
      body: JSON.stringify({ candidate, session_id }),
    }).catch((e) => {
      console.warn("ice post warn", String(e));
    });

    return res.json({ ok: true });
  } catch (e) {
    console.error("ice post error", e);
    return res.status(500).json({ error: "ice_failed" });
  }
});

/* ====== TALK (text/audio) con intercept para audio_url ====== */
router.post("/streams/:id/talk", async (req, res) => {
  try {
    const { id } = req.params;
    const { session_id, script } = req.body || {};
    if (!id || !session_id || !script || !script.type) {
      return res.status(400).json({ error: "missing_fields" });
    }

    let payload = { session_id, script };

    // Interceptar audio_url y convertirlo a MP3 cacheado con Content-Length
    if (script.type === "audio" && typeof script.audio_url === "string") {
      try {
        const u = new URL(script.audio_url, PUBLIC_BASE_URL);
        // solo interceptamos si apunta a nuestro /api/tts?text=...
        if (/\/api\/tts$/i.test(u.pathname) && u.searchParams.get("text")) {
          const text = u.searchParams.get("text") || "";
          console.log(`[DID] Intercept audio_url -> generar MP3 fijo (len) len(text)=${text.length}`);

          const buf = await generateMp3BufferFromText(text);
          const key = crypto.createHash("sha1").update(text + "|" + ELEVENLABS_VOICE_ID).digest("hex");
          ttsCache.set(key, buf);

          const rewritten = `${PUBLIC_BASE_URL}/api/did/tts-cache/${key}`;
          payload = {
            session_id,
            script: { type: "audio", audio_url: rewritten },
          };
          console.log(`[DID] audio_url reescrito a ${rewritten}`);
        }
      } catch (e) {
        console.warn("[DID] intercept audio_url warning:", String(e));
      }
    }

    const base = didBase();
    const r = await _fetch(`${base}/talks/streams/${id}`, {
      method: "POST",
      headers: didHeaders(),
      body: JSON.stringify(payload),
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error("[DID] talk failed", r.status, data);
      return res.status(r.status).json({ error: "talk_failed", detail: data });
    }
    return res.json(data);
  } catch (e) {
    console.error("talk error", e);
    return res.status(500).json({ error: "talk_failed" });
  }
});

module.exports = router;
