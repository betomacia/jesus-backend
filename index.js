// index.js — Bienvenida y diálogo 100% generados por OpenAI (multi-idioma, antirep)
// - /api/welcome: saludo por hora + nombre + frase alentadora + 1 pregunta de servicio (oferta A/B) — TODO por OpenAI
// - /api/ask: Autoayuda (acciones) + Psicología (marco breve) + Espiritualidad + Cita bíblica + pregunta final (oferta A/B)
// - Anti-repetición: evita preguntas/versos/técnicas recientes; no “escritura” consecutiva
// - Memoria en /data (configurable con DATA_DIR)
// - HeyGen y CORS abiertos
//
// Env: OPENAI_API_KEY, DATA_DIR (opcional), HEYGEN_* (opc)

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
function greetingByHour(lang="es"){
  const h=new Date().getHours();
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
    // normaliza campos nuevos
    mem.last_techniques = Array.isArray(mem.last_techniques) ? mem.last_techniques : [];
    mem.last_bible_refs = Array.isArray(mem.last_bible_refs) ? mem.last_bible_refs : [];
    mem.last_questions  = Array.isArray(mem.last_questions)  ? mem.last_questions  : [];
    return mem;
  }catch{
    return {
      last_bible_refs:[],
      last_questions:[],
      last_techniques:[], // etiquetas declaradas por el modelo
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

// ---------- Heurísticas de tema ----------
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

// ---------- Detección de sí / no / cierre (multi-idioma) ----------
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

// ---------- OpenAI helpers ----------
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
        techniques:{type:"array", items:{type:"string"}} // etiquetas declaradas por el modelo
      },
      required:["message","bible","question"],
      additionalProperties:false
    }
  }
};
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
app.get("/api/welcome", (_req,res)=> res.json({ok:true, hint:"POST /api/welcome { lang, name, userId, history }"}));
app.post("/api/memory/sync", (_req,res)=> res.json({ok:true}));

// ---------- WELCOME (100% OpenAI) ----------
app.post("/api/welcome", async (req,res)=>{
  try{
    const { lang="es", name="", userId="anon", history=[] } = req.body||{};
    const nm = String(name||"").trim();
    const hi = greetingByHour(lang);
    const mem = await readUserMemory(userId);

    const avoidQs = Array.isArray(mem.last_questions)? mem.last_questions.slice(-10):[];
    const shortHistory = compactHistory(history,6,200);

    const SYSTEM_PROMPT = `
Eres cercano, sereno y compasivo. Debes generar **variedad**; evita fórmulas fijas.

SALIDA SOLO JSON (en ${langLabel(lang)}):
- "message": ≤75 palabras. Incluye saludo por franja horaria y **nombre si existe** (p.ej. "${hi}${nm?`, ${nm}`:""}"). Da **1 frase alentadora** y **una línea breve de disponibilidad servicial**. **Sin signos de pregunta** y **sin citas bíblicas** dentro del mensaje.
- "question": **UNA sola** pregunta **de servicio** con **dos opciones** (p.ej., “escucharte más” **o** “compartir pasos concretos ahora”). Debe **terminar en "?"**. Evita preguntas sobre planes del día o triviales. Varía el lenguaje.

NO repitas literalmente preguntas recientes: ${avoidQs.map(q=>`"${q}"`).join(", ")||"(ninguna)"}.
Debes sonar natural y humano, **sin** mencionar IA/modelos.
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

    // Validaciones mínimas: que sea oferta A/B
    const looksBinaryNoOptions = /(qué te aliviaría|qué pequeño paso|qué vas a|qué harás|qué plan)/i.test(question||"");
    const hasOptionConnector = /\b(o|ou|or|oder|ou bien|o bien)\b/i.test(question||"");
    const banned = new Set(avoidQs.map(NORM));
    if (!question || banned.has(NORM(question)) || looksBinaryNoOptions || !hasOptionConnector){
      // Regenerar forzando oferta A/B
      const SYS2 = SYSTEM_PROMPT + `\nReformula la "question" como **oferta con dos opciones** explícitas y nuevas (A/B), sin repetir ninguna reciente.`;
      const r2 = await completionJson({
        messages: [{ role:"system", content: SYS2 }, { role:"user", content: header }],
        temperature: 0.85,
        max_tokens: 220,
        response_format: FORMAT_WELCOME
      });
      const c2 = r2?.choices?.[0]?.message?.content || "{}";
      try{ data=JSON.parse(c2);}catch{}
      msg = limitWords(stripQuestionsFromMessage(removeBibleLike(String(data?.message||msg||""))), 75);
      question = String(data?.question||question||"").trim();
      if (question && !/\?\s*$/.test(question)) question += "?";
    }

    // Persistencia de última pregunta
    if (question){
      mem.last_questions = Array.isArray(mem.last_questions)? mem.last_questions : [];
      mem.last_questions.push(question);
      while(mem.last_questions.length>10) mem.last_questions.shift();
      await writeUserMemory(userId, mem);
    }

    res.status(200).json({
      message: msg || `${hi}${nm?`, ${nm}`:""}. Estoy aquí para acompañarte con calma.`,
      bible: { text:"", ref:"" }, // bienvenida no incluye cita en message; omitimos contenido
      question: question || (lang==="en"?"Would you like me to listen more or share a practical next step?":"¿Preferís que te escuche un poco más o que te comparta un paso práctico?")
    });
  }catch(e){
    console.error("WELCOME ERROR:", e);
    const hi = greetingByHour("es");
    res.status(200).json({
      message: `${hi}. Estoy aquí para acompañarte con calma.`,
      bible:{ text:"", ref:"" },
      question: "¿Preferís que te escuche un poco más o que te comparta un paso práctico?"
    });
  }
});

// ---------- ASK (servicial, con soluciones concretas y oferta A/B) ----------
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

    const topic = guessTopic(userTxt);
    const mainSubject = detectMainSubject(userTxt);
    const frame = {
      topic_primary: topic,
      main_subject: mem.frame?.topic_primary===topic ? (mem.frame?.main_subject||mainSubject) : mainSubject,
      support_persons: mem.frame?.topic_primary===topic ? (mem.frame?.support_persons||[]) : [],
    };
    mem.frame = frame;
    mem.last_topic = topic;

    const avoidRefs = Array.isArray(mem.last_bible_refs)? mem.last_bible_refs.slice(-8):[];
    const avoidQs   = Array.isArray(mem.last_questions)? mem.last_questions.slice(-10):[];
    const avoidTech = Array.isArray(mem.last_techniques)? mem.last_techniques.slice(-6):[];
    const shortHistory = compactHistory(history,10,240);

    const QUESTION_POLICY =
      isBye
        ? `El usuario se despide/agradece: **no incluyas "question"**.`
        : `Cierra con **UNA pregunta** en ${langLabel(lang)} como **oferta con dos opciones** (A/B), p. ej. seguir escuchando **o** compartir pasos concretos ahora. Varía idioma y no repitas recientes: ${avoidQs.map(q=>`"${q}"`).join(", ")||"(ninguna)"}; termina en "?". Evita “¿qué te aliviaría…?” u otras donde el usuario deba inventar la solución.`;

    const WRITING_RULE = `
La **autoayuda** debe ser el eje (acciones concretas + mini-práctica 1–3 minutos).
**No sugieras "escribir/diario"** si ya se sugirió recientemente: ${avoidTech.map(t=>`"${t}"`).join(", ")||"(ninguna)"}.
Usa rotación de técnicas: respiración (4-7-8, caja, exhalación lenta), grounding 5-4-3-2-1, agua fría en la cara, caminar 5 minutos, oración breve, chequeo con persona de confianza, límites/tiempo fuera 24h, higiene de sueño simple, hidratación y alimento sencillo, reencuadre cognitivo. Elige 2–3 pasos concretos y guiados.
Solo menciona "escritura" si el usuario la pide o si **no** fue usada en el último turno. Nunca en dos turnos consecutivos.`;

    const ACCEPT_REJECT_RULE =
      saidYes
        ? `El usuario aceptó: brinda 2–3 pasos concretos y **una mini-práctica guiada**; luego la pregunta-oferta A/B.`
        : saidNo
        ? `El usuario rechazó: valida con calidez, ofrece otra vía concreta y suave; luego pregunta-oferta A/B.`
        : `Sin aceptación clara: propone 2–3 pasos y una mini-práctica guiada; luego pregunta-oferta A/B.`;

    const SYSTEM_PROMPT = `
Hablas con serenidad, claridad y compasión. **Nada de frases fijas**: varía tu lenguaje en cada respuesta.

SALIDA SOLO JSON (en ${langLabel(lang)}):
- "message": ≤75 palabras, **sin signos de pregunta**. Contiene:
  - **Autoayuda (eje):** 2–3 pasos concretos (imperativos suavizados: “podemos…”, “si te sirve, probemos…”, “podrías considerar…”).
  - **Mini-práctica guiada (1–3 min)** con instrucciones simples.
  - **Espiritualidad:** 1 línea de esperanza/compañía (sin cita dentro del mensaje).
- "bible": texto + ref (evita repetir: ${avoidRefs.map(r=>`"${r}"`).join(", ")||"(ninguna)"}).
- "question": ${isBye ? "omite la pregunta." : "UNA sola pregunta como oferta A/B; no pidas que el usuario invente la solución."}
- "techniques": lista de etiquetas breves de las técnicas sugeridas (ej.: ["breathing_box","grounding_54321","cold_water","time_out_24h","prayer_short","walk_5min","support_checkin","sleep_hygiene","hydrate","cognitive_reframe","writing_optional"]).

${WRITING_RULE}
${ACCEPT_REJECT_RULE}

Enfoca en el **tema**: ${frame.topic_primary}. Si es “general”, ayuda a concretar mediante los pasos que propongas (no con preguntas abiertas).
No menciones IA/modelos ni muletillas repetitivas.
`;

    const header =
      `Persona: ${persona}\n`+
      `Lang: ${lang}\n`+
      `Mensaje_usuario: ${userTxt}\n`+
      (shortHistory.length?`Historial: ${shortHistory.join(" | ")}`:"Historial: (sin antecedentes)")+"\n"+
      `Evitar_refs: ${avoidRefs.join(" | ")||"(ninguna)"}\n`+
      `Evitar_preguntas: ${avoidQs.join(" | ")||"(ninguna)"}\n`+
      `Evitar_tecnicas: ${avoidTech.join(" | ")||"(ninguna)"}\n`+
      `FRAME: ${JSON.stringify(frame)}\n`;

    // 1) Primera generación
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
      return { msg, ref, text, question, techniques };
    };

    let { msg, ref, text, question, techniques } = parseOut(r);

    // 2) Guardas: evitar pregunta genérica o sin oferta A/B; evitar escritura consecutiva
    const hasGenericAsk = /(qué te aliviaría|qué pequeño paso|qué vas a|qué harás|qué plan)/i.test(question||"");
    const hasAB = /\b(o|ou|or|oder|ou bien|o bien)\b/i.test(question||"");
    const lastWasWriting = (mem.last_techniques || []).slice(-1)[0] === "writing_optional";
    const thisMentionsWriting = (techniques||[]).includes("writing_optional") || /escrib/i.test(msg);

    if ((!isBye && (!question || hasGenericAsk || !hasAB)) || (thisMentionsWriting && lastWasWriting)) {
      const SYS2 = SYSTEM_PROMPT + `
Refuerza: **no** usar "escritura" si ya se sugirió en el último turno; formula la **pregunta como oferta A/B** explícita y distinta.`;
      r = await completionJson({
        messages: [{role:"system",content:SYS2},{role:"user",content:header}],
        temperature:0.65,
        max_tokens:320,
        response_format: FORMAT_ASK
      });
      ({ msg, ref, text, question, techniques } = parseOut(r));
    }

    // 3) Asegurar signo de pregunta y longitudes razonables
    if (!isBye){
      if (question && !/\?\s*$/.test(question)) question += "?";
      const tooShort = (question||"").split(/\s+/).length < 6;
      const tooLong  = (question||"").split(/\s+/).length > 22;
      if (tooShort || tooLong){
        const SYS3 = SYSTEM_PROMPT + `\nAjusta la "question" a 10–20 palabras, oferta A/B, clara y concreta.`;
        const r3 = await completionJson({
          messages: [{role:"system",content:SYS3},{role:"user",content:header}],
          temperature:0.65,
          max_tokens:300,
          response_format: FORMAT_ASK
        });
        ({ msg, ref, text, question, techniques } = parseOut(r3));
        if (question && !/\?\s*$/.test(question)) question += "?";
      }
    } else {
      question = "";
    }

    // 4) Evitar cita repetida/regenerar solo la Biblia si hace falta
    const avoidSet = new Set((mem.last_bible_refs||[]).map(x=>NORM(cleanRef(x))));
    if (!ref || avoidSet.has(NORM(ref))){
      const alt = await regenerateBibleAvoiding({ lang, persona, message:userTxt, frame, bannedRefs: mem.last_bible_refs||[], lastRef: mem.last_bible_refs?.slice(-1)[0]||"" });
      if (alt){ ref = alt.ref; text = alt.text; }
    }

    // 5) Persistencia
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

    // técnicas (para rotación anti-rep)
    if (Array.isArray(techniques) && techniques.length){
      mem.last_techniques = Array.isArray(mem.last_techniques)? mem.last_techniques : [];
      mem.last_techniques = [...mem.last_techniques, ...techniques].slice(-12);
    } else {
      // heurística mínima si no devuelve técnicas
      if (/4-7-8|4 7 8|4,7,8/i.test(msg)) mem.last_techniques = [...(mem.last_techniques||[]), "breathing_478"].slice(-12);
      else if (/caja|box breath/i.test(msg)) mem.last_techniques = [...(mem.last_techniques||[]), "breathing_box"].slice(-12);
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
