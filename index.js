// index.js — Backend conversación (multi-idioma, guardrails dominio, Biblia con memoria)
// Env: OPENAI_API_KEY, DATA_DIR (opcional), HEYGEN_*

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

// ---------- Una sola pregunta ----------
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
  const badGeneric = /(qué te aliviar[ií]a|que te aliviar[ií]a|qué pequeño paso|qué vas a|qué harás|qué plan|what would help|which plan|quel plan|welcher plan)/i;
  if (badGeneric.test(s)){
    s = (lang==="en"
      ? "What happened today that you want to talk about?"
      : lang==="pt" ? "O que aconteceu hoje que você gostaria de conversar?"
      : lang==="it" ? "Che cosa è successo oggi di cui vorresti parlare?"
      : lang==="de" ? "Was ist heute passiert, worüber du sprechen möchtest?"
      : lang==="ca" ? "Què ha passat avui de què vols parlar?"
      : lang==="fr" ? "Qu’est-il arrivé aujourd’hui dont tu aimerais parler ?"
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
    // colecciones
    mem.last_bible_refs = Array.isArray(mem.last_bible_refs) ? mem.last_bible_refs : [];
    mem.last_questions  = Array.isArray(mem.last_questions)  ? mem.last_questions  : [];
    mem.last_techniques = Array.isArray(mem.last_techniques) ? mem.last_techniques : [];
    mem.last_q_styles   = Array.isArray(mem.last_q_styles)   ? mem.last_q_styles   : [];
    // progreso biblia
    mem.bible_progress  = mem.bible_progress || { last_ref:"" };
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
      bible_progress:{ last_ref:"" }
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
  if (/(fe|duda|dios|oraci[oó]n|culpa|pecado|perd[oó]n|biblia)/.test(t)) return "faith";
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

// ---------- Guardrails de dominio ----------
const SUP_LANGS = ["es","en","pt","it","de","ca","fr"];
function t(lang, mapObj) {
  const L = (lang || "es").toLowerCase();
  return mapObj[L] || mapObj.es || "";
}
function hasPersonalAngle(s = "") {
  const x = NORM(s);
  return (
    /\b(me siento|me pone|me preocupa|me angustia|me da miedo|tengo miedo|ansiedad|pánico|triste|depres|enojo|bronca|culpa|vergüenza|me afecta|me duele|me cuesta|no puedo|me agota)\b/i.test(x) ||
    /\b(i feel|i’m anxious|i am anxious|i'm sad|i am sad|depressed|panic|fear|afraid|ashamed|guilty|it hurts|i can’t|i cannot|it’s hard|i'm angry|i am angry)\b/i.test(x) ||
    /\b(me sinto|ansiedade|p[áa]nico|medo|triste|depress[ãa]o|culpa|vergonha|n[ãa]o consigo|d[óo]i|me afeta)\b/i.test(x) ||
    /\b(mi sento|ansia|paura|triste|depress|colpa|vergogna|non riesco|mi fa male|mi pesa)\b/i.test(x) ||
    /\b(ich f[üu]hle|angst|panik|traurig|depress|schuld|scham|es tut weh|ich kann nicht|es f[aä]llt mir schwer|wut)\b/i.test(x) ||
    /\b(em sento|angoixa|por|trist|depressi[oó]|culpa|vergonya|no puc|em fa mal|m’afecta)\b/i.test(x) ||
    /\b(je me sens|angoisse|peur|triste|d[ée]pression|culpabilit[ée]|honte|je n’y arrive pas|ça fait mal|ça m’affecte|col[èe]re)\b/i.test(x)
  );
}
function mentionsChristianContext(s=""){
  const x = NORM(s);
  return /vatican|vaticano|san pedro|bas[ií]lica|catedral|iglesia|parroquia|convento|monasterio|abad[ií]a|evangelio|ap[oó]stol|m[áa]rtir|cristian|biblia|sacramento|liturgia|santo sepulcro|jerusal[eé]n|roma|nazar[eé]t|bel[eé]n|galilea/i.test(x) ||
         /saint peter|holy sepulchre|cathedral|church|abbey|monastery|basilica|gospel|apostle|martyr|christian|bible|sacrament|liturgy/i.test(x) ||
         /igreja|mosteiro|abadia|basílica|evangelho|apóstolo|mártir|crist[ãa]o|bíblia|sacramento|liturgia/i.test(x) ||
         /chiesa|monastero|abbazia|basilica|vangelo|apostolo|martire|cristian/i.test(x) ||
         /kirche|kloster|abtei|basilika|evangelium|apostel|m[äa]rtyrer|christ/i.test(x) ||
         /esgl[ée]sia|monestir|abadia|bas[ií]lica|evangeli|ap[òo]stol|m[àa]rtir|cristi[àa]/i.test(x) ||
         /[ée]glise|monast[eè]re|abbaye|basilique|[ée]vangile|ap[oô]tre|martyr|chr[ée]tien|bible|sacrement|liturgie/i.test(x);
}
function detectOffTopic(raw = "") {
  const x = NORM(raw);

  // Deporte como hábito personal + ángulo personal → permitido
  const sportsAsHabit =
    /\b(entren(ar|o)|gimnasio|hacer ejercicio|actividad f[ií]sica|correr|caminar|rutina de ejercicio)\b/.test(x) ||
    /\b(workout|exercise|go to the gym|running|walk|walking|fitness routine)\b/.test(x) ||
    /\b(academia|treino|exerc[ií]cio|caminhar|corrida|rotina de treino)\b/.test(x) ||
    /\b(allenamento|palestra|esercizio|correre|camminare|routine di allenamento)\b/.test(x);
  if (sportsAsHabit && hasPersonalAngle(x)) return null;

  // Temas off-topic
  const sports =
    /\b(f[úu]tbol|futbol|basquet|b[áa]squet|tenis|nba|fifa|mundial|copa|liga|champions|gol|marcador|resultado|qu[ié]n gan[oó]|empate|tabla)\b/i.test(x) ||
    /\b(football|soccer|basketball|tennis|nba|fifa|world cup|league|champions|score|result|who won|standings)\b/i.test(x);

  const entertainment =
    /\b(pel[ií]cula|serie|actor|actriz|netflix|hbo|max|disney|estreno|oscar|premio|farándula|concierto|[áa]lbum|canci[oó]n|reality)\b/i.test(x) ||
    /\b(movie|series|show|actor|actress|premiere|oscars?|award|celebrity|concert|album|song|reality)\b/i.test(x);

  const food =
    /\b(receta|ingredientes|cocinar|restaurante|men[úu]|delivery|d[óo]nde comer)\b/i.test(x) ||
    /\b(recipe|ingredients|cook|restaurant|menu|delivery|where to eat)\b/i.test(x);

  const politics =
    /\b(pol[ií]tica|elecci[oó]n|presidente|partido|senado|congreso|gobierno|oposici[oó]n)\b/i.test(x) ||
    /\b(politics|election|president|party|senate|congress|government|opposition)\b/i.test(x);

  const mathSci =
    /\b(matem[áa]ticas?|[áa]lgebra|c[aá]lculo|f[ií]sica|qu[ií]mica|biolog[ií]a|astronom[ií]a|ciencia|tecnolog[ií]a|programaci[oó]n|c[oó]digo)\b/i.test(x) ||
    /\b(math|algebra|calculus|physics|chemistry|biology|astronomy|science|technology|programming|code)\b/i.test(x);

  const geoHist =
    /\b(geograf[ií]a|historia)\b/i.test(x) ||
    /\b(geography|history)\b/i.test(x);

  // Excepción: historia/geografía cristiana explícita
  if ((geoHist) && mentionsChristianContext(x)) return null;

  if (sports) return "sports";
  if (entertainment) return "entertainment";
  if (food) return "food";
  if (politics) return "politics";
  if (mathSci) return "science_math";
  if (geoHist) return "geo_history";
  return null;
}

function verseFor(kind, lang="es") {
  const map = {
    sports: {
      es:{text:"El ejercicio corporal aprovecha poco; pero la piedad es útil para todo.",ref:"1 Timoteo 4:8"},
      en:{text:"Physical training is of some value, but godliness has value for all things.",ref:"1 Timothy 4:8"},
      pt:{text:"O exercício físico é de algum valor, mas a piedade é útil para tudo.",ref:"1 Timóteo 4:8"},
      it:{text:"L’esercizio fisico è utile a qualcosa, ma la pietà è utile a tutto.",ref:"1 Timoteo 4:8"},
      de:{text:"Körperliche Übung ist zu wenigem nütze; die Gottseligkeit aber ist zu allem nütze.",ref:"1 Timotheus 4:8"},
      ca:{text:"L’exercici corporal té un cert profit; però la pietat és útil per a tot.",ref:"1 Timoteu 4:8"},
      fr:{text:"L’exercice physique est utile à peu de chose, mais la piété est utile à tout.",ref:"1 Timothée 4:8"}
    },
    entertainment: {
      es:{text:"Todo lo verdadero, honesto, justo, puro, amable... en esto pensad.",ref:"Filipenses 4:8"},
      en:{text:"Whatever is true, honorable, just, pure, lovely... think about these things.",ref:"Philippians 4:8"},
      pt:{text:"Tudo o que é verdadeiro, honroso, justo, puro, amável... nisso pensais.",ref:"Filipenses 4:8"},
      it:{text:"Tutto ciò che è vero, onorevole, giusto, puro, amabile... pensate a queste cose.",ref:"Filippesi 4:8"},
      de:{text:"Alles, was wahr, ehrbar, gerecht, rein, lieblich ist... daran denkt.",ref:"Philipper 4:8"},
      ca:{text:"Tot el que és veritable, honorable, just, pur, amable... penseu en això.",ref:"Filipencs 4:8"},
      fr:{text:"Tout ce qui est vrai, honorable, juste, pur, aimable... pensez à ces choses.",ref:"Philippiens 4:8"}
    },
    food: {
      es:{text:"Sea que comáis o bebáis, hacedlo todo para la gloria de Dios.",ref:"1 Corintios 10:31"},
      en:{text:"Whether you eat or drink, do it all for the glory of God.",ref:"1 Corinthians 10:31"},
      pt:{text:"Quer comais, quer bebais, fazei tudo para a glória de Deus.",ref:"1 Coríntios 10:31"},
      it:{text:"Sia che mangiate, sia che beviate, fate tutto alla gloria di Dio.",ref:"1 Corinzi 10:31"},
      de:{text:"Ob ihr esst oder trinkt – tut alles zur Ehre Gottes.",ref:"1 Korinther 10:31"},
      ca:{text:"Tant si mengeu com si beveu, feu-ho tot per a la glòria de Déu.",ref:"1 Corintis 10:31"},
      fr:{text:"Soit que vous mangiez, soit que vous buviez, faites tout pour la gloire de Dieu.",ref:"1 Corinthiens 10:31"}
    },
    politics: {
      es:{text:"Si es posible, en cuanto dependa de vosotros, estad en paz con todos.",ref:"Romanos 12:18"},
      en:{text:"If possible, as far as it depends on you, live at peace with everyone.",ref:"Romans 12:18"},
      pt:{text:"Se possível, quanto depender de vós, tende paz com todos.",ref:"Romanos 12:18"},
      it:{text:"Se possibile, per quanto dipende da voi, vivete in pace con tutti.",ref:"Romani 12:18"},
      de:{text:"Ist es möglich, so viel an euch liegt, so habt mit allen Menschen Frieden.",ref:"Römer 12:18"},
      ca:{text:"Si és possible, en la mesura que depengui de vosaltres, estigueu en pau amb tothom.",ref:"Romans 12:18"},
      fr:{text:"S’il est possible, autant que cela dépend de vous, soyez en paix avec tous.",ref:"Romains 12:18"}
    },
    science_math: {
      es:{text:"La sabiduría que es de lo alto es primeramente pura, después pacífica…",ref:"Santiago 3:17"},
      en:{text:"The wisdom from above is first pure, then peaceable…",ref:"James 3:17"},
      pt:{text:"A sabedoria do alto é primeiramente pura, depois pacífica…",ref:"Tiago 3:17"},
      it:{text:"La sapienza che viene dall’alto è anzitutto pura, poi pacifica…",ref:"Giacomo 3:17"},
      de:{text:"Die Weisheit von oben ist zuerst rein, danach friedfertig…",ref:"Jakobus 3:17"},
      ca:{text:"La saviesa de dalt és primer pura, després pacífica…",ref:"Jaume 3:17"},
      fr:{text:"La sagesse d’en haut est d’abord pure, ensuite pacifique…",ref:"Jacques 3:17"}
    },
    geo_history: {
      es:{text:"Preguntad por las sendas antiguas… y hallaréis descanso para vuestra alma.",ref:"Jeremías 6:16"},
      en:{text:"Ask for the ancient paths… and you will find rest for your souls.",ref:"Jeremiah 6:16"},
      pt:{text:"Perguntai pelas veredas antigas… e achareis descanso para a vossa alma.",ref:"Jeremias 6:16"},
      it:{text:"Chiedete dei sentieri antichi… e troverete riposo per l’anima vostra.",ref:"Geremia 6:16"},
      de:{text:"Fragt nach den alten Pfaden… so werdet ihr Ruhe finden für eure Seelen.",ref:"Jeremia 6:16"},
      ca:{text:"Pregunteu pels camins antics… i trobareu repòs per a l’ànima.",ref:"Jeremies 6:16"},
      fr:{text:"Interrogez sur les antiques sentiers… et vous trouverez le repos.",ref:"Jérémie 6:16"}
    },
    default: {
      es:{text:"Cercano está el Señor a los quebrantados de corazón.",ref:"Salmos 34:18"},
      en:{text:"The Lord is close to the brokenhearted.",ref:"Psalm 34:18"},
      pt:{text:"Perto está o Senhor dos que têm o coração quebrantado.",ref:"Salmos 34:18"},
      it:{text:"Il Signore è vicino a chi ha il cuore affranto.",ref:"Salmi 34:18"},
      de:{text:"Der HERR ist nahe denen, die zerbrochenen Herzens sind.",ref:"Psalm 34:18"},
      ca:{text:"El Senyor és a prop dels cors trencats.",ref:"Salm 34:18"},
      fr:{text:"L’Éternel est près de ceux qui ont le cœur brisé.",ref:"Psaume 34:18"}
    }
  };
  const k = map[kind] ? kind : "default";
  return t(lang, map[k]);
}

function offTopicReply(kind, lang = "es") {
  const message = t(lang, {
    es:
      kind==="sports" ? "Puedo animarte en lo espiritual y en tus hábitos, pero no doy resultados ni análisis deportivos. Si querés, trabajamos motivación y rutina desde tu realidad."
    : kind==="entertainment" ? "No comento farándula ni estrenos. Estoy aquí para acompañarte por dentro: tus preguntas, decisiones y fe."
    : kind==="food" ? "No doy recetas ni reseñas. Sí puedo ayudarte con la relación con la comida, la ansiedad y hábitos que te hagan bien."
    : kind==="politics" ? "No tomo postura política ni opino de actualidad. Cuidemos tu paz interior, tus relaciones y decisiones con fe."
    : kind==="science_math" ? "No resuelvo matemáticas ni ciencia aplicada. Puedo ayudarte a ordenar tu ánimo, foco y sentido."
    : kind==="geo_history" ? "No doy historia o geografía general. Si es historia de la Iglesia o lugares cristianos, con gusto lo vemos."
    : "Estoy para tu vida interior: fe, emociones y pasos prácticos. Empecemos por lo que hoy te pesa.",
    en:
      kind==="sports" ? "I don’t provide sports results or analysis. I can help with motivation and healthy routines for you."
    : kind==="entertainment" ? "I don’t cover celebrity news or releases. I’m here for your inner life: choices, questions, and faith."
    : kind==="food" ? "I don’t provide recipes or reviews. I can help with your relationship to food, anxiety, and life-giving habits."
    : kind==="politics" ? "I don’t take political stances. Let’s care for your inner peace, relationships, and faith-guided choices."
    : kind==="science_math" ? "I don’t solve math/science questions. I can help with focus, peace, and next steps."
    : kind==="geo_history" ? "I don’t teach general history/geography. For Christian history/places, I’m glad to help."
    : "I’m here for your inner life: faith, emotions, practical steps. What feels heaviest today?",
    // (PT/IT/DE/CA/FR) — (omitidos por brevedad, ya hay versos multilenguaje; mensaje ES/EN cubre UX)
    pt:"Estou aqui para tua vida interior: fé, emoções e passos práticos. O que hoje pesa mais?",
    it:"Sono qui per la tua vita interiore: fede, emozioni e passi concreti. Da dove partiamo oggi?",
    de:"Ich bin für dein Inneres da: Glaube, Gefühle und praktische Schritte. Womit beginnen wir heute?",
    ca:"Soc aquí per la teva vida interior: fe, emocions i passos pràctics. Per on comencem avui?",
    fr:"Je suis là pour ta vie intérieure : foi, émotions, pas concrets. On commence par quoi aujourd’hui ?"
  });

  const question = t(lang, {
    es:
      kind==="sports" ? "¿Querés que definamos un hábito sencillo de movimiento que te sirva hoy?"
    : kind==="entertainment" ? "¿Qué emoción o situación personal te gustaría trabajar ahora mismo?"
    : kind==="food" ? "¿Qué pequeño cambio querés intentar esta semana para cuidarte mejor?"
    : kind==="politics" ? "¿Qué de este tema te inquieta por dentro y quisieras ordenar hoy?"
    : kind==="science_math" ? "¿Qué te preocupa en lo personal de esto y cómo te está afectando?"
    : kind==="geo_history" ? "Si te interesa un tema cristiano en concreto, ¿cuál te gustaría explorar?"
    : "¿Qué pasó hoy de lo que te gustaría hablar?",
    en:
      kind==="sports" ? "Would you like to set a simple movement habit that fits your day?"
    : kind==="entertainment" ? "Which emotion or personal situation would you like to work on right now?"
    : kind==="food" ? "What small change would help you care for yourself this week?"
    : kind==="politics" ? "What about this stirs you inside, and what would you like to put in order today?"
    : kind==="science_math" ? "What’s the personal side of this for you—and how is it affecting you?"
    : kind==="geo_history" ? "If you’re after a Christian theme/place, which one would you like to explore?"
    : "What happened today that you’d like to talk about?",
    pt:"O que aconteceu hoje de que você gostaria de falar?",
    it:"Che cosa è successo oggi di cui vorresti parlare?",
    de:"Was ist heute passiert, worüber du sprechen möchtest?",
    ca:"Què ha passat avui de què t’agradaria parlar?",
    fr:"Qu’est-il arrivé aujourd’hui dont tu aimerais parler ?"
  });

  const bible = verseFor(kind, lang);
  const q = sanitizeSingleQuestion(question, lang, "today");
  return { message: limitWords(message, 75), bible, question: q };
}

// ---- Bienvenida: filtros pregunta ----
function isBadWelcomeQuestion(q=""){
  const x=NORM(q);
  if (!x) return true;
  if (/\b(o|ou|or|oder|o bien|ou bien)\b/.test(x)) return true;
  const hobbyOrPlans = ["hobby","hobbies","pasatiempo","planes","weekend","tiempo libre","what do you like"].some(p=>x.includes(p));
  if (hobbyOrPlans) return true;
  if (/\b(c[oó]mo est[aá]s|how are you)\b/.test(x)) return true;
  return false;
}

// ---- Citas vetadas ----
function isRefMat11_28(ref=""){
  const x = NORM(ref);
  const pats = [
    /mateo\s*11\s*:\s*28/, /mt\.?\s*11\s*:\s*28/, /mat\.?\s*11\s*:\s*28/,
    /matthew?\s*11\s*:\s*28/, /matteo\s*11\s*:\s*28/, /matthäus\s*11\s*:\s*28/,
    /matthieu\s*11\s*:\s*28/, /mateu\s*11\s*:\s*28/, /mateus\s*11\s*:\s*28/
  ];
  return pats.some(r=>r.test(x));
}
const BANNED_REFS = ["Mateo 11:28","Mt 11:28","Mat 11:28","Matthew 11:28","Matteo 11:28","Matthäus 11:28","Matthieu 11:28","Mateu 11:28","Mateus 11:28"];

// ---------- OpenAI formats ----------
const FORMAT_WELCOME = {
  type:"json_schema",
  json_schema:{ name:"WelcomeSchema",
    schema:{ type:"object",
      properties:{ message:{type:"string"}, question:{type:"string"} },
      required:["message","question"], additionalProperties:false
} } };
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
      required:["message","bible","question","q_style"], additionalProperties:false
} } };
const FORMAT_BIBLE_ONLY = {
  type:"json_schema",
  json_schema:{ name:"BibleOnly",
    schema:{ type:"object",
      properties:{ bible:{type:"object",properties:{text:{type:"string"},ref:{type:"string"}},required:["text","ref"]} },
      required:["bible"], additionalProperties:false
} } };

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
    const { lang="es", name="", userId="anon", history=[], hour=null, client_iso=null, tz=null, message_preview="" } = req.body||{};
    const nm = String(name||"").trim();
    const hi = greetingByHour(lang, {hour, client_iso, tz});
    const mem = await readUserMemory(userId);
    const avoidQs = Array.isArray(mem.last_questions)? mem.last_questions.slice(-10):[];
    const shortHistory = compactHistory(history,6,200);

    // Off-topic early pivot (por si el usuario llega con un tema ya en curso)
    let pivotQ = "";
    const offAtStart = detectOffTopic(String(message_preview||""));
    if (offAtStart && !hasPersonalAngle(String(message_preview||""))) {
      pivotQ = offTopicReply(offAtStart, lang).question || "";
    }

    const SYSTEM_PROMPT = `
Eres sereno y concreto. **Céntrate en la situación/problema actual**, no en etiquetar a la persona. Evita muletillas.
SALIDA SOLO JSON (en ${langLabel(lang)}):
- "message": ≤75 palabras. Incluye saludo por franja y **nombre si existe** (p.ej. "${hi}${nm?`, ${nm}`:""}"). Una frase alentadora y disponibilidad. **Sin preguntas** ni citas bíblicas aquí.
- "question": **UNA** pregunta abierta, simple y directa para que el usuario cuente lo de **hoy**. Sin A/B ni dobles.
Evita hobbies/planes/positivismo forzado. No menciones IA/modelos.
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

    let question = sanitizeSingleQuestion(questionRaw, lang, "today");
    if (pivotQ) question = sanitizeSingleQuestion(pivotQ, lang, "today");
    if (!question || isBadWelcomeQuestion(question)){
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
    console.error("WELCOME ERROR:", e);
    const hi = greetingByHour("es");
    const question = "¿Qué pasó hoy de lo que te gustaría hablar?";
    res.status(200).json({
      message: `${hi}. Estoy aquí para escucharte con calma.`,
      bible:{ text:"", ref:"" },
      question
    });
  }
});

// ---------- Biblia: intents + lectura con memoria ----------
function detectBibleIntent(text="", lang="es", mem={}){
  const x=NORM(text);
  if (/(evangelio|lecturas? de hoy|misa de hoy|reading(s)? of today|gospel of today|liturgy of the day)/i.test(x)){
    return { kind:"daily" };
  }
  if (/(contin[úu]a|seguir|segu[ií]|retomar|resum[ei])/i.test(x) && /(lectur|biblia|cap[ií]tulo|vers[ií]culo)/i.test(x)){
    const last = mem?.bible_progress?.last_ref || "";
    if (last) return { kind:"resume", ref:last };
  }
  if (/(lee|leeme|léeme|leer|read)\b.*\b([a-záéíóúüñ ]+)\s*\d+(\s*:\s*\d+(\s*-\s*\d+)?)?/i.test(x)){
    const m = x.match(/(lee|leeme|léeme|leer|read)\b.*\b([a-záéíóúüñ ]+)\s*(\d+(\s*:\s*\d+(\s*-\s*\d+)?)?)/i);
    if (m){
      const book = (m[2]||"").trim();
      const refSuffix = (m[3]||"").replace(/\s+/g,"");
      return { kind:"read_specific", ref: `${book} ${refSuffix}` };
    }
  }
  // patrón simple: "Juan 3", "John 3:16-18"
  const m2 = x.match(/\b([a-záéíóúüñ ]+)\s*\d+(\s*:\s*\d+(\s*-\s*\d+)?)?\b/i);
  if (m2 && /(biblia|evangelio|cap[ií]tulo|vers[ií]culo|lee|leer|read)/i.test(x)){
    const book = (m2[1]||"").trim();
    const refSuffix = (m2[0]||"").replace(book,"").trim();
    return { kind:"read_specific", ref: `${book} ${refSuffix}`.trim() };
  }
  if (/biblia|lee la biblia|leer la biblia|read the bible/i.test(x)){
    return { kind:"read_specific", ref: "Juan 1" };
  }
  return null;
}

async function modelReadBible({ lang="es", ref="", mode="exact", continueAfter=false, approxVerses=8 }={}){
  const SYS = `
Devuelve SOLO JSON {"bible":{"text":"…","ref":"Libro 0:0-0"}} en ${langLabel(lang)}.
- Si "continueAfter"=true, continúa DESPUÉS de ${ref} por ~${approxVerses} versículos (no repitas el último).
- Si "mode"="exact", transcribe el pasaje con fidelidad; numera o separa los versículos si es natural en el idioma.
- No agregues comentarios ni notas. No incluyas nada fuera del JSON.
`;
  const USR = `Referencia: ${ref}\ncontinueAfter: ${continueAfter}\napproxVerses: ${approxVerses}`;
  const r = await completionJson({
    messages:[{role:"system",content:SYS},{role:"user",content:USR}],
    temperature:0.2,
    max_tokens:420,
    response_format: FORMAT_BIBLE_ONLY
  });
  const content = r?.choices?.[0]?.message?.content || "{}";
  let data={}; try{ data=JSON.parse(content);}catch{ data={}; }
  const text = (data?.bible?.text||"").toString().trim();
  const outRef  = cleanRef((data?.bible?.ref||"").toString());
  return text && outRef ? { text, ref: outRef } : null;
}

// ---------- /api/ask ----------
app.post("/api/ask", async (req,res)=>{
  try{
    const { persona="jesus", message="", history=[], userId="anon", lang="es" } = req.body||{};
    const mem = await readUserMemory(userId);
    const userTxt = String(message||"").trim();

    // -------- GUARDRAIL DE DOMINIO --------
    const off = detectOffTopic(userTxt);
    if (off && !hasPersonalAngle(userTxt) && !mentionsChristianContext(userTxt)) {
      const pivot = offTopicReply(off, lang);
      return res.status(200).json(pivot);
    }
    // -------- Biblia: intents --------
    const bIntent = detectBibleIntent(userTxt, lang, mem);
    if (bIntent){
      let reading=null, introMsg="";
      if (bIntent.kind==="daily"){
        introMsg = t(lang,{
          es:"Te leo el Evangelio del día.",
          en:"I’ll read today’s Gospel.",
          pt:"Vou ler o Evangelho de hoje.",
          it:"Ti leggo il Vangelo di oggi.",
          de:"Ich lese dir das Evangelium des Tages.",
          ca:"Et llegeixo l’Evangeli d’avui.",
          fr:"Je te lis l’Évangile du jour."
        });
        reading = await modelReadBible({ lang, ref:"Evangelio del día", mode:"exact", continueAfter:false, approxVerses:10 });
      }else if (bIntent.kind==="resume" && bIntent.ref){
        introMsg = t(lang,{
          es:`Retomamos luego de ${bIntent.ref}.`,
          en:`We’ll continue after ${bIntent.ref}.`,
          pt:`Retomamos após ${bIntent.ref}.`,
          it:`Riprendiamo dopo ${bIntent.ref}.`,
          de:`Wir machen weiter nach ${bIntent.ref}.`,
          ca:`Reprenem després de ${bIntent.ref}.`,
          fr:`Nous continuons après ${bIntent.ref}.`
        });
        reading = await modelReadBible({ lang, ref:bIntent.ref, mode:"exact", continueAfter:true, approxVerses:8 });
      }else if (bIntent.kind==="read_specific" && bIntent.ref){
        introMsg = t(lang,{
          es:`Leemos ${bIntent.ref}.`,
          en:`Let’s read ${bIntent.ref}.`,
          pt:`Vamos ler ${bIntent.ref}.`,
          it:`Leggiamo ${bIntent.ref}.`,
          de:`Lassen wir ${bIntent.ref} lesen.`,
          ca:`Llegim ${bIntent.ref}.`,
          fr:`Lisons ${bIntent.ref}.`
        });
        reading = await modelReadBible({ lang, ref:bIntent.ref, mode:"exact", continueAfter:false, approxVerses:10 });
      }
      if (reading){
        // guardar progreso
        mem.bible_progress.last_ref = reading.ref;
        await writeUserMemory(userId, mem);
        const followQ = t(lang,{
          es:"¿Seguimos un poco más o lo dejamos aquí para mañana?",
          en:"Shall we read a bit more, or pause here for tomorrow?",
          pt:"Lemos mais um pouco ou paramos por hoje?",
          it:"Proseguiamo un po’ o lasciamo per domani?",
          de:"Lesen wir noch etwas weiter oder pausieren wir bis morgen?",
          ca:"Seguim una mica més o ho deixem per demà?",
          fr:"On lit encore un peu, ou on s’arrête pour demain ?"
        });
        return res.status(200).json({
          message: limitWords(stripQuestionsFromMessage(introMsg), 75),
          bible: { text: reading.text, ref: reading.ref },
          question: sanitizeSingleQuestion(followQ, lang, "today")
        });
      }
      // si falló la lectura, seguimos flujo normal…
    }

    // -------- Flujo normal (explore/permiso/execute) --------
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

    const TOPIC_HINT = {
      relationship: { es:"tu pareja", en:"your partner", pt:"sua parceria", it:"il tuo partner", de:"deinem Partner", ca:"la teva parella", fr:"ton/ta partenaire" },
      separation:   { es:"esta separación", en:"this separation", pt:"esta separação", it:"questa separazione", de:"diese Trennung", ca:"aquesta separació", fr:"cette séparation" },
      family_conflict: { es:"tu familia", en:"your family", pt:"sua família", it:"la tua famiglia", de:"deiner Familie", ca:"la teva família", fr:"ta famille" },
      mood: { es:"tus emociones", en:"your emotions", pt:"suas emoções", it:"le tue emozioni", de:"deine Gefühle", ca:"les teves emocions", fr:"tes émotions" },
      grief: { es:"tu duelo", en:"your grief", pt:"seu luto", it:"il tuo lutto", de:"deine Trauer", ca:"el teu dol", fr:"ton deuil" },
      health: { es:"tu salud", en:"your health", pt:"sua saúde", it:"la tua salute", de:"deine Gesundheit", ca:"la teva salut", fr:"ta santé" },
      work_finance: { es:"tu trabajo o finanzas", en:"your work or finances", pt:"seu trabalho ou finanças", it:"il tuo lavoro o finanze", de:"deine Arbeit oder Finanzen", ca:"la teva feina o finances", fr:"ton travail ou tes finances" },
      addiction: { es:"tu proceso de recuperación", en:"your recovery process", pt:"seu processo de recuperação", it:"il tuo percorso de recupero", de:"deinen Genesungsweg", ca:"el teu procés de recuperació", fr:"ton chemin de rétablissement" },
      faith: { es:"tu fe", en:"your faith", pt:"sua fé", it:"la tua fede", de:"deinen Glauben", ca:"la teva fe", fr:"ta foi" }
    }[topic]?.[lang] || null;

    const SYSTEM_PROMPT = `
Hablas con serenidad y **te enfocas en la situación/problema**, no en etiquetar a la persona. Lenguaje clínico, concreto, sin muletillas.

MODO: ${MODE}; RECENCY: ${recency}

SALIDA SOLO JSON (en ${langLabel(lang)}):
- "message": ≤75 palabras, **sin signos de pregunta**.
  * explore: 1–2 validaciones concretas (no poéticas) + **1 micro-acción distinta de las recientes** (time_out_24h, no_escalar, guion_dialogo_pareja, oars_escucha, behavioral_activation leve, opposite_action, cognitive_reframe 1 pensamiento, apoyo_red_social hoy, walk_10min, hydrate). Evita “escritura/diario” salvo que el usuario lo pida.
  * permiso: 1–2 rumbos claros (p.ej., **guion** con ${TOPIC_HINT||"la otra persona"} / **límites asertivos**).
  * execute: guía paso a paso (1–3 min si aplica).
- "bible": texto + ref ajustada al contexto (evita ${[...avoidRefs, ...BANNED_REFS].join(" | ")||"(ninguna)"}).
- "question": **UNA** (sin A/B ni dobles):
   explore → focal (qué pasó, desde cuándo según RECENCY, dónde impacta);
   permiso → permiso específico (“¿Querés que te diga **qué decir y cómo**?”);
   execute → check-in/ajuste.
- "techniques": etiquetas si usas técnicas.
- "q_style": etiqueta del estilo de pregunta.

PRIORIZA autoayuda concreta. No repitas técnicas usadas recién: ${avoidTech.join(", ")||"(ninguna)"}.
No menciones IA/modelos.
`;

    const header =
      `Persona: ${persona}\nLang: ${lang}\nMensaje_usuario: ${userTxt}\n`+
      (compactHistory(history,10,240).length?`Historial: ${compactHistory(history,10,240).join(" | ")}`:"Historial: (sin)")+"\n"+
      `FRAME: ${JSON.stringify(frame)}\n`;

    let r = await completionJson({
      messages: [{role:"system",content:SYSTEM_PROMPT},{role:"user",content:header}],
      temperature:0.6, max_tokens:360, response_format: FORMAT_ASK
    });

    const content = r?.choices?.[0]?.message?.content || "{}";
    let data={}; try{ data=JSON.parse(content);}catch{ data={}; }

    let msg = limitWords(stripQuestionsFromMessage(removeBibleLike(String(data?.message||""))), 75);
    let ref = cleanRef(String(data?.bible?.ref||""));
    let text = String(data?.bible?.text||"").trim();
    let questionRaw = String(data?.question||"").trim();
    let techniques = Array.isArray(data?.techniques)? data.techniques.map(String) : [];
    let q_style = String(data?.q_style||"").trim();

    let question = detectByeThanks(userTxt) ? "" : sanitizeSingleQuestion(questionRaw, lang, recency);

    if (!detectByeThanks(userTxt) && (!question || BAD_GENERIC_Q.test(question))){
      const SYS2 = SYSTEM_PROMPT + `\nAjusta la "question": una sola, natural, específica al tema, sin A/B ni dobles, congruente con RECENCY=${recency}.`;
      const r2 = await completionJson({
        messages: [{role:"system",content:SYS2},{role:"user",content:header}],
        temperature:0.65, max_tokens:340, response_format: FORMAT_ASK
      });
      const c2 = r2?.choices?.[0]?.message?.content || "{}";
      let d2={}; try{ d2=JSON.parse(c2);}catch{ d2={}; }
      msg = limitWords(stripQuestionsFromMessage(removeBibleLike(String(d2?.message||msg||""))), 75);
      ref = cleanRef(String(d2?.bible?.ref||ref||""));
      text = String(d2?.bible?.text||text||"").trim();
      question = sanitizeSingleQuestion(String(d2?.question||question||"").trim(), lang, recency);
      techniques = Array.isArray(d2?.techniques)? d2.techniques.map(String) : techniques;
      q_style = String(d2?.q_style||q_style||"").trim();
    }

    // Anti “escritura/respiración/caminar/hidratar” consecutivas
    const lastTech = (mem.last_techniques || []).slice(-1)[0] || "";
    const usedWriting = (t)=> t==="writing_optional" || /escrit|diario/i.test(t);
    const usedBreath  = (t)=> t==="breathing_exhale46" || /breath|respir/i.test(t);
    const usedWalk    = (t)=> t==="walk_10min" || /caminar|walk/i.test(t);
    const usedHydrate = (t)=> t==="hydrate" || /hidratar|water|agua/i.test(t);
    const thisHas = (pred)=> (techniques||[]).some(pred) || pred(msg);

    if (lastTech){
      if (usedWriting(lastTech) && thisHas(usedWriting)
       || usedBreath(lastTech)  && thisHas(usedBreath)
       || usedWalk(lastTech)    && thisHas(usedWalk)
       || usedHydrate(lastTech) && thisHas(usedHydrate)){
        const SYS3 = SYSTEM_PROMPT + `\nEvita repetir la misma técnica consecutiva; ofrece otra diferente (no_escalar, time_out_24h, oars_escucha, guion_dialogo_pareja, cognitive_reframe, opposite_action, behavioral_activation, apoyo_red_social).`;
        const r3 = await completionJson({
          messages: [{role:"system",content:SYS3},{role:"user",content:header}],
          temperature:0.6, max_tokens:330, response_format: FORMAT_ASK
        });
        const c3 = r3?.choices?.[0]?.message?.content || "{}";
        let d3={}; try{ d3=JSON.parse(c3);}catch{ d3={}; }
        msg = limitWords(stripQuestionsFromMessage(removeBibleLike(String(d3?.message||msg||""))), 75);
        ref = cleanRef(String(d3?.bible?.ref||ref||""));
        text = String(d3?.bible?.text||text||"").trim();
        question = sanitizeSingleQuestion(String(d3?.question||question||"").trim(), lang, recency);
        techniques = Array.isArray(d3?.techniques)? d3.techniques.map(String) : techniques;
        q_style = String(d3?.q_style||q_style||"").trim();
      }
    }

    // Evitar cita repetida / vetada
    const avoidSet = new Set((mem.last_bible_refs||[]).map(x=>NORM(cleanRef(x))));
    if (!ref || avoidSet.has(NORM(ref)) || isRefMat11_28(ref)){
      const alt = await (async()=>{
        const SYS = `
Devuelve SOLO JSON {"bible":{"text":"…","ref":"Libro 0:0"}} en ${langLabel(lang)} evitando estas referencias: ${[...avoidSet, ...BANNED_REFS].size?Array.from(avoidSet).concat(BANNED_REFS).join(" | "):"(ninguna)"}.
No agregues nada fuera del JSON.`;
        const r = await completionJson({
          messages:[{role:"system",content:SYS},{role:"user",content:`Tema: ${guessTopic(userTxt)}\nMensaje: ${userTxt}`}],
          temperature:0.4, max_tokens:120, response_format: FORMAT_BIBLE_ONLY
        });
        const c = r?.choices?.[0]?.message?.content || "{}";
        let d={}; try{ d=JSON.parse(c);}catch{ d={}; }
        const tx = (d?.bible?.text||"").toString().trim();
        const rf = cleanRef((d?.bible?.ref||"").toString());
        return tx && rf ? { text:tx, ref:rf } : null;
      })();
      if (alt){ ref = alt.ref; text = alt.text; }
    }
    if (isRefMat11_28(ref)) {
      ref = (lang==="en"?"Psalm 34:18":"Salmos 34:18");
      text = (lang==="en"?"The Lord is close to the brokenhearted and saves those who are crushed in spirit.":"Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu.");
    }

    // Persistencia
    const cleanedRef = cleanRef(ref);
    if (cleanedRef){
      mem.last_bible_refs = Array.isArray(mem.last_bible_refs)? mem.last_bible_refs : [];
      mem.last_bible_refs.push(cleanedRef);
      while(mem.last_bible_refs.length>8) mem.last_bible_refs.shift();
    }
    if (question){
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
      message: msg || (lang==="en"?"I am with you. Let’s take one practical step.":"Estoy contigo. Demos un paso práctico."),
      bible: { text: text || (lang==="en"?"The Lord is close to the brokenhearted.":"Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu."), ref: cleanedRef || (lang==="en"?"Psalm 34:18":"Salmos 34:18") }
    };
    if (!detectByeThanks(userTxt) && question) out.question = question;

    res.status(200).json(out);
  }catch(err){
    console.error("ASK ERROR:", err);
    res.status(200).json({
      message:"La paz sea contigo. Contame en pocas palabras lo esencial y seguimos paso a paso.",
      bible:{ text:"Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu.", ref:"Salmos 34:18" }
    });
  }
});

// ---------- HeyGen (token/config) ----------
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
