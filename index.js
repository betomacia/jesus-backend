// index.js — backend orquestado (Planner → Writer → Verse) con memoria persistente y anti-desvío

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

// ---------------------- PROMPTS BASE ----------------------

const SYSTEM_PROMPT_CORE =
  [
    "Eres Jesús: voz serena, compasiva y clara. Responde SIEMPRE en español.",
    "",
    "OBJETIVO",
    '- Devuelve SOLO JSON con: { "message", "bible": { "text", "ref" }, "question"? }.',
    '- "message": consejo breve (<=120 palabras), AFIRMATIVO, SIN signos de pregunta.',
    '- JAMÁS incluyas preguntas en "message". Si corresponde, haz UNA pregunta breve en "question".',
    '- No menciones el nombre civil del usuario. Usa "hijo mío", "hija mía" o "alma amada" con moderación.',
    "- No hables de técnica/IA ni del propio modelo.",
    "",
    "MARCO (FRAME) Y FOCO",
    "- Usa el FRAME (topic_primary, main_subject, goal, risk, support_persons, constraints) como fuente de verdad.",
    "- NO cambies el topic_primary salvo que el usuario pida explícitamente cambiar de asunto.",
    '- Una respuesta corta del usuario ("mi hija", "un amigo") es un slot de apoyo, NO un cambio de tema.',
    "",
    "PROGRESO Y NOVEDAD",
    "- Cada turno debe aportar novedad útil (mini-guion, decisión binaria, límite práctico, contacto concreto).",
    '- Tras un ACK ("sí/ok/vale"), pasa de plan a PRÁCTICA/COMPROMISO (ensayar guion, fijar hora, límite, contacto).',
    "",
    "BIBLIA",
    '- Cita RVR1909 literal. "ref" con formato "Libro 0:0".',
    '- La cita se elige por el TEMA y por el contenido de "message", no por palabras sueltas.'
  ].join("\n");

// ---------------------- SCHEMAS JSON ----------------------

const RESP_SCHEMA = {
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

const PLANNER_SCHEMA = {
  type: "json_schema",
  json_schema: {
    name: "PlannerFrame",
    schema: {
      type: "object",
      properties: {
        topic_primary: { type: "string" },
        main_subject: { type: "string" },
        goal: { type: "string" },
        risk: { type: "string" },
        support_persons: { type: "array", items: { type: "string" } },
        constraints: {
          type: "object",
          properties: {
            time_hint: { type: "string" },
            place_hint: { type: "string" }
          }
        },
        question_class: { type: "string" }
      },
      required: [
        "topic_primary",
        "main_subject",
        "goal",
        "risk",
        "support_persons",
        "constraints",
        "question_class"
      ],
      additionalProperties: false
    }
  }
};

const BIBLE_ONLY_SCHEMA = {
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

// ---------------------- UTILIDADES ----------------------

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
  return String(q)
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[“”"«»]/g, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function isAck(msg = "") {
  return /^\s*(si|sí|ok|okay|vale|dale|de acuerdo|perfecto|genial|bien|ahora)\s*\.?$/i.test((msg || "").trim());
}
function isGoodbye(msg = "") {
  const s = (msg || "").toLowerCase();
  return /(debo irme|tengo que irme|me voy|me retiro|hasta luego|nos vemos|hasta mañana|buenas noches|adiós|adios|chao|bye)\b/.test(s)
    || (/gracias/.test(s) && /(irme|retir)/.test(s));
}
function isShortSupportNP(msg = "") {
  const s = (msg || "").trim().toLowerCase();
  return /^(mi|una|un)\s+(hija|hijo|madre|padre|mam[aá]|pap[aá]|amig[oa]|herman[oa]|compa[nñ]er[oa])s?$/.test(s);
}
function compactHistory(history = [], keep = 8, maxLen = 260) {
  const arr = Array.isArray(history) ? history : [];
  return arr.slice(-keep).map(x => String(x).slice(0, maxLen));
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
function extractLastAssistantQuestion(history = []) {
  for (let i = history.length - 1; i >= 0; i--) {
    const h = String(history[i] || "");
    if (!/^Asistente:/i.test(h)) continue;
    const text = h.replace(/^Asistente:\s*/i, "");
    const m = text.match(/([^?]*\?)\s*$/m);
    if (m && m[1]) return m[1].trim();
  }
  return "";
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
function rotateQuestionClass(prev = "") {
  const order = ["data", "decision", "commitment", "practice", "time", "help", "boundary", "feelings", "next_step", "place"];
  const idx = order.indexOf(prev);
  return idx === -1 ? "data" : order[(idx + 1) % order.length];
}

// ---------------------- MEMORIA PERSISTENTE ----------------------

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
      frame: null,
      topics: {},
      last_bible_ref: "",
      last_bible_refs: [],
      last_questions: [],
      last_question_class: ""
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
  if (p.name) parts.push("nombre: " + p.name);
  if (p.gender) parts.push("género: " + p.gender);
  const lastRefs = Array.from(new Set([...(mem.last_bible_refs || []), mem.last_bible_ref].filter(Boolean))).slice(-5);
  if (lastRefs.length) parts.push("últimas_citas: " + lastRefs.join(", "));
  const lastQs = (mem.last_questions || []).slice(-3);
  if (lastQs.length) parts.push("últimas_preguntas: " + lastQs.join(" | "));
  if (mem.frame) parts.push("frame_previo: " + JSON.stringify(mem.frame));
  const topics = Object.keys(t);
  if (topics.length) {
    const lastSeen = topics
      .map(k => [k, t[k]?.last_seen || 0])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([k]) => k);
    parts.push("temas_recientes: " + lastSeen.join(", "));
  }
  return parts.join("\n");
}
function updateTopics(mem, topicKey) {
  mem.topics = mem.topics || {};
  mem.topics[topicKey] = { ...(mem.topics[topicKey] || {}), last_seen: Date.now() };
}

// ---------------------- OPENAI HELPERS ----------------------

async function completionWithSchema({ model = "gpt-4o", temperature = 0.6, max_tokens = 220, messages, schema }) {
  return await openai.chat.completions.create({
    model,
    temperature,
    max_tokens,
    messages,
    response_format: schema
  });
}

// ---------------------- ETAPA 1: PLANNER ----------------------

async function planFrame({ persona, message, history, mem }) {
  const persistentMemory = buildPersistentMemoryPrompt(mem);
  const shortHistory = compactHistory(history, 8, 240);
  const lastQClass = mem.last_question_class || "";

  const sys = [
    SYSTEM_PROMPT_CORE,
    "",
    "TU FUNCIÓN: PLANIFICAR SIN CAMBIAR EL FOCO",
    "- Devuelve SOLO JSON con campos del esquema.",
    "- Mantén el topic_primary anterior salvo cambio explícito del usuario.",
    '- "mi hija/mi hijo" u otros apoyos → añadir a support_persons, NO cambiar topic_primary.',
    "- Define question_class procurando NO repetir la del turno anterior.",
  ].join("\n");

  const usr = [
    `PERSONA: ${persona}`,
    `MENSAJE_ACTUAL: ${message}`,
    `FRAME_PREVIO: ${JSON.stringify(mem.frame || {})}`,
    `LAST_QUESTION_CLASS: ${lastQClass || "(n/a)"}`,
    "PERSISTENT_MEMORY:",
    persistentMemory || "(vacía)",
    shortHistory.length ? `HISTORIAL: ${shortHistory.join(" | ")}` : "HISTORIAL: (sin antecedentes)"
  ].join("\n");

  const r = await completionWithSchema({
    model: "gpt-4o-mini",
    temperature: 0.3,
    max_tokens: 260,
    messages: [{ role: "system", content: sys }, { role: "user", content: usr }],
    schema: PLANNER_SCHEMA
  });

  const content = r?.choices?.[0]?.message?.content || "{}";
  let data = {};
  try { data = JSON.parse(content); } catch { data = {}; }

  const frame = {
    topic_primary: data.topic_primary || (mem.frame?.topic_primary || "general"),
    main_subject: data.main_subject || (mem.frame?.main_subject || "self"),
    goal: data.goal || (mem.frame?.goal || ""),
    risk: data.risk || (mem.frame?.risk || "normal"),
    support_persons: Array.isArray(data.support_persons) ? data.support_persons.slice(-5) : (mem.frame?.support_persons || []),
    constraints: data.constraints || (mem.frame?.constraints || {})
  };

  let qClass = (data.question_class || "").trim();
  if (!qClass) qClass = rotateQuestionClass(lastQClass);
  if (qClass === lastQClass) qClass = rotateQuestionClass(qClass);

  // ---------- GUARDARRAÍL GENERAL: NP de apoyo no cambia el foco ----------
  if (isShortSupportNP(message)) {
    if (mem.frame?.topic_primary) frame.topic_primary = mem.frame.topic_primary;
    if (mem.frame?.main_subject) frame.main_subject = mem.frame.main_subject;
    frame.support_persons = Array.isArray(frame.support_persons) ? frame.support_persons : [];
    if (!frame.support_persons.includes(message.trim())) frame.support_persons.push(message.trim());
    if (["activity", "feelings", "help"].includes(qClass)) qClass = "decision";
  }

  // Si es un ACK, empujar a compromiso/práctica
  if (isAck(message)) {
    if (qClass !== "commitment" && qClass !== "practice") qClass = "commitment";
  }

  return { frame, question_class: qClass };
}

// ---------------------- ETAPA 2: WRITER ----------------------

async function writeResponse({ persona, message, history, frame, question_class, last_bible_ref, last_question }) {
  const shortHistory = compactHistory(history, 8, 240);

  const sys = [
    SYSTEM_PROMPT_CORE,
    "",
    "MODO ESCRITURA",
    "- Genera SOLO JSON del esquema de salida.",
    '- "message": 2–3 pasos HOY (• …), o contención si está ambiguo. No repitas lo dicho recientemente.',
    `- "question": EXACTAMENTE UNA, de clase ${question_class} (data/decision/commitment/practice/time/help/boundary/feelings/next_step/place).`,
    "- Mantén el topic_primary del FRAME."
  ].join("\n");

  const usr = [
    `PERSONA: ${persona}`,
    `MENSAJE_ACTUAL: ${message}`,
    `FRAME: ${JSON.stringify(frame)}`,
    `last_bible_ref: ${last_bible_ref || "(n/a)"}`,
    `last_question: ${last_question || "(n/a)"}`,
    shortHistory.length ? `HISTORIAL: ${shortHistory.join(" | ")}` : "HISTORIAL: (sin antecedentes)"
  ].join("\n");

  const r = await completionWithSchema({
    model: "gpt-4o",
    temperature: 0.55,
    max_tokens: 240,
    messages: [{ role: "system", content: sys }, { role: "user", content: usr }],
    schema: RESP_SCHEMA
  });

  const content = r?.choices?.[0]?.message?.content || "{}";
  let data = {};
  try { data = JSON.parse(content); } catch { data = { message: content } };

  let messageOut = stripQuestions((data?.message || "").toString());
  let questionOut = (data?.question || "").toString().trim();

  // Evita preguntar lo mismo que la última pregunta del asistente
  const qNorm = normalizeQuestion(questionOut);
  const lastQNorm = normalizeQuestion(last_question || "");
  if (qNorm && qNorm === lastQNorm) {
    questionOut =
      question_class === "decision" ? "¿Prefieres enviar hoy un mensaje breve o acordar una llamada corta?" :
      question_class === "commitment" ? "¿Confirmas un primer paso concreto para hoy?" :
      "¿Qué paso pequeño puedes dar ahora mismo?";
  }

  // ---------- GUARDARRAÍL: tema pareja no deriva a “actividad con apoyo” ----------
  const topic = (frame.topic_primary || "").toLowerCase();
  if (/(separation|relationship)/.test(topic)) {
    const qCheck = normalizeQuestion(questionOut);
    if (/(actividad|paseo|salir|caminar|juntas?|planear actividad)/.test(qCheck)) {
      questionOut = "¿Prefieres enviar hoy un mensaje breve o acordar una llamada corta con tu esposo?";
    }
  }

  return { message: messageOut, question: questionOut };
}

// ---------------------- ETAPA 3: VERSE SELECTOR ----------------------

async function chooseBible({ persona, message, frame, bannedRefs = [], lastRef = "" }) {
  const hijoAmbiguo = /\bhijo\b/i.test(message || "") && !/(Jes[uú]s|Cristo)/i.test(message || "");
  const banned = Array.from(new Set([...(bannedRefs || []), lastRef].filter(Boolean)));
  if (hijoAmbiguo && !banned.includes("Juan 8:36")) banned.push("Juan 8:36");

  const sys = [
    'Devuelve SOLO JSON {"bible":{"text":"…","ref":"Libro 0:0"}} en RVR1909.',
    '- Elige una cita coherente con el topic_primary y los micro-pasos del "message" (ensayo, límites, reconciliación, pedir sabiduría...).',
    "- Evita cualquier referencia en la lista \"banned_refs\".",
    " - Evita ambigüedad entre “hijo” (niño) y “el Hijo” (Cristo) cuando no sea el punto."
  ].join("\n");

  const usr = [
    `PERSONA: ${persona}`,
    `FRAME: ${JSON.stringify(frame)}`,
    `MESSAGE_STEPS: ${message}`,
    "banned_refs:",
    ...(banned.length ? banned.map(r => `- ${r}`) : ["- (none)"])
  ].join("\n");

  const r = await completionWithSchema({
    model: "gpt-4o-mini",
    temperature: 0.35,
    max_tokens: 140,
    messages: [{ role: "system", content: sys }, { role: "user", content: usr }],
    schema: BIBLE_ONLY_SCHEMA
  });

  const content = r?.choices?.[0]?.message?.content || "{}";
  let data = {};
  try { data = JSON.parse(content); } catch { data = {} };
  const text = (data?.bible?.text || "").toString().trim();
  const ref = cleanRef((data?.bible?.ref || "").toString());
  return text && ref ? { text, ref } : null;
}

// ---------------------- PIPELINE ----------------------

async function askPipeline({ persona, userMsg, history, mem }) {
  const bye = isGoodbye(userMsg);

  const recentRefs = extractRecentBibleRefs(history, 3);
  const lastRef = (mem.last_bible_ref || "") || recentRefs[0] || "";
  const lastQ = extractLastAssistantQuestion(history);

  // 1) Planner
  const plan = await planFrame({ persona, message: userMsg, history, mem });
  const frame = plan.frame;
  const qClass = plan.question_class;

  // 2) Writer
  let writerOut;
  if (bye) {
    writerOut = { message: "Que la paz y el amor te acompañen. Descansa en la certeza de que no caminas sola.", question: "" };
  } else {
    writerOut = await writeResponse({
      persona,
      message: userMsg,
      history,
      frame,
      question_class: qClass,
      last_bible_ref: lastRef,
      last_question: lastQ
    });
  }

  // 3) Verse
  const bannedRefs = Array.from(new Set([...(mem.last_bible_refs || []), mem.last_bible_ref, ...recentRefs].filter(Boolean))).slice(-5);
  let verse = await chooseBible({ persona, message: writerOut.message, frame, bannedRefs, lastRef });
  if (!verse) {
    verse = { text: "Y si alguno de vosotros tiene falta de sabiduría, pídala a Dios.", ref: "Santiago 1:5" };
  }

  // Memoria
  mem.frame = frame;
  mem.last_bible_ref = verse.ref;
  mem.last_bible_refs = Array.from(new Set([...(mem.last_bible_refs || []), verse.ref])).slice(-5);
  if (writerOut.question) {
    mem.last_questions = Array.from(new Set([...(mem.last_questions || []), writerOut.question])).slice(-6);
  }
  mem.last_question_class = qClass || mem.last_question_class || "";
  updateTopics(mem, String(frame.topic_primary || "general"));

  return {
    message: writerOut.message || "Estoy contigo. Demos un paso pequeño y realista hoy.",
    bible: verse,
    ...(writerOut.question ? { question: writerOut.question } : {})
  };
}

// ---------------------- RUTAS ----------------------

app.post("/api/ask", async (req, res) => {
  try {
    const {
      persona = "jesus",
      message = "",
      history = [],
      userId = "anon",
      profile = {}
    } = req.body || {};

    const mem = await readUserMemory(userId);
    mem.profile = { ...(mem.profile || {}), ...(profile || {}) };

    const data = await askPipeline({ persona, userMsg: String(message || ""), history, mem });
    await writeUserMemory(userId, mem);

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

// ---------------------- ARRANQUE ----------------------

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("Servidor listo en puerto " + PORT);
});
