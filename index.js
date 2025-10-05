// index.js — Backend minimal (sin DB) para Jesús Interactivo
// CORS global, selector de voz por idioma + voz fija XTTS (VOICE_REF),
// fallback xtts→google, viewer proxy, ingest opcional, memory sync no-op.

require("dotenv").config();

if (process.env.JESUS_INSECURE_TLS === "1") {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const OpenAI = require("openai");
const { spawn } = require("child_process");
const https = require("https");
const { Readable } = require("node:stream");

// ===== TLS agent (self-signed) para JESUS_URL (backend↔backend) =====
const INSECURE_AGENT =
  process.env.JESUS_INSECURE_TLS === "1"
    ? new https.Agent({ rejectUnauthorized: false })
    : undefined;

// ===== WebRTC ingest / ffmpeg (opcional) =====
let wrtc = null;
try { wrtc = require("wrtc"); } catch { console.warn("[WARN] wrtc no instalado; /api/ingest/* desactivado."); }
const RTCPeerConnection = wrtc?.RTCPeerConnection;
const RTCAudioSource   = wrtc?.nonstandard?.RTCAudioSource;

let ffmpegPath = process.env.FFMPEG_PATH || null;
try { if (!ffmpegPath) ffmpegPath = require("ffmpeg-static"); } catch {}
if (!ffmpegPath) ffmpegPath = "ffmpeg";
(function checkFfmpeg() {
  try {
    const ps = spawn(ffmpegPath, ["-version"]);
    ps.on("close", (code) => {
      if (code === 0) console.log("[ffmpeg ok]", ffmpegPath);
      else console.warn("[ffmpeg warn] exit", code, "path:", ffmpegPath);
    });
  } catch (e) { console.error("[ffmpeg missing]", e.message); }
})();

// ===== Config =====
const JESUS_URL = (process.env.JESUS_URL || "").trim();
const VOZ_URL   = (process.env.VOZ_URL   || "").trim();
if (!JESUS_URL) console.warn("[WARN] Falta JESUS_URL");
if (!VOZ_URL)   console.warn("[WARN] Falta VOZ_URL");

const TTS_PROVIDER_DEFAULT = (process.env.TTS_PROVIDER || "xtts").trim();
let CURRENT_REF = (process.env.VOICE_REF || "jesus2.mp3").trim(); // ej.: jesus2.mp3

// ===== Selector automático por idioma + tuning =====
const PROVIDER_BY_LANG = {
  es: "xtts", it: "xtts", fr: "xtts",
  en: "google", pt: "google", de: "google", ca: "google",
};
const VOICE_TUNING = {
  es: { rate: "1.10", temp: "0.55" },
  it: { rate: "1.08", temp: "0.55" },
  fr: { rate: "1.06", temp: "0.55" },
  en: { rate: "1.02", temp: "0.55" },
  pt: { rate: "1.10", temp: "0.55" },
  de: { rate: "1.00", temp: "0.55" },
  ca: { rate: "1.06", temp: "0.55" },
};
function pickProvider(lang, fallback) {
  const l = String(lang || "es").toLowerCase();
  return PROVIDER_BY_LANG[l] || fallback || TTS_PROVIDER_DEFAULT || "google";
}
function tuneByLang(params) {
  const l = String(params.lang || "es").toLowerCase();
  const t = VOICE_TUNING[l];
  if (t) {
    if (params.rate === undefined || params.rate === null || params.rate === "") params.rate = t.rate;
    if (params.temp === undefined || params.temp === null || params.temp === "") params.temp = t.temp;
  }
  return params;
}

// ===== App =====
const app = express();

// ----- CORS global -----
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(cors({ origin: true }));
app.use(bodyParser.json());

// ===== Utils =====
const publicBase = (req) => process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
function toQS(obj) {
  const s = new URLSearchParams();
  for (const [k,v] of Object.entries(obj||{})) if (v !== undefined && v !== null && v !== "") s.append(k, String(v));
  return s.toString();
}
async function pipeUpstream(up, res, fallbackType = "application/octet-stream") {
  res.status(up.status);
  const ct = up.headers.get("content-type");
  if (ct) res.setHeader("Content-Type", ct); else res.setHeader("Content-Type", fallbackType);
  const cl = up.headers.get("content-length"); if (cl) res.setHeader("Content-Length", cl);
  const cr = up.headers.get("accept-ranges"); if (cr) res.setHeader("Accept-Ranges", cr);
  if (!up.body) return res.end();
  return Readable.fromWeb(up.body).pipe(res);
}

// ===== JSON por defecto salvo binarios/audio
app.use((req, res, next) => {
  const p = req.path || "";
  if (p.startsWith("/api/viewer/assets") || p.startsWith("/api/assets/") || p.startsWith("/api/files/") || p.startsWith("/api/tts")) return next();
  res.set("Content-Type", "application/json; charset=utf-8");
  next();
});

// ===== OpenAI =====
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ===== Logger + Anti-duplicados =====
app.use((req, _res, next) => {
  if (req.path === "/api/tts" || req.path === "/api/tts_save" || req.path === "/api/tts_fast") {
    const q = req.query || {};
    const txt = String(q.text || "").slice(0, 120).replace(/\s+/g, " ");
    console.log(`[tts hit] ${req.path} lang=${q.lang || "es"} provider=${q.provider || "-"} text="${txt}"`);
  }
  next();
});
const lastTtsHits = new Map(); // key -> timestamp
function ttsKey(q) {
  return [
    (q.text || "").trim(),
    q.lang || "es",
    q.provider || "",
    q.rate || "",
    q.temp || "",
    q.fx || 0
  ].join("|");
}
function isDuplicateHit(key, windowMs = 1800) { // ventana un poco más corta
  const now = Date.now();
  const last = lastTtsHits.get(key) || 0;
  lastTtsHits.set(key, now);
  return (now - last) < windowMs;
}

// ===== Health mínimos =====
app.get("/", (_req, res) => res.json({ ok: true, service: "backend", ts: Date.now() }));

// ===== Bienvenida =====
function greetingByHour(lang="es", hour=null) {
  const h = Number.isInteger(hour) ? hour : new Date().getHours();
  const g = (m,a,n)=> (h<12?m:h<19?a:n);
  switch (lang){
    case "en": return g("Good morning","Good afternoon","Good evening");
    case "pt": return g("Bom dia","Boa tarde","Boa noite");
    case "it": return g("Buongiorno","Buon pomeriggio","Buonasera");
    case "de": return g("Guten Morgen","Guten Tag","Guten Abend");
    case "ca": return g("Bon dia","Bona tarda","Bona nit");
    case "fr": return g("Bonjour","Bon après-midi","Bonsoir");
    default:   return g("Buenos días","Buenas tardes","Buenas noches");
  }
}
const DAILY = {
  es:["Un gesto de bondad puede cambiar tu día.","La fe hace posible lo que parece imposible.","Hoy es buen día para empezar de nuevo.","La paz se cultiva con pasos pequeños.","El amor que das, vuelve a ti."],
  en:["A small kindness can change your day.","Faith makes the impossible possible.","Today is a good day to begin again.","Peace grows from small steps.","The love you give returns to you."]
};
const dayPhrase = (lang="es") => (DAILY[lang]||DAILY.es)[Math.floor(Math.random()* (DAILY[lang]||DAILY.es).length)];

app.post("/api/welcome", (req,res)=>{
  try{
    const { lang="es", name="", hour=null } = req.body||{};
    const hi = greetingByHour(lang, hour);
    const phrase = dayPhrase(lang);
    const nm = String(name||"").trim();
    const sal = nm ? `${hi}, ${nm}.` : `${hi}.`;
    const message =
      lang==="en"? `${sal} ${phrase} I'm here for you.` : `${sal} ${phrase} Estoy aquí para lo que necesites.`;
    const question =
      lang==="en"? "What would you like to share today?" : "¿Qué te gustaría compartir hoy?";
    res.json({ message, question });
  }catch{
    res.json({ message:"La paz sea contigo. ¿De qué te gustaría hablar hoy?", question:"¿Qué te gustaría compartir hoy?" });
  }
});

// ===== /api/ask (más rápido) =====
app.post("/api/ask", async (req,res)=>{
  try{
    const { message="", history=[], lang="es" } = req.body||{};
    const SYS = `
Eres cercano, claro y compasivo, desde una voz cristiana (católica).
Responde en ${lang}. Devuelve SOLO JSON: {"message":"...", "question":"...","bible":{"text":"...","ref":"Libro 0:0"}}`.trim();

    const convo = [];
    const recent = Array.isArray(history) ? history.slice(-8) : [];
    for (const h of recent) if (typeof h === "string") convo.push({ role: "user", content: h });
    convo.push({ role: "user", content: String(message||"").trim() });

    const r = await openai.chat.completions.create({
      model: "gpt-4o-mini",   // ⚡ más veloz
      temperature: 0.6,
      max_tokens: 240,        // ⚡ menos tokens → menos latencia
      messages: [{ role:"system", content:SYS }, ...convo],
      response_format: {
        type:"json_schema",
        json_schema:{
          name:"Reply",
          schema:{
            type:"object",
            properties:{
              message:{type:"string"},
              question:{type:"string"},
              bible:{ type:"object", properties:{ text:{type:"string"}, ref:{type:"string"} }, required:["text","ref"] }
            },
            required:["message","bible"],
            additionalProperties:false
          }
        }
      }
    });

    const content = r?.choices?.[0]?.message?.content || "{}";
    let data={}; try{ data = JSON.parse(content); }catch{}
    res.json({
      message: String(data?.message||"").trim() || (lang==="en"?"I’m with you.":"Estoy contigo."),
      question: String(data?.question||"").trim() || "",
      bible: data?.bible
    });
  }catch(e){
    console.error("ASK ERROR:", e);
    res.json({ message:"La paz sea contigo. Decime en pocas palabras qué está pasando.", question:"¿Qué te gustaría trabajar primero?" });
  }
});

// ====== VOZ (selector XTTS ref + fallback a google) ======
app.get("/api/voice/current", (_req,res)=>{
  res.json({ ok:true, provider_default: TTS_PROVIDER_DEFAULT, fixed_ref: CURRENT_REF, PROVIDER_BY_LANG, VOICE_TUNING });
});
app.post("/api/voice/set_ref", async (req,res)=>{
  try{
    const name = String(req.body?.name || "").trim();
    if (!name) return res.status(400).json({ ok:false, error:"missing_name" });
    if (!/^[a-zA-Z0-9_.-]+$/.test(name)) return res.status(400).json({ ok:false, error:"bad_name" });
    CURRENT_REF = name;
    res.json({ ok:true, fixed_ref: CURRENT_REF });
  } catch(e){
    res.status(500).json({ ok:false, error:String(e) });
  }
});
app.get("/api/voice/use_ref", (req,res)=>{
  const name = String(req.query?.name || "").trim();
  if (!name) return res.status(400).json({ ok:false, error:"missing_name" });
  if (!/^[a-zA-Z0-9_.-]+$/.test(name)) return res.status(400).json({ ok:false, error:"bad_name" });
  CURRENT_REF = name;
  res.json({ ok:true, fixed_ref: CURRENT_REF });
});
app.get("/api/health", async (_req,res)=>{
  try{
    if (!VOZ_URL) return res.status(500).json({ ok:false, error:"missing_VOZ_URL" });
    const r = await fetch(`${VOZ_URL}/health`);
    const j = await r.json().catch(()=> ({}));
    res.json({ ok:true, proxy:"railway", voz_url:VOZ_URL, provider_default:TTS_PROVIDER_DEFAULT, fixed_ref: CURRENT_REF, upstream:j });
  }catch(e){ res.status(500).json({ ok:false, error:String(e) }); }
});
app.get("/api/voice/diag", async (req,res)=>{
  try{
    if (!VOZ_URL) return res.status(500).json({ ok:false, error:"missing_VOZ_URL" });
    const text = req.query.text || "ping de prueba";
    const base = { text, lang:"es", provider: TTS_PROVIDER_DEFAULT||"xtts", rate:"1.0", temp:"0.6", fx:"0" };
    const url = new URL("/tts_save", VOZ_URL);
    url.search = toQS(base);
    const t0 = Date.now();
    const up = await fetch(url.toString());
    const ms = Date.now()-t0;
    const body = await up.text().catch(()=> "");
    let j = {}; try{ j = JSON.parse(body); }catch{ j = { raw: body } }
    const upstream = j.url || j.file || j.path;
    if (upstream) {
      try {
        const name = new URL(upstream).pathname.split("/").pop();
        j.url = `${publicBase(req)}/api/files/${encodeURIComponent(name)}`;
      } catch {}
    }
    res.json({ ok: up.ok, upstream_status: up.status, ms, data: j, fixed_ref: CURRENT_REF });
  } catch(e) {
    res.status(500).json({ ok:false, error:String(e) });
  }
});

// helper: intenta xtts (con ref) y si falla cae a google
async function fetchTTSWithFallback(endpointPath, baseParams) {
  const providers = [
    String(baseParams.provider || TTS_PROVIDER_DEFAULT || "xtts"),
    "google"
  ].filter((v,i,arr)=> arr.indexOf(v)===i); // únicos, xtts primero

  let last = { status: 0, text: "" };
  for (const provider of providers) {
    const url = new URL(endpointPath, VOZ_URL);
    const params = { ...baseParams, provider };
    if (provider.toLowerCase() === "xtts" && CURRENT_REF) params.ref = CURRENT_REF; else delete params.ref;
    url.search = toQS(params);
    const up = await fetch(url.toString());
    const txt = await up.text().catch(()=> "");
    if (up.ok) return { ok:true, provider, status: up.status, body: txt, response: up };
    last = { status: up.status||0, text: txt };
  }
  return { ok:false, status:last.status, detail:last.text };
}

// ===== STREAMING WAV (chunked) =====
app.get("/api/tts", async (req, res) => {
  try {
    if (!VOZ_URL) return res.status(500).json({ ok: false, error: "missing_VOZ_URL" });

    // Anti-duplicados
    const dupKey = ttsKey(req.query || {});
    if (isDuplicateHit(dupKey)) {
      res.status(202).set("Content-Type","audio/wav").end();
      return;
    }

    // baja latencia
    try { req.socket.setNoDelay(true); } catch {}
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Accel-Buffering", "no");
    res.setHeader("Connection", "keep-alive");

    const baseParams = {
      text: req.query.text || "Hola",
      lang: req.query.lang || "es",
      rate: req.query.rate,
      temp: req.query.temp,
      fx: req.query.fx || "0",
      hpf: req.query.hpf, lpf: req.query.lpf, warm_db: req.query.warm_db,
      air_db: req.query.air_db, presence_db: req.query.presence_db,
      reverb_wet: req.query.reverb_wet, reverb_delay: req.query.reverb_delay, reverb_tail: req.query.reverb_tail,
      comp: req.query.comp, width_ms: req.query.width_ms, pitch_st: req.query.pitch_st, gain_db: req.query.gain_db,
      provider: req.query.provider || TTS_PROVIDER_DEFAULT,
      t: Date.now().toString(),
    };

    // Auto-proveedor y tuning
    baseParams.provider = pickProvider(baseParams.lang, baseParams.provider);
    tuneByLang(baseParams);

    for (const prov of [baseParams.provider, "google"].filter(Boolean)) {
      const url = new URL("/tts", VOZ_URL);
      const params = { ...baseParams, provider: prov };
      if (prov.toLowerCase() === "xtts" && CURRENT_REF) params.ref = CURRENT_REF; else delete params.ref;
      url.search = toQS(params);

      const t0 = Date.now();
      const up = await fetch(url.toString(), { headers: { "Accept": "audio/wav" } });
      if (!up.ok) continue;

      // Respuesta CHUNKED
      res.status(200);
      res.setHeader("Content-Type", up.headers.get("content-type") || "audio/wav");
      res.removeHeader("Content-Length");
      if (typeof res.flushHeaders === "function") res.flushHeaders();

      if (!up.body) return res.end();

      const reader = up.body.getReader();
      let aborted = false;
      req.on("aborted", () => { aborted = true; try { reader.cancel(); } catch {} });

      let first = true;
      let total = 0;

      async function pump() {
        if (aborted) return;
        const { value, done } = await reader.read();
        if (done) {
          try { res.end(); } catch {}
          const ms = Date.now() - t0;
          console.log(`[tts stream] done bytes=${total} ms=${ms}`);
          return;
        }
        try {
          total += value.byteLength;
          if (first) {
            const ms1 = Date.now() - t0;
            first = false;
            console.log(`[tts stream] firstByte at ${ms1}ms, provider=${prov}`);
          }
          res.write(Buffer.from(value));
        } catch (e) {
          console.error("[tts stream write err]", e);
          try { res.end(); } catch {}
          try { reader.cancel(); } catch {}
          return;
        }
        return pump();
      }

      return pump();
    }

    const fb = await fetchTTSWithFallback("/tts", baseParams);
    return res.status(500).json({ ok: false, upstream_status: fb.status, detail: fb.detail || "tts upstream failed" });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ===== FAST LANE: fuerza Google, sin FX, para frases cortas =====
app.get("/api/tts_fast", async (req, res) => {
  try {
    if (!VOZ_URL) return res.status(500).json({ ok:false, error:"missing_VOZ_URL" });

    // anti-dup más corto
    const dupKey = ttsKey({ ...(req.query||{}), provider: "google", fx: 0 });
    if (isDuplicateHit(dupKey, 1200)) {
      res.status(202).set("Content-Type","audio/wav").end();
      return;
    }

    try { req.socket.setNoDelay(true); } catch {}
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Accel-Buffering", "no");
    res.setHeader("Connection", "keep-alive");

    const baseParams = {
      text: req.query.text || "Hola",
      lang: (req.query.lang || "es"),
      rate: req.query.rate || "1.10",
      temp: req.query.temp || "0.55",
      provider: "google", // ⚡ siempre Google
      fx: "0",
      t: Date.now().toString(),
    };

    const url = new URL("/tts", VOZ_URL);
    url.search = toQS(baseParams);

    const t0 = Date.now();
    const up = await fetch(url.toString(), { headers: { "Accept": "audio/wav" } });
    if (!up.ok) return res.status(502).json({ ok:false, status: up.status });

    res.status(200);
    res.setHeader("Content-Type", up.headers.get("content-type") || "audio/wav");
    res.removeHeader("Content-Length");
    if (typeof res.flushHeaders === "function") res.flushHeaders();

    if (!up.body) return res.end();

    const reader = up.body.getReader();
    let first = true;
    let total = 0;

    async function pump() {
      const { value, done } = await reader.read();
      if (done) {
        try { res.end(); } catch {}
        const ms = Date.now() - t0;
        console.log(`[tts fast] done bytes=${total} ms=${ms}`);
        return;
      }
      total += value.byteLength;
      if (first) {
        const ms1 = Date.now() - t0;
        first = false;
        console.log(`[tts fast] firstByte at ${ms1}ms`);
      }
      res.write(Buffer.from(value));
      return pump();
    }
    return pump();
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e) });
  }
});

// ===== Genera WAV y guarda (fallback / descargas) =====
app.get("/api/tts_save", async (req,res)=>{
  try{
    if (!VOZ_URL) return res.status(500).json({ ok:false, error:"missing_VOZ_URL" });

    const dupKey = ttsKey(req.query || {});
    if (isDuplicateHit(dupKey)) return res.json({ ok:true, duplicate:true });

    const baseParams = {
      text: req.query.text || "Hola",
      lang: req.query.lang || "es",
      rate: req.query.rate,
      temp: req.query.temp,
      fx: req.query.fx || "0",
      hpf: req.query.hpf, lpf: req.query.lpf, warm_db: req.query.warm_db,
      air_db: req.query.air_db, presence_db: req.query.presence_db,
      reverb_wet: req.query.reverb_wet, reverb_delay: req.query.reverb_delay, reverb_tail: req.query.reverb_tail,
      comp: req.query.comp, width_ms: req.query.width_ms, pitch_st: req.query.pitch_st, gain_db: req.query.gain_db,
      provider: req.query.provider || TTS_PROVIDER_DEFAULT
    };

    baseParams.provider = pickProvider(baseParams.lang, baseParams.provider);
    tuneByLang(baseParams);

    // Llama al upstream
    const url = new URL("/tts_save", VOZ_URL); url.search = toQS(baseParams);
    const up = await fetch(url.toString());
    const txt = await up.text().catch(()=> "");
    if (!up.ok) return res.status(500).json({ ok:false, detail: txt || "tts_save upstream failed" });

    let j = {}; try { j = JSON.parse(txt); } catch { j = { raw: txt }; }
    const upstream = j.url || j.file || j.path;
    if (upstream) {
      try {
        const name = new URL(upstream).pathname.split("/").pop();
        const pub = `${publicBase(req)}/api/files/${encodeURIComponent(name)}`;
        j.url = j.file = j.path = pub;
      } catch {}
    }
    res.json(j);
  }catch(e){
    res.status(500).json({ ok:false, error:String(e) });
  }
});

// ===== Sirve WAV por HTTPS (evita mixed-content) =====
app.get("/api/files/:name", async (req,res)=>{
  try{
    if (!VOZ_URL) return res.status(500).json({ ok:false, error:"missing_VOZ_URL" });
    const name = String(req.params.name||"").trim();
    if (!/^[a-zA-Z0-9_.-]+$/.test(name)) return res.status(400).json({ ok:false, error:"bad_name" });
    const up = await fetch(`${VOZ_URL}/files/${encodeURIComponent(name)}`);
    res.removeHeader("Content-Type");
    await pipeUpstream(up, res, "audio/wav");
  }catch(e){
    res.status(500).json({ ok:false, error:String(e) });
  }
});

// ===== Diag: medir TTFB directo al upstream =====
app.get("/api/_diag/tts_probe", async (req, res) => {
  try {
    if (!VOZ_URL) return res.status(500).json({ ok:false, error:"missing_VOZ_URL" });
    const baseParams = {
      text: req.query.text || "hola",
      lang: req.query.lang || "es",
      rate: req.query.rate,
      temp: req.query.temp,
      provider: req.query.provider || TTS_PROVIDER_DEFAULT,
      t: Date.now().toString(),
    };
    baseParams.provider = pickProvider(baseParams.lang, baseParams.provider);
    tuneByLang(baseParams);

    const url = new URL("/tts", VOZ_URL); url.search = toQS(baseParams);
    const t0 = Date.now();
    const up = await fetch(url.toString());
    const tConn = Date.now() - t0;
    if (!up.body) return res.json({ ok:false, status: up.status, note:"no_body", connect_ms: tConn });
    const reader = up.body.getReader();
    let tFirst = null, total = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (tFirst === null) tFirst = Date.now() - t0;
      if (total > 96*1024) break;
    }
    res.json({ ok:true, status: up.status, connect_ms: tConn, first_byte_ms: tFirst ?? -1, sampled_bytes: total, provider_used: baseParams.provider });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e) });
  }
});

// ===== Memory sync no-op =====
app.post("/api/memory/sync", (_req,res)=> res.json({ ok:true }));

// ===== Arranque =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor listo en puerto ${PORT} | VOICE_REF=${CURRENT_REF}`));
