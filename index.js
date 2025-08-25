// ===============================
// /api/tts-openai-stream (robusto)
// ===============================
const { OpenAI } = require("openai");
const { PassThrough } = require("stream");
const http = require("http");
const https = require("https");

// keep-alive para conexiones largas
const httpAgent  = new http.Agent({ keepAlive: true, maxSockets: 50 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });

const openai = new OpenAI({
  apiKey: (process.env.OPENAI_API_KEY || "").trim(),
  // forzamos keep-alive
  baseURL: process.env.OPENAI_BASE_URL || undefined,
  // el SDK usa fetch, pero algunos entornos respetan globalAgents:
  // no es obligatorio, pero ayuda con proxys y KA.
});

app.get("/api/tts-openai-stream", async (req, res) => {
  try {
    const text = String(req.query.text || "");
    const voice = String(req.query.voice || "verse");
    const lang = String(req.query.lang || "es");
    const format = String(req.query.format || "mp3"); // mp3|wav|opus

    if (!text.trim()) return res.status(400).json({ error: "no_text" });
    if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_API_KEY.trim())
      return res.status(500).json({ error: "missing_openai_key" });

    // Cabeceras de audio chunked
    res.setHeader("Content-Type", format === "wav" ? "audio/wav" : format === "opus" ? "audio/ogg" : "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Transfer-Encoding", "chunked");
    // Importante: forzar envío temprano de cabeceras
    if (res.flushHeaders) res.flushHeaders();

    // Llamada a OpenAI TTS (model y api pueden variar; ajusta al que uses)
    // Model recomendado actual (ajusta si usas otro):
    const model = process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts"; // o "gpt-4o-realtime-preview"
    // Formato de respuesta:
    const audioFormat = format === "wav" ? "wav" : format === "opus" ? "opus" : "mp3";

    // Usamos low-level fetch del SDK para obtener WebStream (evita buffers grandes)
    const response = await openai.audio.speech.create({
      model,
      voice,          // "verse", "alloy", etc.
      input: text,
      format: audioFormat, // "mp3" | "wav" | "opus"
      language: lang  // opcional, según modelo
    }, {
      fetch: (url, opts) => {
        // inyectar agentes keep-alive
        return fetch(url, { ...opts, agent: (url.startsWith("https:") ? httpsAgent : httpAgent) });
      },
    });

    // Algunos SDKs devuelven un ArrayBuffer; otros un Response con body web-stream
    // Normalizamos a Node Stream:
    const body = response.body || response; // por compatibilidad
    const passthrough = new PassThrough();

    // Si es WebStream con getReader:
    if (body && typeof body.getReader === "function") {
      const reader = body.getReader();
      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) passthrough.write(Buffer.from(value));
          }
          passthrough.end();
        } catch (e) {
          console.error("[tts-openai-stream] web reader error", e);
          passthrough.destroy(e);
        }
      })();
    } else if (body && typeof body.pipe === "function") {
      // Node readable
      body.pipe(passthrough);
      body.on("error", (e) => {
        console.error("[tts-openai-stream] pipe error", e);
        passthrough.destroy(e);
      });
    } else if (body && Buffer.isBuffer(body)) {
      // ya es un buffer completo (no ideal, pero sirve)
      passthrough.end(body);
    } else if (response.arrayBuffer) {
      // fallback total
      const ab = await response.arrayBuffer();
      passthrough.end(Buffer.from(ab));
    } else {
      // sin cuerpo
      return res.status(502).json({ error: "no_stream_body" });
    }

    // Pipe al cliente (chunked)
    passthrough.pipe(res);
    passthrough.on("error", (e) => {
      console.error("[tts-openai-stream] passthrough error", e);
      if (!res.headersSent) res.status(500).end();
      else res.end();
    });

  } catch (err) {
    console.error("tts-openai-stream fatal:", err?.message || err);
    if (!res.headersSent) {
      const msg = (err && err.message) || "";
      return res.status(502).json({ error: "openai_tts_failed", detail: msg });
    }
    try { res.end(); } catch {}
  }
});
