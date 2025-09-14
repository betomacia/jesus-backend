// index.js — Backend multilingüe y centralizado (ES/EN/PT/IT/DE/CA/FR)
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

/* ===================== Configuración de idiomas ===================== */

const SUPPORTED = ["es", "en", "pt", "it", "de", "ca", "fr"];
const FALLBACK_LANG = "en";

// Traducción bíblica preferida por idioma
const BIBLE_BY_LANG = {
  es: "RVR1960",
  en: "NIV",
  pt: "ARA",
  it: "CEI",
  de: "Luther",
  ca: "Bíblia Catalana Interconfessional",
  fr: "Louis Segond",
};

// Saludo por hora/idioma
function greetingByLocalTimeLang(lang = "es", date = new Date()) {
  const h = date.getHours();
  const bucket = h < 12 ? "m1" : h < 19 ? "m2" : "m3";
  const T = {
    es: { m1: "Buenos días", m2: "Buenas tardes", m3: "Buenas noches" },
    en: { m1: "Good morning", m2: "Good afternoon", m3: "Good evening" },
    pt: { m1: "Bom dia", m2: "Boa tarde", m3: "Boa noite" },
    it: { m1: "Buongiorno", m2: "Buon pomeriggio", m3: "Buona sera" },
    de: { m1: "Guten Morgen", m2: "Guten Tag", m3: "Guten Abend" },
    ca: { m1: "Bon dia", m2: "Bona tarda", m3: "Bona nit" },
    fr: { m1: "Bonjour", m2: "Bon après-midi", m3: "Bonsoir" },
  };
  const pack = T[SUPPORTED.includes(lang) ? lang : FALLBACK_LANG];
  return pack[bucket];
}

/* ====================== Utilidades generales ======================= */

function safeLang(lang) {
  return SUPPORTED.includes(String(lang || "").toLowerCase()) ? String(lang).toLowerCase() : FALLBACK_LANG;
}
function cleanRef(ref = "") {
  return String(ref).replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
}
function stripQuestionsFromMessage(s = "") {
  return (s || "").split(/\n+/).map(l => l.trim()).filter(l => !/\?\s*$/.test(l)).join("\n").trim()
           .replace(/[¿?]+/g, "").trim();
}
function limitWords(s = "", max = 60) {
  const words = String(s || "").trim().split(/\s+/);
  return words.length <= max ? String(s || "").trim() : words.slice(0, max).join(" ").trim();
}
function normalizeQuestion(q = "") {
  return String(q).toLowerCase().replace(/\s+/g, " ").trim();
}
function compactHistory(history = [], keep = 8, maxLen = 260) {
  const arr = Array.isArray(history) ? history : [];
  return arr.slice(-keep).map(x => String(x).slice(0, maxLen));
}
function extractRecentAssistantQuestions(history = [], maxMsgs = 5) {
  const rev = [...(history || [])].reverse();
  const qs = [];
  for (const h of rev) {
    if (!/^Asistente:/i.test(h) && !/^Assistant:/i.test(h)) continue;
    const text = h.replace(/^Asistente:\s*/i, "").replace(/^Assistant:\s*/i, "").trim();
    const m = text.match(/([^?]*\?)\s*$/m);
    if (m && m[1]) qs.push(normalizeQuestion(m[1]));
    if (qs.length >= maxMsgs) break;
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

// detecciones simples de tema/sujeto
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
const SUPPORT_WORDS = ["hijo","hija","madre","padre","mamá","mama","papá","papa","abuelo","abuela","nieto","nieta",
  "tío","tio","tía","tia","sobrino","sobrina","primo","prima","cuñado","cuñada","suegro","suegra","yerno","nuera",
  "esposo","esposa","pareja","novio","novia","amigo","amiga","compañero","compañera","colega","vecino","vecina",
  "pastor","sacerdote","mentor","maestro","maestra","profesor","profesora","jefe","jefa",
  "psicólogo","psicologa","psicóloga","terapeuta","consejero","consejera","médico","medica","médica"];
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

/* ====================== Memoria por usuario ======================= */

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
async function ensureDataDir() { try { await fs.mkdir(DATA_DIR, { recursive: true }); } catch {} }
function memPath(uid) {
  const safe = String(uid || "anon").replace(/[^a-z0-9_-]/gi, "_");
  return path.join(DATA_DIR, `mem_${safe}.json`);
}
async function readUserMemory(userId) {
  await ensureDataDir();
  try { return JSON.parse(await fs.readFile(memPath(userId), "utf8")); }
  catch { return { last_bible_ref: "", last_bible_refs: [], last_questions: [], frame: null }; }
}
async function writeUserMemory(userId, mem) {
  await ensureDataDir();
  await fs.writeFile(memPath(userId), JSON.stringify(mem, null, 2), "utf8");
}

/* ==================== OpenAI helpers / prompts ==================== */

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

async function completionJSON({ model = "gpt-4o", system, user, temperature = 0.5, max_tokens = 220, timeoutMs = 12000, response_format = responseFormat }) {
  const call = openai.chat.completions.create({
    model, temperature, max_tokens, response_format,
    messages: [{ role: "system", content: system }, { role: "user", content: user }]
  });
  return await Promise.race([call, new Promise((_,rej)=>setTimeout(()=>rej(new Error("TIMEOUT")), timeoutMs))]);
}

function systemPrompt(lang) {
  const biblePref = BIBLE_BY_LANG[lang] || BIBLE_BY_LANG[FALLBACK_LANG];
  return `
You are “Jesus”: serene, compassionate, concise. Always reply in **${lang}**.

GOAL
- Return ONLY JSON: {"message","bible":{"text","ref"},"question"?}
- "message": ≤60 words, affirmative, NO question marks.
- "question": optional, ONE open-ended, ends with "?", do not repeat recent ones.
- Avoid tech/model talk. Be warm, non-dogmatic.

BIBLE
- Choose a verse appropriate to the user’s topic and micro-steps.
- Use translation preference for ${lang}: ${biblePref}.
- Avoid the immediately previous refs and any “banned_refs”.

FRAME
- Respect FRAME (topic_primary, main_subject, support_persons) and short history as context.
- Do not derail the main topic due to support persons.

FORMAT
{
  "message": "... (≤60 words, no '?')",
  "bible": { "text": "... (${biblePref})", "ref": "Book 0:0" },
  "question": "...? (optional, one)"
}
`.trim();
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

async function regenerateBibleAvoiding({ lang, persona, message, frame, bannedRefs = [], lastRef = "" }) {
  const biblePref = BIBLE_BY_LANG[lang] || BIBLE_BY_LANG[FALLBACK_LANG];
  const sys = `Return ONLY JSON {"bible":{"text":"…","ref":"Book 0:0"}} in ${lang} using ${biblePref}. Avoid any ref from "banned_refs" and "last_bible_ref".`;
  const usr = `Persona: ${persona}\nMessage: ${message}\nFRAME: ${JSON.stringify(frame)}\nlast_bible_ref: ${lastRef || "(n/a)"}\nbanned_refs:\n- ${bannedRefs.join("\n- ") || "(none)"}\n`;
  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.4, max_tokens: 120,
    response_format: bibleOnlyFormat,
    messages: [{ role: "system", content: sys }, { role: "user", content: usr }]
  });
  let data = {};
  try { data = JSON.parse(r?.choices?.[0]?.message?.content || "{}"); } catch {}
  const text = (data?.bible?.text || "").toString().trim();
  const ref = cleanRef((data?.bible?.ref || "").toString());
  return text && ref ? { text, ref } : null;
}

/* ============================ Core ============================ */

async function askLLM({ lang = "es", persona = "jesus", message, history = [], userId = "anon" }) {
  lang = safeLang(lang);
  const mem = await readUserMemory(userId);

  // FRAME
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

  const header =
    `Persona: ${persona}\n` +
    `Lang: ${lang}\n` +
    `Message: ${message}\n` +
    `FRAME: ${JSON.stringify(frame)}\n` +
    `last_bible_ref: ${lastRef || "(n/a)"}\n` +
    `banned_refs:\n- ${bannedRefs.join("\n- ") || "(none)"}\n` +
    (recentQs.length ? `recent_questions: ${recentQs.join(" | ")}` : "recent_questions: (none)") + "\n" +
    (shortHistory.length ? `History: ${shortHistory.join(" | ")}` : "History: (none)") + "\n";

  const resp = await completionJSON({
    system: systemPrompt(lang),
    user: header,
    temperature: 0.55,
    max_tokens: 220,
  });

  let data = {};
  try { data = JSON.parse(resp?.choices?.[0]?.message?.content || "{}"); } catch { data = {}; }

  let msg = limitWords(stripQuestionsFromMessage((data?.message || "").toString()), 60);
  let ref = cleanRef((data?.bible?.ref || "").toString());
  let text = (data?.bible?.text || "").toString().trim();

  // Evitar ref vetada/repetida
  if (!ref || bannedRefs.includes(ref)) {
    const alt = await regenerateBibleAvoiding({ lang, persona, message, frame, bannedRefs, lastRef });
    if (alt) { ref = alt.ref; text = alt.text; }
  }

  let question = (data?.question || "").toString().trim();
  const normalizedQ = normalizeQuestion(question);
  const isRepeat = !question ? false : recentQs.includes(normalizedQ);
  const malformed = question && !/\?\s*$/.test(question);
  if (!question || isRepeat || malformed) question = "";

  // Memoria
  mem.last_bible_ref = ref || mem.last_bible_ref || "";
  mem.last_bible_refs = Array.from(new Set([...(mem.last_bible_refs || []), ref].filter(Boolean))).slice(-5);
  if (question) mem.last_questions = Array.from(new Set([...(mem.last_questions || []), normalizedQ])).slice(-6);
  await writeUserMemory(userId, mem);

  if (!msg) {
    msg = (lang === "es") ? "Estoy contigo. Demos un paso pequeño y realista hoy."
        : (lang === "pt") ? "Estou com você. Vamos dar um passo pequeno e realista hoje."
        : (lang === "it") ? "Sono con te. Facciamo oggi un piccolo passo realistico."
        : (lang === "de") ? "Ich bin bei dir. Gehen wir heute einen kleinen, realistischen Schritt."
        : (lang === "ca") ? "Soc amb tu. Fem avui un pas petit i realista."
        : (lang === "fr") ? "Je suis avec toi. Faisons aujourd’hui un petit pas réaliste."
        : "I am with you. Let’s take a small, realistic step today.";
  }

  if (!text || !ref) {
    if (lang === "es") { text = "Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu."; ref = "Salmos 34:18"; }
    else if (lang === "pt") { text = "Perto está o Senhor dos que têm o coração quebrantado; e salva os contritos de espírito."; ref = "Salmos 34:18"; }
    else if (lang === "it") { text = "Il Signore è vicino a quelli che hanno il cuore afflitto; salva gli contriti di spirito."; ref = "Salmi 34:18"; }
    else if (lang === "de") { text = "Der HERR ist nahe denen, die zerbrochenen Herzens sind, und hilft denen, die zerschlagenen Geistes sind."; ref = "Psalm 34,19 (Luther)"; }
    else if (lang === "ca") { text = "El Senyor és a prop dels cors adolorits, i salva els esperits abatuts."; ref = "Salm 34,19"; }
    else if (lang === "fr") { text = "L’Éternel est près de ceux qui ont le cœur brisé, et il sauve ceux dont l’esprit est abattu."; ref = "Psaume 34:19"; }
    else { text = "The LORD is close to the brokenhearted and saves those who are crushed in spirit."; ref = "Psalm 34:18"; }
  }

  return { message: msg, bible: { text, ref }, ...(question ? { question } : {}) };
}

/* ============================ Rutas ============================ */

// Conversación normal
app.post("/api/ask", async (req, res) => {
  try {
    const { persona = "jesus", message = "", history = [], userId = "anon", lang = "es" } = req.body || {};
    const data = await askLLM({ lang: safeLang(lang), persona, message, history, userId });
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(200).json({
      message: (data?.message || "").toString().trim(),
      bible: { text: (data?.bible?.text || "").toString().trim(), ref: (data?.bible?.ref || "").toString().trim() },
      ...(data?.question ? { question: data.question } : {})
    });
  } catch (err) {
    console.error("ASK ERROR:", err);
    res.status(200).json({
      message: "La paz sea contigo. Compárteme en pocas palabras lo esencial, y seguimos paso a paso.",
      bible: { text: "Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu.", ref: "Salmos 34:18" }
    });
  }
});

// Bienvenida (mensaje ≤60 palabras SIN ? en el primer párrafo) + UNA pregunta abierta (opcional). Sin versículo en el primer turno.
app.post("/api/welcome", async (req, res) => {
  try {
    let { lang = "es", name = "", history = [] } = req.body || {};
    lang = safeLang(lang);
    const salute = greetingByLocalTimeLang(lang);
    const nm = (name || "").trim();

    const prompts = {
      es: {
        sys: `Eres Jesús compasivo. Siempre responde en **es**. Devuelve SOLO JSON {"message","question"}. "message": ≤60 palabras, cálido, SIN signos de pregunta. "question": opcional, UNA, abierta, termina en "?". No incluyas citas bíblicas.`,
        usr: `${salute}${nm ? `, ${nm}` : ""}. Genera bienvenida breve y luego una sola pregunta abierta amable. Historial: ${compactHistory(history).join(" | ") || "(sin antecedentes)"}`
      },
      en: {
        sys: `You are compassionate Jesus. Always reply in **en**. Return ONLY JSON {"message","question"}. "message": ≤60 words, warm, NO question marks. "question": optional, ONE, open-ended, ends with "?". No Bible verse.`,
        usr: `${salute}${nm ? `, ${nm}` : ""}. Generate a brief welcome, then a single kind open question. History: ${compactHistory(history).join(" | ") || "(none)"}`
      },
      pt: {
        sys: `Você é Jesus compassivo. Responda sempre em **pt**. Retorne APENAS JSON {"message","question"}. "message": ≤60 palavras, acolhedor, SEM pontos de interrogação. "question": opcional, UMA, aberta, termina com "?". Sem versículo bíblico.`,
        usr: `${salute}${nm ? `, ${nm}` : ""}. Gere uma breve acolhida e depois uma pergunta aberta gentil. Histórico: ${compactHistory(history).join(" | ") || "(nenhum)"}`
      },
      it: {
        sys: `Sei Gesù compassionevole. Rispondi sempre in **it**. Restituisci SOLO JSON {"message","question"}. "message": ≤60 parole, caldo, SENZA punti interrogativi. "question": opzionale, UNA, aperta, termina con "?". Nessun versetto.`,
        usr: `${salute}${nm ? `, ${nm}` : ""}. Genera un breve benvenuto e poi una singola domanda aperta gentile. Storico: ${compactHistory(history).join(" | ") || "(nessuno)"}`
      },
      de: {
        sys: `Du bist mitfühlender Jesus. Antworte immer auf **de**. Gib NUR JSON {"message","question"} zurück. "message": ≤60 Wörter, warm, KEINE Fragezeichen. "question": optional, EINE, offen, endet mit "?". Kein Bibelvers.`,
        usr: `${salute}${nm ? `, ${nm}` : ""}. Erzeuge eine kurze Begrüßung, dann eine einzige offene, freundliche Frage. Verlauf: ${compactHistory(history).join(" | ") || "(keiner)"}`
      },
      ca: {
        sys: `Ets Jesús compassiu. Respon sempre en **ca**. Torna NOMÉS JSON {"message","question"}. "message": ≤60 paraules, càlid, SENSE signes d'interrogació. "question": opcional, UNA, oberta, acaba amb "?". Sense verset bíblic.`,
        usr: `${salute}${nm ? `, ${nm}` : ""}. Genera una benvinguda breu i després una única pregunta oberta amable. Historial: ${compactHistory(history).join(" | ") || "(cap)"}`
      },
      fr: {
        sys: `Tu es Jésus compatissant. Réponds toujours en **fr**. Retourne UNIQUEMENT du JSON {"message","question"}. "message" : ≤60 mots, chaleureux, SANS point d’interrogation. "question" : optionnelle, UNE seule, ouverte, se termine par "?". Pas de verset biblique.`,
        usr: `${salute}${nm ? `, ${nm}` : ""}. Génère un accueil bref puis une unique question ouverte bienveillante. Historique : ${compactHistory(history).join(" | ") || "(aucun)"}`
      },
    }[lang];

    const r = await completionJSON({
      model: "gpt-4o-mini",
      system: prompts.sys,
      user: prompts.usr,
      temperature: 0.4,
      max_tokens: 160,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "Welcome",
          schema: {
            type: "object",
            properties: { message: { type: "string" }, question: { type: "string" } },
            required: ["message"], additionalProperties: false
          }
        }
      }
    });

    let data = {};
    try { data = JSON.parse(r?.choices?.[0]?.message?.content || "{}"); } catch {}
    const message = limitWords(stripQuestionsFromMessage(String(data?.message || "")), 60);
    const question = /\?\s*$/.test(String(data?.question || "")) ? String(data?.question).trim() : "";

    res.json({ message, ...(question ? { question } : {}) });
  } catch (e) {
    console.error("WELCOME ERROR:", e);
    const fallback = (lang) => (
      lang === "es" ? { message: "La paz esté contigo. Estoy aquí para escucharte con calma.", question: "¿Qué te gustaría compartir hoy?" } :
      lang === "pt" ? { message: "A paz esteja com você. Estou aqui para escutar com calma.", question: "O que você gostaria de compartilhar hoje?" } :
      lang === "it" ? { message: "La pace sia con te. Sono qui per ascoltarti con calma.", question: "Cosa ti piacerebbe condividere oggi?" } :
      lang === "de" ? { message: "Friede sei mit dir. Ich bin da, um dir ruhig zuzuhören.", question: "Was möchtest du heute mitteilen?" } :
      lang === "ca" ? { message: "La pau sigui amb tu. Soc aquí per escoltar-te amb calma.", question: "Què t'agradaria compartir avui?" } :
      lang === "fr" ? { message: "Que la paix soit avec toi. Je suis là pour t’écouter avec calme.", question: "Qu’aimerais-tu partager aujourd’hui ?" } :
      { message: "Peace be with you. I’m here to listen calmly.", question: "What would you like to share today?" }
    );
    res.json(fallback(safeLang(req.body?.lang)));
  }
});

/* ===== HeyGen (igual que antes; no toca OpenAI) ===== */

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
    if (!r.ok || !token) return res.status(r.status || 500).json({ error: "heygen_token_failed", detail: json });
    res.json({ token });
  } catch (e) {
    console.error("heygen token exception:", e);
    res.status(500).json({ error: "heygen_token_error" });
  }
});

app.get("/api/heygen/config", (_req, res) => {
  const AV_LANGS = SUPPORTED;
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

/* =========================== Arranque =========================== */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Servidor listo en puerto ${PORT}`));
