// index.js — Bienvenida con pregunta de servicio (multilenguaje, antirep),
// diálogo servicial y colaborativo, pregunta final alineada al tema,
// ≤75 palabras en message, sin cita dentro de "message", memoria ampliada,
// HeyGen y CORS abiertos.
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

// Vocativos y bendiciones espirituales (ligeramente aleatorios)
function pickVocative(lang="es", gender="unknown"){
  const rnd = (arr)=>arr[Math.floor(Math.random()*arr.length)];
  const ES_neutral = ["alma amada","alma querida","corazón buscador","hijo/a del Altísimo","tesoro de Dios"];
  const ES_f = ["hija mía","alma amada","hija querida","amiga del Señor","corazón valiente"];
  const ES_m = ["hijo mío","alma amada","hijo querido","amigo del Señor","corazón valiente"];
  if(lang==="en"){
    const NEU = ["beloved soul","dear heart","child of the Most High","precious soul","cherished one"];
    return rnd(NEU);
  }
  if(lang==="pt"){
    const NEU = ["alma amada","coração querido","filho/a do Altíssimo","alma preciosa","querido/a do Senhor"];
    return rnd(NEU);
  }
  if(lang==="it"){
    const NEU = ["anima amata","caro cuore","figlia/figlio dell’Altissimo","anima preziosa","caro/a del Signore"];
    return rnd(NEU);
  }
  if(lang==="de"){
    const NEU = ["geliebte Seele","liebes Herz","Kind des Höchsten","kostbare Seele","Geliebte/r des Herrn"];
    return rnd(NEU);
  }
  if(lang==="ca"){
    const NEU = ["ànima estimada","cor estimat","fill/a de l’Altíssim","ànima preciosa","estimada del Senyor"];
    return rnd(NEU);
  }
  if(lang==="fr"){
    const NEU = ["âme bien-aimée","cher cœur","enfant du Très-Haut","âme précieuse","bien-aimé(e) du Seigneur"];
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

// ---------- Pools de preguntas de servicio (bienvenida) ----------
const SERVICE_QUESTION_POOL = {
  es: [
    "¿De qué vamos a hablar hoy?",
    "¿En qué puedo ayudarte ahora mismo?",
    "¿Qué vamos a resolver juntos hoy?",
    "¿Qué te inquieta y quieres atender hoy?",
    "¿Qué problema atendemos primero?",
    "¿Qué necesitas que miremos con calma hoy?"
  ],
  en: [
    "What shall we talk about today?",
    "How can I help you right now?",
    "What are we going to solve together today?",
    "What is weighing on you that you’d like to address today?",
    "What problem should we handle first?",
    "What do you need us to look at calmly today?"
  ],
  pt: [
    "Sobre o que vamos falar hoje?",
    "Como posso te ajudar agora mesmo?",
    "O que vamos resolver juntos hoje?",
    "O que te inquieta e quer cuidar hoje?",
    "Que problema tratamos primeiro?",
    "Do que você precisa que olhemos com calma hoje?"
  ],
  it: [
    "Di cosa parliamo oggi?",
    "Come posso aiutarti adesso?",
    "Cosa risolviamo insieme oggi?",
    "Cosa ti pesa e vuoi affrontare oggi?",
    "Quale problema affrontiamo per primo?",
    "Di cosa hai bisogno che guardiamo con calma oggi?"
  ],
  de: [
    "Worüber sprechen wir heute?",
    "Wobei kann ich dir jetzt helfen?",
    "Was lösen wir heute gemeinsam?",
    "Was belastet dich und möchtest du heute angehen?",
    "Welches Problem packen wir zuerst an?",
    "Wobei sollen wir heute in Ruhe hinschauen?"
  ],
  ca: [
    "De què parlem avui?",
    "En què puc ajudar-te ara mateix?",
    "Què resolem junts avui?",
    "Què et inquieta i vols atendre avui?",
    "Quin problema abordem primer?",
    "Què necessites que mirem amb calma avui?"
  ],
  fr: [
    "De quoi parlons-nous aujourd’hui ?",
    "Comment puis-je t’aider maintenant ?",
    "Qu’allons-nous résoudre ensemble aujourd’hui ?",
    "Qu’est-ce qui te pèse et que tu veux aborder aujourd’hui ?",
    "Quel problème traitons en premier ?",
    "De quoi as-tu besoin que nous regardions avec calme aujourd’hui ?"
  ]
};

// ---------- Pregunta final de servicio alineada al tema ----------
function buildTopicAlignedQuestion(lang="es", topic="general"){
  const L = lang in SERVICE_QUESTION_POOL ? lang : "es";
  // Si el tema es general/indefinido: pedir concreción
  if (topic==="general"){
    const pool = {
      es: [
        "¿Qué problema concreto quieres que abordemos juntos ahora?",
        "¿Qué parte de esto te gustaría aclarar primero?",
        "¿Qué situación específica miramos primero?"
      ],
      en: [
        "What concrete problem shall we tackle together now?",
        "Which part would you like to clarify first?",
        "Which specific situation do we look at first?"
      ],
      pt: [
        "Que problema concreto vamos enfrentar juntos agora?",
        "Que parte você quer esclarecer primeiro?",
        "Que situação específica olhamos primeiro?"
      ],
      it: [
        "Quale problema concreto affrontiamo insieme adesso?",
        "Quale parte vorresti chiarire per prima?",
        "Quale situazione specifica guardiamo per prima?"
      ],
      de: [
        "Welches konkrete Problem gehen wir jetzt gemeinsam an?",
        "Welchen Teil möchtest du zuerst klären?",
        "Welche konkrete Situation schauen wir uns zuerst an?"
      ],
      ca: [
        "Quin problema concret vols que abordem plegats ara?",
        "Quina part t’agradaria aclarir primer?",
        "Quina situació específica mirem primer?"
      ],
      fr: [
        "Quel problème concret voulons-nous aborder ensemble maintenant ?",
        "Quelle partie souhaites-tu clarifier en premier ?",
        "Quelle situation spécifique examinons-nous d’abord ?"
      ]
    };
    const arr = pool[L] || pool.es;
    return arr[Math.floor(Math.random()*arr.length)];
  }
  // Con tema detectado: menciona el tema
  const map = {
    relationship: {
      es: [
        "¿Qué paso quieres dar hoy con tu relación?",
        "¿Qué conversación concreta necesitas tener con tu pareja?"
      ],
      en: [
        "What step would you like to take today in your relationship?",
        "What specific conversation do you need to have with your partner?"
      ],
      pt: [
        "Que passo você quer dar hoje no seu relacionamento?",
        "Que conversa específica você precisa ter com seu parceiro?"
      ],
      it: [
        "Quale passo vuoi compiere oggi nella tua relazione?",
        "Quale conversazione concreta devi avere con il tuo partner?"
      ],
      de: [
        "Welchen Schritt möchtest du heute in deiner Beziehung gehen?",
        "Welches konkrete Gespräch musst du mit deinem Partner führen?"
      ],
      ca: [
        "Quin pas vols fer avui en la teva relació?",
        "Quina conversa concreta necessites tenir amb la teva parella?"
      ],
      fr: [
        "Quelle étape veux-tu franchir aujourd’hui dans ta relation ?",
        "Quelle conversation précise dois-tu avoir avec ton/ta partenaire ?"
      ]
    },
    work_finance: {
      es: [
        "¿Qué gestión sencilla hacemos hoy para avanzar en lo laboral/financiero?",
        "¿Qué decisión específica necesitas tomar respecto a tu trabajo o finanzas?"
      ],
      en: [
        "What simple step shall we take today for your work/finances?",
        "What specific decision do you need to make about work or finances?"
      ],
      pt: [
        "Que passo simples damos hoje no trabalho/finanças?",
        "Que decisão específica você precisa tomar sobre trabalho ou finanças?"
      ],
      it: [
        "Quale passo semplice facciamo oggi su lavoro/finanze?",
        "Quale decisione specifica devi prendere su lavoro o finanze?"
      ],
      de: [
        "Welchen einfachen Schritt gehen wir heute bei Arbeit/Finanzen?",
        "Welche konkrete Entscheidung musst du zu Arbeit oder Finanzen treffen?"
      ],
      ca: [
        "Quin pas senzill fem avui en l’àmbit laboral/financer?",
        "Quina decisió específica necessites prendre sobre la feina o finances?"
      ],
      fr: [
        "Quelle étape simple faisons-nous aujourd’hui pour le travail/les finances ?",
        "Quelle décision précise dois-tu prendre sur le travail ou les finances ?"
      ]
    },
    health: {
      es: [
        "¿Qué cuidado concreto podemos incorporar hoy para tu salud?",
        "¿Qué consulta o paso médico te ayudaría a avanzar?"
      ],
      en: [
        "What concrete self-care can we add today for your health?",
        "Which medical step or consult would help you move forward?"
      ],
      pt: [
        "Que cuidado concreto podemos incluir hoje para sua saúde?",
        "Que passo ou consulta médica te ajudaria a avançar?"
      ],
      it: [
        "Quale cura concreta possiamo aggiungere oggi per la tua salute?",
        "Quale passo o consulto medico ti aiuterebbe ad avanzare?"
      ],
      de: [
        "Welche konkrete Fürsorge können wir heute für deine Gesundheit einbauen?",
        "Welcher medizinische Schritt oder Termin würde dir helfen, voranzukommen?"
      ],
      ca: [
        "Quina cura concreta podem incorporar avui per a la teva salut?",
        "Quin pas o consulta mèdica t’ajudaria a avançar?"
      ],
      fr: [
        "Quel soin concret pouvons-nous ajouter aujourd’hui pour ta santé ?",
        "Quelle démarche ou consultation médicale t’aiderait à avancer ?"
      ]
    },
    mood: {
      es: [
        "¿Qué te aliviaría hoy de forma sencilla y realista?",
        "¿Qué pequeño hábito de calma probamos primero?"
      ],
      en: [
        "What would bring you simple, realistic relief today?",
        "Which small calming habit shall we try first?"
      ],
      pt: [
        "O que te traria alívio simples e realista hoje?",
        "Que pequeno hábito de calma tentamos primeiro?"
      ],
      it: [
        "Cosa ti darebbe sollievo semplice e realistico oggi?",
        "Quale piccolo gesto di calma proviamo per primo?"
      ],
      de: [
        "Was würde dir heute einfache, realistische Erleichterung bringen?",
        "Welche kleine Ruhe-Gewohnheit probieren wir zuerst?"
      ],
      ca: [
        "Què et aportaria avui un alleujament senzill i realista?",
        "Quin petit hàbit de calma provem primer?"
      ],
      fr: [
        "Qu’est-ce qui t’apporterait aujourd’hui un soulagement simple et réaliste ?",
        "Quelle petite habitude apaisante essayons-nous d’abord ?"
      ]
    },
    grief: {
      es: [
        "¿Qué detalle de tu duelo quisieras cuidar primero hoy?",
        "¿Qué apoyo cercano podría acompañarte estos días?"
      ],
      en: [
        "Which part of your grief would you like to tend to first today?",
        "Who close to you could support you these days?"
      ],
      pt: [
        "Que parte do seu luto você quer cuidar primeiro hoje?",
        "Quem próximo poderia te apoiar nesses dias?"
      ],
      it: [
        "Quale parte del tuo lutto vuoi curare per prima oggi?",
        "Chi vicino a te potrebbe sostenerti in questi giorni?"
      ],
      de: [
        "Welchen Teil deiner Trauer möchtest du heute zuerst behutsam angehen?",
        "Wer in deiner Nähe könnte dich in diesen Tagen unterstützen?"
      ],
      ca: [
        "Quina part del teu dol vols cuidar primer avui?",
        "Qui a prop teu podria acompanyar-te aquests dies?"
      ],
      fr: [
        "Quelle part de ton deuil souhaites-tu prendre en soin d’abord aujourd’hui ?",
        "Qui, près de toi, pourrait t’accompagner ces jours-ci ?"
      ]
    },
    separation: {
      es: [
        "¿Qué límite o cuidado necesitas hoy para atravesar esta ruptura?",
        "¿Qué conversación o decisión te ayudaría a ordenar este momento?"
      ],
      en: [
        "What boundary or care do you need today to navigate this breakup?",
        "What conversation or decision would help you bring order to this moment?"
      ],
      pt: [
        "Que limite ou cuidado você precisa hoje para atravessar esta ruptura?",
        "Que conversa ou decisão te ajudaria a organizar este momento?"
      ],
      it: [
        "Quale confine o cura ti serve oggi per attraversare questa rottura?",
        "Quale conversazione o decisione ti aiuterebbe a fare ordine in questo momento?"
      ],
      de: [
        "Welche Grenze oder Fürsorge brauchst du heute in dieser Trennung?",
        "Welches Gespräch oder welche Entscheidung würde dir helfen, Ordnung zu schaffen?"
      ],
      ca: [
        "Quin límit o cura necessites avui per travessar aquesta ruptura?",
        "Quina conversa o decisió t’ajudaria a posar ordre en aquest moment?"
      ],
      fr: [
        "Quelle limite ou quel soin te faut-il aujourd’hui pour traverser cette rupture ?",
        "Quelle conversation ou décision t’aiderait à remettre de l’ordre dans ce moment ?"
      ]
    },
    addiction: {
      es: [
        "¿Qué apoyo práctico sumamos hoy para sostener tu proceso?",
        "¿Qué situación de riesgo conviene prevenir primero?"
      ],
      en: [
        "What practical support shall we add today to sustain your process?",
        "Which risk situation is best to prevent first?"
      ],
      pt: [
        "Que apoio prático somamos hoje para sustentar seu processo?",
        "Qual situação de risco convém prevenir primeiro?"
      ],
      it: [
        "Quale supporto pratico aggiungiamo oggi per sostenere il tuo percorso?",
        "Quale situazione a rischio conviene prevenire per prima?"
      ],
      de: [
        "Welche praktische Unterstützung fügen wir heute hinzu, um deinen Weg zu tragen?",
        "Welche Risikosituation sollten wir zuerst vorbeugen?"
      ],
      ca: [
        "Quin suport pràctic afegim avui per sostenir el teu procés?",
        "Quina situació de risc convé prevenir primer?"
      ],
      fr: [
        "Quel soutien pratique ajoutons-nous aujourd’hui pour soutenir ton processus ?",
        "Quelle situation à risque vaut-il mieux prévenir d’abord ?"
      ]
    },
    family_conflict: {
      es: [
        "¿Qué gesto pacificador te ayudaría hoy en tu familia?",
        "¿Qué límite claro necesitas expresar con respeto?"
      ],
      en: [
        "What peacemaking gesture would help in your family today?",
        "What clear boundary do you need to express respectfully?"
      ],
      pt: [
        "Que gesto pacificador ajudaria hoje na sua família?",
        "Que limite claro você precisa expressar com respeito?"
      ],
      it: [
        "Quale gesto di pace aiuterebbe oggi nella tua famiglia?",
        "Quale confine chiaro devi esprimere con rispetto?"
      ],
      de: [
        "Welche friedensstiftende Geste hilft heute in deiner Familie?",
        "Welche klare Grenze musst du respektvoll ausdrücken?"
      ],
      ca: [
        "Quin gest pacificador t’ajudaria avui a la teva família?",
        "Quin límit clar necessites expressar amb respecte?"
      ],
      fr: [
        "Quel geste de paix aiderait aujourd’hui dans ta famille ?",
        "Quelle limite claire dois-tu exprimer avec respect ?"
      ]
    }
  };
  const arr = (map[topic] && map[topic][L]) || (map[topic] && map[topic]["es"]) || null;
  if (!arr) return buildTopicAlignedQuestion(L, "general");
  return arr[Math.floor(Math.random()*arr.length)];
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
      { ref:"Isaiah 40:31", text:"Those who hope in the Lord will renew their strength."
      }
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

    // Selecciona pregunta de servicio (antirep)
    function pickServiceQuestion(lang="es", bannedSet=new Set()){
      const pool = SERVICE_QUESTION_POOL[lang] || SERVICE_QUESTION_POOL.es;
      const candidates = pool.filter(q => !bannedSet.has(NORM(q)));
      const chosen = (candidates.length? candidates[Math.floor(Math.random()*candidates.length)] : pool[0]) || pool[0];
      return /\?\s*$/.test(chosen) ? chosen : (chosen + "?");
    }

    const SYSTEM_PROMPT = `
Hablas con serenidad, claridad y compasión.

Salida SOLO JSON:
- "message": empieza EXACTAMENTE con: "${prelude}"
  Añade 1 frase alentadora práctica (autoayuda breve + toque espiritual). **Sin preguntas**. Máximo 75 palabras totales. **No incluyas citas bíblicas ni referencias** en "message".
- "bible": cita pertinente (texto + ref) de esperanza.
- "question": **UNA sola** pregunta **de servicio práctico** (no poética, no abstracta, no oferta de “¿Quieres…?”). 6–12 palabras. Debe ser equivalente a: “¿De qué vamos a hablar hoy?”, “¿En qué puedo ayudarte ahora mismo?”, “¿Qué vamos a resolver juntos hoy?”, variando el enunciado y siempre terminando en "?".

Evita estas referencias: ${avoidRefs.map(r=>`"${r}"`).join(", ") || "(ninguna)"}.
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
      temperature: 0.65,
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

    // Antirepetición pregunta + forzar servicio
    const banned = new Set(avoidQs.map(NORM));
    const looksLikeOffer = /^¿\s*(quieres|te gustaría|prefieres|puedo|hacemos)/i.test(question || "");
    const tooShort = (question||"").split(/\s+/).length < 5;
    const tooLong  = (question||"").split(/\s+/).length > 15;
    if (!question || banned.has(NORM(question)) || looksLikeOffer || tooShort || tooLong){
      question = pickServiceQuestion(lang, banned);
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
      message: `${hi}. Alma amada, que la paz del Señor esté contigo. Cuéntame en pocas palabras qué te trae hoy.`,
      bible:{ text:"Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu.", ref:"Salmos 34:18" },
      question: "¿En qué puedo ayudarte ahora mismo?"
    });
  }
});

// ---------- ASK (servicial, colaborativo, pregunta final alineada) ----------
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

    let QUESTION_RULE = "";
    if (isBye){
      QUESTION_RULE = `No incluyas "question" si el usuario se despide o agradece.`;
    } else if (saidYes){
      QUESTION_RULE = `
El usuario aceptó. Entonces:
- Brinda 2–3 pasos concretos con tono colaborativo (“podemos…”, “si te ayuda, probemos…”), y 1 mini práctica guiada (1–3 minutos).
- Luego UNA pregunta breve **no binaria** (seguimiento o preferencia), evitando “¿Te gustaría…?”, “¿Quieres…?”.`;
    } else if (saidNo){
      QUESTION_RULE = `
El usuario rechazó. Entonces:
- Valida con calidez y ofrece en el **mensaje** una alternativa distinta y suave (“si prefieres, podemos…”).
- UNA pregunta personal breve para entender mejor (no sí/no), variada.`;
    } else {
      QUESTION_RULE = `
No hay aceptación/negativa clara. Haz UNA pregunta personal de clarificación **alineada al tema** detectado (si existe); si el tema es difuso, pide concretar el problema. No binaria, breve, práctica.`;
    }

    const SYSTEM_PROMPT = `
Hablas con serenidad, claridad y compasión.
Salida SOLO JSON.

"message": máximo 75 palabras, **sin signos de pregunta**. Tono **colaborativo y servicial** (evita imperativos duros):
- 2–3 frases de autoayuda **práctica** con 1–2 micro-pasos posibles (“podemos…”, “si te ayuda, probemos…”, “podrías considerar…”).
- Luego un toque espiritual cristiano.
**No incluyas citas bíblicas ni referencias en "message"**.

"bible": cita pertinente (texto + ref). Evita repetir referencias recientes.

"question": UNA, según estas reglas:
${QUESTION_RULE}
- Alinea la pregunta con el **tema** (FRAME.topic_primary). Si el tema es “general”, pide concretar el problema (“¿Qué problema concreto…?”).
- Varía el enunciado; evita equivalentes de turnos recientes.
- Termina en "?" si existe.

FRAME: ${JSON.stringify(frame)}.
Evita referencias: ${avoidRefs.map(r=>`"${r}"`).join(", ")||"(ninguna)"}.
Evita preguntas recientes: ${avoidQs.map(q=>`"${q}"`).join(", ")||"(ninguna)"}.
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
      temperature:0.6,
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
        msg = limitWords(`${msg} ${
          lang==="en"?"Go in peace; may the Lord keep you.":
          lang==="pt"?"Vai em paz; que o Senhor te guarde.":
          lang==="it"?"Va' in pace; il Signore ti custodisca.":
          lang==="de"?"Geh in Frieden; der Herr behüte dich.":
          lang==="ca"?"Vés en pau; que el Senyor et guardi.":
          lang==="fr"?"Va en paix; que le Seigneur te garde.":
          "Ve en paz; que el Señor te guarde."
        }`, 75);
      }
    } else {
      // Normaliza signo de interrogación
      if (question && !/\?\s*$/.test(question)) question+="?";

      // Si el tema es "general" y la pregunta no concreta, sustituir
      if (topic==="general"){
        const forced = buildTopicAlignedQuestion(lang, "general");
        const tooGeneric = /(cómo estás|qué te inquieta|de qué quieres hablar|qué te gustaría compartir)/i.test(question||"");
        if (!question || tooGeneric) question = forced;
      } else {
        // Si hay tema, asegurar alineación semántica (heurística)
        const topicWord = {
          relationship:/pareja|relaci|espos|novi|matr/i,
          work_finance:/trabaj|emple|finanz|dinero|deud/i,
          health:/salud|dolor|diagn|m[eé]dic/i,
          mood:/ansied|triste|miedo|p[áa]nico|estr[eé]s/i,
          grief:/duelo|perd|fallec|luto/i,
          separation:/separaci|ruptur|divorcio/i,
          addiction:/adici|alcohol|droga|apuest/i,
          family_conflict:/familia|conflict|discusi|suegr|hij[oa]/i
        }[topic] || null;
        if (topicWord && !(topicWord.test(question||""))) {
          // Reemplazo por una pregunta alineada
          question = buildTopicAlignedQuestion(lang, topic);
        }
      }

      // Filtros de calidad y antirepetición
      const qNorm = NORM(question);
      const banned = new Set(avoidQs.map(NORM));
      const yesNoLike = /^\s*¿\s*(quieres|te gustaría|prefieres|puedo|hacemos|lo hacemos)/i.test(question||"");
      const tooShort = (question||"").split(/\s+/).length < 5;
      const tooLong  = (question||"").split(/\s+/).length > 18;
      if (banned.has(qNorm) || tooShort || tooLong || yesNoLike){
        question = buildTopicAlignedQuestion(lang, topic);
        if (!/\?\s*$/.test(question)) question += "?";
      }
    }

    // Antirepetición cita
    const avoidSet = new Set(avoidRefs.map(x=>NORM(cleanRef(x))));
    if (!ref || avoidSet.has(NORM(cleanRef(ref)))){
      const alt = pickAltVerse(lang, topic, avoidRefs);
      ref = alt.ref; text = alt.text;
    }

    // Guardar memoria
    const offerKind = /respir|respira|oraci|orar|rezo/i.test(msg) ? "calma_breve"
                    : /escribe|diario|gratitud|lista/i.test(msg) ? "escritura_breve"
                    : /paso|gesto|amor|contacta|saluda/i.test(msg) ? "gestos_amor"
                    : null;

    let pending = null;
    const mImp = msg.match(/\b(Podemos|Si te ayuda, probemos|Podrías considerar|Tal vez ayuda)\b[^.]{3,100}\./i);
    if (mImp) pending = mImp[0].replace(/\s+/g," ").trim();

    if (offerKind) mem.last_offer_kind = offerKind;
    mem.last_user_reply = saidYes ? "yes" : saidNo ? "no" : isBye ? "bye" : "text";
    if (pending) mem.pending_action = pending;

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
