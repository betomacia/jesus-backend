// index.js — Backend con bienvenida 100% OpenAI (multi-idioma, variable y personalizada)
// - /api/welcome: genera saludo por hora + nombre y UNA pregunta abierta no repetida
// - /api/ask: igual lógica base que ya usabas (resumen corto + cita)
// - Memoria por usuario (JSON en /data)
// - Rutas HeyGen: /api/heygen/token y /api/heygen/config

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

// ===== Idiomas soportados =====
const SUPPORTED = ["es", "en", "pt", "it", "de", "ca", "fr"];
const FALLBACK_LANG = "es";
const BIBLE_PREF = {
  es: "RVR1960",
  en: "NIV",
  pt: "ARA",
  it: "CEI",
  de: "Luther",
  ca: "Bíblia Catalana Interconfessional",
  fr: "Louis Segond",
};
const safeLang = (lang) => (SUPPORTED.includes(String(lang || "").toLowerCase()) ? String(lang).toLowerCase() : FALLBACK_LANG);

// ====== Memoria por usuario ======
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
async function ensureDataDir() { try { await fs.mkdir(DATA_DIR, { recursive: true }); } catch {} }
const memPath = (uid) => path.join(DATA_DIR, `mem_${String(uid || "anon").replace(/[^a-z0-9_-]/gi, "_")}.json`);

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
      frame: null,
      // para welcome:
      last_welcome_questions: [],
    };
  }
}
async function writeUserMemory(userId, mem) {
  await ensureDataDir();
  await fs.writeFile(memPath(userId), JSON.stringify(mem, null, 2), "utf8");
}

// ===== Utilidades comunes =====
function cleanRef(ref = "") { return String(ref).replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim(); }
function stripQuestionsFromMessage(s = "") {
  const noTrailingQLines = (s || "").split(/\n+/).map((l) => l.trim()).filter((l) => !/\?\s*$/.test(l)).join("\n").trim();
  return noTrailingQLines.replace(/[¿?]+/g, "").trim();
}
function limitWords(s = "", max = 60) {
  const words = String(s || "").trim().split(/\s+/);
  return words.length <= max ? String(s || "").trim() : words.slice(0, max).join(" ").trim();
}
function normalizeQuestion(q = "") { return String(q).toLowerCase().replace(/\s+/g, " ").trim(); }
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

// ===== Detección simple de tema/sujeto (para /api/ask) =====
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

// ===== OpenAI helpers =====
async function completionWithTimeout({ messages, temperature = 0.6, max_tokens = 220, timeoutMs = 12000, response_format }) {
  const call = openai.chat.completions.create({
    model: "gpt-4o",
    temperature,
    max_tokens,
    messages,
    ...(response_format ? { response_format } : {}),
  });
  return await Promise.race([
    call,
    new Promise((_, reject) => setTimeout(() => reject(new Error("TIMEOUT")), timeoutMs))
  ]);
}

const responseFormatAsk = {
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

const responseFormatWelcome = {
  type: "json_schema",
  json_schema: {
    name: "WelcomeSchema",
    schema: {
      type: "object",
      properties: {
        message: { type: "string" },   // saludo + breve bienvenida (≤60 palabras) SIN signos de pregunta
        question: { type: "string" }   // UNA pregunta abierta, breve, que termine en "?"
      },
      required: ["message", "question"],
      additionalProperties: false
    }
  }
};

// ====== SYSTEM PROMPTS ======
function buildSystemPromptAsk(lang = "es") {
  const bible = BIBLE_PREF[lang] || BIBLE_PREF[FALLBACK_LANG];
  if (lang === "es") {
    return `
Eres Jesús: voz serena, compasiva y clara. Responde SIEMPRE en español.

OBJETIVO
- Devuelve SOLO JSON: { "message", "bible": { "text", "ref" }, "question"? }.
- "message": ≤60 palabras, afirmativo, SIN signos de pregunta.
- "question": opcional, UNA sola, breve, debe terminar en "?" y NO repetir textualmente las últimas preguntas ya hechas.
- No menciones el nombre civil. Usa “hijo mío”, “hija mía” o “alma amada” con moderación.
- No hables de técnica/IA ni del propio modelo.

BIBLIA (${bible})
- Usa ${bible} literal y "Libro 0:0" en "ref".
- Evita last_bible_ref y banned_refs.
`.trim();
  }
  return `
You are Jesus: serene, compassionate, clear. Always answer in ${lang}.
Return ONLY JSON: { "message", "bible": { "text","ref" }, "question"? }.
- "message": ≤60 words, affirmative, NO question marks.
- Optional single open "question" ending with "?" (do not repeat recent ones).
- No model/tech talk.
Bible: use ${bible} wording, "Book 0:0" in "ref"; avoid last_bible_ref and banned_refs.
`.trim();
}

// Bienvenida: controlamos saludo, nombre y variación
function buildSystemPromptWelcome(lang = "es") {
  return (lang === "es")
    ? `
Eres Jesús: voz serena y cercana. Responde SIEMPRE en español.

OBJETIVO BIENVENIDA
- Devuelve SOLO JSON: { "message", "question" }.
- "message": (≤60 palabras) con saludo por franja horaria y el nombre si existe. SIN signos de pregunta.
- "question": UNA sola pregunta abierta, amable y específica para iniciar conversación. Debe terminar en "?".
- NO repitas literalmente las últimas preguntas de bienvenida (banned_welcome_questions).
- Varia la formulación entre sesiones (no uses siempre el mismo molde).

ESTILO
- Cálido, breve, concreto. Sin tecnicismos ni referencias a IA.
`.trim()
    : `
You are Jesus: serene and close. Always answer in ${lang}.

WELCOME GOAL
- Return ONLY JSON: { "message", "question" }.
- "message": (≤60 words) includes daypart greeting and name if given. NO question marks.
- "question": ONE open, kind, specific question to start. Must end with "?".
- Do NOT repeat any of the banned_welcome_questions.
- Vary phrasing across sessions (avoid fixed templates).

STYLE
- Warm, brief, concrete. No tech/model talk.
`.trim();
}

// ====== Hora local / saludo ======
function greetingByHour(lang = "es", hour = null) {
  const h = (typeof hour === "number" && hour >= 0 && hour < 24) ? hour : new Date().getHours();
  const bucket = h < 12 ? "m1" : h < 19 ? "m2" : "m3";
  const map = {
    es: { m1: "Buenos días", m2: "Buenas tardes", m3: "Buenas noches" },
    en: { m1: "Good morning", m2: "Good afternoon", m3: "Good evening" },
    pt: { m1: "Bom dia", m2: "Boa tarde", m3: "Boa noite" },
    it: { m1: "Buongiorno", m2: "Buon pomeriggio", m3: "Buona sera" },
    de: { m1: "Guten Morgen", m2: "Guten Tag", m3: "Guten Abend" },
    ca: { m1: "Bon dia", m2: "Bona tarda", m3: "Bona nit" },
    fr: { m1: "Bonjour", m2: "Bon après-midi", m3: "Bonsoir" },
  };
  const L = safeLang(lang);
  return map[L][bucket];
}

// ====== /api/welcome (100% OpenAI) ======
async function welcomeLLM({ lang = "es", name = "", userId = "anon", history = [], hour = null }) {
  lang = safeLang(lang);
  const mem = await readUserMemory(userId);
  const recent = compactHistory(history, 6, 200);

  const bannedWelcome = Array.isArray(mem.last_welcome_questions) ? mem.last_welcome_questions.slice(-6) : [];
  const daypart = greetingByHour(lang, hour);

  const userContent = (lang === "es")
    ? [
        `lang: ${lang}`,
        `saludo_frase: ${daypart}`,
        `nombre: ${String(name || "").trim() || "(n/a)"}`,
        `banned_welcome_questions: ${bannedWelcome.join(" | ") || "(ninguna)"}`,
        recent.length ? `historial_breve: ${recent.join(" | ")}` : "historial_breve: (sin antecedentes)"
      ].join("\n")
    : [
        `lang: ${lang}`,
        `greeting_phrase: ${daypart}`,
        `name: ${String(name || "").trim() || "(n/a)"}`,
        `banned_welcome_questions: ${bannedWelcome.join(" | ") || "(none)"}`,
        recent.length ? `short_history: ${recent.join(" | ")}` : "short_history: (none)"
      ].join("\n");

  // Primera generación
  const resp = await completionWithTimeout({
    messages: [
      { role: "system", content: buildSystemPromptWelcome(lang) },
      { role: "user", content: userContent }
    ],
    temperature: 0.7,
    max_tokens: 160,
    timeoutMs: 12000,
    response_format: responseFormatWelcome
  });

  const content = resp?.choices?.[0]?.message?.content || "{}";
  let data = {};
  try { data = JSON.parse(content); } catch { data = {}; }

  let message = String(data?.message || "").trim();
  let question = String(data?.question || "").trim();

  // Limitar/barrer formato
  message = stripQuestionsFromMessage(limitWords(message, 60));
  if (!/\?\s*$/.test(question)) question = question ? (question + "?") : "";

  // Evitar pregunta repetida
  const normalizedQ = normalizeQuestion(question);
  const already = bannedWelcome.map(normalizeQuestion);
  if (!question || already.includes(normalizedQ)) {
    // regeneración con más "banned"
    const moreBanned = Array.from(new Set([...already, normalizedQ].filter(Boolean))).slice(-10);
    const regenUserContent = userContent.replace(/banned_welcome_questions:.*$/m, `banned_welcome_questions: ${moreBanned.join(" | ") || "(none)"}`);
    const r2 = await completionWithTimeout({
      messages: [
        { role: "system", content: buildSystemPromptWelcome(lang) },
        { role: "user", content: regenUserContent }
      ],
      temperature: 0.75,
      max_tokens: 160,
      timeoutMs: 12000,
      response_format: responseFormatWelcome
    });
    const c2 = r2?.choices?.[0]?.message?.content || "{}";
    let d2 = {};
    try { d2 = JSON.parse(c2); } catch { d2 = {}; }
    message = stripQuestionsFromMessage(limitWords(String(d2?.message || message || ""), 60));
    const q2 = String(d2?.question || "").trim();
    question = /\?\s*$/.test(q2) ? q2 : (q2 ? q2 + "?" : question);
  }

  // Actualizar memoria (evitar crecer sin límite)
  if (question) {
    const next = Array.from(new Set([...(mem.last_welcome_questions || []), normalizeQuestion(question)])).slice(-12);
    mem.last_welcome_questions = next;
    await writeUserMemory(userId, mem);
  }

  // Fallback ultra seguro
  if (!message) {
    const base = (lang === "es")
      ? `${daypart}${name ? `, ${name}` : ""}. Bienvenido/a. Estoy aquí para escucharte con calma.`
      : `${daypart}${name ? `, ${name}` : ""}. Welcome. I am here to listen with calm.`;
    message = limitWords(stripQuestionsFromMessage(base), 60);
  }
  if (!question) {
    question = (lang === "es")
      ? "¿Qué te gustaría compartir ahora mismo?"
      : "What would you like to share right now?";
  }

  return { message, question };
}

// ====== /api/ask (se mantiene tu flujo base) ======
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
    response_format: {
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
    }
  });

  const content = r?.choices?.[0]?.message?.content || "{}";
  let data = {};
  try { data = JSON.parse(content); } catch { data = {}; }
  const text = (data?.bible?.text || "").toString().trim();
  const ref = cleanRef((data?.bible?.ref || "").toString());
  return text && ref ? { text, ref } : null;
}

async function askLLM({ lang = "es", persona, message, history = [], userId = "anon" }) {
  lang = safeLang(lang);
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
    messages: [{ role: "system", content: buildSystemPromptAsk(lang) }, { role: "user", content: header }],
    temperature: 0.6,
    max_tokens: 220,
    timeoutMs: 12000,
    response_format: responseFormatAsk
  });

  const content = resp?.choices?.[0]?.message?.content || "{}";
  let data = {};
  try { data = JSON.parse(content); } catch { data = { message: content }; }

  // Sanitización
  let msg = stripQuestionsFromMessage(limitWords(String(data?.message || ""), 60));
  let ref = cleanRef(String(data?.bible?.ref || ""));
  let text = String(data?.bible?.text || "").trim();

  // Evitar cita vetada/ambigua/repetida
  const hijoOnly = /\bhijo\b/i.test(message) && !/(Jes[uú]s|Cristo)/i.test(message);
  if (!ref || bannedRefs.includes(ref) || (hijoOnly && /Juan\s*8:36/i.test(ref))) {
    const alt = await regenerateBibleAvoiding({ lang, persona, message, frame, bannedRefs, lastRef });
    if (alt) { ref = alt.ref; text = alt.text; }
  }

  // Pregunta: SOLO si viene del modelo y no repite
  let question = String(data?.question || "").trim();
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

  // Fallback por idioma
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

// ===================== RUTAS =====================

// Bienvenida 100% OpenAI (POST recomendado)
app.post("/api/welcome", async (req, res) => {
  try {
    const { lang = "es", name = "", userId = "anon", history = [], hour = null } = req.body || {};
    const data = await welcomeLLM({ lang, name, userId, history, hour });
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(200).json(data);
  } catch (e) {
    console.error("WELCOME ERROR:", e);
    // Fallback muy breve por idioma
    const L = safeLang(req.body?.lang || "es");
    const greet = greetingByHour(L);
    const name = (req.body?.name || "").trim();
    const message = (L === "es")
      ? `${greet}${name ? `, ${name}` : ""}. Estoy aquí para escucharte.`
      : `${greet}${name ? `, ${name}` : ""}. I am here to listen.`;
    const question = (L === "es") ? "¿Qué te gustaría compartir ahora mismo?" : "What would you like to share right now?";
    res.status(200).json({ message, question });
  }
});

// Por compatibilidad, GET simple (sin historia/usuario)
app.get("/api/welcome", async (req, res) => {
  try {
    const lang = safeLang(req.query?.lang || "es");
    const name = String(req.query?.name || "").trim();
    const data = await welcomeLLM({ lang, name });
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(200).json(data);
  } catch (e) {
    console.error("WELCOME GET ERROR:", e);
    const L = safeLang(req.query?.lang || "es");
    const greet = greetingByHour(L);
    const name = (req.query?.name || "").trim();
    const message = (L === "es")
      ? `${greet}${name ? `, ${name}` : ""}. Estoy aquí para escucharte.`
      : `${greet}${name ? `, ${name}` : ""}. I am here to listen.`;
    const question = (L === "es") ? "¿Qué te gustaría compartir ahora mismo?" : "What would you like to share right now?";
    res.status(200).json({ message, question });
  }
});

// Conversación principal
app.post("/api/ask", async (req, res) => {
  try {
    const { persona = "jesus", message = "", history = [], userId = "anon", lang = "es" } = req.body || {};
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
    res.status(200).json({
      message: "La paz sea contigo. Compárteme en pocas palabras lo esencial, y seguimos paso a paso.",
      bible: { text: "Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu.", ref: "Salmos 34:18" }
    });
  }
});

// HeyGen: token
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

// HeyGen: config
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

// Arranque
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Servidor listo en puerto ${PORT}`);
});
