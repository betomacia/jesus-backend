// index.js — Backend limpio solo con OpenAI (con hardening)
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const OpenAI = require("openai");
const path = require("path");
const fs = require("fs/promises");
const crypto = require("crypto");                  // NEW: request id
const helmet = require("helmet");                 // NEW
const rateLimit = require("express-rate-limit");  // NEW
require("dotenv").config();

const app = express();

// --- Seguridad base ---
app.set("trust proxy", 1); // NEW: detrás de proxy en Railway
app.use(helmet({ crossOriginResourcePolicy: false })); // NEW: cabeceras seguras
app.use(bodyParser.json({ limit: "200kb" })); // NEW: límite payload

// --- CORS (lista blanca) ---
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);
// Si no seteaste ALLOWED_ORIGINS, permito todo como fallback (tu comportamiento actual)
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) {
      return cb(null, true);
    }
    return cb(new Error("CORS not allowed"), false);
  },
  credentials: false,
}));

// --- Rate limiting ---
const limiter = rateLimit({
  windowMs: 60 * 1000,            // 1 min
  limit: 60,                      // 60 req/min por IP
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// --- Request ID + logging básico ---
app.use((req, _res, next) => {
  req.id = crypto.randomUUID();
  req.start = Date.now();
  console.log(`[REQ ${req.id}] ${req.method} ${req.url}`);
  next();
});

// --- OpenAI ---
if (!process.env.OPENAI_API_KEY) {
  console.warn("⚠️ Falta OPENAI_API_KEY en el entorno");
}
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- Utils originales (sin cambios salvo minimos) ---
const NORM = (s = "") => String(s).toLowerCase().replace(/\s+/g, " ").trim();

function langLabel(l = "es") {
  const m = { es:"Español", en:"English", pt:"Português", it:"Italiano", de:"Deutsch", ca:"Català", fr:"Français" };
  return m[l] || "Español";
}
function greetingByHour(lang = "es", hour = null) {
  const h = Number.isInteger(hour) ? hour : new Date().getHours();
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

// ... DAILY_PHRASES, dayPhrase, FALLBACK_VERSES, pickFallbackVerse (sin cambios) ...

// --- Memoria FS (nota: Railway puede ser efímero) ---
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
async function ensureDataDir() { try { await fs.mkdir(DATA_DIR, { recursive: true }); } catch {} }
function memPath(uid) { const safe = String(uid || "anon").replace(/[^a-z0-9_-]/gi, "_"); return path.join(DATA_DIR, `mem_${safe}.json`); }
async function readMem(userId) {
  await ensureDataDir();
  try {
    const raw = await fs.readFile(memPath(userId), "utf8");
    const m = JSON.parse(raw);
    return { last_user_text: m.last_user_text || "", last_user_ts: m.last_user_ts || 0, last_bot: m.last_bot || null, last_refs: Array.isArray(m.last_refs) ? m.last_refs : [] };
  } catch {
    return { last_user_text: "", last_user_ts: 0, last_bot: null, last_refs: [] };
  }
}
async function writeMem(userId, mem) {
  await ensureDataDir();
  await fs.writeFile(memPath(userId), JSON.stringify(mem, null, 2), "utf8");
}

// --- Filtros de alcance (sin cambios) ---
const OFFTOPIC = [ /* ... tus regex ... */ ];
const RELIGIOUS_ALLOW = [ /* ... tus regex ... */ ];
const isReligiousException = (s) => RELIGIOUS_ALLOW.some(r => r.test(NORM(s)));
const isOffTopic = (s) => OFFTOPIC.some(r => r.test(NORM(s)));
function isGibberish(s) {
  const x = (s || "").trim();
  if (!x || x.length < 2) return true;
  const letters = (x.match(/[a-záéíóúüñàèìòùçâêîôûäëïöüß]/gi) || []).length;
  return letters < Math.ceil(x.length * 0.25);
}

// --- Helpers nuevos ---
const ALLOWED_LANGS = new Set(["es","en","pt","it","de","ca","fr"]);
const ALLOWED_GENDERS = new Set(["male","female"]);

function sanitizeHistory(arr) {
  if (!Array.isArray(arr)) return [];
  const safe = arr
    .slice(-8)
    .map(x => (typeof x === "string" ? x.slice(0, 2000) : ""))
    .filter(Boolean);
  return safe;
}

function withTimeout(promise, ms = 20000) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error("Request timeout")), ms)),
  ]);
}

// --- Health ---
app.get("/", (_req, res) => res.json({ ok: true, service: "backend", ts: Date.now() }));
app.get("/healthz", (_req, res) => res.send("ok"));
app.get("/readyz", (_req, res) => res.send("ready"));

// Welcome (restaurado: sin OpenAI, misma lógica original)
app.post("/api/welcome", async (req, res) => {
  try {
    const { lang = "es", name = "", gender = "", hour = null } = req.body || {};
    const h = Number.isInteger(hour) ? hour : new Date().getHours();
    const greeting = greetingByHour(lang, h);
    const phrase = dayPhrase(lang);
    const nm = String(name || "").trim();

    let sal = nm ? `${greeting}, ${nm}.` : `${greeting}.`;

    // “Hijo/Hija mía” según género (igual que antes)
    if (gender === "male")      sal += " Hijo mío,";
    else if (gender === "female") sal += " Hija mía,";

    const message =
      lang === "en" ? `${sal} ${phrase} I'm here for you.` :
      lang === "pt" ? `${sal} ${phrase} Estou aqui para você.` :
      lang === "it" ? `${sal} ${phrase} Sono qui per te.` :
      lang === "de" ? `${sal} ${phrase} Ich bin für dich da.` :
      lang === "ca" ? `${sal} ${phrase} Sóc aquí per ajudar-te.` :
      lang === "fr" ? `${sal} ${phrase} Je suis là pour toi.` :
      `${sal} ${phrase} Estoy aquí para lo que necesites.`;

    const question =
      lang === "en" ? "What would you like to share today?" :
      lang === "pt" ? "O que você gostaria de compartilhar hoje?" :
      lang === "it" ? "Di cosa ti piacerebbe parlare oggi?" :
      lang === "de" ? "Worüber möchtest du heute sprechen?" :
      lang === "ca" ? "De què t'agradaria parlar avui?" :
      lang === "fr" ? "De quoi aimerais-tu parler aujourd'hui ?" :
      "¿Qué te gustaría compartir hoy?";

    res.json({ message, question });
  } catch {
    // Fallback por si algo raro pasa
    res.json({
      message: "La paz sea contigo. ¿De qué te gustaría hablar hoy?",
      question: "¿Qué te gustaría compartir hoy?",
    });
  }
});


// --- Ask (con timeouts, reintentos y validación) ---
app.post("/api/ask", async (req, res) => {
  const started = Date.now();
  try {
    const lang = ALLOWED_LANGS.has(req.body?.lang) ? req.body.lang : "es";
    const userId = String(req.body?.userId || "anon").slice(0, 120);
    const message = String(req.body?.message || "").trim().slice(0, 2000);
    const history = sanitizeHistory(req.body?.history);

    // Anti-ruido y alcance
    const mem = await readMem(userId);
    const now = Date.now();

    if (message && mem.last_user_text && message === mem.last_user_text && now - mem.last_user_ts < 7000) {
      if (mem.last_bot) return res.json(mem.last_bot);
    }

    if (isGibberish(message)) {
      const msg =
        lang === "en" ? "I didn't quite get that. Could you say it again in a few words?" :
        lang === "pt" ? "Não entendi bem. Pode repetir em poucas palavras?" :
        lang === "it" ? "Non ho capito bene. Puoi ripetere in poche parole?" :
        lang === "de" ? "Ich habe es nicht ganz verstanden. Kannst du es in wenigen Worten wiederholen?" :
        lang === "ca" ? "No ho he entès del tot. Ho pots repetir en poques paraules?" :
        lang === "fr" ? "Je n'ai pas bien compris. Peux-tu répéter en quelques mots ?" :
        "No te entendí bien. ¿Podés repetirlo en pocas palabras?";
      const out = { message: msg, question: "", bible: { text: "", ref: "" } };
      mem.last_user_text = message; mem.last_user_ts = now; mem.last_bot = out;
      await writeMem(userId, mem);
      return res.json(out);
    }

    if (isOffTopic(message) && !isReligiousException(message)) {
      const msg =
        lang === "en" ? "I'm here for your inner life: faith, personal struggles and healing." :
        lang === "pt" ? "Estou aqui para a sua vida interior: fé, questões pessoais e cura." :
        lang === "it" ? "Sono qui per la tua vita interiore: fede, difficoltà personali e guarigione." :
        lang === "de" ? "Ich bin für dein inneres Leben da: Glaube, persönliche Themen und Heilung." :
        lang === "ca" ? "Sóc aquí per a la teva vida interior: fe, dificultats personals i sanació." :
        lang === "fr" ? "Je suis là pour ta vie intérieure : foi, difficultés personnelles et guérison." :
        "Estoy aquí para tu vida interior: fe, dificultades personales y sanación.";
      const q =
        lang === "en" ? "What would help you most right now—your emotions, a relationship, or your prayer life?" :
        lang === "pt" ? "O que mais ajudaria agora — suas emoções, uma relação, ou a sua vida de oração?" :
        lang === "it" ? "Cosa ti aiuterebbe ora — le emozioni, una relazione o la tua vita di preghiera?" :
        lang === "de" ? "Was würde dir jetzt am meisten helfen – deine Gefühle, eine Beziehung oder dein Gebetsleben?" :
        lang === "ca" ? "Què t'ajudaria ara — les teves emocions, una relació o la teva vida de pregària?" :
        lang === "fr" ? "Qu'est-ce qui t'aiderait le plus — tes émotions, une relation ou ta vie de prière ?" :
        "¿Qué te ayudaría ahora — tus emociones, una relación o tu vida de oración?";
      const out = { message: msg, question: q, bible: { text: "", ref: "" } };
      mem.last_user_text = message; mem.last_user_ts = now; mem.last_bot = out;
      await writeMem(userId, mem);
      return res.json(out);
    }

    // --- OpenAI call con timeout y reintentos simples ---
    const SYS = `
Eres cercano, claro y compasivo, desde una voz cristiana (católica).
Alcance: espiritualidad/fe católica, psicología/autoayuda personal, relaciones y emociones.
Varía el lenguaje; no repitas muletillas. 1 sola pregunta breve y pertinente.
Formato (JSON en ${langLabel(lang)}): {"message":"...", "question":"...?", "bible":{"text":"...","ref":"Libro 0:0"}}
- "message": natural y concreto
- "question": una pregunta simple
- "bible": SIEMPRE incluida; pertinente; evita Mateo/Matthew 11:28
No incluyas nada fuera del JSON.
`.trim();

    const convo = [
      ...history.map(h => ({ role: "user", content: h })),
      { role: "user", content: message }
    ];

    const call = () => openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.6,
      max_tokens: 360,
      messages: [{ role: "system", content: SYS }, ...convo],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "Reply",
          schema: {
            type: "object",
            properties: {
              message: { type: "string" },
              question: { type: "string" },
              bible: {
                type: "object",
                properties: { text: { type: "string" }, ref: { type: "string" } },
                required: ["text", "ref"],
              },
            },
            required: ["message", "bible"],
            additionalProperties: false,
          },
        },
      },
    });

    let r, lastErr;
    for (let i = 0; i < 2; i++) { // 1 intento + 1 retry
      try { r = await withTimeout(call(), 20000); break; }
      catch (e) { lastErr = e; if (i === 0) await new Promise(t => setTimeout(t, 400)); }
    }
    if (!r) throw lastErr || new Error("OpenAI call failed");

    const content = r?.choices?.[0]?.message?.content || "{}";
    let data = {};
    try { data = JSON.parse(content); } catch { data = {}; }

    let out = {
      message: String(data?.message || "").trim() || (lang === "en" ? "I'm with you." : "Estoy contigo."),
      question: String(data?.question || "").trim() || "",
    };

    const banned = /mateo\s*11\s*:\s*28|matt(hew)?\s*11\s*:\s*28|matteo\s*11\s*:\s*28|matthäus\s*11\s*:\s*28|matthieu\s*11\s*:\s*28|mateu\s*11\s*:\s*28|mateus\s*11\s*:\s*28/i;
    const refRaw = String(data?.bible?.ref || "").trim();
    const txtRaw = String(data?.bible?.text || "").trim();
    const used = new Set((mem.last_refs || []).map(x => NORM(x)));

    let finalVerse = null;
    if (txtRaw && refRaw && !banned.test(refRaw) && !used.has(NORM(refRaw))) {
      finalVerse = { ref: refRaw, text: txtRaw };
    } else {
      finalVerse = pickFallbackVerse(lang, used);
    }

    out.bible = finalVerse;

    // Persistir memoria
    mem.last_refs = [...(mem.last_refs || []), finalVerse.ref].slice(-8);
    mem.last_user_text = message;
    mem.last_user_ts = now;
    mem.last_bot = out;
    await writeMem(userId, mem);

    res.json(out);
  } catch (e) {
    console.error("ASK ERROR:", e);
    res.json({
      message: "La paz sea contigo. Decime en pocas palabras qué está pasando.",
      question: "¿Qué te gustaría trabajar primero?",
      bible: { ref: "Salmos 34:18", text: "Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu." },
    });
  } finally {
    console.log(`[REQ ${req.id}] done in ${Date.now() - started}ms`);
  }
});

// --- Arranque ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Backend listo en puerto ${PORT}`));

