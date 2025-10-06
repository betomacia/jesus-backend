// index.js — Backend minimal (sin DB) para Jesús Interactivo
// Versión estable + anti-eco de texto y anti-doble-disparo opcional.
// /api/tts = streaming (chunked); /api/tts_save = guarda y devuelve URL proxificada.

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
    ? new https.Agent({ rejectUnauthorized: false, keepAlive: true })
    : undefined;

// ===== wrtc (opcional) + ffmpeg =====
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

// 🔑 Por defecto usamos XTTS (GPU). Cambiá con env TTS_PROVIDER si querés.
const TTS_PROVIDER_DEFAULT = (process.env.TTS_PROVIDER || "xtts").trim();

// ref fija para xtts (si usás xtts)
let CURRENT_REF = (process.env.VOICE_REF || "jesus2.mp3").trim();

const app = express();
app.set("trust proxy", true);

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

// ===== JSON por defecto salvo binarios/audio/viewer
app.use((req, res, next) => {
  const p = req.path || "";
  if (p.startsWith("/api/viewer/") || p.startsWith("/api/assets/") || p.startsWith("/api/files/") || p.startsWith("/api/tts")) {
    return next();
  }
  res.set("Content-Type", "application/json; charset=utf-8");
  next();
});

// ===== OpenAI =====
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ===== Health =====
app.get("/", (_req, res) => res.json({ ok: true, service: "backend", ts: Date.now() }));

// ===== Bienvenida mínima =====
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
    const message = lang==="en" ? `${sal} ${phrase} I'm here for you.` : `${sal} ${phrase} Estoy aquí para lo que necesites.`;
    const question = lang==="en" ? "What would you like to share today?" : "¿Qué te gustaría compartir hoy?";
    res.json({ message, question });
  }catch{
    res.json({ message:"La paz sea contigo. ¿De qué te gustaría hablar hoy?", question:"¿Qué te gustaría compartir hoy?" });
  }
});

// ===== /api/ask (rápido) =====
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
      model: "gpt-4o-mini",
      temperature: 0.6,
      max_tokens: 240,
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

// ===== VOZ (estado) =====
app.get("/api/voice/current", (_req,res)=>{
  res.json({ ok:true, provider_default: TTS_PROVIDER_DEFAULT, fixed_ref: CURRENT_REF });
});

// ===== Diag upstream =====
app.get("/api/health", async (_req,res)=>{
  try{
    if (!VOZ_URL) return res.status(500).json({ ok:false, error:"missing_VOZ_URL" });
    const r = await fetch(`${VOZ_URL}/health`);
    const j = await r.json().catch(()=> ({}));
    res.json({ ok:true, proxy:"railway", voz_url:VOZ_URL, provider_default:TTS_PROVIDER_DEFAULT, fixed_ref: CURRENT_REF, upstream:j });
  }catch(e){ res.status(500).json({ ok:false, error:String(e) }); }
});

// ===== Voice diag (simple) =====
app.get("/api/voice/diag", async (req, res) => {
  try {
    if (!VOZ_URL) return res.status(500).json({ ok:false, error:"missing_VOZ_URL" });

    const baseParams = {
      text: String(req.query.text || "ping de voz"),
      lang: String(req.query.lang || "es"),
      rate: "1.10",
      temp: "0.55",
      provider: "xtts",
      ref: CURRENT_REF || "",
      t: Date.now().toString(),
    };

    const u = new URL("/tts", VOZ_URL);
    u.search = toQS(baseParams);

    const t0 = Date.now();
    const up = await fetch(u.toString(), { headers: { Accept: "audio/wav", Connection: "keep-alive" } });
    const connect_ms = Date.now() - t0;

    if (!up.body) return res.json({ ok:false, status: up.status, note:"no_body", connect_ms });

    const reader = up.body.getReader();
    let first_byte_ms = -1, total = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (first_byte_ms === -1) first_byte_ms = Date.now() - t0;
      if (total > 64 * 1024) { try { await reader.cancel(); } catch {} break; }
    }

    res.json({ ok: up.ok, status: up.status, connect_ms, first_byte_ms, sampled_bytes: total, provider_used: "xtts" });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e) });
  }
});

// ======= Anti-eco de texto (suave) =======
function collapseImmediateDupes(s) {
  if (!s) return s;
  let txt = String(s).replace(/\s+/g, " ").trim();

  // Elimina “A A” o “A. A.” inmediatos
  txt = txt.replace(/(\b[\p{L}\p{N}’'´-]+)(\s+\1\b)/giu, "$1");

  // Por oraciones: elimina repetición inmediata exacta
  const sent = txt.split(/(?<=[.!?…])\s+/);
  const out = [];
  for (const s2 of sent) {
    const norm = s2.replace(/\s+/g," ").trim().toLowerCase();
    const prev = out.length ? out[out.length-1].replace(/\s+/g," ").trim().toLowerCase() : "";
    if (norm && norm === prev) continue;
    out.push(s2);
  }
  return out.join(" ").replace(/\s+/g," ").trim();
}

// ===== helper: fallback xtts → google, sin auto-tuning =====
async function fetchTTSWithFallback(endpointPath, baseParams) {
  const prefer = String(baseParams.provider || TTS_PROVIDER_DEFAULT || "xtts");
  const providers = [prefer, (prefer.toLowerCase()==="xtts" ? "google" : "xtts")];
  let last = { status: 0, text: "" };
  for (const provider of providers) {
    const url = new URL(endpointPath, VOZ_URL);
    const params = { ...baseParams, provider };
    if (provider.toLowerCase() === "xtts" && CURRENT_REF) params.ref = CURRENT_REF; else delete params.ref;
    url.search = toQS(params);
    const up = await fetch(url.toString(), { headers: { Connection: "keep-alive", Accept: "audio/wav" } });
    const txt = await up.text().catch(()=> "");
    if (up.ok) return { ok:true, provider, status: up.status, body: txt, response: up };
    last = { status: up.status||0, text: txt };
  }
  return { ok:false, status:last.status, detail:last.text };
}

// ===== Anti-doble-disparo: cache 1.2s por (ip+text+lang+prov) =====
const recentTTS = new Map(); // key -> ts
function ttsKey(ip, p) {
  return `${ip}|${(p.lang||"es").toLowerCase()}|${(p.provider||TTS_PROVIDER_DEFAULT).toLowerCase()}|${(p.text||"").trim()}`;
}
function isRecent(ip, p, windowMs=1200) {
  const k = ttsKey(ip,p);
  const now = Date.now();
  const last = recentTTS.get(k) || 0;
  recentTTS.set(k, now);
  // limpieza simple
  for (const [kk, vv] of Array.from(recentTTS.entries())) if (now - vv > 4000) recentTTS.delete(kk);
  return (now - last) < windowMs;
}

// ===== STREAMING WAV (chunked) =====
app.get("/api/tts", async (req, res) => {
  try {
    if (!VOZ_URL) return res.status(500).json({ ok: false, error: "missing_VOZ_URL" });

    const baseParams = {
      text: req.query.text || "Hola",
      lang: req.query.lang || "es",
      rate: req.query.rate || "1.10",
      temp: req.query.temp || "0.55",
      fx: "0",
      provider: req.query.provider || TTS_PROVIDER_DEFAULT,
      t: Date.now().toString(),
    };

    // anti-eco de texto (no toca signos, sólo duplicados inmediatos)
    baseParams.text = collapseImmediateDupes(baseParams.text);

    // anti doble disparo (desactivar con ?bypass_dedupe=1)
    const bypass = String(req.query.bypass_dedupe || "0") === "1";
    const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").toString().split(",")[0].trim();
    if (!bypass && isRecent(ip, baseParams)) {
      res.status(208).json({ ok:false, note:"duplicate_tts_suppressed" });
      return;
    }

    // TCP/HTTP para latencia baja
    try { req.socket.setNoDelay(true); } catch {}
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Accel-Buffering", "no");
    res.setHeader("Connection", "keep-alive");

    // 1) intenta proveedor pedido/default
    // 2) cae al otro si falla
    for (const prov of [baseParams.provider, (baseParams.provider.toLowerCase()==="xtts"?"google":"xtts")]) {
      const url = new URL("/tts", VOZ_URL);
      const params = { ...baseParams, provider: prov };
      if (prov.toLowerCase() === "xtts" && CURRENT_REF) params.ref = CURRENT_REF; else delete params.ref;
      url.search = toQS(params);

      const t0 = Date.now();
      const up = await fetch(url.toString(), { headers: { "Accept": "audio/wav", "Connection": "keep-alive" } });
      if (!up.ok) continue;

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
          console.log(`[tts stream] done bytes=${total} ms=${ms}, provider=${prov}`);
          return;
        }
        total += value.byteLength;
        if (first) {
          const ms1 = Date.now() - t0;
          first = false;
          console.log(`[tts stream] firstByte at ${ms1}ms, provider=${prov}`);
        }
        res.write(Buffer.from(value));
        return pump();
      }
      return pump();
    }

    return res.status(502).json({ ok:false, error:"tts upstream failed" });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ===== Genera WAV y guarda (para <audio src>) =====
app.get("/api/tts_save", async (req,res)=>{
  try{
    if (!VOZ_URL) return res.status(500).json({ ok:false, error:"missing_VOZ_URL" });

    const baseParams = {
      text: req.query.text || "Hola",
      lang: req.query.lang || "es",
      rate: req.query.rate || "1.10",
      temp: req.query.temp || "0.55",
      fx: "0",
      provider: req.query.provider || TTS_PROVIDER_DEFAULT,
      t: Date.now().toString()
    };

    baseParams.text = collapseImmediateDupes(baseParams.text);

    const resp = await fetchTTSWithFallback("/tts_save", baseParams);
    if (!resp.ok) return res.status(500).json({ ok:false, upstream_status:resp.status, detail:resp.detail||"tts_save upstream failed" });

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

// ===== Probe (parcheado: ignora TypeError: terminated de undici al cancelar) =====
app.get("/api/_diag/tts_probe", async (req, res) => {
  try {
    if (!VOZ_URL) return res.status(500).json({ ok:false, error:"missing_VOZ_URL" });
    const baseParams = {
      text: collapseImmediateDupes(req.query.text || "hola"),
      lang: req.query.lang || "es",
      rate: req.query.rate || "1.10",
      temp: req.query.temp || "0.55",
      provider: req.query.provider || TTS_PROVIDER_DEFAULT,
      t: Date.now().toString(),
    };
    const url = new URL("/tts", VOZ_URL); url.search = toQS(baseParams);
    const t0 = Date.now();
    const up = await fetch(url.toString(), { headers: { Accept: "audio/wav" } });
    const tConn = Date.now() - t0;

    if (!up.body) return res.json({ ok:false, status: up.status, note:"no_body", connect_ms: tConn });

    const reader = up.body.getReader();
    let tFirst = null, total = 0, ok = true;

    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (tFirst === null) tFirst = Date.now() - t0;
        if (total > 96 * 1024) { // ~100KB bastan para medir
          await reader.cancel(); // <- cancelar explicitamente
          break;
        }
      }
    } catch (e) {
      // undici lanza "TypeError: terminated" cuando cancelamos; lo tratamos como OK.
      if (!(e instanceof TypeError && String(e.message || "").includes("terminated"))) {
        ok = false;
      }
    }

    res.json({ ok, status: up.status, connect_ms: tConn, first_byte_ms: tFirst ?? -1, sampled_bytes: total, provider_used: baseParams.provider });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e) });
  }
});

// ===== Memory sync no-op =====
app.post("/api/memory/sync", (_req,res)=> res.json({ ok:true }));

// ===== Arranque =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor listo en puerto ${PORT} | VOICE_REF=${CURRENT_REF} | TTS_PROVIDER=${TTS_PROVIDER_DEFAULT}`));
