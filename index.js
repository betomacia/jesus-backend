// index.js — Backend conversacional enfocado (multi-idioma, antirep, memoria, dominios acotados)

const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const OpenAI = require("openai");
const path = require("path");
const fs = require("fs/promises");
require("dotenv").config();

const app = express();
app.use(cors({ origin: "*"}));
app.use(bodyParser.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ----------------------- Utils básicos ----------------------- */
const NORM = (s="") => String(s).toLowerCase().replace(/\s+/g," ").trim();
const clampWords = (s="", max=75) => {
  const w = String(s).trim().split(/\s+/);
  return w.length<=max ? String(s).trim() : w.slice(0,max).join(" ").trim();
};
const cleanRef = (ref="") => String(ref).replace(/\s*\([^)]*\)\s*/g," ").replace(/\s+/g," ").trim();
const stripEndQs = (s="") => String(s).split(/\n+/).map(l=>l.trim()).filter(l=>!/\?\s*$/.test(l)).join("\n").trim();
const removeBibleLike = (t="") => t
  .replace(/^[\s]*[—-]\s*.*?\([^)]+?\d+\s*:\s*\d+\)[\s]*$/gim,"")
  .replace(/\(([^)]+?\d+\s*:\s*\d+)\)/g,"")
  .replace(/\s*[—-]\s*[^()]*\(\s*[^)]+?\d+\s*:\s*\d+\s*\)\s*$/g,"")
  .replace(/[ \t]+\n/g,"\n").replace(/\n{3,}/g,"\n\n").trim();

const compactHistory = (arr=[], keep=8, maxLen=260) =>
  (Array.isArray(arr)?arr:[]).slice(-keep).map(x=>String(x).slice(0,maxLen));

const LANG_LABEL = {
  es:"Español", en:"English", pt:"Português", it:"Italiano", de:"Deutsch", ca:"Català", fr:"Français"
};
const langLabel = (l="es") => LANG_LABEL[l] || "Español";

/* ----------------------- Bienvenida: frase motivacional ----------------------- */
function motivationLine(lang="es"){
  const M = {
    es:[
      "Un gesto de bondad puede cambiar tu día.",
      "La esperanza crece con cada paso pequeño.",
      "Hoy es una buena oportunidad para comenzar de nuevo.",
      "La paciencia también es una forma de fortaleza.",
      "Respirar hondo es abrir espacio a la paz."
    ],
    en:[
      "A small act of kindness can change your day.",
      "Hope grows with every small step.",
      "Today is a good chance to begin again.",
      "Patience is a quiet kind of strength.",
      "A deep breath makes room for peace."
    ],
    pt:[
      "Um gesto de bondade pode transformar o seu dia.",
      "A esperança cresce a cada pequeno passo.",
      "Hoje é uma boa chance de recomeçar.",
      "Paciência também é força.",
      "Respirar fundo abre espaço para a paz."
    ],
    it:[
      "Un gesto di bontà può cambiare la tua giornata.",
      "La speranza cresce ad ogni piccolo passo.",
      "Oggi è una buona occasione per ricominciare.",
      "La pazienza è forza silenziosa.",
      "Un respiro profondo fa spazio alla pace."
    ],
    de:[
      "Eine kleine Freundlichkeit kann deinen Tag verändern.",
      "Hoffnung wächst mit jedem kleinen Schritt.",
      "Heute ist eine gute Chance für einen Neuanfang.",
      "Geduld ist stille Stärke.",
      "Ein tiefer Atemzug schafft Raum für Frieden."
    ],
    ca:[
      "Un gest de bondat pot canviar el teu dia.",
      "L’esperança creix amb cada petit pas.",
      "Avui és una bona oportunitat per recomençar.",
      "La paciència també és fortalesa.",
      "Respirar profund obre espai a la pau."
    ],
    fr:[
      "Un geste de bonté peut changer ta journée.",
      "L’espérance grandit à chaque petit pas.",
      "Aujourd’hui est une bonne occasion de recommencer.",
      "La patience est une force tranquille.",
      "Une profonde inspiration laisse place à la paix."
    ]
  };
  const arr = M[lang] || M.es;
  return arr[Math.floor(Math.random()*arr.length)];
}

/* ----------------------- Hora local ----------------------- */
function resolveClientHour({hour=null, client_iso=null, tz=null}={}){
  if (Number.isInteger(hour) && hour>=0 && hour<24) return hour;
  if (client_iso){
    const d = new Date(client_iso);
    if (!isNaN(d.getTime())) return d.getHours();
  }
  if (tz){
    try{
      const fmt = new Intl.DateTimeFormat("en-US",{timeZone:tz,hour:"numeric",hour12:false});
      const parts = fmt.formatToParts(new Date());
      const h = parseInt(parts.find(p=>p.type==="hour")?.value||"0",10);
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

/* ----------------------- Detecciones ----------------------- */
function detectRecency(s=""){
  const x=NORM(s);
  const today = /\b(hoy|reci[eé]n|ahora|esta (mañana|tarde|noche))\b/.test(x)
             || /\b(today|right now|this (morning|afternoon|evening))\b/.test(x)
             || /\b(hoje|agora|esta (manhã|tarde|noite))\b/.test(x)
             || /\b(oggi|adesso|questa (mattina|pomeriggio|sera))\b/.test(x)
             || /\b(heute|(heute )?(morgen|nachmittag|abend))\b/.test(x)
             || /\b(avui|aquest (matí|tarda|vespre))\b/.test(x)
             || /\b(aujourd'hui|ce (matin|après-midi|soir))\b/.test(x);
  if (today) return "today";
  const yesterday = /\b(ayer|yesterday|ontem|ieri|gestern|ahir|hier)\b/.test(x);
  if (yesterday) return "yesterday";
  const hours = /\b(hace|ha)\s*\d+\s*(h|horas?)\b/.test(x) || /\b\d+\s*(hours?|hrs?)\s*ago\b/.test(x);
  if (hours) return "hours";
  return "generic";
}

function detectAffirmation(s=""){
  const x=NORM(s);
  const pats=[
    /\bsi\b|\bsí\b|\bclaro\b|\bvale\b|\bok\b|\bperfecto\b|\bde acuerdo\b/,
    /\byes\b|\bsure\b|\bok\b/,
    /\bsim\b/,
    /\bsì\b/,
    /\bja\b/,
    /\boui\b/
  ];
  return pats.some(r=>r.test(x));
}
function detectNegation(s=""){
  const x=NORM(s);
  const pats=[
    /\bno\b|\bmejor no\b|\bno gracias\b/,
    /\bnope\b|\bnah\b/,
    /\bnão\b/,
    /\bnon\b/,
    /\bnein\b/,
    /\bnon\b/
  ];
  return pats.some(r=>r.test(x));
}
function detectByeThanks(s=""){
  const x=NORM(s);
  const pats=[
    /\bgracias\b|\bme tengo que ir\b|\bme voy\b|\bhasta luego\b|\bad(i|í)os\b/,
    /\bthank(s| you)\b|\bi have to go\b|\bbye\b|\bsee you\b/,
    /\bobrigad[oa]\b|\btchau\b/,
    /\bdevo andare\b|\bciao\b/,
    /\bdanke\b|\btschüss\b/,
    /\bmerci\b|\bje dois partir\b/
  ];
  return pats.some(r=>r.test(x));
}
function detectVague(s=""){
  const x=NORM(s);
  if (!x) return true;
  if (x.length<12) return true;
  if (/\btengo un problema\b|\bproblema\b|\bnecesito ayuda\b|\bno s[eé] por d[oó]nde empezar\b|\bhola\b|\bestoy mal\b/.test(x)) return true;
  return false;
}
function detectRequestExecute(s=""){
  const x=NORM(s);
  return /\b(dime|decime)\s+qu[eé]\s+hacer\b|\bquiero\s+pasos\b|\barmar\s+un\s+guion\b|\bgu[ií]ame\b|\bquiero que me digas\b/.test(x);
}

// evento capturado & hijos/visitas
function detectEventCaptured(s=""){
  const x=NORM(s);
  return /(me separ[ée]|separaci[oó]n|divorcio|infidelidad|me enga[nñ]o|se acost[oó] con|traici[oó]n|pelea con mi (pareja|espos[oa]|novi[oa]))/.test(x);
}
function detectChildrenFlag(s=""){
  const x=NORM(s);
  return /(hij[oa]s?|custodia|visitas|r[eé]gimen de visitas|ver a (los|mis) ni[nñ]os|no (lo|la) va[sy] a ver|no (dejo|dejar[ée]) ver)/.test(x);
}

// dominios excluidos (no religiosos)
function isReligiousContext(s=""){
  const x=NORM(s);
  return /(iglesia|templo|catedral|bas[ií]lica|vaticano|oraci[oó]n|confesi[oó]n|sacramento|peregrinaci[oó]n|santo|fe|biblia)/.test(x);
}
function isExcludedTopic(s=""){
  const x=NORM(s);
  const geoTour = /(d[oó]nde queda|ubicaci[oó]n|pa[ií]s|mapa|turismo|restaurantes|playas|hoteles|atracciones|clima|capital)/;
  const sports  = /(partido|resultado|goles|f[úu]tbol|nba|tenis|mundial|liga|marcador)/;
  const ent     = /(m[úu]sica|canci[oó]n|pel[ií]cula|serie|actor|actriz|concierto|espect[aá]culo)/;
  const lit     = /(novela|libro de ficci[oó]n|best seller|autor de novelas)/;
  const mathSci = /(matem[aá]tica|f[ií]sica|qu[ií]mica|biolog[ií]a|geograf[ií]a|historia(?! cristiana))/;
  const mechIT  = /(alternador|embrague|inyector|motor|c[óo]dig[oa]|javascript|python|servidor|ip|wifi|windows|linux|gpu|cpu)/;
  const toys    = /(consola|juego|videojuego|playstation|xbox|switch|lego|juguete)/;
  return (
    ((geoTour.test(x) || /argentina|brasil|alemania|españa|italia|francia|uruguay|chile|mexico|per[uú]/.test(x)) && !isReligiousContext(x)) ||
    sports.test(x) || ent.test(x) || (lit.test(x) && !/biblia|evangelio|santos|literatura religiosa/.test(x)) ||
    mathSci.test(x) || mechIT.test(x) || toys.test(x)
  );
}

/* ----------------------- Post-filtro UNA sola pregunta ----------------------- */
function fixTemporalQuestion(q="", recency="generic", lang="es"){
  if (!q) return q;
  const weeksLike = /(últimas?|dernieres?|letzte|ultime|darreres?)\s+(semanas|weeks|wochen|semaines|setmanes)/i;
  const daysLike  = /(últimos?|derniers?|letzten?|ultimi|darrers?)\s+(d[ií]as|days|tage|jours|dies)/i;
  if (recency==="today" || recency==="hours" || recency==="yesterday"){
    if (weeksLike.test(q) || daysLike.test(q)){
      const repl = (lang==="en"?"since today":"desde hoy");
      q = q.replace(weeksLike, repl).replace(daysLike, repl);
    }
  }
  if (!/\?\s*$/.test(q)) q = q.trim() + "?";
  return q;
}
function sanitizeSingleQuestion(q="", lang="es", recency="generic", avoidRecent=[]){
  if (!q) return q;
  let s = String(q).trim();
  s = (s.split("?")[0]||s).trim()+"?";
  // Bloquear A/B y dobles “y cómo/and how…”
  const ab = /\b(o|ou|or|oder|o bien|ou bien)\b/i;
  if (ab.test(s)) s = s.split(ab)[0].trim()+"?";
  const joiners = /(y|and|et|und|e|i)\s+(c[óo]mo|how|comment|wie|come|com)\b/i;
  if (joiners.test(s)) s = s.split(joiners)[0].trim()+"?";

  // Genéricas que no sirven (añado “divide el problema / qué parte…”)
  const BAD_GENERIC_Q = /(qué te aliviar[ií]a|que te aliviar[ií]a|qué pequeño paso|qué vas a|qué harás|qué plan|divide el problema|qué parte espec[ií]fica|qué parte de la situaci[oó]n)/i;
  if (BAD_GENERIC_Q.test(NORM(s))) {
    s = (lang==="en"
      ? "What happened that you want to address first?"
      : lang==="pt" ? "O que aconteceu que você quer abordar primeiro?"
      : lang==="it" ? "Che cosa è successo che vuoi affrontare per prima?"
      : lang==="de" ? "Was ist passiert, das du zuerst angehen möchtest?"
      : lang==="ca" ? "Què ha passat que vols abordar primer?"
      : lang==="fr" ? "Qu’est-il arrivé que tu veux aborder en premier ?"
      : "¿Qué pasó y qué querés abordar primero?");
  }

  // Evitar repetir últimas N preguntas
  if (avoidRecent.map(NORM).includes(NORM(s))) {
    s = (lang==="en"?"What part would you like to start with today?":
         lang==="pt"?"Por qual parte você quer começar hoje?":
         lang==="it"?"Da quale parte vuoi iniziare oggi?":
         lang==="de"?"Mit welchem Teil möchtest du heute beginnen?":
         lang==="ca"?"Per on vols començar avui?":
         lang==="fr"?"Par quelle partie veux-tu commencer aujourd’hui ?":
         "¿Por dónde querés empezar hoy?");
  }

  return fixTemporalQuestion(s, recency, lang);
}

/* ----------------------- Memoria en FS ----------------------- */
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
    mem.frame = mem.frame || {};
    return mem;
  }catch{
    return {
      last_bible_refs:[], last_questions:[], last_techniques:[], last_q_styles:[],
      frame:{}, last_offer_kind:null, last_user_reply:null, last_ts:0, pending_action:null, last_topic:null
    };
  }
}
async function writeUserMemory(userId,mem){
  await ensureDataDir();
  await fs.writeFile(memPath(userId), JSON.stringify(mem,null,2), "utf8");
}

/* ----------------------- OpenAI JSON formats ----------------------- */
const FORMAT_WELCOME = {
  type:"json_schema",
  json_schema:{
    name:"WelcomeSchema",
    schema:{ type:"object", properties:{ message:{type:"string"}, question:{type:"string"} },
      required:["message","question"], additionalProperties:false }
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
      required:["bible"], additionalProperties:false
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

/* ----------------------- Rutas de salud ----------------------- */
app.get("/", (_req,res)=> res.json({ok:true, service:"backend", ts:Date.now()}));
app.get("/api/welcome", (_req,res)=> res.json({ok:true, hint:"POST /api/welcome { lang, name, userId, history, hour?, client_iso?, tz? }"}));
app.post("/api/memory/sync", (_req,res)=> res.json({ok:true}));

/* ----------------------- /api/welcome ----------------------- */
app.post("/api/welcome", async (req,res)=>{
  try{
    const { lang="es", name="", userId="anon", history=[], hour=null, client_iso=null, tz=null } = req.body||{};
    const nm = String(name||"").trim();
    const hi = greetingByHour(lang, {hour, client_iso, tz});
    const mem = await readUserMemory(userId);
    const avoidQs = Array.isArray(mem.last_questions)? mem.last_questions.slice(-10):[];
    const shortHistory = compactHistory(history,6,200);
    const insp = motivationLine(lang);

    const SYSTEM_PROMPT = `
Eres cercano, sereno y compasivo. Varía el lenguaje, evita muletillas, hobbies/planes y positivismo forzado.

SALIDA SOLO JSON (en ${langLabel(lang)}):
- "message": ≤75 palabras. Incluye saludo por franja y **nombre si existe** (p.ej. "${hi}${nm?`, ${nm}`:""}"). 
  Añade **una sola** frase motivacional del día (no bíblica), distinta a una cita. **Sin preguntas** y **sin citas** dentro del "message".
- "question": **UNA** pregunta **abierta, simple y directa** para que el usuario cuente **lo que trae hoy**. Debe **terminar en "?"**.
  Prohibido: A/B, doble pregunta con “y ...”, hobbies/planes/tiempo libre y preguntas genéricas repetitivas.
Evita repetir recientes: ${avoidQs.map(q=>`"${q}"`).join(", ")||"(ninguna)"}.
No menciones IA/modelos.`;
    const header =
      `Lang: ${lang}\n`+
      `Nombre: ${nm||"(anónimo)"}\n`+
      `Saludo_sugerido: ${hi}${nm?`, ${nm}`:""}\n`+
      `Frase_dia: ${insp}\n`+
      (shortHistory.length?`Historial: ${shortHistory.join(" | ")}`:"Historial: (sin antecedentes)")+"\n";

    const r = await completionJson({
      messages: [{ role:"system", content: SYSTEM_PROMPT }, { role:"user", content: header }],
      temperature: 0.8, max_tokens: 260, response_format: FORMAT_WELCOME
    });

    const content = r?.choices?.[0]?.message?.content || "{}";
    let data={}; try{ data=JSON.parse(content);}catch{ data={}; }
    let msg = clampWords(stripEndQs(removeBibleLike(String(data?.message||""))), 75);
    if (!msg) msg = `${hi}${nm?`, ${nm}`:""}. ${insp}`;
    let question = sanitizeSingleQuestion(String(data?.question||"").trim(), lang, "today", avoidQs);
    if (!question){
      question = (lang==="en"?"What happened today that you’d like to talk about?":
                  lang==="pt"?"O que aconteceu hoje que você gostaria de conversar?":
                  lang==="it"?"Che cosa è successo oggi di cui vorresti parlare?":
                  lang==="de"?"Was ist heute passiert, worüber du sprechen möchtest?":
                  lang==="ca"?"Què ha passat avui que vulguis compartir?":
                  lang==="fr"?"Qu’est-il arrivé aujourd’hui dont tu aimerais parler ?":
                  "¿Qué pasó hoy de lo que te gustaría hablar?");
    }

    if (question){
      mem.last_questions = Array.isArray(mem.last_questions)? mem.last_questions : [];
      mem.last_questions.push(question);
      while(mem.last_questions.length>10) mem.last_questions.shift();
      await writeUserMemory(userId, mem);
    }

    res.status(200).json({ message: msg, question });
  }catch(e){
    const hi = greetingByHour("es");
    const msg = `${hi}. ${motivationLine("es")}`;
    const question = "¿Qué pasó hoy de lo que te gustaría hablar?";
    res.status(200).json({ message: msg, question });
  }
});

/* ----------------------- /api/ask ----------------------- */
const BANNED_REFS = ["Mateo 11:28","Mt 11:28","Mat 11:28","Matthew 11:28","Matteo 11:28","Matthäus 11:28","Matthieu 11:28","Mateu 11:28","Mateus 11:28"];
function isRefMat11_28(ref=""){
  const x=NORM(ref);
  const pats=[
    /mateo\s*11\s*:\s*28/, /mt\.?\s*11\s*:\s*28/, /mat\.?\s*11\s*:\s*28/, /san\s+mateo\s*11\s*:\s*28/,
    /matthew?\s*11\s*:\s*28/, /matteo\s*11\s*:\s*28/, /matthäus\s*11\s*:\s*28/, /matthieu\s*11\s*:\s*28/,
    /mateu\s*11\s*:\s*28/, /mateus\s*11\s*:\s*28/
  ];
  return pats.some(r=>r.test(x));
}

async function regenBibleAvoiding({ lang, persona, message, frame, bannedRefs=[], lastRef="" }){
  const SYS = `
Devuelve SOLO JSON {"bible":{"text":"…","ref":"Libro 0:0"}} en ${langLabel(lang)}.
- Ajusta la cita al tema/contexto.
- Evita referencias recientes: ${bannedRefs.map(r=>`"${r}"`).join(", ")||"(ninguna)"} y la última: "${lastRef||"(n/a)"}".
- Evita Mateo/Matthew 11:28 (todas las variantes).
- No agregues nada fuera del JSON.`;
  const USR = `Persona: ${persona}\nMensaje_usuario: ${message}\nFRAME: ${JSON.stringify(frame)}`;
  const r = await completionJson({
    messages:[{role:"system",content:SYS},{role:"user",content:USR}],
    temperature:0.4, max_tokens:120, response_format: FORMAT_BIBLE_ONLY
  });
  const content = r?.choices?.[0]?.message?.content || "{}";
  let data={}; try{ data=JSON.parse(content);}catch{ data={}; }
  const text = (data?.bible?.text||"").toString().trim();
  const ref  = cleanRef((data?.bible?.ref||"").toString());
  return text && ref ? { text, ref } : null;
}

// Plantillas de guion (mínimas, idioma por salida del modelo; usamos español si el modelo falla)
function scriptSeparationES(){
  return [
    "**Contexto (1 frase):** “Quiero hablar con respeto sobre lo que pasó entre nosotros.”",
    "**Mensaje en yo (2):** “Me sentí herido y confundido.” / “Necesito entender y también poner límites sanos.”",
    "**Límite:** “No voy a insultar ni espiar; necesito honestidad y respeto mutuo.”",
    "**Petición concreta:** “Propongo pausar 24h antes de decisiones grandes y luego acordar pasos.”",
    "**Cierre breve:** “Gracias por escuchar; busquemos el bien, sobre todo por nuestra paz.”"
  ].join("\n");
}
function scriptCoparentingES(){
  return [
    "**Apertura:** “Quiero hablar de los chicos sin peleas.”",
    "**Enfoque en ellos:** “Ellos necesitan calma y amor de ambos.”",
    "**Regla de no escalar:** “Si sube el tono, paramos 24h y seguimos luego.”",
    "**Acuerdo de visitas (borrador):** días/horarios claros, puntualidad y flexibilidad mínima.",
    "**Cierre:** “Cualquier cambio lo avisamos por mensaje, con respeto.”"
  ].join("\n");
}

app.post("/api/ask", async (req,res)=>{
  try{
    const { persona="jesus", message="", history=[], userId="anon", lang="es" } = req.body||{};
    const userTxt = String(message||"").trim();

    // Filtro de ruido / vacío
    const justNoise = !userTxt || /^[^a-zA-ZÀ-ÿ\d]{1,4}$/.test(userTxt);
    if (justNoise) {
      const msg = (lang==="en"?"I didn’t get that—could you say it again in a few words?":
                   lang==="pt"?"Não entendi bem—pode repetir em poucas palavras?":
                   lang==="it"?"Non ho capito bene—puoi ripetere in poche parole?":
                   lang==="de"?"Ich habe das nicht verstanden—kannst du es kurz wiederholen?":
                   lang==="ca"?"No ho vaig entendre bé—ho pots repetir en poques paraules?":
                   lang==="fr"?"Je n’ai pas bien compris—peux-tu répéter en quelques mots ?":
                   "No te entendí bien—¿podés repetirlo en pocas palabras?");
      return res.status(200).json({ message: msg, bible:{text:"",ref:""}, question: "" });
    }

    // Dominios excluidos (no religiosos)
    if (isExcludedTopic(userTxt)) {
      const msg = (lang==="en"
        ? "I’m here for your spirituality and personal wellbeing. I don’t provide results or technical data about that. We can talk about your emotions, relationships, or faith—and I can guide you with a practical next step."
        : lang==="pt"
        ? "Estou aqui para sua espiritualidade e bem-estar pessoal. Não trago resultados nem dados técnicos sobre esse tema. Podemos falar das suas emoções, relações ou fé—e eu te guio num próximo passo prático."
        : lang==="it"
        ? "Sono qui per la tua spiritualità e il tuo benessere personale. Non fornisco risultati o dati tecnici su quell’argomento. Possiamo parlare delle tue emozioni, relazioni o fede—e guidarti in un passo concreto."
        : lang==="de"
        ? "Ich bin für deine Spiritualität und dein Wohlbefinden da. Ich gebe keine Resultate oder technischen Daten dazu. Wir können über Gefühle, Beziehungen oder Glauben sprechen—und ich gebe dir einen praktischen nächsten Schritt."
        : lang==="ca"
        ? "Sóc aquí per la teva espiritualitat i benestar personal. No dono resultats ni dades tècniques sobre això. Podem parlar de les teves emocions, relacions o fe—i et guio amb un pas pràctic."
        : lang==="fr"
        ? "Je suis là pour ta spiritualité et ton bien-être. Je ne donne pas de résultats ni de données techniques là-dessus. Parlons de tes émotions, relations ou foi—et je te guide avec un pas concret."
        : "Estoy aquí para tu espiritualidad y tu bienestar personal. No doy resultados ni datos técnicos sobre ese tema. Podemos enfocarnos en tus emociones, tus relaciones o tu fe—y te guío con un paso práctico.");
      const q = (lang==="en"?"Which would you like to focus on—your emotions, a relationship, or your faith?":
                 lang==="pt"?"Quer focar nas suas emoções, numa relação ou na sua fé?":
                 lang==="it"?"Vuoi concentrarti sulle tue emozioni, una relazione o la tua fede?":
                 lang==="de"?"Möchtest du dich auf Gefühle, eine Beziehung oder deinen Glauben konzentrieren?":
                 lang==="ca"?"Vols enfocar-te en les teves emocions, una relació o la teva fe?":
                 lang==="fr"?"Tu préfères te concentrer sur tes émotions, une relation ou ta foi ?":
                 "¿Querés enfocarte en tus emociones, una relación o tu fe?");
      return res.status(200).json({ message: msg, bible:{text:"",ref:""}, question: q });
    }

    const mem = await readUserMemory(userId);
    const isBye   = detectByeThanks(userTxt);
    const saidYes = detectAffirmation(userTxt);
    const saidNo  = detectNegation(userTxt);
    const recency = detectRecency(userTxt);

    // Actualizar flags de evento/hijos
    if (detectEventCaptured(userTxt)) mem.frame.event_captured = true;
    if (detectChildrenFlag(userTxt)) mem.frame.children_flag = true;

    // Tópico (muy simple)
    const topic = /(pareja|espos[oa]|novi[oa]|separaci[oó]n|divorcio|infidelidad)/i.test(userTxt) ? "relationship"
                : /(hij[oa]s?|custodia|visitas)/i.test(userTxt) ? "coparenting"
                : /(ansiedad|miedo|tristeza|depresi[oó]n|bronca|ira|estr[eé]s)/i.test(userTxt) ? "mood"
                : /(fe|dios|oraci[oó]n|culpa|perd[oó]n)/i.test(userTxt) ? "faith"
                : mem.last_topic || "general";
    mem.last_topic = topic;

    // Progresión de modo
    let MODE = "explore";         // explore → permiso → execute → (bye)
    let EXEC_KIND = null;         // "guion_separacion" | "guion_coparenting" | "regulacion_bronca"
    const shortHistory = compactHistory(history,10,240);

    if (isBye) MODE = "bye";
    else if (saidYes && (mem.pending_action==="offer_guion_separacion" || mem.pending_action==="offer_guion_coparenting" || mem.pending_action==="offer_regulacion")){
      MODE = "execute";
      EXEC_KIND = mem.pending_action.replace("offer_","");
    } else if (mem.frame.event_captured) {
      // ya tenemos evento → pedir permiso para guion/regulación según contexto
      MODE = "permiso";
      if (mem.frame.children_flag || topic==="coparenting") {
        mem.pending_action = "offer_guion_coparenting";
      } else if (topic==="relationship") {
        mem.pending_action = "offer_guion_separacion";
      } else {
        mem.pending_action = "offer_regulacion";
      }
    } else if (detectRequestExecute(userTxt)) {
      MODE = "execute";
      EXEC_KIND = topic==="coparenting" ? "guion_coparenting"
                : topic==="relationship" ? "guion_separacion"
                : "regulacion_bronca";
      mem.pending_action = "offer_"+EXEC_KIND;
    } else {
      MODE = "explore";
      mem.pending_action = null;
    }

    // Anti-repetición de preguntas y técnicas
    const avoidRefs   = (mem.last_bible_refs||[]).slice(-8);
    const avoidQs     = (mem.last_questions||[]).slice(-10);
    const avoidTech   = (mem.last_techniques||[]).slice(-6);
    const avoidQStyle = (mem.last_q_styles||[]).slice(-6);

    // Si vamos a ejecutar, devolvemos guion concreto SIN preguntar objetivos otra vez
    if (!isBye && MODE==="execute") {
      let script = "";
      if (EXEC_KIND==="guion_coparenting") script = scriptCoparentingES();
      else if (EXEC_KIND==="guion_separacion") script = scriptSeparationES();
      else {
        script = [
          "**Regular ahora (90s):** exhala más largo que inhalas (4–6), pausa breve, repite.",
          "**Nombrar emoción:** “Estoy con bronca/tristeza; no voy a decidir ahora.”",
          "**Acción mínima:** un vaso de agua + caminar 5–10 min.",
          "**Reencuadre 1 línea:** “Puedo responder con respeto y límites.”"
        ].join("\n");
      }
      const msg = (lang==="en"? "Here’s a short script you can use right now:\n\n" :
                  lang==="pt"? "Aqui vai um roteiro curto que você pode usar agora:\n\n" :
                  lang==="it"? "Ecco un copione breve da usare adesso:\n\n" :
                  lang==="de"? "Hier ist ein kurzes Skript, das du jetzt verwenden kannst:\n\n" :
                  lang==="ca"? "Tens un guió curt per usar ara mateix:\n\n" :
                  lang==="fr"? "Voici un court script à utiliser maintenant :\n\n" :
                  "Acá tenés un guion breve para usar ahora:\n\n") + script;

      // Biblia (evitando repeticiones)
      let ref="", text="";
      const alt = await regenBibleAvoiding({
        lang, persona, message:userTxt, frame:mem.frame,
        bannedRefs:[...avoidRefs,...BANNED_REFS],
        lastRef: avoidRefs.slice(-1)[0]||""
      });
      if (alt){ ref=alt.ref; text=alt.text; }
      if (isRefMat11_28(ref) || !ref) {
        ref = (lang==="en"?"Psalm 34:18":"Salmos 34:18");
        text = (lang==="en"?"The Lord is close to the brokenhearted and saves those who are crushed in spirit.":"Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu.");
      }

      // Pregunta de ajuste breve
      const q = (lang==="en"?"Do you want us to tweak any line of the script?":
                 lang==="pt"?"Quer ajustar alguma linha do roteiro?":
                 lang==="it"?"Vuoi che modifichiamo qualche frase del copione?":
                 lang==="de"?"Sollen wir eine Zeile des Skripts anpassen?":
                 lang==="ca"?"Vols ajustar alguna frase del guió?":
                 lang==="fr"?"Souhaites-tu ajuster une phrase du script ?":
                 "¿Querés ajustar alguna línea del guion?");
      // Persistencia
      mem.last_bible_refs = [...avoidRefs, ref].slice(-8);
      mem.last_questions = [...avoidQs, q].slice(-10);
      mem.last_q_styles = [...avoidQStyle, "execute_checkin"].slice(-10);
      mem.last_techniques = [...avoidTech, EXEC_KIND||"execute"].slice(-12);
      mem.pending_action = null;
      await writeUserMemory(userId, mem);
      return res.status(200).json({ message: msg, bible:{text,ref}, question: q });
    }

    // Si no estamos en ejecutar, usamos el modelo con reglas fuertes
    const TOPIC_HINT = {
      relationship: { es:"tu pareja", en:"your partner", pt:"sua parceria", it:"il tuo partner", de:"deinem Partner", ca:"la teva parella", fr:"ton/ta partenaire" },
      coparenting:  { es:"las visitas y el cuidado de los hijos", en:"visitation and care of the children", pt:"as visitas e o cuidado dos filhos", it:"le visite e la cura dei figli", de:"Umgangszeiten und Fürsorge für die Kinder", ca:"les visites i la cura dels fills", fr:"les visites et le soin des enfants" },
      mood:         { es:"regular la emoción y tomar un paso pequeño", en:"regulate the emotion and take a small step", pt:"regular a emoção e dar um pequeno passo", it:"regolare l’emozione e fare un piccolo passo", de:"Gefühle regulieren und einen kleinen Schritt machen", ca:"regular l’emoció i fer un petit pas", fr:"réguler l’émotion et faire un petit pas" }
    }[topic] || { es:"el tema", en:"the topic", pt:"o tema", it:"il tema", de:"das Thema", ca:"el tema", fr:"le sujet" };

    const SYSTEM_PROMPT = `
Hablas con serenidad, claridad y compasión. Evita metáforas largas; sé **concreto y clínico** en lenguaje simple.
MODO ACTUAL: ${MODE}; RECENCY: ${recency}
SALIDA SOLO JSON (en ${langLabel(lang)}):
- "message": ≤75 palabras, **sin signos de pregunta**.
  * explore: 1–2 validaciones concretas + **1 micro-acción útil** (no solo respiración) + 1 línea espiritual breve (sin cita).
  * permiso: 1–2 rumbos claros (p.ej., “armamos un **guion** sobre ${TOPIC_HINT.es||TOPIC_HINT}” / “**regular** bronca y definir **límites**”); 1 línea espiritual.
  * bye: despedida breve y bendición, sin pregunta.
- "bible": texto + ref (evita repeticiones y Mateo/Matt 11:28).
- "question": **UNA** (termina en "?").
  * explore → pregunta focal concreta (qué ocurrió / impacto / desde cuándo) **sin** A/B ni dobles ni “divide el problema”.
  * permiso → **pregunta de permiso** específica (“¿Querés que te dé un **guion** listo para usar?”).
  * bye → sin pregunta.
- "techniques": etiquetas (ej.: ["time_out_24h","no_escalar","guion_dialogo_pareja","message_en_yo","oars_escucha","behavioral_activation","opposite_action","cognitive_reframe","walk_10min","hydrate","prayer_short","limites_asertivos","apoyo_red_social"]).
- "q_style": etiqueta del estilo de pregunta.

Prioriza **autoayuda concreta**. Evita repetir técnicas recientes: ${avoidTech.join(", ")||"(ninguna)"}.
Evita repetir estilos de pregunta recientes: ${avoidQStyle.join(", ")||"(ninguno)"}.
Prohibido hobbies/planes/tiempo libre.
No menciones IA/modelos.`;

    const header =
      `Persona: ${persona}\n`+
      `Lang: ${lang}\n`+
      `Mensaje_usuario: ${userTxt}\n`+
      (shortHistory.length?`Historial: ${shortHistory.join(" | ")}`:"Historial: (sin antecedentes)")+"\n"+
      `Evitar_refs: ${[...avoidRefs, ...BANNED_REFS].join(" | ")||"(ninguna)"}\n`+
      `Evitar_preguntas: ${avoidQs.join(" | ")||"(ninguna)"}\n`+
      `Evitar_tecnicas: ${avoidTech.join(" | ")||"(ninguna)"}\n`+
      `Evitar_q_styles: ${avoidQStyle.join(" | ")||"(ninguno)"}\n`+
      `FRAME: ${JSON.stringify(mem.frame)}\n`;

    let r = await completionJson({
      messages:[{role:"system",content:SYSTEM_PROMPT},{role:"user",content:header}],
      temperature:0.6, max_tokens:360, response_format: FORMAT_ASK
    });

    const content = r?.choices?.[0]?.message?.content || "{}";
    let data={}; try{ data=JSON.parse(content);}catch{ data={}; }

    let msg = clampWords(stripEndQs(removeBibleLike(String(data?.message||""))), 75);
    let ref = cleanRef(String(data?.bible?.ref||""));
    let text = String(data?.bible?.text||"").trim();
    let q_raw = String(data?.question||"").trim();
    let techniques = Array.isArray(data?.techniques)? data.techniques.map(String) : [];
    let q_style = String(data?.q_style||"").trim();

    // Ajustar pregunta
    let question = isBye ? "" : sanitizeSingleQuestion(q_raw, lang, recency, avoidQs);

    // Biblia segura
    const avoidSet = new Set((mem.last_bible_refs||[]).map(x=>NORM(cleanRef(x))));
    if (!ref || avoidSet.has(NORM(ref)) || isRefMat11_28(ref)){
      const alt = await regenBibleAvoiding({ lang, persona, message:userTxt, frame:mem.frame, bannedRefs:[...avoidRefs,...BANNED_REFS], lastRef: avoidRefs.slice(-1)[0]||"" });
      if (alt){ ref=alt.ref; text=alt.text; }
    }
    if (!ref || isRefMat11_28(ref)) {
      ref = (lang==="en"?"Psalm 34:18":"Salmos 34:18");
      text = (lang==="en"?"The Lord is close to the brokenhearted and saves those who are crushed in spirit.":"Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu.");
    }

    // Persistencia
    if (ref){ mem.last_bible_refs=[...avoidRefs, ref].slice(-8); }
    if (!isBye && question){ mem.last_questions=[...avoidQs, question].slice(-10); }
    if (Array.isArray(techniques)&&techniques.length){ mem.last_techniques=[...avoidTech, ...techniques].slice(-12); }
    if (q_style){ mem.last_q_styles=[...avoidQStyle, q_style].slice(-10); }
    mem.last_user_reply = userTxt; mem.last_ts = Date.now();

    await writeUserMemory(userId, mem);

    const out = { message: msg || (lang==="en"?"I am with you. Let’s take one small, practical step.":"Estoy contigo. Demos un paso pequeño y práctico."), bible:{ text: text, ref: ref } };
    if (!isBye && question) out.question = question;
    res.status(200).json(out);

  }catch(err){
    res.status(200).json({
      message:"La paz sea contigo. Contame en pocas palabras lo esencial y seguimos paso a paso.",
      bible:{ text:"Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu.", ref:"Salmos 34:18" }
    });
  }
});

/* ----------------------- HeyGen bridge ----------------------- */
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

/* ----------------------- Arranque ----------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log(`Servidor listo en puerto ${PORT}`));
