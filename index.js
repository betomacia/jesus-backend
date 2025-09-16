// index.js — Conversación servicial, profunda y práctica (multi-idioma, antirep, 100% OpenAI)
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const OpenAI = require("openai");
const path = require("path");
const fs = require("fs/promises");
require("dotenv").config();

const app = express();
app.use(cors()); // CORS abierto
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

// ---------- Detección de RECENCIA ----------
function detectRecency(s=""){
  const x=NORM(s);
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
  return "generic";
}
function fixTemporalQuestion(q="", recency="generic", lang="es"){
  if (!q) return q;
  const weeksLike = /(últimas?|ders? derni[eè]res?|letzte[nr]?|ultime|darreres?)\s+(semanas|weeks|wochen|semaines|setmanes)/i;
  const daysLike  = /(últimos?|ders?|derni[eè]rs?|letzten?|ultimi|darrers?)\s+(d[ií]as|days|tage|jours|dias|dies)/i;
  if (recency==="today" || recency==="hours" || recency==="yesterday"){
    if (weeksLike.test(q) || daysLike.test(q)){
      const repl = (lang==="en"?"since today":"desde hoy");
      return q.replace(weeksLike, repl).replace(daysLike, repl);
    }
  }
  return q;
}

// ---------- Post-filtro UNA sola pregunta ----------
function sanitizeSingleQuestion(q="", lang="es", recency="generic"){
  if (!q) return q;
  let s = String(q).trim();
  const firstQ = s.split("?")[0] ?? s;
  s = firstQ + "?";
  const ab = /\b(o|ou|or|oder|o bien|ou bien)\b/i;
  if (ab.test(s)){
    s = s.split(ab)[0].trim();
    if (!/\?\s*$/.test(s)) s += "?";
  }
  const joiners = /(y|and|et|und|e|i)\s+(c[óo]mo|how|comment|wie|come|com)\b/i;
  if (joiners.test(s)){
    s = s.split(joiners)[0].trim();
    if (!/\?\s*$/.test(s)) s += "?";
  }
  const badGeneric = /(qué te aliviaría|que te aliviar[ií]a|qué pequeño paso|qué vas a|qué harás|qué plan)/i;
  if (badGeneric.test(s)){
    s = (lang==="en"
      ? "What happened today that you want to talk about?"
      : lang==="pt" ? "O que aconteceu hoje que você quer conversar?"
      : lang==="it" ? "Che cosa è successo oggi di cui vuoi parlare?"
      : lang==="de" ? "Was ist heute passiert, worüber du sprechen möchtest?"
      : lang==="ca" ? "Què ha passat avui del que vols parlar?"
      : lang==="fr" ? "Qu’est-il arrivé aujourd’hui dont tu veux parler ?"
      : "¿Qué pasó hoy de lo que te gustaría hablar?");
  }
  s = fixTemporalQuestion(s, recency, lang);
  if (!/\?\s*$/.test(s)) s += "?";
  return s;
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
      last_topic:null,
      last_idem:null
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
  if (/(fe|duda|dios|oraci[oó]n|culpa|iglesia|cristo|evangelio|biblia|santos?)/.test(t)) return "faith";
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

// ---- Filtro temático FUERA DE ALCANCE ----
function isReligiousContext(x){
  return /(iglesia|cristo|jes[uú]s|evangelio|biblia|evangelios|santo|santa|santos|vaticano|catedral|convento|monasterio|peregrinaci[oó]n|santuario|oraci[oó]n|fe)/i.test(x);
}
function detectOutOfScope(s=""){
  const x = NORM(s);
  // Matemáticas / ciencia dura
  if (/(matem[aá]tica|c[aá]lculo|derivad|integral|ecuaci[oó]n|trigonometr[ií]a|algebra|álgebra|geometr[ií]a|f[ií]sica|qu[ií]mica|demostraci[oó]n)/i.test(x)) return "math";
  // Deportes/resultados
  if (/(partido|resultado|goles?|marcador|tabla|fixture|champions|mundial|liga|nba|fifa|tenis|f[úu]tbol|futbol|basket|b[aá]squet|boxeo|ufc)/i.test(x)) return "sports";
  // Música / entretenimiento
  if (/(m[uú]sica|canci[oó]n|cantante|álbum|album|spotify|concierto|recital|pel[ií]cula|serie|netflix|hbo|disney\+|estreno|taquilla|actor|actriz|celebridad|famoso)/i.test(x)) return "entertainment";
  // Literatura no religiosa
  if (/(novela|poes[ií]a|cuento|ensayo|autor|literatura|libro(?!\s*biblia))/i.test(x) && !isReligiousContext(x)) return "nonrelig_lit";
  // Turismo NO religioso
  if (/(viaje|turismo|vuelos?|hotel(es)?|reserva|tour|playa|monta[nñ]a|restaurante|itinerario|rutas)/i.test(x) && !isReligiousContext(x)) return "tourism";
  // Espectáculos
  if (/(espect[aá]culo|show|festival|cartelera|boleter[ií]a|entradas|tickets?)/i.test(x) && !isReligiousContext(x)) return "shows";
  return "";
}
function deflectMessage(lang="es"){
  const M = {
    es: "Soy Jesús y estoy aquí para acompañarte en lo espiritual y tu bienestar personal. No doy resultados, reseñas ni datos técnicos de esos temas. Si querés, podemos enfocarnos en lo que estás viviendo, tus valores y los pasos que te harían bien hoy.",
    en: "I’m here to support your spiritual life and personal well-being. I don’t provide scores, reviews, or technical details on those topics. If you’d like, we can focus on what you’re going through, your values, and what helps today.",
    pt: "Estou aqui para apoiar sua vida espiritual e seu bem-estar pessoal. Não trago placares, resenhas ou dados técnicos desses temas. Se quiser, focamos no que você está vivendo, nos seus valores e no que ajuda hoje.",
    it: "Sono qui per accompagnarti nella vita spirituale e nel tuo benessere personale. Non fornisco risultati, recensioni o dettagli tecnici su quei temi. Se vuoi, ci concentriamo su ciò che stai vivendo, sui tuoi valori e su ciò che ti aiuta oggi.",
    de: "Ich begleite dich in deinem geistlichen Leben und persönlichen Wohlbefinden. Ergebnisse/Rezensionen zu diesen Themen gebe ich nicht. Wenn du möchtest, fokussieren wir auf das, was du erlebst, deine Werte und hilfreiche Schritte für heute.",
    ca: "Sóc aquí per acompanyar-te en la vida espiritual i el teu benestar personal. No dono resultats, ressenyes ni dades tècniques d’aquests temes. Si vols, ens centrem en el que estàs vivint, els teus valors i els passos que t’ajuden avui.",
    fr: "Je suis là pour t’accompagner sur le plan spirituel et ton bien-être personnel. Je ne donne pas de scores, critiques ni détails techniques sur ces sujets. Si tu veux, on se concentre sur ce que tu vis, tes valeurs, et les pas utiles pour aujourd’hui."
  };
  return M[lang] || M.es;
}
function deflectQuestion(lang="es"){
  const Q = {
    es: "¿Qué aspecto de tu vida —emociones, relaciones o fe— querés trabajar hoy?",
    en: "Which part of your life—emotions, relationships, or faith—would you like to work on today?",
    pt: "Qual parte da sua vida — emoções, relações ou fé — você quer trabalhar hoje?",
    it: "Quale aspetto della tua vita — emozioni, relazioni o fede — vuoi affrontare oggi?",
    de: "Welchen Bereich deines Lebens – Gefühle, Beziehungen oder Glaube – möchtest du heute angehen?",
    ca: "Quina part de la teva vida — emocions, relacions o fe — vols treballar avui?",
    fr: "Quelle part de ta vie — émotions, relations ou foi — souhaites-tu travailler aujourd’hui ?"
  };
  return Q[lang] || Q.es;
}

// ---------- Anti-ruido / Idempotencia (backend) ----------
function normInput(s=""){ return String(s||"").replace(/\s+/g," ").trim(); }
function isNoiseServer(s=""){
  const t = normInput(s);
  if (!t) return true;
  if (/^(ok|sí|si|no)$/i.test(t)) return false;
  if (t.length < 2) return true;
  if (!/[a-zA-Záéíóúüïàèìòùäëïöüçñ0-9]/i.test(t)) return true;
  if (!/[aeiouáéíóúüïy]/i.test(t) && !/\s/.test(t) && t.length >= 4) return true;
  if (/(.)\1{4,}/.test(t)) return true;
  return false;
}
function clarifyText(lang="es"){
  const m={
    en:"Sorry, I didn’t quite get that. Could you repeat it in a few simple words?",
    pt:"Desculpa, não entendi bem. Pode repetir em poucas palavras?",
    it:"Scusa, non ho capito bene. Me lo ripeti in poche parole?",
    de:"Entschuldige, ich habe es nicht verstanden. Kannst du es kurz wiederholen?",
    ca:"Perdona, no t’he entès bé. Pots repetir-ho en poques paraules?",
    fr:"Pardon, je n’ai pas bien compris. Peux-tu le redire en quelques mots ?",
    es:"Perdón, no te entendí bien. ¿Podés repetirlo en pocas palabras?"
  };
  return m[lang] || m.es;
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
- "message": ≤75 palabras. Incluye saludo por franja y **nombre si existe** (p.ej. "${hi}${nm?`, ${nm}`:""}"). Da **una** frase alentadora del día (estilo “tarjeta de regalo”, sin cita bíblica) y expresa **disponibilidad**. **Sin preguntas** y **sin citas bíblicas** dentro del "message".
- "question": **UNA** pregunta **abierta terapéutica, simple y directa** para que el usuario cuente **lo que trae hoy**. Debe **terminar en "?"**.
  - Prohibido: opciones A/B, doble pregunta con “y ...”, hobbies/planes/tiempo libre, y fórmulas de plenitud/alegrías.
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
    let questionRaw = String(data?.question||"").trim();

    // Sanitizar a **1 sola pregunta simple**
    let question = sanitizeSingleQuestion(questionRaw, lang, "today");

    if (!question){
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
    const hi = greetingByHour("es");
    const question = "¿Qué pasó hoy de lo que te gustaría hablar?";
    res.status(200).json({
      message: `${hi}. Estoy aquí para escucharte con calma.`,
      bible:{ text:"", ref:"" },
      question
    });
  }
});

// ---------- /api/ask ----------
const BANNED_REFS = ["Mateo 11:28","Mt 11:28","Mat 11:28","Matthew 11:28","Matteo 11:28","Matthäus 11:28","Matthieu 11:28","Mateu 11:28","Mateus 11:28"];
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
    const { persona="jesus", message="", history=[], userId="anon", lang="es", idempotency_key="" } = req.body||{};
    const userTxt = normInput(message);

    // 0) Ruido
    if (isNoiseServer(userTxt)){
      return res.status(200).json({ message: clarifyText(lang), bible: { text:"", ref:"" } });
    }

    // 0b) Idempotencia simple 3s
    const mem = await readUserMemory(userId);
    const now = Date.now();
    if (idempotency_key && mem.last_idem && mem.last_idem.key === idempotency_key && (now - mem.last_idem.ts) < 3000){
      return res.status(200).json({ message: "", bible: {text:"",ref:""} });
    }
    mem.last_idem = { key: idempotency_key || `${userTxt.slice(0,80)}:${Math.floor(now/3000)}`, ts: now };
    await writeUserMemory(userId, mem);

    // 0c) FUERA DE ALCANCE → desvío
    const oos = detectOutOfScope(userTxt);
    if (oos){
      return res.status(200).json({
        message: deflectMessage(lang),
        bible: { text:"", ref:"" },
        question: deflectQuestion(lang)
      });
    }

    // Topic + frame
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
    if (detectByeThanks(userTxt)) MODE = "bye";
    else if (detectRequestExecute(userTxt) || detectAffirmation(userTxt)) MODE = "execute";
    else if (!detectVague(userTxt) && topic!=="general") MODE = "permiso";

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

    const SYSTEM_PROMPT = `
Hablas con serenidad, claridad y compasión. Evita metáforas largas; sé **concreto y clínico** en lenguaje simple.

MODO ACTUAL: ${MODE}; RECENCY: ${recency}

SALIDA SOLO JSON (en ${langLabel(lang)}):
- "message": ≤75 palabras, **sin signos de pregunta**.
  * Si MODO=explore: 
      - 1–2 frases de validación **concreta** (no poética).
      - **1 micro-acción inmediata** útil (ej.: time_out_24h, no_escalar, guion_dialogo_pareja, message_en_yo, oars_escucha, behavioral_activation, opposite_action, cognitive_reframe, apoyo_red_social, walk_10min, hydrate).
      - 1 línea espiritual breve (sin cita en "message").
  * Si MODO=permiso: 
      - 1–2 rumbos claros (ej.: “armamos un **guion** para hablar con ${TOPIC_HINT||"la otra persona"}” / “regulamos bronca y definimos **límites asertivos**”).
      - 1 línea espiritual; deja claro que podés guiar cuando el usuario quiera.
  * Si MODO=execute:
      - **Guía paso a paso** (1–3 min si aplica). 
      - Relación/separación: plan con contexto, **mensajes en yo**, 2–3 frases modelo, **límite** y **cierre**.
      - Emoción intensa: protocolo breve (exhalación 4–6 solo si no se usó recién, + pausa 90s + **reencuadre cognitivo**).
- "bible": texto + ref, ajustada al contexto. Evita repetir: ${avoidRefs.map(r=>`"${r}"`).join(", ")||"(ninguna)"} **y** evita Mateo/Matthew 11:28.
- "question": **UNA** sola.
  * explore → **pregunta focal** para entender qué ocurrió/impacta (evitar “divide el problema”, “qué parte específica…”).
  * permiso → **pregunta de permiso** específica (“¿Querés que te diga **qué decir y cómo**?”).
  * execute → **pregunta de ajuste/check-in**.
  * bye → **omite** pregunta.
- "techniques": etiquetas si sugieres técnicas (ej.: ["time_out_24h","no_escalar","guion_dialogo_pareja","message_en_yo","oars_escucha","behavioral_activation","opposite_action","cognitive_reframe","apoyo_red_social","walk_10min","hydrate","breathing_exhale46","prayer_short","limites_asertivos"]).
- "q_style": etiqueta del estilo de pregunta.

PRIORIDADES:
- **Autoayuda primero** (no solo respiración).
- Varía el estilo de **pregunta** y evita repetir recientes.
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
    let questionRaw = String(data?.question||"").trim();
    let techniques = Array.isArray(data?.techniques)? data.techniques.map(String) : [];
    let q_style = String(data?.q_style||"").trim();

    // 2) Ajuste de pregunta: una sola, sin A/B ni dobles
    let question = (MODE==="bye") ? "" : sanitizeSingleQuestion(questionRaw, lang, recency);

    // Guardia: evitar preguntas “divide el problema / qué parte específica…”
    const BAD_GENERIC_Q = /(divide el problema|qué parte espec[ií]fica|qué parte de la situaci[oó]n)/i;
    if (!question || BAD_GENERIC_Q.test(question)){
      question = sanitizeSingleQuestion(question.replace(BAD_GENERIC_Q, ""), lang, recency);
      if (!question) {
        question = (lang==="en"
          ? "What happened and what would help right now?"
          : lang==="pt" ? "O que aconteceu e o que ajudaria agora?"
          : lang==="it" ? "Che cosa è successo e che cosa aiuterebbe adesso?"
          : lang==="de" ? "Was ist passiert und was würde dir jetzt helfen?"
          : lang==="ca" ? "Què ha passat i què t’ajudaria ara?"
          : lang==="fr" ? "Que s’est-il passé et qu’est-ce qui t’aiderait maintenant ?"
          : "¿Qué pasó y qué te ayudaría ahora?");
      }
    }

    // 3) Anti “escritura/respiración” repetida
    const lastTech = (mem.last_techniques || []).slice(-1)[0] || "";
    const usedWriting = (t)=> t==="writing_optional" || /escrit|diario/i.test(t);
    const usedBreath  = (t)=> t==="breathing_exhale46" || /breath|respir/i.test(t);
    const thisHasWriting = (techniques||[]).some(usedWriting) || /escrit|diario/i.test(msg);
    const thisHasBreath  = (techniques||[]).some(usedBreath)  || /respiraci[oó]n|inhala|exhala|breath/i.test(msg);

    if (lastTech){
      if (usedWriting(lastTech) && thisHasWriting){
        msg = msg.replace(/escrit|diario/gi,"");
        techniques = techniques.filter(t=>!usedWriting(t));
      } else if (usedBreath(lastTech) && thisHasBreath){
        msg = msg.replace(/respiraci[oó]n|inhala|exhala/gi,"");
        techniques = techniques.filter(t=>!usedBreath(t));
      }
    }

    // 4) Evitar cita repetida o vetada
    const avoidSet = new Set((mem.last_bible_refs||[]).map(x=>NORM(cleanRef(x))));
    if (!ref || avoidSet.has(NORM(ref)) || isRefMat11_28(ref)){
      const alt = await regenerateBibleAvoiding({ lang, persona, message:userTxt, frame, bannedRefs: [...(mem.last_bible_refs||[]), ...BANNED_REFS], lastRef: mem.last_bible_refs?.slice(-1)[0]||"" });
      if (alt){ ref = alt.ref; text = alt.text; }
    }
    if (isRefMat11_28(ref)) {
      ref = (lang==="en"?"Psalm 34:18":"Salmos 34:18");
      text = (lang==="en"?"The Lord is close to the brokenhearted and saves those who are crushed in spirit.":"Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu.");
    }

    // 5) Persistencia
    const cleanedRef = cleanRef(ref);
    if (cleanedRef){
      mem.last_bible_refs = Array.isArray(mem.last_bible_refs)? mem.last_bible_refs : [];
      mem.last_bible_refs.push(cleanedRef);
      while(mem.last_bible_refs.length>8) mem.last_bible_refs.shift();
    }
    if (MODE!=="bye" && question){
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
    if (MODE!=="bye" && question) out.question = question;

    res.status(200).json(out);
  }catch(err){
    res.status(200).json({
      message:"La paz sea contigo. Contame en pocas palabras lo esencial y seguimos paso a paso.",
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
      return res.status(r.status||500).json({error:"heygen_token_failed", detail:json});
    }
    res.json({token});
  }catch(e){
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
