// index.js — Backend completo (CommonJS) con antirepetición de citas bíblicas,
// bienvenida con pregunta fija rotada, límite ≤75 palabras, memoria simple, Heygen y CORS.
// Requisitos env: OPENAI_API_KEY, HEYGEN_API_KEY (opcional),
// HEYGEN_DEFAULT_AVATAR (opcional), HEYGEN_VOICE_ID (opcional),
// HEYGEN_AVATAR_ES/EN/PT/IT/DE/CA/FR (opc.)

const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const OpenAI = require("openai");
const path = require("path");
const fs = require("fs/promises");
require("dotenv").config();

const app = express();

// ===== Middlewares =====
app.use(cors());
app.use(bodyParser.json());

// ===== OpenAI client =====
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ===== Utils =====
function cleanRef(ref = "") {
  return String(ref).replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
}
function stripQuestionsFromMessage(s = "") {
  const noTrailingQLines = (s || "")
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => !/\?\s*$/.test(l))
    .join("\n")
    .trim();
  return noTrailingQLines.replace(/[¿?]+/g, "").trim();
}
function limitWords(s = "", max = 75) {
  const words = String(s || "").trim().split(/\s+/);
  return words.length <= max ? String(s || "").trim() : words.slice(0, max).join(" ").trim();
}
// Normaliza para comparar preguntas o refs
function normalizeLower(s = "") {
  return String(s).toLowerCase().replace(/\s+/g, " ").trim();
}
function compactHistory(history = [], keep = 8, maxLen = 260) {
  const arr = Array.isArray(history) ? history : [];
  return arr.slice(-keep).map((x) => String(x).slice(0, maxLen));
}
function langLabel(l = "es") {
  const m = { es:"Español", en:"English", pt:"Português", it:"Italiano", de:"Deutsch", ca:"Català", fr:"Français" };
  return m[l] || "Español";
}
function greetingByHour(lang = "es") {
  const h = new Date().getHours();
  const g = (m,a,n) => (h < 12 ? m : h < 19 ? a : n);
  switch (lang) {
    case "en": return g("Good morning","Good afternoon","Good evening");
    case "pt": return g("Bom dia","Boa tarde","Boa noite");
    case "it": return g("Buongiorno","Buon pomeriggio","Buonasera");
    case "de": return g("Guten Morgen","Guten Tag","Guten Abend");
    case "ca": return g("Bon dia","Bona tarda","Bona nit");
    case "fr": return g("Bonjour","Bon après-midi","Bonsoir");
    default:   return g("Buenos días","Buenas tardes","Buenas noches");
  }
}

// === Sanitizador: si el modelo colara la cita dentro de message, la quitamos ===
function removeBibleLike(text = "") {
  let s = String(text || "");
  s = s.replace(/^[\s]*[—-]\s*.*?\([^)]+?\d+\s*:\s*\d+\)[\s]*$/gim, "").trim();
  s = s.replace(/\(([^)]+?\d+\s*:\s*\d+)\)/g, () => "");
  s = s.replace(/\s*[—-]\s*[^()]*\(\s*[^)]+?\d+\s*:\s*\d+\s*\)\s*$/g, "").trim();
  return s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ===== Memoria simple por usuario (FS) =====
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
      last_bible_ref: "",
      last_bible_refs: [],
      last_questions: [],
      frame: null
    };
  }
}
async function writeUserMemory(userId, mem) {
  await ensureDataDir();
  await fs.writeFile(memPath(userId), JSON.stringify(mem, null, 2), "utf8");
}

// ===== FRAME: detecciones simples =====
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
const SUPPORT_WORDS = [
  "hijo","hija","madre","padre","mamá","mama","papá","papa","abuelo","abuela","nieto","nieta",
  "tío","tio","tía","tia","sobrino","sobrina","primo","prima","cuñado","cuñada","suegro","suegra","yerno","nuera",
  "esposo","esposa","pareja","novio","novia","amigo","amiga","compañero","compañera","colega","vecino","vecina",
  "pastor","sacerdote","mentor","maestro","maestra","profesor","profesora","jefe","jefa",
  "psicólogo","psicologa","psicóloga","terapeuta","consejero","consejera","médico","medica","médica"
];
function detectSupportNP(s = "") {
  const raw = (s || "").trim();
  if (!raw) return null;
  const tokens = raw.split(/\s+/);
  if (tokens.length > 6) return null;
  const low = raw.toLowerCase();
  const art = /^(mi|mis|una|un|el|la)\s+(.+)$/i;
  let core = low;
  let label = raw;
  const m = low.match(art);
  if (m) { core = m[2].trim(); label = raw; }
  const first = core.split(/\s+/)[0].replace(/[.,;:!?"'()]/g, "");
  if (!first) return null;
  if (!SUPPORT_WORDS.includes(first)) return null;
  return { label };
}

// ===== Pool de citas por tema (fallback si el modelo repite) =====
function versePoolByTopic(lang = "es") {
  // Textos ES / EN mínimos (se pueden ampliar)
  const ES = {
    mood: [
      { ref: "Isaías 41:10", text: "No temas, porque yo estoy contigo; no desmayes, porque yo soy tu Dios que te esfuerzo." },
      { ref: "Filipenses 4:6-7", text: "Por nada estéis afanosos... y la paz de Dios... guardará vuestros corazones." },
      { ref: "Salmos 55:22", text: "Echa sobre Jehová tu carga, y él te sustentará." }
    ],
    grief: [
      { ref: "Salmos 34:18", text: "Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu." },
      { ref: "Mateo 5:4", text: "Bienaventurados los que lloran, porque ellos recibirán consolación." },
      { ref: "Apocalipsis 21:4", text: "Enjugará Dios toda lágrima de los ojos de ellos." }
    ],
    relationship: [
      { ref: "1 Corintios 13:4-7", text: "El amor es sufrido, es benigno... todo lo sufre, todo lo cree, todo lo espera." },
      { ref: "Efesios 4:32", text: "Sed benignos unos con otros, misericordiosos, perdonándoos unos a otros." },
      { ref: "Romanos 12:18", text: "Si es posible, en cuanto dependa de vosotros, estad en paz con todos." }
    ],
    work_finance: [
      { ref: "Mateo 6:34", text: "No os afanéis por el día de mañana; porque el día de mañana traerá su afán." },
      { ref: "Proverbios 16:3", text: "Encomienda a Jehová tus obras, y tus pensamientos serán afirmados." },
      { ref: "Filipenses 4:19", text: "Mi Dios, pues, suplirá todo lo que os falta..." }
    ],
    health: [
      { ref: "Salmos 103:2-3", text: "Él es quien sana todas tus dolencias." },
      { ref: "Jeremías 30:17", text: "Porque yo haré venir sanidad para ti, y te sanaré de tus heridas." },
      { ref: "3 Juan 1:2", text: "Ruego que seas prosperado en todas las cosas, y que tengas salud." }
    ],
    faith: [
      { ref: "Proverbios 3:5-6", text: "Fíate de Jehová de todo tu corazón... y él enderezará tus veredas." },
      { ref: "Hebreos 11:1", text: "La fe es la certeza de lo que se espera, la convicción de lo que no se ve." },
      { ref: "Juan 14:27", text: "La paz os dejo, mi paz os doy; no se turbe vuestro corazón, ni tenga miedo." }
    ],
    separation: [
      { ref: "Salmos 147:3", text: "Él sana a los quebrantados de corazón, y venda sus heridas." },
      { ref: "Isaías 43:2", text: "Cuando pases por las aguas, yo estaré contigo." },
      { ref: "Romanos 8:28", text: "A los que aman a Dios, todas las cosas les ayudan a bien." }
    ],
    addiction: [
      { ref: "1 Corintios 10:13", text: "Fiel es Dios, que no os dejará ser tentados más de lo que podéis resistir." },
      { ref: "Gálatas 5:1", text: "Estad, pues, firmes en la libertad con que Cristo nos hizo libres." },
      { ref: "Salmos 40:1-2", text: "Me hizo sacar del pozo de la desesperación, del lodo cenagoso." }
    ],
    family_conflict: [
      { ref: "Santiago 1:19", text: "Todo hombre sea pronto para oír, tardo para hablar, tardo para airarse." },
      { ref: "Colosenses 3:13", text: "Soportándoos unos a otros, y perdonándoos unos a otros." },
      { ref: "Romanos 12:10", text: "Amaos los unos a los otros con amor fraternal." }
    ],
    general: [
      { ref: "Salmos 23:1", text: "Jehová es mi pastor; nada me faltará." },
      { ref: "1 Pedro 5:7", text: "Echando toda vuestra ansiedad sobre él, porque él tiene cuidado de vosotros." },
      { ref: "Isaías 40:31", text: "Los que esperan a Jehová tendrán nuevas fuerzas." }
    ]
  };

  const EN = {
    mood: [
      { ref: "Isaiah 41:10", text: "Do not fear, for I am with you; do not be dismayed, for I am your God." },
      { ref: "Philippians 4:6-7", text: "Do not be anxious about anything... and the peace of God will guard your hearts." },
      { ref: "Psalm 55:22", text: "Cast your cares on the Lord and he will sustain you." }
    ],
    grief: [
      { ref: "Psalm 34:18", text: "The Lord is close to the brokenhearted and saves those who are crushed in spirit." },
      { ref: "Matthew 5:4", text: "Blessed are those who mourn, for they will be comforted." },
      { ref: "Revelation 21:4", text: "He will wipe every tear from their eyes." }
    ],
    relationship: [
      { ref: "1 Corinthians 13:4-7", text: "Love is patient, love is kind... it always protects, always trusts, always hopes." },
      { ref: "Ephesians 4:32", text: "Be kind and compassionate to one another, forgiving each other." },
      { ref: "Romans 12:18", text: "If it is possible, as far as it depends on you, live at peace with everyone." }
    ],
    work_finance: [
      { ref: "Matthew 6:34", text: "Do not worry about tomorrow, for tomorrow will worry about itself." },
      { ref: "Proverbs 16:3", text: "Commit to the Lord whatever you do, and he will establish your plans." },
      { ref: "Philippians 4:19", text: "My God will meet all your needs..." }
    ],
    health: [
      { ref: "Psalm 103:2-3", text: "He heals all your diseases." },
      { ref: "Jeremiah 30:17", text: "I will restore you to health and heal your wounds." },
      { ref: "3 John 1:2", text: "I pray that you may enjoy good health." }
    ],
    faith: [
      { ref: "Proverbs 3:5-6", text: "Trust in the Lord with all your heart... and he will make your paths straight." },
      { ref: "Hebrews 11:1", text: "Faith is confidence in what we hope for and assurance about what we do not see." },
      { ref: "John 14:27", text: "Peace I leave with you; my peace I give you." }
    ],
    separation: [
      { ref: "Psalm 147:3", text: "He heals the brokenhearted and binds up their wounds." },
      { ref: "Isaiah 43:2", text: "When you pass through the waters, I will be with you." },
      { ref: "Romans 8:28", text: "In all things God works for the good of those who love him." }
    ],
    addiction: [
      { ref: "1 Corinthians 10:13", text: "God is faithful; he will not let you be tempted beyond what you can bear." },
      { ref: "Galatians 5:1", text: "It is for freedom that Christ has set us free." },
      { ref: "Psalm 40:1-2", text: "He lifted me out of the slimy pit, out of the mud and mire." }
    ],
    family_conflict: [
      { ref: "James 1:19", text: "Everyone should be quick to listen, slow to speak and slow to become angry." },
      { ref: "Colossians 3:13", text: "Bear with each other and forgive one another." },
      { ref: "Romans 12:10", text: "Be devoted to one another in love." }
    ],
    general: [
      { ref: "Psalm 23:1", text: "The Lord is my shepherd, I lack nothing." },
      { ref: "1 Peter 5:7", text: "Cast all your anxiety on him because he cares for you." },
      { ref: "Isaiah 40:31", text: "Those who hope in the Lord will renew their strength." }
    ]
  };

  return (lang === "en" ? EN : ES);
}

function pickAltVerse(lang = "es", topic = "general", avoid = []) {
  const pool = versePoolByTopic(lang);
  const list = pool[topic] || pool.general || [];
  const avoidSet = new Set(avoid.map((r) => normalizeLower(cleanRef(r))));
  for (const v of list) {
    if (!avoidSet.has(normalizeLower(cleanRef(v.ref)))) return v;
  }
  // Si todas están evitadas, toma de "general"
  if (topic !== "general") {
    for (const v of pool.general) {
      if (!avoidSet.has(normalizeLower(cleanRef(v.ref)))) return v;
    }
  }
  // Último recurso: primera del pool
  return list[0] || pool.general[0] || { ref: (lang === "en" ? "Psalm 34:18" : "Salmos 34:18"), text: (lang === "en" ? "The Lord is close to the brokenhearted." : "Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu.") };
}

// ===== Prompt base (autoayuda + toque espiritual) =====
const SYSTEM_PROMPT_BASE = `
Hablas con serenidad, claridad y compasión. Estructura cada respuesta con dos capas:
1) Autoayuda: psicoeducación breve y práctica (marcos cognitivo-conductuales, ACT, compasión, límites, hábitos), basada en bibliografía general de autoayuda. Ofrece 1–2 micro-pasos concretos.
2) Toque espiritual cristiano: aplica una cita bíblica pertinente (RVR1909 en español; equivalente en otros idiomas) y un cierre de esperanza humilde.

Reglas IMPORTANTES:
- Devuelve SOLO JSON.
- "message": máximo 75 palabras, sin signos de pregunta, **NO incluyas citas bíblicas ni referencias** (la Escritura va SOLO en "bible").
- "question": UNA sola pregunta abierta (opcional), breve, termina en "?" y variada (no repitas fórmulas).
- Mantén coherencia con FRAME (tema/sujeto/apoyos) y con el historial breve.
`;

// ===== JSON schema para respuestas =====
const RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "SpiritualGuidance",
    schema: {
      type: "object",
      properties: {
        message: { type: "string" },
        bible: {
          type: "object",
          properties: { text: { type: "string" }, ref: { type: "string" } },
          required: ["text", "ref"]
        },
        question: { type: "string" }
      },
      required: ["message", "bible"],
      additionalProperties: false
    }
  }
};

// ===== OpenAI helper =====
async function completionJson({ messages, temperature = 0.6, max_tokens = 240, timeoutMs = 12000 }) {
  const call = openai.chat.completions.create({
    model: "gpt-4o",
    temperature,
    max_tokens,
    messages,
    response_format: RESPONSE_FORMAT
  });
  return await Promise.race([
    call,
    new Promise((_, reject) => setTimeout(() => reject(new Error("TIMEOUT")), timeoutMs))
  ]);
}

// ===================================================================
// HEALTH & DEBUG
// ===================================================================
app.get("/", (_req, res) => {
  res.json({ ok: true, service: "backend", ts: Date.now() });
});
app.get("/api/welcome", (_req, res) => {
  res.json({ ok: true, hint: "Usa POST /api/welcome con { lang, name, userId, history }" });
});
// Evita 404 del front
app.post("/api/memory/sync", (_req, res) => res.json({ ok: true }));

// ===================================================================
// WELCOME (POST) — saludo + bendición + pregunta fija rotada; antirepetición
// ===================================================================
app.post("/api/welcome", async (req, res) => {
  try {
    const { lang = "es", name = "", history = [], userId = "anon" } = req.body || {};
    const hi = greetingByHour(lang);
    const nm = String(name || "").trim();

    const mem = await readUserMemory(userId);
    const avoidRefs = Array.isArray(mem.last_bible_refs) ? mem.last_bible_refs.slice(-8) : [];

    const Q_SET = [
      "¿Cómo estás hoy?",
      "¿En qué quieres profundizar?",
      "¿Qué tienes para contarme?"
    ];
    const pickQ = Q_SET[Math.floor(Math.random() * Q_SET.length)];

    const SYSTEM_PROMPT = `${SYSTEM_PROMPT_BASE}
Responde SIEMPRE en ${langLabel(lang)}.
"message": inicia con "${hi}${nm ? ", " + nm : ""}." + **UNA bendición breve** y **UNA frase de orientación** (2–3 frases en total, sin citas).
"question": ignora la del modelo; la pregunta final será seleccionada del sistema.
Evita usar cualquiera de estas referencias bíblicas exactas: ${avoidRefs.map((r)=>`"${r}"`).join(", ") || "(ninguna)"}.
La cita bíblica va SOLO en "bible" y debe ser pertinente a una bienvenida breve.`;

    const shortHistory = compactHistory(history, 6, 200);
    const header =
      `Lang: ${lang}\n` +
      `Nombre: ${nm || "(anónimo)"}\n` +
      (shortHistory.length ? `Historial: ${shortHistory.join(" | ")}` : "Historial: (sin antecedentes)") + "\n";

    const r = await completionJson({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: header }
      ],
      temperature: 0.7,
      max_tokens: 240
    });

    const content = r?.choices?.[0]?.message?.content || "{}";
    let data = {};
    try { data = JSON.parse(content); } catch { data = {}; }

    let msg = limitWords(stripQuestionsFromMessage(removeBibleLike((data?.message || "").toString())), 75);
    let ref = cleanRef((data?.bible?.ref || "").toString());
    let text = (data?.bible?.text || "").toString().trim();

    // Antirepetición: si ref está en evitados, sustituimos por alternativa
    const topic = "general";
    const avoidSet = new Set(avoidRefs.map((x) => normalizeLower(cleanRef(x))));
    if (!ref || avoidSet.has(normalizeLower(cleanRef(ref)))) {
      const alt = pickAltVerse(lang, topic, avoidRefs);
      ref = alt.ref;
      text = alt.text;
    }

    // Actualiza memoria
    const cleanedRef = cleanRef(ref);
    if (cleanedRef) {
      const arr = Array.isArray(mem.last_bible_refs) ? mem.last_bible_refs : [];
      arr.push(cleanedRef);
      while (arr.length > 8) arr.shift();
      mem.last_bible_refs = arr;
      await writeUserMemory(userId, mem);
    }

    res.status(200).json({
      message: msg || `${hi}${nm ? ", " + nm : ""}. Que la paz de Dios te sostenga. Comparte en pocas palabras y damos un paso sencillo.`,
      bible: {
        text: text || (lang === "en" ? "The Lord is close to the brokenhearted." : "Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu."),
        ref: cleanedRef || (lang === "en" ? "Psalm 34:18" : "Salmos 34:18")
      },
      question: pickQ
    });
  } catch (e) {
    console.error("WELCOME ERROR:", e);
    res.status(200).json({
      message: "La paz sea contigo. Cuéntame en pocas palabras qué te trae hoy.",
      bible: { text: "Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu.", ref: "Salmos 34:18" },
      question: "¿Cómo estás hoy?"
    });
  }
});

// ===================================================================
// ASK (POST) — Autoayuda + toque espiritual; FRAME; ≤75 palabras; antirepetición
// ===================================================================
app.post("/api/ask", async (req, res) => {
  try {
    const {
      persona = "jesus",
      message = "",
      history = [],
      userId = "anon",
      lang = "es"
    } = req.body || {};

    // Memoria/FRAME
    const mem = await readUserMemory(userId);
    const support = detectSupportNP(message);
    const topic = guessTopic(message);
    const mainSubject = detectMainSubject(message);
    const frame = {
      topic_primary: topic,
      main_subject: mem.frame?.topic_primary === topic ? (mem.frame?.main_subject || mainSubject) : mainSubject,
      support_persons: support ? [{ label: support.label }] : (mem.frame?.topic_primary === topic ? (mem.frame?.support_persons || []) : []),
    };
    mem.frame = frame;

    // Antirepetición
    const avoidRefs = Array.isArray(mem.last_bible_refs) ? mem.last_bible_refs.slice(-8) : [];

    const shortHistory = compactHistory(history, 10, 240);

    const SYSTEM_PROMPT = `${SYSTEM_PROMPT_BASE}
Responde SIEMPRE en ${langLabel(lang)}.
"message": máximo 75 palabras, sin signos de pregunta. Primero autoayuda breve (2–3 frases) con 1–2 micro-pasos; luego un toque espiritual cristiano. **No incluyas citas bíblicas ni referencias en "message"**.
"question": UNA abierta breve, concreta, que avance el caso (termina en "?").
Evita usar cualquiera de estas referencias bíblicas exactas: ${avoidRefs.map((r)=>`"${r}"`).join(", ") || "(ninguna)"}.
La cita bíblica va SOLO en "bible" y debe apoyar el micro-paso sugerido.`;

    const header =
      `Persona: ${persona}\n` +
      `Lang: ${lang}\n` +
      `Mensaje_actual: ${message}\n` +
      `FRAME: ${JSON.stringify(frame)}\n` +
      (shortHistory.length ? `Historial: ${shortHistory.join(" | ")}` : "Historial: (sin antecedentes)") + "\n";

    const r = await completionJson({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: header }
      ],
      temperature: 0.65,
      max_tokens: 260
    });

    const content = r?.choices?.[0]?.message?.content || "{}";
    let data = {};
    try { data = JSON.parse(content); } catch { data = {}; }

    let msg = limitWords(stripQuestionsFromMessage(removeBibleLike((data?.message || "").toString())), 75);
    let ref = cleanRef((data?.bible?.ref || "").toString());
    let text = (data?.bible?.text || "").toString().trim();
    let question = (data?.question || "").toString().trim();
    if (question && !/\?\s*$/.test(question)) question = question + "?";

    // Antirepetición: si ref está en evitados, sustituimos por alternativa
    const avoidSet = new Set(avoidRefs.map((x) => normalizeLower(cleanRef(x))));
    if (!ref || avoidSet.has(normalizeLower(cleanRef(ref)))) {
      const alt = pickAltVerse(lang, topic, avoidRefs);
      ref = alt.ref;
      text = alt.text;
    }

    // Actualiza memoria: push ref y recorta
    const cleanedRef = cleanRef(ref);
    if (cleanedRef) {
      const arr = Array.isArray(mem.last_bible_refs) ? mem.last_bible_refs : [];
      arr.push(cleanedRef);
      while (arr.length > 8) arr.shift();
      mem.last_bible_refs = arr;
    }
    await writeUserMemory(userId, mem);

    res.status(200).json({
      message: msg || (lang === "en" ? "I am with you. Let’s take one small and practical step." : "Estoy contigo. Demos un paso pequeño y práctico."),
      bible: {
        text: text || (lang === "en" ? "The Lord is close to the brokenhearted." : "Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu."),
        ref: cleanedRef || (lang === "en" ? "Psalm 34:18" : "Salmos 34:18")
      },
      ...(question ? { question } : {})
    });
  } catch (err) {
    console.error("ASK ERROR:", err);
    res.status(200).json({
      message: "La paz sea contigo. Compárteme en pocas palabras lo esencial, y seguimos paso a paso.",
      bible: { text: "Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu.", ref: "Salmos 34:18" }
    });
  }
});

// ===================================================================
// HEYGEN
// ===================================================================
app.get("/api/heygen/token", async (_req, res) => {
  try {
    const API_KEY = process.env.HEYGEN_API_KEY || process.env.HEYGEN_TOKEN || "";
    if (!API_KEY) {
      return res.status(500).json({ error: "missing_HEYGEN_API_KEY" });
    }
    const r = await fetch("https://api.heygen.com/v1/streaming.create_token", {
      method: "POST",
      headers: {
        "x-api-key": API_KEY,
        "Content-Type": "application/json",
      },
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

// ===== Arranque =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor listo en puerto ${PORT}`);
});
