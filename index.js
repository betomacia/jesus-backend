// index.js — Backend (CommonJS) con: ≤75 palabras, anti-repetición de citas (evita Mt 11:28),
// retry si cita vetada, memoria simple de últimas citas, Heygen y CORS abierto.

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
function limitWords(s = "", max = 75) { // <= 75
  const words = String(s || "").trim().split(/\s+/);
  return words.length <= max ? String(s || "").trim() : words.slice(0, max).join(" ").trim();
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

// — Sanitizador: si el modelo metiera la cita en "message", la quitamos.
function removeBibleLike(text = "") {
  let s = String(text || "");
  s = s.replace(/^[\s]*[—-]\s*.*?\([^)]+?\d+\s*:\s*\d+\)[\s]*$/gim, "").trim();
  s = s.replace(/\(([^)]+?\d+\s*:\s*\d+)\)/g, () => "");
  s = s.replace(/\s*[—-]\s*[^()]*\(\s*[^)]+?\d+\s*:\s*\d+\s*\)\s*$/g, "").trim();
  return s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ===== Memoria (últimas citas) =====
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
async function ensureDataDir() { try { await fs.mkdir(DATA_DIR, { recursive: true }); } catch {} }
function memPath(uid) { const safe = String(uid || "anon").replace(/[^a-z0-9_-]/gi, "_"); return path.join(DATA_DIR, `mem_${safe}.json`); }
async function readUserMemory(userId) {
  await ensureDataDir();
  try { return JSON.parse(await fs.readFile(memPath(userId), "utf8")); }
  catch { return { last_bible_refs: [], frame: null }; }
}
async function writeUserMemory(userId, mem) {
  await ensureDataDir();
  await fs.writeFile(memPath(userId), JSON.stringify(mem, null, 2), "utf8");
}

// ===== FRAME =====
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
function detectSupportNP(s = "") {
  const SUPPORT_WORDS = ["hijo","hija","madre","padre","mamá","mama","papá","papa","abuelo","abuela","nieto","nieta","tío","tio","tía","tia","sobrino","sobrina","primo","prima","cuñado","cuñada","suegro","suegra","yerno","nuera","esposo","esposa","pareja","novio","novia","amigo","amiga","compañero","compañera","colega","vecino","vecina","pastor","sacerdote","mentor","maestro","maestra","profesor","profesora","jefe","jefa","psicólogo","psicologa","psicóloga","terapeuta","consejero","consejera","médico","medica","médica"];
  const raw = (s || "").trim(); if (!raw) return null;
  const tokens = raw.split(/\s+/); if (tokens.length > 6) return null;
  const low = raw.toLowerCase(); const art = /^(mi|mis|una|un|el|la)\s+(.+)$/i;
  let core = low; let label = raw; const m = low.match(art); if (m) { core = m[2].trim(); label = raw; }
  const first = core.split(/\s+/)[0].replace(/[.,;:!?"'()]/g, ""); if (!first) return null;
  if (!SUPPORT_WORDS.includes(first)) return null; return { label };
}

// ===== Prompt base =====
const SYSTEM_PROMPT_BASE = `
Hablas con serenidad, claridad y compasión. Dos capas:
1) Autoayuda breve y práctica (bibliografía general): 1–2 micro-pasos.
2) Toque espiritual cristiano: una cita bíblica pertinente y un cierre de esperanza.
Reglas:
- SOLO JSON.
- "message": ≤75 palabras, sin signos de pregunta, **sin citas ni referencias bíblicas** (van SOLO en "bible").
- "question": UNA (opcional), abierta, breve, termina en "?", variada.
- Usa el FRAME y el historial.
- Si se te dan "banned_refs", **no las uses ni sus equivalentes**; elige otra coherente con el tema.
`;

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

async function completionJson({ messages, temperature = 0.6, max_tokens = 230, timeoutMs = 12000 }) {
  const call = openai.chat.completions.create({
    model: "gpt-4o",
    temperature,
    max_tokens,
    messages,
    response_format: RESPONSE_FORMAT
  });
  return await Promise.race([call, new Promise((_, rj) => setTimeout(() => rj(new Error("TIMEOUT")), timeoutMs))]);
}

// — Citas “muy usadas” (evitar cuando sea posible)
const COMMON_OVERUSED_REFS = [
  "Mateo 11:28",
  "Salmos 23:1",
  "Filipenses 4:6",
  "Jeremías 29:11",
  "Romanos 8:28",
  "Salmos 34:18"
];

// ---------- HEALTH ----------
app.get("/", (_req, res) => res.json({ ok: true, service: "backend", ts: Date.now() }));
app.get("/api/welcome", (_req, res) => res.json({ ok: true, hint: "POST /api/welcome {lang,name,history}" }));
app.post("/api/memory/sync", (_req, res) => res.json({ ok: true }));

// ---------- WELCOME ----------
app.post("/api/welcome", async (req, res) => {
  try {
    const { lang = "es", name = "", history = [], userId = "anon" } = req.body || {};
    const hi = greetingByHour(lang);
    const nm = String(name || "").trim();

    // Memoria para evitar repetir cita también en welcome
    const mem = await readUserMemory(userId);
    const banned_refs = Array.from(new Set([...(mem.last_bible_refs || []), ...COMMON_OVERUSED_REFS])).slice(-8);

    const prompt =
      `${SYSTEM_PROMPT_BASE}\n` +
      `Responde SIEMPRE en ${langLabel(lang)}.\n` +
      `"message": inicia con "${hi}${nm ? ", " + nm : ""}." + una **bendición breve** y **una frase de orientación** (2–3 frases máx).\n` +
      `"question": UNA breve y distinta para invitar a compartir.\n` +
      `banned_refs: ${banned_refs.join(" | ")}`;

    const header =
      `Lang: ${lang}\n` +
      `Nombre: ${nm || "(anónimo)"}\n` +
      (history?.length ? `Historial: ${compactHistory(history, 6, 200).join(" | ")}` : "Historial: (sin antecedentes)") + "\n";

    // 1er intento
    let r = await completionJson({ messages: [{ role: "system", content: prompt }, { role: "user", content: header }], temperature: 0.7 });
    let data = {};
    try { data = JSON.parse(r?.choices?.[0]?.message?.content || "{}"); } catch {}
    let msg = limitWords(stripQuestionsFromMessage(removeBibleLike(String(data?.message || ""))), 75);
    let ref = cleanRef(String(data?.bible?.ref || ""));
    let text = String(data?.bible?.text || "").trim();
    let question = String(data?.question || "").trim();
    if (question && !/\?\s*$/.test(question)) question += "?";

    // Si la cita está vetada, reintenta 1 vez
    if (ref && banned_refs.includes(ref)) {
      const retryPrompt = prompt + `\nIMPORTANTE: evita absolutamente estas referencias: ${banned_refs.join(", ")}. Elige otra coherente con el tema.`;
      r = await completionJson({ messages: [{ role: "system", content: retryPrompt }, { role: "user", content: header }], temperature: 0.6 });
      try { data = JSON.parse(r?.choices?.[0]?.message?.content || "{}"); } catch {}
      msg = limitWords(stripQuestionsFromMessage(removeBibleLike(String(data?.message || ""))), 75);
      ref = cleanRef(String(data?.bible?.ref || ""));
      text = String(data?.bible?.text || "").trim();
      question = String(data?.question || "").trim();
      if (question && !/\?\s*$/.test(question)) question += "?";
    }

    // Actualiza memoria de citas
    if (ref) {
      mem.last_bible_refs = Array.from(new Set([...(mem.last_bible_refs || []), ref])).slice(-6);
      await writeUserMemory(userId, mem);
    }

    res.json({
      message: msg || `${hi}${nm ? ", " + nm : ""}. Que la paz de Dios te sostenga. Comparte lo esencial y avanzamos.`,
      bible: {
        text: text || (lang === "en" ? "The Lord is near to the brokenhearted." : "Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu."),
        ref: ref || (lang === "en" ? "Psalm 34:18" : "Salmos 34:18")
      },
      ...(question ? { question } : {})
    });
  } catch (e) {
    console.error("WELCOME ERROR:", e);
    res.json({
      message: "La paz sea contigo. Cuéntame en pocas palabras qué te trae hoy.",
      bible: { text: "Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu.", ref: "Salmos 34:18" },
      question: "¿Qué te gustaría abordar primero?"
    });
  }
});

// ---------- ASK ----------
app.post("/api/ask", async (req, res) => {
  try {
    const { persona = "jesus", message = "", history = [], userId = "anon", lang = "es" } = req.body || {};

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

    const banned_refs = Array.from(new Set([...(mem.last_bible_refs || []), ...COMMON_OVERUSED_REFS])).slice(-8);

    const prompt =
      `${SYSTEM_PROMPT_BASE}\n` +
      `Responde SIEMPRE en ${langLabel(lang)}.\n` +
      `"message": ≤75 palabras, autoayuda (2–3 frases) + toque espiritual (sin cita en message).\n` +
      `"question": UNA abierta breve que avance el caso.\n` +
      `banned_refs: ${banned_refs.join(" | ")}`;

    const header =
      `Persona: ${persona}\n` +
      `Lang: ${lang}\n` +
      `Mensaje_actual: ${message}\n` +
      `FRAME: ${JSON.stringify(frame)}\n` +
      (history?.length ? `Historial: ${compactHistory(history, 10, 240).join(" | ")}` : "Historial: (sin antecedentes)") + "\n";

    // 1er intento
    let r = await completionJson({ messages: [{ role: "system", content: prompt }, { role: "user", content: header }], temperature: 0.65 });
    let data = {};
    try { data = JSON.parse(r?.choices?.[0]?.message?.content || "{}"); } catch {}
    let msg = limitWords(stripQuestionsFromMessage(removeBibleLike(String(data?.message || ""))), 75);
    let ref = cleanRef(String(data?.bible?.ref || ""));
    let text = String(data?.bible?.text || "").trim();
    let question = String(data?.question || "").trim();
    if (question && !/\?\s*$/.test(question)) question += "?";

    // Retry si cita vetada
    if (ref && banned_refs.includes(ref)) {
      const retryPrompt = prompt + `\nIMPORTANTE: evita absolutamente estas referencias: ${banned_refs.join(", ")}. Elige otra coherente con el tema.`;
      r = await completionJson({ messages: [{ role: "system", content: retryPrompt }, { role: "user", content: header }], temperature: 0.6 });
      try { data = JSON.parse(r?.choices?.[0]?.message?.content || "{}"); } catch {}
      msg = limitWords(stripQuestionsFromMessage(removeBibleLike(String(data?.message || ""))), 75);
      ref = cleanRef(String(data?.bible?.ref || ""));
      text = String(data?.bible?.text || "").trim();
      question = String(data?.question || "").trim();
      if (question && !/\?\s*$/.test(question)) question += "?";
    }

    // Guarda última cita
    if (ref) {
      mem.last_bible_refs = Array.from(new Set([...(mem.last_bible_refs || []), ref])).slice(-6);
    }
    await writeUserMemory(userId, mem);

    res.json({
      message: msg || (lang === "en" ? "I am with you. Let’s take one small and practical step." : "Estoy contigo. Demos un paso pequeño y práctico."),
      bible: {
        text: text || (lang === "en" ? "The Lord is near to the brokenhearted." : "Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu."),
        ref: ref || (lang === "en" ? "Psalm 34:18" : "Salmos 34:18")
      },
      ...(question ? { question } : {})
    });
  } catch (err) {
    console.error("ASK ERROR:", err);
    res.json({
      message: "La paz sea contigo. Compárteme en pocas palabras lo esencial, y seguimos paso a paso.",
      bible: { text: "Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu.", ref: "Salmos 34:18" }
    });
  }
});

// ---------- HEYGEN ----------
app.get("/api/heygen/token", async (_req, res) => {
  try {
    const API_KEY = process.env.HEYGEN_API_KEY || process.env.HEYGEN_TOKEN || "";
    if (!API_KEY) return res.status(500).json({ error: "missing_HEYGEN_API_KEY" });
    const r = await fetch("https://api.heygen.com/v1/streaming.create_token", {
      method: "POST", headers: { "x-api-key": API_KEY, "Content-Type": "application/json" }, body: "{}",
    });
    const json = await r.json().catch(() => ({})); const token = json?.data?.token || json?.token || json?.access_token || "";
    if (!r.ok || !token) return res.status(r.status || 500).json({ error: "heygen_token_failed", detail: json });
    res.json({ token });
  } catch (e) { console.error("heygen token exception:", e); res.status(500).json({ error: "heygen_token_error" }); }
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor listo en puerto ${PORT}`));
