// index.js — Diálogo servicial con bienvenida íntima (multi-idioma), ≤75 palabras,
// preguntas personales variadas, ramificación sí/no/bye, antirepetición de citas/preguntas,
// memoria ampliada (retoma pendientes), HeyGen y CORS.
//
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

// Vocativos y bendiciones espirituales (cálidos/íntimos)
function pickVocative(lang="es", gender="unknown"){
  const rnd = (arr)=>arr[Math.floor(Math.random()*arr.length)];
  const ES_neutral = ["alma amada","tesoro de mi corazón","corazón buscador","hija/o del Altísimo","alma de mi vida"];
  const ES_f = ["hija mía","amada de mi corazón","alma amada","amiga del Señor","corazón valiente"];
  const ES_m = ["hijo mío","amado de mi corazón","alma amada","amigo del Señor","corazón valiente"];
  if(lang==="en"){
    const NEU = ["beloved daughter/son of my heart","beloved soul","dear heart","precious one","child of the Most High"];
    return rnd(NEU);
  }
  if(lang==="pt"){
    const NEU = ["alma amada","tesouro do meu coração","filha/o do Altíssimo","querida do Senhor","coração valente"];
    return rnd(NEU);
  }
  if(lang==="it"){
    const NEU = ["anima amata","tesoro del mio cuore","figlia/figlio dell’Altissimo","caro cuore","amata del Signore"];
    return rnd(NEU);
  }
  if(lang==="de"){
    const NEU = ["geliebte Seele","Schatz meines Herzens","Kind des Höchsten","liebes Herz","Geliebte/r des Herrn"];
    return rnd(NEU);
  }
  if(lang==="ca"){
    const NEU = ["ànima estimada","tresor del meu cor","fill/a de l’Altíssim","cor estimat","estimada del Senyor"];
    return rnd(NEU);
  }
  if(lang==="fr"){
    const NEU = ["âme bien-aimée","trésor de mon cœur","enfant du Très-Haut","cher cœur","bien-aimé(e) du Seigneur"];
    return rnd(NEU);
  }
  if(gender==="female") return rnd(ES_f);
  if(gender==="male")   return rnd(ES_m);
  return rnd(ES_neutral);
}
function pickBlessing(lang="es"){
  const rnd = (arr)=>arr[Math.floor(Math.random()*arr.length)];
  const ES = [
    "que la paz del Señor esté contigo",
    "que el amor de Dios te sostenga",
    "que el Espíritu te fortalezca",
    "que Cristo ilumine tus pasos"
  ];
  const EN = [
    "may the Lord’s peace be with you",
    "may God’s love sustain you",
    "may the Spirit strengthen you",
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
    return {
      last_bible_refs:[],
      last_questions:[],
      frame:null,
      last_offer_kind:null,
      last_user_reply:null,
      pending_action:null,
      pending_ts: null,
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

// ---------- Pool de citas (fallback si repite) ----------
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
      { ref:"Isaiah 41:10", text:"Do not fear, for I am with you." },
      { ref:"Philippians 4:6-7", text:"Do not be anxious about anything... and the peace of God will guard your hearts." },
      { ref:"Psalm 55:22", text:"Cast your cares on the Lord and he will sustain you." }
    ],
    grief: [
      { ref:"Psalm 34:18", text:"The Lord is close to the brokenhearted and saves those who are crushed in spirit." },
      { ref:"Matthew 5:4", text:"Blessed are those who mourn, for they will be comforted." },
      { ref:"Revelation 21:4", text:"He will wipe every tear from their eyes." }
    ],
    relationship: [
      { ref:"1 Corinthians 13:4-7", text:"Love is patient, love is kind... it always protects, always trusts, always hopes." },
      { ref:"Ephesians 4:32", text:"Be kind and compassionate, forgiving each other." },
      { ref:"Romans 12:18", text:"If it is possible, as far as it depends on you, live at peace with everyone." }
    ],
    work_finance: [
      { ref:"Matthew 6:34", text:"Do not worry about tomorrow." },
      { ref:"Proverbs 16:3", text:"Commit to the Lord whatever you do." },
      { ref:"Philippians 4:19", text:"My God will meet all your needs." }
    ],
    health: [
      { ref:"Psalm 103:2-3", text:"He heals all your diseases." },
      { ref:"Jeremiah 30:17", text:"I will restore you to health." },
      { ref:"3 John 1:2", text:"I pray that you may enjoy good health." }
    ],
    faith: [
      { ref:"Proverbs 3:5-6", text:"Trust in the Lord with all your heart." },
      { ref:"Hebrews 11:1", text:"Faith is confidence in what we hope for." },
      { ref:"John 14:27", text:"Peace I leave with you; my peace I give you." }
    ],
    separation: [
      { ref:"Psalm 147:3", text:"He heals the brokenhearted and binds up their wounds." },
      { ref:"Isaiah 43:2", text:"When you pass through the waters, I will be with you." },
      { ref:"Romans 8:28", text:"In all things God works for the good of those who love him." }
    ],
    addiction: [
      { ref:"1 Corinthians 10:13", text:"God is faithful; he will not let you be tempted beyond what you can bear." },
      { ref:"Galatians 5:1", text:"It is for freedom that Christ has set us free." },
      { ref:"Psalm 40:1-2", text:"He lifted me out of the slimy pit, out of the mud and mire." }
    ],
    family_conflict: [
      { ref:"James 1:19", text:"Quick to listen, slow to speak, slow to become angry." },
      { ref:"Colossians 3:13", text:"Bear with each other and forgive one another." },
      { ref:"Romans 12:10", text:"Be devoted to one another in love." }
    ],
    general: [
      { ref:"Psalm 23:1", text:"The Lord is my shepherd; I lack nothing." },
      { ref:"1 Peter 5:7", text:"Cast all your anxiety on him because he cares for you." },
      { ref:"Isaiah 40:31", text:"Those who hope in the Lord will renew their strength." }
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

// ---------- WELCOME (íntima + memoria de pendientes) ----------
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

    // Si hay acción pendiente reciente (<=48h), suavemente la recordamos con intimidad
    const hasRecentPending = mem.pending_action && (!mem.pending_ts || (Date.now() - mem.pending_ts) < 48*60*60*1000);
    const pendLineByLang = (l)=>(
      l==="en" ? `If you wish, we can gently revisit what was pending: ${mem.pending_action}`
      : l==="pt" ? `Se quiser, retomamos com carinho o que ficou pendente: ${mem.pending_action}`
      : l==="it" ? `Se vuoi, riprendiamo con dolcezza ciò che era in sospeso: ${mem.pending_action}`
      : l==="de" ? `Wenn du möchtest, greifen wir behutsam das Anstehende wieder auf: ${mem.pending_action}`
      : l==="ca" ? `Si vols, reprenem amb suavitat allò que va quedar pendent: ${mem.pending_action}`
      : l==="fr" ? `Si tu veux, reprenons avec douceur ce qui était en suspens : ${mem.pending_action}`
      : `Si quieres, retomamos con calma lo pendiente: ${mem.pending_action}`
    );

    const prelude = `${hi}${nm?`, ${nm}`:""}. ${voc[0].toUpperCase()+voc.slice(1)}, ${blessing}.`;

    // Evitar preguntas genéricas/frías
    const GENERIC_QS = [
      "¿cómo estás hoy?","¿en qué quieres profundizar?","¿qué tienes para contarme?",
      "¿qué te gustaría compartir?","¿de qué quieres hablar?","¿qué necesitas hoy?"
    ];

    const SYSTEM_PROMPT = `
Hablas con intimidad, cercanía y compasión, como quien ya conoce la historia de la persona.

Salida SOLO JSON:
- "message": empieza EXACTAMENTE con: "${prelude}"
  Añade 1 frase breve alentadora (autoayuda suave + toque espiritual), íntima y personal. Evita tono de entrevista. **Sin preguntas**. Máximo 75 palabras totales. **No incluyas citas bíblicas ni referencias** en "message".
  ${hasRecentPending ? `Incluye al final una mención suave y agradecida por recordar el pendiente si aparece: "${pendLineByLang(lang)}".` : ""}
- "bible": cita pertinente (texto + ref) de esperanza/consuelo.
- "question": **UNA** pregunta personal, íntima y concreta (6–14 palabras), que invite a abrir el corazón (no oferta, no sí/no, no genérica, no fría). Varía el enunciado.

Evita estas referencias: ${avoidRefs.map(r=>`"${r}"`).join(", ") || "(ninguna)"}.
Evita estas preguntas recientes: ${avoidQs.map(q=>`"${q}"`).join(", ") || "(ninguna)"}.
Evita preguntas genéricas como: ${GENERIC_QS.map(q=>`"${q}"`).join(", ")}.

Responde SIEMPRE en ${langLabel(lang)}.
`;

    const shortHistory = compactHistory(history,6,200);
    const header =
      `Lang: ${lang}\n`+
      `Nombre: ${nm||"(anónimo)"}\n`+
      `Prelude: ${prelude}\n`+
      (shortHistory.length?`Historial: ${shortHistory.join(" | ")}`:"Historial: (sin antecedentes)")+"\n"+
      `Pendiente: ${mem.pending_action?mem.pending_action:"(ninguno)"}\n`;

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
    const qNorm = NORM(question);

    // Antirepetición cita
    const avoidRefSet = new Set(avoidRefs.map(x=>NORM(cleanRef(x))));
    if (!ref || avoidRefSet.has(NORM(cleanRef(ref)))){
      const alt = pickAltVerse(lang, "general", avoidRefs);
      ref = alt.ref; text = alt.text;
    }

    // Antirepetición / calidad de pregunta
    const banned = new Set(avoidQs.map(NORM));
    const tooShort = qNorm.split(/\s+/).length < 5;
    const tooLong  = qNorm.split(/\s+/).length > 16;
    const genericish = /(cómo estás|qué te inquieta|qué quieres hablar|qué te gustaría compartir|de qué hablamos|qué necesitas hoy)/i;

    if (!question || banned.has(qNorm) || tooShort || tooLong || genericish.test(question)){
      // Fallback íntimo por idioma
      const seeds = {
        es: [
          "¿Qué late más fuerte en tu corazón ahora mismo?",
          "¿Qué te duele por dentro y necesitas poner en palabras?",
          "¿Dónde sientes que te falta fuerza hoy por dentro?",
          "¿Qué necesitas de mí en este instante para aliviar tu carga?"
        ],
        en: [
          "What is beating strongest in your heart right now?",
          "What aches inside that needs gentle words today?",
          "Where do you feel you lack strength inside today?",
          "What do you need from me right now to ease your burden?"
        ],
        pt: [
          "O que pulsa mais forte no seu coração agora?",
          "O que dói por dentro e precisa ser dito com carinho?",
          "Onde você sente que falta força hoje, por dentro?",
          "O que você precisa de mim agora para aliviar o peso?"
        ],
        it: [
          "Cosa pulsa più forte nel tuo cuore adesso?",
          "Cosa ti fa male dentro e ha bisogno di parole gentili?",
          "Dove senti che ti manca forza, oggi, nel profondo?",
          "Di cosa hai bisogno da me ora per alleggerire il peso?"
        ],
        de: [
          "Was schlägt gerade am stärksten in deinem Herzen?",
          "Was schmerzt in dir und braucht behutsame Worte?",
          "Wo fehlt dir heute innerlich die Kraft?",
          "Was brauchst du jetzt von mir, um die Last zu erleichtern?"
        ],
        ca: [
          "Què batega més fort al teu cor ara mateix?",
          "Què et fa mal per dins i necessita paraules suaus?",
          "On sents que et falta força avui, per dins?",
          "Què necessites de mi ara per alleujar la càrrega?"
        ],
        fr: [
          "Qu’est-ce qui bat le plus fort dans ton cœur maintenant ?",
          "Qu’est-ce qui te fait mal au dedans et a besoin de mots doux ?",
          "Où sens-tu qu’il te manque de la force aujourd’hui, au fond ?",
          "De quoi as-tu besoin de moi maintenant pour alléger ta charge ?"
        ]
      };
      const pool = seeds[lang]||seeds.es;
      question = pool[Math.floor(Math.random()*pool.length)];
      if (!/\?\s*$/.test(question)) question += "?";
    }

    // Persistencia
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
      message: msg || `${prelude} Compartamos en pocas palabras y damos un paso sencillo.`,
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
      message: `${hi}. Alma amada, que la paz del Señor esté contigo. Estoy aquí, cuéntame con calma qué te trae hoy.`,
      bible:{ text:"Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu.", ref:"Salmos 34:18" },
      question: "¿Qué late más fuerte en tu corazón ahora mismo?"
    });
  }
});

// ---------- ASK (servicial + ramificación sí/no/bye, ≤75 palabras, antirep) ----------
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
    const shortHistory = compactHistory(history,10,240);

    // Reglas dinámicas de pregunta
    let QUESTION_RULE = "";
    if (isBye){
      QUESTION_RULE = `No incluyas "question" si el usuario se está despidiendo o agradeciendo.`;
    } else if (saidYes){
      QUESTION_RULE = `
El usuario aceptó. Entonces:
- Da 2–3 pasos concretos + 1 mini práctica guiada (1–3 minutos).
- Luego UNA pregunta breve de seguimiento **no binaria** (preferencias/ajuste). Prohibidas preguntas sí/no y “¿Te gustaría…?”.
`;
    } else if (saidNo){
      QUESTION_RULE = `
El usuario rechazó. Entonces:
- Valida con calidez y ofrece alternativa distinta **en el mensaje** (no como pregunta).
- UNA pregunta personal breve para entender mejor (no sí/no), variada.
`;
    } else {
      QUESTION_RULE = `
No hay aceptación/negativa. Haz UNA pregunta personal abierta, concreta (no oferta, no sí/no), que ayude a entender para elegir la mejor ayuda.
`;
    }

    const SYSTEM_PROMPT = `
Hablas con serenidad, cercanía y compasión. Eres servicial: ofreces ayuda concreta sin dar órdenes ni sonar imperativo.

Salida SOLO JSON.

"message": máximo 75 palabras, sin signos de pregunta. Primero autoayuda breve y práctica (2–3 frases, con 1–2 micro-pasos concretos ajustados al tema); luego un toque espiritual cristiano. **No incluyas citas bíblicas ni referencias en "message"**. Evita repetir literalmente las últimas 2–3 palabras del usuario.
"bible": cita pertinente que apoye el micro-paso (texto + ref). Evita repetir referencias recientes.
"question": UNA, según estas reglas:
${QUESTION_RULE}
- Varía el enunciado; evita equivalentes semánticos de turnos recientes.
- Termina en "?" si existe.

Marco (FRAME): ${JSON.stringify(frame)}.
Evita estas referencias: ${avoidRefs.map(r=>`"${r}"`).join(", ")||"(ninguna)"}.
Evita estas preguntas recientes: ${avoidQs.map(q=>`"${q}"`).join(", ")||"(ninguna)"}.
Responde SIEMPRE en ${langLabel(lang)}.
`;

    const header =
      `Persona: ${persona}\n`+
      `Lang: ${lang}\n`+
      `Mensaje_usuario: ${userTxt}\n`+
      (shortHistory.length?`Historial: ${shortHistory.join(" | ")}`:"Historial: (sin antecedentes)")+"\n"+
      `Ultima_oferta: ${mem.last_offer_kind||"(ninguna)"}\n`+
      `Ultima_respuesta_usuario: ${mem.last_user_reply||"(desconocida)"}\n`+
      `Pendiente: ${mem.pending_action||"(ninguno)"}\n`;

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

    // Cierre sin pregunta (bye/thanks)
    if (isBye){
      question = "";
      if (!/paz|esperanz|luz|fortalec|acompa/i.test(msg)) {
        msg = limitWords(`${msg} ${lang==="en"?"Go in peace; may the Lord keep you.":lang==="pt"?"Vai em paz; que o Senhor te guarde.":lang==="it"?"Va' in pace; il Signore ti custodisca.":lang==="de"?"Geh in Frieden; der Herr behüte dich.":lang==="ca"?"Vés en pau; que el Senyor et guardi.":lang==="fr"?"Va en paix; que le Seigneur te garde.":"Ve en paz; que el Señor te guarde."}`, 75);
      }
    } else {
      if (question && !/\?\s*$/.test(question)) question+="?";
      const qNorm = NORM(question);
      const banned = new Set(avoidQs.map(NORM));
      const isYesNo = /^(quieres|deseas|te gustaría|prefieres|puedo|hacemos|lo hacemos|queres)\b/i.test(question);
      const tooShort = qNorm.split(/\s+/).length < 5;
      const tooLong  = qNorm.split(/\s+/).length > 18;
      if ((saidYes && isYesNo) || banned.has(qNorm) || tooShort || tooLong){
        const follow = {
          es: [
            "¿Qué parte te haría bien practicar primero?",
            "¿En qué situación concreta quisieras aplicarlo hoy?",
            "¿En qué momento del día encaja mejor para ti?",
            "¿Quién cercano podría acompañarte en este paso?"
          ],
          en: [
            "Which part would help to practice first?",
            "Which concrete situation shall we apply it to today?",
            "When in your day would it fit best?",
            "Who close to you could support this step?"
          ],
          pt: [
            "Que parte ajudaria praticar primeiro?",
            "Em que situação concreta aplicamos hoje?",
            "Em que horário do dia se encaixa melhor?",
            "Quem poderia apoiar você neste passo?"
          ],
          it: [
            "Quale parte ti aiuterebbe a praticare per prima?",
            "A quale situazione concreta lo applichiamo oggi?",
            "In quale momento della giornata si adatta meglio?",
            "Chi vicino a te potrebbe sostenerti in questo passo?"
          ],
          de: [
            "Welcher Teil hilft dir zuerst zu üben?",
            "Auf welche konkrete Situation wenden wir es heute an?",
            "Wann im Tagesablauf passt es am besten?",
            "Wer in deiner Nähe könnte diesen Schritt unterstützen?"
          ],
          ca: [
            "Quina part t’ajudaria a practicar primer?",
            "A quina situació concreta ho apliquem avui?",
            "En quin moment del dia t’encaixa millor?",
            "Qui a prop teu podria acompanyar-te en aquest pas?"
          ],
          fr: [
            "Quelle partie t’aiderait à pratiquer d’abord ?",
            "À quelle situation concrète l’appliquons-nous aujourd’hui ?",
            "À quel moment de la journée cela te conviendrait le mieux ?",
            "Qui, près de toi, pourrait soutenir cette étape ?"
          ]
        };
        const pool = follow[lang]||follow.es;
        question = pool[Math.floor(Math.random()*pool.length)];
        if (!/\?\s*$/.test(question)) question += "?";
      }
    }

    // Antirepetición cita
    const avoidSet = new Set(avoidRefs.map(x=>NORM(cleanRef(x))));
    if (!ref || avoidSet.has(NORM(cleanRef(ref)))){
      const alt = pickAltVerse(lang, topic, avoidRefs);
      ref = alt.ref; text = alt.text;
    }

    // Guardar memoria (oferta y pendiente)
    const offerKind = /respir|respira|oraci|orar|rezo/i.test(msg) ? "calma_breve"
                    : /escribe|diario|gratitud|lista/i.test(msg) ? "escritura_breve"
                    : /paso|gesto|amor|contacta|saluda|acerc|aplica/i.test(msg) ? "gestos_amor"
                    : null;

    // Extraer micro-paso simple como pendiente
    let pending = null;
    const mImp = msg.match(/\b(Prueba|Intenta|Dedica|Escribe|Respira|Llama|Saluda|Agradece|Camina|Ora|Pide|Celebra)\b[^.]{3,80}\./i);
    if (mImp) pending = mImp[0].replace(/\s+/g," ").trim();

    if (offerKind) mem.last_offer_kind = offerKind;
    mem.last_user_reply = saidYes ? "yes" : saidNo ? "no" : isBye ? "bye" : "text";
    if (pending){ mem.pending_action = pending; mem.pending_ts = Date.now(); }

    const cleanedRef = cleanRef(ref);
    if (cleanedRef){
      const arr = Array.isArray(mem.last_bible_refs)? mem.last_bible_refs : [];
      arr.push(cleanedRef); while(arr.length>8) arr.shift();
      mem.last_bible_refs = arr;
    }
    if (!isBye && question){
      const qs = Array.isArray(mem.last_questions)? mem.last_questions : [];
      qs.push(question); while(qs.length>10) qs.shift();
      mem.last_questions = qs;
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
