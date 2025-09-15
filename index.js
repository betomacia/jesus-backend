// index.js — Conversación servicial y profunda (multi-idioma, antirep, 100% OpenAI)
// - /api/welcome: saludo por hora **del dispositivo** + nombre + frase alentadora + 1 pregunta ABIERTA terapéutica
//     (sin A/B, sin hobbies/planes; centrada en “lo que trae hoy”)
// - /api/ask: tres modos conversacionales con foco en AUTOAYUDA real
//     * explore: validación concreta + **1 micro-acción inmediata** (no “diario” salvo que lo pida) + 1 línea espiritual (sin cita) + 1 pregunta focal
//     * permiso: 1–2 cursos de acción posibles + 1 línea espiritual + **pregunta de permiso** específica al tema
//     * ejecutar: **guion/plan paso a paso** (p. ej., diálogo con la pareja: contexto, “mensajes en yo”, 2–3 frases modelo, límite y cierre) + 1 pregunta de ajuste
// - Anti-repetición: preguntas, estilos de pregunta (q_style), técnicas (cooldown de respiración/escritura) y **citas bíblicas** (bloquea Mateo/Matthew 11:28 en todos los idiomas)
// - Memoria en /data (DATA_DIR configurable)
// - HeyGen y CORS abiertos
//
// Env: OPENAI_API_KEY, DATA_DIR (opcional), HEYGEN_* (opcional)

const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const OpenAI = require("openai");
const path = require("path");
const fs = require("fs/promises");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(bodyParser.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------- Utils ----------
const NORM = (s="") => String(s).toLowerCase().replace(/\s+/g," ").trim();

function cleanRef(ref=""){ return String(ref).replace(/\s*\([^)]*\)\s*/g," ").replace(/\s+/g," ").trim(); }
function stripQuestionsFromMessage(s=""){
  const noTrailingQ = String(s).split(/\n+/).map(l=>l.trim()).filter(l=>!/\?\s*$/.test(l)).join("\n").trim();
  return noTrailingQ.replace(/[¿?]+/g,"").trim();
}
function limitWords(s="", max=75){
  const w = String(s).trim().split(/\s+/);
  return w.length<=max ? String(s).trim() : w.slice(0,max).join(" ").trim();
}
function removeBibleLike(text=""){
  let s=String(text||"");
  s=s.replace(/^[\s]*[—-]\s*.*?\([^)]+?\d+\s*:\s*\d+\)[\s]*$/gim,"").trim();
  s=s.replace(/\(([^)]+?\d+\s*:\s*\d+)\)/g,()=> "");
  s=s.replace(/\s*[—-]\s*[^()]*\(\s*[^)]+?\d+\s*:\s*\d+\s*\)\s*$/g,"").trim();
  return s.replace(/[ \t]+\n/g,"\n").replace(/\n{3,}/g,"\n\n").trim();
}
function compactHistory(history=[], keep=8, maxLen=260){
  const arr = Array.isArray(history)?history:[];
  return arr.slice(-keep).map(x=>String(x).slice(0,maxLen));
}
function langLabel(l="es"){
  const m={es:"Español",en:"English",pt:"Português",it:"Italiano",de:"Deutsch",ca:"Català",fr:"Français"};
  return m[l]||"Español";
}

// --- Hora local del cliente ---
function resolveClientHour({hour=null, client_iso=null, tz=null}={}){
  if (Number.isInteger(hour) && hour>=0 && hour<24) return hour;
  if (client_iso){
    const d = new Date(client_iso);
    if (!isNaN(d.getTime())) return d.getHours();
  }
  if (tz){
    try{
      const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false });
      const parts = fmt.formatToParts(new Date());
      const h = parseInt(parts.find(p=>p.type==="hour")?.value || "0",10);
      if (!isNaN(h)) return h;
    }catch{}
  }
  return new Date().getHours();
}
function greetingByHour(lang="es", opts={}){
  const h = resolveClientHour(opts);
  const g=(m,a,n)=>h<12?m:h<19?a:n;
  switch(lang){
    case "en": return g("Good morning","Good afternoon","Good evening");
    case "pt": return g("Bom dia","Boa tarde","Boa noite");
    case "it": return g("Buongiorno","Buon pomeriggio","Buonasera");
    case "de": return g("Guten Morgen","Guten Tag","Guten Abend");
    case "ca": return g("Bon dia","Bona tarda","Bona nit");
    case "fr": return g("Bonjour","Bon après-midi","Bonsoir");
    default:   return g("Buenos días","Buenas tardes","Buenas noches");
  }
}

// ---------- Detección de RECENCIA (multi-idioma) ----------
function detectRecency(s=""){
  const x=NORM(s);
  // Hoy / ahora / recién / hace horas
  const today = /\b(hoy|reci[eé]n|ahora|hace un rato|esta (mañana|tarde|noche))\b/.test(x)
             || /\b(today|just now|right now|earlier today|this (morning|afternoon|evening))\b/.test(x)
             || /\b(hoje|agora|agorinha|mais cedo hoje|esta (manhã|tarde|noite))\b/.test(x)
             || /\b(oggi|adesso|poco fa|questa (mattina|pomeriggio|sera))\b/.test(x)
             || /\b(heute|gerade eben|soeben|heute (Morgen|Nachmittag|Abend))\b/.test(x)
             || /\b(avui|ara|fa una estona|aquest (matí|tarda|vespre))\b/.test(x)
             || /\b(aujourd'hui|à l'instant|tout à l'heure|ce (matin|après-midi|soir))\b/.test(x);
  if (today) return "today";
  const yesterday = /\b(ayer)\b/.test(x) || /\b(yesterday)\b/.test(x) || /\b(ontem)\b/.test(x) || /\b(ieri)\b/.test(x) || /\b(gestern)\b/.test(x) || /\b(ahir)\b/.test(x) || /\b(hier)\b/.test(x);
  if (yesterday) return "yesterday";
  const hours = /\bhace\s+\d+\s*(h|horas?)\b/.test(x) || /\b\d+\s*(hours?|hrs?)\s*ago\b/.test(x) || /\bh[aá]\s*\d+\s*(h|horas?)\b/.test(x);
  if (hours) return "hours";
  // genérico
  return "generic";
}
function fixTemporalQuestion(q="", recency="generic", lang="es"){
  if (!q) return q;
  const x = NORM(q);
  const weeksLike = /(últimas?|ders? derni[eè]res?|letzte[nr]?|ultime|darreres?)\s+(semanas|weeks|semanas|semanes|wochen|semaines|setmanes)/i;
  const daysLike  = /(últimos?|ders?|derni[eè]rs?|letzten?|ultimi|darrers?)\s+(d[ií]as|days|tage|jours|dias|dies)/i;
  if (recency==="today" || recency==="hours" || recency==="yesterday"){
    if (weeksLike.test(q) || daysLike.test(q)){
      const repl = (lang==="en"?"since today":"desde hoy");
      return q.replace(weeksLike, repl).replace(daysLike, repl);
    }
  }
  return q;
}

// ---------- Memoria en FS ----------
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname,"data");
async function ensureDataDir(){ try{ await fs.mkdir(DATA_DIR,{recursive:true}); }catch{} }
function memPath(uid){ const safe=String(uid||"anon").replace(/[^a-z0-9_-]/gi,"_"); return path.join(DATA_DIR,`mem_${safe}.json`); }
async function readUserMemory(userId){
  await ensureDataDir();
  try{
    const raw = await fs.readFile(memPath(userId),"utf8");
    const mem = JSON.parse(raw);
    mem.last_bible_refs = Array.isArray(mem.last_bible_refs) ? mem.last_bible_refs : [];
    mem.last_questions  = Array.isArray(mem.last_questions)  ? mem.last_questions  : [];
    mem.last_techniques = Array.isArray(mem.last_techniques) ? mem.last_techniques : [];
    mem.last_q_styles   = Array.isArray(mem.last_q_styles)   ? mem.last_q_styles   : [];
    return mem;
  }catch{
    return {
      last_bible_refs:[],
      last_questions:[],
      last_techniques:[],
      last_q_styles:[],
      frame:null,
      last_offer_kind:null,
      last_user_reply:null,
      pending_action:null,
      last_topic:null
    };
  }
}
async function writeUserMemory(userId,mem){
  await ensureDataDir();
  await fs.writeFile(memPath(userId), JSON.stringify(mem,null,2), "utf8");
}

// ---------- Heurísticas ----------
function guessTopic(s=""){
  const t=(s||"").toLowerCase();
  if (/(droga|adicci|alcohol|apuestas)/.test(t)) return "addiction";
  if (/(me separ|separaci[oó]n|divorcio|ruptura)/.test(t)) return "separation";
  if (/(pareja|matrimonio|conyug|novi[oa])/i.test(t)) return "relationship";
  if (/(duelo|falleci[oó]|perd[ií]|luto)/.test(t)) return "grief";
  if (/(ansied|p[áa]nico|depres|triste|miedo|temor|estr[eé]s|enojo|bronca|ira|rabia|furia)/.test(t)) return "mood";
  if (/(trabajo|despido|salario|dinero|deuda|finanzas)/.test(t)) return "work_finance";
  if (/(salud|diagn[oó]stico|enfermedad|dolor)/.test(t)) return "health";
  if (/(familia|conflicto|discusi[oó]n|suegr)/.test(t)) return "family_conflict";
  if (/(fe|duda|dios|oraci[oó]n|culpa)/.test(t)) return "faith";
  return "general";
}
function detectMainSubject(s=""){
  const t=(s||"").toLowerCase();
  if (/(mi\s+espos|mi\s+marid)/.test(t)) return "partner";
  if (/(mi\s+novi[oa])/.test(t)) return "partner";
  if (/(mi\s+hij[oa])/.test(t)) return "child";
  if (/(mi\s+madre|mam[aá])/.test(t)) return "mother";
  if (/(mi\s+padre|pap[aá])/.test(t)) return "father";
  if (/(mi\s+herman[oa])/.test(t)) return "sibling";
  if (/(mi\s+amig[oa])/.test(t)) return "friend";
  return "self";
}
function detectAffirmation(s=""){
  const x=NORM(s);
  const pats=[
    /\bsi\b|\bsí\b|\bclaro\b|\bde acuerdo\b|\bok\b|\bvale\b|\bperfecto\b/,
    /\byes\b|\byep\b|\byup\b|\bsure\b|\bok\b|\bokay\b/,
    /\bsim\b|\bclaro\b|\bok\b/,
    /\bsì\b|\bcerto\b|\bva bene\b/,
    /\bja\b|\bjawohl\b|\bok\b/,
    /\boui\b|\bd’accord\b|\bok\b/,
    /\bsí\b|\bsi\b/
  ];
  return pats.some(r=>r.test(x));
}
function detectNegation(s=""){
  const x=NORM(s);
  const pats=[
    /\bno\b|\bmejor no\b|\bno gracias\b/,
    /\bnope\b|\bnah\b|\bno thanks\b/,
    /\bnão\b|\bnão obrigado\b|\bnão obrigada\b/,
    /\bnon\b|\bno grazie\b/,
    /\bnein\b|\bkein\b/,
    /\bnon\b|\bpas\b/
  ];
  return pats.some(r=>r.test(x));
}
function detectByeThanks(s=""){
  const x=NORM(s);
  const pats=[
    /\bgracias\b|\bmuchas gracias\b|\bmil gracias\b|\bme tengo que ir\b|\bme voy\b|\bhasta luego\b|\badiós\b/,
    /\bthanks\b|\bthank you\b|\bi have to go\b|\bgotta go\b|\bbye\b|\bsee you\b/,
    /\bobrigado\b|\bobrigada\b|\bvaleu\b|\btenho que ir\b|\btchau\b|\bate logo\b/,
    /\bgrazie\b|\bdevo andare\b|\bciao\b|\ba dopo\b/,
    /\bdanke\b|\bmuss gehen\b|\btschüss\b/,
    /\bmerci\b|\bje dois partir\b|\bau revoir\b/
  ];
  return pats.some(r=>r.test(x));
}
function detectVague(s=""){
  const x=NORM(s);
  if (!x) return true;
  if (x.length < 12) return true;
  if (/\btengo un problema\b|\bproblema\b|\bnecesito ayuda\b|\bno sé por dónde empezar\b|\bno se por donde empezar\b|\bhola\b|\bestoy mal\b/i.test(x)) return true;
  return false;
}
function detectRequestExecute(s=""){
  const x=NORM(s);
  return /\bdime qu[eé] hacer\b|\bdecime qu[eé] hacer\b|\bquiero pasos\b|\bquiero que me digas\b|\bayudame a\b|\bayúdame a\b|\bquiero que me gu[ií]es\b|\bprobar[eé] la respiraci[oó]n\b|\bquiero hablar con\b|\bc[oó]mo hablar con\b|\barmar un guion\b|\bgu[ií]ame\b/i.test(x);
}

// ---- Filtros PREGUNTA bienvenida (multi-idioma) ----
function isBadWelcomeQuestion(q=""){
  const x=NORM(q);
  if (!x) return true;
  if (/\b(o|ou|or|oder|o bien|ou bien)\b/.test(x)) return true; // A/B
  const hobbyOrPlans = [
    "hobby","hobbies","pasatiempo","pasatiempos","aficion","aficiones","aficions",
    "planes","planos","pläne","plans","weekend","fin de semana","wochenende",
    "tiempo libre","temps libre","tempo livre","freizeit",
    "qué te gusta hacer","que te gusta hacer","what do you like to do",
    "cosa ti piace fare","was machst du gern","què t'agrada fer","ce que tu aimes faire",
    "disfrutas","enjoy","curtir","loisirs","passe-temps","passatempi"
  ].some(p=>x.includes(p));
  if (hobbyOrPlans) return true;
  const forcedPos = [
    "pleno","plenitud","plena","alegria","alegrías","alegrias","felicidad",
    "joy","joys","joyful","happy today","gioia","felice","freude","glücklich",
    "joie","heureux","feliç","alegria avui"
  ].some(p=>x.includes(p));
  if (forcedPos) return true;
  if (/\b(c[oó]mo est[aá]s|how are you|como vai|come stai|wie geht|comment [çc]a va)\b/.test(x)) return true;
  return false;
}

// ---- Citas bíblicas vetadas (Mateo/Matthew 11:28 en todos los idiomas y alias) ----
function isRefMat11_28(ref=""){
  const x = NORM(ref);
  if (!x) return false;
  const pats = [
    /mateo\s*11\s*:\s*28/, /mt\.?\s*11\s*:\s*28/, /mat\.?\s*11\s*:\s*28/, /san\s+mateo\s*11\s*:\s*28/,
    /matthew?\s*11\s*:\s*28/, /matteo\s*11\s*:\s*28/, /matthäus\s*11\s*:\s*28/, /matthieu\s*11\s*:\s*28/,
    /mateu\s*11\s*:\s*28/, /mateus\s*11\s*:\s*28/
  ];
  return pats.some(r=>r.test(x));
}
const BANNED_REFS = ["Mateo 11:28","Mt 11:28","Mat 11:28","Matthew 11:28","Matteo 11:28","Matthäus 11:28","Matthieu 11:28","Mateu 11:28","Mateus 11:28"];

// ---------- OpenAI formats ----------
const FORMAT_WELCOME = {
  type:"json_schema",
  json_schema:{
    name:"WelcomeSchema",
    schema:{
      type:"object",
      properties:{
        message:{type:"string"},
        question:{type:"string"}
      },
      required:["message","question"],
      additionalProperties:false
    }
  }
};
const FORMAT_ASK = {
  type:"json_schema",
  json_schema:{
    name:"SpiritualGuidance",
    schema:{
      type:"object",
      properties:{
        message:{type:"string"},
        bible:{type:"object",properties:{text:{type:"string"},ref:{type:{type:"string"}}},required:["text","ref"]},
        question:{type:"string"},
        techniques:{type:"array", items:{type:"string"}},
        q_style:{type:"string"}
      },
      required:["message","bible","question","q_style"],
      additionalProperties:false
    }
  }
};
const FORMAT_BIBLE_ONLY = {
  type:"json_schema",
  json_schema:{
    name:"BibleOnly",
    schema:{
      type:"object",
      properties:{ bible:{type:"object",properties:{text:{type:"string"},ref:{type:"string"}},required:["text","ref"]} },
      required:["bible"],
      additionalProperties:false
    }
  }
};
async function completionJson({messages, temperature=0.6, max_tokens=260, timeoutMs=12000, response_format}){
  const call = openai.chat.completions.create({
    model:"gpt-4o",
    temperature,
    max_tokens,
    messages,
    response_format: response_format || FORMAT_ASK
  });
  return await Promise.race([ call, new Promise((_,rej)=>setTimeout(()=>rej(new Error("TIMEOUT")), timeoutMs)) ]);
}

// ---------- Health ----------
app.get("/", (_req,res)=> res.json({ok:true, service:"backend", ts:Date.now()}));
app.get("/api/welcome", (_req,res)=> res.json({ok:true, hint:"POST /api/welcome { lang, name, userId, history, hour?, client_iso?, tz? }"}));
app.post("/api/memory/sync", (_req,res)=> res.json({ok:true}));

// ---------- /api/welcome ----------
app.post("/api/welcome", async (req,res)=>{
  try{
    const { lang="es", name="", userId="anon", history=[], hour=null, client_iso=null, tz=null } = req.body||{};
    const nm = String(name||"").trim();

    const hi = greetingByHour(lang, {hour, client_iso, tz});
    const mem = await readUserMemory(userId);
    const avoidQs = Array.isArray(mem.last_questions)? mem.last_questions.slice(-10):[];
    const shortHistory = compactHistory(history,6,200);

    const SYSTEM_PROMPT = `
Eres cercano, sereno y compasivo. Varía el lenguaje, evita muletillas, hobbies/planes y positivismo forzado.

SALIDA SOLO JSON (en ${langLabel(lang)}):
- "message": ≤75 palabras. Incluye saludo por franja y **nombre si existe** (p.ej. "${hi}${nm?`, ${nm}`:""}"). Da **una** frase alentadora del día y expresa **disponibilidad**. **Sin preguntas** y **sin citas bíblicas** dentro del "message".
- "question": **UNA** pregunta **abierta terapéutica** para que el usuario cuente **lo que trae hoy** (qué pasó, desde cuándo o impacto). Debe **terminar en "?"**.
  - Prohibido: opciones A/B, técnicas, hobbies/planes/tiempo libre, y fórmulas de plenitud/alegrías.
  - Evita repetir recientes: ${avoidQs.map(q=>`"${q}"`).join(", ")||"(ninguna)"}.
No menciones IA/modelos.
`;
    const header =
      `Lang: ${lang}\n`+
      `Nombre: ${nm||"(anónimo)"}\n`+
      `Saludo_sugerido: ${hi}${nm?`, ${nm}`:""}\n`+
      (shortHistory.length?`Historial: ${shortHistory.join(" | ")}`:"Historial: (sin antecedentes)")+"\n";

    const r = await completionJson({
      messages: [{ role:"system", content: SYSTEM_PROMPT }, { role:"user", content: header }],
      temperature: 0.8,
      max_tokens: 260,
      response_format: FORMAT_WELCOME
    });

    const content = r?.choices?.[0]?.message?.content || "{}";
    let data={}; try{ data=JSON.parse(content);}catch{ data={}; }
    let msg = limitWords(stripQuestionsFromMessage(removeBibleLike(String(data?.message||""))), 75);
    let question = String(data?.question||"").trim();
    if (question && !/\?\s*$/.test(question)) question += "?";

    if (!question || isBadWelcomeQuestion(question)){
      // Fallback seguro
      question = (lang==="en"
        ? "What happened recently that you’d like to talk about?"
        : lang==="pt" ? "O que aconteceu recentemente que você gostaria de conversar?"
        : lang==="it" ? "Che cosa è successo recentemente di cui vorresti parlare?"
        : lang==="de" ? "Was ist kürzlich passiert, worüber du sprechen möchtest?"
        : lang==="ca" ? "Què ha passat recentment que vulguis compartir?"
        : lang==="fr" ? "Qu’est-il arrivé récemment dont tu aimerais parler ?"
        : "¿Qué ocurrió recientemente que te gustaría conversar?");
    }

    if (question){
      mem.last_questions = Array.isArray(mem.last_questions)? mem.last_questions : [];
      mem.last_questions.push(question);
      while(mem.last_questions.length>10) mem.last_questions.shift();
      await writeUserMemory(userId, mem);
    }

    res.status(200).json({
      message: msg || `${hi}${nm?`, ${nm}`:""}. Estoy aquí para escucharte con calma.`,
      bible: { text:"", ref:"" },
      question
    });
  }catch(e){
    console.error("WELCOME ERROR:", e);
    const hi = greetingByHour("es");
    res.status(200).json({
      message: `${hi}. Estoy aquí para escucharte con calma.`,
      bible:{ text:"", ref:"" },
      question: "¿Qué ocurrió recientemente que te gustaría conversar?"
    });
  }
});

// ---------- /api/ask (explorar → permiso → ejecutar, con AUTOAYUDA real) ----------
async function regenerateBibleAvoiding({ lang, persona, message, frame, bannedRefs = [], lastRef = "" }) {
  const SYS = `
Devuelve SOLO JSON {"bible":{"text":"…","ref":"Libro 0:0"}} en ${langLabel(lang)}.
- Ajusta la cita al tema/contexto.
- Evita referencias recientes: ${bannedRefs.map(r=>`"${r}"`).join(", ")||"(ninguna)"} y la última: "${lastRef||"(n/a)"}".
- Evita Mateo/Matthew 11:28 (todas las variantes de idioma).
- No agregues nada fuera del JSON.
`;
  const USR = `Persona: ${persona}\nMensaje_usuario: ${message}\nFRAME: ${JSON.stringify(frame)}`;
  const r = await completionJson({
    messages:[{role:"system",content:SYS},{role:"user",content:USR}],
    temperature:0.4,
    max_tokens:120,
    response_format: FORMAT_BIBLE_ONLY
  });
  const content = r?.choices?.[0]?.message?.content || "{}";
  let data={}; try{ data=JSON.parse(content);}catch{ data={}; }
  const text = (data?.bible?.text||"").toString().trim();
  const ref  = cleanRef((data?.bible?.ref||"").toString());
  return text && ref ? { text, ref } : null;
}

app.post("/api/ask", async (req,res)=>{
  try{
    const { persona="jesus", message="", history=[], userId="anon", lang="es" } = req.body||{};
    const mem = await readUserMemory(userId);

    const userTxt = String(message||"").trim();
    const isBye   = detectByeThanks(userTxt);
    const saidYes = detectAffirmation(userTxt);
    const saidNo  = detectNegation(userTxt);

    const topic = guessTopic(userTxt);
    const mainSubject = detectMainSubject(userTxt);
    const recency = detectRecency(userTxt);
    const frame = {
      topic_primary: topic,
      main_subject: mem.frame?.topic_primary===topic ? (mem.frame?.main_subject||mainSubject) : mainSubject,
      support_persons: mem.frame?.topic_primary===topic ? (mem.frame?.support_persons||[]) : [],
      recency_hint: recency
    };
    mem.frame = frame;
    mem.last_topic = topic;

    const avoidRefs = Array.isArray(mem.last_bible_refs)? mem.last_bible_refs.slice(-8):[];
    const avoidQs   = Array.isArray(mem.last_questions)? mem.last_questions.slice(-10):[];
    const avoidTech = Array.isArray(mem.last_techniques)? mem.last_techniques.slice(-6):[];
    const avoidQStyles = Array.isArray(mem.last_q_styles)? mem.last_q_styles.slice(-6):[];
    const shortHistory = compactHistory(history,10,240);

    let MODE = "explore";
    if (isBye) MODE = "bye";
    else if (detectRequestExecute(userTxt) || saidYes) MODE = "execute";
    else if (!detectVague(userTxt) && topic!=="general") MODE = "permiso";
    if (saidNo && MODE!=="bye") MODE = "explore";

    const BAD_GENERIC_Q = /(qué te aliviaría|que te aliviar[ií]a|qué pequeño paso|qué vas a|qué harás|qué plan)/i;

    // pista de destinatario por tema (para preguntas de permiso)
    const TOPIC_HINT = {
      relationship: { es:"tu pareja", en:"your partner", pt:"sua parceria", it:"il tuo partner", de:"deinem Partner", ca:"la teva parella", fr:"ton/ta partenaire" },
      separation:   { es:"esta separación", en:"this separation", pt:"esta separação", it:"questa separazione", de:"diese Trennung", ca:"aquesta separació", fr:"cette séparation" },
      family_conflict: { es:"tu familia", en:"your family", pt:"sua família", it:"la tua famiglia", de:"deiner Familie", ca:"la teva família", fr:"ta famille" },
      mood: { es:"tus emociones", en:"your emotions", pt:"suas emoções", it:"le tue emozioni", de:"deine Gefühle", ca:"les teves emocions", fr:"tes émotions" },
      grief: { es:"tu duelo", en:"your grief", pt:"seu luto", it:"il tuo lutto", de:"deine Trauer", ca:"el teu dol", fr:"ton deuil" },
      health: { es:"tu salud", en:"your health", pt:"sua saúde", it:"la tua salute", de:"deine Gesundheit", ca:"la teva salut", fr:"ta santé" },
      work_finance: { es:"tu trabajo o finanzas", en:"your work or finances", pt:"seu trabalho ou finanças", it:"il tuo lavoro o finanze", de:"deine Arbeit oder Finanzen", ca:"la teva feina o finances", fr:"ton travail ou tes finances" },
      addiction: { es:"tu proceso de recuperación", en:"your recovery process", pt:"seu processo de recuperação", it:"il tuo percorso di recupero", de:"deinen Genesungsweg", ca:"el teu procés de recuperació", fr:"ton chemin de rétablissement" },
      faith: { es:"tu fe", en:"your faith", pt:"sua fé", it:"la tua fede", de:"deinen Glauben", ca:"la teva fe", fr:"ta foi" }
    }[topic]?.[lang] || null;

    // ---------- PROMPT principal ----------
    const SYSTEM_PROMPT = `
Hablas con serenidad, claridad y compasión. Evita metáforas largas; sé **concreto y clínico** en lenguaje simple.

MODO ACTUAL: ${MODE}; RECENCY: ${recency}

SALIDA SOLO JSON (en ${langLabel(lang)}):
- "message": ≤75 palabras, **sin signos de pregunta**.
  * Si MODO=explore: 
      - 1–2 frases de validación **concreta** (no poética).
      - **1 micro-acción inmediata** orientada a estabilizar o entender (ej.: lugar tranquilo para hablar, **time-out 24h** antes de reaccionar, **no_escalar** en discusiones, **guion_dialogo_pareja** breve, **oars_escucha** con un familiar, **behavioral_activation** leve, **opposite_action** ante rumiación, **cognitive_reframe** 1 pensamiento, **apoyo_red_social** hoy, **walk_10min**, **hydrate**). **Evita “escritura/diario”** salvo que el usuario lo pida.
      - 1 línea espiritual breve (sin cita en "message").
  * Si MODO=permiso: 
      - 1–2 rumbos claros (ej.: “armamos un **guion** para hablar con ${TOPIC_HINT||"la otra persona"}” / “regulamos bronca y definimos **límites asertivos**”).
      - 1 línea espiritual; deja claro que podés guiar cuando el usuario quiera.
  * Si MODO=execute:
      - **Guía paso a paso** (1–3 min si aplica). 
      - Relación/separación: plan de conversación sincera: contexto, **mensajes en yo**, 2–3 frases modelo, **límite** y **cierre**.
      - Emoción intensa: protocolo breve (exhalación 4–6 **solo si no se usó en el turno anterior**, + pausa 90s + **reencuadre cognitivo**).
      - Evita “escritura/diario” si fue usada en el turno previo.
- "bible": texto + ref, ajustada al contexto/tema. Evita repetir: ${avoidRefs.map(r=>`"${r}"`).join(", ")||"(ninguna)"} **y** evita Mateo/Matthew 11:28 en cualquier idioma/abreviatura.
- "question": **UNA sola**.
  * explore → **pregunta focal** para entender: qué ocurrió, **desde cuándo** (respetando RECENCY: si es “today/hours/yesterday”, **prohibido** “últimas semanas/días”), y/o dónde impacta (pareja/familia/trabajo/salud/fe). Sin A/B ni genéricas.
  * permiso → **pregunta de permiso** específica (“¿Querés que te diga **qué decir y cómo**?” sobre ${TOPIC_HINT||"el tema"}).
  * execute → **pregunta de ajuste/check-in** (¿adaptamos el guion?, ¿otra frase?, ¿siguiente micro-paso?).
  * bye → **omite** pregunta.
  Debe terminar en "?" y evitar preguntas genéricas tipo (qué te aliviaría / qué plan).
- "techniques": etiquetas si sugieres técnicas (ej.: ["time_out_24h","no_escalar","guion_dialogo_pareja","message_en_yo","oars_escucha","behavioral_activation","opposite_action","cognitive_reframe","walk_10min","hydrate","breathing_exhale46","prayer_short","limites_asertivos","apoyo_red_social"]).
- "q_style": etiqueta del estilo de pregunta (ej.: "explore_event","explore_since_now","explore_impact","permiso_guion","permiso_regulacion","execute_checkin","execute_adjust").

PRIORIDADES:
- **Autoayuda primero**: acciones concretas útiles al tema (no solo respiración).
- Si la última técnica fue respiración o escritura (en recientes: ${avoidTech.join(", ")||"(ninguna)"}), **no** las repitas ahora.
- Varía el estilo de la **pregunta** y evita repetir estilos recientes: ${avoidQStyles.join(", ")||"(ninguno)"}.
No menciones IA/modelos.
`;

    const header =
      `Persona: ${persona}\n`+
      `Lang: ${lang}\n`+
      `Mensaje_usuario: ${userTxt}\n`+
      (shortHistory.length?`Historial: ${shortHistory.join(" | ")}`:"Historial: (sin antecedentes)")+"\n"+
      `Evitar_refs: ${[...avoidRefs, ...BANNED_REFS].join(" | ")||"(ninguna)"}\n`+
      `Evitar_preguntas: ${avoidQs.join(" | ")||"(ninguna)"}\n`+
      `Evitar_tecnicas: ${avoidTech.join(" | ")||"(ninguna)"}\n`+
      `Evitar_q_styles: ${avoidQStyles.join(" | ")||"(ninguno)"}\n`+
      `FRAME: ${JSON.stringify(frame)}\n`;

    // 1) Generación
    let r = await completionJson({
      messages: [{role:"system",content:SYSTEM_PROMPT},{role:"user",content:header}],
      temperature:0.6,
      max_tokens:360,
      response_format: FORMAT_ASK
    });

    const content = r?.choices?.[0]?.message?.content || "{}";
    let data={}; try{ data=JSON.parse(content);}catch{ data={}; }

    let msg = limitWords(stripQuestionsFromMessage(removeBibleLike(String(data?.message||""))), 75);
    let ref = cleanRef(String(data?.bible?.ref||""));
    let text = String(data?.bible?.text||"").trim();
    let question = String(data?.question||"").trim();
    let techniques = Array.isArray(data?.techniques)? data.techniques.map(String) : [];
    let q_style = String(data?.q_style||"").trim();

    // 2) Ajuste temporal de la pregunta según recencia
    if (!isBye){
      if (question && !/\?\s*$/.test(question)) question += "?";
      question = fixTemporalQuestion(question, recency, lang);
    }

    // 3) Guardas de calidad para pregunta
    if (isBye){ question=""; }
    else{
      const isGeneric = BAD_GENERIC_Q.test(question||"");
      const looksAB = /\b(o|ou|or|oder|o bien|ou bien)\b/i.test(question||"");
      if (!question || isGeneric || looksAB){
        const SYS2 = SYSTEM_PROMPT + `\nAjusta la "question": una sola, natural, específica al tema, sin A/B, no genérica ni temporalmente incongruente con RECENCY=${recency}.`;
        const r2 = await completionJson({
          messages: [{role:"system",content:SYS2},{role:"user",content:header}],
          temperature:0.65,
          max_tokens:340,
          response_format: FORMAT_ASK
        });
        const c2 = r2?.choices?.[0]?.message?.content || "{}";
        let d2={}; try{ d2=JSON.parse(c2);}catch{ d2={}; }
        msg = limitWords(stripQuestionsFromMessage(removeBibleLike(String(d2?.message||msg||""))), 75);
        ref = cleanRef(String(d2?.bible?.ref||ref||""));
        text = String(d2?.bible?.text||text||"").trim();
        question = String(d2?.question||question||"").trim();
        techniques = Array.isArray(d2?.techniques)? d2.techniques.map(String) : techniques;
        q_style = String(d2?.q_style||q_style||"").trim();
        if (question && !/\?\s*$/.test(question)) question += "?";
        question = fixTemporalQuestion(question, recency, lang);
      }
    }

    // 4) Anti “escritura” y anti “respiración” consecutivas
    const lastTech = (mem.last_techniques || []).slice(-1)[0] || "";
    const usedWriting = (t)=> t==="writing_optional" || /escrit|diario/i.test(t);
    const usedBreath  = (t)=> t==="breathing_exhale46" || /breath|respir/i.test(t);
    const thisHasWriting = (techniques||[]).some(usedWriting) || /escrit|diario/i.test(msg);
    const thisHasBreath  = (techniques||[]).some(usedBreath)  || /respiraci[oó]n|inhala|exhala|breath/i.test(msg);

    if (!isBye && lastTech){
      if (usedWriting(lastTech) && thisHasWriting){
        // Re-pide sin escritura
        const SYS3 = SYSTEM_PROMPT + `\nEvita "escritura/diario" porque se usó recién; ofrece otra vía concreta (oars_escucha, guion_dialogo_pareja, time_out_24h, no_escalar, cognitive_reframe, behavioral_activation, apoyo_red_social, walk_10min, hydrate).`;
        const r3 = await completionJson({
          messages: [{role:"system",content:SYS3},{role:"user",content:header}],
          temperature:0.65,
          max_tokens:340,
          response_format: FORMAT_ASK
        });
        const c3 = r3?.choices?.[0]?.message?.content || "{}";
        let d3={}; try{ d3=JSON.parse(c3);}catch{ d3={}; }
        msg = limitWords(stripQuestionsFromMessage(removeBibleLike(String(d3?.message||msg||""))), 75);
        ref = cleanRef(String(d3?.bible?.ref||ref||""));
        text = String(d3?.bible?.text||text||"").trim();
        question = String(d3?.question||question||"").trim();
        techniques = Array.isArray(d3?.techniques)? d3.techniques.map(String) : techniques;
        q_style = String(d3?.q_style||q_style||"").trim();
        if (question && !/\?\s*$/.test(question)) question += "?";
        question = fixTemporalQuestion(question, recency, lang);
      } else if (usedBreath(lastTech) && thisHasBreath){
        // Re-pide sin respiración repetida
        const SYS4 = SYSTEM_PROMPT + `\nEvita respiración porque se usó recién; prioriza otras técnicas (no_escalar, time_out_24h, oars_escucha, guion_dialogo_pareja, cognitive_reframe, opposite_action, behavioral_activation, apoyo_red_social, walk_10min, hydrate).`;
        const r4 = await completionJson({
          messages: [{role:"system",content:SYS4},{role:"user",content:header}],
          temperature:0.65,
          max_tokens:340,
          response_format: FORMAT_ASK
        });
        const c4 = r4?.choices?.[0]?.message?.content || "{}";
        let d4={}; try{ d4=JSON.parse(c4);}catch{ d4={}; }
        msg = limitWords(stripQuestionsFromMessage(removeBibleLike(String(d4?.message||msg||""))), 75);
        ref = cleanRef(String(d4?.bible?.ref||ref||""));
        text = String(d4?.bible?.text||text||"").trim();
        question = String(d4?.question||question||"").trim();
        techniques = Array.isArray(d4?.techniques)? d4.techniques.map(String) : techniques;
        q_style = String(d4?.q_style||q_style||"").trim();
        if (question && !/\?\s*$/.test(question)) question += "?";
        question = fixTemporalQuestion(question, recency, lang);
      }
    }

    // 5) Evitar cita repetida o vetada
    const avoidSet = new Set((mem.last_bible_refs||[]).map(x=>NORM(cleanRef(x))));
    if (!ref || avoidSet.has(NORM(ref)) || isRefMat11_28(ref)){
      const alt = await regenerateBibleAvoiding({ lang, persona, message:userTxt, frame, bannedRefs: [...(mem.last_bible_refs||[]), ...BANNED_REFS], lastRef: mem.last_bible_refs?.slice(-1)[0]||"" });
      if (alt){ ref = alt.ref; text = alt.text; }
    }
    if (isRefMat11_28(ref)) { // si aún insiste, reemplazo seguro
      ref = (lang==="en"?"Psalm 34:18":"Salmos 34:18");
      text = (lang==="en"?"The Lord is close to the brokenhearted and saves those who are crushed in spirit.":"Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu.");
    }

    // 6) Persistencia
    const cleanedRef = cleanRef(ref);
    if (cleanedRef){
      mem.last_bible_refs = Array.isArray(mem.last_bible_refs)? mem.last_bible_refs : [];
      mem.last_bible_refs.push(cleanedRef);
      while(mem.last_bible_refs.length>8) mem.last_bible_refs.shift();
    }
    if (!isBye && question){
      mem.last_questions = Array.isArray(mem.last_questions)? mem.last_questions : [];
      mem.last_questions.push(question);
      while(mem.last_questions.length>10) mem.last_questions.shift();
    }
    if (Array.isArray(techniques) && techniques.length){
      mem.last_techniques = Array.isArray(mem.last_techniques)? mem.last_techniques : [];
      mem.last_techniques = [...mem.last_techniques, ...techniques].slice(-12);
    }
    if (q_style){
      mem.last_q_styles = Array.isArray(mem.last_q_styles)? mem.last_q_styles : [];
      mem.last_q_styles.push(q_style);
      while(mem.last_q_styles.length>10) mem.last_q_styles.shift();
    }
    await writeUserMemory(userId, mem);

    const out = {
      message: msg || (lang==="en"?"I am with you. Let’s take one small and practical step.":"Estoy contigo. Demos un paso pequeño y práctico."),
      bible: { text: text || (lang==="en"?"The Lord is close to the brokenhearted.":"Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu."), ref: cleanedRef || (lang==="en"?"Psalm 34:18":"Salmos 34:18") }
    };
    if (!isBye && question) out.question = question;

    res.status(200).json(out);
  }catch(err){
    console.error("ASK ERROR:", err);
    res.status(200).json({
      message:"La paz sea contigo. Compárteme en pocas palabras lo esencial, y seguimos paso a paso.",
      bible:{ text:"Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu.", ref:"Salmos 34:18" }
    });
  }
});

// ---------- HeyGen ----------
app.get("/api/heygen/token", async (_req,res)=>{
  try{
    const API_KEY = process.env.HEYGEN_API_KEY || process.env.HEYGEN_TOKEN || "";
    if(!API_KEY) return res.status(500).json({error:"missing_HEYGEN_API_KEY"});
    const r = await fetch("https://api.heygen.com/v1/streaming.create_token",{
      method:"POST",
      headers:{"x-api-key":API_KEY,"Content-Type":"application/json"},
      body:"{}"
    });
    const json = await r.json().catch(()=>({}));
    const token = json?.data?.token || json?.token || json?.access_token || "";
    if(!r.ok || !token){
      console.error("heygen_token_failed:",{status:r.status,json});
      return res.status(r.status||500).json({error:"heygen_token_failed", detail:json});
    }
    res.json({token});
  }catch(e){
    console.error("heygen token exception:", e);
    res.status(500).json({error:"heygen_token_error"});
  }
});

app.get("/api/heygen/config", (_req,res)=>{
  const AV_LANGS=["es","en","pt","it","de","ca","fr"];
  const avatars={};
  for(const l of AV_LANGS){
    const key=`HEYGEN_AVATAR_${l.toUpperCase()}`;
    const val=(process.env[key]||"").trim();
    if(val) avatars[l]=val;
  }
  const voiceId=(process.env.HEYGEN_VOICE_ID||"").trim();
  const defaultAvatar=(process.env.HEYGEN_DEFAULT_AVATAR||"").trim();
  const version=process.env.HEYGEN_CFG_VERSION || Date.now();
  res.json({voiceId, defaultAvatar, avatars, version});
});

// ---------- Arranque ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log(`Servidor listo en puerto ${PORT}`));
