// index.js — Bienvenida espiritual corta + pregunta servicial (sin "quieres/te gustaría"),
// /ask con estilo de pregunta SERVICIAL por defecto u OFERTA solo si el usuario pide guía explícita,
// límite ≤75 palabras, sin cita en "message", antirepetición de citas y preguntas, memoria en FS.
// Env: OPENAI_API_KEY, HEYGEN_API_KEY (opc), HEYGEN_DEFAULT_AVATAR (opc),
// HEYGEN_VOICE_ID (opc), HEYGEN_AVATAR_ES/EN/PT/IT/DE/CA/FR (opc)

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

// Vocativos y bendiciones espirituales (ligeramente aleatorios)
function pickVocative(lang="es", gender="unknown"){
  const rnd = (arr)=>arr[Math.floor(Math.random()*arr.length)];
  const ES_neutral = ["alma amada","hija del Altísimo","alma querida","amado del Señor","corazón buscador"];
  const ES_f = ["hija mía","alma amada","hija querida","amiga del Señor","corazón valiente"];
  const ES_m = ["hijo mío","alma amada","hijo querido","amigo del Señor","corazón valiente"];
  if(lang==="en"){
    const NEU = ["beloved soul","dear child of the Most High","dear heart","beloved one","seeker of light"];
    return rnd(NEU);
  }
  if(lang==="pt"){
    const NEU = ["alma amada","filho/filha do Altíssimo","coração querido","ser amado","buscador de luz"];
    return rnd(NEU);
  }
  if(lang==="it"){
    const NEU = ["anima amata","figlia/figlio dell’Altissimo","caro cuore","persona amata","cercatore di luce"];
    return rnd(NEU);
  }
  if(lang==="de"){
    const NEU = ["geliebte Seele","Kind des Höchsten","liebes Herz","Geliebte/r","Sucher des Lichts"];
    return rnd(NEU);
  }
  if(lang==="ca"){
    const NEU = ["ànima estimada","fill/a de l’Altíssim","cor estimat","ésser estimat","cercador/a de llum"];
    return rnd(NEU);
  }
  if(lang==="fr"){
    const NEU = ["âme bien-aimée","enfant du Très-Haut","cher cœur","être bien-aimé","chercheur de lumière"];
    return rnd(NEU);
  }
  if(gender==="female") return rnd(ES_f);
  if(gender==="male")   return rnd(ES_m);
  return rnd(ES_neutral);
}

function pickBlessing(lang="es"){
  const rnd = (arr)=>arr[Math.floor(Math.random()*arr.length)];
  const ES = [
    "que la paz del Señor esté siempre contigo",
    "que el amor de Dios te sostenga",
    "que el Espíritu te fortalezca en lo profundo",
    "que Cristo ilumine tus pasos"
  ];
  const EN = [
    "may the peace of the Lord be with you",
    "may God’s love sustain you",
    "may the Spirit strengthen you within",
    "may Christ light your steps"
  ];
  const PT = ["que a paz do Senhor esteja contigo","que o amor de Deus te sustente","que o Espírito te fortaleça","que Cristo ilumine teus passos"];
  const IT = ["che la pace del Signore sia con te","che l’amore di Dio ti sorregga","che lo Spirito ti fortifichi","che Cristo illumini i tuoi passi"];
  const DE = ["möge der Friede des Herrn mit dir sein","möge Gottes Liebe dich tragen","möge der Geist dich stärken","möge Christus deine Schritte erleuchten"];
  const CA = ["que la pau del Senyor sigui amb tu","que l’amor de Déu et sostingui","que l’Esperit t’enforteixi","que Crist il·lumini els teus passos"];
  const FR = ["que la paix du Seigneur soit avec toi","que l’amour de Dieu te soutienne","que l’Esprit te fortifie","que le Christ éclaire tes pas"];
  switch(lang){
    case "en": return rnd(EN);
    case "pt": return rnd(PT);
    case "it": return rnd(IT);
    case "de": return rnd(DE);
    case "ca": return rnd(CA);
    case "fr": return rnd(FR);
    default:   return rnd(ES);
  }
}

// Limpia cita metida en "message"
function removeBibleLike(text=""){
  let s=String(text||"");
  s=s.replace(/^[\s]*[—-]\s*.*?\([^)]+?\d+\s*:\s*\d+\)[\s]*$/gim,"").trim();
  s=s.replace(/\(([^)]+?\d+\s*:\s*\d+)\)/g,()=> "");
  s=s.replace(/\s*[—-]\s*[^()]*\(\s*[^)]+?\d+\s*:\s*\d+\s*\)\s*$/g,"").trim();
  return s.replace(/[ \t]+\n/g,"\n").replace(/\n{3,}/g,"\n\n").trim();
}

// ---------- Memoria en FS ----------
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname,"data");
async function ensureDataDir(){ try{ await fs.mkdir(DATA_DIR,{recursive:true}); }catch{} }
function memPath(uid){ const safe=String(uid||"anon").replace(/[^a-z0-9_-]/gi,"_"); return path.join(DATA_DIR,`mem_${safe}.json`); }
async function readUserMemory(userId){
  await ensureDataDir();
  try{
    const raw = await fs.readFile(memPath(userId),"utf8");
    return JSON.parse(raw);
  }catch{
    return { last_bible_refs:[], last_questions:[], frame:null };
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
  if (/(ansied|p[áa]nico|depres|triste|miedo|temor|estr[eé]s)/.test(t)) return "mood";
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

// ---------- Pool de citas (fallback) ----------
function versePoolByTopic(lang="es"){
  const ES = {
    mood: [
      { ref:"Isaías 41:10", text:"No temas, porque yo estoy contigo; no desmayes, porque yo soy tu Dios que te esfuerzo." },
      { ref:"Filipenses 4:6-7", text:"Por nada estéis afanosos... y la paz de Dios... guardará vuestros corazones." },
      { ref:"Salmos 55:22", text:"Echa sobre Jehová tu carga, y él te sustentará." }
    ],
    grief: [
      { ref:"Salmos 34:18", text:"Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu." },
      { ref:"Mateo 5:4", text:"Bienaventurados los que lloran, porque ellos recibirán consolación." },
      { ref:"Apocalipsis 21:4", text:"Enjugará Dios toda lágrima de los ojos de ellos." }
    ],
    relationship: [
      { ref:"1 Corintios 13:4-7", text:"El amor es sufrido, es benigno... todo lo sufre, todo lo cree, todo lo espera." },
      { ref:"Efesios 4:32", text:"Sed benignos unos con otros, misericordiosos, perdonándoos unos a otros." },
      { ref:"Romanos 12:18", text:"Si es posible, en cuanto dependa de vosotros, estad en paz con todos." }
    ],
    work_finance: [
      { ref:"Mateo 6:34", text:"No os afanéis por el día de mañana; porque el día de mañana traerá su afán." },
      { ref:"Proverbios 16:3", text:"Encomienda a Jehová tus obras, y tus pensamientos serán afirmados." },
      { ref:"Filipenses 4:19", text:"Mi Dios, pues, suplirá todo lo que os falta..." }
    ],
    health: [
      { ref:"Salmos 103:2-3", text:"Él es quien sana todas tus dolencias." },
      { ref:"Jeremías 30:17", text:"Porque yo haré venir sanidad para ti, y te sanaré de tus heridas." },
      { ref:"3 Juan 1:2", text:"Ruego que seas prosperado en todas las cosas, y que tengas salud." }
    ],
    faith: [
      { ref:"Proverbios 3:5-6", text:"Fíate de Jehová de todo tu corazón... y él enderezará tus veredas." },
      { ref:"Hebreos 11:1", text:"La fe es la certeza de lo que se espera, la convicción de lo que no se ve." },
      { ref:"Juan 14:27", text:"La paz os dejo, mi paz os doy; no se turbe vuestro corazón, ni tenga miedo." }
    ],
    separation: [
      { ref:"Salmos 147:3", text:"Él sana a los quebrantados de corazón, y venda sus heridas." },
      { ref:"Isaías 43:2", text:"Cuando pases por las aguas, yo estaré contigo." },
      { ref:"Romanos 8:28", text:"A los que aman a Dios, todas las cosas les ayudan a bien." }
    ],
    addiction: [
      { ref:"1 Corintios 10:13", text:"Fiel es Dios, que no os dejará ser tentados más de lo que podéis resistir." },
      { ref:"Gálatas 5:1", text:"Estad, pues, firmes en la libertad con que Cristo nos hizo libres." },
      { ref:"Salmos 40:1-2", text:"Me hizo sacar del pozo de la desesperación, del lodo cenagoso." }
    ],
    family_conflict: [
      { ref:"Santiago 1:19", text:"Todo hombre sea pronto para oír, tardo para hablar, tardo para airarse." },
      { ref:"Colosenses 3:13", text:"Soportándoos unos a otros, y perdonándoos unos a otros." },
      { ref:"Romanos 12:10", text:"Amaos los unos a los otros con amor fraternal." }
    ],
    general: [
      { ref:"Salmos 23:1", text:"Jehová es mi pastor; nada me faltará." },
      { ref:"1 Pedro 5:7", text:"Echando toda vuestra ansiedad sobre él, porque él tiene cuidado de vosotros." },
      { ref:"Isaías 40:31", text:"Los que esperan a Jehová tendrán nuevas fuerzas." }
    ]
  };
  const EN = {
    mood: [
      { ref:"Isaiah 41:10", text:"Do not fear, for I am with you..." },
      { ref:"Philippians 4:6-7", text:"Do not be anxious about anything..." },
      { ref:"Psalm 55:22", text:"Cast your cares on the Lord..." }
    ],
    grief: [
      { ref:"Psalm 34:18", text:"The Lord is close to the brokenhearted..." },
      { ref:"Matthew 5:4", text:"Blessed are those who mourn..." },
      { ref:"Revelation 21:4", text:"He will wipe every tear..." }
    ],
    relationship: [
      { ref:"1 Corinthians 13:4-7", text:"Love is patient, love is kind..." },
      { ref:"Ephesians 4:32", text:"Be kind and compassionate..." },
      { ref:"Romans 12:18", text:"As far as it depends on you, live at peace..." }
    ],
    work_finance: [
      { ref:"Matthew 6:34", text:"Do not worry about tomorrow..." },
      { ref:"Proverbs 16:3", text:"Commit to the Lord whatever you do..." },
      { ref:"Philippians 4:19", text:"My God will meet all your needs..." }
    ],
    health: [
      { ref:"Psalm 103:2-3", text:"He heals all your diseases." },
      { ref:"Jeremiah 30:17", text:"I will restore you to health..." },
      { ref:"3 John 1:2", text:"I pray that you may enjoy good health." }
    ],
    faith: [
      { ref:"Proverbs 3:5-6", text:"Trust in the Lord with all your heart..." },
      { ref:"Hebrews 11:1", text:"Faith is confidence in what we hope for..." },
      { ref:"John 14:27", text:"Peace I leave with you..." }
    ],
    separation: [
      { ref:"Psalm 147:3", text:"He heals the brokenhearted..." },
      { ref:"Isaiah 43:2", text:"When you pass through the waters..." },
      { ref:"Romans 8:28", text:"God works for the good..." }
    ],
    addiction: [
      { ref:"1 Corinthians 10:13", text:"God is faithful; he will not let you be tempted..." },
      { ref:"Galatians 5:1", text:"It is for freedom that Christ has set us free." },
      { ref:"Psalm 40:1-2", text:"He lifted me out of the slimy pit..." }
    ],
    family_conflict: [
      { ref:"James 1:19", text:"Quick to listen, slow to speak..." },
      { ref:"Colossians 3:13", text:"Bear with and forgive each other." },
      { ref:"Romans 12:10", text:"Be devoted to one another in love." }
    ],
    general: [
      { ref:"Psalm 23:1", text:"The Lord is my shepherd..." },
      { ref:"1 Peter 5:7", text:"Cast all your anxiety on him..." },
      { ref:"Isaiah 40:31", text:"Those who hope in the Lord..." }
    ]
  };
  return (lang==="en"?EN:ES);
}
function pickAltVerse(lang="es", topic="general", avoid=[]){
  const pool=versePoolByTopic(lang);
  const list=pool[topic]||pool.general||[];
  const avoidSet=new Set(avoid.map(r=>NORM(cleanRef(r))));
  for(const v of list){ if(!avoidSet.has(NORM(cleanRef(v.ref)))) return v; }
  if(topic!=="general"){
    for(const v of pool.general){ if(!avoidSet.has(NORM(cleanRef(v.ref)))) return v; }
  }
  return list[0]||pool.general[0]||{ref:(lang==="en"?"Psalm 34:18":"Salmos 34:18"), text:(lang==="en"?"The Lord is close to the brokenhearted.":"Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu.")};
}

// ---------- Detección de estilo de pregunta ----------
const OFFER_TOKENS = {
  es: [/ens[eé]ñame/,/mu[eé]strame/,/ay[uú]dame a/,/c[oó]mo hago/,/c[oó]mo puedo/,/dame pasos/,/expl[ií]came/,/gu[ií]ame/],
  en: [/teach me/,/show me/,/help me (to )?/,/how do i/,/how can i/,/give me steps/,/explain/i, /guide me/],
  pt: [/ensina(-me)?/,/mostra(-me)?/,/ajuda(-me)? a/,/como faço/,/como posso/,/d[aê](-me)? passos/,/explica(-me)?/,/guia(-me)?/],
  it: [/insegnami/,/mostrami/,/aiutami a/,/come faccio/,/come posso/,/dammi i passi/,/spiegami/,/guidami/],
  de: [/bring mir bei/,/zeig(e)? mir/,/hilf mir (zu )?/,/wie mache ich/,/wie kann ich/,/gib mir schritte/,/erkl[aä]r(e)? mir/,/f[uü]hre mich/],
  ca: [/ensenya(-m|’m)/,/mostra(-m|’m)/,/ajuda(-m|’m) a/,/com ho faig/,/com puc/,/dona’m passos/,/explica(-m|’m)/,/guia(-m|’m)/],
  fr: [/apprends-moi/,/montre-moi/,/aide-moi (à )?/,/comment (je )?fais/,/comment (je )?peux/,/donne(-| )moi des [eé]tapes/,/explique-moi/,/guide-moi/]
};
const BANNED_OFFER_PHRASES = {
  es: [/¿\s*quieres\b/i,/¿\s*te gustaría\b/i],
  en: [/^would you like/i,/^do you want/i],
  pt: [/^você quer/i,/^gostaria/i],
  it: [/^vuoi/i,/^ti piacerebbe/i],
  de: [/^willst du/i,/^möchtest du/i],
  ca: [/^vols/i,/^t’agradaria/i],
  fr: [/^veux-tu/i,/^voudrais-tu/i]
};

function detectGuidanceCue(msg="", lang="es"){
  const toks = OFFER_TOKENS[lang] || OFFER_TOKENS.es;
  const low = msg.toLowerCase();
  return toks.some(rx => rx.test(low));
}
function isOfferLike(q="", lang="es"){
  const bans = BANNED_OFFER_PHRASES[lang] || BANNED_OFFER_PHRASES.es;
  return bans.some(rx => rx.test(q));
}

// ---------- OpenAI helper ----------
const RESPONSE_FORMAT = {
  type:"json_schema",
  json_schema:{
    name:"SpiritualGuidance",
    schema:{
      type:"object",
      properties:{
        message:{type:"string"},
        bible:{type:"object",properties:{text:{type:"string"},ref:{type:"string"}},required:["text","ref"]},
        question:{type:"string"}
      },
      required:["message","bible"],
      additionalProperties:false
    }
  }
};

async function completionJson({messages, temperature=0.6, max_tokens=240, timeoutMs=12000}){
  const call = openai.chat.completions.create({
    model:"gpt-4o",
    temperature,
    max_tokens,
    messages,
    response_format: RESPONSE_FORMAT
  });
  return await Promise.race([ call, new Promise((_,rej)=>setTimeout(()=>rej(new Error("TIMEOUT")), timeoutMs)) ]);
}

// ---------- Health ----------
app.get("/", (_req,res)=> res.json({ok:true, service:"backend", ts:Date.now()}));
app.get("/api/welcome", (_req,res)=> res.json({ok:true, hint:"POST /api/welcome { lang, name, userId, gender?, history }"}));
app.post("/api/memory/sync", (_req,res)=> res.json({ok:true}));

// ---------- WELCOME ----------
app.post("/api/welcome", async (req,res)=>{
  try{
    const { lang="es", name="", userId="anon", gender="unknown", history=[] } = req.body||{};
    const nm = String(name||"").trim();
    const hi = greetingByHour(lang);
    const voc = pickVocative(lang, gender);
    const blessing = pickBlessing(lang);

    const mem = await readUserMemory(userId);
    const avoidRefs = Array.isArray(mem.last_bible_refs)? mem.last_bible_refs.slice(-8):[];
    const avoidQs   = Array.isArray(mem.last_questions)? mem.last_questions.slice(-10):[];

    const prelude = `${hi}${nm?`, ${nm}`:""}. ${voc[0].toUpperCase()+voc.slice(1)}, ${blessing}.`;

    // En bienvenida forzamos estilo SERVICIAL y prohibimos oferta (“Would you like…”, “Quieres…”, etc.)
    const SYSTEM_PROMPT = `
Hablas con serenidad, claridad y compasión.

Salida (SOLO JSON):
- "message": empieza EXACTAMENTE con: "${prelude}"
  Luego agrega 1 frase alentadora para el día (autoayuda + toque espiritual). Sin signos de pregunta.
  Máximo 75 palabras totales. **No incluyas citas bíblicas ni referencias** en "message".
- "bible": una cita breve y pertinente (texto + ref) de esperanza.
- "question": **UNA** pregunta breve, servicial y personal (6–14 palabras) que invite a compartir.
  Debe sonar a “¿En qué puedo apoyarte hoy?”, “¿Qué te aqueja?”, “¿Qué te gustaría comprender mejor?”,
  pero **sin** usar fórmulas de oferta (p.ej., no empieces con “¿Quieres…?” ni “¿Te gustaría…?”).
  Evita repeticiones recientes.

Evita usar estas referencias bíblicas exactas: ${avoidRefs.map(r=>`"${r}"`).join(", ") || "(ninguna)"}.
Evita estas preguntas recientes: ${avoidQs.map(q=>`"${q}"`).join(", ") || "(ninguna)"}.

Responde SIEMPRE en ${langLabel(lang)}.
`;

    const shortHistory = compactHistory(history,6,200);
    const header =
      `Lang: ${lang}\n`+
      `Nombre: ${nm||"(anónimo)"}\n`+
      `Prelude: ${prelude}\n`+
      (shortHistory.length?`Historial: ${shortHistory.join(" | ")}`:"Historial: (sin antecedentes)")+"\n";

    const r = await completionJson({
      messages: [
        { role:"system", content: SYSTEM_PROMPT },
        { role:"user", content: header }
      ],
      temperature: 0.7,
      max_tokens: 240
    });

    const content = r?.choices?.[0]?.message?.content || "{}";
    let data={}; try{ data=JSON.parse(content);}catch{ data={}; }

    let msg = limitWords(stripQuestionsFromMessage(removeBibleLike(String(data?.message||""))), 75);
    if (!msg.startsWith(prelude)) msg = `${prelude} ${msg}`.trim();

    let ref = cleanRef(String(data?.bible?.ref||""));
    let text = String(data?.bible?.text||"").trim();
    let question = String(data?.question||"").trim();
    if (question && !/\?\s*$/.test(question)) question += "?";

    // Antirepetición cita
    const avoidRefSet = new Set(avoidRefs.map(x=>NORM(cleanRef(x))));
    if (!ref || avoidRefSet.has(NORM(cleanRef(ref)))){
      const alt = pickAltVerse(lang, "general", avoidRefs);
      ref = alt.ref; text = alt.text;
    }

    // Validación de estilo de pregunta: debe ser SERVICIAL (no oferta)
    if (isOfferLike(question, lang)) {
      // Fallback servicial por idioma (anti-repetición con memoria)
      const SERVICIAL = {
        es: [
          "¿Qué situación concreta quisieras que miremos hoy?",
          "¿Qué te inquieta y te gustaría poner en palabras?",
          "¿En qué aspecto te vendría bien apoyo ahora?",
          "¿Qué parte de esto pesa más para ti hoy?",
          "¿Qué te gustaría comprender mejor de lo que estás viviendo?"
        ],
        en: [
          "What specific situation would you like to look at today?",
          "What’s weighing on you that needs words now?",
          "Where would support be most helpful right now?",
          "Which part of this feels heaviest today?",
          "What would you like to understand better about this moment?"
        ],
        pt: [
          "Que situação concreta você gostaria de olharmos hoje?",
          "O que te inquieta e precisa de palavras agora?",
          "Em que aspecto o apoio seria mais útil agora?",
          "Qual parte disso pesa mais hoje para você?",
          "O que você gostaria de compreender melhor neste momento?"
        ],
        it: [
          "Quale situazione concreta desideri guardare oggi?",
          "Cosa ti inquieta e ha bisogno di parole ora?",
          "In quale aspetto un sostegno sarebbe più utile adesso?",
          "Quale parte di questo pesa di più oggi?",
          "Che cosa vorresti comprendere meglio di questo momento?"
        ],
        de: [
          "Welche konkrete Situation möchtest du heute anschauen?",
          "Was belastet dich und braucht Worte gerade jetzt?",
          "Wobei wäre Unterstützung jetzt am hilfreichsten?",
          "Welcher Teil davon wiegt heute am schwersten?",
          "Was möchtest du an diesem Moment besser verstehen?"
        ],
        ca: [
          "Quina situació concreta t’agradaria mirar avui?",
          "Què t’inquieta i necessita paraules ara?",
          "En quin aspecte t’aniria bé suport ara?",
          "Quina part d’això pesa més avui?",
          "Què t’agradaria comprendre millor d’aquest moment?"
        ],
        fr: [
          "Quelle situation précise souhaites-tu regarder aujourd’hui ?",
          "Qu’est-ce qui t’inquiète et a besoin de mots maintenant ?",
          "Dans quel aspect un soutien t’aiderait le plus maintenant ?",
          "Quelle part de tout cela pèse le plus aujourd’hui ?",
          "Que voudrais-tu mieux comprendre de ce moment ?"
        ]
      };
      const pool = SERVICIAL[lang] || SERVICIAL.es;
      const banned = new Set((mem.last_questions||[]).map(NORM));
      const cand = pool.find(q=>!banned.has(NORM(q))) || pool[0];
      question = cand.endsWith("?")?cand:`${cand}?`;
    }

    // Persistir memoria: refs y preguntas
    const cleanedRef = cleanRef(ref);
    if (cleanedRef){
      const arr = Array.isArray(mem.last_bible_refs)? mem.last_bible_refs : [];
      arr.push(cleanedRef); while(arr.length>8) arr.shift();
      mem.last_bible_refs = arr;
    }
    if (question){
      const qs = Array.isArray(mem.last_questions)? mem.last_questions : [];
      qs.push(question); while(qs.length>10) qs.shift();
      mem.last_questions = qs;
    }
    await writeUserMemory(userId, mem);

    res.status(200).json({
      message: msg || `${prelude} Comparte en pocas palabras y damos un paso sencillo.`,
      bible: {
        text: text || (lang==="en"?"The Lord is close to the brokenhearted.":"Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu."),
        ref: cleanedRef || (lang==="en"?"Psalm 34:18":"Salmos 34:18")
      },
      question
    });
  }catch(e){
    console.error("WELCOME ERROR:", e);
    const hi = greetingByHour("es");
    res.status(200).json({
      message: `${hi}. Alma amada, que la paz del Señor esté siempre contigo. Cuéntame en pocas palabras qué te trae hoy.`,
      bible:{ text:"Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu.", ref:"Salmos 34:18" },
      question: "¿Qué situación concreta quisieras que miremos hoy?"
    });
  }
});

// ---------- ASK (≤75 palabras; estilo de pregunta dependiendo del mensaje) ----------
app.post("/api/ask", async (req,res)=>{
  try{
    const { persona="jesus", message="", history=[], userId="anon", lang="es" } = req.body||{};
    const mem = await readUserMemory(userId);

    const topic = guessTopic(message);
    const mainSubject = detectMainSubject(message);
    const frame = {
      topic_primary: topic,
      main_subject: mem.frame?.topic_primary===topic ? (mem.frame?.main_subject||mainSubject) : mainSubject,
      support_persons: mem.frame?.topic_primary===topic ? (mem.frame?.support_persons||[]) : [],
    };
    mem.frame = frame;

    const avoidRefs = Array.isArray(mem.last_bible_refs)? mem.last_bible_refs.slice(-8):[];
    const avoidQs   = Array.isArray(mem.last_questions)? mem.last_questions.slice(-10):[];
    const allowOffer = detectGuidanceCue(message, lang);

    // Instrucciones de estilo:
    // - message: ≤75 palabras, sin "?" y sin citas.
    // - question:
    //   * si allowOffer=true -> puede ser oferta (pero variada y no repetitiva)
    //   * si allowOffer=false -> SERVICIAL (prohibido empezar con "¿Quieres... / Would you like... / ...")
    const SYSTEM_PROMPT = `
Hablas con serenidad, claridad y compasión.
Salida SOLO JSON.

"message": máximo 75 palabras, sin signos de pregunta. Primero autoayuda breve (2–3 frases) con 1–2 micro-pasos; luego un toque espiritual cristiano. **No incluyas citas bíblicas ni referencias en "message"**.
"bible": cita pertinente que apoye el micro-paso (texto + ref).
"question": **UNA** pregunta breve que avance el caso (termina en "?").
- Si el usuario pide guía explícita, puedes usar una pregunta-oferta (enseñar, orar, dar pasos), variando el tono y evitando repeticiones recientes.
- Si NO hay petición explícita, usa una pregunta servicial/personal (por ej. precisar situación, sentir, obstáculo), **sin** fórmulas de oferta como "¿Quieres... / ¿Te gustaría... / Would you like...".

Evita estas referencias bíblicas exactas: ${avoidRefs.map(r=>`"${r}"`).join(", ")||"(ninguna)"}.
Evita estas preguntas recientes: ${avoidQs.map(q=>`"${q}"`).join(", ")||"(ninguna)"}.

Responde SIEMPRE en ${langLabel(lang)}.
`;

    const shortHistory = compactHistory(history,10,240);
    const header =
      `Persona: ${persona}\n`+
      `Lang: ${lang}\n`+
      `Mensaje_actual: ${message}\n`+
      `ALLOW_OFFER: ${allowOffer}\n`+
      `FRAME: ${JSON.stringify(frame)}\n`+
      (shortHistory.length?`Historial: ${shortHistory.join(" | ")}`:"Historial: (sin antecedentes)")+"\n";

    const r = await completionJson({
      messages: [{role:"system",content:SYSTEM_PROMPT},{role:"user",content:header}],
      temperature:0.65,
      max_tokens:260
    });

    const content = r?.choices?.[0]?.message?.content || "{}";
    let data={}; try{ data=JSON.parse(content);}catch{ data={}; }

    let msg = limitWords(stripQuestionsFromMessage(removeBibleLike(String(data?.message||""))), 75);
    let ref = cleanRef(String(data?.bible?.ref||""));
    let text = String(data?.bible?.text||"").trim();
    let question = String(data?.question||"").trim();
    if (question && !/\?\s*$/.test(question)) question+="?";

    // Antirepetición cita
    const avoidSet = new Set(avoidRefs.map(x=>NORM(cleanRef(x))));
    if (!ref || avoidSet.has(NORM(cleanRef(ref)))){
      const alt = pickAltVerse(lang, topic, avoidRefs);
      ref = alt.ref; text = alt.text;
    }

    // Validar estilo de pregunta acorde a allowOffer
    if (!allowOffer && isOfferLike(question, lang)) {
      // reemplazar por servicial
      const SERVICIAL = {
        es: [
          "¿Qué parte de esto te gustaría aclarar primero?",
          "¿Qué situación concreta quisieras que miremos ahora?",
          "¿Dónde sientes que necesitas más apoyo hoy?",
          "¿Qué te inquieta más y quieres poner en palabras?",
          "¿Qué paso pequeño te sería amable intentar hoy?"
        ],
        en: [
          "Which part of this would you like to clarify first?",
          "What specific situation shall we look at now?",
          "Where do you feel you need more support today?",
          "What weighs on you most and needs words?",
          "What small step would be kind to try today?"
        ],
        pt: [
          "Que parte disso você gostaria de esclarecer primeiro?",
          "Que situação concreta vamos olhar agora?",
          "Em que sente que precisa de mais apoio hoje?",
          "O que mais te pesa e precisa de palavras?",
          "Que passo pequeno seria gentil tentar hoje?"
        ],
        it: [
          "Quale parte desideri chiarire per prima?",
          "Quale situazione concreta guardiamo adesso?",
          "Dove senti di aver più bisogno di sostegno oggi?",
          "Cosa pesa di più e ha bisogno di parole?",
          "Quale passo piccolo sarebbe gentile provare oggi?"
        ],
        de: [
          "Welchen Teil möchtest du zuerst klären?",
          "Welche konkrete Situation schauen wir uns jetzt an?",
          "Wobei brauchst du heute mehr Unterstützung?",
          "Was belastet dich am meisten und braucht Worte?",
          "Welcher kleine Schritt wäre heute gut auszuprobieren?"
        ],
        ca: [
          "Quina part d’això vols aclarir primer?",
          "Quina situació concreta mirem ara?",
          "On sents que necessites més suport avui?",
          "Què et pesa més i necessita paraules?",
          "Quin petit pas seria amable provar avui?"
        ],
        fr: [
          "Quelle partie souhaites-tu clarifier en premier ?",
          "Quelle situation précise regardons-nous maintenant ?",
          "Où sens-tu que tu as besoin de plus de soutien aujourd’hui ?",
          "Qu’est-ce qui pèse le plus et a besoin de mots ?",
          "Quel petit pas serait bon à essayer aujourd’hui ?"
        ]
      };
      const pool = SERVICIAL[lang] || SERVICIAL.es;
      const banned = new Set((mem.last_questions||[]).map(NORM));
      const cand = pool.find(q=>!banned.has(NORM(q))) || pool[0];
      question = cand.endsWith("?")?cand:`${cand}?`;
    }

    // Guarda memoria
    const cleanedRef = cleanRef(ref);
    if (cleanedRef){
      const arr = Array.isArray(mem.last_bible_refs)? mem.last_bible_refs : [];
      arr.push(cleanedRef); while(arr.length>8) arr.shift();
      mem.last_bible_refs = arr;
    }
    if (question){
      const qs = Array.isArray(mem.last_questions)? mem.last_questions : [];
      qs.push(question); while(qs.length>10) qs.shift();
      mem.last_questions = qs;
    }
    await writeUserMemory(userId, mem);

    res.status(200).json({
      message: msg || (lang==="en"?"I am with you. Let’s take one small and practical step.":"Estoy contigo. Demos un paso pequeño y práctico."),
      bible: { text: text || (lang==="en"?"The Lord is close to the brokenhearted.":"Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu."), ref: cleanedRef || (lang==="en"?"Psalm 34:18":"Salmos 34:18") },
      ...(question?{question}:{})
    });
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
