// index.js (CommonJS)

// 1) Carga de variables de entorno (.env)
require("dotenv").config();

// 2) Dependencias
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch"); // v2.x (Node stream), ya está en package.json
const { URL, URLSearchParams } = require("url");

// 3) Config
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

// URL del servidor de voz (tu FastAPI/XTTS)
const VOZ_URL = process.env.VOZ_URL || "http://136.114.108.182:8000";
const PROVIDER_DEFAULT = process.env.PROVIDER_DEFAULT || "xtts";
const FIXED_REF = process.env.FIXED_REF || "jesus2.mp3";

// OpenAI (usaremos la API HTTP directa para evitar ESM)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// ========= Helpers =========
function baseUrlFromReq(req) {
  const proto = (req.headers["x-forwarded-proto"] || req.protocol || "https");
  const host = req.headers["x-forwarded-host"] || req.get("host");
  return `${proto}://${host}`;
}

function ensure(ok, msg = "Bad Request") {
  if (!ok) {
    const err = new Error(msg);
    err.status = 400;
    throw err;
  }
}

function pickFileName(u) {
  try {
    const name = new URL(u).pathname.split("/").pop();
    return name || "";
  } catch {
    return "";
  }
}

// ========= Health =========
app.get("/api/health", async (req, res) => {
  try {
    // ping al upstream /health si existe
    let upstream = null;
    try {
      const r = await fetch(`${VOZ_URL}/health`, { timeout: 8000 });
      upstream = await r.json().catch(() => null);
    } catch (_) {}

    res.json({
      ok: true,
      proxy: "railway",
      voz_url: VOZ_URL,
      provider_default: PROVIDER_DEFAULT,
      fixed_ref: FIXED_REF,
      upstream,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ========= Proxy de audio: /api/tts (stream WAV) =========
// Ejemplo: /api/tts?text=hola&lang=es&rate=1.10
app.get("/api/tts", async (req, res) => {
  try {
    const q = new URLSearchParams();
    if (req.query.text) q.set("text", String(req.query.text));
    if (req.query.lang) q.set("lang", String(req.query.lang));
    if (req.query.rate) q.set("rate", String(req.query.rate));
    // params “extra” que tu front envía, los pasamos tal cual
    if (req.query.temp) q.set("temp", String(req.query.temp));
    if (req.query.fx) q.set("fx", String(req.query.fx));
    if (req.query.provider) q.set("provider", String(req.query.provider));
    if (req.query.t) q.set("t", String(req.query.t));

    const url = `${VOZ_URL}/tts?${q.toString()}`;
    const upstream = await fetch(url, {
      headers: { Accept: "audio/wav" },
    });

    // Encabezados mínimos para WAV
    res.status(upstream.status);
    res.set("Content-Type", upstream.headers.get("content-type") || "audio/wav");
    // Nota: no reenviamos Content-Length para permitir streaming chunked si aplica
    upstream.body.pipe(res);
  } catch (e) {
    res.status(500).send("proxy_tts_error: " + String(e.message || e));
  }
});

// ========= Proxy de audio: /api/tts_save (JSON con /api/files/NAME) =========
app.get("/api/tts_save", async (req, res) => {
  try {
    const q = new URLSearchParams();
    q.set("text", String(req.query.text || "Hola"));
    q.set("lang", String(req.query.lang || "es"));
    if (req.query.rate) q.set("rate", String(req.query.rate));
    if (req.query.temp) q.set("temp", String(req.query.temp));
    if (req.query.fx) q.set("fx", String(req.query.fx));
    if (req.query.provider) q.set("provider", String(req.query.provider));
    if (req.query.t) q.set("t", String(req.query.t));

    const url = `${VOZ_URL}/tts_save?${q.toString()}`;
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    const j = await r.json().catch(() => null);

    ensure(j && j.ok && (j.url || j.file || j.path), "upstream_invalid");

    const upstreamUrl = j.url || j.file || j.path;
    const name = pickFileName(upstreamUrl);
    ensure(name, "filename_missing");

    const base = baseUrlFromReq(req);
    const myUrl = `${base}/api/files/${name}`;

    res.json({ ok: true, url: myUrl, file: myUrl, path: myUrl });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ========= Descarga de archivos: /api/files/:name =========
app.get("/api/files/:name", async (req, res) => {
  try {
    const name = String(req.params.name || "");
    ensure(/^[A-Za-z0-9._-]+$/.test(name), "bad_name");

    const url = `${VOZ_URL}/files/${encodeURIComponent(name)}`;
    const r = await fetch(url);
    if (!r.ok) {
      return res.status(r.status).send("upstream_error");
    }
    res.status(r.status);
    res.set("Content-Type", r.headers.get("content-type") || "audio/wav");
    if (r.headers.get("content-length")) {
      res.set("Content-Length", r.headers.get("content-length"));
    }
    r.body.pipe(res);
  } catch (e) {
    res.status(500).send("files_proxy_error: " + String(e.message || e));
  }
});

// ========= Diagnóstico de latencia: /api/voice/diag =========
// Mide TTFB aprox leyendo el primer chunk del stream
app.get("/api/voice/diag", async (req, res) => {
  const text = String(req.query.text || "hola");
  const lang = String(req.query.lang || "es");

  async function probe(label) {
    const q = new URLSearchParams({ text, lang });
    const url = `${VOZ_URL}/tts?${q.toString()}`;
    const t0 = Date.now();
    try {
      const r = await fetch(url, { headers: { Accept: "audio/wav" } });
      const t1 = Date.now();

      let sampled = 0;
      if (r.ok && r.body) {
        await new Promise((resolve) => {
          let done = false;
          r.body.on("data", (chunk) => {
            if (done) return;
            sampled += chunk.length || 0;
            // con un primer chunk es suficiente para estimar
            done = true;
            resolve();
          });
          r.body.on("end", () => resolve());
          r.body.on("error", () => resolve());
        });
      }
      return {
        ok: r.ok,
        status: r.status,
        connect_ms: t1 - t0,
        first_byte_ms: t1 - t0,
        sampled_bytes: sampled,
        provider_used: label,
      };
    } catch (e) {
      return {
        ok: false,
        status: 0,
        connect_ms: -1,
        first_byte_ms: -1,
        sampled_bytes: 0,
        provider_used: label,
        error: String(e.message || e),
      };
    }
  }

  try {
    const xtts = await probe("xtts");
    // opcionalmente otra “ruta” (si tu upstream cambiara por provider)
    const google = await probe("google"); // hoy apunta igual, solo a efectos de comparar

    res.json({ ok: true, xtts, google, voz_url: VOZ_URL });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ========= OpenAI: chat relay sencillo =========
// POST /api/openai/chat  { messages:[{role,content},...], model?, temperature?, max_tokens?, stream? }
app.post("/api/openai/chat", async (req, res) => {
  try {
    ensure(!!OPENAI_API_KEY, "OPENAI_API_KEY faltante");
    const {
      messages = [],
      model = OPENAI_MODEL,
      temperature = 0.7,
      max_tokens = 400,
      stream = false,
    } = req.body || {};

    const body = {
      model,
      messages,
      temperature,
      max_tokens,
      stream: !!stream,
    };

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!stream) {
      // respuesta normal (no streaming)
      const j = await r.json().catch(() => null);
      if (!r.ok) {
        return res.status(r.status).json(j || { error: "openai_error" });
      }
      return res.json(j);
    }

    // streaming SSE - reenvío crudo de chunks
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    r.body.on("data", (chunk) => res.write(chunk));
    r.body.on("end", () => res.end());
    r.body.on("error", () => res.end());
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ========= Arranque =========
app.listen(PORT, () => {
  console.log(`[railway] backend escuchando en :${PORT}`);
  console.log(`VOZ_URL=${VOZ_URL} | PROVIDER_DEFAULT=${PROVIDER_DEFAULT}`);
});
