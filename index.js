// index.js — Backend conversacional (OpenAI) con filtros temáticos y guiones concretos
// Env: OPENAI_API_KEY, PORT, DATA_DIR (opcional), HEYGEN_* (opcional)

const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const OpenAI = require("openai");
const path = require("path");
const fs = require("fs/promises");
require("dotenv").config();

const app = express();
app.use(cors({ origin: "*", methods: ["GET","POST","OPTIONS"], allowedHeaders: ["Content-Type","x-api-key"] }));
app.use(bodyParser.json({ limit: "1mb" }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------- Utils ----------
const NORM = (s="") => String(s).toLowerCase().replace(/\s+/g," ").trim();
const langLabel = (l="es") => ({es:"Español",en:"English",pt:"Português",it:"Italiano",de:"Deutsch",ca:"Català",fr:"Français"})[l]||"Español";
const limitWords = (s="", max=75)=>{ const w=String(s).trim().split(/\s+/); return w.length<=max?String(s).trim():w.slice(0,max).join(" ").trim(); };
const cleanRef = (ref="")=> String(ref).replace(/\s*\([^)]*\)\s*/g," ").replace(/\s+/g," ").trim();
const stripQuestionsFromMessage = (s="") => String(s).split(/\n+/).map(l=>l.trim()).filter(l=>!/\?\s*$/.test(l)).join("\n").trim();
const removeBibleLike = (text="")=>{
  let s=String(text||"");
  s=s.replace(/^[\s]*[—-]\s*.*?\([^)]+?\d+\s*:\s*\d+\)[\s]*$/gim,"").trim();
  s=s.replace(/\(([^)]+?\d+\s*:\s*\d+)\)/g,()=> "");
  s=s.replace(/\s*[—-]\s*[^()]*\(\s*[^)]+?\d+\s*:\s*\d+\s*\)\s*$/g,"").trim();
  return s.replace(/[ \t]+\n/g,"\n").replace(/\n{3,}/g,"\n\n").trim();
};

// Historial/memoria en FS
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname,"data");
async function ensureDataDir(){ try{ await fs.mkdir(DATA_DIR,{recursive:true}); }catch{} }
function memPath(uid){ const safe=String(uid||"anon").replace(/[^a-z0-9_-]/gi,"_"); return path.join(DATA_DIR,`mem_${safe}.json`); }
async function readUserMemory(userId){
  await ensureDataDir();
  try{
    const raw=await fs.readFile(memPath(userId),"utf8");
    const m=JSON.parse(raw);
    m.last_bible_refs = Array.isArray(m.last_bible_refs)?m.last_bible_refs:[];
    m.last_questions  = Array.isArray(m.last_questions)? m.last_questions:[];
    m.last_techniques = Array.isArray(m.last_techniques)?m.last_techniques:[];
    m.last_q_styles   = Array.isArray(m.last_q_styles)? m.last_q_styles:[];
    return m;
  }catch{
    return { last_bible_refs:[], last_questions:[], last_techniques:[], last_q_styles:[], frame:null, last_topic:null };
  }
}
async function writeUserMemory(userId,mem){ await ensureDataDir(); await fs.writeFile(memPath(userId), JSON.stringify(mem,null,2), "utf8"); }

// Compactar historial que se manda a OpenAI
function compactHistory(history=[], keep=10, maxLen=240){
  const arr=Array.isArray(history)?history:[];
  return arr.slice(-keep).map(x=>String(x).slice(0,maxLen));
}

// Hora local
function resolveClientHour({hour=null, client_iso=null, tz=null}={}){
  if (Number.isInteger(hour) && hour>=0 && hour<24) return hour;
  if (client_iso){ const d=new Date(client_iso); if (!isNaN(d.getTime())) return d.getHours(); }
  if (tz){
    try{
      const fmt=new Intl.DateTimeFormat("en-US",{timeZone:tz,hour:"numeric",hour12:false});
      const parts=fmt.formatToParts(new Date());
      const h=parseInt(parts.find(p=>p.type==="hour")?.value||"0",10);
      if (!isNaN(h)) return h;
    }catch{}
  }
  return new Date().getHours();
}
function greetingByHour(lang="es", opts={}){
  const h=resolveClientHour(opts);
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

// ---------- Detecciones (tema/ruido/OOS) ----------
function detectByeThanks(s=""){ const x=NORM(s);
  return [
    /\bgracias\b|\bmuchas gracias\b|\bme tengo que ir\b|\bhasta luego\b|\bad[ií]os\b/,
    /\bthanks\b|\bbye\b|\bsee you\b/, /\bobrigado\b|\bobrigada\b|\btchau\b/,
    /\bgrazie\b|\bciao\b/, /\bdanke\b|\btschüss\b/, /\bmerci\b|\bau revoir\b/
  ].some(r=>r.test(x));
}
function detectAffirmation(s=""){ const x=NORM(s);
  return [/\bs[ií]\b|\bclaro\b|\bok\b/, /\byes\b|\bsure\b|\bok\b/, /\bsim\b/, /\bs[iì]\b|\bcerto\b/, /\bja\b/, /\boui\b/].some(r=>r.test(x));
}
function detectNegation(s=""){ const x=NORM(s);
  return [/\bno\b|\bmejor no\b|\bno gracias\b/, /\bnope\b|nah\b/, /\bn[aã]o\b/, /\bnon\b/, /\bnein\b/].some(r=>r.test(x));
}
function detectRequestExecute(s=""){ const x=NORM(s);
  return /\bdecime qu[eé] decir\b|\bdime qu[eé] decir\b|\bquiero pasos\b|\barmar un gui[oó]n\b|\bgu[ií]ame\b|\bqué decir y c[oó]mo\b/.test(x);
}

// Ruido / nonsense / duplicados cortos
function isGibberishOrTooShort(s=""){
  const t=String(s||"").trim();
  if (!t) return true;
  if (t.length<=2) return true;
  if (/^[a-z]{2,4}$/i.test(t) && !/(si|no|ok|hey|hola|bye|ciao|vale|okey)/i.test(t)) return true;
  return false;
}

// OOS: geografía no religiosa, turismo no religioso, mecánica/auto, técnica/IT, juegos/juguetería, entretenimiento/música/literatura no religiosa, mates/ciencia (datos)
function isReligiousPlaceQuery(s=""){
  const x=NORM(s);
  return /\b(iglesia|catedral|bas[ií]lica|santuario|oratorio|templo|parroquia|monasterio|convento|misa|adoraci[oó]n|confesi[oó]n|rosario)\b/.test(x)
      || /\b(church|cathedral|basilica|sanctuary|oratory|temple|parish|monastery|convent|mass|adoration|confession)\b/.test(x);
}
function detectOOS(s=""){
  const x=NORM(s);
  const geoNonRel = /\b(d[oó]nde queda|where is|ubicaci[oó]n|mapa|map|capital de|pa[ií]s|frontera|latitud|longitud)\b/.test(x) && !isReligiousPlaceQuery(s);
  const tourismNonRel = /\b(turismo|tour|hotel|restaurante|playa|atracciones|viaje|alojamiento)\b/.test(x) && !isReligiousPlaceQuery(s);
  const mechanics = /\b(alternador|embrague|carburador|inyector|buj[ií]a|correa|filtro|sensores? obd|par motor|hp|cv|torque)\b/.test(x);
  const techIT = /\b(api|framework|bug|deploy|docker|javascript|python|c\+\+|base de datos|servidor|hosting|ip|dns|router|wifi|android studio|xcode)\b/.test(x);
  const toysGames = /\b(juguete|lego|playstation|xbox|nintendo|minecraft|fortnite|roblox|juego(s)? de mesa|metagame)\b/.test(x);
  const entertainment = /\b(pel[ií]cula|serie|celebridad|cantante|m[uú]sica|novela|reseña|ranking|billboard|taquilla)\b/.test(x);
  const mathSci = /\b(derivada|integral|l[ií]mite|f[ií]sica|qu[ií]mica|biolog[ií]a|ecuaci[oó]n|teorema|geometr[ií]a)\b/.test(x);
  return geoNonRel || tourismNonRel || mechanics || techIT || toysGames || entertainment || mathSci;
}

// Heurísticas de tema (para guion)
function guessTopic(s=""){
  const t=NORM(s);
  if (/(pareja|espos[ao]|novi[ao]|separaci[oó]n|divorcio|ruptura)/.test(t)) return "relationship";
  if (/(hij[oa]|familia|discusi[oó]n|conflicto|suegr)/.test(t)) return "family_conflict";
  if (/(ansied|p[áa]nico|depres|triste|bronca|enojo|ira|estr[eé]s|miedo|soledad)/.test(t)) return "mood";
  if (/(duelo|falleci[oó]|luto|perd[ií])/i.test(t)) return "grief";
  if (/(adicci[oó]n|droga|alcohol|apuestas)/.test(t)) return "addiction";
  if (/(fe|dios|oraci[oó]n|culpa|perd[oó]n)/.test(t)) return "faith";
  if (/(trabajo|despido|salario|deuda|finanzas)/.test(t)) return "work_finance";
  return "general";
}
function detectMainSubject(s=""){
  const t=NORM(s);
  if (/\bmi esposa|\bmi marido|\bmi pareja|\bmi novio|\bmi novia\b/.test(t)) return "partner";
  if (/\bmi hij[oa]\b/.test(t)) return "child";
  if (/\bmi madre|\bmam[aá]\b/.test(t)) return "mother";
  if (/\bmi padre|\bpap[aá]\b/.test(t)) return "father";
  if (/\bmi herman[oa]\b/.test(t)) return "sibling";
  if (/\bmi amig[oa]\b/.test(t)) return "friend";
  return "self";
}

// ---------- Anti-repetición de preguntas genéricas ----------
const BAD_GENERIC_Q = /(qué te aliviar[ií]a|que te aliviar[ií]a|qué pequeño paso|qué vas a|qué harás|qué plan|divide el problema|qué parte espec[ií]fica|qué parte de la situaci[oó]n)/i;

// ---------- OpenAI response formats ----------
const FORMAT_WELCOME = {
  type:"json_schema",
  json_schema:{ name:"WelcomeSchema", schema:{
    type:"object",
    properties:{ message:{type:"string"}, question:{type:"string"} },
    required:["message","question"], additionalProperties:false } }
};
const FORMAT_ASK = {
  type:"json_schema",
  json_schema:{ name:"SpiritualGuidance", schema:{
    type:"object",
    properties:{
      message:{type:"string"},
      bible:{type:"object",properties:{text:{type:"string"},ref:{type:"string"}},required:["text","ref"]},
      question:{type:"string"},
      techniques:{type:"array", items:{type:"string"}},
      q_style:{type:"string"}
    },
    required:["message","bible","question","q_style"], additionalProperties:false } }
};
const FORMAT_BIBLE_ONLY = {
  type:"json_schema",
  json_schema:{ name:"BibleOnly", schema:{
    type:"object",
    properties:{ bible:{type:"object",properties:{text:{type:"string"},ref:{type:"string"}},required:["text","ref"]} },
    required:["bible"], additionalProperties:false } }
};

async function completionJson({messages, temperature=0.6, max_tokens=260, timeoutMs=12000, response_format}){
  const call = openai.chat.completions.create({ model:"gpt-4o", temperature, max_tokens, messages, response_format: response_format || FORMAT_ASK });
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
    const nm=String(name||"").trim();
    const hi=greetingByHour(lang,{hour,client_iso,tz});
    const mem=await readUserMemory(userId);
    const avoidQs = Array.isArray(mem.last_questions)? mem.last_questions.slice(-10):[];
    const shortHistory = compactHistory(history,6,200);

    const SYSTEM_PROMPT = `
Eres cercano, sereno y práctico. Varía el lenguaje, evita muletillas y no uses versos bíblicos dentro de "message".
SALIDA SOLO JSON (en ${langLabel(lang)}):
- "message": ≤75 palabras. Incluye saludo por franja y **nombre si existe** ("${hi}${nm?`, ${nm}`:""}"). Da **1 frase tipo tarjeta** (alentadora/realista, no cursi) y expresa **disponibilidad**. **Sin preguntas** ni citas bíblicas en "message".
- "question": **UNA** pregunta **abierta y simple** para que el usuario cuente **lo que trae hoy**. Termina en "?". Evita repetir recientes: ${avoidQs.map(q=>`"${q}"`).join(", ")||"(ninguna)"}.
No menciones IA/modelos.`;

    const header =
      `Lang: ${lang}\n`+
      `Nombre: ${nm||"(anónimo)"}\n`+
      `Saludo_sugerido: ${hi}${nm?`, ${nm}`:""}\n`+
      (shortHistory.length?`Historial: ${shortHistory.join(" | ")}`:"Historial: (sin antecedentes)")+"\n";

    const r = await completionJson({ messages:[{role:"system",content:SYSTEM_PROMPT},{role:"user",content:header}], temperature:0.8, max_tokens:260, response_format: FORMAT_WELCOME });
    const content = r?.choices?.[0]?.message?.content || "{}";
    let data={}; try{ data=JSON.parse(content);}catch{ data={}; }
    let msg = limitWords(stripQuestionsFromMessage(removeBibleLike(String(data?.message||""))), 75);
    let question = String(data?.question||"").trim();
    if (!/\?\s*$/.test(question||"")) question = (question||"").replace(/\?+$/,"")+"?";

    if (!question || BAD_GENERIC_Q.test(question)){
      question = (lang==="en"
        ? "What happened today that you’d like to talk about?"
        : lang==="pt" ? "O que aconteceu hoje que você gostaria de conversar?"
        : lang==="it" ? "Che cosa è successo oggi di cui vorresti parlare?"
        : lang==="de" ? "Was ist heute passiert, worüber du sprechen möchtest?"
        : lang==="ca" ? "Què ha passat avui que vulguis compartir?"
        : lang==="fr" ? "Qu’est-il arrivé aujourd’hui dont tu aimerais parler ?"
        : "¿Qué pasó hoy de lo que te gustaría hablar?");
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
    const hi=greetingByHour("es");
    res.status(200).json({ message:`${hi}. Estoy aquí para escucharte con calma.`, bible:{text:"",ref:""}, question:"¿Qué pasó hoy de lo que te gustaría hablar?" });
  }
});

// ---------- /api/ask ----------
const BANNED_REFS = ["Mateo 11:28","Mt 11:28","Mat 11:28","Matthew 11:28","Matteo 11:28","Matthäus 11:28","Matthieu 11:28","Mateu 11:28","Mateus 11:28"];
function isRefMat11_28(ref=""){ const x=NORM(ref); return [
  /mateo\s*11\s*:\s*28/, /mt\.?\s*11\s*:\s*28/, /mat\.?\s*11\s*:\s*28/, /san\s+mateo\s*11\s*:\s*28/,
  /matthew?\s*11\s*:\s*28/, /matteo\s*11\s*:\s*28/, /matthäus\s*11\s*:\s*28/, /matthieu\s*11\s*:\s*28/,
  /mateu\s*11\s*:\s*28/, /mateus\s*11\s*:\s*28/
].some(r=>r.test(x)); }

async function regenerateBibleAvoiding({ lang, persona, message, frame, bannedRefs = [], lastRef = "" }) {
  const SYS = `
Devuelve SOLO JSON {"bible":{"text":"…","ref":"Libro 0:0"}} en ${langLabel(lang)}.
- Ajusta la cita al tema/contexto.
- Evita referencias recientes: ${bannedRefs.map(r=>`"${r}"`).join(", ")||"(ninguna)"} y la última: "${lastRef||"(n/a)"}".
- Evita Mateo/Matthew 11:28 (todas las variantes).
- No agregues nada fuera del JSON.`;
  const USR = `Persona: ${persona}\nMensaje_usuario: ${message}\nFRAME: ${JSON.stringify(frame)}`;
  const r = await completionJson({ messages:[{role:"system",content:SYS},{role:"user",content:USR}], temperature:0.4, max_tokens:120, response_format: FORMAT_BIBLE_ONLY });
  const content = r?.choices?.[0]?.message?.content || "{}";
  let data={}; try{ data=JSON.parse(content);}catch{ data={}; }
  const text=(data?.bible?.text||"").toString().trim(); const ref=cleanRef((data?.bible?.ref||"").toString());
  return text && ref ? { text, ref } : null;
}

app.post("/api/ask", async (req,res)=>{
  try{
    const { persona="jesus", message="", history=[], userId="anon", lang="es" } = req.body||{};
    const mem = await readUserMemory(userId);
    const userTxt = String(message||"").trim();

    // 0) Anti-ruido / duplicados
    const lastUserLine = Array.isArray(history)? history.slice(-1)[0] || "" : "";
    if (isGibberishOrTooShort(userTxt) || (NORM(lastUserLine).endsWith(NORM(userTxt)) && userTxt.length<6)){
      return res.status(200).json({ message: (lang==="en"?"I didn’t catch that — could you rephrase it in a few words?":"No te entendí bien, ¿podés repetirlo en pocas palabras?"), bible:{text:"",ref:""} });
    }

    // 1) OOS vs religioso
    if (detectOOS(userTxt) && !isReligiousPlaceQuery(userTxt)){
      const redirect = (lang==="en"
        ? "I’m here for your spiritual life and personal wellbeing. If you like, we can focus on what you’re living — emotions, relationships or faith."
        : lang==="pt" ? "Estou aqui para tua vida espiritual e bem-estar pessoal. Se quiser, focamos no que você está vivendo — emoções, relações ou fé."
        : lang==="it" ? "Sono qui per la tua vita spirituale e il tuo benessere personale. Se vuoi, ci concentriamo su ciò che stai vivendo — emozioni, relazioni o fede."
        : lang==="de" ? "Ich bin für dein geistliches Leben und dein Wohlbefinden da. Wenn du magst, richten wir den Blick auf das, was du gerade erlebst — Gefühle, Beziehungen oder Glauben."
        : lang==="ca" ? "Soc aquí per la teva vida espiritual i el teu benestar personal. Si vols, enfoquem el que estàs vivint — emocions, relacions o fe."
        : lang==="fr" ? "Je suis là pour ta vie spirituelle et ton bien-être. Si tu veux, on se concentre sur ce que tu vis — émotions, relations ou foi."
        : "Estoy aquí para tu vida espiritual y tu bienestar personal. Si querés, enfocamos lo que estás viviendo — emociones, relaciones o fe.");
      const q = (lang==="en"?"Where would you like to start today — emotions, a relationship, or your faith?":
        lang==="pt"?"Por onde você quer começar hoje — emoções, uma relação ou tua fé?":
        lang==="it"?"Da dove preferisci iniziare oggi — emozioni, una relazione o la tua fede?":
        lang==="de"?"Womit möchtest du heute beginnen — Gefühle, eine Beziehung oder deinen Glauben?":
        lang==="ca"?"Per on vols començar avui — emocions, una relació o la teva fe?":
        lang==="fr"?"Par quoi veux-tu commencer aujourd’hui — émotions, une relation ou ta foi ?":
        "¿Por dónde te gustaría empezar hoy — emociones, una relación o tu fe?");
      return res.status(200).json({ message: redirect, bible:{text:"",ref:""}, question: q });
    }

    // 2) FRAME/Tema
    const topic = guessTopic(userTxt);
    const mainSubject = detectMainSubject(userTxt);
    const frame = { topic_primary: topic, main_subject: mem.frame?.topic_primary===topic ? (mem.frame?.main_subject||mainSubject) : mainSubject };
    mem.frame = frame; mem.last_topic = topic;

    const avoidRefs = Array.isArray(mem.last_bible_refs)? mem.last_bible_refs.slice(-8):[];
    const avoidQs   = Array.isArray(mem.last_questions)? mem.last_questions.slice(-10):[];
    const avoidTech = Array.isArray(mem.last_techniques)? mem.last_techniques.slice(-6):[];
    const avoidQStyles = Array.isArray(mem.last_q_styles)? mem.last_q_styles.slice(-6):[];
    const shortHistory = compactHistory(history,10,240);

    // 3) Modo
    const isBye   = detectByeThanks(userTxt);
    const saidYes = detectAffirmation(userTxt);
    const saidNo  = detectNegation(userTxt);
    let MODE = "explore";
    if (isBye) MODE="bye";
    else if (detectRequestExecute(userTxt) || saidYes) MODE="execute";
    else if (topic!=="general") MODE="permiso";
    if (saidNo && MODE!=="bye") MODE="explore";

    // 4) Prompts
    const TOPIC_HINT = {
      relationship: { es:"tu pareja", en:"your partner", pt:"sua parceria", it:"il tuo partner", de:"deinem Partner", ca:"la teva parella", fr:"ton/ta partenaire" },
      family_conflict: { es:"tu familia", en:"your family", pt:"sua família", it:"la tua famiglia", de:"deiner Familie", ca:"la teva família", fr:"ta famille" },
      mood: { es:"tus emociones", en:"your emotions", pt:"suas emoções", it:"le tue emozioni", de:"deine Gefühle", ca:"les teves emocions", fr:"tes émotions" },
      grief: { es:"tu duelo", en:"your grief", pt:"seu luto", it:"il tuo lutto", de:"deine Trauer", ca:"el teu dol", fr:"ton deuil" },
      addiction: { es:"tu proceso de recuperación", en:"your recovery process", pt:"seu processo de recuperação", it:"il tuo percorso di recupero", de:"deinen Genesungsweg", ca:"el teu procés de recuperació", fr:"ton chemin de rétablissement" },
      work_finance: { es:"tu trabajo o finanzas", en:"your work or finances", pt:"seu trabalho ou finanças", it:"il tuo lavoro o finanze", de:"deine Arbeit oder Finanzen", ca:"la teva feina o finances", fr:"ton travail ou tes finances" },
      faith: { es:"tu fe", en:"your faith", pt:"sua fé", it:"la tua fede", de:"deinen Glauben", ca:"la teva fe", fr:"ta foi" }
    }[topic]?.[lang] || null;

    const SYSTEM_PROMPT = `
Hablas con serenidad, claridad y compasión. Evita metáforas largas; sé **concreto** y **clínico** en lenguaje simple.

MODO ACTUAL: ${MODE}

SALIDA SOLO JSON (en ${langLabel(lang)}):
- "message": ≤75 palabras, **sin signos de pregunta**.
  * explore: 1–2 validaciones **concretas**, **1 micro-acción** útil (no solo “respirar/escribir”), y 1 línea espiritual breve (sin cita en "message").
  * permiso: 1–2 rumbos claros (ej.: “armamos un **guion** para hablar con ${TOPIC_HINT||"la otra persona"}” / “regulamos bronca y definimos **límites asertivos**”), + 1 línea espiritual.
  * execute: **Guía paso a paso** (3–5 pasos, directo). Relaciones: guion con mensajes en “yo”, 2–3 frases modelo, **límite** y **cierre**. Emoción intensa: protocolo breve (sin repetir respiración si fue usada recién).
- "bible": texto + ref, adecuada al contexto. Evita repetir: ${avoidRefs.map(r=>`"${r}"`).join(", ")||"(ninguna)"} y **evita Mateo/Matthew 11:28**.
- "question": **UNA** sola, termina en "?". Prohibido: “divide el problema”, “qué parte específica”, “desde cuándo” si no aporta. Prefiere preguntas de **acción/rumbo** (guion ahora vs regulación).
- "techniques": etiquetas de técnicas si las usas (p.ej., ["time_out_24h","no_escalar","guion_dialogo_pareja","message_en_yo","oars_escucha","behavioral_activation","opposite_action","cognitive_reframe","apoyo_red_social","limites_asertivos","walk_10min","hydrate"]).
- "q_style": estilo de pregunta (p.ej., "permiso_guion","execute_checkin","explore_impact"…).

Prioriza **autoayuda concreta** y **evita** repetir técnicas recientes: ${avoidTech.join(", ")||"(ninguna)"}.
Evita preguntas genéricas repetidas: ${avoidQStyles.join(", ")||"(ninguno)"} y patrones: ${BAD_GENERIC_Q}.
No menciones IA/modelos.`;

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

    // 5) Llamada principal
    let r = await completionJson({ messages:[{role:"system",content:SYSTEM_PROMPT},{role:"user",content:header}], temperature:0.6, max_tokens:360, response_format: FORMAT_ASK });
    const content = r?.choices?.[0]?.message?.content || "{}";
    let data={}; try{ data=JSON.parse(content);}catch{ data={}; }

    let msg = limitWords(stripQuestionsFromMessage(removeBibleLike(String(data?.message||""))), 75);
    let ref = cleanRef(String(data?.bible?.ref||""));
    let text = String(data?.bible?.text||"").trim();
    let questionRaw = String(data?.question||"").trim();
    let techniques = Array.isArray(data?.techniques)? data.techniques.map(String) : [];
    let q_style = String(data?.q_style||"").trim();

    // Ajuste final de pregunta
    let question = isBye ? "" : String(questionRaw||"").trim();
    if (BAD_GENERIC_Q.test(question)) question = "";
    if (question && !/\?\s*$/.test(question)) question += "?";
    if (!question && !isBye){
      question = (lang==="en"?"Would you like us to make a short script for your first step, or regulate the emotion and set one boundary now?":
        lang==="pt"?"Preferes que façamos um roteiro curto para teu primeiro passo, ou regular a emoção e definir um limite agora?":
        lang==="it"?"Preferisci che facciamo un breve copione per il primo passo, o regolare l’emozione e fissare un confine adesso?":
        lang==="de"?"Möchtest du jetzt ein kurzes Skript für den ersten Schritt, oder die Emotion regulieren und eine Grenze setzen?":
        lang==="ca"?"Vols que fem un guió curt pel primer pas, o regular l’emoció i posar un límit ara?":
        lang==="fr"?"Veux-tu qu’on prépare un petit script pour ton premier pas, ou qu’on régule l’émotion et pose une limite maintenant ?":
        "¿Querés que armemos un guion breve para tu primer paso, o regular ahora la emoción y definir un límite?");
    }

    // 6) Evitar cita repetida o vetada
    const avoidSet = new Set((mem.last_bible_refs||[]).map(x=>NORM(cleanRef(x))));
    if (!ref || avoidSet.has(NORM(ref)) || isRefMat11_28(ref)){
      const alt = await regenerateBibleAvoiding({ lang, persona, message:userTxt, frame, bannedRefs: [...(mem.last_bible_refs||[]), ...BANNED_REFS], lastRef: mem.last_bible_refs?.slice(-1)[0]||"" });
      if (alt){ ref = alt.ref; text = alt.text; }
    }
    if (isRefMat11_28(ref)) {
      ref = (lang==="en"?"Psalm 34:18":"Salmos 34:18");
      text = (lang==="en"?"The Lord is close to the brokenhearted and saves those who are crushed in spirit.":"Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu.");
    }

    // 7) Persistencia
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
      message:"La paz sea contigo. Contame en pocas palabras lo esencial y armamos un primer paso.",
      bible:{ text:"Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu.", ref:"Salmos 34:18" }
    });
  }
});

// ---------- HeyGen (token/config con CORS abierto) ----------
app.get("/api/heygen/token", async (_req,res)=>{
  try{
    const API_KEY = process.env.HEYGEN_API_KEY || process.env.HEYGEN_TOKEN || "";
    if(!API_KEY) return res.status(500).json({error:"missing_HEYGEN_API_KEY"});
    const r = await fetch("https://api.heygen.com/v1/streaming.create_token",{ method:"POST", headers:{"x-api-key":API_KEY,"Content-Type":"application/json"}, body:"{}" });
    const json = await r.json().catch(()=>({}));
    const token = json?.data?.token || json?.token || json?.access_token || "";
    if(!r.ok || !token){ return res.status(r.status||500).json({error:"heygen_token_failed", detail:json}); }
    res.setHeader("Access-Control-Allow-Origin","*");
    res.json({token});
  }catch(e){
    res.setHeader("Access-Control-Allow-Origin","*");
    res.status(500).json({error:"heygen_token_error"});
  }
});
app.get("/api/heygen/config", (_req,res)=>{
  const AV_LANGS=["es","en","pt","it","de","ca","fr"];
  const avatars={}; for(const l of AV_LANGS){ const k=`HEYGEN_AVATAR_${l.toUpperCase()}`; const v=(process.env[k]||"").trim(); if(v) avatars[l]=v; }
  const voiceId=(process.env.HEYGEN_VOICE_ID||"").trim();
  const defaultAvatar=(process.env.HEYGEN_DEFAULT_AVATAR||"").trim();
  const version=process.env.HEYGEN_CFG_VERSION || Date.now();
  res.setHeader("Access-Control-Allow-Origin","*");
  res.json({voiceId, defaultAvatar, avatars, version});
});

// ---------- Arranque ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log(`Servidor listo en puerto ${PORT}`));
