// index.js — Backend minimal (sin DB) para Jesús Interactivo
// CORS global, selector de voz fija para XTTS (VOICE_REF), fallback xtts→google,
// viewer proxy, ingest opcional, memory sync no-op.

require("dotenv").config();

if (process.env.JESUS_INSECURE_TLS === "1") {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const path = require("path");
const fs = require("fs/promises");
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

// Voz fija para XTTS (referencia /refs/ del servidor jesus-voz)
let CURRENT_REF = (process.env.VOICE_REF || "jesus2.mp3").trim(); // ej.: jesus2.mp3

// ===== App =====
const app = express();

// ----- CORS global (incluye errores/404/500/OPTIONS) -----
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

// JSON por defecto salvo binarios/audio
app.use((req, res, next) => {
  const p = req.path || "";
  if (
    p.startsWith("/api/viewer/assets") ||
    p.startsWith("/api/assets/") ||
    p.startsWith("/api/files/") ||
    p.startsWith("/api/tts")
  ) return next();
  res.set("Content-Type", "application/json; charset=utf-8");
  next();
});

// ===== OpenAI =====
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ===== Utils =====
const NORM = (s="") => String(s).toLowerCase().replace(/\s+/g," ").trim();
const publicBase = (req) => process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;

function toQS(obj) {
  const s = new URLSearchParams();
  for (const [k,v] of Object.entries(obj||{})) if (v !== undefined && v !== null && v !== "") s.append(k, String(v));
  return s.toString();
}
function mergeQS(a = {}, b = {}) {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(a)) if (v !== undefined) s.append(k, v);
  for (const [k, v] of Object.entries(b)) if (v !== undefined) s.set(k, String(v));
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

// ===== Health mínimos =====
app.get("/", (_req, res) => res.json({ ok: true, service: "backend", ts: Date.now() }));

app.get("/api/_diag/viewer_check", async (_req, res) => {
  try {
    if (!JESUS_URL) return res.status(500).json({ ok:false, error:"missing_JESUS_URL" });
    const r = await fetch(`${JESUS_URL}/health`, { agent: INSECURE_AGENT });
    const j = await r.json().catch(()=> ({}));
    if (!r.ok) return res.status(r.status).json({ ok:false, error:"health_non_200", detail:j, jesus_url:JESUS_URL });
    res.json({ ok:true, jesus_url:JESUS_URL, health:j });
  } catch (e) {
    res.status(500).json({ ok:false, error:"viewer_check_failed", detail:String(e), jesus_url:JESUS_URL });
  }
});

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

// ===== /api/ask =====
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
      model: "gpt-4o",
      temperature: 0.6,
      max_tokens: 360,
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

// estado actual
app.get("/api/voice/current", (_req,res)=>{
  res.json({ ok:true, provider_default: TTS_PROVIDER_DEFAULT, fixed_ref: CURRENT_REF });
});

// set ref por POST
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

// set ref por query (cómodo para probar rápido)
app.get("/api/voice/use_ref", (req,res)=>{
  const name = String(req.query?.name || "").trim();
  if (!name) return res.status(400).json({ ok:false, error:"missing_name" });
  if (!/^[a-zA-Z0-9_.-]+$/.test(name)) return res.status(400).json({ ok:false, error:"bad_name" });
  CURRENT_REF = name;
  res.json({ ok:true, fixed_ref: CURRENT_REF });
});

// health del proxy de voz
app.get("/api/health", async (_req,res)=>{
  try{
    if (!VOZ_URL) return res.status(500).json({ ok:false, error:"missing_VOZ_URL" });
    const r = await fetch(`${VOZ_URL}/health`);
    const j = await r.json().catch(()=> ({}));
    res.json({ ok:true, proxy:"railway", voz_url:VOZ_URL, provider_default:TTS_PROVIDER_DEFAULT, fixed_ref: CURRENT_REF, upstream:j });
  }catch(e){ res.status(500).json({ ok:false, error:String(e) }); }
});

// diagnóstico rápido
app.get("/api/voice/diag", async (req,res)=>{
  try{
    if (!VOZ_URL) return res.status(500).json({ ok:false, error:"missing_VOZ_URL" });
    const text = req.query.text || "ping de prueba";
    const base = { text, lang:"es", provider: TTS_PROVIDER_DEFAULT||"xtts", rate:"1.0", temp:"0.6", fx:"0" };
    if ((base.provider||"").toLowerCase()==="xtts" && CURRENT_REF) base.ref = CURRENT_REF;

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
    // si es xtts y hay ref, la pasamos
    if (provider.toLowerCase() === "xtts" && CURRENT_REF) {
      params.ref = CURRENT_REF;
    } else {
      delete params.ref;
    }
    url.search = toQS(params);
    const up = await fetch(url.toString());
    const txt = await up.text().catch(()=> "");
    if (up.ok) {
      return { ok:true, provider, status: up.status, body: txt, response: up };
    }
    last = { status: up.status||0, text: txt };
  }

  return { ok:false, status:last.status, detail:last.text };
}

// WAV streaming
app.get("/api/tts", async (req,res)=>{
  try{
    if (!VOZ_URL) return res.status(500).json({ ok:false, error:"missing_VOZ_URL" });
    const baseParams = {
      text: req.query.text || "Hola",
      lang: req.query.lang || "es",
      rate: req.query.rate || "1.10",
      temp: req.query.temp || "0.6",
      fx: req.query.fx || "0",
      hpf: req.query.hpf, lpf: req.query.lpf, warm_db: req.query.warm_db,
      air_db: req.query.air_db, presence_db: req.query.presence_db,
      reverb_wet: req.query.reverb_wet, reverb_delay: req.query.reverb_delay, reverb_tail: req.query.reverb_tail,
      comp: req.query.comp, width_ms: req.query.width_ms, pitch_st: req.query.pitch_st, gain_db: req.query.gain_db,
      provider: req.query.provider || TTS_PROVIDER_DEFAULT
    };

    // intento 1: xtts (con ref) → si falla: google
    for (const prov of [baseParams.provider, "google"].filter(Boolean)) {
      const url = new URL("/tts", VOZ_URL);
      const params = { ...baseParams, provider: prov };
      if (prov.toLowerCase()==="xtts" && CURRENT_REF) params.ref = CURRENT_REF; else delete params.ref;
      url.search = toQS(params);
      const up = await fetch(url.toString());
      if (up.ok) {
        res.removeHeader("Content-Type");
        return pipeUpstream(up, res, "audio/wav");
      }
    }

    const fb = await fetchTTSWithFallback("/tts", baseParams);
    return res.status(500).json({ ok:false, upstream_status:fb.status, detail:fb.detail||"tts upstream failed" });
  }catch(e){
    res.status(500).json({ ok:false, error:String(e) });
  }
});

// Genera WAV, guarda y devuelve URL proxificada
app.get("/api/tts_save", async (req,res)=>{
  try{
    if (!VOZ_URL) return res.status(500).json({ ok:false, error:"missing_VOZ_URL" });

    const baseParams = {
      text: req.query.text || "Hola",
      lang: req.query.lang || "es",
      rate: req.query.rate || "1.10",
      temp: req.query.temp || "0.6",
      fx: req.query.fx || "0",
      hpf: req.query.hpf, lpf: req.query.lpf, warm_db: req.query.warm_db,
      air_db: req.query.air_db, presence_db: req.query.presence_db,
      reverb_wet: req.query.reverb_wet, reverb_delay: req.query.reverb_delay, reverb_tail: req.query.reverb_tail,
      comp: req.query.comp, width_ms: req.query.width_ms, pitch_st: req.query.pitch_st, gain_db: req.query.gain_db,
      provider: req.query.provider || TTS_PROVIDER_DEFAULT
    };

    const resp = await fetchTTSWithFallback("/tts_save", baseParams);
    if (!resp.ok) {
      return res.status(500).json({ ok:false, upstream_status:resp.status, detail:resp.detail||"tts_save upstream failed" });
    }

    let j = {}; try { j = JSON.parse(resp.body); } catch { j = { raw: resp.body }; }
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

// Sirve WAV por HTTPS (evita mixed-content)
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

// POST JSON → WAV (corto)
app.post("/api/tts_from_json", async (req,res)=>{
  try{
    if (!VOZ_URL) return res.status(500).json({ ok:false, error:"missing_VOZ_URL" });
    const b = req.body||{};
    const baseParams = {
      text: b.text || "Hola",
      lang: b.lang || "es",
      rate: b.rate ?? "1.10",
      temp: b.temp ?? "0.6",
      fx: b.fx?.fx ? 1 : b.fx?.enable ? 1 : 0,
      hpf: b.fx?.hpf, lpf: b.fx?.lpf, warm_db: b.fx?.warm_db,
      air_db: b.fx?.air_db, presence_db: b.fx?.presence_db,
      reverb_wet: b.fx?.reverb_wet, reverb_delay: b.fx?.reverb_delay, reverb_tail: b.fx?.reverb_tail,
      comp: b.fx?.comp, width_ms: b.fx?.width_ms, pitch_st: b.fx?.pitch_st, gain_db: b.fx?.gain_db,
      provider: b.provider || (String(b.source||"").startsWith("xtts") ? "xtts" : TTS_PROVIDER_DEFAULT)
    };

    const resp = await fetchTTSWithFallback("/tts_save", baseParams);
    if (!resp.ok) return res.status(500).json({ ok:false, upstream_status:resp.status, detail:resp.detail||"tts_save upstream failed" });

    let j = {}; try { j = JSON.parse(resp.body); } catch { j = { raw: resp.body }; }
    const upstream = j.url || j.file || j.path;
    let pub = upstream;
    if (upstream) {
      try {
        const name = new URL(upstream).pathname.split("/").pop();
        pub = `${publicBase(req)}/api/files/${encodeURIComponent(name)}`;
      } catch {}
    }
    res.json({ ok:true, url: pub, file: pub, tts: j, fixed_ref: CURRENT_REF });
  }catch(e){
    res.status(500).json({ ok:false, error:String(e) });
  }
});

// ===== Viewer assets/proxy =====
app.get("/api/viewer/assets/:file", async (req,res)=>{
  try{
    if (!JESUS_URL) return res.status(500).json({ error:"missing_JESUS_URL" });
    const r = await fetch(`${JESUS_URL}/assets/${encodeURIComponent(req.params.file)}`, { agent: INSECURE_AGENT });
    if (!r.ok) {
      const body = await r.text().catch(()=> "");
      res.status(r.status||502).set("Content-Type","text/plain; charset=utf-8").send(body||"asset fetch failed");
      return;
    }
    res.removeHeader("Content-Type");
    res.setHeader("Content-Type", r.headers.get("content-type") || "application/octet-stream");
    res.setHeader("Cache-Control", "no-store");
    return Readable.fromWeb(r.body).pipe(res);
  }catch(e){
    res.status(502).set("Content-Type","application/json; charset=utf-8").json({ error:"asset_proxy_exception", detail:String(e) });
  }
});
app.get("/api/assets/idle",(req,res)=>{ req.params.file="idle_loop.mp4"; app._router.handle(req,res,()=>{},"get","/api/viewer/assets/:file"); });
app.get("/api/assets/talk",(req,res)=>{ req.params.file="talk.mp4"; app._router.handle(req,res,()=>{},"get","/api/viewer/assets/:file"); });

// ===== Viewer offer =====
app.post("/api/viewer/offer", async (req,res)=>{
  try{
    if (!JESUS_URL) return res.status(500).json({ error:"missing_JESUS_URL" });
    const payload = { sdp: req.body?.sdp, type: req.body?.type };
    if (!payload.sdp || !payload.type) return res.status(400).json({ error:"bad_offer_payload" });
    const r = await fetch(`${JESUS_URL}/viewer/offer`, {
      method:"POST", headers:{ "Content-Type":"application/json; charset=utf-8" },
      body: JSON.stringify(payload), agent: INSECURE_AGENT
    });
    if (r.ok) return res.json(await r.json().catch(()=> ({})));
    if (r.status===501) return res.json({ stub:true, webrtc:false, idleUrl:"/api/viewer/assets/idle_loop.mp4", talkUrl:"/api/viewer/assets/talk.mp4" });
    const detail = await r.text().catch(()=> "");
    res.status(r.status||502).json({ error:"viewer_proxy_failed", status:r.status||502, detail, jesus_url:JESUS_URL });
  }catch(e){
    res.status(200).json({ stub:true, webrtc:false, idleUrl:"/api/viewer/assets/idle_loop.mp4", talkUrl:"/api/viewer/assets/talk.mp4" });
  }
});
app.get("/api/viewer/offer", (_req,res)=> res.status(405).json({ ok:false, error:"use_POST_here" }));

// ===== Ingest (opcional) =====
const sessions = new Map();
function chunkPCM(buf, chunkBytes=1920){ const out=[]; for(let i=0;i+chunkBytes<=buf.length;i+=chunkBytes) out.push(buf.slice(i,i+chunkBytes)); return out; }

app.post("/api/ingest/start", async (req,res)=>{
  if (!RTCPeerConnection || !RTCAudioSource) return res.status(501).json({ error:"wrtc_not_available" });
  try{
    const { ttsUrl } = req.body||{};
    if (!ttsUrl) return res.status(400).json({ error:"missing_ttsUrl" });
    if (!JESUS_URL) return res.status(500).json({ error:"missing_JESUS_URL" });

    const pc = new RTCPeerConnection();
    const source = new RTCAudioSource();
    const track = source.createTrack();
    pc.addTrack(track);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const r = await fetch(`${JESUS_URL}/ingest/offer`, {
      method:"POST", headers:{ "Content-Type":"application/json; charset=utf-8" },
      body: JSON.stringify({ sdp: offer.sdp, type: offer.type }), agent: INSECURE_AGENT
    });
    if (!r.ok) return res.status(r.status||500).json({ error:"jesus_ingest_failed", detail: await r.text().catch(()=> "") });
    const answer = await r.json();
    await pc.setRemoteDescription(answer);

    const ff = spawn(ffmpegPath, ["-re","-i",ttsUrl,"-f","s16le","-acodec","pcm_s16le","-ac","1","-ar","48000","pipe:1"], { stdio:["ignore","pipe","inherit"] });

    let leftover = Buffer.alloc(0);
    ff.stdout.on("data",(buf)=>{
      const data = Buffer.concat([leftover, buf]);
      const CHUNK = 1920;
      const chunks = chunkPCM(data, CHUNK);
      leftover = data.slice(chunks.length*CHUNK);
      for (const c of chunks) {
        const samples = new Int16Array(c.buffer, c.byteOffset, c.byteLength/2);
        source.onData({ samples, sampleRate:48000, bitsPerSample:16, channelCount:1, numberOfFrames:960 });
      }
    });

    const id = Math.random().toString(36).slice(2,10);
    sessions.set(id, { pc, source, ff, track });
    res.json({ ok:true, id });
  }catch(e){
    res.status(500).json({ error:String(e) });
  }
});
app.post("/api/ingest/stop", async (req,res)=>{
  const { id } = req.body||{};
  const s = id? sessions.get(id) : null;
  if (!s) return res.json({ ok:true, note:"no_session" });
  try{ s.ff.kill("SIGKILL"); }catch{}
  try{ s.track.stop(); }catch{}
  try{ await s.pc.close(); }catch{}
  sessions.delete(id);
  res.json({ ok:true });
});

// ===== Memory sync no-op =====
app.post("/api/memory/sync", (_req,res)=> res.json({ ok:true }));

// ===== Arranque =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor listo en puerto ${PORT} | VOICE_REF=${CURRENT_REF}`));
