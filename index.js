// index.js — Conversación servicial y profunda (multi-idioma, antirep, 100% OpenAI)
// - /api/welcome: saludo por hora **del dispositivo** + nombre + frase alentadora + 1 pregunta ABIERTA terapéutica
//     (sin A/B, sin técnicas, sin hobbies/planes/positivismo forzado; centrada en “lo que trae hoy”)
// - /api/ask: tres modos conversacionales
//     * explore: validar concreta + 1 línea espiritual (sin cita en "message") + 1 pregunta focal (hecho/desde-cuándo/impacto), sin técnicas
//     * permiso: 1–2 acciones generales + 1 línea espiritual + 1 pregunta de permiso específica al tema (“¿Querés que te diga qué decir y cómo?”) *variada*
//     * ejecutar: guía paso a paso (guion/técnica) + 1 pregunta de ajuste/check-in
// - Anti-repetición: preguntas, estilos de pregunta (q_style), citas bíblicas y técnicas (evitar “escritura” consecutiva)
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
  // 1) Hora explícita (0–23)
  if (Number.isInteger(hour) && hour>=0 && hour<24) return hour;
  // 2) ISO del cliente
  if (client_iso){
    const d = new Date(client_iso);
    if (!isNaN(d.getTime())) return d.getHours();
  }
  // 3) Zona horaria IANA
  if (tz){
    try{
      const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false });
      const parts = fmt.formatToParts(new Date());
      const h = parseInt(parts.find(p=>p.type==="hour")?.value || "0",10);
      if (!isNaN(h)) return h;
    }catch{}
  }
  // 4) Fallback: hora del servidor
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
// ¿Mensaje vago?
function detectVague(s=""){
  const x=NORM(s);
  if (!x) return true;
  if (x.length < 12) return true;
  if (/\btengo un problema\b|\bproblema\b|\bnecesito ayuda\b|\bno sé por dónde empezar\b|\bno se por donde empezar\b|\bhola\b|\bestoy mal\b/i.test(x)) return true;
  return false;
}
// ¿Usuario pide guía/ejecución o acepta?
function detectRequestExecute(s=""){
  const x=NORM(s);
  return /\bdime qu[eé] hacer\b|\bdecime qu[eé] hacer\b|\bquiero pasos\b|\bquiero que me digas\b|\bayudame a\b|\bayúdame a\b|\bquiero que me gu[ií]es\b|\bprobar[eé] la respiraci[oó]n\b|\bquiero hablar con\b|\bc[oó]mo hablar con\b|\barmar un guion\b|\bgu[ií]ame\b/i.test(x);
}

// ---- Filtros adicionales para la PREGUNTA de bienvenida (multi-idioma) ----
function isBadWelcomeQuestion(q=""){
  const x=NORM(q);
  if (!x) return true;
  // Menú A/B
  if (/\b(o|ou|or|oder|o bien|ou bien)\b/.test(x)) return true;
  // Hobbies / planes / tiempo libre (ES, EN, PT, IT, DE, CA, FR)
  const hobbyOrPlans = [
    "hobby","hobbies","pasatiempo","pasatiempos","aficion","aficiones","aficions",
    "planes","planos","pläne","plans","weekend","fin de semana","wochenende",
    "tiempo libre","temps libre","tempo livre","freizeit",
    "qué te gusta hacer","que te gusta hacer","what do you like to do",
    "cosa ti piace fare","was machst du gern","què t'agrada fer","ce que tu aimes faire",
    "disfrutas","enjoy","curtir","loisirs","passe-temps","passatempi"
  ].some(p=>x.includes(p));
  if (hobbyOrPlans) return true;
  // Positivismo forzado / plenitud
  const forcedPos = [
    "pleno","plenitud","plena","alegria","alegrías","alegrias","felicidad",
    "joy","joys","joyful","happy today","gioia","felice","freude","glücklich",
    "joie","heureux","feliç","alegria avui"
  ].some(p=>x.includes(p));
  if (forcedPos) return true;
  // Small talk trivial
  if (/\b(c[oó]mo est[aá]s|how are you|como vai|come stai|wie geht|comment [çc]a va)\b/.test(x)) return true;
  return false;
}

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
        bible:{type:"object",properties:{text:{type:"string"},ref:{type:"string"}},required:["text","ref"]},
        question:{type:"string"},
        techniques:{type:"array", items:{type:"string"}},
        q_style:{type:"string"} // etiqueta del estilo de pregunta generado
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

// ---------- /api/welcome (apertura real, hora local del cliente, pregunta centrada en “lo que trae hoy”) ----------
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
- "question": **UNA** pregunta **abierta terapéutica** para que el usuario cuente **lo que trae hoy** (tema actual, qué pasó, desde cuándo o cómo le afecta). Debe **terminar en "?"**. 
  - Prohibido: opciones A/B, técnicas, hobbies/planes/tiempo libre, y fórmulas de plenitud/alegrías.
  - Evita repetir recientes: ${avoidQs.map(q=>`"${q}"`).join(", ")||"(ninguna)"}.
No menciones IA/modelos.
`;
    const header =
      `Lang: ${lang}\n`+
      `Nombre: ${nm||"(anónimo)"}\n`+
      `Saludo_sugerido: ${hi}${nm?`, ${nm}`:""}\n`+
      (shortHistory.length?`Historial: ${shortHistory.join(" | ")}`:"Historial: (sin antecedentes)")+"\n";

    let r = await completionJson({
      messages: [{ role:"system", content: SYSTEM_PROMPT }, { role:"user", content: header }],
      temperature: 0.8,
      max_tokens: 260,
      response_format: FORMAT_WELCOME
    });

    const parseWelcome = (raw) => {
      const content = raw?.choices?.[0]?.message?.content || "{}";
      let data={}; try{ data=JSON.parse(content);}catch{ data={}; }
      let msg = limitWords(stripQuestionsFromMessage(removeBibleLike(String(data?.message||""))), 75);
      let question = String(data?.question||"").trim();
      if (question && !/\?\s*$/.test(question)) question += "?";
      return {msg, question};
    };

    let { msg, question } = parseWelcome(r);

    // Filtros: evitar A/B, hobbies, planes, positivismo forzado, small talk trivial
    if (!question || isBadWelcomeQuestion(question)){
      const SYS2 = SYSTEM_PROMPT + `\nReformula la "question" como **pregunta abierta terapéutica** centrada en lo que trae HOY (hecho/desde-cuándo/impacto), sin A/B, sin hobbies/planes, sin “pleno/alegrías”, sin small talk.`;
      const r2 = await completionJson({
        messages: [{ role:"system", content: SYS2 }, { role:"user", content: header }],
        temperature: 0.85,
        max_tokens: 220,
        response_format: FORMAT_WELCOME
      });
      ({ msg, question } = parseWelcome(r2));
      if (!question || isBadWelcomeQuestion(question)){
        // Fallback seguro
        question = (lang==="en"
          ? "What happened recently that you’d like to talk about?"
          : lang==="pt" ? "O que aconteceu recentemente que você gostaria de conversar?"
          : lang==="it" ? "Che cosa è successo recentemente di cui vorresti parlare?"
          : lang==="de" ? "Was ist kürzlich passiert, worüber du sprechen möchtest?"
          : lang==="ca" ? "Què ha passat recentment que vulguis compartir?"
          : lang==="fr" ? "Qu’est-il arrivé récemment dont tu aimerais parler ?"
          : "¿Qué ocurrió recientemente que te gustaría conversar?") + "";
      }
    }

    // Persistir pregunta
    if (question){
      mem.last_questions = Array.isArray(mem.last_questions)? mem.last_questions : [];
      mem.last_questions.push(question);
      while(mem.last_questions.length>10) mem.last_questions.shift();
      await writeUserMemory(userId, mem);
    }

    res.status(200).json({
      message: msg || `${hi}${nm?`, ${nm}`:""}. Estoy aquí para escucharte con calma.`,
      bible: { text:"", ref:"" },
      question: question
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

// ---------- /api/ask (explorar → permiso → ejecutar) ----------
async function regenerateBibleAvoiding({ lang, persona, message, frame, bannedRefs = [], lastRef = "" }) {
  const SYS = `
Devuelve SOLO JSON {"bible":{"text":"…","ref":"Libro 0:0"}} en ${langLabel(lang)}.
- Ajusta la cita al tema/contexto.
- Evita referencias recientes: ${bannedRefs.map(r=>`"${r}"`).join(", ")||"(ninguna)"} y la última: "${lastRef||"(n/a)"}".
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

    // FRAME básico
    const topic = guessTopic(userTxt);
    const mainSubject = detectMainSubject(userTxt);
    const frame = {
      topic_primary: topic,
      main_subject: mem.frame?.topic_primary===topic ? (mem.frame?.main_subject||mainSubject) : mainSubject,
      support_persons: mem.frame?.topic_primary===topic ? (mem.frame?.support_persons||[]) : [],
    };
    mem.frame = frame;
    mem.last_topic = topic;

    // Memorias recientes
    const avoidRefs = Array.isArray(mem.last_bible_refs)? mem.last_bible_refs.slice(-8):[];
    const avoidQs   = Array.isArray(mem.last_questions)? mem.last_questions.slice(-10):[];
    const avoidTech = Array.isArray(mem.last_techniques)? mem.last_techniques.slice(-6):[];
    const avoidQStyles = Array.isArray(mem.last_q_styles)? mem.last_q_styles.slice(-6):[];
    const shortHistory = compactHistory(history,10,240);

    // Selección de modo
    let MODE = "explore";
    if (isBye) MODE = "bye";
    else if (detectRequestExecute(userTxt) || saidYes) MODE = "execute";
    else if (!detectVague(userTxt) && topic!=="general") MODE = "permiso";
    if (saidNo && MODE!=="bye") MODE = "explore";

    const BAD_GENERIC_Q = /(qué te aliviaría|que te aliviar[ií]a|qué pequeño paso|qué vas a|qué harás|qué plan)/i;

    // Pista de tema para preguntas de permiso (multi-idioma)
    const TOPIC_HINT = {
      relationship: { es:"tu pareja", en:"your partner", pt:"sua parceria", it:"il tuo partner", de:"deinem Partner", ca:"la teva parella", fr:"ton/ta partenaire" },
      family_conflict: { es:"tu familia", en:"your family", pt:"sua família", it:"la tua famiglia", de:"deiner Familie", ca:"la teva família", fr:"ta famille" },
      mood: { es:"tus emociones", en:"your emotions", pt:"suas emoções", it:"le tue emozioni", de:"deine Gefühle", ca:"les teves emocions", fr:"tes émotions" },
      grief: { es:"tu duelo", en:"your grief", pt:"seu luto", it:"il tuo lutto", de:"deine Trauer", ca:"el teu dol", fr:"ton deuil" },
      separation: { es:"esta separación", en:"this separation", pt:"esta separação", it:"questa separazione", de:"diese Trennung", ca:"aquesta separació", fr:"cette séparation" },
      health: { es:"tu salud", en:"your health", pt:"sua saúde", it:"la tua salute", de:"deine Gesundheit", ca:"la teva salut", fr:"ta santé" },
      work_finance: { es:"tu trabajo o finanzas", en:"your work or finances", pt:"seu trabalho ou finanças", it:"il tuo lavoro o finanze", de:"deine Arbeit oder Finanzen", ca:"la teva feina o finances", fr:"ton travail ou tes finances" },
      addiction: { es:"tu proceso de recuperación", en:"your recovery process", pt:"seu processo de recuperação", it:"il tuo percorso di recupero", de:"deinen Genesungsweg", ca:"el teu procés de recuperació", fr:"ton chemin de rétablissement" },
      faith: { es:"tu fe", en:"your faith", pt:"sua fé", it:"la tua fede", de:"deinen Glauben", ca:"la teva fe", fr:"ta foi" }
    }[topic]?.[lang] || null;

    const SYSTEM_PROMPT = `
Hablas con serenidad, claridad y compasión. Evita metáforas largas; sé concreto.

MODO ACTUAL: ${MODE}

SALIDA SOLO JSON (en ${langLabel(lang)}):
- "message": ≤75 palabras, **sin signos de pregunta**.
  * Si MODO=explore: 1–2 frases de validación **concreta** (no poética), + 1 línea espiritual **sin** cita dentro del "message". **No** propongas técnicas todavía.
  * Si MODO=permiso: ofrece **1–2 acciones generales** suaves y realistas (sin detallar técnicas), + 1 línea espiritual, y encuadra que podés guiar cuando el usuario quiera.
  * Si MODO=execute: guía **paso a paso** (guion/técnica) clara y breve (1–3 min si es práctica), con lenguaje sencillo.
- "bible": texto + ref, ajustada al contexto/tema. Evita repetir: ${avoidRefs.map(r=>`"${r}"`).join(", ")||"(ninguna)"}.
- "question": **UNA sola**.
  * explore → **pregunta focal** para entender: qué ocurrió, desde cuándo, y/o dónde impacta (pareja/familia/trabajo/salud/fe); evita “qué te aliviaría”.
  * permiso → **pregunta de permiso** natural (ej.: “¿Querés que te diga qué decir y cómo?”), **específica al tema**${TOPIC_HINT?` (menciona: "${TOPIC_HINT}")`:""}; sin A/B.
  * execute → **pregunta de ajuste/check-in** (adaptar guion, medir intensidad, siguiente micro-paso).
  * bye → **omite** pregunta.
  Debe terminar en "?" y **no** usar opciones A/B; evita preguntas genéricas: ${BAD_GENERIC_Q}.
- "techniques": lista de etiquetas si sugieres técnicas (ej.: ["breathing_box","grounding_54321","cold_water","walk_5min","support_checkin","time_out_24h","sleep_hygiene","hydrate","cognitive_reframe","prayer_short","writing_optional"]).
- "q_style": etiqueta del estilo de pregunta (ej.: "explore_area","explore_event","explore_impact","permiso_guion","permiso_practica","execute_checkin","execute_adjust").

PRIORIDADES:
- La **autoayuda** es el eje: acciones concretas y útiles al tema. Evita “escritura/diario” si aparece en recientes: ${avoidTech.join(", ")||"(ninguna)"}; jamás dos turnos seguidos.
- Si MODO=explore: 0 técnicas. Si MODO=permiso: aún sin detalles de técnicas; ofrece empezar cuando el usuario lo pida. Si MODO=execute: guía práctica concreta.
- Varía el estilo de la **pregunta** y evita repetir estilos recientes: ${avoidQStyles.join(", ")||"(ninguno)"}.
No menciones IA/modelos.
`;

    const header =
      `Persona: ${persona}\n`+
      `Lang: ${lang}\n`+
      `Mensaje_usuario: ${userTxt}\n`+
      (shortHistory.length?`Historial: ${shortHistory.join(" | ")}`:"Historial: (sin antecedentes)")+"\n"+
      `Evitar_refs: ${avoidRefs.join(" | ")||"(ninguna)"}\n`+
      `Evitar_preguntas: ${avoidQs.join(" | ")||"(ninguna)"}\n`+
      `Evitar_tecnicas: ${avoidTech.join(" | ")||"(ninguna)"}\n`+
      `Evitar_q_styles: ${avoidQStyles.join(" | ")||"(ninguno)"}\n`+
      `FRAME: ${JSON.stringify(frame)}\n`;

    // 1) Generación
    let r = await completionJson({
      messages: [{role:"system",content:SYSTEM_PROMPT},{role:"user",content:header}],
      temperature:0.6,
      max_tokens:320,
      response_format: FORMAT_ASK
    });

    const parseOut = (raw) => {
      const content = raw?.choices?.[0]?.message?.content || "{}";
      let data={}; try{ data=JSON.parse(content);}catch{ data={}; }
      let msg = limitWords(stripQuestionsFromMessage(removeBibleLike(String(data?.message||""))), 75);
      let ref = cleanRef(String(data?.bible?.ref||""));
      let text = String(data?.bible?.text||"").trim();
      let question = String(data?.question||"").trim();
      let techniques = Array.isArray(data?.techniques)? data.techniques.map(String) : [];
      let q_style = String(data?.q_style||"").trim();
      return { msg, ref, text, question, techniques, q_style };
    };

    let { msg, ref, text, question, techniques, q_style } = parseOut(r);

    // 2) Guardas de calidad
    if (isBye){ question=""; }
    else{
      if (question && !/\?\s*$/.test(question)) question += "?";
      // evitar preguntas genéricas o A/B
      const isGeneric = BAD_GENERIC_Q.test(question||"");
      const looksAB = /\b(o|ou|or|oder|o bien|ou bien)\b/i.test(question||"");
      if (!question || isGeneric || looksAB){
        const SYS2 = SYSTEM_PROMPT + `\nAjusta la "question": una sola, natural, específica al tema, sin A/B, no genérica.`;
        const r2 = await completionJson({
          messages: [{role:"system",content:SYS2},{role:"user",content:header}],
          temperature:0.65,
          max_tokens:320,
          response_format: FORMAT_ASK
        });
        ({ msg, ref, text, question, techniques, q_style } = parseOut(r2));
        if (question && !/\?\s*$/.test(question)) question += "?";
      }
    }

    // Evitar técnica "escritura" consecutiva
    const lastWasWriting = (mem.last_techniques || []).slice(-1)[0] === "writing_optional";
    const thisMentionsWriting = (techniques||[]).includes("writing_optional") || /escrib/i.test(msg);
    if (!isBye && lastWasWriting && thisMentionsWriting){
      const SYS3 = SYSTEM_PROMPT + `\nEvita "escritura/diario" porque se usó recién; ofrece otra vía concreta coherente con el tema.`;
      const r3 = await completionJson({
        messages: [{role:"system",content:SYS3},{role:"user",content:header}],
        temperature:0.65,
        max_tokens:320,
        response_format: FORMAT_ASK
      });
      ({ msg, ref, text, question, techniques, q_style } = parseOut(r3));
      if (question && !/\?\s*$/.test(question)) question += "?";
    }

    // 3) Evitar cita repetida/regenerar sólo Biblia si hace falta
    const avoidSet = new Set((mem.last_bible_refs||[]).map(x=>NORM(cleanRef(x))));
    if (!ref || avoidSet.has(NORM(ref))){
      const alt = await regenerateBibleAvoiding({ lang, persona, message:userTxt, frame, bannedRefs: mem.last_bible_refs||[], lastRef: mem.last_bible_refs?.slice(-1)[0]||"" });
      if (alt){ ref = alt.ref; text = alt.text; }
    }

    // 4) Persistencia
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
