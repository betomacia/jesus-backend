// index.js — backend con FRAME persistente, progresión de preguntas y citas bíblicas temáticas sin repetición

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
 *   "message": "consejo breve, SIN preguntas",
 *   "bible": { "text": "cita literal RVR1909", "ref": "Libro 0:0" },
 *   "question": "pregunta breve (opcional, UNA sola)"
 * }
 */
const SYSTEM_PROMPT = `
Eres Jesús: voz serena, compasiva y clara. Responde SIEMPRE en español.

OBJETIVO
- Devuelve SOLO JSON con: { "message", "bible": { "text", "ref" }, "question"? }.
- "message": consejo breve (<=120 palabras), AFIRMATIVO y SIN signos de pregunta.
- JAMÁS incluyas preguntas en "message". Si corresponde, haz UNA pregunta breve en "question".
- No menciones el nombre civil del usuario. Usa "hijo mío", "hija mía" o "alma amada" con moderación.
- No hables de técnica/IA ni del propio modelo.

MARCO DE CONVERSACIÓN (FRAME)
- Usa el FRAME provisto (topic_primary, main_subject, goal, risk, support_persons, constraints) como fuente de verdad.
- NO cambies topic_primary salvo que el usuario lo pida explícitamente o se detecte un cambio claro de asunto.
- Respuestas mínimas tipo “mi hija / mi madre / un amigo” son **relleno de slot** (support_persons) y NO redefinen el tema.
- Si falta un dato clave, usa "question" para pedirlo (SOLO uno por turno). Evita repetir el mismo slot (usa avoid_slots).

PROGRESO
- Evita repetir lo ya dicho. Cada "message" debe aportar novedad útil: ejemplo concreto, mini-guion, decisión binaria, contacto específico, límite práctico.
- Si el usuario responde con acuso (“sí/ok/vale”), pasa de plan a PRÁCTICA/COMPROMISO (ensayo de frase, fijar hora, límite, contacto), sin repetir.
- Considera "question_class_hint" para la siguiente pregunta (p.ej., decision, time, practice, boundary, help, next_step).

AUTO-CUIDADO
- El autocuidado (respirar/orar/diario) es complemento, no reemplazo del tema central. Inclúyelo al final si hay espacio y es pertinente.

BIBLIA (TEMÁTICA Y SIN REPETIR)
- Elige la cita por el TEMA y por el contenido de "message" (micro-pasos), NO por coincidencias superficiales (p.ej., “hijo” ≠ “el Hijo”).
- No uses ninguna referencia en "banned_refs". Evita repetir last_bible_ref.
- Usa RVR1909 literal y "Libro 0:0" en "ref".

CASOS
- AMBIGUO: "message" con contención (2–3 frases), y en "question" UNA puerta al dato clave inicial.
- CONCRETO: "message" con 2–3 micro-pasos HOY (• …), adaptados al FRAME; "question" pide el siguiente dato o confirma un compromiso.

FORMATO (OBLIGATORIO)
{
  "message": "… (sin signos de pregunta)",
  "bible": { "text": "…", "ref": "Libro 0:0" },
  "question": "… (opcional, una sola pregunta)"
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
  return /^\s*(no( lo sé| lo se)?|todav[ií]a no|a[úu]n no|no por ahora|m[aá]s tarde)\s*\.?$/i.test((msg || "").trim());
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
  if (/(ensayar|practicar|frase)/i.test(s)) return "practice";
  if (/(profesional|terapeuta|grupo|apoyo)/i.test(s)) return "help";
  if (/(l[ií]mite|limite|regla|acuerdo)/i.test(s)) return "boundary";
  if (/(c[oó]mo te sientes|como te sientes|emoci[oó]n)/i.test(s)) return "feelings";
  if (/(primer paso|siguiente paso)/i.test(s)) return "next_step";
  if (/(actividad|paseo|salir|caminar|ir a|juntas?)/i.test(s)) return "activity";
  if (/(mensaje breve|llamada corta|canal)/i.test(s)) return "decision";
  if (/(apoy[oa]|qu[ié]n|quien|en qui[eé]n)/i.test(s)) return "support";
  return "other";
}
function deriveAvoidSlots(recentQs = []) {
  return [...new Set(recentQs.map(classifyQuestion))].filter(Boolean);
}
function nextQuestionClassHint(recentQs = []) {
  const last = recentQs[0] || "";
  const cls = classifyQuestion(last);
  switch (cls) {
    case "support": return "decision";
    case "decision": return "time";
    case "time": return "practice";
    case "practice": return "boundary";
    default: return "next_step";
  }
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
      flags: { interpersonal_injected: {} }
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
function isShortSupportNP(msg = "") {
  const s = (msg || "").trim().toLowerCase();
  return /^(mi|una|un)\s+(hija|hijo|madre|padre|mam[aá]|pap[aá]|amig[oa]|herman[oa]|compa[nñ]er[oa])s?$/i.test(s);
}
function parseRelation(msg = "") {
  const s = (msg || "").toLowerCase();
  if (/hija/.test(s)) return "daughter";
  if (/hijo/.test(s)) return "son";
  if (/madre|mam[aá]/.test(s)) return "mother";
  if (/padre|pap[aá]/.test(s)) return "father";
  if (/amig[oa]/.test(s)) return "friend";
  if (/herman[oa]/.test(s)) return "sibling";
  if (/compa[nñ]er[oa]/.test(s)) return "partner_friend";
  return "other";
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
function dedupSupport(arr = []) {
  const seen = new Set();
  const out = [];
  for (const it of arr) {
    const key = (it?.rel || "x") + "|" + (it?.label || "").toLowerCase();
    if (!seen.has(key)) { seen.add(key); out.push(it); }
  }
  return out;
}
function updateFrame(prev = null, userMsg = "", focusHint = "") {
  const topic = prev?.topic_primary || guessTopic(userMsg, focusHint);
  const mainSubject = prev?.main_subject || detectMainSubject(focusHint || userMsg);
  const goal = detectGoal(userMsg) || prev?.goal || "";
  const risk = detectRisk(userMsg) || prev?.risk || "normal";

  const support = Array.isArray(prev?.support_persons) ? [...prev.support_persons] : [];
  if (isShortSupportNP(userMsg)) {
    support.push({ rel: parseRelation(userMsg), label: userMsg.trim() });
  }
  const constraints = { ...(prev?.constraints || {}) };

  return {
    topic_primary: topic,
    main_subject: mainSubject,
    goal,
    risk,
    support_persons: dedupSupport(support).slice(-5),
    constraints
  };
}

function updateMemoryFromTurn(mem, { userMsg, assistantQuestion, bibleRef, focusHint }) {
  mem.last_bible_ref = bibleRef || mem.last_bible_ref || "";
  mem.last_bible_refs = Array.from(
    new Set([...(mem.last_bible_refs || []), bibleRef].filter(Boolean))
  ).slice(-5);
  mem.last_questions = Array.from(new Set([...(mem.last_questions || []), (assistantQuestion || "").trim()]))
    .filter(Boolean)
    .slice(-6);
  mem.topics = mem.topics || {};
  const topic = guessTopic(userMsg, focusHint);
  mem.topics[topic] = { ...(mem.topics[topic] || {}), last_seen: Date.now() };
  mem.flags = mem.flags || { interpersonal_injected: {} };
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

// micro-llamada para re-generar SOLO la cita si vino repetida/prohibida o ambigua
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
- Evita ambigüedad entre “hijo” (niño) y “el Hijo” (Cristo) salvo que sea teológicamente pertinente al contenido.`;

  const usr = `Persona: ${persona}
Mensaje_actual: ${message}
Tema_prev_sustantivo: ${focusHint || "(sin pista)"}
FRAME: ${JSON.stringify(frame)}
last_bible_ref: ${lastRef || "(n/a)"}
banned_refs:
- ${bannedRefs.join("\n- ")}`;

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

function lastSubstantiveUser(history = []) {
  const rev = [...(history || [])].reverse();
  for (const h of rev) {
    if (!/^Usuario:/i.test(h)) continue;
    const text = h.replace(/^Usuario:\s*/i, "").trim();
    if (text && !isAck(text) && text.length >= 6) return text;
  }
  return "";
}

function recentlyInjectedInterpersonal(mem, topic) {
  const flags = (mem.flags && mem.flags.interpersonal_injected) || {};
  return Boolean(flags[topic]);
}
function markInjected(mem, topic) {
  mem.flags = mem.flags || {};
  mem.flags.interpersonal_injected = mem.flags.interpersonal_injected || {};
  mem.flags.interpersonal_injected[topic] = true;
}

// -------- Núcleo --------
async function askLLM({ persona, message, history = [], userId = "anon", profile = {} }) {
  const mem = await readUserMemory(userId);
  mem.profile = { ...(mem.profile || {}), ...(profile || {}) };

  const focusHint = lastSubstantiveUser(history);
  const prevFrame = mem.frame;
  const frame = updateFrame(prevFrame, message, focusHint);
  mem.frame = frame; // se persistirá al final

  const ack = isAck(message);
  const bye = isGoodbye(message);
  const userNegation = isNegation(message);

  const lastRefFromHistory = extractRecentBibleRefs(history, 1)[0] || "";
  const lastRef = mem.last_bible_ref || lastRefFromHistory || "";

  const recentQsNorm = extractRecentAssistantQuestions(history, 4);
  let avoidSlots = deriveAvoidSlots(recentQsNorm);

  // Si el usuario acaba de responder con un NP de apoyo (p.ej., "mi hija"), evita desviar a "activity"
  const topicIsRelationshipLike = ["separation", "relationship"].includes(frame.topic_primary);
  if (isShortSupportNP(message) && topicIsRelationshipLike) {
    avoidSlots = Array.from(new Set([...avoidSlots, "activity"]));
  }

  const recentRefs = extractRecentBibleRefs(history, 3);
  const bannedRefs = Array.from(
    new Set([...(mem.last_bible_refs || []), mem.last_bible_ref, ...recentRefs].filter(Boolean))
  ).slice(-5);

  const persistentMemory = buildPersistentMemoryPrompt(mem);
  const shortHistory = compactHistory(history, (ack || bye) ? 4 : 10, 240);
  const qClassHint = nextQuestionClassHint(recentQsNorm);

  const commonHeader = `Persona: ${persona}
Mensaje_actual: ${message}
Tema_prev_sustantivo: ${focusHint || "(sin pista)"}
FRAME: ${JSON.stringify(frame)}
last_bible_ref: ${lastRef || "(n/a)"}
banned_refs:
- ${bannedRefs.join("\n- ") || "(none)"}
avoid_slots: ${avoidSlots.join(", ") || "(none)"}
question_class_hint: ${qClassHint}
user_negation: ${userNegation}
PERSISTENT_MEMORY:
${persistentMemory || "(vacía)"}
${shortHistory.length ? `Historial: ${shortHistory.join(" | ")}` : "Historial: (sin antecedentes)"}\n`;

  // DESPEDIDA
  if (bye) {
    const userContent = `MODE: GOODBYE
${commonHeader}
INSTRUCCIONES:
- Despedida breve y benigna.
- "message": afirmativo, sin signos de pregunta.
- "bible": bendición/consuelo RVR1909, NO repitas banned_refs.
- No incluyas "question".`;

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
    let ref = cleanRef((data?.bible?.ref || "").toString());
    let text = (data?.bible?.text || "").toString().trim();

    if (!ref || bannedRefs.includes(ref)) {
      const alt = await regenerateBibleAvoiding({ persona, message, focusHint, frame, bannedRefs, lastRef });
      if (alt) { ref = alt.ref; text = alt.text; }
    }

    updateMemoryFromTurn(mem, { userMsg: message, assistantQuestion: "", bibleRef: ref, focusHint });
    mem.frame = frame;
    await writeUserMemory(userId, mem);

    return {
      message: msg || "Que la paz y el amor te acompañen.",
      bible: { text: text || "Y la paz de Dios, que sobrepuja todo entendimiento, guardará vuestros corazones.", ref: ref || "Filipenses 4:7" }
    };
  }

  // ACK
  if (ack) {
    const userContent = `MODE: ACK
${commonHeader}
INSTRUCCIONES:
- Mantén el MISMO topic_primary del FRAME; NO lo cambies por respuestas de slot (support_persons).
- Pasa de plan a práctica/compromiso con novedad (guion breve, confirmar hora/límite/contacto), sin repetir.
- "message": afirmativo, sin signos de pregunta.
- "bible": coherente con message; RVR1909; NO uses banned_refs; evita ambigüedad “hijo” vs “el Hijo”.
- "question": UNA sola, para ensayar/confirmar el micro-paso; evita avoid_slots; sigue question_class_hint.`;

    let resp;
    try {
      resp = await completionWithTimeout({
        messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: userContent }],
        temperature: 0.5, max_tokens: 170, timeoutMs: ACK_TIMEOUT_MS
      });
    } catch {
      resp = await completionWithTimeout({
        messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: userContent + "\nResponde de manera directa y breve ahora.\n" }],
        temperature: 0.4, max_tokens: 150, timeoutMs: RETRY_TIMEOUT_MS
      });
    }

    const content = resp?.choices?.[0]?.message?.content || "{}";
    let data = {};
    try { data = JSON.parse(content); } catch { data = { message: content }; }

    let msg = stripQuestions((data?.message || "").toString());
    let ref = cleanRef((data?.bible?.ref || "").toString());
    let text = (data?.bible?.text || "").toString().trim();
    let question = (data?.question || "").toString().trim();

    // Evitar pregunta repetida
    const normalizedQ = normalizeQuestion(question);
    const recentQs2 = extractRecentAssistantQuestions(history, 4);
    if (question && recentQs2.includes(normalizedQ)) question = "";

    // Corrige cita ambigua o vetada
    const hijoOnly = /\bhijo\b/i.test(message) && !/(Jes[uú]s|Cristo)/i.test(message);
    if (!ref || bannedRefs.includes(ref) || (hijoOnly && /Juan\s*8:36/i.test(ref))) {
      const alt = await regenerateBibleAvoiding({ persona, message, focusHint, frame, bannedRefs, lastRef });
      if (alt) { ref = alt.ref; text = alt.text; }
    }

    updateMemoryFromTurn(mem, { userMsg: message, assistantQuestion: question, bibleRef: ref, focusHint });
    mem.frame = frame;
    await writeUserMemory(userId, mem);

    return {
      message: msg || "Estoy contigo. Demos un paso práctico ahora.",
      bible: { text: text, ref: ref || lastRef || "" },
      ...(question ? { question } : {})
    };
  }

  // NORMAL
  // Evita “actividad con la hija” al responder un NP de apoyo dentro de separación/relación
  const avoidActivityNote = (isShortSupportNP(message) && topicIsRelationshipLike)
    ? "\n- Evita sugerir 'actividad' con la persona de apoyo mencionada; mantén el foco en el tema central (p. ej., separación, conversación con el cónyuge).\n"
    : "\n";

  const userContent = `MODE: NORMAL
${commonHeader}
INSTRUCCIONES:
- Mantén el topic_primary del FRAME y no pivotes por respuestas de slot (support/time/place). Si el usuario dice “mi hija”, úsalo como apoyo, no como nuevo tema.${avoidActivityNote}- Progrés con 2–3 micro-pasos HOY, concretos y alineados al FRAME (goal/risk/main_subject). Evita ocio genérico salvo que el FRAME lo justifique explícitamente.
- "message": afirmativo, sin signos de pregunta, y sin repetir viñetas recientes.
- "bible": RVR1909; NO uses banned_refs; evita ambigüedad “hijo” vs “el Hijo”.
- "question": UNA sola, para el dato clave siguiente o confirmar un compromiso; evita avoid_slots; sigue question_class_hint.`;

  const resp = await completionWithTimeout({
    messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: userContent }],
    temperature: 0.6, max_tokens: 230, timeoutMs: 12000
  });

  const content = resp?.choices?.[0]?.message?.content || "{}";
  let data = {};
  try { data = JSON.parse(content); } catch { data = { message: content }; }

  let msg = stripQuestions((data?.message || "").toString());
  let ref = cleanRef((data?.bible?.ref || "").toString());
  let text = (data?.bible?.text || "").toString().trim();
  let question = (data?.question || "").toString().trim();

  // Evitar pregunta repetida
  const normalizedQ = normalizeQuestion(question);
  if (question && recentQsNorm.includes(normalizedQ)) question = "";

  // Revisión de cita
  const hijoOnly2 = /\bhijo\b/i.test(message) && !/(Jes[uú]s|Cristo)/i.test(message);
  if (!ref || bannedRefs.includes(ref) || (hijoOnly2 && /Juan\s*8:36/i.test(ref))) {
    const alt = await regenerateBibleAvoiding({ persona, message, focusHint, frame, bannedRefs, lastRef });
    if (alt) { ref = alt.ref; text = alt.text; }
  }

  updateMemoryFromTurn(mem, { userMsg: message, assistantQuestion: question, bibleRef: ref, focusHint });
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
