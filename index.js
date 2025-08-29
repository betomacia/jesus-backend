// index.js — backend con memoria persistente, anti-repetición de citas, y foco temático sólido

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

CONDUCE LA CONVERSACIÓN (ENTREVISTA GUIADA)
- Mantén un TEMA PRINCIPAL explícito y NO pivotes salvo que el usuario lo pida.
- Piensa en: qué pasó, con quién, riesgo/urgencia, objetivo inmediato, obstáculos, recursos/apoyo, cuándo/dónde, primer micro-paso.
- En cada turno, identifica QUÉ DATO CLAVE FALTA y usa "question" para pedir SOLO UN dato que desbloquee el siguiente paso (o confirmar un compromiso breve).
- Si el usuario responde con acuso ("sí/vale/ok"), NO repitas lo ya dicho: pasa de plan a PRÁCTICA/COMPROMISO (mini guion, confirmar hora, límite, apoyo).
- No repitas la misma pregunta de turnos recientes (mira "avoid_questions" y "avoid_slots").
- Si "user_negation" es true (“no”, “no lo sé”), NO repreguntes lo mismo: cambia de ángulo (decision binaria, alternativa breve) o pide otro dato útil.
- Puedes usar "PERSISTENT_MEMORY" para retomar temas pendientes en charlas anteriores, sin perder el foco actual.

FOCO EN CONSUMO (topic_primary=addiction_child/addiction)
- Prioriza acciones directas con la persona implicada y la red de apoyo (hablar con el hijo, acordar límites, contactar profesional/grupo).
- Autocuidado (oración/diario/respirar) es COMPLEMENTO, no reemplaza acciones principales; colócalo al final si queda espacio.
- Evita generalidades vagas; da ejemplos, mini guiones o decisiones concretas.

BIBLIA (TEMÁTICA Y SIN REPETIR)
- Elige la cita por el TEMA y por el contenido de "message" (los micro-pasos), NO por coincidencias léxicas superficiales.
- AVISO: la palabra “hijo” (niño) NO justifica elegir versículos sobre “el Hijo” (Jesucristo) si no es pertinente; evita esa ambigüedad.
- No uses ninguna referencia en "banned_refs".
- Evita repetir la MISMA referencia usada inmediatamente antes (si recibes "last_bible_ref", NO la repitas).
- Usa RVR1909 literal y "Libro 0:0" en "ref".
- Si dudas, elige pasajes breves pertinentes al tema (libertad/adicción; sabiduría/límites; amor/temor; consuelo/esperanza), sin repetir las vetadas.

CASOS
- AMBIGUO: "message" con contención (2–3 frases), y en "question" UNA puerta al dato clave inicial.
- CONCRETO: en "message" 2–3 micro-pasos HOY (• …), adaptados al tema/momento; en "question" UNA pregunta que obtenga el siguiente dato o confirme un compromiso.

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

// -------- Memoria persistente (archivo por usuario) --------
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
async function ensureDataDir() {
  try { await fs.mkdir(DATA_DIR, { recursive: true }); } catch {}
}
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
    return { profile: {}, topics: {}, last_bible_ref: "", last_bible_refs: [], last_questions: [] };
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
  if (mem.last_bible_ref) parts.push(`última_cita: ${mem.last_bible_ref}`);
  const lastRefs = Array.from(new Set([...(mem.last_bible_refs || []), mem.last_bible_ref].filter(Boolean))).slice(-5);
  if (lastRefs.length) parts.push(`últimas_citas: ${lastRefs.join(", ")}`);
  const lastQs = (mem.last_questions || []).slice(-3);
  if (lastQs.length) parts.push(`últimas_preguntas: ${lastQs.join(" | ")}`);
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
function guessTopic(userMsg = "", focusHint = "") {
  const s = (focusHint || userMsg || "").toLowerCase();
  if (/hijo/.test(s) && /(droga|consum)/.test(s)) return "addiction_child";
  if (/(droga|adicci)/.test(s)) return "addiction";
  if (/(me separ|separaci[oó]n|divorcio|me divorci[eé]|nos separamos|ruptura)/.test(s)) return "separation";
  if (/(pareja|matrimonio|conyug)/.test(s)) return "relationship";
  if (/(ansied|miedo|temor|triste|depres)/.test(s)) return "mood";
  return "general";
}

function updateMemoryFromTurn(mem, { userMsg, assistantQuestion, bibleRef, focusHint }) {
  mem.last_bible_ref = bibleRef || mem.last_bible_ref || "";
  mem.last_bible_refs = Array.from(
    new Set([...(mem.last_bible_refs || []), bibleRef].filter(Boolean))
  ).slice(-5);
  mem.last_questions = Array.from(new Set([...(mem.last_questions || []), (assistantQuestion || "").trim()]))
    .filter(Boolean)
    .slice(-6);
  const topic = guessTopic(userMsg, focusHint);
  mem.topics = mem.topics || {};
  mem.topics[topic] = { ...(mem.topics[topic] || {}), last_seen: Date.now() };
  return mem;
}

// --- Anti-repetición de preguntas ---
function normalizeQuestion(q = "") {
  return String(q).toLowerCase().replace(/\s+/g, " ").trim();
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
  if (/(actividad|paseo|salir|caminar|ir a|juntas?)/i.test(s)) return "activity"; // <-- nuevo
  return "other";
}

function deriveAvoidSlots(recentQs = []) {
  return [...new Set(recentQs.map(classifyQuestion))].filter(Boolean);
}
function isNegation(msg = "") {
  return /^\s*(no( lo sé| lo se)?|todav[ií]a no|a[úu]n no|no por ahora|m[aá]s tarde)\s*\.?$/i.test((msg || "").trim());
}

// --- extra: refs recientes en historial (para banned_refs) ---
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

function isAck(msg = "") {
  return /^\s*(si|sí|ok|okay|vale|dale|de acuerdo|perfecto|genial|bien)\s*\.?$/i.test((msg || "").trim());
}
function isGoodbye(msg = "") {
  const s = (msg || "").toLowerCase();
  return /(debo irme|tengo que irme|me voy|me retiro|hasta luego|nos vemos|hasta mañana|buenas noches|adiós|adios|chao|bye)\b/.test(s)
      || (/gracias/.test(s) && /(irme|retir)/.test(s));
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
function compactHistory(history = [], keep = 8, maxLen = 260) {
  const arr = Array.isArray(history) ? history : [];
  return arr.slice(-keep).map(x => String(x).slice(0, maxLen));
}

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

// ——— micro-llamada para REEMPLAZAR SOLO la cita si vino repetida/prohibida ———
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

async function regenerateBibleAvoiding({ persona, message, focusHint, topicPrimary, bannedRefs = [], lastRef = "" }) {
  const sys = `Devuelve SOLO JSON con {"bible":{"text":"…","ref":"Libro 0:0"}} en RVR1909. 
- No uses ninguna referencia de "banned_refs".
- La cita debe sostener el TEMA y los micro-pasos, no por coincidencia léxica superficial.
- Evita ambigüedad entre “hijo” (niño) y “el Hijo” (Cristo) salvo que sea teológicamente pertinente al contenido.`.trim();

  const usr =
    `Persona: ${persona}\n` +
    `Mensaje_actual: ${message}\n` +
    `Tema_prev_sustantivo: ${focusHint || "(sin pista)"}\n` +
    `topic_primary: ${topicPrimary}\n` +
    `last_bible_ref: ${lastRef || "(n/a)"}\n` +
    `banned_refs:\n- ${bannedRefs.join("\n- ")}\n`;

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
  // --- Cargar memoria persistente y combinar perfil ---
  const mem = await readUserMemory(userId);
  mem.profile = { ...(mem.profile || {}), ...(profile || {}) };
  const persistentMemory = buildPersistentMemoryPrompt(mem);

  const ack = isAck(message);
  const bye = isGoodbye(message);
  const lastRefFromHistory = extractRecentBibleRefs(history, 1)[0] || "";
  const lastRef = mem.last_bible_ref || lastRefFromHistory || "";
  const focusHint = lastSubstantiveUser(history);
  const topicPrimary = guessTopic(message, focusHint);
  const shortHistory = compactHistory(history, (ack || bye) ? 4 : 10, 240);
  const recentQs = extractRecentAssistantQuestions(history, 4);
  const avoidSlots = deriveAvoidSlots(recentQs);
  const userNegation = isNegation(message);
  const recentRefs = extractRecentBibleRefs(history, 3);
  const bannedRefs = Array.from(
    new Set([...(mem.last_bible_refs || []), mem.last_bible_ref, ...recentRefs].filter(Boolean))
  ).slice(-5);

  // --- DESPEDIDA ---
  if (bye) {
    const userContent =
      `MODE: GOODBYE\n` +
      `Persona: ${persona}\n` +
      `Mensaje_actual: ${message}\n` +
      `Tema_prev_sustantivo: ${focusHint || "(sin pista)"}\n` +
      `topic_primary: ${topicPrimary}\n` +
      `last_bible_ref: ${lastRef || "(n/a)"}\n` +
      `banned_refs:\n- ${bannedRefs.join("\n- ") || "(none)"}\n` +
      `avoid_questions:\n- ${recentQs.join("\n- ")}\n` +
      `avoid_slots: ${avoidSlots.join(", ") || "(none)"}\n` +
      `user_negation: ${userNegation}\n` +
      `PERSISTENT_MEMORY:\n${persistentMemory || "(vacía)"}\n` +
      (shortHistory.length ? `Historial: ${shortHistory.join(" | ")}` : "Historial: (sin antecedentes)") + "\n" +
      `INSTRUCCIONES:\n- Despedida breve y benigna.\n- "message": afirmativo, sin signos de pregunta.\n- "bible": bendición/consuelo RVR1909.\n- No repitas referencias en banned_refs.\n- No incluyas "question".\n`;

    let resp;
    try {
      resp = await completionWithTimeout({
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent }
        ],
        temperature: 0.5,
        max_tokens: 160,
        timeoutMs: ACK_TIMEOUT_MS
      });
    } catch {
      resp = await completionWithTimeout({
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent + "\nPor favor responde ahora mismo.\n" }
        ],
        temperature: 0.4,
        max_tokens: 140,
        timeoutMs: RETRY_TIMEOUT_MS
      });
    }

    const content = resp?.choices?.[0]?.message?.content || "{}";
    let data = {};
    try { data = JSON.parse(content); } catch { data = { message: content }; }

    let msg = stripQuestions((data?.message || "").toString());
    let ref = cleanRef((data?.bible?.ref || "").toString());
    let text = (data?.bible?.text || "").toString().trim();

    // Si devolvió una ref vetada, re-generamos SOLO la Biblia
    if (!ref || bannedRefs.includes(ref)) {
      const alt = await regenerateBibleAvoiding({ persona, message, focusHint, topicPrimary, bannedRefs, lastRef });
      if (alt) { ref = alt.ref; text = alt.text; }
    }

    updateMemoryFromTurn(mem, { userMsg: message, assistantQuestion: "", bibleRef: ref, focusHint });
    await writeUserMemory(userId, mem);

    return {
      message: msg || "Que la paz y el amor te acompañen.",
      bible: { text: text || "Y la paz de Dios, que sobrepuja todo entendimiento, guardará vuestros corazones.", ref: ref || "Filipenses 4:7" }
    };
  }

  // --- ACK ---
  if (ack) {
    const userContent =
      `MODE: ACK\n` +
      `Persona: ${persona}\n` +
      `Mensaje_actual: ${message}\n` +
      `Tema_prev_sustantivo: ${focusHint || "(sin pista)"}\n` +
      `topic_primary: ${topicPrimary}\n` +
      `last_bible_ref: ${lastRef || "(n/a)"}\n` +
      `banned_refs:\n- ${bannedRefs.join("\n- ") || "(none)"}\n` +
      `avoid_questions:\n- ${recentQs.join("\n- ")}\n` +
      `avoid_slots: ${avoidSlots.join(", ") || "(none)"}\n` +
      `user_negation: ${userNegation}\n` +
      `PERSISTENT_MEMORY:\n${persistentMemory || "(vacía)"}\n` +
      (shortHistory.length ? `Historial: ${shortHistory.join(" | ")}` : "Historial: (sin antecedentes)") + "\n" +
      `INSTRUCCIONES:\n- Mantén el MISMO tema y pasa de plan a práctica/compromiso con NOVEDAD, sin repetir.\n- "message": afirmativo, sin signos de pregunta; evita autocuidado como contenido principal.\n- "bible": coherente con message; RVR1909; NO uses banned_refs.\n- "question": UNA sola, para ensayar/confirmar el micro-paso; evita avoid_slots.\n`;

    let resp;
    try {
      resp = await completionWithTimeout({
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent }
        ],
        temperature: 0.5,
        max_tokens: 160,
        timeoutMs: ACK_TIMEOUT_MS
      });
    } catch {
      resp = await completionWithTimeout({
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent + "\nResponde de manera directa y breve ahora.\n" }
        ],
        temperature: 0.4,
        max_tokens: 140,
        timeoutMs: RETRY_TIMEOUT_MS
      });
    }

    const content = resp?.choices?.[0]?.message?.content || "{}";
    let data = {};
    try { data = JSON.parse(content); } catch { data = { message: content }; }

    let msg = stripQuestions((data?.message || "").toString());
    let ref = cleanRef((data?.bible?.ref || "").toString());
    let text = (data?.bible?.text || "").toString().trim();
    let question = (data?.question || "").toString().trim();

    // Sustitución de cita si cae en banned o ambigüedad “hijo”→“Hijo”
    const hijoOnly = /\bhijo\b/i.test(message) && !/(Jes[uú]s|Cristo|libert)/i.test(message);
    if (!ref || bannedRefs.includes(ref) || (topicPrimary === "addiction_child" && hijoOnly && /Juan\s*8:36/i.test(ref))) {
      const alt = await regenerateBibleAvoiding({ persona, message, focusHint, topicPrimary, bannedRefs, lastRef });
      if (alt) { ref = alt.ref; text = alt.text; }
    }

    // anti-repetición mínima de pregunta
    const normalizedQ = normalizeQuestion(question);
    const recentQs2 = extractRecentAssistantQuestions(history, 4);
    if (question && recentQs2.includes(normalizedQ)) question = "";

    updateMemoryFromTurn(mem, { userMsg: message, assistantQuestion: question, bibleRef: ref, focusHint });
    await writeUserMemory(userId, mem);

    return {
      message: msg || "Estoy contigo. Demos un paso práctico ahora.",
      bible: { text: text, ref: ref || lastRef || "" },
      ...(question ? { question } : {})
    };
  }

  // --- NORMAL ---
  const userContent =
    `MODE: NORMAL\n` +
    `Persona: ${persona}\n` +
    `Mensaje_actual: ${message}\n` +
    `Tema_prev_sustantivo: ${focusHint || "(sin pista)"}\n` +
    `topic_primary: ${topicPrimary}\n` +
    `last_bible_ref: ${lastRef || "(n/a)"}\n` +
    `banned_refs:\n- ${bannedRefs.join("\n- ") || "(none)"}\n` +
    `avoid_questions:\n- ${recentQs.join("\n- ")}\n` +
    `avoid_slots: ${avoidSlots.join(", ") || "(none)"}\n` +
    `user_negation: ${userNegation}\n` +
    `PERSISTENT_MEMORY:\n${persistentMemory || "(vacía)"}\n` +
    (shortHistory.length ? `Historial: ${shortHistory.join(" | ")}` : "Historial: (sin antecedentes)") + "\n" +
    `INSTRUCCIONES:\n- Mantén el tema y progresa con 2–3 micro-pasos HOY; evita repetir viñetas recientes.\n- "message": afirmativo, sin signos de pregunta; evita autocuidado como contenido principal.\n- "bible": RVR1909; NO uses banned_refs; evita ambigüedad “hijo” vs “el Hijo”.\n- "question": UNA sola, para el dato clave siguiente o confirmar un compromiso; evita avoid_slots.\n`;

  const resp = await completionWithTimeout({
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userContent }
    ],
    temperature: 0.6,
    max_tokens: 220,
    timeoutMs: 12000
  });

  const content = resp?.choices?.[0]?.message?.content || "{}";
  let data = {};
  try { data = JSON.parse(content); } catch { data = { message: content }; }

  let msg = stripQuestions((data?.message || "").toString());
  let ref = cleanRef((data?.bible?.ref || "").toString());
  let text = (data?.bible?.text || "").toString().trim();
  let question = (data?.question || "").toString().trim();

  // Sustitución de cita si cae en banned o ambigüedad
  const hijoOnly = /\bhijo\b/i.test(message) && !/(Jes[uú]s|Cristo|libert)/i.test(message);
  if (!ref || bannedRefs.includes(ref) || (topicPrimary === "addiction_child" && hijoOnly && /Juan\s*8:36/i.test(ref))) {
    const alt = await regenerateBibleAvoiding({ persona, message, focusHint, topicPrimary, bannedRefs, lastRef });
    if (alt) { ref = alt.ref; text = alt.text; }
  }

  updateMemoryFromTurn(mem, { userMsg: message, assistantQuestion: question, bibleRef: ref, focusHint });
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

