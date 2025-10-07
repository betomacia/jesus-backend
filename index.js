// index.js
import express from "express";
import cors from "cors";
import morgan from "morgan";
import { Readable } from "stream";
import http from "http";
import https from "https";

// ===== Config =====
const PORT = process.env.PORT || 3000;
const VOZ_URL = process.env.VOZ_URL || "http://136.114.108.182:8000"; // tu servidor FastAPI
const app = express();

app.disable("x-powered-by");
app.use(cors({ origin: "*"}));
app.use(express.json());
app.use(morgan("tiny"));

// Conexiones keep-alive + timeouts generosos
http.globalAgent.keepAlive = true;
https.globalAgent.keepAlive = true;
const FETCH_OPTS = { // 60s request timeout "suave"
  // Nota: node-fetch nativo (undici) tiene timeout en AbortController si lo necesitas.
};

// Helper: arma URL con query
function buildUrl(base, path, q = {}) {
  const u = new URL(path, base.endsWith("/") ? base : base + "/");
  for (const [k, v] of Object.entries(q)) {
    if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  }
  return u.toString();
}

// Helper: fetch JSON y propaga status/errores
async function proxyJson(targetUrl) {
  const r = await fetch(targetUrl, { ...FETCH_OPTS });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { ok:false, detail:"upstream_not_json", raw:text }; }
  if (!r.ok) {
    return { ok:false, status:r.status, detail:data.detail || data || "upstream_error" };
  }
  return data;
}

// ===== Rutas =====

// Salud combinada
app.get("/api/health", async (req, res) => {
  try {
    const u = buildUrl(VOZ_URL, "/health");
    const r = await fetch(u, { ...FETCH_OPTS });
    const data = await r.json().catch(() => ({}));
    res.json({ ok:true, proxy:"railway", voz_url: VOZ_URL, provider_default:"xtts", fixed_ref:"jesus2.mp3", upstream: data });
  } catch (e) {
    res.status(500).json({ ok:false, detail:String(e) });
  }
});

// WAV por streaming (audio/wav)
app.get("/api/tts", async (req, res) => {
  try {
    const { text = "Hola", lang = "es", rate = "1.0" } = req.query;
    const u = buildUrl(VOZ_URL, "/tts", { text, lang, rate });

    const r = await fetch(u, { ...FETCH_OPTS });
    if (!r.ok) {
      const msg = await r.text();
      return res.status(502).type("text/plain").send(`upstream_error ${r.status}: ${msg}`);
    }

    // Propagar cabeceras útiles
    res.setHeader("Content-Type", r.headers.get("content-type") || "audio/wav");
    const len = r.headers.get("content-length");
    if (len) res.setHeader("Content-Length", len);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");

    Readable.fromWeb(r.body).pipe(res);
  } catch (e) {
    res.status(500).json({ ok:false, detail:String(e) });
  }
});

// Genera 1 archivo y devuelve URL /files/...
app.get("/api/tts_save", async (req, res) => {
  try {
    const { text = "Hola", lang = "es", rate = "1.0" } = req.query;
    const u = buildUrl(VOZ_URL, "/tts_save", { text, lang, rate });
    const data = await proxyJson(u);
    if (data.ok) {
      return res.json({
        ok:true,
        url: data.url,
        file: data.file || data.url,
        path: data.path || data.url
      });
    }
    res.status(502).json(data);
  } catch (e) {
    res.status(500).json({ ok:false, detail:String(e) });
  }
});

// Genera varios archivos (segmentado) y devuelve lista de URLs
app.get("/api/tts_save_segmented", async (req, res) => {
  try {
    const {
      text = "",
      lang = "es",
      rate = "1.0",
      seg_max = "120"
    } = req.query;

    const u = buildUrl(VOZ_URL, "/tts_save_segmented", { text, lang, rate, seg_max });
    const data = await proxyJson(u);
    if (data.ok) {
      return res.json(data); // { ok, chunks, ttfb_ms, parts:[...] }
    }
    res.status(502).json(data);
  } catch (e) {
    res.status(500).json({ ok:false, detail:String(e) });
  }
});

// Archivos estáticos del upstream (paso-through opcional)
// Nota: normalmente no hace falta; las URLs devueltas ya apuntan al VOZ_URL.
// Si quisieras rehostear, podrías pull & cache aquí.

// Raíz simple
app.get("/", (req, res) => {
  res.type("text/plain").send("Jesus Backend · OK");
});

// Arranque
app.listen(PORT, () => {
  console.log(`[railway] listening on :${PORT} -> VOZ_URL=${VOZ_URL}`);
});
