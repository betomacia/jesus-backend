// index.js — backend generalista con FRAME persistente, anti-desvío y citas bíblicas sin repetición

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
- Usa el FRAME provisto (topic_primary, main_subject, goal, risk, support_persons, constraints) como **fuente de verdad**.
- NO cambies topic_primary salvo que el usuario lo pida explícitamente o se detecte un cambio claro de asunto.
- Respuestas mínimas tipo “mi hija / mi madre / un amigo” son **relleno de slot** (support_persons) y NO redefinen el tema.
- Si falta un dato clave, usa "question" para pedirlo (SOLO uno por turno). Evita repetir el mismo slot (usa avoid_slots).

PROGRESO
- Evita repetir lo ya dicho. Cada "message" debe aportar novedad útil: ejemplo concreto, mini-guion, decisión binaria, contacto específico, límite práctico.
- Si el usuario responde con acuso (“sí/ok/vale”), pasa de plan a PRÁCTICA/COMPROMISO (ensayo de frase, fijar hora, límite, contacto), sin repetir.

AUTO-CUIDADO
- El autocuidado (respirar/orar/diario) es **complemento**, no reemplaza las acciones del tema central. Inclúyelo al final si hay espacio y es pertinente.

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
  const s = (msg || "").trim().toLowerCase();
  return (
    /^\s*(no( lo sé| lo se)?|todav[ií]a no|a[úu]n no|no por ahora|m[aá]s tarde)\s*\.?$/i.test(s) ||
    /\bno tengo ganas\b/.test(s)
  );
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
  if (/(qu[ié]n|quien|en qui[eé]n conf[ií]as|puede acompa[nñ]arte|apoyarte)/i.test(s)) return "support";
  return "other";
}
function deriveAvoidSlots(recentQs = []) {
  return [...new Set(recentQs.map(classifyQuestion))].filter(Boolean);
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
      frame: null
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
  if (/(recuperar|que vuelva|que regrese|volver conmigo|reconcili|retomar|restaurar)/.test(s)) return "reconcile";
  if (/(denuncia|violencia|abuso|amenaza|peligro)/.test(s)) return "safety";
  if (/(separar|divorci|terminar|cortar)/.test(s)) return "separate";
  if (/(buscar ayuda|terapeuta|grupo|profesional)/.test(s)) return "seek_help";
  if (/(no s[eé]|confuso|confund|c[oó]mo puedo|de qu[eé] manera|qu[eé] pasos)/.test(s)) return "clarify";
  return "";
}
function wantsPlan(msg = "") {
  const s = (msg || "").toLowerCase();
  return /(c[oó]mo puedo|de qu[eé] manera|qu[eé] pasos|qu[eé] debo hacer)/.test(s);
}
function detectRisk(text = "") {
  const s = (text || "").toLowerCase();
  if (/(violencia|golpe|amenaza|arma|peligro|me har[aá]|suicid|autolesi)/.test(s)) return "high";
  return "normal";
}
function updateFrame(prev = null, userMsg = "", focusHint = "") {
  const topic = prev?.topic_primary || guessTopic(userMsg, focusHint);
  const mainSubject = prev?.main_subject || detectMainSubject(focusHint || userMsg);
  const goal = detectGoal(userMsg) || prev?.goal || "";
  const risk = detectRisk(userMsg) || prev?.risk || "normal";

  // support persons
  const support = Array.isArray(prev?.support_persons) ? [...prev.support_persons] : [];
  if (isShortSupportNP(userMsg)) {
    support.push({ rel: parseRelation(userMsg), label: userMsg.trim() });
  }

  // constraints básicas (time/place si el usuario las da)
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
function dedupSupport(arr = []) {
  const seen = new Set();
  const out = [];
  for (const it of arr) {
    const key = (it?.rel || "x") + "|" + (it?.label || "").toLowerCase();
    if (!seen.has(key)) { seen.add(key); out.push(it); }
  }
  return out;
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

// micro-llamada para re-generar SOLO la cita si vino repetida/prohibida
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
  mem.frame = frame; // persistiremos al final

  const ack = isAck(message);
  const bye = isGoodbye(message);
  const userNegation = isNegation(message);

  const lastRefFromHistory = extractRecentBibleRefs(history, 1)[0] || "";
  const lastRef = mem.last_bible_ref || lastRefFromHistory || "";

  const recentQsNorm = extractRecentAssistantQuestions(history, 4);
  let avoidSlots = deriveAvoidSlots(recentQsNorm);

  // Si el usuario acaba de responder con un NP de apoyo, evita derivar a "activity" y "support"
  if (isShortSupportNP(message)) {
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
      `- "message": afirmativo, sin signos de pregunta.\n` +
      `- "bible": bendición/consuelo RVR1909.\n` +
      `- No repitas referencias en banned_refs.\n` +
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
    let ref = cleanRef((data?.bible?.ref || "").toString());
    let text = (data?.bible?.text || "").toString().trim();

    if (!ref || bannedRefs.includes(ref)) {
      const alt = await regenerateBibleAvoiding({ persona, message, focusHint, frame, bannedRefs, lastRef });
      if (alt) { ref = alt.ref; text = alt.text; }
    }

    updateMemoryFromTurn(mem, { userMsg: message, assistantQuestion: "", bibleRef: ref, focusHint });
    await writeUserMemory(userId, mem);

    return {
      message: msg || "Que la paz y el amor te acompañen.",
      bible: { text: text || "Y la paz de Dios, que sobrepuja todo entendimiento, guardará vuestros corazones.", ref: ref || "Filipenses 4:7" }
    };
  }

  // ACK (“sí/ok/vale”)
  if (ack) {
    const userContent =
      `MODE: ACK\n` +
      commonHeader +
      `INSTRUCCIONES:\n` +
      `- Mantén el MISMO topic_primary del FRAME, NO lo cambies por respuestas de slot (p.ej., support_persons).\n` +
      `- Pasa de plan a práctica/compromiso con **novedad** (guion breve, confirmar hora/límite/contacto), sin repetir.\n` +
      `- Si FRAME.goal = "reconcile": prioriza pasos de contacto con la pareja HOY (elegir canal: mensaje/llamada, fijar hora, redactar 1–2 frases de apertura respetuosas, acordar un límite amable). No desvíes a "apoyo/actividad/diario" salvo como complemento breve al final.\n` +
      `- Si user_negation = true: ofrece un micro-paso de 30–60 segundos alineado al objetivo (p. ej., redactar una sola frase inicial), evita tareas largas o genéricas.\n` +
      `- "message": afirmativo, sin signos de pregunta.\n` +
      `- "bible": coherente con message; RVR1909; NO uses banned_refs.\n` +
      `- "question": UNA sola, para ensayar/confirmar el micro-paso; evita avoid_slots.\n`;

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
    let ref = cleanRef((data?.bible?.ref || "").toString());
    let text = (data?.bible?.text || "").toString().trim();
    let question = (data?.question || "").toString().trim();

    const normalizedQ = normalizeQuestion(question);
    const recentQs2 = extractRecentAssistantQuestions(history, 4);
    if (question && recentQs2.includes(normalizedQ)) question = "";

    // Si objetivo es reconciliar y no hay pregunta, forzamos una que empuje acción concreta
    if ((!question || question.length < 3) && frame.goal === "reconcile") {
      question = "¿Quieres que redactemos juntos un mensaje inicial para él?";
    }

    // Corrige cita si falta/vetada/ambigua
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
  const userContent =
    `MODE: NORMAL\n` +
    commonHeader +
    `INSTRUCCIONES:\n` +
    `- Mantén el topic_primary del FRAME y **no** pivotes por respuestas de slot (support/time/place). Si el usuario dice “mi hija”, úsalo como apoyo, no como nuevo tema.\n` +
    `- Progrés con 2–3 micro-pasos HOY, concretos y alineados al FRAME (goal/risk/main_subject). Evita ocio genérico salvo que el FRAME lo justifique (bonding explícito).\n` +
    `- Si FRAME.goal = "reconcile": prioriza pasos de contacto con la pareja HOY (elegir canal: mensaje/llamada, fijar hora, redactar 1–2 frases), no propongas actividades con la persona de apoyo como foco principal.\n` +
    `- Si user_negation = true: sugiere el micro-paso más pequeño posible alineado al objetivo (30–60 segundos), sin “paseos” ni rutinas largas.\n` +
    `- "message": afirmativo, sin signos de pregunta, y sin repetir viñetas recientes.\n` +
    `- "bible": RVR1909; NO uses banned_refs; evita ambigüedad “hijo” vs “el Hijo”.\n` +
    `- "question": UNA sola, para el dato clave siguiente o confirmar un compromiso; evita avoid_slots.\n`;

  const resp = await completionWithTimeout({
    messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: userContent }],
    temperature: 0.6, max_tokens: 220, timeoutMs: 12000
  });

  const content = resp?.choices?.[0]?.message?.content || "{}";
  let data = {};
  try { data = JSON.parse(content); } catch { data = { message: content }; }

  let msg = stripQuestions((data?.message || "").toString());
  let ref = cleanRef((data?.bible?.ref || "").toString());
  let text = (data?.bible?.text || "").toString().trim();
  let question = (data?.question || "").toString().trim();

  // fuerza pregunta útil si meta es reconciliar
  if ((!question || question.length < 3) && frame.goal === "reconcile") {
    question = "¿Prefieres iniciar con un mensaje breve o con una llamada corta?";
  }

  const hijoOnly = /\bhijo\b/i.test(message) && !/(Jes[uú]s|Cristo)/i.test(message);
  if (!ref || bannedRefs.includes(ref) || (hijoOnly && /Juan\s*8:36/i.test(ref))) {
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

function lastSubstantiveUser(history = []) {
  const rev = [...(history || [])].reverse();
  for (const h of rev) {
    if (!/^Usuario:/i.test(h)) continue;
    const text = h.replace(/^Usuario:\s*/i, "").trim();
    if (text && !isAck(text) && text.length >= 6) return text;
  }
  return "";
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
