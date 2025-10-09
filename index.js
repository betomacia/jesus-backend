// index.js — Backend monolítico (API + Proxy XTTS)
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const OpenAI = require("openai");
const path = require("path");
const fs = require("fs/promises");
const { Readable } = require("stream");
const http = require("http");
const https = require("https");

if (typeof fetch === "undefined") {
  global.fetch = require("node-fetch");
}

// --- Keep-Alive para upstream ---
const HTTP_AGENT  = new http.Agent({ keepAlive: true, keepAliveMsecs: 10000, maxSockets: 100 });
const HTTPS_AGENT = new https.Agent({ keepAlive: true, keepAliveMsecs: 10000, maxSockets: 100 });
function agentFor(url) {
  return String(url).startsWith("https:") ? { agent: HTTPS_AGENT } : { agent: HTTP_AGENT };
}

// --- Express ---
const app = express();
app.disable("x-powered-by");
app.use(bodyParser.json());
app.use(cors({ origin: "*", methods: ["GET","POST","OPTIONS"], allowedHeaders: ["Content-Type","Authorization"] }));
app.options("*", cors());
app.use((req,res,next)=>{
  res.header("Access-Control-Allow-Origin","*");
  res.header("Access-Control-Allow-Methods","GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers","Content-Type,Authorization");
  if (req.method==="OPTIONS") return res.sendStatus(204);
  next();
});

// --- Config ---
const VOZ_URL = (process.env.VOZ_URL || "http://127.0.0.1:8006").replace(/\/+$/, "");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- Helpers ---
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
async function ensureDataDir(){ try{ await fs.mkdir(DATA_DIR,{recursive:true}); }catch{} }
function _base(req){
  const proto=req.headers["x-forwarded-proto"]||req.protocol||"http";
  const host=req.headers["x-forwarded-host"]||req.get("host");
  return `${proto}://${host}`;
}

// ---------- Health ----------
app.get("/", (_req,res)=>res.json({ok:true,service:"backend",ts:Date.now()}));
app.get("/api/health", async (req,res)=>{
  try{
    let upstream=null;
    try{
      const r=await fetch(`${VOZ_URL}/health`,{...agentFor(VOZ_URL)});
      upstream=await r.json().catch(()=>null);
    }catch{}
    res.json({ok:true,proxy:"node",voz_url:VOZ_URL,upstream});
  }catch(e){ res.status(500).json({ok:false,error:String(e)}); }
});

// ---------- Rutas API ----------
app.post("/api/welcome", async (req,res)=>{
  try{
    const { lang="es", name="", userId="anon" } = req.body||{};
    const phrase = "La paz sea contigo.";
    const question = lang==="en" ? "What would help you right now?" : "¿En qué te puedo acompañar ahora?";
    res.json({ message:`Hola ${name||"amigo"}. ${phrase}`, question });
  }catch{ res.json({ message:"La paz sea contigo.", question:"¿En qué te puedo acompañar ahora?" }); }
});

app.post("/api/ask", async (req,res)=>{
  try{
    const { message="", lang="es" } = req.body||{};
    const out = { message: "Estoy contigo.", question: "¿Qué sientes ahora?", bible: { text:"", ref:"" } };
    res.json(out);
  }catch(e){ res.json({ message:"Error interno", question:"", bible:{text:"",ref:""} }); }
});

// ====================================================
// ===============  RUTAS DE VOZ (XTTS)  ==============
// ====================================================

// /api/tts → proxy directo a WAV
app.get("/api/tts", async (req,res)=>{
  try{
    const q=new URLSearchParams(req.query);
    const url=`${VOZ_URL}/tts?${q.toString()}`;
    const up=await fetch(url,{headers:{Accept:"audio/wav"},...agentFor(VOZ_URL)});
    const ab=await up.arrayBuffer(); const buf=Buffer.from(ab);
    res.status(up.status).set("Content-Type",up.headers.get("content-type")||"audio/wav");
    res.set("Access-Control-Allow-Origin","*");
    res.send(buf);
  }catch(e){ res.status(500).send("proxy_tts_error:"+String(e)); }
});

// /api/tts_save → devuelve URL reescrita
app.get("/api/tts_save", async (req,res)=>{
  try{
    const q=new URLSearchParams(req.query);
    const r=await fetch(`${VOZ_URL}/tts_save?${q}`,{headers:{Accept:"application/json"},...agentFor(VOZ_URL)});
    const j=await r.json();
    const name=String(j.url||j.file||j.path||"").split("/").pop();
    if(!name) return res.status(502).json({ok:false,error:"filename_missing"});
    const mine=`${_base(req)}/api/files/${name}`;
    res.set("Access-Control-Allow-Origin","*");
    res.json({ok:true,url:mine});
  }catch(e){ res.status(500).json({ok:false,error:String(e)}); }
});

// /api/tts_save_segmented
app.get("/api/tts_save_segmented", async (req,res)=>{
  try{
    const q=new URLSearchParams(req.query);
    const r=await fetch(`${VOZ_URL}/tts_save_segmented?${q}`,{headers:{Accept:"application/json"},...agentFor(VOZ_URL)});
    const j=await r.json();
    const base=_base(req);
    const parts=(j.parts||[]).map(u=>`${base}/api/files/${String(u).split("/").pop()}`);
    res.set("Access-Control-Allow-Origin","*");
    res.json({ok:true,chunks:parts.length,parts});
  }catch(e){ res.status(500).json({ok:false,error:String(e)}); }
});

// /api/files/:name
app.get("/api/files/:name", async (req,res)=>{
  try{
    const name=String(req.params.name||"");
    const upstream=await fetch(`${VOZ_URL}/files/${encodeURIComponent(name)}`,{headers:{Accept:"audio/wav"},...agentFor(VOZ_URL)});
    res.status(upstream.status);
    res.setHeader("Access-Control-Allow-Origin","*");
    res.setHeader("Content-Type",upstream.headers.get("content-type")||"audio/wav");
    if(upstream.body){
      const nodeStream=Readable.fromWeb?Readable.fromWeb(upstream.body):Readable.from(upstream.body);
      nodeStream.pipe(res);
    } else res.end();
  }catch(e){ res.status(500).send("files_proxy_error:"+String(e)); }
});

// /api/voice/segment → passthrough
app.get("/api/voice/segment", async (req,res)=>{
  try{
    const q=new URLSearchParams(req.query);
    const r=await fetch(`${VOZ_URL}/tts_save_segmented?${q}`,{headers:{Accept:"application/json"},...agentFor(VOZ_URL)});
    const j=await r.json();
    const base=_base(req);
    const parts=(j.parts||[]).map(u=>`${base}/api/files/${String(u).split("/").pop()}`);
    res.set("Access-Control-Allow-Origin","*");
    res.json({ok:true,chunks:parts.length,parts});
  }catch(e){ res.status(500).json({ok:false,error:String(e)}); }
});

// /api/tts_stream_segmented → reenvío SSE
app.get("/api/tts_stream_segmented", async (req,res)=>{
  req.socket?.setNoDelay?.(true);
  res.socket?.setNoDelay?.(true);
  res.setHeader("Content-Type","text/event-stream; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Cache-Control","no-cache, no-transform");
  res.flushHeaders?.();
  res.write(`event: ping\ndata: {"ts":${Date.now()}}\n\n`);

  const url=new URL("/tts_stream_segmented",VOZ_URL);
  for(const [k,v] of Object.entries(req.query)) url.searchParams.set(k,String(v));
  const upstream=await fetch(url.toString(),{headers:{Accept:"text/event-stream"},...agentFor(VOZ_URL)});
  if(!upstream.ok||!upstream.body){ res.end(); return; }

  const decoder=new TextDecoder(); let carry=""; const base=_base(req);
  const reader=upstream.body.getReader();
  while(true){
    const {done,value}=await reader.read(); if(done) break;
    carry+=decoder.decode(value,{stream:true});
    let idx; while((idx=carry.indexOf("\n"))>=0){
      const line=carry.slice(0,idx); carry=carry.slice(idx+1);
      if(line.startsWith("data:")){
        try{
          const obj=JSON.parse(line.slice(5).trim());
          if(obj?.url){ const name=obj.url.split("/").pop(); obj.url=`${base}/api/files/${name}`; }
          res.write(`data: ${JSON.stringify(obj)}\n\n`);
        }catch{ res.write(line+"\n"); }
      } else res.write(line+"\n");
    }
    res.flush?.();
  }
  if(carry) res.write(carry);
  res.end();
});

// ---------- Arranque ----------
const PORT=process.env.PORT||3000;
app.listen(PORT,()=>console.log(`Servidor listo en puerto ${PORT}`));
