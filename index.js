// index.js — Backend conversación (OpenAI) con lógica clínica/espiritual mejorada
// - /api/welcome: saludo por hora + nombre + frase motivacional + 1 sola pregunta abierta
// - /api/ask: explorar → permiso → ejecutar (guion + plan 24h) con técnicas específicas y anti-repetición
// - Guardarraíles de foco temático (cristianismo/autoayuda/psico personal). Desvía temas fuera de alcance.
// - Memoria en FS para evitar repeticiones de preguntas/versículos/estilos y llevar el hilo.
// - HeyGen token/config + CORS abierto.
//
// ENV: OPENAI_API_KEY, DATA_DIR (opcional), HEYGEN_* (opcional)

const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const OpenAI = require("openai");
const path = require("path");
const fs = require("fs/promises");
require("dotenv").config();

const app = express();
app.use(
  cors({
    origin: true,
    credentials: false,
  })
);
app.use(bodyParser.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// -------------------- Utils --------------------
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
function removeBibleLike(text = "") {
  let s = String(text || "");
  s = s.replace(/^[\s]*[—-]\s*.*?\([^)]+?\d+\s*:\s*\d+\)[\s]*$/gim, "").trim();
  s = s.replace(/\(([^)]+?\d+\s*:\s*\d+)\)/g, () => "");
  s = s.replace(/\s*[—-]\s*[^()]*\(\s*[^)]+?\d+\s*:\s*\d+\s*\)\s*$/g, "").trim();
  return s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
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

// Hora local del cliente
function resolveClientHour({ hour = null, client_iso = null, tz = null } = {}) {
  if (Number.isInteger(hour) && hour >= 0 && hour < 24) return hour;
  if (client_iso) {
    const d = new Date(client_iso);
    if (!isNaN(d.getTime())) return d.getHours();
  }
  if (tz) {
    try {
      const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false });
      const parts = fmt.formatToParts(new Date());
      const h = parseInt(parts.find((p) => p.type === "hour")?.value || "0", 10);
      if (!isNaN(h)) return h;
    } catch {}
  }
  return new Date().getHours();
}
function greetingByHour(lang = "es", opts = {}) {
  const h = resolveClientHour(opts);
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

// Recencia
function detectRecency(s = "") {
  const x = NORM(s);
  const today =
    /\b(hoy|reci[eé]n|ahora|hace un rato|esta (mañana|tarde|noche))\b/.test(x) ||
    /\b(today|just now|right now|earlier today|this (morning|afternoon|evening))\b/.test(x) ||
    /\b(hoje|agora|agorinha|mais cedo hoje|esta (manhã|tarde|noite))\b/.test(x) ||
    /\b(oggi|adesso|poco fa|questa (mattina|pomeriggio|sera))\b/.test(x) ||
    /\b(heute|gerade eben|soeben|heute (Morgen|Nachmittag|Abend))\b/.test(x) ||
    /\b(avui|ara|fa una estona|aquest (matí|tarda|vespre))\b/.test(x) ||
    /\b(aujourd'hui|à l'instant|tout à l'heure|ce (matin|après-midi|soir))\b/.test(x);
  if (today) return "today";
  const yesterday =
    /\b(ayer)\b/.test(x) ||
    /\b(yesterday)\b/.test(x) ||
    /\b(ontem)\b/.test(x) ||
    /\b(ieri)\b/.test(x) ||
    /\b(gestern)\b/.test(x) ||
    /\b(ahir)\b/.test(x) ||
    /\b(hier)\b/.test(x);
  if (yesterday) return "yesterday";
  const hours =
    /\bhace\s+\d+\s*(h|horas?)\b/.test(x) ||
    /\b\d+\s*(hours?|hrs?)\s*ago\b/.test(x) ||
    /\bh[aá]\s*\d+\s*(h|horas?)\b/.test(x);
  if (hours) return "hours";
  return "generic";
}
function fixTemporalQuestion(q = "", recency = "generic", lang = "es") {
  if (!q) return q;
  const weeksLike = /(últimas?|ders? derni[eè]res?|letzte[nr]?|ultime|darreres?)\s+(semanas|weeks|wochen|semaines|setmanes)/i;
  const daysLike = /(últimos?|ders?|derni[eè]rs?|letzten?|ultimi|darrers?)\s+(d[ií]as|days|tage|jours|dias|dies)/i;
  if (recency === "today" || recency === "hours" || recency === "yesterday") {
    if (weeksLike.test(q) || daysLike.test(q)) {
      const repl = lang === "en" ? "since today" : "desde hoy";
      return q.replace(weeksLike, repl).replace(daysLike, repl);
    }
  }
  return q;
}

// Post-filtro: 1 sola pregunta (sin A/B ni dobles)
function sanitizeSingleQuestion(q = "", lang = "es", recency = "generic") {
  if (!q) return q;
  let s = String(q).trim();
  const firstQ = s.split("?")[0] ?? s;
  s = firstQ + "?";
  const ab = /\b(o|ou|or|oder|o bien|ou bien)\b/i;
  if (ab.test(s)) {
    s = s.split(ab)[0].trim();
    if (!/\?\s*$/.test(s)) s += "?";
  }
  const joiners = /(y|and|et|und|e|i)\s+(c[óo]mo|how|comment|wie|come|com)\b/i;
  if (joiners.test(s)) {
    s = s.split(joiners)[0].trim();
    if (!/\?\s*$/.test(s)) s += "?";
  }
  // Bloquear preguntas genéricas o “divide el problema”
  const BAD_GENERIC_Q =
    /(qué te aliviaría|que te aliviar[ií]a|qué pequeño paso|qué vas a|qué harás|qué plan|divide el problema|qué parte espec[ií]fica|qué parte de la situaci[oó]n)/i;
  if (BAD_GENERIC_Q.test(s)) {
    s =
      lang === "en"
        ? "What happened that you want help with right now?"
        : lang === "pt"
        ? "O que aconteceu e com o que você precisa de ajuda agora?"
        : lang === "it"
        ? "Che cosa è successo e con cosa vuoi aiuto adesso?"
        : lang === "de"
        ? "Was ist passiert, wobei brauchst du jetzt Hilfe?"
        : lang === "ca"
        ? "Què ha passat i amb què necessites ajuda ara?"
        : lang === "fr"
        ? "Que s’est-il passé et de quoi as-tu besoin maintenant ?"
        : "¿Qué pasó y con qué necesitas ayuda ahora mismo?";
  }
  s = fixTemporalQuestion(s, recency, lang);
  if (!/\?\s*$/.test(s)) s += "?";
  return s;
}

// Memoria FS
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
    const mem = JSON.parse(raw);
    mem.last_bible_refs = Array.isArray(mem.last_bible_refs) ? mem.last_bible_refs : [];
    mem.last_questions = Array.isArray(mem.last_questions) ? mem.last_questions : [];
    mem.last_techniques = Array.isArray(mem.last_techniques) ? mem.last_techniques : [];
    mem.last_q_styles = Array.isArray(mem.last_q_styles) ? mem.last_q_styles : [];
    return mem;
  } catch {
    return {
      last_bible_refs: [],
      last_questions: [],
      last_techniques: [],
      last_q_styles: [],
      frame: null,
      last_offer_kind: null, // 'guion' | 'plan24h' | null
      last_user_reply: null,
      pending_action: null,
      last_topic: null,
    };
  }
}
async function writeUserMemory(userId, mem) {
  await ensureDataDir();
  await fs.writeFile(memPath(userId), JSON.stringify(mem, null, 2), "utf8");
}

// Heurísticas
function guessTopic(s = "") {
  const t = (s || "").toLowerCase();
  if (/(droga|adicci|alcohol|apuestas)/.test(t)) return "addiction";
  if (/(me separ|separaci[oó]n|divorcio|ruptura)/.test(t)) return "separation";
  if (/(pareja|matrimonio|conyug|novi[oa])/i.test(t)) return "relationship";
  if (/(duelo|falleci[oó]|perd[ií]|luto)/.test(t)) return "grief";
  if (/(ansied|p[áa]nico|depres|triste|miedo|temor|estr[eé]s|enojo|bronca|ira|rabia|furia)/.test(t)) return "mood";
  if (/(trabajo|despido|salario|dinero|deuda|finanzas)/.test(t)) return "work_finance";
  if (/(salud|diagn[oó]stico|enfermedad|dolor)/.test(t)) return "health";
  if (/(familia|conflicto|discusi[oó]n|suegr)/.test(t)) return "family_conflict";
  if (/(fe|duda|dios|oraci[oó]n|culpa|pecado)/.test(t)) return "faith";
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
function detectAffirmation(s = "") {
  const x = NORM(s);
  const pats = [
    /\bsi\b|\bsí\b|\bclaro\b|\bde acuerdo\b|\bok\b|\bvale\b|\bperfecto\b/,
    /\byes\b|\byep\b|\byup\b|\bsure\b|\bok\b|\bokay\b/,
    /\bsim\b|\bclaro\b|\bok\b/,
    /\bsì\b|\bcerto\b|\bva bene\b/,
    /\bja\b|\bjawohl\b|\bok\b/,
    /\boui\b|\bd’accord\b|\bok\b/,
  ];
  return pats.some((r) => r.test(x));
}
function detectNegation(s = "") {
  const x = NORM(s);
  const pats = [
    /\bno\b|\bmejor no\b|\bno gracias\b/,
    /\bnope\b|\bnah\b|\bno thanks\b/,
    /\bnão\b|\bnão obrigado\b|\bnão obrigada\b/,
    /\bnon\b|\bno grazie\b/,
    /\bnein\b|\bkein\b/,
    /\bnon\b|\bpas\b/,
  ];
  return pats.some((r) => r.test(x));
}
function detectByeThanks(s = "") {
  const x = NORM(s);
  const pats = [
    /\bgracias\b|\bmuchas gracias\b|\bmil gracias\b|\bme tengo que ir\b|\bme voy\b|\bhasta luego\b|\badiós\b/,
    /\bthanks\b|\bthank you\b|\bi have to go\b|\bgotta go\b|\bbye\b|\bsee you\b/,
    /\bobrigado\b|\bobrigada\b|\bvaleu\b|\btenho que ir\b|\btchau\b|\bate logo\b/,
    /\bgrazie\b|\bdevo andare\b|\bciao\b|\ba dopo\b/,
    /\bdanke\b|\bmuss gehen\b|\btschüss\b/,
    /\bmerci\b|\bje dois partir\b|\bau revoir\b/,
  ];
  return pats.some((r) => r.test(x));
}
function detectVague(s = "") {
  const x = NORM(s);
  if (!x) return true;
  if (x.length < 2) return true;
  if (/\b(hola|hola\.?|buen[oa]s)\b/.test(x)) return true;
  if (
    /\btengo un problema\b|\bproblema\b|\bnecesito ayuda\b|\bno sé por dónde empezar\b|\bno se por donde empezar\b|\bestoy mal\b/i.test(
      x
    )
  )
    return true;
  return false;
}
function detectRequestExecute(s = "") {
  const x = NORM(s);
  return /\bdime qu[eé] hacer\b|\bdecime qu[eé] hacer\b|\bquiero pasos\b|\bquiero que me digas\b|\bayudame a\b|\bayúdame a\b|\bquiero que me gu[ií]es\b|\barmar un guion\b|\bgu[ií]ame\b/i.test(
    x
  );
}
function detectEmotions(s = "") {
  const x = NORM(s);
  const emos = [];
  if (/(bronca|enojo|ira|rabia|furia)/.test(x)) emos.push("anger");
  if (/(angustia|ansiedad|p[áa]nico)/.test(x)) emos.push("anxiety");
  if (/(desilusi[oó]n|triste|depres)/.test(x)) emos.push("sadness");
  return emos;
}

// Guardarraíles de alcance
function isReligiousPlaceQuery(x) {
  return /(iglesia|templo|parroquia|misa|vaticano|santuario|convento|monasterio|oraci[oó]n|catedral|bas[ií]lica)/.test(x);
}
function isOutOfScope(message = "") {
  const x = NORM(message);
  // excepciones religiosas
  if (isReligiousPlaceQuery(x)) return false;

  const banned =
    /(f[uú]tbol|deporte|resultado|liga|champions|tenis|basket|boxeo|espect[aá]culo|celebridad|m[uú]sica|pel[ií]cula|serie|novela|actor|cantante|concierto|premios?)/i.test(
      x
    ) ||
    /(turismo|pa[ií]s|capital|geograf[ií]a|mapa|d[oó]nde queda|donde queda|c[oó]mo llegar|cómo llegar)/i.test(x) ||
    /(mec[aá]nica|alternador|motor|caja de cambios|embrague|par|neum[aá]tico|aceite)/i.test(x) ||
    /(t[eé]cnica|inform[aá]tica|programaci[oó]n|c[oó]digo|bug|algoritmo|api|base de datos)/i.test(x) ||
    /(matem[aá]tica|c[aá]lculo|ecuaci[oó]n|integral|derivada)/i.test(x) ||
    /(juegos?|gamer|consola|ps5|xbox|nintendo|minecraft|roblox)/i.test(x) ||
    /(electr[oó]nica|arduino|raspberry|sensor|m[ií]crocontrolador)/i.test(x);
  return banned;
}

// Citas vetadas (Mateo 11:28 en todos los idiomas)
function isRefMat11_28(ref = "") {
  const x = NORM(ref);
  if (!x) return false;
  const pats = [
    /mateo\s*11\s*:\s*28/,
    /mt\.?\s*11\s*:\s*28/,
    /mat\.?\s*11\s*:\s*28/,
    /san\s+mateo\s*11\s*:\s*28/,
    /matthew?\s*11\s*:\s*28/,
    /matteo\s*11\s*:\s*28/,
    /matthäus\s*11\s*:\s*28/,
    /matthieu\s*11\s*:\s*28/,
    /mateu\s*11\s*:\s*28/,
    /mateus\s*11\s*:\s*28/,
  ];
  return pats.some((r) => r.test(x));
}
const BANNED_REFS = [
  "Mateo 11:28",
  "Mt 11:28",
  "Mat 11:28",
  "Matthew 11:28",
  "Matteo 11:28",
  "Matthäus 11:28",
  "Matthieu 11:28",
  "Mateu 11:28",
  "Mateus 11:28",
];

// OpenAI formats
const FORMAT_WELCOME = {
  type: "json_schema",
  json_schema: {
    name: "WelcomeSchema",
    schema: {
      type: "object",
      properties: { message: { type: "string" }, question: { type: "string" } },
      required: ["message", "question"],
      additionalProperties: false,
    },
  },
};
const FORMAT_ASK = {
  type: "json_schema",
  json_schema: {
    name: "SpiritualGuidance",
    schema: {
      type: "object",
      properties: {
        message: { type: "string" },
        bible: { type: "object", properties: { text: { type: "string" }, ref: { type: "string" } }, required: ["text", "ref"] },
        question: { type: "string" },
        techniques: { type: "array", items: { type: "string" } },
        q_style: { type: "string" },
        offer_kind: { type: "string" }, // "guion" | "plan24h" | "permiso" | null
      },
      required: ["message", "bible", "q_style"],
      additionalProperties: false,
    },
  },
};
const FORMAT_BIBLE_ONLY = {
  type: "json_schema",
  json_schema: {
    name: "BibleOnly",
    schema: {
      type: "object",
      properties: { bible: { type: "object", properties: { text: { type: "string" }, ref: { type: "string" } }, required: ["text", "ref"] } },
      required: ["bible"],
      additionalProperties: false,
    },
  },
};

async function completionJson({ messages, temperature = 0.6, max_tokens = 260, timeoutMs = 12000, response_format }) {
  const call = openai.chat.completions.create({
    model: "gpt-4o",
    temperature,
    max_tokens,
    messages,
    response_format: response_format || FORMAT_ASK,
  });
  return await Promise.race([call, new Promise((_, rej) => setTimeout(() => rej(new Error("TIMEOUT")), timeoutMs))]);
}

// -------------------- Health --------------------
app.get("/", (_req, res) => res.json({ ok: true, service: "backend", ts: Date.now() }));
app.get("/api/welcome", (_req, res) => res.json({ ok: true, hint: "POST /api/welcome { lang, name, userId, history, hour?, client_iso?, tz? }" }));
app.post("/api/memory/sync", (_req, res) => res.json({ ok: true }));

// -------------------- /api/welcome --------------------
app.post("/api/welcome", async (req, res) => {
  try {
    const { lang = "es", name = "", userId = "anon", history = [], hour = null, client_iso = null, tz = null } = req.body || {};
    const nm = String(name || "").trim();

    const hi = greetingByHour(lang, { hour, client_iso, tz });
    const mem = await readUserMemory(userId);
    const avoidQs = Array.isArray(mem.last_questions) ? mem.last_questions.slice(-10) : [];
    const shortHistory = compactHistory(history, 6, 200);

    const SYSTEM_PROMPT = `
Eres cercano, sereno y compasivo. Varía el lenguaje, evita muletillas y positivismo forzado.

SALIDA SOLO JSON (en ${langLabel(lang)}):
- "message": ≤75 palabras. Incluye saludo por franja y **nombre si existe** (p.ej. "${hi}${nm ? `, ${nm}` : ""}"). 
  Da **una frase motivacional tipo tarjeta** (no versículo) + expresa **disponibilidad**. 
  **Sin preguntas** y **sin citas bíblicas** dentro de "message".
- "question": **UNA** pregunta **simple y directa** para que el usuario cuente **lo que trae hoy**. Debe **terminar en "?"**.
  Prohibido: A/B, doble pregunta con “y ...”, hobbies/planes/tiempo libre, fórmulas de plenitud.
  Evita repetir recientes: ${avoidQs.map((q) => `"${q}"`).join(", ") || "(ninguna)"}.
No menciones IA/modelos.
`;
    const header = `Lang: ${lang}
Nombre: ${nm || "(anónimo)"}
Saludo_sugerido: ${hi}${nm ? `, ${nm}` : ""}
Historial: ${shortHistory.length ? shortHistory.join(" | ") : "(sin antecedentes)"}
`;

    const r = await completionJson({
      messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: header }],
      temperature: 0.8,
      max_tokens: 260,
      response_format: FORMAT_WELCOME,
    });

    const content = r?.choices?.[0]?.message?.content || "{}";
    let data = {};
    try {
      data = JSON.parse(content);
    } catch {
      data = {};
    }
    let msg = limitWords(stripQuestionsFromMessage(removeBibleLike(String(data?.message || ""))), 75);
    let questionRaw = String(data?.question || "").trim();
    let question = sanitizeSingleQuestion(questionRaw, lang, "today");
    if (!question) {
      question =
        lang === "en"
          ? "What happened today that you’d like to talk about?"
          : lang === "pt"
          ? "O que aconteceu hoje que você gostaria de conversar?"
          : lang === "it"
          ? "Che cosa è successo oggi di cui vorresti parlare?"
          : lang === "de"
          ? "Was ist heute passiert, worüber du sprechen möchtest?"
          : lang === "ca"
          ? "Què ha passat avui que vulguis compartir?"
          : lang === "fr"
          ? "Qu’est-il arrivé aujourd’hui dont tu aimerais parler ?"
          : "¿Qué pasó hoy de lo que te gustaría hablar?";
    }

    if (question) {
      mem.last_questions = Array.isArray(mem.last_questions) ? mem.last_questions : [];
      mem.last_questions.push(question);
      while (mem.last_questions.length > 10) mem.last_questions.shift();
      await writeUserMemory(userId, mem);
    }

    res.status(200).json({
      message: msg || `${hi}${nm ? `, ${nm}` : ""}. Estoy aquí para escucharte con calma.`,
      bible: { text: "", ref: "" },
      question,
    });
  } catch (e) {
    console.error("WELCOME ERROR:", e);
    const hi = greetingByHour("es");
    const question = "¿Qué pasó hoy de lo que te gustaría hablar?";
    res.status(200).json({
      message: `${hi}. Estoy aquí para escucharte con calma.`,
      bible: { text: "", ref: "" },
      question,
    });
  }
});

// -------------------- /api/ask --------------------
async function regenerateBibleAvoiding({ lang, persona, message, frame, bannedRefs = [], lastRef = "" }) {
  const SYS = `
Devuelve SOLO JSON {"bible":{"text":"…","ref":"Libro 0:0"}} en ${langLabel(lang)}.
- Ajusta la cita al tema/contexto.
- Evita referencias recientes: ${bannedRefs.map((r) => `"${r}"`).join(", ") || "(ninguna)"} y la última: "${
    lastRef || "(n/a)"
  }".
- Evita Mateo/Matthew 11:28 (todas las variantes).
- No agregues nada fuera del JSON.`;
  const USR = `Persona: ${persona}
Mensaje_usuario: ${message}
FRAME: ${JSON.stringify(frame)}`;
  const r = await completionJson({
    messages: [{ role: "system", content: SYS }, { role: "user", content: USR }],
    temperature: 0.4,
    max_tokens: 120,
    response_format: FORMAT_BIBLE_ONLY,
  });
  const content = r?.choices?.[0]?.message?.content || "{}";
  let data = {};
  try {
    data = JSON.parse(content);
  } catch {
    data = {};
  }
  const text = (data?.bible?.text || "").toString().trim();
  const ref = cleanRef((data?.bible?.ref || "").toString());
  return text && ref ? { text, ref } : null;
}

app.post("/api/ask", async (req, res) => {
  try {
    const { persona = "jesus", message = "", history = [], userId = "anon", lang = "es" } = req.body || {};
    const userTxt = String(message || "").trim();

    // --- filtros de entrada ---
    const onlyLetters = /[\p{L}]{2,}/u.test(userTxt);
    if (!onlyLetters || userTxt.length < 2) {
      return res.status(200).json({
        message:
          lang === "en"
            ? "I didn’t catch that. Could you repeat it in a few words?"
            : "No te entendí bien, ¿podés repetirlo en pocas palabras?",
        bible: {
          text:
            lang === "en"
              ? "The Lord is near to all who call on him in truth."
              : "Cercano está Jehová a todos los que le invocan de veras.",
          ref: lang === "en" ? "Psalm 145:18" : "Salmos 145:18",
        },
      });
    }

    if (isOutOfScope(userTxt)) {
      return res.status(200).json({
        message:
          lang === "en"
            ? "I’m here for your spiritual life and personal wellbeing. I don’t provide results or technical data about that topic. If you want, we can focus on what you’re living, your values, and the next steps that would help you today."
            : "Estoy aquí para tu vida espiritual y tu bienestar personal. No doy resultados ni datos técnicos sobre ese tema. Si querés, nos enfocamos en lo que estás viviendo, tus valores y los pasos que te harían bien hoy.",
        bible: {
          text:
            lang === "en"
              ? "Come to me, all you who are weary and burdened, and I will give you rest."
              : "Venid a mí todos los que estáis trabajados y cargados, y yo os haré descansar.",
          ref: lang === "en" ? "Matthew 11:28" : "Mateo 11:28",
        },
        question:
          lang === "en"
            ? "What happened and what would you like help with today?"
            : "¿Qué pasó y con qué te gustaría ayuda hoy?",
      });
    }

    const mem = await readUserMemory(userId);

    // Señales de control de flujo
    const isBye = detectByeThanks(userTxt);
    const saidYes = detectAffirmation(userTxt);
    const saidNo = detectNegation(userTxt);

    // Marco
    const topic = guessTopic(userTxt);
    const mainSubject = detectMainSubject(userTxt);
    const recency = detectRecency(userTxt);
    const emotions = detectEmotions(userTxt);
    const frame = {
      topic_primary: topic,
      main_subject: mem.frame?.topic_primary === topic ? mem.frame?.main_subject || mainSubject : mainSubject,
      support_persons: mem.frame?.topic_primary === topic ? mem.frame?.support_persons || [] : [],
      recency_hint: recency,
      emotions,
      last_offer_kind: mem.last_offer_kind || null,
    };
    mem.frame = frame;
    mem.last_topic = topic;

    const avoidRefs = Array.isArray(mem.last_bible_refs) ? mem.last_bible_refs.slice(-8) : [];
    const avoidQs = Array.isArray(mem.last_questions) ? mem.last_questions.slice(-10) : [];
    const avoidTech = Array.isArray(mem.last_techniques) ? mem.last_techniques.slice(-6) : [];
    const avoidQStyles = Array.isArray(mem.last_q_styles) ? mem.last_q_styles.slice(-6) : [];
    const shortHistory = compactHistory(history, 10, 240);

    // MODO
    let MODE = "explore";
    if (isBye) MODE = "bye";
    else if (detectRequestExecute(userTxt) || saidYes || mem.last_offer_kind === "permiso") MODE = "execute";
    else if (!detectVague(userTxt) && topic !== "general") MODE = "permiso";
    if (saidNo && MODE !== "bye") MODE = "explore";

    // Mensajes de sistema
    const TOPIC_HINT = {
      relationship: { es: "tu pareja", en: "your partner", pt: "sua parceria", it: "il tuo partner", de: "deinem Partner", ca: "la teva parella", fr: "ton/ta partenaire" },
      separation: { es: "esta separación", en: "this separation", pt: "esta separação", it: "questa separazione", de: "diese Trennung", ca: "aquesta separació", fr: "cette séparation" },
      family_conflict: { es: "tu familia", en: "your family", pt: "sua família", it: "la tua famiglia", de: "deiner Familie", ca: "la teva família", fr: "ta famille" },
      mood: { es: "tus emociones", en: "your emotions", pt: "suas emoções", it: "le tue emozioni", de: "deine Gefühle", ca: "les teves emocions", fr: "tes émotions" },
      grief: { es: "tu duelo", en: "your grief", pt: "seu luto", it: "il tuo lutto", de: "deine Trauer", ca: "el teu dol", fr: "ton deuil" },
      health: { es: "tu salud", en: "your health", pt: "sua saúde", it: "la tua salute", de: "deine Gesundheit", ca: "la teva salut", fr: "ta santé" },
      work_finance: { es: "tu trabajo o finanzas", en: "your work or finances", pt: "seu trabalho ou finanças", it: "il tuo lavoro o finanze", de: "deine Arbeit oder Finanzen", ca: "la teva feina o finances", fr: "ton travail ou tes finances" },
      addiction: { es: "tu proceso de recuperación", en: "your recovery process", pt: "seu processo de recuperação", it: "il tuo percorso di recupero", de: "deinen Genesungsweg", ca: "el teu procés de recuperació", fr: "ton chemin de rétablissement" },
      faith: { es: "tu fe", en: "your faith", pt: "sua fé", it: "la tua fede", de: "deinen Glauben", ca: "la teva fe", fr: "ta foi" },
    }[topic]?.[lang] || null;

    // Preferencias de técnicas por emoción
    const EMO_TECH_HINT = [];
    if (emotions.includes("anger")) EMO_TECH_HINT.push("no_escalar", "time_out_24h", "opposite_action");
    if (emotions.includes("anxiety")) EMO_TECH_HINT.push("anclaje_54321", "breathing_exhale46", "hydrate");
    if (emotions.includes("sadness")) EMO_TECH_HINT.push("cognitive_reframe", "apoyo_red_social");

    const SYSTEM_PROMPT = `
Hablas con serenidad, claridad y compasión; lenguaje simple y **clínico**, sin metáforas largas.

MODO: ${MODE}; RECENCIA: ${recency}; EMOCIONES: ${emotions.join(", ") || "ninguna"}

SALIDA SOLO JSON (en ${langLabel(lang)}):
- "message": ≤75 palabras, **sin signos de pregunta**.
  * explore:
      - 1–2 frases de validación **concreta** (no poética).
      - **1 micro-acción inmediata** útil (p.ej.: time_out_24h, no_escalar, guion_dialogo_pareja breve, message_en_yo, oars_escucha, behavioral_activation, opposite_action, cognitive_reframe 1 pensamiento, apoyo_red_social hoy, walk_10min, hydrate). 
      - 1 línea espiritual corta (sin cita dentro de "message").
  * permiso:
      - Ofrece claramente **dos rumbos**: “armamos un **guion** para hablar con ${TOPIC_HINT || "el tema"}” **o** “regulamos emoción y definimos **límites** ahora”.
      - 1 línea espiritual.
  * execute:
      - Si la intención es guion, entrega **guion listo para usar** con esta estructura EXACTA en 5 líneas (marcadas en negrita):
        **Contexto (1 frase)**, **Mensaje en yo (2)**, **Límite**, **Petición concreta**, **Cierre breve**.
      - Tras dar guion, prepara **plan 24h** (descanso, no contactar en caliente, comer, caminar 10 min, 1 llamada breve de sostén, oración corta).
- "bible": texto + ref, ajustada al contexto. Evita repetir: ${avoidRefs.map((r) => `"${r}"`).join(", ") || "(ninguna)"} y **evita Mateo/Matthew 11:28**.
- "question": **UNA sola** y que haga **avanzar**:
  * explore → “¿Qué pasó y con quién?” **o** “¿Qué te gustaría resolver hoy?” (evitar “desde cuándo” si no agrega acción).
  * permiso → “¿Querés que te diga **qué decir y cómo** (guion), o regulamos ahora la emoción y marcamos un límite?”
  * execute → “¿Querés que ajustemos una línea del guion o te dejo ahora el **plan de 24h** paso a paso?”
  * bye → omitir pregunta.
  Debe terminar en "?" y evitar genéricas tipo “qué te aliviaría/qué plan/qué parte”.
- "techniques": etiquetas de técnicas usadas. **Incluye** preferentemente (si aplica) ${EMO_TECH_HINT.join(", ") || "(libre)"} y **evita** repetir recientes: ${
      avoidTech.join(", ") || "(ninguna)"
    }.
- "q_style": etiqueta (explore_event, permiso_guion, execute_checkin, etc).
- "offer_kind": "guion" | "plan24h" | "permiso" | null.

PRIORIDADES:
- **Autoayuda concreta primero** (no solo respirar/escribir). Si la última técnica fue respiración o escritura (${avoidTech.join(", ") || "(ninguna)"}), **no** la repitas ahora.
- Evita repetir **estilo de pregunta**: ${avoidQStyles.join(", ") || "(ninguno)"}.
- Tras “no” a ajustar guion: ofrece **plan 24h** (no volver a validaciones genéricas).
No menciones IA/modelos.
`;

    const header = `Persona: ${persona}
Lang: ${lang}
Mensaje_usuario: ${userTxt}
Historial: ${shortHistory.length ? shortHistory.join(" | ") : "(sin antecedentes)"}
Evitar_refs: ${[...avoidRefs, ...BANNED_REFS].join(" | ") || "(ninguna)"}
Evitar_preguntas: ${avoidQs.join(" | ") || "(ninguna)"}
Evitar_tecnicas: ${avoidTech.join(" | ") || "(ninguna)"}
Evitar_q_styles: ${avoidQStyles.join(" | ") || "(ninguno)"}
FRAME: ${JSON.stringify(frame)}
`;

    // 1) Generación
    let r = await completionJson({
      messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: header }],
      temperature: 0.6,
      max_tokens: 380,
      response_format: FORMAT_ASK,
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
    let questionRaw = String(data?.question || "").trim();
    let techniques = Array.isArray(data?.techniques) ? data.techniques.map(String) : [];
    let q_style = String(data?.q_style || "").trim();
    let offer_kind = String(data?.offer_kind || "").trim() || null;

    let question = isBye ? "" : sanitizeSingleQuestion(questionRaw, lang, recency);

    // 2) Ajuste adicional de pregunta si quedó floja
    const BAD_GENERIC_Q =
      /(qué te aliviaría|que te aliviar[ií]a|qué pequeño paso|qué vas a|qué harás|qué plan|divide el problema|qué parte espec[ií]fica|qué parte de la situaci[oó]n)/i;
    if (!isBye && (!question || BAD_GENERIC_Q.test(question))) {
      const SYS2 = SYSTEM_PROMPT + `\nRefina la "question": una sola, directa y que haga avanzar (sin A/B si no es permiso).`;
      const r2 = await completionJson({
        messages: [{ role: "system", content: SYS2 }, { role: "user", content: header }],
        temperature: 0.65,
        max_tokens: 320,
        response_format: FORMAT_ASK,
      });
      const c2 = r2?.choices?.[0]?.message?.content || "{}";
      let d2 = {};
      try {
        d2 = JSON.parse(c2);
      } catch {
        d2 = {};
      }
      msg = limitWords(stripQuestionsFromMessage(removeBibleLike(String(d2?.message || msg || ""))), 75);
      ref = cleanRef(String(d2?.bible?.ref || ref || ""));
      text = String(d2?.bible?.text || text || "").trim();
      question = isBye ? "" : sanitizeSingleQuestion(String(d2?.question || question || "").trim(), lang, recency);
      techniques = Array.isArray(d2?.techniques) ? d2.techniques.map(String) : techniques;
      q_style = String(d2?.q_style || q_style || "").trim();
      offer_kind = String(d2?.offer_kind || offer_kind || "").trim() || offer_kind;
    }

    // 3) Anti repetición cita / cita vetada
    const avoidSet = new Set((mem.last_bible_refs || []).map((x) => NORM(cleanRef(x))));
    if (!ref || avoidSet.has(NORM(ref)) || isRefMat11_28(ref)) {
      const alt = await regenerateBibleAvoiding({
        lang,
        persona,
        message: userTxt,
        frame,
        bannedRefs: [...(mem.last_bible_refs || []), ...BANNED_REFS],
        lastRef: mem.last_bible_refs?.slice(-1)[0] || "",
      });
      if (alt) {
        ref = alt.ref;
        text = alt.text;
      }
    }
    if (isRefMat11_28(ref)) {
      ref = lang === "en" ? "Psalm 34:18" : "Salmos 34:18";
      text =
        lang === "en"
          ? "The Lord is close to the brokenhearted and saves those who are crushed in spirit."
          : "Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu.";
    }

    // 4) Persistencia
    const cleanedRef = cleanRef(ref);
    if (cleanedRef) {
      mem.last_bible_refs = Array.isArray(mem.last_bible_refs) ? mem.last_bible_refs : [];
      mem.last_bible_refs.push(cleanedRef);
      while (mem.last_bible_refs.length > 8) mem.last_bible_refs.shift();
    }
    if (!isBye && question) {
      mem.last_questions = Array.isArray(mem.last_questions) ? mem.last_questions : [];
      mem.last_questions.push(question);
      while (mem.last_questions.length > 10) mem.last_questions.shift();
    }
    if (Array.isArray(techniques) && techniques.length) {
      mem.last_techniques = Array.isArray(mem.last_techniques) ? mem.last_techniques : [];
      mem.last_techniques = [...mem.last_techniques, ...techniques].slice(-12);
    }
    if (q_style) {
      mem.last_q_styles = Array.isArray(mem.last_q_styles) ? mem.last_q_styles : [];
      mem.last_q_styles.push(q_style);
      while (mem.last_q_styles.length > 10) mem.last_q_styles.shift();
    }
    // marcar oferta
    if (offer_kind) mem.last_offer_kind = offer_kind;

    await writeUserMemory(userId, mem);

    const out = {
      message:
        msg ||
        (lang === "en" ? "I’m with you. Let’s take one small, practical step." : "Estoy contigo. Demos un paso pequeño y práctico."),
      bible: {
        text:
          text ||
          (lang === "en"
            ? "The Lord is close to the brokenhearted."
            : "Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu."),
        ref: cleanedRef || (lang === "en" ? "Psalm 34:18" : "Salmos 34:18"),
      },
    };
    if (!isBye && question) out.question = question;

    res.status(200).json(out);
  } catch (err) {
    console.error("ASK ERROR:", err);
    res.status(200).json({
      message:
        "La paz sea contigo. Contame en pocas palabras lo esencial y seguimos con pasos concretos.",
      bible: {
        text: "Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu.",
        ref: "Salmos 34:18",
      },
    });
  }
});

// -------------------- HeyGen --------------------
app.get("/api/heygen/token", async (_req, res) => {
  try {
    const API_KEY = (process.env.HEYGEN_API_KEY || process.env.HEYGEN_TOKEN || "").trim();
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

// -------------------- Start --------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor listo en puerto ${PORT}`));
