// index.js — Backend (CommonJS) con:
// - Bienvenida espiritual breve (≤75 palabras) + pregunta PERSONAL servicial (no "¿Quieres/Te gustaría…?" en bienvenida)
// - Respuestas posteriores (≤75 palabras) con autoayuda + toque espiritual + cita bíblica
// - Generación INFINITA (OpenAI) de preguntas y citas en TODOS los idiomas (sin pools locales finitos)
// - Antirepetición por usuario (memoria en FS) de preguntas y referencias bíblicas (con reintento si repite)
// - Sanitiza para que "message" NO incluya la cita; la cita va SOLO en "bible"
// - HeyGen helpers + CORS abierto
//
// ENV requeridas:
//   OPENAI_API_KEY
// Opcionales (para HeyGen):
//   HEYGEN_API_KEY | HEYGEN_TOKEN, HEYGEN_DEFAULT_AVATAR, HEYGEN_VOICE_ID, HEYGEN_AVATAR_ES/EN/PT/IT/DE/CA/FR

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

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ============ Utils ============
const NORM = (s = "") => String(s).toLowerCase().replace(/\s+/g, " ").trim();

function cleanRef(ref = "") {
  return String(ref).replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
}
function stripQuestionsFromMessage(s = "") {
  const noTrailingQ = String(s)
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => !/\?\s*$/.test(l))
    .join("\n")
    .trim();
  return noTrailingQ.replace(/[¿?]+/g, "").trim();
}
function limitWords(s = "", max = 75) {
  const w = String(s).trim().split(/\s+/);
  return w.length <= max ? String(s).trim() : w.slice(0, max).join(" ").trim();
}
function compactHistory(history = [], keep = 8, maxLen = 260) {
  const arr = Array.isArray(history) ? history : [];
  return arr.slice(-keep).map((x) => String(x).slice(0, maxLen));
}
function langLabel(l = "es") {
  const m = {
    es: "Español",
    en: "English",
    pt: "Português",
    it: "Italiano",
    de: "Deutsch",
    ca: "Català",
    fr: "Français",
  };
  return m[l] || "Español";
}
function greetingByHour(lang = "es") {
  const h = new Date().getHours();
  const g = (m, a, n) => (h < 12 ? m : h < 19 ? a : n);
  switch (lang) {
    case "en":
      return g("Good morning", "Good afternoon", "Good evening");
    case "pt":
      return g("Bom dia", "Boa tarde", "Boa noite");
    case "it":
      return g("Buongiorno", "Buon pomeriggio", "Buonasera");
    case "de":
      return g("Guten Morgen", "Guten Tag", "Guten Abend");
    case "ca":
      return g("Bon dia", "Bona tarda", "Bona nit");
    case "fr":
      return g("Bonjour", "Bon après-midi", "Bonsoir");
    default:
      return g("Buenos días", "Buenas tardes", "Buenas noches");
  }
}

// Vocativos y bendiciones (variación ligera; sólo para tono, no es pool de preguntas/citas)
function pickVocative(lang = "es", gender = "unknown") {
  const rnd = (arr) => arr[Math.floor(Math.random() * arr.length)];
  if (lang === "en") return rnd(["beloved soul", "dear heart", "beloved child", "dear soul"]);
  if (lang === "pt") return rnd(["alma amada", "coração querido", "filho amado", "filha amada"]);
  if (lang === "it") return rnd(["anima amata", "cuore caro", "figlio amato", "figlia amata"]);
  if (lang === "de") return rnd(["geliebte Seele", "liebes Herz", "geliebtes Kind"]);
  if (lang === "ca") return rnd(["ànima estimada", "cor estimat", "fill estimat", "filla estimada"]);
  if (lang === "fr") return rnd(["âme bien-aimée", "cher cœur", "enfant bien-aimé"]);
  if (gender === "female") return rnd(["hija mía", "alma amada", "hija querida", "amiga del Señor"]);
  if (gender === "male") return rnd(["hijo mío", "alma amada", "hijo querido", "amigo del Señor"]);
  return rnd(["alma amada", "hija del Altísimo", "amado del Señor", "alma querida"]);
}
function pickBlessing(lang = "es") {
  const rnd = (arr) => arr[Math.floor(Math.random() * arr.length)];
  switch (lang) {
    case "en":
      return rnd([
        "may the peace of the Lord be with you",
        "may God’s love sustain you",
        "may the Spirit strengthen you",
        "may Christ light your steps",
      ]);
    case "pt":
      return rnd([
        "que a paz do Senhor esteja contigo",
        "que o amor de Deus te sustente",
        "que o Espírito te fortaleça",
        "que Cristo ilumine teus passos",
      ]);
    case "it":
      return rnd([
        "che la pace del Signore sia con te",
        "che l’amore di Dio ti sorregga",
        "che lo Spirito ti fortifichi",
        "che Cristo illumini i tuoi passi",
      ]);
    case "de":
      return rnd([
        "möge der Friede des Herrn mit dir sein",
        "möge Gottes Liebe dich tragen",
        "möge der Geist dich stärken",
        "möge Christus deine Schritte erleuchten",
      ]);
    case "ca":
      return rnd([
        "que la pau del Senyor sigui amb tu",
        "que l’amor de Déu et sostingui",
        "que l’Esperit t’enforteixi",
        "que Crist il·lumini els teus passos",
      ]);
    case "fr":
      return rnd([
        "que la paix du Seigneur soit avec toi",
        "que l’amour de Dieu te soutienne",
        "que l’Esprit te fortifie",
        "que le Christ éclaire tes pas",
      ]);
    default:
      return rnd([
        "que la paz del Señor esté siempre contigo",
        "que el amor de Dios te sostenga",
        "que el Espíritu te fortalezca",
        "que Cristo ilumine tus pasos",
      ]);
  }
}

// Quitar rastro de cita si el modelo la coló dentro de "message"
function removeBibleLike(text = "") {
  let s = String(text || "");
  s = s.replace(/^[\s]*[—-]\s*.*?\([^)]+?\d+\s*:\s*\d+\)[\s]*$/gim, "").trim();
  s = s.replace(/\(([^)]+?\d+\s*:\s*\d+)\)/g, () => "");
  s = s.replace(/\s*[—-]\s*[^()]*\(\s*[^)]+?\d+\s*:\s*\d+\s*\)\s*$/g, "").trim();
  return s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ============ Memoria por usuario (FS) ============
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
async function ensureDataDir() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch {}
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
    return {
      last_bible_refs: [], // refs recientes para evitar
      last_questions: [], // preguntas recientes para evitar
      frame: null, // placeholder para futuro
    };
  }
}
async function writeUserMemory(userId, mem) {
  await ensureDataDir();
  await fs.writeFile(memPath(userId), JSON.stringify(mem, null, 2), "utf8");
}

// ============ Heurísticas simples de tema ============
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

// ============ OpenAI helper ============
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
          required: ["text", "ref"],
        },
        question: { type: "string" },
      },
      required: ["message", "bible"],
      additionalProperties: false,
    },
  },
};

async function completionJson({ messages, temperature = 0.6, max_tokens = 240, timeoutMs = 14000 }) {
  const call = openai.chat.completions.create({
    model: "gpt-4o",
    temperature,
    max_tokens,
    messages,
    response_format: RESPONSE_FORMAT,
  });
  return await Promise.race([call, new Promise((_, rej) => setTimeout(() => rej(new Error("TIMEOUT")), timeoutMs))]);
}

// ============ Health ============
app.get("/", (_req, res) => res.json({ ok: true, service: "backend", ts: Date.now() }));
app.get("/api/welcome", (_req, res) =>
  res.json({ ok: true, hint: "POST /api/welcome { lang, name, userId, gender?, history }" })
);
app.post("/api/memory/sync", (_req, res) => res.json({ ok: true }));

// ============ WELCOME ============
// Objetivo: saludo breve (≤75 palabras totales), espiritual, y luego UNA pregunta PERSONAL (no de oferta).
// * La pregunta debe ser variada y diferente a las recientes almacenadas por usuario.
// * Las citas y preguntas las genera OpenAI (no pools locales).
app.post("/api/welcome", async (req, res) => {
  try {
    const { lang = "es", name = "", userId = "anon", gender = "unknown", history = [] } = req.body || {};
    const nm = String(name || "").trim();
    const hi = greetingByHour(lang);
    const voc = pickVocative(lang, gender);
    const blessing = pickBlessing(lang);
    const prelude = `${hi}${nm ? `, ${nm}` : ""}. ${voc[0].toUpperCase() + voc.slice(1)}, ${blessing}.`;

    const mem = await readUserMemory(userId);
    const avoidRefs = Array.isArray(mem.last_bible_refs) ? mem.last_bible_refs.slice(-12) : [];
    const avoidQs = Array.isArray(mem.last_questions) ? mem.last_questions.slice(-16) : [];

    // Reglas de estilo para la pregunta de bienvenida:
    // - Personal/servicial: debe mostrar interés genuino por lo que necesita y siente el usuario.
    // - NO usar "¿Quieres/Te gustaría...?" en bienvenida (esas ofertas vendrán después en seguimiento).
    // - 6–16 palabras, variada, específica, termina en "?".
    const SYSTEM_PROMPT = `
Eres un guía compasivo. Responde SOLO en ${langLabel(lang)} y SOLO JSON con el esquema.

Requisitos de salida:
- "message": Empieza exactamente con: "${prelude}"
  Tras ese inicio, añade 1–2 frases breves: ánimo realista + foco del día. Máximo 75 palabras totales. Sin signos de pregunta. **NO incluyas citas ni referencias bíblicas en "message"**.
- "bible": Una cita bíblica pertinente (texto + ref) que refuerce el ánimo/esperanza del saludo. Evita repeticiones y varía a lo largo del canon (Antiguo/NT, diferentes libros).
- "question": **UNA** pregunta PERSONAL servicial que explore necesidades/sentires/tema del usuario (no ofrezcas acciones explícitas aún). Debe ser distinta a las recientes y a fórmulas genéricas. No uses "¿Quieres...?" ni "¿Te gustaría...?" en la bienvenida. 6–16 palabras, termina en "?".

Evita referencias recientes: ${avoidRefs.map((r) => `"${r}"`).join(", ") || "(ninguna)"}.
Evita preguntas recientes: ${avoidQs.map((q) => `"${q}"`).join(", ") || "(ninguna)"}.

Criterios de calidad:
- Variedad de vocabulario y sintaxis; tono cercano y respetuoso.
- Lenguaje claro, concreto, sin tecnicismos.
- No enumeraciones; no listas.
`;

    const shortHistory = compactHistory(history, 6, 200);
    const header =
      `Lang: ${lang}\n` +
      `Nombre: ${nm || "(anónimo)"}\n` +
      `Prelude: ${prelude}\n` +
      (shortHistory.length ? `Historial: ${shortHistory.join(" | ")}` : "Historial: (sin antecedentes)") +
      "\n";

    const r = await completionJson({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: header },
      ],
      temperature: 0.75,
      max_tokens: 240,
    });

    const content = r?.choices?.[0]?.message?.content || "{}";
    let data = {};
    try {
      data = JSON.parse(content);
    } catch {
      data = {};
    }

    let msg = limitWords(stripQuestionsFromMessage(removeBibleLike(String(data?.message || ""))), 75);
    if (!msg.startsWith(prelude)) msg = `${prelude} ${msg}`.trim();

    let ref = cleanRef(String(data?.bible?.ref || ""));
    let text = String(data?.bible?.text || "").trim();
    let question = String(data?.question || "").trim();
    if (question && !/\?\s*$/.test(question)) question += "?";
    const qNorm = NORM(question);

    // Si ref repetida => reintenta SOLO la biblia una vez
    const avoidRefSet = new Set(avoidRefs.map((x) => NORM(cleanRef(x))));
    if (!ref || avoidRefSet.has(NORM(ref))) {
      const r2 = await completionJson({
        messages: [
          {
            role: "system",
            content: `Devuelve SOLO JSON con "bible" nuevo (texto + ref), en ${langLabel(
              lang
            )}. Evita estas referencias: ${avoidRefs.map((r) => `"${r}"`).join(", ") || "(ninguna)"}. Usa un versículo distinto, pertinente y claro.`,
          },
          { role: "user", content: "Necesito únicamente un nuevo objeto bible." },
        ],
        temperature: 0.8,
        max_tokens: 120,
      }).catch(() => null);
      const c2 = r2?.choices?.[0]?.message?.content || "{}";
      try {
        const d2 = JSON.parse(c2);
        if (d2?.bible?.ref && d2?.bible?.text) {
          ref = cleanRef(String(d2.bible.ref || ""));
          text = String(d2.bible.text || "").trim();
        }
      } catch {}
    }

    // Validación de la pregunta: no repetida, personal y sin “¿Quieres…?”
    const bannedQs = new Set(avoidQs.map(NORM));
    const isOfferish = /^(¿\s*)?(quieres|te gustaría|deseas)\b/i.test(question || "");
    const tooShort = qNorm.split(/\s+/).length < 6;
    const tooLong = qNorm.split(/\s+/).length > 16;
    if (!question || bannedQs.has(qNorm) || isOfferish || tooShort || tooLong) {
      const rQ = await completionJson({
        messages: [
          {
            role: "system",
            content: `Escribe SOLO JSON con "question" en ${langLabel(
              lang
            )}. Debe ser PERSONAL/servicial (necesidades, sentimientos, tema). 6–16 palabras. Termina en "?". Evita: ${Array.from(bannedQs)
              .map((q) => `"${q}"`)
              .join(", ") || "(ninguna)"} y evita “¿Quieres…?” / “¿Te gustaría…?”.`,
          },
          { role: "user", content: "Necesito únicamente un 'question' nuevo." },
        ],
        temperature: 0.85,
        max_tokens: 60,
      }).catch(() => null);
      const cQ = rQ?.choices?.[0]?.message?.content || "{}";
      try {
        const dQ = JSON.parse(cQ);
        if (dQ?.question) {
          question = String(dQ.question || "").trim();
          if (question && !/\?\s*$/.test(question)) question += "?";
        }
      } catch {}
    }

    // Persistencia de memoria (últimas refs y preguntas)
    const cleanedRef = cleanRef(ref);
    if (cleanedRef) {
      const arr = Array.isArray(mem.last_bible_refs) ? mem.last_bible_refs : [];
      arr.push(cleanedRef);
      while (arr.length > 12) arr.shift();
      mem.last_bible_refs = arr;
    }
    if (question) {
      const qs = Array.isArray(mem.last_questions) ? mem.last_questions : [];
      qs.push(question);
      while (qs.length > 16) qs.shift();
      mem.last_questions = qs;
    }
    await writeUserMemory(userId, mem);

    res.status(200).json({
      message:
        msg ||
        `${prelude} Comparte en pocas palabras lo esencial y damos un paso sencillo.`,
      bible: {
        text:
          text ||
          (lang === "en"
            ? "The Lord is close to the brokenhearted."
            : "Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu."),
        ref:
          cleanedRef ||
          (lang === "en" ? "Psalm 34:18" : "Salmos 34:18"),
      },
      question:
        question ||
        (lang === "en"
          ? "What part of your heart needs attention today?"
          : "¿Qué parte de tu corazón necesita atención hoy?"),
    });
  } catch (e) {
    console.error("WELCOME ERROR:", e);
    const hi = greetingByHour("es");
    res.status(200).json({
      message: `${hi}. Alma amada, que la paz del Señor esté siempre contigo. Cuéntame en pocas palabras qué te trae hoy.`,
      bible: {
        text:
          "Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu.",
        ref: "Salmos 34:18",
      },
      question: "¿Qué situación concreta quisieras mirar conmigo hoy?",
    });
  }
});

// ============ ASK ============
// Respuestas posteriores (≤75 palabras), con:
// - "message": autoayuda breve (1–2 micro-pasos) + toque espiritual; sin preguntas ni citas dentro del message.
// - "bible": cita pertinente (texto + ref) coherente con el micro-paso propuesto (evitar repeticiones recientes).
// - "question": PERSONAL/diagnóstica o de progreso. Puede incluir ofertas (“¿Quieres que te guíe…?”) SOLO si tiene sentido por contexto,
//   pero el modelo debe priorizar preguntas que recaben información útil o concreten el próximo paso.
app.post("/api/ask", async (req, res) => {
  try {
    const { persona = "jesus", message = "", history = [], userId = "anon", lang = "es" } = req.body || {};
    const mem = await readUserMemory(userId);

    const topic = guessTopic(message);
    const mainSubject = detectMainSubject(message);
    const frame = {
      topic_primary: topic,
      main_subject:
        mem.frame?.topic_primary === topic ? mem.frame?.main_subject || mainSubject : mainSubject,
      support_persons:
        mem.frame?.topic_primary === topic ? mem.frame?.support_persons || [] : [],
    };
    mem.frame = frame;

    const avoidRefs = Array.isArray(mem.last_bible_refs) ? mem.last_bible_refs.slice(-12) : [];
    const shortHistory = compactHistory(history, 10, 240);

    const SYSTEM_PROMPT = `
Eres guía compasivo. Responde SOLO en ${langLabel(lang)} y SOLO JSON.

"message": máximo 75 palabras, sin signos de pregunta. Primero 1–2 frases de autoayuda clara y práctica (micro-pasos ejecutables hoy); luego un toque espiritual cristiano (sin citar). **NO incluyas citas ni referencias en "message"**.

"bible": cita pertinente (texto + ref) relacionada con el micro-paso o el consuelo ofrecido. Evita referencias recientes y varía a lo largo de la Escritura (diferentes libros, AT/NT).

"question": UNA pregunta breve (6–16 palabras), personal y útil para avanzar: profundiza en el problema, clarifica contexto, o valida disposición. Puede ofrecer ayuda concreta sólo si el contexto la sugiere (p. ej., “¿Quieres que te acompañe en una oración breve?”), pero evita repetir esa forma seguido. Termina en "?".

Evita referencias recientes: ${avoidRefs.map((r) => `"${r}"`).join(", ") || "(ninguna)"}.
Criterios: tono cálido, concreto, sin tecnicismos, sin listas.
`;

    const header =
      `Persona: ${persona}\n` +
      `Lang: ${lang}\n` +
      `Mensaje_actual: ${message}\n` +
      `FRAME: ${JSON.stringify(frame)}\n` +
      (shortHistory.length ? `Historial: ${shortHistory.join(" | ")}` : "Historial: (sin antecedentes)") +
      "\n";

    const r = await completionJson({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: header },
      ],
      temperature: 0.7,
      max_tokens: 260,
    });

    const content = r?.choices?.[0]?.message?.content || "{}";
    let data = {};
    try {
      data = JSON.parse(content);
    } catch {
      data = {};
    }

    let msg = limitWords(stripQuestionsFromMessage(removeBibleLike(String(data?.message || ""))), 75);
    let ref = cleanRef(String(data?.bible?.ref || ""));
    let text = String(data?.bible?.text || "").trim();
    let question = String(data?.question || "").trim();
    if (question && !/\?\s*$/.test(question)) question += "?";

    // Reintento si cita repetida
    const avoidSet = new Set(avoidRefs.map((x) => NORM(cleanRef(x))));
    if (!ref || avoidSet.has(NORM(ref))) {
      const r2 = await completionJson({
        messages: [
          {
            role: "system",
            content: `Devuelve SOLO JSON con "bible" nuevo (texto + ref), en ${langLabel(
              lang
            )}. Evita estas referencias: ${avoidRefs.map((r) => `"${r}"`).join(", ") || "(ninguna)"}. Selecciona un versículo distinto y pertinente al consejo.`,
          },
          { role: "user", content: "Necesito únicamente un nuevo objeto bible." },
        ],
        temperature: 0.8,
        max_tokens: 120,
      }).catch(() => null);
      const c2 = r2?.choices?.[0]?.message?.content || "{}";
      try {
        const d2 = JSON.parse(c2);
        if (d2?.bible?.ref && d2?.bible?.text) {
          ref = cleanRef(String(d2.bible.ref || ""));
          text = String(d2.bible.text || "").trim();
        }
      } catch {}
    }

    // Persistir memoria
    const cleanedRef = cleanRef(ref);
    if (cleanedRef) {
      const arr = Array.isArray(mem.last_bible_refs) ? mem.last_bible_refs : [];
      arr.push(cleanedRef);
      while (arr.length > 12) arr.shift();
      mem.last_bible_refs = arr;
    }
    await writeUserMemory(userId, mem);

    res.status(200).json({
      message:
        msg ||
        (lang === "en"
          ? "I am with you. Let’s take one small and practical step."
          : "Estoy contigo. Demos un paso pequeño y práctico."),
      bible: {
        text:
          text ||
          (lang === "en"
            ? "The Lord is close to the brokenhearted."
            : "Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu."),
        ref:
          cleanedRef ||
          (lang === "en" ? "Psalm 34:18" : "Salmos 34:18"),
      },
      ...(question ? { question } : {}),
    });
  } catch (err) {
    console.error("ASK ERROR:", err);
    res.status(200).json({
      message:
        "La paz sea contigo. Compárteme en pocas palabras lo esencial, y seguimos paso a paso.",
      bible: {
        text:
          "Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu.",
        ref: "Salmos 34:18",
      },
    });
  }
});

// ============ HeyGen helpers ============
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

// ============ Arranque ============
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor listo en puerto ${PORT}`));
