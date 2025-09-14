// index.js — Backend completo (CommonJS) con welcome/ask multilenguaje (≤90 palabras),
// memoria simple, Heygen, CORS abierto y sanitización anti-duplicado de cita en message.
//
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
function limitWords(s = "", max = 90) {
  const words = String(s || "").trim().split(/\s+/);
  return words.length <= max ? String(s || "").trim() : words.slice(0, max).join(" ").trim();
}
// Q normalizada (para evitar repetir)
function normalizeQuestion(q = "") {
  return String(q).toLowerCase().replace(/\s+/g, " ").trim();
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

  // Líneas tipo: — “...” (Libro 0:0) o - “...” (Libro 0:0)
  s = s.replace(/^[\s]*[—-]\s*.*?\([^)]+?\d+\s*:\s*\d+\)[\s]*$/gim, "").trim();

  // Paréntesis con patrón de referencia (Libro 0:0)
  s = s.replace(/\(([^)]+?\d+\s*:\s*\d+)\)/g, (m) => {
    return ""; // removemos el paréntesis completo
  });

  // Quitar duplicación final estilo " — ... (Libro 0:0)"
  s = s.replace(/\s*[—-]\s*[^()]*\(\s*[^)]+?\d+\s*:\s*\d+\s*\)\s*$/g, "").trim();

  // Compactar espacios.
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

// ===== Prompt base (autoayuda + toque espiritual) =====
// *** IMPORTANTE: el message NO lleva cita bíblica, va SOLO en "bible" ***
const SYSTEM_PROMPT_BASE = `
Hablas con serenidad, claridad y compasión. Estructura cada respuesta con dos capas:
1) Autoayuda: psicoeducación breve y práctica (marcos cognitivo-conductuales, ACT, compasión, límites, hábitos), basada en bibliografía general de autoayuda. Ofrece 1–2 micro-pasos concretos.
2) Toque espiritual cristiano: aplica una cita bíblica pertinente (RVR1909 en español; equivalente en otros idiomas) y un cierre de esperanza humilde.

Reglas IMPORTANTES:
- Devuelve SOLO JSON.
- "message": máximo 90 palabras, sin signos de pregunta, **NO incluyas citas bíblicas ni referencias** (la Escritura va SOLO en "bible").
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
  res.json({ ok: true, hint: "Usa POST /api/welcome con { lang, name, history }" });
});
// Evita 404 del front
app.post("/api/memory/sync", (_req, res) => res.json({ ok: true }));

// ===================================================================
// WELCOME (POST) — saludo por hora + bendición breve + pregunta (varia wording)
// SIN citas bíblicas dentro de "message" (solo en "bible").
// ===================================================================
app.post("/api/welcome", async (req, res) => {
  try {
    const { lang = "es", name = "", history = [] } = req.body || {};
    const hi = greetingByHour(lang);
    const nm = String(name || "").trim();

    const SYSTEM_PROMPT = `${SYSTEM_PROMPT_BASE}
Responde SIEMPRE en ${langLabel(lang)}.
"message": inicia con "${hi}${nm ? ", " + nm : ""}." + **UNA bendición breve** y **UNA frase de orientación**. Mantén 2–3 frases máximo. **No pongas citas bíblicas ni referencias en "message"**.
"question": UNA pregunta abierta breve y distinta en cada bienvenida, para invitar a compartir el tema.
La cita bíblica va SOLO en "bible" y debe ser pertinente.`;

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

    let msg = limitWords(stripQuestionsFromMessage(removeBibleLike((data?.message || "").toString())), 90);
    let ref = cleanRef((data?.bible?.ref || "").toString());
    let text = (data?.bible?.text || "").toString().trim();
    let question = (data?.question || "").toString().trim();
    if (question && !/\?\s*$/.test(question)) question = question + "?";

    res.status(200).json({
      message: msg || `${hi}${nm ? ", " + nm : ""}. Que la paz de Dios te sostenga. Comparte en pocas palabras y damos un paso sencillo.`,
      bible: {
        text: text || (lang === "en" ? "The Lord is near to the brokenhearted." : "Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu."),
        ref: ref || (lang === "en" ? "Psalm 34:18" : "Salmos 34:18")
      },
      ...(question ? { question } : {})
    });
  } catch (e) {
    console.error("WELCOME ERROR:", e);
    res.status(200).json({
      message: "La paz sea contigo. Cuéntame en pocas palabras qué te trae hoy.",
      bible: { text: "Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu.", ref: "Salmos 34:18" },
      question: "¿Qué te gustaría abordar primero?"
    });
  }
});

// ===================================================================
// ASK (POST) — Autoayuda + toque espiritual; FRAME; ≤90 palabras
// **Sin citas bíblicas dentro de "message"** para evitar duplicado.
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

    const shortHistory = compactHistory(history, 10, 240);

    const SYSTEM_PROMPT = `${SYSTEM_PROMPT_BASE}
Responde SIEMPRE en ${langLabel(lang)}.
"message": máximo 90 palabras, sin signos de pregunta. Primero autoayuda breve (2–3 frases) con 1–2 micro-pasos; luego un toque espiritual cristiano. **No incluyas citas bíblicas ni referencias en "message"**.
"question": UNA abierta breve, concreta, que avance el caso (termina en "?").
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

    let msg = limitWords(stripQuestionsFromMessage(removeBibleLike((data?.message || "").toString())), 90);
    let ref = cleanRef((data?.bible?.ref || "").toString());
    let text = (data?.bible?.text || "").toString().trim();
    let question = (data?.question || "").toString().trim();
    if (question && !/\?\s*$/.test(question)) question = question + "?";

    await writeUserMemory(userId, mem);

    res.status(200).json({
      message: msg || (lang === "en" ? "I am with you. Let’s take one small and practical step." : "Estoy contigo. Demos un paso pequeño y práctico."),
      bible: {
        text: text || (lang === "en" ? "The Lord is near to the brokenhearted." : "Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu."),
        ref: ref || (lang === "en" ? "Psalm 34:18" : "Salmos 34:18")
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
