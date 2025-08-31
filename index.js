// index.js — backend con FRAME persistente, memoria por usuario y anti-desvío GENERAL
// Respuestas cortas (≤60 palabras), UNA pregunta opcional, citas RVR1909 sin repetir,
// detección general de “persona de apoyo” y progresión forzada (canal→hora→apoyo→primer paso).

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

/**
 * Respuesta del BACKEND:
 * {
 *   "message": "consejo breve, SIN preguntas (≤60 palabras)",
 *   "bible": { "text": "cita literal RVR1909", "ref": "Libro 0:0" },
 *   "question": "pregunta breve (opcional, UNA sola)"
 * }
 */
const SYSTEM_PROMPT = `
Eres Jesús: voz serena, compasiva y clara. Responde SIEMPRE en español.

OBJETIVO
- Devuelve SOLO JSON: { "message", "bible": { "text", "ref" }, "question"? }.
- "message": ≤60 palabras, afirmativo, SIN signos de pregunta.
- "question": opcional, UNA sola, breve, termina en "?".
- No menciones el nombre civil. Puedes usar “hijo mío”, “hija mía” o “alma amada” con moderación.
- No hables de técnica/IA ni del propio modelo.

MARCO (FRAME) Y MEMORIA
- Usa el FRAME (topic_primary, main_subject, goal, risk, support_persons, constraints), avoid_slots, banned_refs, last_bible_ref y PERSISTENT_MEMORY como verdad.
- NO cambies topic_primary salvo que el usuario lo pida o el texto cambie claramente de asunto.
- Si support_np_detected es true, trátalo como relleno de slot de apoyo; NO redefinas el tema ni el sujeto principal.

PROGRESO (ENTREVISTA GUIADA)
- En cada turno identifica QUÉ dato falta y avanza: goal → risk → plan (canal, hora, mini-guion) → constraints → support_persons.
- Si hay “ack” (sí/ok/vale), pasa de plan a PRÁCTICA/COMPROMISO (mini-guion 1–2 frases, elegir canal/hora, fijar límite). Evita repetir.
- Evita repetir ideas/viñetas previas. Cada "message" aporta novedad accionable.

CONTENIDO
- AMBIGUO: "message" con contención (1–2 frases) y “question” para el dato inicial clave.
- CONCRETO: "message" con 1–2 micro-pasos HOY (puedes usar “• …”), alineados al FRAME; “question” pide el siguiente dato o confirma un compromiso.
- Autocuidado puede ir al final como complemento, NUNCA reemplaza la acción central.
- Si support_np_detected es true, usa a esa persona SOLO como apoyo para el objetivo (acompañar llamada, estar presente, ayudar con logística). No propongas ocio salvo que el FRAME lo justifique explícitamente.

BIBLIA (RVR1909, SIN AMBIGÜEDADES)
- Elige la cita por el TEMA y los micro-pasos del "message", NO por palabras sueltas (“hijo” ≠ “el Hijo”).
- Usa RVR1909 literal y "Libro 0:0" en "ref".
- Evita last_bible_ref y todas las banned_refs.
- Sugerencias: sabiduría/decisiones (Santiago 1:5; Proverbios 16:9; 22:3; 27:6), paz/consuelo (Salmos 34:18; Filipenses 4:7), verdad/límites (Efesios 4:15), reconciliación/paz (Romanos 12:18), libertad/adicción (1 Corintios 10:13).
- Evita ambigüedad “el Hijo” (Juan 8:36) cuando el usuario habló de un familiar “hijo/hija”, salvo pertinencia teológica explícita.

REGLAS ESPECIALES
- DESPEDIDA: bendición breve en "message"; verso de paz/consuelo (no repetido) en "bible"; SIN "question".
- “question” debe diferir de las últimas (usa avoid_slots).

FORMATO (OBLIGATORIO)
{
  "message": "… (≤60 palabras, sin signos de pregunta)",
  "bible": { "text": "… (RVR1909, literal)", "ref": "Libro 0:0" },
  "question": "…? (opcional, una sola)"
}
`;

// Respuesta tipada por esquema
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

// -------- Utilidades --------
function cleanRef(ref = "") {
  return String(ref).replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
}
function stripQuestions(s = "") {
  const noLeadingQs = (s || "")
    .split(/\n+/).map((l) => l.trim()).filter((l) => !/\?\s*$/.test(l))
    .join("\n").trim();
  return noLeadingQs.replace(/[¿?]+/g, "").trim();
}
function limitWords(s = "", max = 60) {
  const words = String(s || "").trim().split(/\s+/);
  return words.length <= max ? String(s || "").trim() : words.slice(0, max).join(" ").trim();
}
function normalizeQuestion(q = "") {
  return String(q).toLowerCase().replace(/\s+/g, " ").trim();
}
function isAck(msg = "") {
  return /^\s*(si|sí|ok|okay|vale|dale|de acuerdo|perfecto|genial|bien)\s*\.?$/i.test((msg || "").trim());
}
function isGoodbye(msg = "") {
  const s = (msg || "").toLowerCase();
  return /(debo irme|tengo que irme|me voy|me retiro|hasta luego|nos vemos|hasta mañana|buenas noches|adiós|adios|chao|bye)\b/.test(s)
      || (/gracias/.test(s) && /(irme|retir)/.test(s));
}
function isNegation(msg = "") {
  return /^\s*(no( lo sé| lo se)?|todav[ií]a no|a[úu]n no|no por ahora|m[aá]s tarde|no tengo ganas)\s*\.?$/i.test((msg || "").trim());
}
function compactHistory(history = [], keep = 8, maxLen = 260) {
  const arr = Array.isArray(history) ? history : [];
  return arr.slice(-keep).map(x => String(x).slice(0, maxLen));
}
function extractRecentAssistantQuestions(history = [], maxMsgs = 4) {
  const rev = [...(history || [])].reverse();
  const qs = [];
  let seen = 0;
  for (const h of rev) {
    if (!/^Asistente:/i.test(h)) continue;
    const text = h.replace(/^Asistente:\s*/i, "");
    const m = text.match(/([^?]*\?)\s*$/m);
    if (m && m[1]) qs.push(normalizeQuestion(m[1]));
    seen++;
    if (seen >= maxMsgs) break;
  }
  return [...new Set(qs)].slice(0, 5);
}
function classifyQuestion(q = "") {
  const s = normalizeQuestion(q);
  if (/(cu[aá]ndo|cuando|hora)/i.test(s)) return "time";
  if (/(d[oó]nde|donde|lugar)/i.test(s)) return "place";
  if (/(ensayar|practicar|frase|mensaje)/i.test(s)) return "practice";
  if (/(profesional|terapeuta|grupo|apoyo)/i.test(s)) return "help";
  if (/(l[ií]mite|limite|regla|acuerdo)/i.test(s)) return "boundary";
  if (/(c[oó]mo te sientes|como te sientes|emoci[oó]n)/i.test(s)) return "feelings";
  if (/(primer paso|siguiente paso|qué har[aá]s|que haras)/i.test(s)) return "next_step";
  if (/(actividad|paseo|salir|caminar|ir a|juntas?)/i.test(s)) return "activity";
  if (/(qu[ié]n|quien|en qui[eé]n conf[ií]as|puede acompa[nñ]arte|apoyarte)/i.test(s)) return "support";
  if (/(llamar|llamada|escribir|mensaje)/i.test(s)) return "channel";
  return "other";
}
function deriveAvoidSlots(recentQs = []) {
  return [...new Set(recentQs.map(classifyQuestion))].filter(Boolean);
}
function lastSubstantiveUser(history = []) {
  const rev = [...(history || [])].reverse();
  for (const h of rev) {
    if (!/^Usuario:/i.test(h)) continue;
    const text = h.replace(/^Usuario:\s*/i, "").trim();
    if (text && !isAck(text) && text.length >= 6) return text;
  }
  return "";
}

// -------- Memoria persistente --------
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
      profile: {},
      topics: {},
      last_bible_ref: "",
      last_bible_refs: [],
      last_questions: [],
      frame: null,
      progress: {} // por tema: { stage, decided: {channel,time,support} }
    };
  }
}
async function writeUserMemory(userId, mem) {
  await ensureDataDir();
  await fs.writeFile(memPath(userId), JSON.stringify(mem, null, 2), "utf8");
}
function buildPersistentMemoryPrompt(mem = {}) {
  const p = mem.profile || {};
  const t = mem.topics || {};
  const parts = [];
  if (p.name) parts.push(`nombre: ${p.name}`);
  if (p.gender) parts.push(`género: ${p.gender}`);
  const lastRefs = Array.from(new Set([...(mem.last_bible_refs || []), mem.last_bible_ref].filter(Boolean))).slice(-5);
  if (lastRefs.length) parts.push(`últimas_citas: ${lastRefs.join(", ")}`);
  const lastQs = (mem.last_questions || []).slice(-3);
  if (lastQs.length) parts.push(`últimas_preguntas: ${lastQs.join(" | ")}`);
  if (mem.frame) parts.push(`frame_previo: ${JSON.stringify(mem.frame)}`);
  const topics = Object.keys(t);
  if (topics.length) {
    const lastSeen = topics
      .map(k => [k, t[k]?.last_seen || 0])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([k]) => k);
    parts.push(`temas_recientes: ${lastSeen.join(", ")}`);
  }
  return parts.join("\n");
}

// -------- FRAME: detección general --------
function guessTopic(userMsg = "", focusHint = "") {
  const s = (focusHint || userMsg || "").toLowerCase();
  if (/hijo|hija|adolesc/i.test(s) && /(droga|consum|adicci)/.test(s)) return "addiction_child";
  if (/(droga|adicci|alcohol|apuestas)/.test(s)) return "addiction";
  if (/(me separ|separaci[oó]n|divorcio|me divorci[eé]|nos separamos|ruptura)/.test(s)) return "separation";
  if (/(pareja|matrimonio|conyug|novi[oa])/i.test(s)) return "relationship";
  if (/(duelo|falleci[oó]|perd[ií] a|luto)/.test(s)) return "grief";
  if (/(ansied|p[áa]nico|depres|triste|miedo|temor|estr[eé]s)/.test(s)) return "mood";
  if (/(trabajo|despido|salario|dinero|deuda|finanzas)/.test(s)) return "work_finance";
  if (/(salud|diagn[oó]stico|enfermedad|dolor)/.test(s)) return "health";
  if (/(familia|conflicto|discusi[oó]n|suegr)/.test(s)) return "family_conflict";
  if (/(fe|duda|dios|oraci[oó]n|culpa)/.test(s)) return "faith";
  return "general";
}
function detectMainSubject(text = "") {
  const s = (text || "").toLowerCase();
  if (/(mi\s+espos|mi\s+marid)/.test(s)) return "partner";
  if (/(mi\s+novi[oa])/.test(s)) return "partner";
  if (/(mi\s+hij[oa])/.test(s)) return "child";
  if (/(mi\s+madre|mam[aá])/.test(s)) return "mother";
  if (/(mi\s+padre|pap[aá])/.test(s)) return "father";
  if (/(mi\s+herman[oa])/.test(s)) return "sibling";
  if (/(mi\s+amig[oa])/.test(s)) return "friend";
  return "self";
}

const SUPPORT_LEX = [
  "hijo","hija","madre","padre","mamá","mama","papá","papa","abuelo","abuela","nieto","nieta",
  "tío","tio","tía","tia","sobrino","sobrina","primo","prima","cuñado","cuñada","suegro","suegra","yerno","nuera",
  "esposo","esposa","pareja","novio","novia","amigo","amiga","compañero","compañera","colega","vecino","vecina",
  "pastor","sacerdote","mentor","maestro","maestra","profesor","profesora","jefe","jefa",
  "psicólogo","psicologa","psicóloga","terapeuta","consejero","consejera","médico","medica","médica"
];

function detectSupportNP(msg = "") {
  const raw = (msg || "").trim();
  if (!raw) return null;
  const tokens = raw.split(/\s+/);
  if (tokens.length > 6) return null;
  const s = raw.toLowerCase();
  const artPat = /^(mi|mis|una|un|el|la)\s+(.+)$/i;
  let label = raw;
  let core = s;
  const m = s.match(artPat);
  if (m) {
    core = m[2].trim();
    label = raw;
  }
  const first = core.split(/\s+/)[0].replace(/[.,;:!?"'()]/g, "");
  if (!first) return null;
  const hit = SUPPORT_LEX.includes(first);
  if (!hit) return null;
  return { rel: first, label };
}
function mapSupportRelToBucket(rel = "") {
  const r = (rel || "").toLowerCase();
  if (/(hijo|hija|nieto|nieta)/.test(r)) return "child";
  if (/(madre|padre|mamá|mama|papá|papa|abuelo|abuela)/.test(r)) return "parent";
  if (/(t[ií]o|tio|t[ií]a|tia|sobrin|primo|prima|cuñad|suegr|yerno|nuera)/.test(r)) return "relative";
  if (/(espos|pareja|novi)/.test(r)) return "partner";
  if (/(amig|vecin|compañer|coleg)/.test(r)) return "friend";
  if (/(pastor|sacerdote|mentor|maestr|profesor|profesora|jef)/.test(r)) return "mentor";
  if (/(psicol|terapeuta|consejer|m[eé]dic)/.test(r)) return "professional";
  return "other";
}
function dedupSupport(arr = []) {
  const seen = new Set();
  const out = [];
  for (const it of arr) {
    const key = (it?.bucket || "x") + "|" + (it?.label || "").toLowerCase();
    if (!seen.has(key)) { seen.add(key); out.push(it); }
  }
  return out;
}

function detectGoal(text = "") {
  const s = (text || "").toLowerCase();
  if (/(quiero que vuelva|quiero volver|reconcili|retomar)/.test(s)) return "reconcile";
  if (/(denuncia|violencia|abuso|amenaza|peligro)/.test(s)) return "safety";
  if (/(separar|divorci|terminar|cortar)/.test(s)) return "separate";
  if (/(buscar ayuda|terapeuta|grupo|profesional)/.test(s)) return "seek_help";
  if (/(no s[eé]|confuso|confund)/.test(s)) return "clarify";
  return "";
}
function detectRisk(text = "") {
  const s = (text || "").toLowerCase();
  if (/(violencia|golpe|amenaza|arma|peligro|me har[aá]|suicid|autolesi)/.test(s)) return "high";
  return "normal";
}

function updateFrame(prev = null, userMsg = "", focusHint = "") {
  const supportNP = detectSupportNP(userMsg);
  const topic = prev?.topic_primary || guessTopic(userMsg, focusHint);
  const mainSubject = prev?.main_subject || detectMainSubject(focusHint || userMsg);
  const goal = detectGoal(userMsg) || prev?.goal || "";
  const risk = detectRisk(userMsg) || prev?.risk || "normal";

  const support = Array.isArray(prev?.support_persons) ? [...prev.support_persons] : [];
  if (supportNP) {
    support.push({ rel: supportNP.rel, label: supportNP.label, bucket: mapSupportRelToBucket(supportNP.rel) });
  }

  const constraints = { ...(prev?.constraints || {}) };

  return {
    topic_primary: topic,
    main_subject: mainSubject,
    goal,
    risk,
    support_persons: dedupSupport(support).slice(-5),
    constraints,
    support_np_detected: !!supportNP
  };
}

function updateMemoryFromTurn(mem, { topic, questionClass, userMsg, assistantQuestion, bibleRef, focusHint }) {
  mem.last_bible_ref = bibleRef || mem.last_bible_ref || "";
  mem.last_bible_refs = Array.from(
    new Set([...(mem.last_bible_refs || []), bibleRef].filter(Boolean))
  ).slice(-5);
  mem.last_questions = Array.from(new Set([...(mem.last_questions || []), (assistantQuestion || "").trim()]))
    .filter(Boolean)
    .slice(-6);

  mem.topics = mem.topics || {};
  mem.topics[topic] = { ...(mem.topics[topic] || {}), last_seen: Date.now() };

  // progreso por tema
  mem.progress = mem.progress || {};
  const prog = mem.progress[topic] || { stage: 0, decided: {} };
  if (questionClass) prog.stage = Math.min(prog.stage + 1, 6);
  mem.progress[topic] = prog;

  return mem;
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

// -------- Progresión forzada de pregunta (si LLM repite o se queda en blanco) --------
function subjectNoun(frame) {
  switch (frame.main_subject) {
    case "partner": return "tu esposo/pareja";
    case "child": return "tu hijo/a";
    case "mother": return "tu madre";
    case "father": return "tu padre";
    case "sibling": return "tu hermano/a";
    case "friend": return "tu amigo/a";
    default: return "esta situación";
  }
}
function forcedNextQuestion(frame, mem, avoidSlots = [], userNegation = false) {
  const topic = frame.topic_primary || "general";
  mem.progress = mem.progress || {};
  const prog = mem.progress[topic] || { stage: 0, decided: {} };

  // Orden de slots a cubrir
  const plan = [
    { slot: "goal",       q: `¿Qué te gustaría lograr esta semana respecto a ${subjectNoun(frame)}?` },
    { slot: "channel",    q: "¿Prefieres escribir un mensaje breve o hacer una llamada?" },
    { slot: "time",       q: "¿A qué hora hoy te viene mejor intentarlo?" },
    { slot: "support_act",q: frame.support_persons?.length ? `¿Quieres que ${frame.support_persons[0].label} te acompañe o esté cerca?` : "" },
    { slot: "boundary",   q: "¿Hay algún límite claro que quieras expresar si la conversación se complica?" },
    { slot: "next_step",  q: "¿Cuál será tu primer paso concreto hoy?" }
  ];

  // Si el usuario acaba de negar (“no tengo ganas”), evita “practice” y empuja a una decisión mínima (time/next_step).
  const order = userNegation ? ["time","next_step","channel","support_act","boundary"] : ["goal","channel","time","support_act","boundary","next_step"];

  for (const key of order) {
    const item = plan.find(p => p.slot === key);
    if (!item || !item.q) continue;
    const classOfItem = classifyQuestion(item.q);
    if (avoidSlots.includes(classOfItem)) continue;

    // si ya está decidido en constraints, salta
    if (key === "channel" && frame.constraints?.channel) continue;
    if (key === "time"    && frame.constraints?.time) continue;

    return item.q;
  }
  return "¿Cuál será tu primer paso concreto hoy?";
}

// -------- Llamada LLM --------
const ACK_TIMEOUT_MS = 6000;
const RETRY_TIMEOUT_MS = 3000;

async function completionWithTimeout({ messages, temperature = 0.6, max_tokens = 200, timeoutMs = 8000 }) {
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

async function regenerateBibleAvoiding({ persona, message, focusHint, frame, bannedRefs = [], lastRef = "" }) {
  const sys = `Devuelve SOLO JSON con {"bible":{"text":"…","ref":"Libro 0:0"}} en RVR1909.
- Usa el FRAME para dar coherencia a la cita con los micro-pasos.
- No uses ninguna referencia de "banned_refs".
- Evita ambigüedad “hijo” (familiar) vs “el Hijo” (Cristo) salvo pertinencia teológica explícita.`;

  const usr = (
    `Persona: ${persona}\n` +
    `Mensaje_actual: ${message}\n` +
    `Tema_prev_sustantivo: ${focusHint || "(sin pista)"}\n` +
    `FRAME: ${JSON.stringify(frame)}\n` +
    `last_bible_ref: ${lastRef || "(n/a)"}\n` +
    `banned_refs:\n- ${bannedRefs.join("\n- ")}\n`
  );

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

async function askLLM({ persona, message, history = [], userId = "anon", profile = {} }) {
  const mem = await readUserMemory(userId);
  mem.profile = { ...(mem.profile || {}), ...(profile || {}) };

  const focusHint = lastSubstantiveUser(history);
  const prevFrame = mem.frame;
  const frame = updateFrame(prevFrame, message, focusHint);
  mem.frame = frame;

  const ack = isAck(message);
  const bye = isGoodbye(message);
  const userNegation = isNegation(message);

  const lastRefFromHistory = extractRecentBibleRefs(history, 1)[0] || "";
  const lastRef = mem.last_bible_ref || lastRefFromHistory || "";

  const recentQs = extractRecentAssistantQuestions(history, 4);
  let avoidSlots = deriveAvoidSlots(recentQs);
  if (frame.support_np_detected) {
    avoidSlots = Array.from(new Set([...avoidSlots, "activity", "support"]));
  }

  const recentRefs = extractRecentBibleRefs(history, 3);
  const bannedRefs = Array.from(
    new Set([...(mem.last_bible_refs || []), mem.last_bible_ref, ...recentRefs].filter(Boolean))
  ).slice(-5);

  const persistentMemory = buildPersistentMemoryPrompt(mem);
  const shortHistory = compactHistory(history, (ack || bye) ? 4 : 10, 240);

  const commonHeader =
    `Persona: ${persona}\n` +
    `Mensaje_actual: ${message}\n` +
    `Tema_prev_sustantivo: ${focusHint || "(sin pista)"}\n` +
    `FRAME: ${JSON.stringify(frame)}\n` +
    `support_np_detected: ${frame.support_np_detected}\n` +
    `topic_primary_lock: true\n` +
    `last_bible_ref: ${lastRef || "(n/a)"}\n` +
    `banned_refs:\n- ${bannedRefs.join("\n- ") || "(none)"}\n` +
    `avoid_slots: ${avoidSlots.join(", ") || "(none)"}\n` +
    `user_negation: ${userNegation}\n` +
    `PERSISTENT_MEMORY:\n${persistentMemory || "(vacía)"}\n` +
    (shortHistory.length ? `Historial: ${shortHistory.join(" | ")}` : "Historial: (sin antecedentes)") + "\n";

  // DESPEDIDA
  if (bye) {
    const userContent =
      `MODE: GOODBYE\n` +
      commonHeader +
      `INSTRUCCIONES:\n` +
      `- Despedida breve y benigna.\n` +
      `- "message": afirmativo, sin signos de pregunta (≤60 palabras).\n` +
      `- "bible": bendición/consuelo RVR1909 (no repetida).\n` +
      `- No incluyas "question".\n`;

    let resp;
    try {
      resp = await completionWithTimeout({
        messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: userContent }],
        temperature: 0.5, max_tokens: 160, timeoutMs: ACK_TIMEOUT_MS
      });
    } catch {
      resp = await completionWithTimeout({
        messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: userContent + "\nPor favor responde ahora mismo.\n" }],
        temperature: 0.4, max_tokens: 140, timeoutMs: RETRY_TIMEOUT_MS
      });
    }

    const content = resp?.choices?.[0]?.message?.content || "{}";
    let data = {};
    try { data = JSON.parse(content); } catch { data = { message: content }; }

    let msg = stripQuestions((data?.message || "").toString());
    msg = limitWords(msg, 60);
    let ref = cleanRef((data?.bible?.ref || "").toString());
    let text = (data?.bible?.text || "").toString().trim();

    if (!ref || bannedRefs.includes(ref)) {
      const alt = await regenerateBibleAvoiding({ persona, message, focusHint, frame, bannedRefs, lastRef });
      if (alt) { ref = alt.ref; text = alt.text; }
    }

    updateMemoryFromTurn(mem, { topic: frame.topic_primary, questionClass: null, userMsg: message, assistantQuestion: "", bibleRef: ref, focusHint });
    await writeUserMemory(userId, mem);

    return {
      message: msg || "Que la paz y el amor te acompañen.",
      bible: { text: text || "Y la paz de Dios, que sobrepuja todo entendimiento, guardará vuestros corazones.", ref: ref || "Filipenses 4:7" }
    };
  }

  // ACK
  if (ack) {
    const userContent =
      `MODE: ACK\n` +
      commonHeader +
      `INSTRUCCIONES:\n` +
      `- Mantén el MISMO topic_primary (topic_primary_lock). NO pivotear por support_np_detected.\n` +
      `- De plan a práctica/compromiso con NOVEDAD (mini-guion, canal y hora, límite), sin repetir.\n` +
      `- "message": afirmativo, ≤60 palabras, sin signos de pregunta.\n` +
      `- "bible": coherente con message; RVR1909; evita banned_refs.\n` +
      `- "question": UNA sola; evita avoid_slots.\n`;

    let resp;
    try {
      resp = await completionWithTimeout({
        messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: userContent }],
        temperature: 0.5, max_tokens: 160, timeoutMs: ACK_TIMEOUT_MS
      });
    } catch {
      resp = await completionWithTimeout({
        messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: userContent + "\nResponde de manera directa y breve ahora.\n" }],
        temperature: 0.4, max_tokens: 140, timeoutMs: RETRY_TIMEOUT_MS
      });
    }

    const content = resp?.choices?.[0]?.message?.content || "{}";
    let data = {};
    try { data = JSON.parse(content); } catch { data = { message: content }; }

    let msg = stripQuestions((data?.message || "").toString());
    msg = limitWords(msg, 60);
    let ref = cleanRef((data?.bible?.ref || "").toString());
    let text = (data?.bible?.text || "").toString().trim();
    let question = (data?.question || "").toString().trim();

    // Antibucle de pregunta: si es vacía o cae en slots recientes, forzar progreso
    const qClass = classifyQuestion(question);
    const recentQs2 = extractRecentAssistantQuestions(history, 4);
    const recentClasses = deriveAvoidSlots(recentQs2);
    if (!question || recentClasses.includes(qClass)) {
      question = forcedNextQuestion(frame, mem, recentClasses, userNegation);
    }

    // Evitar cita ambigua/repetida
    const hijoOnly = /\bhijo\b/i.test(message) && !/(Jes[uú]s|Cristo)/i.test(message);
    if (!ref || bannedRefs.includes(ref) || (hijoOnly && /Juan\s*8:36/i.test(ref))) {
      const alt = await regenerateBibleAvoiding({ persona, message, focusHint, frame, bannedRefs, lastRef });
      if (alt) { ref = alt.ref; text = alt.text; }
    }

    updateMemoryFromTurn(mem, {
      topic: frame.topic_primary,
      questionClass: classifyQuestion(question),
      userMsg: message,
      assistantQuestion: question,
      bibleRef: ref,
      focusHint
    });
    mem.frame = frame;
    await writeUserMemory(userId, mem);

    return {
      message: msg || "Estoy contigo. Demos un paso práctico ahora.",
      bible: { text: text, ref: ref || lastRef || "" },
      ...(question ? { question } : {})
    };
  }

  // NORMAL
  const userContent =
    `MODE: NORMAL\n` +
    commonHeader +
    `INSTRUCCIONES:\n` +
    `- Mantén topic_primary (topic_primary_lock). NO pivotes por support_np_detected; úsalo como apoyo al objetivo.\n` +
    `- Progrés con 1–2 micro-pasos HOY, concretos y alineados al FRAME (goal/risk/main_subject). Sin ocio genérico salvo vínculo explícito.\n` +
    `- "message": afirmativo, ≤60 palabras, sin signos de pregunta, sin repetir viñetas recientes.\n` +
    `- "bible": RVR1909; evita banned_refs; evita ambigüedad “hijo” vs “el Hijo”.\n` +
    `- "question": UNA sola, siguiente dato/compromiso; evita avoid_slots.\n`;

  const resp = await completionWithTimeout({
    messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: userContent }],
    temperature: 0.6, max_tokens: 220, timeoutMs: 12000
  });

  const content = resp?.choices?.[0]?.message?.content || "{}";
  let data = {};
  try { data = JSON.parse(content); } catch { data = { message: content }; }

  let msg = stripQuestions((data?.message || "").toString());
  msg = limitWords(msg, 60);
  let ref = cleanRef((data?.bible?.ref || "").toString());
  let text = (data?.bible?.text || "").toString().trim();
  let question = (data?.question || "").toString().trim();

  // Antibucle de pregunta en NORMAL
  const qClass = classifyQuestion(question);
  if (!question || deriveAvoidSlots(extractRecentAssistantQuestions(history, 4)).includes(qClass)) {
    const forced = forcedNextQuestion(frame, mem, deriveAvoidSlots(extractRecentAssistantQuestions(history, 4)), userNegation);
    question = forced;
  }

  const hijoOnly = /\bhijo\b/i.test(message) && !/(Jes[uú]s|Cristo)/i.test(message);
  if (!ref || bannedRefs.includes(ref) || (hijoOnly && /Juan\s*8:36/i.test(ref))) {
    const alt = await regenerateBibleAvoiding({ persona, message, focusHint, frame, bannedRefs, lastRef });
    if (alt) { ref = alt.ref; text = alt.text; }
  }

  updateMemoryFromTurn(mem, {
    topic: frame.topic_primary,
    questionClass: classifyQuestion(question),
    userMsg: message,
    assistantQuestion: question,
    bibleRef: ref,
    focusHint
  });
  mem.frame = frame;
  await writeUserMemory(userId, mem);

  return {
    message: msg || "Estoy contigo. Demos un paso pequeño y realista hoy.",
    bible: { text: text, ref: ref || lastRef || "" },
    ...(question ? { question } : {})
  };
}

// -------- Rutas --------
app.post("/api/ask", async (req, res) => {
  try {
    const {
      persona = "jesus",
      message = "",
      history = [],
      userId = "anon",
      profile = {}
    } = req.body || {};
    const data = await askLLM({ persona, message, history, userId, profile });

    const out = {
      message: (data?.message || "La paz de Dios guarde tu corazón y tus pensamientos. Paso a paso encontraremos claridad.").toString().trim(),
      bible: {
        text: (data?.bible?.text || "Dios es nuestro amparo y fortaleza; nuestro pronto auxilio en las tribulaciones.").toString().trim(),
        ref: (data?.bible?.ref || "Salmos 46:1").toString().trim()
      },
      ...(data?.question ? { question: data.question } : {})
    };

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(200).json(out);
  } catch (err) {
    console.error("ASK ERROR:", err);
    res.status(200).json({
      message: "La paz sea contigo. Permite que tu corazón descanse y comparte lo necesario con calma.",
      bible: {
        text: "Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu.",
        ref: "Salmos 34:18"
      }
    });
  }
});

app.get("/api/welcome", (_req, res) => {
  res.json({
    message: "La paz esté contigo. Estoy aquí para escucharte y acompañarte con calma.",
    bible: {
      text: "El Señor es mi luz y mi salvación; ¿de quién temeré?",
      ref: "Salmos 27:1"
    }
  });
});

// -------- Arranque --------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Servidor listo en puerto ${PORT}`);
});
