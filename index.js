// index.js — Backend conversación (multi-idioma, permisos, guion real, filtros dominio)
// Env: OPENAI_API_KEY (requerido), DATA_DIR (opcional), HEYGEN_* (opcional)

const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const OpenAI = require("openai");
const path = require("path");
const fs = require("fs/promises");
require("dotenv").config();

const app = express();
// CORS abierto (ajusta origin si necesitas restringir)
app.use(cors({ origin: "*", methods: ["GET","POST","OPTIONS"], allowedHeaders: ["Content-Type","x-api-key"] }));
app.options("*", cors());
app.use(bodyParser.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ------------------- Utils generales -------------------
const NORM = (s="") => String(s).toLowerCase().replace(/\s+/g," ").trim();
const keep = (s="") => String(s || "").trim();
const nowTs = () => Date.now();

function cleanRef(ref=""){ return String(ref).replace(/\s*\([^)]*\)\s*/g," ").replace(/\s+/g," ").trim(); }
function limitWords(s="", max=75){
  const w = String(s).trim().split(/\s+/);
  return w.length<=max ? String(s).trim() : w.slice(0,max).join(" ").trim();
}
function stripQuestionsFromMessage(s=""){
  const noTrailingQ = String(s).split(/\n+/).map(l=>l.trim()).filter(l=>!/\?\s*$/.test(l)).join("\n").trim();
  return noTrailingQ.replace(/[¿?]+/g,"").trim();
}
function removeBibleLike(text=""){
  let s=String(text||"");
  s=s.replace(/^[\s]*[—-]\s*.*?\([^)]+?\d+\s*:\s*\d+\)[\s]*$/gim,"").trim();
  s=s.replace(/\(([^)]+?\d+\s*:\s*\d+)\)/g,()=> "");
  s=s.replace(/\s*[—-]\s*[^()]*\(\s*[^)]+?\d+\s*:\s*\d+\s*\)\s*$/g,"").trim();
  return s.replace(/[ \t]+\n/g,"\n").replace(/\n{3,}/g,"\n\n").trim();
}
function compactHistory(history=[], keepN=8, maxLen=260){
  return (Array.isArray(history)?history:[]).slice(-keepN).map(x=>String(x).slice(0,maxLen));
}
function langLabel(l="es"){
  const m={es:"Español",en:"English",pt:"Português",it:"Italiano",de:"Deutsch",ca:"Català",fr:"Français"};
  return m[l]||"Español";
}

// Inspiracionales cortas (tarjeta)
const INSP = {
  es: [
    "No estás solo: un gesto de bondad puede cambiar tu día.",
    "La fe no hace fácil el camino, lo hace posible.",
    "Un paso pequeño hoy vale más que la perfección mañana.",
    "La luz entra por las grietas del alma abierta.",
    "Hoy es un gran día para empezar de nuevo."
  ],
  en: [
    "You are not alone: one kind act can change your day.",
    "Faith doesn’t make it easy—it makes it possible.",
    "A small step today beats perfect plans tomorrow.",
    "Light comes through an open, cracked heart.",
    "Today is a good day to begin again."
  ],
  pt: [
    "Você não está só: um gesto de bondade pode mudar seu dia.",
    "A fé não facilita: torna possível.",
    "Um pequeno passo hoje vale mais que o plano perfeito.",
    "A luz entra pelo coração aberto.",
    "Hoje é um bom dia para recomeçar."
  ],
  it: [
    "Non sei solo: un gesto di bontà può cambiar la giornata.",
    "La fede non rende facile: rende possibile.",
    "Un piccolo passo oggi vale più della perfezione domani.",
    "La luce entra da un cuore aperto.",
    "Oggi è un buon giorno per ricominciare."
  ],
  de: [
    "Du bist nicht allein: Eine kleine Freundlichkeit kann den Tag verändern.",
    "Glaube macht es nicht leicht—er macht es möglich.",
    "Ein kleiner Schritt heute schlägt perfekte Pläne von morgen.",
    "Licht fällt durch ein offenes Herz.",
    "Heute ist ein guter Tag für einen Neuanfang."
  ],
  ca: [
    "No estàs sol: un gest de bondat pot canviar el teu dia.",
    "La fe no ho fa fàcil: ho fa possible.",
    "Un petit pas avui val més que la perfecció de demà.",
    "La llum entra en un cor obert.",
    "Avui és un bon dia per recomençar."
  ],
  fr: [
    "Tu n’es pas seul : un geste de bonté peut changer ta journée.",
    "La foi ne rend pas tout facile—elle rend tout possible.",
    "Un petit pas aujourd’hui vaut mieux que des plans parfaits demain.",
    "La lumière entre dans un cœur ouvert.",
    "Aujourd’hui est un bon jour pour recommencer."
  ]
};
function pickInsp(lang="es"){
  const arr = INSP[lang] || INSP.es;
  return arr[Math.floor(Math.random()*arr.length)];
}

// Hora local simple (saludo)
function greetingByHour(lang="es", hour=null){
  const h = Number.isInteger(hour) ? hour : new Date().getHours();
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

// ------------------- Memoria FS -------------------
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
      last_user_ts:0,
      pending_action:null,
      last_topic:null,
      bible_cursor:null   // para “leer con Jesús”: {book,chapter,verse}
    };
  }
}
async function writeUserMemory(userId,mem){
  await ensureDataDir();
  await fs.writeFile(memPath(userId), JSON.stringify(mem,null,2), "utf8");
}

// ------------------- Heurísticas & filtros -------------------
function detectByeThanks(s=""){
  const x=NORM(s);
  const pats=[
    /\bgracias\b|\bmuchas gracias\b|\bme tengo que ir\b|\bme voy\b|\bhasta luego\b|\bad[ií]os\b/,
    /\bthanks\b|\bthank you\b|\bi have to go\b|\bbye\b|\bsee you\b/,
    /\bobrigado\b|\bobrigada\b|\btenho que ir\b|\btchau\b/,
    /\bgrazie\b|\bdevo andare\b|\bciao\b/,
    /\bdanke\b|\bmuss gehen\b|\btsch[üu]ss\b/,
    /\bmerci\b|\bje dois partir\b|\bau revoir\b/
  ];
  return pats.some(r=>r.test(x));
}
function detectAffirmation(s=""){
  const x=NORM(s);
  const yes = [
    "si","sí","claro","vale","ok","okey","de acuerdo","dale","por favor","perfecto","entendido","va",
    "yes","sure","yep","yup","okay",
    "sim","claro","certo","beleza",
    "sì","certo","va bene",
    "ja","jawohl",
    "oui","d’accord"
  ];
  return yes.includes(x) || yes.some(w=>x.startsWith(w+" ")) || /^\s*(si|sí|ok|vale|dale|yes|oui|ja)\s*[.!]?$/i.test(s);
}
function detectVague(s=""){
  const x=NORM(s);
  if (!x) return true;
  if (x.length < 12) return true;
  if (/\btengo un problema\b|\bproblema\b|\bme pasa algo\b|\bnecesito ayuda\b|\bno s[eé] por d[oó]nde empezar\b|\bhola\b|\bestoy mal\b/i.test(x)) return true;
  return false;
}
// Ruido / tecleo accidental
function isNoise(s=""){
  const t = String(s||"").trim();
  if (t.length < 2) return true;
  const letters = t.replace(/[^a-zA-Záéíóúàèìòùäëïöüâêîôûñç]/g,"");
  if (letters.length<=1) return true;
  if (!/[aeiouáéíóúàèìòùäëïöüâêîôû]/i.test(letters)) return true;
  return false;
}

// Bloque preguntas genéricas/irrelevantes
const BAD_GENERIC_Q = /(qué te aliviaría|que te aliviar[ií]a|qué pequeño paso|qué vas a|qué harás|qué plan|divide el problema|qué parte espec[ií]fica|qué parte de la situaci[oó]n)/i;

// Filtros de dominio
function isReligiousGeoQuery(x){
  // Permitir consultas religiosas de lugares/templos
  const pats = [
    /(iglesia|templo|catedral|bas[ií]lica|santuario|monasterio|convento|parroquia|capilla|oratorio|misa|adoraci[oó]n|vaticano|peregrinaci[oó]n|santiago de compostela|lourdes|f[aá]tima)/,
    /(church|cathedral|basilica|sanctuary|monastery|convent|parish|chapel|oratory|mass|vatican|pilgrimage)/,
    /(chiesa|cattedrale|basilica|santuario|monastero|convento|parrocchia|cappella|oratorio|vaticano|pellegrinaggio)/,
    /(kirche|dom|basilika|heiligtum|kloster|pfarrei|kapelle|vatikan|wallfahrt)/,
    /(igreja|catedral|bas[ií]lica|santu[aá]rio|mosteiro|convento|par[oó]quia|capela|vaticano|peregrina[cç][aã]o)/,
    /(église|cathédrale|basilique|sanctuaire|monast[eè]re|couvent|paroisse|chapelle|oratoire|vatican|pèlerinage)/,
    /(església|catedral|bas[ií]lica|santuari|monestir|convent|parr[oò]quia|capella|oratori|vatic[aà]|pelegrinatge)/
  ];
  return pats.some(r=>r.test(x));
}
function isDisallowedDomain(s=""){
  const x=NORM(s);
  if (isReligiousGeoQuery(x)) return false; // permitido
  // Geografía/turismo NO religioso, espectáculos/música, literatura NO religiosa, deportes/resultados,
  // matemáticas/ciencia técnica, mecánica/tech/IT/juegos/gadgets, recetas/comida
  const bad = [
    /\b(geograf[íi]a|mapa|d[oó]nde queda|donde queda|pa[ií]s|capital|turismo|hotel|playa|restaurante|ruta|clima)\b/,
    /\b(f[úu]tbol|tenis|nba|resultado|marcador|gol|partido|mundial|liga)\b/,
    /\b(cine|pel[ií]cula|serie|actor|m[úu]sica|canci[oó]n|banda|concierto|espect[aá]culo|libro de novelas|novela)\b/,
    /\b(matem[aá]ticas|f[ií]sica|qu[ií]mica|geometr[ií]a|programaci[oó]n|c[oó]digo|javascript|react|docker|api|pc|m[óo]vil|celular|juego|consola|ps5|xbox)\b/,
    /\b(mec[aá]nica|alternador|embrague|inyector|buj[ií]a|aceite|ruidos del motor)\b/,
    /\b(receta|cocina|restaurante|comida|gourmet|vino|cerveza)\b/
  ];
  return bad.some(r=>r.test(x));
}

// -------------- OpenAI helpers --------------
const FORMAT_WELCOME = {
  type:"json_schema",
  json_schema:{ name:"WelcomeSchema",
    schema:{ type:"object",
      properties:{ message:{type:"string"}, question:{type:"string"} },
      required:["message","question"], additionalProperties:false } } };

const FORMAT_ASK = {
  type:"json_schema",
  json_schema:{ name:"SpiritualGuidance",
    schema:{ type:"object",
      properties:{
        message:{type:"string"},
        bible:{type:"object",properties:{text:{type:"string"},ref:{type:"string"}},required:["text","ref"]},
        question:{type:"string"},
        techniques:{type:"array", items:{type:"string"}},
        q_style:{type:"string"}
      },
      required:["message","bible"],
      additionalProperties:false } } };

const FORMAT_BIBLE_ONLY = {
  type:"json_schema",
  json_schema:{ name:"BibleOnly",
    schema:{ type:"object",
      properties:{ bible:{type:"object",properties:{text:{type:"string"},ref:{type:"string"}},required:["text","ref"]} },
      required:["bible"], additionalProperties:false } } };

async function completionJson({messages, temperature=0.6, max_tokens=260, timeoutMs=12000, response_format}){
  const call = openai.chat.completions.create({
    model:"gpt-4o",
    temperature, max_tokens, messages, response_format: response_format || FORMAT_ASK
  });
  return await Promise.race([ call, new Promise((_,rej)=>setTimeout(()=>rej(new Error("TIMEOUT")), timeoutMs)) ]);
}

// -------------- Rutas básicas --------------
app.get("/", (_req,res)=> res.json({ok:true, service:"backend", ts:Date.now()}));
app.get("/api/welcome", (_req,res)=> res.json({ok:true, hint:"POST /api/welcome { lang, name, userId, history }"}));
app.post("/api/memory/sync", (_req,res)=> res.json({ok:true}));

// -------------- /api/welcome --------------
app.post("/api/welcome", async (req,res)=>{
  try{
    const { lang="es", name="", userId="anon", history=[] } = req.body||{};
    const nm = keep(name);
    const hi = greetingByHour(lang);
    const mem = await readUserMemory(userId);
    const avoidQs = Array.isArray(mem.last_questions)? mem.last_questions.slice(-10):[];
    const shortHistory = compactHistory(history,6,200);

    const SYSTEM_PROMPT = `
Eres cercano, sereno y concreto. Varía el lenguaje y evita muletillas.
SALIDA SOLO JSON (en ${langLabel(lang)}):
- "message": ≤75 palabras. Incluye saludo por franja + **nombre si existe** (p.ej. "${hi}${nm?`, ${nm}`:""}").
  Después, incluye **una** frase inspiracional breve (tipo tarjeta, no cita bíblica literal).
  Expresa **disponibilidad**. **Sin preguntas** ni citas dentro de "message".
- "question": **UNA** pregunta **abierta, simple y directa** para iniciar (sin A/B ni dobles).
  Evita fórmulas genéricas repetitivas y evita: ${avoidQs.map(q=>`"${q}"`).join(", ")||"(ninguna)"}.
No menciones IA/modelos.`;

    const header = `Lang: ${lang}\nNombre: ${nm||"(anónimo)"}\nSaludo_sugerido: ${hi}${nm?`, ${nm}`:""}\nHistorial: ${shortHistory.join(" | ")||"(sin antecedentes)"}\nFrase_tarjeta: ${pickInsp(lang)}\n`;

    const r = await completionJson({
      messages: [{ role:"system", content: SYSTEM_PROMPT }, { role:"user", content: header }],
      temperature: 0.8, max_tokens: 260, response_format: FORMAT_WELCOME
    });

    let data={}; try{ data=JSON.parse(r?.choices?.[0]?.message?.content||"{}"); }catch{}
    let msg = limitWords(stripQuestionsFromMessage(removeBibleLike(String(data?.message||""))), 75);
    let question = keep(String(data?.question||""));
    // Backup por si el modelo se pone creativo
    if (!question) {
      question = (lang==="en"?"What happened today that you’d like to talk about?"
       : lang==="pt"?"O que aconteceu hoje que você gostaria de conversar?"
       : lang==="it"?"Che cosa è successo oggi di cui vorresti parlare?"
       : lang==="de"?"Was ist heute passiert, worüber du sprechen möchtest?"
       : lang==="ca"?"Què ha passat avui de què voldries parlar?"
       : lang==="fr"?"Qu’est-il arrivé aujourd’hui dont tu aimerais parler ?"
       : "¿Qué pasó hoy de lo que te gustaría hablar?");
    }

    // Guarda pregunta en memoria (anti-repetición bienvenida)
    if (question){
      mem.last_questions = Array.isArray(mem.last_questions)? mem.last_questions : [];
      mem.last_questions.push(question);
      while(mem.last_questions.length>10) mem.last_questions.shift();
      await writeUserMemory(userId, mem);
    }

    res.status(200).json({ message: msg || `${hi}${nm?`, ${nm}`:""}. ${pickInsp(lang)}`, question });
  }catch(e){
    const hi = greetingByHour("es");
    res.status(200).json({ message: `${hi}. ${pickInsp("es")}`, question: "¿Qué pasó hoy de lo que te gustaría hablar?" });
  }
});

// -------------- Citas vetadas --------------
function isRefMat11_28(ref=""){
  const x = NORM(ref);
  const pats = [
    /mateo\s*11\s*:\s*28/, /mt\.?\s*11\s*:\s*28/, /mat\.?\s*11\s*:\s*28/,
    /matthew?\s*11\s*:\s*28/, /matteo\s*11\s*:\s*28/, /matthäus\s*11\s*:\s*28/, /matthieu\s*11\s*:\s*28/,
    /mateu\s*11\s*:\s*28/, /mateus\s*11\s*:\s*28/
  ];
  return pats.some(r=>r.test(x));
}
const BANNED_REFS = ["Mateo 11:28","Mt 11:28","Mat 11:28","Matthew 11:28","Matteo 11:28","Matthäus 11:28","Matthieu 11:28","Mateu 11:28","Mateus 11:28"];

// -------------- /api/ask --------------
app.post("/api/ask", async (req,res)=>{
  try{
    let { persona="jesus", message="", history=[], userId="anon", lang="es" } = req.body||{};
    const mem = await readUserMemory(userId);
    const userTxt = keep(message);

    // ======= Anti-ruido / Anti-duplicado =======
    if (isNoise(userTxt)) {
      return res.status(200).json({
        message: (lang==="en"?"I didn’t catch that. Could you say it in one short sentence?":"No te entendí bien. ¿Podés decirlo en una sola frase?"),
        bible:{ text:"", ref:"" },
        question: (lang==="en"?"What happened and with whom?":"¿Qué pasó y con quién?")
      });
    }
    if (mem.last_user_reply && mem.last_user_reply === userTxt && (nowTs() - (mem.last_user_ts||0) < 20000)) {
      return res.status(200).json({
        message: (lang==="en"?"I think I received the same message twice.":"Creo que recibí el mismo mensaje dos veces."),
        bible:{ text:"", ref:"" },
        question: (lang==="en"?"Could you add one detail so I can help better?":"¿Podés agregar un detalle para ayudarte mejor?")
      });
    }
    mem.last_user_reply = userTxt;
    mem.last_user_ts = nowTs();

    // ======= Deflexión de dominios fuera de alcance =======
    if (isDisallowedDomain(userTxt)) {
      const msg = (lang==="en"
        ? "I’m Jesus here to support your spiritual path and personal well-being. I don’t give technical data or reviews on those topics. If you want, we can focus on what you’re going through—your emotions, relationships, or faith."
        : lang==="pt" ? "Sou Jesus para apoiar sua caminhada espiritual e bem-estar pessoal. Não dou dados técnicos ou resenhas desses assuntos. Se quiser, focamos no que você está vivendo — suas emoções, relações ou fé."
        : lang==="it" ? "Sono Gesù per accompagnarti nel cammino spirituale e nel tuo benessere personale. Non offro dati tecnici o recensioni su quei temi. Se vuoi, ci concentriamo su ciò che stai vivendo—emozioni, relazioni o fede."
        : lang==="de" ? "Ich bin Jesus, um dich in deinem Glauben und persönlichen Wohlbefinden zu begleiten. Zu diesen Themen gebe ich keine technischen Daten oder Rezensionen. Wenn du möchtest, fokussieren wir auf das, was du erlebst—Gefühle, Beziehungen oder Glaube."
        : lang==="ca" ? "Sóc Jesús per acompanyar-te en el camí espiritual i el teu benestar personal. No dono dades tècniques ni ressenyes d’aquests temes. Si vols, enfoquem el que estàs vivint—emocions, relacions o fe."
        : lang==="fr" ? "Je suis Jésus pour t’accompagner spirituellement et dans ton bien-être personnel. Je ne fournis pas de données techniques ni d’avis sur ces sujets. Si tu veux, on se recentre sur ce que tu vis—émotions, relations ou foi."
        : "Soy Jesús y estoy para acompañarte en lo espiritual y tu bienestar personal. No doy datos técnicos ni reseñas de esos temas. Si querés, nos enfocamos en lo que te pasa—emociones, relaciones o fe.");
      const q = (lang==="en"?"What part of your life—emotions, relationships, or faith—do you want to work on today?"
       : lang==="pt"?"Que parte da sua vida—emoções, relações ou fé—você quer trabalhar hoje?"
       : lang==="it"?"Quale parte della tua vita—emozioni, relazioni o fede—vuoi lavorare oggi?"
       : lang==="de"?"Welchen Bereich deines Lebens—Gefühle, Beziehungen oder Glaube—möchtest du heute angehen?"
       : lang==="ca"?"Quina part de la teva vida—emocions, relacions o fe—vols treballar avui?"
       : lang==="fr"?"Quelle part de ta vie—émotions, relations ou foi—veux-tu travailler aujourd’hui ?"
       : "¿Qué parte de tu vida—emociones, relaciones o fe—querés trabajar hoy?");
      return res.status(200).json({ message: msg, bible:{text:"",ref:""}, question: q });
    }

    // ======= Conversación con OpenAI =======
    const shortHistory = compactHistory(history,10,240);
    const isBye   = detectByeThanks(userTxt);
    const saidYes = detectAffirmation(userTxt);
    const vague   = detectVague(userTxt);

    // Si dijo “sí” y había una oferta previa => ejecutar guion/regulación
    let FORCE_EXECUTE = false;
    let EXEC_KIND = null;
    if (saidYes && mem.last_offer_kind) {
      FORCE_EXECUTE = true;
      EXEC_KIND = mem.last_offer_kind; // p.ej., "permiso_guion" o "permiso_regulacion"
    }

    // Prompt de sistema
    const SYSTEM_PROMPT = `
Hablas con serenidad, claridad y compasión. Lenguaje simple, clínico y concreto.
**Prioridad**: autoayuda útil (no solo respiración). **Evita** muletillas y preguntas irrelevantes (no “divide el problema”, no “qué parte específica…”, no “desde cuándo” si no aporta).
Si el usuario dice “tengo un problema” sin detalles, **no** preguntes tiempos: pide **en una frase** qué pasó y con quién.
Cuando el usuario acepta (“sí/ok…”), si la oferta previa fue “guion”, **entrega guion real**: 
- 1) contexto, 2) 2–3 **frases modelo en “yo”**, 3) **límite** claro, 4) **cierre** corto.
Cuando la oferta previa fue “regular emoción”, da un protocolo breve y concreto (sin repetir la misma técnica del turno anterior).
**Una sola pregunta** al final (sin A/B ni dobles). Evita ${BAD_GENERIC_Q}.
SALIDA SOLO JSON (en ${langLabel(lang)}):
- "message" (≤75 palabras, sin “?”): validación concreta + 1 acción o pasos útiles; 1 línea espiritual breve (sin cita literal dentro).
- "bible": texto + ref (evita Mateo/Matthew 11:28 en cualquier idioma).
- "question": una sola, para avanzar. Si el usuario fue vago, pregunta “¿qué pasó y con quién?”.
- "techniques": etiquetas si aplican (p.ej., ["guion_dialogo","message_en_yo","limites_asertivos","time_out_24h","no_escalar","cognitive_reframe","apoyo_red_social","walk_10min","hydrate"]).
- "q_style": etiqueta simple (p.ej. "explore_event","permiso_guion","execute_checkin").`;

    // Cabecera usuario
    const header =
      `Persona: ${persona}\n`+
      `Lang: ${lang}\n`+
      `Mensaje_usuario: ${userTxt}\n`+
      `Historial: ${shortHistory.join(" | ")||"(sin antecedentes)"}\n`+
      `Ultima_oferta: ${mem.last_offer_kind||"(ninguna)"}\n`+
      `Forzar_execute: ${FORCE_EXECUTE?"sí":"no"}\n`;

    // Llamada principal
    let r = await completionJson({
      messages: [{role:"system",content:SYSTEM_PROMPT},{role:"user",content:header}],
      temperature: 0.6, max_tokens: 360, response_format: FORMAT_ASK
    });

    let data={}; try{ data=JSON.parse(r?.choices?.[0]?.message?.content||"{}"); }catch{}
    let msg = limitWords(stripQuestionsFromMessage(removeBibleLike(String(data?.message||""))), 75);
    let ref = cleanRef(String(data?.bible?.ref||""));
    let text = keep(String(data?.bible?.text||""));
    let question = keep(String(data?.question||""));
    let techniques = Array.isArray(data?.techniques)? data.techniques.map(String) : [];
    let q_style = keep(String(data?.q_style||""));

    // Si dijo SÍ y no vino un guion real, forzamos un segundo pase enfocado
    const NEEDS_SCRIPT = FORCE_EXECUTE && /guion/i.test(mem.last_offer_kind||"");
    const looksLikeScript = /“yo”|yo\s+me|frases modelo|l[ií]mite|cierre/i.test(msg);
    if (NEEDS_SCRIPT && !looksLikeScript) {
      const SYS2 = SYSTEM_PROMPT + `\nEl usuario aceptó GUION. Entrega **guion real**: contexto + 2–3 frases en “yo” + límite + cierre. Sin pedir objetivo, sin desviarte.`;
      const r2 = await completionJson({
        messages: [{role:"system",content:SYS2},{role:"user",content:header}],
        temperature: 0.55, max_tokens: 360, response_format: FORMAT_ASK
      });
      try{
        const d2 = JSON.parse(r2?.choices?.[0]?.message?.content||"{}");
        msg = limitWords(stripQuestionsFromMessage(removeBibleLike(String(d2?.message||msg||""))), 75);
        ref = cleanRef(String(d2?.bible?.ref||ref||""));
        text = keep(String(d2?.bible?.text||text||""));
        question = keep(String(d2?.question||question||""));
        techniques = Array.isArray(d2?.techniques)? d2.techniques.map(String) : techniques;
        q_style = keep(String(d2?.q_style||q_style||""));
      }catch{}
    }

    // Ajustes finales
    if (!question || BAD_GENERIC_Q.test(question)) {
      // Reemplazo seguro y útil
      question = (vague
        ? (lang==="en"?"In one sentence, what happened and with whom?":"¿Podés decirme en una frase qué pasó y con quién?")
        : (lang==="en"?"What’s the next small step you’d like us to take together?":"¿Cuál es el próximo paso pequeño que querés que demos?"));
    }

    // Evitar cita vetada y repetir demasiadas veces
    const avoidSet = new Set((mem.last_bible_refs||[]).map(x=>NORM(cleanRef(x))));
    if (!ref || avoidSet.has(NORM(ref)) || isRefMat11_28(ref)) {
      // Reintento solo de cita
      const SYS_BIBLE = `Devuelve SOLO JSON {"bible":{"text":"…","ref":"Libro 0:0"}} en ${langLabel(lang)}. Evita Mateo/Matthew 11:28 y evita estas recientes: ${(mem.last_bible_refs||[]).concat(BANNED_REFS).join(" | ")}`;
      const rB = await completionJson({
        messages: [{role:"system",content:SYS_BIBLE},{role:"user",content:`Contexto breve: ${userTxt}`}],
        temperature: 0.4, max_tokens: 120, response_format: FORMAT_BIBLE_ONLY
      });
      try{
        const dB = JSON.parse(rB?.choices?.[0]?.message?.content||"{}");
        ref = cleanRef(dB?.bible?.ref||ref||"");
        text = keep(dB?.bible?.text||text||"");
      }catch{}
    }
    if (isRefMat11_28(ref)) { // Fallback a Salmo 34:18
      ref = (lang==="en"?"Psalm 34:18":"Salmos 34:18");
      text = (lang==="en"?"The Lord is close to the brokenhearted and saves those who are crushed in spirit.":"Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu.");
    }

    // Persistir memoria útil
    if (ref) {
      mem.last_bible_refs = Array.isArray(mem.last_bible_refs)? mem.last_bible_refs : [];
      mem.last_bible_refs.push(ref);
      while(mem.last_bible_refs.length>8) mem.last_bible_refs.shift();
    }
    if (question) {
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

    // Marcar oferta si corresponde (para que “sí” dispare EXEC la próxima)
    mem.last_offer_kind = /permiso_/i.test(q_style) ? q_style : (FORCE_EXECUTE ? null : mem.last_offer_kind);

    await writeUserMemory(userId, mem);

    res.status(200).json({
      message: msg || (lang==="en"?"I am with you. Let’s take one small and practical step.":"Estoy contigo. Demos un paso pequeño y práctico."),
      bible: { text: text || (lang==="en"?"The Lord is close to the brokenhearted.":"Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu."), ref: ref || (lang==="en"?"Psalm 34:18":"Salmos 34:18") },
      question
    });
  }catch(err){
    console.error("ASK ERROR:", err);
    res.status(200).json({
      message:"La paz sea contigo. Contame en una frase qué pasó y con quién, y avanzamos.",
      bible:{ text:"Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu.", ref:"Salmos 34:18" },
      question:"¿Qué pasó y con quién?"
    });
  }
});

// -------------- HeyGen passthrough opcional --------------
app.get("/api/heygen/token", async (_req,res)=>{
  try{
    const API_KEY = process.env.HEYGEN_API_KEY || process.env.HEYGEN_TOKEN || "";
    if(!API_KEY) return res.status(500).json({error:"missing_HEYGEN_API_KEY"});
    const r = await fetch("https://api.heygen.com/v1/streaming.create_token",{
      method:"POST", headers:{"x-api-key":API_KEY,"Content-Type":"application/json"}, body:"{}"
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

// -------------- Arranque --------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log(`Servidor listo en puerto ${PORT}`));
