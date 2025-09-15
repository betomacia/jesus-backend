// index.js — Bienvenida espiritual (≤75 palabras) + IA genera preguntas personales/oferta
// (sin listas fijas), antirepetición (citas/preguntas), memoria con last_offer/last_topic/checkins,
// manejo de sí/no por idioma, HeyGen y CORS.
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
const NORM = (s = "") => String(s).toLowerCase().replace(/\s+/g, " ").trim();

function cleanRef(ref = "") {
  return String(ref).replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
}
function stripQuestionsFromMessage(s = "") {
  const noTrailingQ = String(s)
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => !/\?\s*$/.test(l))
    .join("\n")
    .trim();
  return noTrailingQ.replace(/[¿?]+/g, "").trim();
}
function limitWords(s = "", max = 75) {
  const w = String(s).trim().split(/\s+/);
  return w.length <= max ? String(s).trim() : w.slice(0, max).join(" ").trim();
}
function compactHistory(history = [], keep = 8, maxLen = 260) {
  const arr = Array.isArray(history) ? history : [];
  return arr.slice(-keep).map((x) => String(x).slice(0, maxLen));
}
function langLabel(l = "es") {
  const m = { es: "Español", en: "English", pt: "Português", it: "Italiano", de: "Deutsch", ca: "Català", fr: "Français" };
  return m[l] || "Español";
}
function greetingByHour(lang = "es") {
  const h = new Date().getHours();
  const g = (m, a, n) => (h < 12 ? m : h < 19 ? a : n);
  switch (lang) {
    case "en":
      return g("Good morning", "Good afternoon", "Good evening");
    case "pt":
      return g("Bom dia", "Boa tarde", "Boa noite");
    case "it":
      return g("Buongiorno", "Buon pomeriggio", "Buonasera");
    case "de":
      return g("Guten Morgen", "Guten Tag", "Guten Abend");
    case "ca":
      return g("Bon dia", "Bona tarda", "Bona nit");
    case "fr":
      return g("Bonjour", "Bon après-midi", "Bonsoir");
    default:
      return g("Buenos días", "Buenas tardes", "Buenas noches");
  }
}

// Vocativos y bendiciones espirituales
function pickVocative(lang = "es", gender = "unknown") {
  const rnd = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const ES_neutral = ["alma amada", "hija del Altísimo", "alma querida", "amado del Señor", "corazón buscador"];
  const ES_f = ["hija mía", "alma amada", "hija querida", "amiga del Señor", "corazón valiente"];
  const ES_m = ["hijo mío", "alma amada", "hijo querido", "amigo del Señor", "corazón valiente"];
  if (lang === "en") return rnd(["beloved soul","dear daughter of the Most High","dear heart","beloved child","seeker of light"]);
  if (lang === "pt") return rnd(["alma amada","filha/o do Altíssimo","coração querido","alma querida","filho/a amado/a"]);
  if (lang === "it") return rnd(["anima amata","figlia/figlio dell’Altissimo","cuore caro","anima cara","figlia/figlio amato/a"]);
  if (lang === "de") return rnd(["geliebte Seele","liebes Herz","Kind des Höchsten","teure Seele","geliebtes Kind"]);
  if (lang === "ca") return rnd(["ànima estimada","cor estimat","fill/a de l’Altíssim","ànima volguda","fill/a estimat/da"]);
  if (lang === "fr") return rnd(["âme bien-aimée","cher cœur","enfant du Très-Haut","âme chérie","enfant bien-aimé"]);
  if (gender === "female") return rnd(ES_f);
  if (gender === "male") return rnd(ES_m);
  return rnd(ES_neutral);
}
function pickBlessing(lang = "es") {
  const rnd = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const ES = [
    "que la paz del Señor esté siempre contigo",
    "que el amor de Dios te sostenga",
    "que el Espíritu te fortalezca en lo profundo",
    "que Cristo ilumine tus pasos",
  ];
  const EN = [
    "may the peace of the Lord be with you",
    "may God’s love sustain you",
    "may the Spirit strengthen you within",
    "may Christ light your steps",
  ];
  const PT = ["que a paz do Senhor esteja contigo", "que o amor de Deus te sustente", "que o Espírito te fortaleça", "que Cristo ilumine teus passos"];
  const IT = ["che la pace del Signore sia con te", "che l’amore di Dio ti sorregga", "che lo Spirito ti fortifichi", "che Cristo illumini i tuoi passi"];
  const DE = ["möge der Friede des Herrn mit dir sein", "möge Gottes Liebe dich tragen", "möge der Geist dich stärken", "möge Christus deine Schritte erleuchten"];
  const CA = ["que la pau del Senyor sigui amb tu", "que l’amor de Déu et sostingui", "que l’Esperit t’enforteixi", "que Crist il·lumini els teus passos"];
  const FR = ["que la paix du Seigneur soit avec toi", "que l’amour de Dieu te soutienne", "que l’Esprit te fortifie", "que le Christ éclaire tes pas"];
  switch (lang) {
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
function removeBibleLike(text = "") {
  let s = String(text || "");
  s = s.replace(/^[\s]*[—-]\s*.*?\([^)]+?\d+\s*:\s*\d+\)[\s]*$/gim, "").trim();
  s = s.replace(/\(([^)]+?\d+\s*:\s*\d+)\)/g, () => "");
  s = s.replace(/\s*[—-]\s*[^()]*\(\s*[^)]+?\d+\s*:\s*\d+\s*\)\s*$/g, "").trim();
  return s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ---------- Memoria en FS ----------
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
async function ensureDataDir() { try { await fs.mkdir(DATA_DIR, { recursive: true }); } catch {} }
function memPath(uid) {
  const safe = String(uid || "anon").replace(/[^a-z0-9_-]/gi, "_");
  return path.join(DATA_DIR, `mem_${safe}.json`);
}
async function readUserMemory(userId) {
  await ensureDataDir();
  try {
    const raw = await fs.readFile(memPath(userId), "utf8");
    return JSON.parse(raw);
  } catch {
    return {
      last_bible_refs: [],
      last_questions: [],
      frame: null,
      last_offer: null,
      last_topic: null,
      checkins: [],
    };
  }
}
async function writeUserMemory(userId, mem) {
  await ensureDataDir();
  await fs.writeFile(memPath(userId), JSON.stringify(mem, null, 2), "utf8");
}

// ---------- Heurísticas de tema ----------
function guessTopic(s = "") {
  const t = (s || "").toLowerCase();
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
function detectMainSubject(s = "") {
  const t = (s || "").toLowerCase();
  if (/(mi\s+espos|mi\s+marid)/.test(t)) return "partner";
  if (/(mi\s+novi[oa])/.test(t)) return "partner";
  if (/(mi\s+hij[oa])/.test(t)) return "child";
  if (/(mi\s+madre|mam[aá])/.test(t)) return "mother";
  if (/(mi\s+padre|pap[aá])/.test(t)) return "father";
  if (/(mi\s+herman[oa])/.test(t)) return "sibling";
  if (/(mi\s+amig[oa])/.test(t)) return "friend";
  return "self";
}

// ---------- Detección sí/no multilenguaje ----------
function detectYesNo(lang = "es", text = "") {
  const s = NORM(text);
  const YES = ["si","sí","dale","ok","de acuerdo","claro","por favor","hazlo","vale","yes","yep","yeah","sure","please","okey","sim","certo","claro","ok","sì","va bene","ja","gern","klar","oui","d’accord","bien sûr"];
  const NO  = ["no","no gracias","mejor no","ahora no","no quiero","nope","nah","not now","no thanks","não","agora não","no grazie","nein","lieber nicht","no gràcies","non","pas maintenant"];
  if (YES.some((w) => s === w || s.startsWith(w + " "))) return "yes";
  if (NO.some((w) => s === w || s.startsWith(w + " "))) return "no";
  return null;
}

// ---------- Pool de citas para fallback ----------
function versePoolByTopic(lang = "es") {
  const ES = {
    mood: [
      { ref: "Isaías 41:10", text: "No temas, porque yo estoy contigo; no desmayes, porque yo soy tu Dios que te esfuerzo." },
      { ref: "Filipenses 4:6-7", text: "Por nada estéis afanosos... y la paz de Dios... guardará vuestros corazones." },
      { ref: "Salmos 55:22", text: "Echa sobre Jehová tu carga, y él te sustentará." },
    ],
    grief: [
      { ref: "Salmos 34:18", text: "Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu." },
      { ref: "Mateo 5:4", text: "Bienaventurados los que lloran, porque ellos recibirán consolación." },
      { ref: "Apocalipsis 21:4", text: "Enjugará Dios toda lágrima de los ojos de ellos." },
    ],
    relationship: [
      { ref: "1 Corintios 13:4-7", text: "El amor es sufrido, es benigno... todo lo sufre, todo lo cree, todo lo espera." },
      { ref: "Efesios 4:32", text: "Sed benignos unos con otros, misericordiosos, perdonándoos unos a otros." },
      { ref: "Romanos 12:18", text: "Si es posible, en cuanto dependa de vosotros, estad en paz con todos." },
    ],
    work_finance: [
      { ref: "Mateo 6:34", text: "No os afanéis por el día de mañana; porque el día de mañana traerá su afán." },
      { ref: "Proverbios 16:3", text: "Encomienda a Jehová tus obras, y tus pensamientos serán afirmados." },
      { ref: "Filipenses 4:19", text: "Mi Dios, pues, suplirá todo lo que os falta..." },
    ],
    health: [
      { ref: "Salmos 103:2-3", text: "Él es quien sana todas tus dolencias." },
      { ref: "Jeremías 30:17", text: "Porque yo haré venir sanidad para ti, y te sanaré de tus heridas." },
      { ref: "3 Juan 1:2", text: "Ruego que seas prosperado en todas las cosas, y que tengas salud." },
    ],
    faith: [
      { ref: "Proverbios 3:5-6", text: "Fíate de Jehová de todo tu corazón... y él enderezará tus veredas." },
      { ref: "Hebreos 11:1", text: "La fe es la certeza de lo que se espera, la convicción de lo que no se ve." },
      { ref: "Juan 14:27", text: "La paz os dejo, mi paz os doy; no se turbe vuestro corazón, ni tenga miedo." },
    ],
    separation: [
      { ref: "Salmos 147:3", text: "Él sana a los quebrantados de corazón, y venda sus heridas." },
      { ref: "Isaías 43:2", text: "Cuando pases por las aguas, yo estaré contigo." },
      { ref: "Romanos 8:28", text: "A los que aman a Dios, todas las cosas les ayudan a bien." },
    ],
    addiction: [
      { ref: "1 Corintios 10:13", text: "Fiel es Dios, que no os dejará ser tentados más de lo que podéis resistir." },
      { ref: "Gálatas 5:1", text: "Estad, pues, firmes en la libertad con que Cristo nos hizo libres." },
      { ref: "Salmos 40:1-2", text: "Me hizo sacar del pozo de la desesperación, del lodo cenagoso." },
    ],
    family_conflict: [
      { ref: "Santiago 1:19", text: "Todo hombre sea pronto para oír, tardo para hablar, tardo para airarse." },
      { ref: "Colosenses 3:13", text: "Soportándoos unos a otros, y perdonándoos unos a otros." },
      { ref: "Romanos 12:10", text: "Amaos los unos a los otros con amor fraternal." },
    ],
    general: [
      { ref: "Salmos 23:1", text: "Jehová es mi pastor; nada me faltará." },
      { ref: "1 Pedro 5:7", text: "Echando toda vuestra ansiedad sobre él, porque él tiene cuidado de vosotros." },
      { ref: "Isaías 40:31", text: "Los que esperan a Jehová tendrán nuevas fuerzas." },
    ],
  };
  const EN = {
    mood: [
      { ref: "Isaiah 41:10", text: "Do not fear, for I am with you..." },
      { ref: "Philippians 4:6-7", text: "Do not be anxious about anything..." },
      { ref: "Psalm 55:22", text: "Cast your cares on the Lord..." },
    ],
    grief: [
      { ref: "Psalm 34:18", text: "The Lord is close to the brokenhearted..." },
      { ref: "Matthew 5:4", text: "Blessed are those who mourn..." },
      { ref: "Revelation 21:4", text: "He will wipe every tear..." },
    ],
    relationship: [
      { ref: "1 Corinthians 13:4-7", text: "Love is patient, love is kind..." },
      { ref: "Ephesians 4:32", text: "Be kind and compassionate..." },
      { ref: "Romans 12:18", text: "As far as it depends on you, live at peace..." },
    ],
    work_finance: [
      { ref: "Matthew 6:34", text: "Do not worry about tomorrow..." },
      { ref: "Proverbs 16:3", text: "Commit to the Lord whatever you do..." },
      { ref: "Philippians 4:19", text: "My God will meet all your needs..." },
    ],
    health: [
      { ref: "Psalm 103:2-3", text: "He heals all your diseases." },
      { ref: "Jeremiah 30:17", text: "I will restore you to health..." },
      { ref: "3 John 1:2", text: "I pray that you may enjoy good health." },
    ],
    faith: [
      { ref: "Proverbs 3:5-6", text: "Trust in the Lord with all your heart..." },
      { ref: "Hebrews 11:1", text: "Faith is confidence in what we hope for..." },
      { ref: "John 14:27", text: "Peace I leave with you..." },
    ],
    separation: [
      { ref: "Psalm 147:3", text: "He heals the brokenhearted..." },
      { ref: "Isaiah 43:2", text: "When you pass through the waters..." },
      { ref: "Romans 8:28", text: "God works for the good..." },
    ],
    addiction: [
      { ref: "1 Corinthians 10:13", text: "God is faithful; he will not let you be tempted..." },
      { ref: "Galatians 5:1", text: "It is for freedom that Christ has set us free." },
      { ref: "Psalm 40:1-2", text: "He lifted me out of the slimy pit..." },
    ],
    family_conflict: [
      { ref: "James 1:19", text: "Quick to listen, slow to speak..." },
      { ref: "Colossians 3:13", text: "Bear with and forgive each other." },
      { ref: "Romans 12:10", text: "Be devoted to one another in love." },
    ],
    general: [
      { ref: "Psalm 23:1", text: "The Lord is my shepherd..." },
      { ref: "1 Peter 5:7", text: "Cast all your anxiety on him..." },
      { ref: "Isaiah 40:31", text: "Those who hope in the Lord..." },
    ],
  };
  return lang === "en" ? EN : ES;
}
function pickAltVerse(lang = "es", topic = "general", avoid = []) {
  const pool = versePoolByTopic(lang);
  const list = pool[topic] || pool.general || [];
  const avoidSet = new Set(avoid.map((r) => NORM(cleanRef(r))));
  for (const v of list) if (!avoidSet.has(NORM(cleanRef(v.ref)))) return v;
  if (topic !== "general") for (const v of pool.general) if (!avoidSet.has(NORM(cleanRef(v.ref)))) return v;
  return list[0] || pool.general[0] || {
    ref: lang === "en" ? "Psalm 34:18" : "Salmos 34:18",
    text: lang === "en" ? "The Lord is close to the brokenhearted." : "Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu.",
  };
}

// ---------- OpenAI helper ----------
const RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "SpiritualGuidance",
    schema: {
      type: "object",
      properties: {
        message: { type: "string" },
        bible: { type: "object", properties: { text: { type: "string" }, ref: { type: "string" } }, required: ["text", "ref"] },
        question: { type: "string" },
      },
      required: ["message", "bible"],
      additionalProperties: false,
    },
  },
};
async function completionJson({ messages, temperature = 0.6, max_tokens = 240, timeoutMs = 12000 }) {
  const call = openai.chat.completions.create({
    model: "gpt-4o",
    temperature,
    max_tokens,
    messages,
    response_format: RESPONSE_FORMAT,
  });
  return await Promise.race([call, new Promise((_, rej) => setTimeout(() => rej(new Error("TIMEOUT")), timeoutMs))]);
}

// ---------- Health ----------
app.get("/", (_req, res) => res.json({ ok: true, service: "backend", ts: Date.now() }));
app.get("/api/welcome", (_req, res) => res.json({ ok: true, hint: "POST /api/welcome { lang, name, userId, gender?, history }" }));
app.post("/api/memory/sync", (_req, res) => res.json({ ok: true }));

// ---------- Prompt helpers (IA genera preguntas variadas) ----------
function questionGuidelines(lang = "es", avoidQs = [], mode = "auto") {
  // mode: "auto" (IA decide personal vs oferta), "personal", "offer"
  const avoidJoined = avoidQs.map((q) => `"${q}"`).join(", ") || "(none)";
  const ES = `
- Genera UNA sola pregunta (termina en "?"), breve (6–16 palabras), cálida.
- Puede ser PERSONAL (para entender mejor la situación) u OFERTA (proponiendo ayuda concreta).
- Parafrasea creativamente: evita sinónimos triviales de preguntas recientes y evita estas exactas: ${avoidJoined}.
- No repitas fórmulas obvias ("¿Cómo estás hoy?", "¿En qué puedo ayudarte?").
- Ajusta al tema y al tono pastoral (servicial + autoayuda + espiritual).
${mode !== "auto" ? `- Esta vez prefiere el estilo: ${mode.toUpperCase()}.` : ""}
`;
  const EN = `
- Produce ONE concise question (6–16 words), warm, ending with "?".
- It can be PERSONAL (to understand) or OFFER (proposing concrete help).
- Paraphrase creatively; avoid echoing recent questions and these exact ones: ${avoidJoined}.
- Do not use generic formulas ("How are you today?", "How can I help?").
- Fit the topic and pastoral tone (service + self-help + spiritual).
${mode !== "auto" ? `- Prefer this style now: ${mode.toUpperCase()}.` : ""}
`;
  const map = { es: ES, en: EN,
    pt: EN, it: EN, de: EN, ca: EN, fr: EN // reusar EN como guía (modelo es multilingüe)
  };
  return map[lang] || ES;
}

// ---------- WELCOME ----------
app.post("/api/welcome", async (req, res) => {
  try {
    const { lang = "es", name = "", userId = "anon", gender = "unknown", history = [] } = req.body || {};
    const nm = String(name || "").trim();
    const hi = greetingByHour(lang);
    const voc = pickVocative(lang, gender);
    const blessing = pickBlessing(lang);

    const mem = await readUserMemory(userId);
    const avoidRefs = Array.isArray(mem.last_bible_refs) ? mem.last_bible_refs.slice(-8) : [];
    const avoidQs = Array.isArray(mem.last_questions) ? mem.last_questions.slice(-10) : [];

    // Prelude (saludo + toque espiritual + una frase alentadora añadida por IA)
    const prelude = `${hi}${nm ? `, ${nm}` : ""}. ${voc[0].toUpperCase() + voc.slice(1)}, ${blessing}.`;

    const SYSTEM_PROMPT = `
Hablas con serenidad, claridad y compasión.
Salida SOLO JSON.
"message": comienza EXACTAMENTE con: "${prelude}"
Después añade UNA sola frase breve de aliento para el día (autoayuda simple + toque espiritual). Sin preguntas. Máximo 75 palabras totales. No incluyas citas ni referencias bíblicas en "message".
"bible": cita pertinente (texto + ref) de esperanza/ánimo.
"question": crea tú mismo UNA pregunta **nueva** siguiendo estas pautas:
${questionGuidelines(lang, avoidQs, "auto")}
Responde SIEMPRE en ${langLabel(lang)}.
Evita estas referencias exactas: ${avoidRefs.map((r) => `"${r}"`).join(", ") || "(ninguna)"}.
`;

    const shortHistory = compactHistory(history, 6, 200);
    const header =
      `Lang: ${lang}\n` +
      `Nombre: ${nm || "(anónimo)"}\n` +
      (shortHistory.length ? `Historial: ${shortHistory.join(" | ")}` : "Historial: (sin antecedentes)") +
      "\n";

    const r = await completionJson({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: header },
      ],
      temperature: 0.7,
      max_tokens: 220,
    });

    const content = r?.choices?.[0]?.message?.content || "{}";
    let data = {};
    try { data = JSON.parse(content); } catch { data = {}; }

    let msg = limitWords(stripQuestionsFromMessage(removeBibleLike(String(data?.message || ""))), 75);
    if (!msg.startsWith(prelude)) msg = `${prelude} ${msg}`.trim();

    let ref = cleanRef(String(data?.bible?.ref || ""));
    let text = String(data?.bible?.text || "").trim();
    let question = String(data?.question || "").trim();
    if (question && !/\?\s*$/.test(question)) question += "?";

    // Antirepetición de cita
    const avoidRefSet = new Set(avoidRefs.map((x) => NORM(cleanRef(x))));
    if (!ref || avoidRefSet.has(NORM(cleanRef(ref)))) {
      const alt = pickAltVerse(lang, "general", avoidRefs);
      ref = alt.ref; text = alt.text;
    }

    // Guardar pregunta y posibles estados
    if (question) {
      const arr = Array.isArray(mem.last_questions) ? mem.last_questions : [];
      arr.push(question); while (arr.length > 10) arr.shift();
      mem.last_questions = arr;
    }
    // Bienvenida: no fijamos oferta específica aún
    mem.last_offer = null;

    await writeUserMemory(userId, mem);

    res.status(200).json({
      message: msg || `${prelude} Comparte en pocas palabras y damos un paso sencillo.`,
      bible: { text: text || (lang === "en" ? "The Lord is close to the brokenhearted." : "Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu."), ref: ref || (lang === "en" ? "Psalm 34:18" : "Salmos 34:18") },
      question
    });
  } catch (e) {
    console.error("WELCOME ERROR:", e);
    const hi = greetingByHour("es");
    res.status(200).json({
      message: `${hi}. Alma amada, que la paz del Señor esté siempre contigo. Cuéntame en pocas palabras qué te trae hoy.`,
      bible: { text: "Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu.", ref: "Salmos 34:18" },
      question: "¿Qué te gustaría poner en palabras hoy?",
    });
  }
});

// ---------- ASK (≤75 palabras, IA genera pregunta variada, sí/no, antirepetición cita) ----------
app.post("/api/ask", async (req, res) => {
  try {
    const { persona = "jesus", message = "", history = [], userId = "anon", lang = "es" } = req.body || {};
    const mem = await readUserMemory(userId);

    const topic = guessTopic(message);
    const mainSubject = detectMainSubject(message);
    const frame = {
      topic_primary: topic,
      main_subject: mem.frame?.topic_primary === topic ? mem.frame?.main_subject || mainSubject : mainSubject,
      support_persons: mem.frame?.topic_primary === topic ? mem.frame?.support_persons || [] : [],
    };
    mem.frame = frame;

    const avoidRefs = Array.isArray(mem.last_bible_refs) ? mem.last_bible_refs.slice(-8) : [];
    const avoidQs = Array.isArray(mem.last_questions) ? mem.last_questions.slice(-10) : [];
    const shortHistory = compactHistory(history, 10, 240);

    // Sí/No ante posible oferta previa
    const yn = detectYesNo(lang, message);
    if (yn && mem.last_offer) {
      const alt = pickAltVerse(lang, topic, avoidRefs);
      if (yn === "yes") {
        const body = realizeOffer(mem.last_offer.type || "step_today", lang, topic);
        const msg = limitWords(stripQuestionsFromMessage(body), 75);

        // check-in recordable
        const ck = (topic === "relationship" ? (lang === "en" ? "that gesture of love" : "ese gesto de amor")
                  : topic === "mood" ? (lang === "en" ? "the 3-breath cycle" : "la respiración de 3 ciclos")
                  : (lang === "en" ? "today’s small step" : "el paso pequeño de hoy"));
        const cks = Array.isArray(mem.checkins) ? mem.checkins : [];
        if (ck) { cks.push(ck); while (cks.length > 5) cks.shift(); mem.checkins = cks; }

        // memoria de cita
        const cleanedRef = cleanRef(alt.ref);
        if (cleanedRef) {
          const arr = avoidRefs.slice();
          arr.push(cleanedRef); while (arr.length > 8) arr.shift();
          mem.last_bible_refs = arr;
        }
        mem.last_offer = null; // cumplida

        await writeUserMemory(userId, mem);
        return res.status(200).json({
          message: msg || (lang === "en" ? "Here is a gentle step for today." : "Aquí tienes un paso sencillo para hoy."),
          bible: { text: alt.text, ref: alt.ref },
          question: (lang === "en" ? "What would you like to share next?" : "¿Qué te gustaría compartir después?")
        });
      } else {
        // no → alternativa suave y dejamos que IA elija nueva pregunta
        const soft = lang === "en" ? "All right. Let’s try something kinder for you." : "Está bien. Probemos algo más amable para ti.";
        const msg = limitWords(stripQuestionsFromMessage(soft), 75);
        const cleanedRef = cleanRef(alt.ref);
        if (cleanedRef) {
          const arr = avoidRefs.slice();
          arr.push(cleanedRef); while (arr.length > 8) arr.shift();
          mem.last_bible_refs = arr;
        }
        // no fijamos nueva oferta; IA decidirá estilo de pregunta
        mem.last_offer = null;
        await writeUserMemory(userId, mem);
        return res.status(200).json({
          message: msg,
          bible: { text: alt.text, ref: alt.ref },
          question: lang === "en" ? "Would you like a different kind of support?" : "¿Te gustaría otro tipo de apoyo?"
        });
      }
    }

    // Flujo normal con IA generando pregunta variada
    const SYSTEM_PROMPT = `
Hablas con serenidad, claridad y compasión.
Salida SOLO JSON.
"message": máximo 75 palabras, sin signos de pregunta. Primero autoayuda breve (2–3 frases) con 1–2 micro-pasos; luego un toque espiritual cristiano. **No incluyas citas bíblicas ni referencias en "message"**.
"bible": cita pertinente que apoye el micro-paso (texto + ref).
"question": crea tú mismo UNA pregunta **nueva**, breve (6–16 palabras), cálida, que avance el caso.
Puede ser PERSONAL (para comprender) u OFERTA (p. ej., “¿Quieres que te enseñe X?” / “¿Quieres orar 1 minuto?”).
Evita repetir o parafrasear pobremente preguntas recientes: ${avoidQs.map((q)=>`"${q}"`).join(", ") || "(ninguna)"}.
Responde SIEMPRE en ${langLabel(lang)} y alinea con el tema detectado: ${topic}.
`;

    const header =
      `Persona: ${persona}\n` +
      `Lang: ${lang}\n` +
      `Mensaje_actual: ${message}\n` +
      `FRAME: ${JSON.stringify(frame)}\n` +
      (shortHistory.length ? `Historial: ${shortHistory.join(" | ")}` : "Historial: (sin antecedentes)") +
      "\n";

    const r = await completionJson({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: header },
      ],
      temperature: 0.7,
      max_tokens: 260,
    });

    const content = r?.choices?.[0]?.message?.content || "{}";
    let data = {};
    try { data = JSON.parse(content); } catch { data = {}; }

    let msg = limitWords(stripQuestionsFromMessage(removeBibleLike(String(data?.message || ""))), 75);
    let ref = cleanRef(String(data?.bible?.ref || ""));
    let text = String(data?.bible?.text || "").trim();
    let question = String(data?.question || "").trim();
    if (question && !/\?\s*$/.test(question)) question += "?";

    // Antirepetición cita
    const avoidSet = new Set(avoidRefs.map((x) => NORM(cleanRef(x))));
    if (!ref || avoidSet.has(NORM(cleanRef(ref)))) {
      const alt = pickAltVerse(lang, topic, avoidRefs);
      ref = alt.ref; text = alt.text;
    }

    // Guardar memoria: cita y pregunta
    const cleanedRef = cleanRef(ref);
    if (cleanedRef) {
      const arr = avoidRefs.slice();
      arr.push(cleanedRef); while (arr.length > 8) arr.shift();
      mem.last_bible_refs = arr;
    }
    if (question) {
      const qArr = Array.isArray(mem.last_questions) ? mem.last_questions : [];
      qArr.push(question); while (qArr.length > 10) qArr.shift();
      mem.last_questions = qArr;
    }

    // Si la pregunta es de “oferta” (heurística simple)
    const qIsOffer = /quieres|quieres que|would you like|want me to|quer|vuoi|möchtest|vols|veux-tu/i.test(question);
    if (qIsOffer) {
      // definimos tipo genérico (se usará si luego responde “sí”)
      mem.last_offer = { type: "step_today", ts: Date.now() };
    } else {
      mem.last_offer = null;
    }

    // check-in base según tema
    if (!mem.last_topic) mem.last_topic = topic;
    if (topic && !/general/.test(topic)) {
      const ck = (topic === "relationship"
        ? (lang === "en" ? "that pending conversation" : "esa conversación pendiente")
        : topic === "mood"
        ? (lang === "en" ? "the 3-breath cycle" : "la respiración de 3 ciclos")
        : (lang === "en" ? "today’s step" : "el paso de hoy"));
      const cks = Array.isArray(mem.checkins) ? mem.checkins : [];
      if (ck) { cks.push(ck); while (cks.length > 5) cks.shift(); mem.checkins = cks; }
    }

    await writeUserMemory(userId, mem);

    res.status(200).json({
      message: msg || (lang === "en" ? "I am with you. Let’s take one small and practical step." : "Estoy contigo. Demos un paso pequeño y práctico."),
      bible: { text: text || (lang === "en" ? "The Lord is close to the brokenhearted." : "Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu."), ref: cleanedRef || (lang === "en" ? "Psalm 34:18" : "Salmos 34:18") },
      ...(question ? { question } : {}),
    });
  } catch (err) {
    console.error("ASK ERROR:", err);
    res.status(200).json({
      message: "La paz sea contigo. Compárteme en pocas palabras lo esencial, y seguimos paso a paso.",
      bible: { text: "Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu.", ref: "Salmos 34:18" },
    });
  }
});

// ---------- Ofertas (acciones) ----------
function doPrayer(lang = "es") {
  const ES = "Señor, mira su corazón y dale consuelo. Ilumina sus pasos hoy y acércalo a tu paz. Amén.";
  const EN = "Lord, look upon this heart and bring comfort. Light the steps today and draw near with Your peace. Amen.";
  const PT = "Senhor, olha para este coração e traz consolo. Ilumina os passos de hoje e aproxima com Tua paz. Amém.";
  const IT = "Signore, guarda questo cuore e dona consolazione. Illumina i passi di oggi e avvicina con la Tua pace. Amen.";
  const DE = "Herr, sieh auf dieses Herz und schenke Trost. Erleuchte die Schritte heute und sei nahe mit deinem Frieden. Amen.";
  const CA = "Senyor, mira aquest cor i porta consol. Il·lumina els passos d’avui i acosta’t amb la teva pau. Amén.";
  const FR = "Seigneur, regarde ce cœur et apporte la consolation. Éclaire les pas d’aujourd’hui et approche avec ta paix. Amen.";
  const map = { es: ES, en: EN, pt: PT, it: IT, de: DE, ca: CA, fr: FR };
  return map[lang] || ES;
}
function stepsExpressLove(lang = "es") {
  const ES = "Hoy, saluda a alguien con calidez, ofrece ayuda pequeña y expresa gratitud concreta. Tres gestos, un corazón abierto.";
  const EN = "Today, greet someone warmly, offer a small help, and express concrete gratitude. Three gestures, one open heart.";
  const PT = "Hoje, cumprimente alguém com carinho, ofereça uma pequena ajuda e expresse gratidão concreta. Três gestos, um coração aberto.";
  const IT = "Oggi, saluta qualcuno con calore, offri un piccolo aiuto ed esprimi gratitudine concreta. Tre gesti, un cuore aperto.";
  const DE = "Grüße heute jemanden herzlich, biete eine kleine Hilfe an und zeige konkrete Dankbarkeit. Drei Gesten, ein offenes Herz.";
  const CA = "Avui, saluda algú amb calidesa, ofereix una petita ajuda i expressa gratitud concreta. Tres gestos, un cor obert.";
  const FR = "Aujourd’hui, salue quelqu’un chaleureusement, offre une petite aide et exprime une gratitude concrète. Trois gestes, un cœur ouvert.";
  const map = { es: ES, en: EN, pt: PT, it: IT, de: DE, ca: CA, fr: FR };
  return map[lang] || ES;
}
function tinyPlan(lang = "es") {
  const ES = "Plan simple: 5’ de silencio al despertar, 1 gesto amable, 1 gratitud escrita al final del día.";
  const EN = "Simple plan: 5’ of quiet on waking, 1 kind gesture, 1 written gratitude at day’s end.";
  const PT = "Plano simples: 5’ de silêncio ao acordar, 1 gesto gentil, 1 gratidão escrita ao final do dia.";
  const IT = "Piano semplice: 5’ di silenzio al risveglio, 1 gesto gentile, 1 gratitudine scritta a fine giornata.";
  const DE = "Einfacher Plan: 5 Min Ruhe am Morgen, 1 freundliche Geste, 1 schriftliche Dankbarkeit am Abend.";
  const CA = "Pla simple: 5’ de silenci en despertar, 1 gest amable, 1 gratitud escrita al final del dia.";
  const FR = "Plan simple : 5’ de silence au réveil, 1 geste bienveillant, 1 gratitude écrite en fin de journée.";
  const map = { es: ES, en: EN, pt: PT, it: IT, de: DE, ca: CA, fr: FR };
  return map[lang] || ES;
}
function pickNextOffer(lang = "es", topic = "general") {
  // heurística simple (podrías afinar por topic)
  return "step_today";
}
function realizeOffer(offerType, lang = "es", topic = "general") {
  switch (offerType) {
    case "pray_one_min": return doPrayer(lang);
    case "express_love": return stepsExpressLove(lang);
    case "weekly_plan":  return tinyPlan(lang);
    case "step_today":
    default:             return stepsExpressLove(lang);
  }
}

// ---------- HeyGen ----------
app.get("/api/heygen/token", async (_req, res) => {
  try {
    const API_KEY = process.env.HEYGEN_API_KEY || process.env.HEYGEN_TOKEN || "";
    if (!API_KEY) return res.status(500).json({ error: "missing_HEYGEN_API_KEY" });
    const r = await fetch("https://api.heygen.com/v1/streaming.create_token", {
      method: "POST",
      headers: { "x-api-key": API_KEY, "Content-Type": "application/json" },
      body: "{}",
    });
    const json = await r.json().catch(() => ({}));
    const token = json?.data?.token || json?.token || json?.access_token || "";
    if (!r.ok || !token) {
      console.error("heygen_token_failed:", { status: r.status, json });
      return res.status(r.status || 500).json({ error: "heygen_token_failed", detail: json });
    }
    res.json({ token });
  } catch (e) {
    console.error("heygen token exception:", e);
    res.status(500).json({ error: "heygen_token_error" });
  }
});

app.get("/api/heygen/config", (_req, res) => {
  const AV_LANGS = ["es", "en", "pt", "it", "de", "ca", "fr"];
  const avatars = {};
  for (const l of AV_LANGS) {
    const key = `HEYGEN_AVATAR_${l.toUpperCase()}`;
    const val = (process.env[key] || "").trim();
    if (val) avatars[l] = val;
  }
  const voiceId = (process.env.HEYGEN_VOICE_ID || "").trim();
  const defaultAvatar = (process.env.HEYGEN_DEFAULT_AVATAR || "").trim();
  const version = process.env.HEYGEN_CFG_VERSION || Date.now();
  res.json({ voiceId, defaultAvatar, avatars, version });
});

// ---------- Arranque ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor listo en puerto ${PORT}`));
