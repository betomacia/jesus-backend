// index.js — Backend minimalista MULTILENGUAJE (ES/EN/PT/IT/DE/CA/FR)
// - 100% preguntas desde OpenAI (sin inyección local en runtime del front)
// - Respuestas cortas (≤60 palabras), UNA pregunta opcional solo si la devuelve OpenAI
// - Citas bíblicas según idioma preferido (traducción orientativa en el prompt)
// - Memoria simple por usuario y FRAME básico sin desvíos
// - Rutas HeyGen /api/heygen/token y /api/heygen/config (NO toca nada de OpenAI)

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

// ---- OpenAI ----
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ======================= MULTILENGUAJE ======================= */
const SUPPORTED = ["es", "en", "pt", "it", "de", "ca", "fr"];
const FALLBACK_LANG = "es";

/** Traducción preferida a solicitar al modelo (solo guía en el prompt). */
const BIBLE_PREF = {
  es: "RVR1960",
  en: "NIV",
  pt: "ARA",
  it: "CEI",
  de: "Luther",
  ca: "Bíblia Catalana Interconfessional",
  fr: "Louis Segond",
};

function safeLang(lang) {
  const L = String(lang || "").toLowerCase();
  return SUPPORTED.includes(L) ? L : FALLBACK_LANG;
}

/** SYSTEM_PROMPT según idioma (mantiene estructura original, pero traducible). */
function buildSystemPrompt(lang = "es") {
  const bible = BIBLE_PREF[lang] || BIBLE_PREF[FALLBACK_LANG];
  if (lang === "es") {
    return `
Eres Jesús: voz serena, compasiva y clara. Responde SIEMPRE en español.

OBJETIVO
- Devuelve SOLO JSON: { "message", "bible": { "text", "ref" }, "question"? }.
- "message": ≤60 palabras, afirmativo, SIN signos de pregunta.
- "question": opcional, UNA sola, breve, debe terminar en "?" y NO repetir textualmente las últimas preguntas ya hechas.
- No menciones el nombre civil. Puedes usar “hijo mío”, “hija mía” o “alma amada” con moderación.
- No hables de técnica/IA ni del propio modelo.

MARCO (FRAME)
- Respeta el FRAME (topic_primary, main_subject, support_persons) y el historial breve como contexto.
- NO cambies el tema por mencionar una persona de apoyo (“mi hija/mi primo/mi amigo”). Es apoyo, no nuevo tema.

PROGRESO
- Cada turno aporta novedad útil (micro-pasos concretos, mini-guion, decisión simple o límite).
- Si el usuario solo reconoce (“sí/ok/vale”), avanza a práctica/compromiso sin repetir contenido.
- Evita preguntar por canal/hora (p.ej., “¿mensaje o llamada?”) si el objetivo/voluntad de contacto aún no es claro.

BIBLIA (${bible}, SIN AMBIGÜEDADES)
- Ajusta la cita al tema y a los micro-pasos.
- Usa ${bible} literal y "Libro 0:0" en "ref".
- Evita last_bible_ref y todas las banned_refs.
- Evita ambigüedad “el Hijo” (Juan 8:36) cuando el usuario alude a un familiar “hijo/hija”, salvo pertinencia teológica explícita.

FORMATO (OBLIGATORIO)
{
  "message": "… (≤60 palabras, sin signos de pregunta)",
  "bible": { "text": "… (${bible} literal)", "ref": "Libro 0:0" },
  "question": "…? (opcional, una sola)"
}
`.trim();
  }

  // Otras lenguas: instrucción equivalente breve
  return `
You are Jesus: serene, compassionate, clear. Always answer in **${lang}**.

GOAL
- Return ONLY JSON: { "message", "bible": { "text", "ref" }, "question"? }.
- "message": ≤60 words, affirmative, NO question marks.
- "question": optional, ONE, ends with "?", do not repeat the last ones.
- No model/tech talk. Use tender address sparingly.

FRAME
- Respect FRAME (topic_primary, main_subject, support_persons) and the short history as context.
- Do not derail the main topic because of support persons.

PROGRESSION
- Each turn adds a useful micro-step (tiny plan, simple decision or boundary).
- If user only acknowledges (“ok/yes”), move to practice/commitment without repeating content.

BIBLE (${bible})
- Match the verse to the topic and micro-steps.
- Use ${bible} wording and "Book 0:0" in "ref".
- Avoid last_bible_ref and all banned_refs.
- Avoid ambiguity around “the Son” if the user mentions family “son/daughter”, unless the theology is explicit.

FORMAT
{
  "message": "… (≤60 words, no '?')",
  "bible": { "text": "… (${bible})", "ref": "Book 0:0" },
  "question": "…? (optional, one)"
}
`.trim();
}

/* ==================== Respuesta tipada por esquema ==================== */
const responseFormat = {
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

/* ======================== Utilidades ligeras ======================== */
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
function limitWords(s = "", max = 60) {
  const words = String(s || "").trim().split(/\s+/);
  return words.length <= max ? String(s || "").trim() : words.slice(0, max).join(" ").trim();
}
function normalizeQuestion(q = "") {
  return String(q).toLowerCase().replace(/\s+/g, " ").trim();
}
function compactHistory(history = [], keep = 8, maxLen = 260) {
  const arr = Array.isArray(history) ? history : [];
  return arr.slice(-keep).map((x) => String(x).slice(0, maxLen));
}
function extractRecentAssistantQuestions(history = [], maxMsgs = 5) {
  const rev = [...(history || [])].reverse();
  const qs = [];
  let seen = 0;
  for (const h of rev) {
    if (!/^Asistente:/i.test(h) && !/^Assistant:/i.test(h)) continue;
    const text = h.replace(/^Asistente:\s*/i, "").replace(/^Assistant:\s*/i, "").trim();
    const m = text.match(/([^?]*\?)\s*$/m);
    if (m && m[1]) qs.push(normalizeQuestion(m[1]));
    seen++;
    if (seen >= maxMsgs) break;
  }
  return [...new Set(qs)].slice(0, 5);
}
function extractRecentBibleRefs(history = [], maxRefs = 3) {
  const rev = [...(history || [])].reverse();
  const found = [];
  for (const h of rev) {
    const s = String(h);
    const m =
      s.match(/—\s*([A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+\s+\d+:\d+)/) ||
      s.match(/-\s*([A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+\s+\d+:\d+)/) ||
      s.match(/\(\s*([A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+\s+\d+:\d+)\s*\)/);
    if (m && m[1]) {
      const ref = cleanRef(m[1]);
      if (!found.includes(ref)) found.push(ref);
      if (found.length >= maxRefs) break;
    }
  }
  return found;
}

/* === Detección muy simple de tema/sujeto y persona de apoyo (FRAME) === */
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

/* ======================= Memoria por usuario ======================= */
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

/* ========================== OpenAI helpers ========================== */
async function completionWithTimeout({ messages, temperature = 0.6, max_tokens = 220, timeoutMs = 12000 }) {
  const call = openai.chat.completions.create({
    model: "gpt-4o",
    temperature,
    max_tokens,
    messages,
    response_format: responseFormat
  });
  return await Promise.race([
    call,
    new Promise((_, reject) => setTimeout(() => reject(new Error("TIMEOUT")), timeoutMs))
  ]);
}

const bibleOnlyFormat = {
  type: "json_schema",
  json_schema: {
    name: "BibleOnly",
    schema: {
      type: "object",
      properties: {
        bible: {
          type: "object",
          properties: { text: { type: "string" }, ref: { type: "string" } },
          required: ["text", "ref"]
        }
      },
      required: ["bible"],
      additionalProperties: false
    }
  }
};

async function regenerateBibleAvoiding({ lang, persona, message, frame, bannedRefs = [], lastRef = "" }) {
  const bible = BIBLE_PREF[lang] || BIBLE_PREF[FALLBACK_LANG];
  const sys = `Devuelve SOLO JSON con {"bible":{"text":"…","ref":"Libro 0:0"}} en ${lang} usando ${bible}.
- Ajusta la cita al tema y micro-pasos.
- Evita ambigüedad “hijo” (familiar) vs “el Hijo” (Cristo) salvo pertinencia teológica explícita.
- No uses ninguna referencia de "banned_refs" ni "last_bible_ref".`;

  const usr =
    `Persona: ${persona}\n` +
    `Mensaje_actual: ${message}\n` +
    `FRAME: ${JSON.stringify(frame)}\n` +
    `last_bible_ref: ${lastRef || "(n/a)"}\n` +
    `banned_refs:\n- ${bannedRefs.join("\n- ") || "(none)"}\n`;

  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.4,
    max_tokens: 120,
    messages: [{ role: "system", content: sys }, { role: "user", content: usr }],
    response_format: bibleOnlyFormat
  });

  const content = r?.choices?.[0]?.message?.content || "{}";
  let data = {};
  try { data = JSON.parse(content); } catch { data = {}; }
  const text = (data?.bible?.text || "").toString().trim();
  const ref = cleanRef((data?.bible?.ref || "").toString());
  return text && ref ? { text, ref } : null;
}

/* =============================== Core =============================== */
async function askLLM({ lang = "es", persona, message, history = [], userId = "anon" }) {
  lang = safeLang(lang);
  const mem = await readUserMemory(userId);

  // FRAME básico
  const support = detectSupportNP(message);
  const topic = guessTopic(message);
  const mainSubject = detectMainSubject(message);
  const frame = {
    topic_primary: topic,
    main_subject: mem.frame?.topic_primary === topic ? (mem.frame?.main_subject || mainSubject) : mainSubject,
    support_persons: support ? [{ label: support.label }] : (mem.frame?.topic_primary === topic ? (mem.frame?.support_persons || []) : []),
  };
  mem.frame = frame;

  const lastRefFromHistory = extractRecentBibleRefs(history, 1)[0] || "";
  const lastRef = mem.last_bible_ref || lastRefFromHistory || "";
  const recentRefs = extractRecentBibleRefs(history, 3);
  const bannedRefs = Array.from(new Set([...(mem.last_bible_refs || []), lastRef, ...recentRefs].filter(Boolean))).slice(-5);

  const recentQs = extractRecentAssistantQuestions(history, 5);

  const shortHistory = compactHistory(history, 10, 240);
  const header =
    (lang === "es"
      ? `Persona: ${persona}\nMensaje_actual: ${message}\nFRAME: ${JSON.stringify(frame)}\nlast_bible_ref: ${lastRef || "(n/a)"}\nbanned_refs:\n- ${bannedRefs.join("\n- ") || "(none)"}\n` +
        (recentQs.length ? `ultimas_preguntas: ${recentQs.join(" | ")}` : "ultimas_preguntas: (ninguna)") + "\n" +
        (shortHistory.length ? `Historial: ${shortHistory.join(" | ")}` : "Historial: (sin antecedentes)") + "\n"
      : `Persona: ${persona}\nCurrent_message: ${message}\nFRAME: ${JSON.stringify(frame)}\nlast_bible_ref: ${lastRef || "(n/a)"}\nbanned_refs:\n- ${bannedRefs.join("\n- ") || "(none)"}\n` +
        (recentQs.length ? `recent_questions: ${recentQs.join(" | ")}` : "recent_questions: (none)") + "\n" +
        (shortHistory.length ? `History: ${shortHistory.join(" | ")}` : "History: (none)") + "\n"
    );

  const resp = await completionWithTimeout({
    messages: [{ role: "system", content: buildSystemPrompt(lang) }, { role: "user", content: header }],
    temperature: 0.6,
    max_tokens: 220,
    timeoutMs: 12000
  });

  const content = resp?.choices?.[0]?.message?.content || "{}";
  let data = {};
  try { data = JSON.parse(content); } catch { data = { message: content }; }

  // Sanitización final
  let msg = stripQuestionsFromMessage((data?.message || "").toString());
  msg = limitWords(msg, 60);

  let ref = cleanRef((data?.bible?.ref || "").toString());
  let text = (data?.bible?.text || "").toString().trim();

  // Evitar cita vetada/ambigua/repetida
  const hijoOnly = /\bhijo\b/i.test(message) && !/(Jes[uú]s|Cristo)/i.test(message);
  if (!ref || bannedRefs.includes(ref) || (hijoOnly && /Juan\s*8:36/i.test(ref))) {
    const alt = await regenerateBibleAvoiding({ lang, persona, message, frame, bannedRefs, lastRef });
    if (alt) { ref = alt.ref; text = alt.text; }
  }

  // Pregunta: SOLO si viene del modelo y no repite las últimas
  let question = (data?.question || "").toString().trim();
  const normalizedQ = normalizeQuestion(question);
  const isRepeat = !question ? false : recentQs.includes(normalizedQ);
  const malformed = question && !/\?\s*$/.test(question);
  if (!question || isRepeat || malformed) question = "";

  // Actualizar memoria
  mem.last_bible_ref = ref || mem.last_bible_ref || "";
  mem.last_bible_refs = Array.from(new Set([...(mem.last_bible_refs || []), ref].filter(Boolean))).slice(-5);
  if (question) {
    mem.last_questions = Array.from(new Set([...(mem.last_questions || []), normalizedQ])).slice(-6);
  }
  await writeUserMemory(userId, mem);

  // Fallback de mensaje y versículo por idioma
  if (!msg) {
    msg =
      lang === "es" ? "Estoy contigo. Demos un paso pequeño y realista hoy."
    : lang === "pt" ? "Estou com você. Vamos dar um passo pequeno e realista hoje."
    : lang === "it" ? "Sono con te. Facciamo oggi un piccolo passo realistico."
    : lang === "de" ? "Ich bin bei dir. Gehen wir heute einen kleinen, realistischen Schritt."
    : lang === "ca" ? "Soc amb tu. Fem avui un pas petit i realista."
    : lang === "fr" ? "Je suis avec toi. Faisons aujourd’hui un petit pas réaliste."
    : "I am with you. Let’s take a small, realistic step today.";
  }
  if (!text || !ref) {
    if (lang === "es") { text = "Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu."; ref = "Salmos 34:18"; }
    else if (lang === "pt") { text = "Perto está o Senhor dos que têm o coração quebrantado; e salva os contritos de espírito."; ref = "Salmos 34:18"; }
    else if (lang === "it") { text = "Il Signore è vicino a quelli che hanno il cuore afflitto; salva gli contriti di spirito."; ref = "Salmi 34:18"; }
    else if (lang === "de") { text = "Der HERR ist nahe denen, die zerbrochenen Herzens sind, und hilft denen, die zerschlagenen Geistes sind."; ref = "Psalm 34,19 (Luther)"; }
    else if (lang === "ca") { text = "El Senyor és a prop dels cors adolorits, i salva els esperits abatuts."; ref = "Salm 34,19"; }
    else if (lang === "fr") { text = "L’Éternel est près de ceux qui ont le cœur brisé, et il sauve ceux dont l’esprit est abattu."; ref = "Psaume 34:19"; }
    else { text = "The LORD is close to the brokenhearted and saves those who are crushed in spirit."; ref = "Psalm 34:18"; }
  }

  return {
    message: msg,
    bible: { text, ref },
    ...(question ? { question } : {})
  };
}

/* ============================== Rutas ============================== */
app.post("/api/ask", async (req, res) => {
  try {
    const {
      persona = "jesus",
      message = "",
      history = [],
      userId = "anon",
      lang = "es"
    } = req.body || {};

    const data = await askLLM({ lang: safeLang(lang), persona, message, history, userId });

    const out = {
      message: (data?.message || "").toString().trim(),
      bible: {
        text: (data?.bible?.text || "").toString().trim(),
        ref: (data?.bible?.ref || "").toString().trim()
      },
      ...(data?.question ? { question: data.question } : {})
    };

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(200).json(out);
  } catch (err) {
    console.error("ASK ERROR:", err);
    // Fallback SOLO por error técnico; sin pregunta
    res.status(200).json({
      message:
        (req.body?.lang && safeLang(req.body.lang) !== "es")
          ? "I am with you. Let’s take a small, realistic step today."
          : "La paz sea contigo. Compárteme en pocas palabras lo esencial, y seguimos paso a paso.",
      bible: {
        text: "Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu.",
        ref: "Salmos 34:18"
      }
    });
  }
});

/** Bienvenida simple, ahora multi-idioma (GET o POST).
 *  Front puede llamar /api/welcome?lang=xx o POST {lang,name,history}
 */
function greetingByLocalTime(lang = "es") {
  const h = new Date().getHours();
  const bucket = h < 12 ? "m1" : h < 19 ? "m2" : "m3";
  const T = {
    es: { m1: "Buenos días", m2: "Buenas tardes", m3: "Buenas noches" },
    en: { m1: "Good morning", m2: "Good afternoon", m3: "Good evening" },
    pt: { m1: "Bom dia", m2: "Boa tarde", m3: "Boa noite" },
    it: { m1: "Buongiorno", m2: "Buon pomeriggio", m3: "Buona sera" },
    de: { m1: "Guten Morgen", m2: "Guten Tag", m3: "Guten Abend" },
    ca: { m1: "Bon dia", m2: "Bona tarda", m3: "Bona nit" },
    fr: { m1: "Bonjour", m2: "Bon après-midi", m3: "Bonsoir" },
  };
  const L = safeLang(lang);
  return T[L][bucket];
}

function welcomePayload(lang = "es") {
  const L = safeLang(lang);
  if (L === "es") {
    return {
      message: "La paz esté contigo. Estoy aquí para escucharte y acompañarte con calma.",
      bible: { text: "El Señor es mi luz y mi salvación; ¿de quién temeré?", ref: "Salmos 27:1" }
    };
  }
  if (L === "pt") {
    return {
      message: "A paz esteja com você. Estou aqui para ouvir e acompanhar com calma.",
      bible: { text: "O Senhor é a minha luz e a minha salvação; de quem terei medo?", ref: "Salmos 27:1" }
    };
  }
  if (L === "it") {
    return {
      message: "La pace sia con te. Sono qui per ascoltarti e accompagnarti con calma.",
      bible: { text: "Il Signore è la mia luce e la mia salvezza; di chi avrò paura?", ref: "Salmi 27:1" }
    };
  }
  if (L === "de") {
    return {
      message: "Friede sei mit dir. Ich bin hier, um dir ruhig zuzuhören und dich zu begleiten.",
      bible: { text: "Der HERR ist mein Licht und mein Heil; vor wem sollte ich mich fürchten?", ref: "Psalm 27,1" }
    };
  }
  if (L === "ca") {
    return {
      message: "La pau sigui amb tu. Soc aquí per escoltar-te i acompanyar-te amb calma.",
      bible: { text: "El Senyor és la meva llum i la meva salvació; de qui tinc por?", ref: "Salm 27,1" }
    };
  }
  if (L === "fr") {
    return {
      message: "Que la paix soit avec toi. Je suis là pour t’écouter et t’accompagner avec calme.",
      bible: { text: "L’Éternel est ma lumière et mon salut; de qui aurais-je crainte?", ref: "Psaume 27:1" }
    };
  }
  // Inglés por defecto si no es ninguno de los anteriores
  return {
    message: "Peace be with you. I’m here to listen and accompany you calmly.",
    bible: { text: "The LORD is my light and my salvation—whom shall I fear?", ref: "Psalm 27:1" }
  };
}

app.get("/api/welcome", (req, res) => {
  const lang = safeLang(req.query?.lang);
  // saludo no se usa en payload, pero queda por si el front lo necesita algún día
  greetingByLocalTime(lang);
  res.json(welcomePayload(lang));
});

app.post("/api/welcome", (req, res) => {
  const lang = safeLang(req.body?.lang);
  greetingByLocalTime(lang);
  res.json(welcomePayload(lang));
});

/* === HeyGen: emitir token de sesión (NO toca OpenAI) === */
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
      body: "{}", // algunos proxys esperan body JSON
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

/* === HeyGen: configuración para el frontend (Railway) === */
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

/* ============================ Arranque ============================ */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Servidor listo en puerto ${PORT}`);
});
