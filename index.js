const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");
const path = require("path");
const fs = require("fs/promises");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// ---- Salud / ping ----
app.get("/", (_req, res) => {
  res.status(200).send("OK - jesus-backend up");
});

// ---- OpenAI ----
if (!process.env.OPENAI_API_KEY) {
  console.warn("[WARN] Falta OPENAI_API_KEY: las rutas /api/* que llaman a OpenAI fallarán hasta que la definas.");
}
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ===== Idiomas soportados =====
const SUPPORTED = ["es", "en", "pt", "it", "de", "ca", "fr"];
const FALLBACK_LANG = "es";
const BIBLE_PREF = {
  es: "RVR1960",
  en: "NIV",
  pt: "ARA",
  it: "CEI",
  de: "Luther",
  ca: "Bíblia Catalana Interconfessional",
  fr: "Louis Segond",
};
const safeLang = (lang) =>
  SUPPORTED.includes(String(lang || "").toLowerCase())
    ? String(lang).toLowerCase()
    : FALLBACK_LANG;

// ====== Memoria por usuario (persistente + 7 días) ======
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
async function ensureDataDir() {
  try { await fs.mkdir(DATA_DIR, { recursive: true }); } catch {}
}
const memPath = (uid) =>
  path.join(DATA_DIR, `mem_${String(uid || "anon").replace(/[^a-z0-9_-]/gi, "_")}.json`);
const nowTs = () => Date.now();
const daysAgo = (n) => nowTs() - n * 24 * 60 * 60 * 1000;

async function readUserMemory(userId) {
  await ensureDataDir();
  try {
    const raw = await fs.readFile(memPath(userId), "utf8");
    const parsed = JSON.parse(raw);
    const cutoff = daysAgo(7);
    parsed.log = Array.isArray(parsed.log)
      ? parsed.log.filter((e) => (e.ts || 0) >= cutoff)
      : [];
    return parsed;
  } catch {
    return {
      last_bible_ref: "",
      last_bible_refs: [],
      last_questions: [],
      frame: null,
      last_welcome_questions: [],
      topics: [],
      log: [],
    };
  }
}
async function writeUserMemory(userId, mem) {
  await ensureDataDir();
  await fs.writeFile(memPath(userId), JSON.stringify(mem, null, 2), "utf8");
}
async function appendLog(userId, role, text) {
  const mem = await readUserMemory(userId);
  mem.log = Array.isArray(mem.log) ? mem.log : [];
  mem.log.push({ ts: nowTs(), role, text: String(text || "") });
  if (mem.log.length > 200) mem.log = mem.log.slice(-200);
  await writeUserMemory(userId, mem);
  return mem;
}

// ===== Utilidades =====
function cleanRef(ref = "") {
  return String(ref).replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
}
function stripQuestionsFromMessage(s = "") {
  const noTrailingQLines = (s || "")
    .split(/\n+/).map((l) => l.trim()).filter((l) => !/\?\s*$/.test(l)).join("\n").trim();
  return noTrailingQLines.replace(/[¿?]+/g, "").trim();
}
function limitWords(s = "", max = 80) {
  const words = String(s || "").trim().split(/\s+/);
  return words.length <= max ? String(s || "").trim() : words.slice(0, max).join(" ").trim();
}
function normalizeQuestion(q = "") { return String(q).toLowerCase().replace(/\s+/g, " ").trim(); }
function compactHistory(history = [], keep = 8, maxLen = 260) {
  const arr = Array.isArray(history) ? history : [];
  return arr.slice(-keep).map((x) => String(x).slice(0, maxLen));
}
function extractRecentAssistantQuestions(history = [], maxMsgs = 5) {
  const rev = [...(history || [])].reverse();
  const qs = []; let seen = 0;
  for (const h of rev) {
    if (!/^Asistente:/i.test(h) && !/^Assistant:/i.test(h)) continue;
    const text = h.replace(/^Asistente:\s*/i, "").replace(/^Assistant:\s*/i, "").trim();
    const m = text.match(/([^?]*\?)\s*$/m);
    if (m && m[1]) qs.push(normalizeQuestion(m[1]));
    seen++; if (seen >= maxMsgs) break;
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

// ===== Detección de tema/sujeto =====
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
  let core = low; let label = raw;
  const m = low.match(art);
  if (m) { core = m[2].trim(); label = raw; }
  const first = core.split(/\s+/)[0].replace(/[.,;:!?"'()]/g, "");
  if (!first) return null;
  if (!SUPPORT_WORDS.includes(first)) return null;
  return { label };
}

// ===== Crisis / seguridad =====
function isCrisis(text = "") {
  const t = (text || "").toLowerCase();
  return /(suicid|quitarme la vida|me quiero morir|autolesi[oó]n|self[- ]harm|kill myself)/.test(t);
}
function crisisMessage(lang = "es") {
  const L = safeLang(lang);
  const msg = {
    es: "Siento que estás pasando por un momento muy duro. Tu vida es valiosa. Si estás en peligro inmediato, llama a emergencias de tu país ahora. También puedes hablar con alguien de confianza o buscar ayuda profesional. Si quieres, puedo quedarme contigo aquí mientras das el siguiente paso.",
    en: "I'm really sorry you're going through this. Your life matters. If you're in immediate danger, call your local emergency number now. You can also reach out to someone you trust or a professional. I can stay with you here while you take the next step.",
    pt: "Sinto muito que você esteja passando por isso. Sua vida é valiosa. Se houver perigo imediato, ligue para a emergência do seu país agora. Procure alguém de confiança ou um profissional. Posso ficar aqui com você enquanto dá o próximo passo.",
    it: "Mi dispiace per ciò che stai vivendo. La tua vita è preziosa. Se sei in pericolo immediato, chiama subito i servizi di emergenza. Parla con qualcuno di fiducia o un professionista. Posso restare con te mentre fai il prossimo passo.",
    de: "Es tut mir leid, dass du das durchmachst. Dein Leben ist wertvoll. Bist du in akuter Gefahr, rufe bitte sofort den Notruf an. Sprich mit einer Vertrauensperson oder einer Fachkraft. Ich bleibe gern hier bei dir für den nächsten Schritt.",
    ca: "Em sap greu pel que estàs vivint. La teva vida és valuosa. Si ets en perill immediat, truca als serveis d’emergència ara. Parla amb algú de confiança o amb un professional. Puc quedar-me amb tu mentre fas el següent pas.",
    fr: "Je suis désolé pour ce que vous traversez. Votre vie compte. En cas de danger immédiat, appelez les urgences de votre pays. Parlez à quelqu’un de confiance ou à un professionnel. Je peux rester avec vous pendant la suite."
  };
  return msg[L] || msg.es;
}

// ===== OpenAI helpers =====
async function completionWithTimeout({ messages, temperature = 0.6, max_tokens = 300, timeoutMs = 12000, response_format }) {
  const call = openai.chat.completions.create({
    model: "gpt-4o",
    temperature,
    max_tokens,
    messages,
    ...(response_format ? { response_format } : {}),
  });
  return await Promise.race([
    call,
    new Promise((_, reject) => setTimeout(() => reject(new Error("TIMEOUT")), timeoutMs)),
  ]);
}

const responseFormatAsk = {
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
      required: ["message", "bible", "question"],
      additionalProperties: false
    }
  }
};

const responseFormatWelcome = {
  type: "json_schema",
  json_schema: {
    name: "WelcomeSchema",
    schema: {
      type: "object",
      properties: {
        message: { type: "string" },
        question: { type: "string" }
      },
      required: ["message", "question"],
      additionalProperties: false
    }
  }
};

// ====== SYSTEM PROMPTS ======
function buildSystemPromptAsk(lang = "es") {
  const bible = BIBLE_PREF[lang] || BIBLE_PREF[FALLBACK_LANG];
  if (lang === "es") {
    return `
Eres Jesús (voz serena, compasiva y clara). Responde SIEMPRE en español.

OBJETIVO
- Devuelve SOLO JSON: { "message", "bible": { "text", "ref" }, "question" }.
- "message": ≤80 palabras, tono afirmativo, sin signos de pregunta.
- "question": UNA, abierta y breve, que termine en "?" y NO repita preguntas recientes.
- No menciones técnica/IA ni el propio modelo.

CONTENIDO (obligatorio, en cada respuesta)
- Autoayuda: 1 micro-paso concreto y realista.
- Psicología: un marco breve (respiración, regulación emocional, reencuadre, afrontamiento).
- Espiritualidad: esperanza/compañía.
- Cita bíblica (${bible}) con "Libro 0:0" en "ref".
- Si hay crisis, prioriza contención y pedir ayuda inmediata.

MEMORIA/FOCO
- Mantén el foco del tema actual y de los últimos 7 días.
- Si el usuario venía con un tema, puedes preguntar por el progreso primero.
`.trim();
  }
  return `
You are Jesus (serene, compassionate, clear). Always answer in ${lang}.
Return ONLY JSON: { "message","bible":{"text","ref"},"question" }.
- message ≤80 words; question: one, ends with "?"; no tech talk.
- Self-help micro-step + brief psychology + spirituality + Bible (${bible}).
- Crisis: prioritize safety.
Focus: current topic & last 7 days; may check progress first.
`.trim();
}

function buildSystemPromptWelcome(lang = "es") {
  return (lang === "es")
    ? `
Eres Jesús: voz serena y cercana. Responde SIEMPRE en español.
Devuelve SOLO JSON: { "message", "question" }.
- "message": ≤60 palabras con saludo por hora y nombre si existe. SIN "?".
- "question": 1 abierta amable, termina en "?", no repitas preguntas recientes.
- Varía la formulación. Si hay tema reciente (7 días), sugiere retomarlo.
`.trim()
    : `
You are Jesus: serene and close. Always answer in ${lang}.
Return ONLY JSON: { "message", "question" }.
- message ≤60 words, daypart + name, no '?'.
- question: 1 open, ends with '?', vary phrasing; gently invite recent topic if any.
`.trim();
}

// ====== Saludo por hora ======
function greetingByHour(lang = "es", hour = null) {
  const h = (typeof hour === "number" && hour >= 0 && hour < 24) ? hour : new Date().getHours();
  const bucket = h < 12 ? "m1" : h < 19 ? "m2" : "m3";
  const map = {
    es: { m1: "Buenos días", m2: "Buenas tardes", m3: "Buenas noches" },
    en: { m1: "Good morning", m2: "Good afternoon", m3: "Good evening" },
    pt: { m1: "Bom dia", m2: "Boa tarde", m3: "Boa noite" },
    it: { m1: "Buongiorno", m2: "Buon pomeriggio", m3: "Buona sera" },
    de: { m1: "Guten Morgen", m2: "Guten Tag", m3: "Guten Abend" },
    ca: { m1: "Bon dia", m2: "Bona tarda", m3: "Bona nit" },
    fr: { m1: "Bonjour", m2: "Bon après-midi", m3: "Bonsoir" },
  };
  const L = safeLang(lang);
  return map[L][bucket];
}

// ===== Pista de tema reciente (7 días) =====
function recentTopicHint(mem) {
  const cutoff = daysAgo(7);
  const recent = Array.isArray(mem.topics) ? mem.topics.filter(t => (t.ts || 0) >= cutoff) : [];
  if (!recent.length) return null;
  const last = recent[recent.length - 1];
  return { topic: last.topic, summary: limitWords(last.summary, 20) };
}

// ====== /api/welcome ======
async function welcomeLLM({ lang = "es", name = "", userId = "anon", history = [], hour = null }) {
  lang = safeLang(lang);
  const mem = await readUserMemory(userId);
  const recent = compactHistory(history, 6, 200);
  const bannedWelcome = Array.isArray(mem.last_welcome_questions) ? mem.last_welcome_questions.slice(-6) : [];
  const daypart = greetingByHour(lang, hour);
  const hint = recentTopicHint(mem);

  const userContent = (lang === "es")
    ? [
        `lang: ${lang}`,
        `saludo_frase: ${daypart}`,
        `nombre: ${String(name || "").trim() || "(n/a)"}`,
        `banned_welcome_questions: ${bannedWelcome.join(" | ") || "(ninguna)"}`,
        hint ? `tema_reciente: ${hint.topic} — ${limitWords(hint.summary, 20)}` : "tema_reciente: (ninguno)",
        recent.length ? `historial_breve: ${recent.join(" | ")}` : "historial_breve: (sin antecedentes)"
      ].join("\n")
    : [
        `lang: ${lang}`,
        `greeting_phrase: ${daypart}`,
        `name: ${String(name || "").trim() || "(n/a)"}`,
        `banned_welcome_questions: ${bannedWelcome.join(" | ") || "(none)"}`,
        hint ? `recent_topic: ${hint.topic} — ${limitWords(hint.summary, 20)}` : "recent_topic: (none)",
        recent.length ? `short_history: ${recent.join(" | ")}` : "short_history: (none)"
      ].join("\n");

  const resp = await completionWithTimeout({
    messages: [{ role: "system", content: buildSystemPromptWelcome(lang) }, { role: "user", content: userContent }],
    temperature: 0.75, max_tokens: 180, timeoutMs: 12000, response_format: responseFormatWelcome
  });

  const content = resp?.choices?.[0]?.message?.content || "{}";
  let data = {};
  try { data = JSON.parse(content); } catch { data = {}; }

  let message = String(data?.message || "").trim();
  let question = String(data?.question || "").trim();

  message = stripQuestionsFromMessage(limitWords(message, 60));
  if (!/\?\s*$/.test(question)) question = question ? (question + "?") : "";

  const normalizedQ = normalizeQuestion(question);
  const already = (bannedWelcome || []).map(normalizeQuestion);
  if (!question || already.includes(normalizedQ)) {
    const moreBanned = Array.from(new Set([...(already || []), normalizedQ].filter(Boolean))).slice(-10);
    const regenUserContent = userContent.replace(/banned_welcome_questions:.*$/m, `banned_welcome_questions: ${moreBanned.join(" | ") || "(none)"}`);
    const r2 = await completionWithTimeout({
      messages: [{ role: "system", content: buildSystemPromptWelcome(lang) }, { role: "user", content: regenUserContent }],
      temperature: 0.8, max_tokens: 180, timeoutMs: 12000, response_format: responseFormatWelcome
    });
    const c2 = r2?.choices?.[0]?.message?.content || "{}";
    let d2 = {}; try { d2 = JSON.parse(c2); } catch { d2 = {}; }
    message = stripQuestionsFromMessage(limitWords(String(d2?.message || message || ""), 60));
    const q2 = String(d2?.question || "").trim();
    question = /\?\s*$/.test(q2) ? q2 : (q2 ? q2 + "?" : question);
  }

  const mem2 = await readUserMemory(userId);
  if (question) {
    mem2.last_welcome_questions = Array.from(new Set([...(mem2.last_welcome_questions || []), normalizeQuestion(question)])).slice(-12);
    await writeUserMemory(userId, mem2);
  }

  if (!message) {
    const base = (lang === "es")
      ? `${daypart}${name ? `, ${name}` : ""}. Bienvenido/a. Estoy aquí para escucharte con calma.`
      : `${daypart}${name ? `, ${name}` : ""}. Welcome. I am here to listen with calm.`;
    message = limitWords(stripQuestionsFromMessage(base), 60);
  }
  if (!question) {
    question = (lang === "es") ? "¿Qué te gustaría compartir ahora mismo?" : "What would you like to share right now?";
  }

  return { message, question };
}

// ====== /api/ask ======
async function regenerateBibleAvoiding({ lang, persona, message, frame, bannedRefs = [], lastRef = "" }) {
  const bible = BIBLE_PREF[lang] || BIBLE_PREF[FALLBACK_LANG];
  const sys = `Devuelve SOLO JSON con {"bible":{"text":"…","ref":"Libro 0:0"}} en ${lang} usando ${bible}.
- Ajusta la cita al tema y micro-pasos.
- Evita ambigüedad “hijo” (familiar) vs “el Hijo” (Cristo) salvo pertinencia teológica explícita.
- No uses ninguna referencia de "banned_refs" ni "last_bible_ref".`;

  const usr =
    `Persona: ${persona}\n` +
    `Mensaje_actual: ${message}\n` +
    `FRAME: ${JSON.stringify(frame)}\n` +
    `last_bible_ref: ${lastRef || "(n/a)"}\n` +
    `banned_refs:\n- ${bannedRefs.join("\n- ") || "(none)"}\n`;

  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.4,
    max_tokens: 120,
    messages: [{ role: "system", content: sys }, { role: "user", content: usr }],
    response_format: {
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
    }
  });

  const content = r?.choices?.[0]?.message?.content || "{}";
  let data = {};
  try { data = JSON.parse(content); } catch { data = {}; }
  const text = (data?.bible?.text || "").toString().trim();
  const ref = cleanRef((data?.bible?.ref || "").toString());
  return text && ref ? { text, ref } : null;
}

async function askLLM({ lang = "es", persona, message, history = [], userId = "anon" }) {
  lang = safeLang(lang);

  if (isCrisis(message)) {
    return {
      message: crisisMessage(lang),
      bible: {
        text: "Jehová es mi luz y mi salvación; ¿de quién temeré?",
        ref: lang === "es" ? "Salmos 27:1" : (lang === "pt" ? "Salmos 27:1" : (lang === "fr" ? "Psaume 27:1" : "Psalm 27:1"))
      },
      question: (lang === "es") ? "¿Puedes decirme dónde estás y si hay alguien contigo ahora?" :
                (lang === "pt") ? "Você pode me dizer onde está e se há alguém com você agora?" :
                (lang === "fr") ? "Pouvez-vous me dire où vous êtes et s’il y a quelqu’un avec vous maintenant?" :
                "Can you tell me where you are and if someone is with you now?"
    };
  }

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

  const lastRefFromHistory = extractRecentBibleRefs(history, 1)[0] || "";
  const lastRef = mem.last_bible_ref || lastRefFromHistory || "";
  const recentRefs = extractRecentBibleRefs(history, 3);
  const bannedRefs = Array.from(new Set([...(mem.last_bible_refs || []), lastRef, ...recentRefs].filter(Boolean))).slice(-5);
  const recentQs = extractRecentAssistantQuestions(history, 5);
  const shortHistory = compactHistory(history, 10, 240);
  const hint = recentTopicHint(mem);

  const header =
    (lang === "es"
      ? `Persona: ${persona}\nMensaje_actual: ${message}\nFRAME: ${JSON.stringify(frame)}\nlast_bible_ref: ${lastRef || "(n/a)"}\nbanned_refs:\n- ${bannedRefs.join("\n- ") || "(none)"}\n` +
        (recentQs.length ? `ultimas_preguntas: ${recentQs.join(" | ")}` : "ultimas_preguntas: (ninguna)") + "\n" +
        (shortHistory.length ? `Historial: ${shortHistory.join(" | ")}` : "Historial: (sin antecedentes)") + "\n" +
        (hint ? `tema_reciente: ${hint.topic} — ${limitWords(hint.summary, 25)}` : "tema_reciente: (ninguno)") + "\n"
      : `Persona: ${persona}\nCurrent_message: ${message}\nFRAME: ${JSON.stringify(frame)}\nlast_bible_ref: ${lastRef || "(n/a)"}\nbanned_refs:\n- ${bannedRefs.join("\n- ") || "(none)"}\n` +
        (recentQs.length ? `recent_questions: ${recentQs.join(" | ")}` : "recent_questions: (none)") + "\n" +
        (shortHistory.length ? `History: ${shortHistory.join(" | ")}` : "History: (none)") + "\n" +
        (hint ? `recent_topic: ${hint.topic} — ${limitWords(hint.summary, 25)}` : "recent_topic: (none)") + "\n"
    );

  const resp = await completionWithTimeout({
    messages: [{ role: "system", content: buildSystemPromptAsk(lang) }, { role: "user", content: header }],
    temperature: 0.6, max_tokens: 320, timeoutMs: 12000, response_format: responseFormatAsk
  });

  const content = resp?.choices?.[0]?.message?.content || "{}";
  let data = {};
  try { data = JSON.parse(content); } catch { data = { message: content }; }

  let msg = stripQuestionsFromMessage(limitWords(String(data?.message || ""), 80));
  let ref = cleanRef(String(data?.bible?.ref || ""));
  let text = String(data?.bible?.text || "").trim();

  const hijoOnly = /\bhijo\b/i.test(message) && !/(Jes[uú]s|Cristo)/i.test(message);
  if (!ref || bannedRefs.includes(ref) || (hijoOnly && /Juan\s*8:36/i.test(ref))) {
    const alt = await regenerateBibleAvoiding({ lang, persona, message, frame, bannedRefs, lastRef });
    if (alt) { ref = alt.ref; text = alt.text; }
  }

  let question = String(data?.question || "").trim();
  const normalizedQ = normalizeQuestion(question);
  const isRepeat = !question ? false : recentQs.includes(normalizedQ);
  if (!/\?\s*$/.test(question) || isRepeat) {
    question = (lang === "es") ? "¿Qué detalle te gustaría explorar un poco más?" :
               (lang === "pt") ? "O que você gostaria de explorar um pouco mais?" :
               (lang === "it") ? "Quale dettaglio vorresti approfondire un po' di più?" :
               (lang === "de") ? "Welchen Aspekt möchtest du noch etwas vertiefen?" :
               (lang === "ca") ? "Quin detall t’agradaria explorar una mica més?" :
               (lang === "fr") ? "Quel détail souhaitez-vous explorer un peu plus ?" :
               "What detail would you like to explore a bit more?";
  }

  mem.last_bible_ref = ref || mem.last_bible_ref || "";
  mem.last_bible_refs = Array.from(new Set([...(mem.last_bible_refs || []), ref].filter(Boolean))).slice(-5);
  if (question) {
    mem.last_questions = Array.from(new Set([...(mem.last_questions || []), normalizeQuestion(question)])).slice(-6);
  }
  const t = topic;
  if (t && /general/.test(t) === false) {
    mem.topics = Array.isArray(mem.topics) ? mem.topics : [];
    mem.topics.push({ ts: nowTs(), topic: t, summary: limitWords(message, 25) });
    if (mem.topics.length > 50) mem.topics = mem.topics.slice(-50);
  }
  await writeUserMemory(userId, mem);

  return {
    message: msg || ((lang === "es") ? "Estoy contigo. Demos un paso pequeño y realista hoy." : "I am with you. Let’s take a small, realistic step today."),
    bible: { text: text || "Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu.", ref: ref || (lang === "es" ? "Salmos 34:18" : "Psalm 34:18") },
    question
  };
}

// ===================== RUTAS =====================

app.post("/api/welcome", async (req, res) => {
  try {
    const { lang = "es", name = "", userId = "anon", history = [], hour = null } = req.body || {};
    const data = await welcomeLLM({ lang, name, userId, history, hour });
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(200).json(data);
    if (userId) await appendLog(userId, "assistant", `${data.message}\n${data.question}`);
  } catch (e) {
    console.error("WELCOME ERROR:", e);
    const L = safeLang(req.body?.lang || "es");
    const greet = greetingByHour(L);
    const name = (req.body?.name || "").trim();
    const message = (L === "es")
      ? `${greet}${name ? `, ${name}` : ""}. Estoy aquí para escucharte.`
      : `${greet}${name ? `, ${name}` : ""}. I am here to listen.`;
    const question = (L === "es") ? "¿Qué te gustaría compartir ahora mismo?" : "What would you like to share right now?";
    res.status(200).json({ message, question });
  }
});

app.get("/api/welcome", async (req, res) => {
  try {
    const lang = safeLang(req.query?.lang || "es");
    const name = String(req.query?.name || "").trim();
    const data = await welcomeLLM({ lang, name });
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(200).json(data);
  } catch (e) {
    console.error("WELCOME GET ERROR:", e);
    const L = safeLang(req.query?.lang || "es");
    const greet = greetingByHour(L);
    const name = (req.query?.name || "").trim();
    const message = (L === "es")
      ? `${greet}${name ? `, ${name}` : ""}. Estoy aquí para escucharte.`
      : `${greet}${name ? `, ${name}` : ""}. I am here to listen.`;
    const question = (L === "es") ? "¿Qué te gustaría compartir ahora mismo?" : "What would you like to share right now?";
    res.status(200).json({ message, question });
  }
});

app.post("/api/ask", async (req, res) => {
  try {
    const { persona = "jesus", message = "", history = [], userId = "anon", lang = "es" } = req.body || {};
    if (userId && message) await appendLog(userId, "user", message);

    const data = await askLLM({ lang: safeLang(lang), persona, message, history, userId });
    const out = {
      message: (data?.message || "").toString().trim(),
      bible: { text: (data?.bible?.text || "").toString().trim(), ref: (data?.bible?.ref || "").toString().trim() },
      question: (data?.question || "").toString().trim()
    };

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(200).json(out);

    if (userId) await appendLog(userId, "assistant", `${out.message}\n${out.bible.text} — ${out.bible.ref}\n${out.question}`);
  } catch (err) {
    console.error("ASK ERROR:", err);
    res.status(200).json({
      message: "La paz sea contigo. Compárteme en pocas palabras lo esencial, y seguimos paso a paso.",
      bible: { text: "Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu.", ref: "Salmos 34:18" },
      question: "¿Cuál sería un primer paso pequeño que te verías capaz de intentar hoy?"
    });
  }
});

// HeyGen: token (Node 22 tiene fetch global)
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

// Arranque
const PORT = process.env.PORT || 8080;
const HOST = "0.0.0.0";
app.listen(PORT, HOST, () => {
  console.log(`Servidor listo en ${HOST}:${PORT}`);
});
