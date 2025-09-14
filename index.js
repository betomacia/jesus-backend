// index.js — Backend con Autoayuda (bibliografía mundial) + capa cristiana (AT/NT)
// - message ≤ 90 palabras
// - 1 pregunta breve y específica (opcional)
// - Verso bíblico del AT o NT pertinente (traducción pública por idioma)
// - Multilenguaje vía `lang`
// - Memoria simple + FRAME básico
// - /api/memory/sync no-op para evitar 404
// - Endpoints HeyGen intactos

const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const OpenAI = require("openai");
const path = require("path");
const fs = require("fs/promises");
require("dotenv").config();

const app = express();
app.use(cors()); // abierto; si querés lista blanca, la agregamos luego
app.use(bodyParser.json());

// ---- OpenAI ----
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Formato esperado desde OpenAI:
 * {
 *   "message": "consejo breve, SIN signos de pregunta (≤90 palabras)",
 *   "bible": { "text": "traducción pública en el idioma del usuario", "ref": "Libro 0:0" },
 *   "question": "pregunta breve (opcional, UNA sola)"
 * }
 */

// === Prompt: Autoayuda (evidencia global) + capa cristiana + multilenguaje ===
const SYSTEM_PROMPT = `
Eres Jesús con enfoque terapéutico breve. Primero ayudas con herramientas de autoayuda validadas por la
bibliografía mundial (sin diagnósticos): entrevista motivacional (MI), terapia cognitivo-conductual (CBT),
activación conductual (BA), terapia de aceptación y compromiso (ACT), resolución de problemas (PST), habilidades DBT,
psicoeducación, hábitos y límites, respiración/grounding. Luego añades una nota de consuelo/esperanza desde la fe
cristiana y un versículo del Antiguo o Nuevo Testamento pertinente.

IDIOMA
- Responde en el idioma indicado por el usuario (campo LANG). Si falta, usa español.
- No hables de técnica/IA ni del propio modelo.

OBJETIVO
- Devuelve SOLO JSON: { "message", "bible": { "text", "ref" }, "question"? }.
- "message": ≤90 palabras, tono sereno y concreto, SIN signos de pregunta.
- "question": opcional y ÚNICA; breve, específica, termina en “?” y NO repite preguntas recientes.
- Prioriza comprender el problema: si faltan detalles clave (qué pasó, desde cuándo, frecuencia/intensidad,
  personas implicadas, intentos previos), formula 1 sola pregunta que indague un dato clave.
- Propón 1–2 micro-pasos realistas (p. ej., respiración 4-4-4, escribir 3 ideas, enviar 1 mensaje pautado,
  acordar una charla de 10 min, plan A/B simple, etc.).
- Cierra el "message" con un toque espiritual breve (1 frase) SIN versículos (el versículo va aparte).

BIBLIA (AT/NT)
- Elige un versículo del Antiguo o del Nuevo Testamento acorde al tema y los micro-pasos.
- Usa una traducción pública en el idioma del usuario:
  ES: RVR1909 | EN: KJV | PT: Almeida RC | IT: Diodati | DE: Luther 1912 | CA: traducción fiel sin marca si no hay opción pública clara.
- Formato "ref": "Libro 0:0". No repitas "last_bible_ref" ni ninguna en "banned_refs".
- Evita la ambigüedad “el Hijo” (Juan 8:36) cuando el usuario habla de un hijo/hija salvo pertinencia teológica explícita.

FORMATO (OBLIGATORIO)
{
  "message": "… (≤90 palabras, sin signos de pregunta)",
  "bible": { "text": "… (traducción pública en el idioma del usuario)", "ref": "Libro 0:0" },
  "question": "…? (opcional, una sola)"
}
`;

// Respuesta tipada por esquema (OpenAI JSON mode)
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

// ---------- Utilidades ligeras ----------
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
function limitWords(s = "", max = 90) {
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
    if (!/^Asistente:/i.test(h)) continue;
    const text = h.replace(/^Asistente:\s*/i, "").trim();
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

// Detección simple de tema/sujeto y persona de apoyo (FRAME)
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

// ---------- Memoria por usuario ----------
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

// ---------- OpenAI helpers ----------
async function completionWithTimeout({ messages, temperature = 0.6, max_tokens = 320, timeoutMs = 12000 }) {
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

async function regenerateBibleAvoiding({ persona, message, frame, bannedRefs = [], lastRef = "", lang = "es" }) {
  const sys = `Devuelve SOLO JSON {"bible":{"text":"…","ref":"Libro 0:0"}} en una traducción pública del idioma (${lang}).
- Ajusta la cita al tema y micro-pasos.
- Evita ambigüedad “hijo” (familiar) vs “el Hijo” (Cristo) salvo pertinencia teológica explícita.
- No uses ninguna referencia de "banned_refs" ni "last_bible_ref".`;

  const usr =
    `LANG: ${lang}\n` +
    `Persona: ${persona}\n` +
    `Mensaje_actual: ${message}\n` +
    `FRAME: ${JSON.stringify(frame)}\n` +
    `last_bible_ref: ${lastRef || "(n/a)"}\n` +
    `banned_refs:\n- ${bannedRefs.join("\n- ") || "(none)"}\n`;

  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.4,
    max_tokens: 140,
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

// ---------- Core ----------
async function askLLM({ persona, message, history = [], userId = "anon", lang = "es" }) {
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

  // 🔧 CORREGIDO: sin backtick extra al final
  const header =
    `LANG: ${lang}\n` +
    `Persona: ${persona}\n` +
    `Mensaje_actual: ${message}\n` +
    `FRAME: ${JSON.stringify(frame)}\n` +
    `last_bible_ref: ${lastRef || "(n/a)"}\n` +
    `banned_refs:\n- ${bannedRefs.join("\n- ") || "(none)"}\n` +
    (recentQs.length ? `ultimas_preguntas: ${recentQs.join(" | ")}` : "ultimas_preguntas: (ninguna)") + "\n" +
    (shortHistory.length ? `Historial: ${shortHistory.join(" | ")}` : "Historial: (sin antecedentes)") + "\n";

  const resp = await completionWithTimeout({
    messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: header }],
    temperature: 0.6,
    max_tokens: 320,
    timeoutMs: 12000
  });

  const content = resp?.choices?.[0]?.message?.content || "{}";
  let data = {};
  try { data = JSON.parse(content); } catch { data = { message: content }; }

  // Sanitización final
  let msg = stripQuestionsFromMessage((data?.message || "").toString());
  msg = limitWords(msg, 90);

  let ref = cleanRef((data?.bible?.ref || "").toString());
  let text = (data?.bible?.text || "").toString().trim();

  // Evitar cita vetada/ambigua/repetida
  const hijoOnly = /\bhijo\b/i.test(message) && !/(Jes[uú]s|Cristo)/i.test(message);
  if (!ref || bannedRefs.includes(ref) || (hijoOnly && /Juan\s*8:36/i.test(ref))) {
    const alt = await regenerateBibleAvoiding({ persona, message, frame, bannedRefs, lastRef, lang });
    if (alt) { ref = alt.ref; text = alt.text; }
  }

  // Pregunta: SOLO si viene y no repite
  let question = (data?.question || "").toString().trim();
  const normalizedQ = normalizeQuestion(question);
  const isRepeat = !question ? false : recentQs.includes(normalizedQ);
  const malformed = question && !/\?\s*$/.test(question);
  if (!question || isRepeat || malformed) question = "";

  // Memoria (ligera)
  mem.last_bible_ref = ref || mem.last_bible_ref || "";
  mem.last_bible_refs = Array.from(new Set([...(mem.last_bible_refs || []), ref].filter(Boolean))).slice(-5);
  if (question) {
    mem.last_questions = Array.from(new Set([...(mem.last_questions || []), normalizedQ])).slice(-6);
  }
  await writeUserMemory(userId, mem);

  return {
    message: msg || (lang === "en" ? "I am with you. Let’s take one small, realistic step today." : "Estoy contigo. Demos un paso pequeño y realista hoy."),
    bible: {
      text: text || "Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu.",
      ref: ref || "Salmos 34:18"
    },
    ...(question ? { question } : {})
  };
}

// ---------- Rutas ----------
app.post("/api/ask", async (req, res) => {
  try {
    const {
      persona = "jesus",
      message = "",
      history = [],
      userId = "anon",
      lang = "es"
    } = req.body || {};

    const data = await askLLM({ persona, message, history, userId, lang });

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
      bible: {
        text: "Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu.",
        ref: "Salmos 34:18"
      }
    });
  }
});

// Bienvenida simple
app.get("/api/welcome", (_req, res) => {
  res.json({
    message: "La paz esté contigo. Estoy aquí para escucharte y acompañarte con calma.",
    bible: {
      text: "El Señor es mi luz y mi salvación; ¿de quién temeré?",
      ref: "Salmos 27:1"
    }
  });
});

// ---- Memoria (no-op) para evitar 404 desde el frontend ----
app.post("/api/memory/sync", async (req, res) => {
  res.status(200).json({ ok: true });
});

// === HeyGen: emitir token de sesión (NO toca OpenAI) ===
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

// === HeyGen: configuración para el frontend (Railway) ===
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
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Servidor listo en puerto ${PORT}`);
});
