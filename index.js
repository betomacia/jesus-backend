// index.js — backend orquestado (Planner → Writer → Verse) con memoria persistente, goal lock, cooldowns y anti-desvío

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
    '- No menciones el nombre civil del usuario. Usa \"hijo mío\", \"hija mía\" o \"alma amada\" con moderación.',
    "- No hables de técnica/IA ni del propio modelo.",
    "",
    "FRAME Y FOCO",
    "- Usa el FRAME (topic_primary, main_subject, goal, risk, support_persons, constraints) como fuente de verdad.",
    "- NO cambies el topic_primary salvo que el usuario lo pida explícitamente.",
    "- \"mi hija/mi hijo/un amigo\" son slots de apoyo: NO redefinen el tema.",
    "",
    "PROGRESO Y NOVEDAD",
    "- Cada turno aporta novedad útil (mini-guion, decisión binaria, límite práctico, contacto concreto).",
    "- Tras un ACK (\"sí/ok/vale\"), pasa de plan a PRÁCTICA/COMPROMISO (ensayar guion, fijar hora, límite, contacto).",
    "",
    "BIBLIA",
    '- Cita RVR1909 literal. \"ref\" con formato \"Libro 0:0\".',
    "- La cita se elige por el TEMA y por el contenido de \"message\", no por palabras sueltas."
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
function parseGoalFromText(s = "") {
  const t = (s || "").toLowerCase();
  if (/(quiero recuperar|quiero que vuelva|reconcili|volver con)/.test(t)) return "reconcile";
  if (/(cerrar en paz|soltar|aceptar|terminar|divorcio)/.test(t)) return "close_peacefully";
  if (/(ganar claridad|no se|no s[eé]|confund)/.test(t)) return "clarify";
  return "";
}
function detectRefusalClass(s = "") {
  const t = (s || "").toLowerCase();
  if (/(no\s+quiero|no\s+me\s+gusta|no\s+voy\s+a).*(terapeuta|terapia|psic[oó]logo|consejer[oa]|grupo|profesional)/.test(t)) return "help";
  return "";
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
      last_question_class: "",
      goal_lock: "",         // reconcile | clarify | close_peacefully
      declines: { help: 0 }  // contador de rechazos
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
  if (mem.goal_lock) parts.push("objetivo_bloqueado: " + mem.goal_lock);
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
  // 1) goal lock / rechazos
  const parsedGoal = parseGoalFromText(message);
  if (parsedGoal) mem.goal_lock = parsedGoal;
  const refusal = detectRefusalClass(message);
  if (refusal === "help") mem.declines.help = Math.min(3, (mem.declines.help || 0) + 1);

  const persistentMemory = buildPersistentMemoryPrompt(mem);
  const shortHistory = compactHistory(history, 8, 240);
  const lastQClass = mem.last_question_class || "";
  const focusHint = lastSubstantiveUser(history);

  const sys = [
    SYSTEM_PROMPT_CORE,
    "",
    "TU FUNCIÓN: PLANIFICAR SIN CAMBIAR EL FOCO",
    "- Devuelve SOLO JSON con campos del esquema.",
    "- Mantén el topic_primary anterior salvo cambio explícito del usuario.",
    "- \"mi hija/mi hijo\" u otros apoyos → añadir a support_persons, NO cambiar topic_primary.",
    "- Define question_class procurando NO repetir la del turno anterior.",
    "- Si hay objective_bloqueado, respétalo como goal salvo que el usuario lo cambie."
  ].join("\n");

  const usr = [
    `PERSONA: ${persona}`,
    `MENSAJE_ACTUAL: ${message}`,
    `FRAME_PREVIO: ${JSON.stringify(mem.frame || {})}`,
    `LAST_QUESTION_CLASS: ${lastQClass || "(n/a)"}`,
    `objective_bloqueado: ${mem.goal_lock || "(ninguno)"}`,
    `rechazos: ${JSON.stringify(mem.declines || {})}`,
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

  // 2) ensamblar frame
  const framePrev = mem.frame || {};
  const frame = {
    topic_primary: data.topic_primary || framePrev.topic_primary || "general",
    main_subject: data.main_subject || framePrev.main_subject || "self",
    goal: (mem.goal_lock || data.goal || framePrev.goal || ""),
    risk: data.risk || framePrev.risk || "normal",
    support_persons: Array.isArray(data.support_persons) ? data.support_persons.slice(-5) : (framePrev.support_persons || []),
    constraints: data.constraints || framePrev.constraints || {}
  };

  // 3) normalizar question class
  let qClass = (data.question_class || "").trim();
  if (!qClass) qClass = rotateQuestionClass(lastQClass);
  if (qClass === lastQClass) qClass = rotateQuestionClass(qClass);

  // 4) slots de apoyo NO pivotan
  if (isShortSupportNP(message)) {
    frame.topic_primary = framePrev.topic_primary || frame.topic_primary;
    frame.main_subject  = framePrev.main_subject  || frame.main_subject;
    if (!frame.support_persons.includes(message.trim())) frame.support_persons.push(message.trim());
    if (["activity", "feelings", "help"].includes(qClass)) qClass = "decision";
  }

  // 5) cooldown de “help” si hubo rechazos
  if ((mem.declines.help || 0) >= 2 && qClass === "help") {
    qClass = "decision";
  }

  // 6) ACK empuja a compromiso/práctica
  if (isAck(message)) {
    if (!["commitment", "practice"].includes(qClass)) qClass = "commitment";
  }

  return { frame, question_class: qClass, focusHint };
}

// ---------------------- ETAPA 2: WRITER ----------------------

async function writeResponse({ persona, message, history, frame, question_class, last_bible_ref, last_question }) {
  const shortHistory = compactHistory(history, 8, 240);

  const sys = [
    SYSTEM_PROMPT_CORE,
    "",
    "MODO ESCRITURA",
    "- Genera SOLO JSON del esquema de salida.",
    '- \"message\": 2–3 pasos HOY (• …), o contención si está ambiguo. No repitas lo dicho recientemente.',
    `- \"question\": EXACTAMENTE UNA, de clase ${question_class} (data/decision/commitment/practice/time/help/boundary/feelings/next_step/place).`,
    "- Mantén el topic_primary del FRAME.",
    "",
    // Reglas fuertes para temas de pareja/separación con reconciliación
    "- Si topic_primary es separación/relación y goal es \"reconcile\":",
    "  • Incluye AL MENOS un paso interpersonal concreto (elegir canal, hora, guion breve, límites de respeto).",
    "  • Limita autocuidado a UNA viñeta como máximo (complemento, no sustituto)."
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

  // Evitar repetir la última pregunta literalmente
  const qNorm = normalizeQuestion(questionOut);
  const lastQNorm = normalizeQuestion(last_question || "");
  if (qNorm && qNorm === lastQNorm) {
    questionOut =
      question_class === "decision" ? "¿Prefieres enviar hoy un mensaje breve o acordar una llamada corta?" :
      question_class === "commitment" ? "¿Confirmas un primer paso concreto para hoy?" :
      "¿Qué paso pequeño puedes dar ahora mismo?";
  }

  // Refuerzo anti-actividad con apoyo si el tema es pareja
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
    '- Elige una cita coherente con el topic_primary y con los micro-pasos del "message" (ensayo, límites, reconciliación, pedir sabiduría...).',
    "- Evita cualquier referencia en la lista \"banned_refs\".",
    "- Evita ambigüedad entre “hijo” (niño) y “el Hijo” (Cristo) cuando no sea el punto."
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
  const focusHint = lastSubstantiveUser(history);

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
    writerOut = {
      message: "Que la paz y el amor te acompañen. Descansa en la certeza de que no caminas sola.",
      question: ""
    };
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
    verse = { text: "Y si alguno de vosotros tiene falta de sabiduría, pídala a Dios, el cual da a todos abundantemente y sin reproche, y le será dada.", ref: "Santiago 1:5" };
  }

  // Memoria
  mem.frame = frame;
  mem.last_bible_ref = verse.ref;
  mem.last_bible_refs = Array.from(new Set([...(mem.last_bible_refs || []), verse.ref])).slice(-5);
  if (writerOut.question) {
    mem.last_questions = Array.from(new Set([...(mem.last_questions || []), writerOut.question])).slice(-6);
  }
  mem.last_question_class = qClass || mem.last_question_class || "";
  mem.topics = mem.topics || {};
  const topicKey = String(frame.topic_primary || "general");
  mem.topics[topicKey] = { ...(mem.topics[topicKey] || {}), last_seen: Date.now() };

  // amortiguar rechazos: con el paso del tiempo se “descuenta”
  if (mem.declines && mem.declines.help > 0) mem.declines.help = Math.max(0, mem.declines.help - 1);

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
