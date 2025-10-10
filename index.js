// index.js — Backend monolítico, dominios acotados y respuestas naturales (multi-idioma)
// Mantiene OpenAI EXACTO (no se toca la lógica). Mejora proxy TTS (baja latencia).

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const OpenAI = require("openai");
const path = require("path");
const fs = require("fs/promises");
const { Readable } = require("stream");
const http = require("http");
const https = require("https");

// ====== fetch: Node 18+ lo trae global. Polyfill solo si faltara. ======
if (typeof fetch === "undefined") {
  global.fetch = require("node-fetch");
}

// ====== Keep-Alive Agents para reducir latencias con el servidor de voz ======
const HTTP_AGENT  = new http.Agent({ keepAlive: true, keepAliveMsecs: 10000, maxSockets: 256 });
const HTTPS_AGENT = new https.Agent({ keepAlive: true, keepAliveMsecs: 10000, maxSockets: 256 });
function agentFor(url) {
  return String(url).startsWith("https:")
    ? { agent: HTTPS_AGENT }
    : { agent: HTTP_AGENT };
}

// ====== App ======
const app = express();
app.disable("x-powered-by");

// Parsers
app.use(bodyParser.json({ limit: "1mb" }));

// CORS robusto + preflight (una sola vez)
app.use(cors({
  origin: "*",
  methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));
app.options("*", cors());
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ====== Config VOZ (FastAPI XTTS) ======
const VOZ_URL = (process.env.VOZ_URL || "http://136.114.108.182:8006").replace(/\/+$/, "");

// ====== OpenAI ======
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ====== DB opcional (no crashea si falta) ======
let query = null;
let ping = null;
try {
  ({ query, ping } = require("./db/pg"));
} catch (e) {
  console.warn("[DB] Módulo ./db/pg ausente o 'pg' no instalado. /db/* responderán 503.");
}

// ====== Utils ======
const NORM = (s = "") => String(s).toLowerCase().replace(/\s+/g, " ").trim();

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

function resolveLocalHour({ hour = null, tzOffsetMinutes = null } = {}) {
  if (Number.isInteger(hour) && hour >= 0 && hour <= 23) return hour;
  if (Number.isInteger(tzOffsetMinutes)) {
    const nowUtc = new Date(Date.now());
    const localMs = nowUtc.getTime() - tzOffsetMinutes * 60 * 1000;
    const local = new Date(localMs);
    return local.getHours();
  }
  return new Date().getHours();
}

function greetingByHour(lang = "es", hour = null) {
  const h = Number.isInteger(hour) ? hour : new Date().getHours();
  const g = (m, a, n) => (h < 12 ? m : h < 19 ? a : n);
  switch (lang) {
    case "en": return g("Good morning", "Good afternoon", "Good evening");
    case "pt": return g("Bom dia", "Boa tarde", "Boa noite");
    case "it": return g("Buongiorno", "Buon pomeriggio", "Buonasera");
    case "de": return g("Guten Morgen", "Guten Tag", "Guten Abend");
    case "ca": return g("Bon dia", "Bona tarda", "Bona nit");
    case "fr": return g("Bonjour", "Bon après-midi", "Bonsoir");
    default:   return g("Buenos días", "Buenas tardes", "Buenas noches");
  }
}

// Fallbacks mínimos (si OpenAI falla)
const DAILY_FALLBACKS = {
  es: [
    "La paz también crece en lo pequeño.",
    "Un paso honesto hoy abre caminos mañana.",
    "No estás solo: vamos de a poco.",
  ],
  en: [
    "Small honest steps open the way.",
    "You’re not alone; let’s start small.",
  ],
  pt: [ "Um passo sincero hoje abre caminhos." ],
  it: [ "Un passo sincero oggi apre la strada." ],
  de: [ "Ein ehrlicher Schritt heute öffnet Wege." ],
  ca: [ "Un pas sincer avui obre camins." ],
  fr: [ "Un pas sincère aujourd’hui ouvre la voie." ],
};
function dayFallback(lang = "es") {
  const arr = DAILY_FALLBACKS[lang] || DAILY_FALLBACKS["es"];
  return arr[Math.floor(Math.random() * arr.length)];
}

// Memoria en FS (simple)
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
async function ensureDataDir() { try { await fs.mkdir(DATA_DIR, { recursive: true }); } catch (_) {} }
function memPath(uid) {
  const safe = String(uid || "anon").replace(/[^a-z0-9_-]/gi, "_");
  return path.join(DATA_DIR, `mem_${safe}.json`);
}
async function readMem(userId) {
  await ensureDataDir();
  try {
    const raw = await fs.readFile(memPath(userId), "utf8");
    const m = JSON.parse(raw);
    return {
      name: m.name || "",
      sex: m.sex || "",
      last_user_text: m.last_user_text || "",
      last_user_ts: m.last_user_ts || 0,
      last_bot: m.last_bot || null,
      last_refs: Array.isArray(m.last_refs) ? m.last_refs : [],
    };
  } catch {
    return { name: "", sex: "", last_user_text: "", last_user_ts: 0, last_bot: null, last_refs: [] };
  }
}
async function writeMem(userId, mem) {
  await ensureDataDir();
  await fs.writeFile(memPath(userId), JSON.stringify(mem, null, 2), "utf8");
}

// ---------- Health ----------
app.get("/", (_req, res) => res.json({ ok: true, service: "backend", ts: Date.now() }));

// ---------- DB Health ----------
app.get("/db/health", async (_req, res) => {
  if (!ping) return res.status(503).json({ ok: false, error: "db_unavailable" });
  try {
    const now = await ping();
    res.json({ ok: true, now });
  } catch (e) {
    console.error("DB HEALTH ERROR:", e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});
app.get("/db/test", async (_req, res) => {
  if (!query) return res.status(503).json({ ok: false, error: "db_unavailable" });
  try {
    const r = await query("SELECT COUNT(*)::int AS users FROM users");
    res.json({ users: r.rows?.[0]?.users ?? 0 });
  } catch (e) {
    console.error("DB TEST ERROR:", e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ---------- /api/welcome (OpenAI) ----------
app.post("/api/welcome", async (req, res) => {
  try {
    const {
      lang = "es",
      name = "",
      sex = "",
      userId = "anon",
      history = [],
      localHour = null, hour = null, tzOffsetMinutes = null,
    } = req.body || {};

    const resolvedHour = Number.isInteger(localHour)
      ? localHour
      : resolveLocalHour({ hour, tzOffsetMinutes });

    const mem = await readMem(userId);
    const nm = String(name || mem.name || "").trim();
    const sx = String(sex || mem.sex || "").trim().toLowerCase();
    if (nm) mem.name = nm;
    if (sx === "male" || sx === "female") mem.sex = sx;
    await writeMem(userId, mem);

    let sal = nm ? `${greetingByHour(lang, resolvedHour)}, ${nm}.` : `${greetingByHour(lang, resolvedHour)}.`;
    if (Math.random() < 0.25) {
      if (mem.sex === "female") sal += " Hija mía,";
      else if (mem.sex === "male") sal += " Hijo mío,";
    }

    const W_SYS = `
Devuélveme SOLO un JSON en ${langLabel(lang)} con este esquema:
{"phrase":"<frase alentadora breve, suave, de autoestima, sin clichés ni tono duro>",
 "question":"<UNA pregunta íntima/acompañamiento (no cuestionario), distinta a '¿Qué te gustaría compartir hoy?'>"}
Condiciones:
- Evita fórmulas gastadas: nada de “cada pequeño paso cuenta” ni “camino hacia tus metas”.
- La pregunta invita a hablar (variada). 
- No incluyas nada fuera del JSON.
`.trim();

    let phrase = "";
    let question = "";
    try {
      const r = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.9,
        max_tokens: 180,
        messages: [
          { role: "system", content: W_SYS },
          ...(Array.isArray(history) ? history.slice(-6).map(h => ({ role: "user", content: String(h) })) : []),
          { role: "user", content: nm ? `Nombre del usuario: ${nm}` : "Usuario anónimo" }
        ],
        response_format: { type: "json_object" },
      });
      const content = r?.choices?.[0]?.message?.content || "{}";
      const data = JSON.parse(content);
      phrase = String(data?.phrase || "").trim();
      question = String(data?.question || "").trim();
    } catch {
      phrase = dayFallback(lang);
      question =
        lang === "en" ? "What would help you right now?" :
        lang === "pt" ? "Em que posso te acompanhar agora?" :
        lang === "it" ? "Di cosa vuoi parlare adesso?" :
        lang === "de" ? "Wobei kann ich dich jetzt begleiten?" :
        lang === "ca" ? "En què et puc acompanyar ara?" :
        lang === "fr" ? "De quoi veux-tu parler maintenant ?" :
                        "¿En qué te puedo acompañar ahora?";
    }

    const message = `${sal} ${phrase}`.replace(/\s+/g, " ").trim();
    res.json({ message, question });
  } catch (e) {
    console.error("WELCOME ERROR:", e);
    res.json({ message: "La paz sea contigo.", question: "¿En qué te puedo acompañar ahora?" });
  }
});

// ---------- /api/ask (OpenAI) ----------
const RELIGIOUS_ALLOW = [
  /\b(iglesia|templo|catedral|parroquia|misa|sacramento|oraci[oó]n|santuario|santo|santos|biblia|evangelio|rosario|confesi[oó]n|eucarist[ií]a|liturgia|vaticano|lourdes|f[aá]tima|peregrinaci[oó]n|camino de santiago)\b/i,
];
const OFFTOPIC = [
  /\b(f[úu]tbol|futbol|deporte|champions|nba|tenis|selecci[oó]n|mundial|goles?)\b/i,
  /\b(pel[ií]cula|serie|netflix|hbo|max|disney|spotify|cantante|concierto|celebridad|famos[oa]s?)\b/i,
  /\b(program(a|ar|aci[oó]n)|c[oó]digo|javascript|react|inform[aá]tica|computaci[oó]n|pc|ordenador|linux|windows|macos|driver|api|prompt)\b/i,
  /\b(ingenier[ií]a|software|hardware|servidor|cloud|nube|red(es)?|wifi|routing|docker|kubernetes)\b/i,
  /\b(matem[aá]ticas?|algebra|c[aá]lculo|geometr[ií]a|trigonometr[ií]a)\b/i,
  /\b(f[ií]sica|qu[ií]mica|biolog[ií]a|geolog[ií]a|astronom[ií]a|laboratorio)\b/i,
  /\b(mec[aá]nica|alternador|bater[ií]a del auto|motor|embrague|inyector|buj[ií]a|correa|nafta|diesel)\b/i,
  /\b(circuito|voltaje|ohmios|arduino|raspberry|microcontrolador|placa)\b/i,
  /\b(videojuego|fortnite|minecraft|playstation|xbox|nintendo|steam)\b/i,
  /\b(pa[ií]s|capital|mapa|d[oó]nde queda|ubicaci[oó]n|distancia|kil[oó]metros|frontera|r[íi]o|monta[ñn]a|cordillera)\b/i,
  /\b(viaje|hotel|playa|turismo|destino|vuelo|itinerario|tour|gu[ií]a tur[ií]stica)\b/i,
  /\b(gastronom[ií]a|cocina|recet(a|ario)s?|platos?|ingredientes?|men[uú]|postres?)\b/i,
  /\b(comida|almuerzo|cena|desayuno|merienda|calor[ií]as|nutrici[oó]n|dieta)\b/i,
  /\b(bebidas?|vino|cerveza|licor|c[oó]ctel|trago|caf[eé]|restaurante)\b/i,
  /\b(pol[ií]tica|elecci[oó]n|partido|diputado|senador|presidente|gobierno)\b/i,
  /\b(criptomonedas?|bitcoin|acciones|bolsa|nasdaq|d[oó]lar|euro)\b/i,
];
function isReligiousException(s) { return RELIGIOUS_ALLOW.some((r) => r.test(NORM(s))); }
function isOffTopic(s) { return OFFTOPIC.some((r) => r.test(NORM(s))); }
function isGibberish(s) {
  const x = (s || "").trim();
  if (!x) return true;
  if (x.length < 2) return true;
  const letters = (x.match(/[a-záéíóúüñàèìòùçâêîôûäëïöüß]/gi) || []).length;
  return letters < Math.ceil(x.length * 0.25);
}

app.post("/api/ask", async (req, res) => {
  try {
    const { message = "", history = [], userId = "anon", lang = "es" } = req.body || {};
    const userTxt = String(message || "").trim();

    const mem = await readMem(userId);
    const now = Date.now();

    if (userTxt && mem.last_user_text && userTxt === mem.last_user_text && now - mem.last_user_ts < 7000) {
      if (mem.last_bot) return res.json(mem.last_bot);
    }

    if (isGibberish(userTxt)) {
      const msg =
        lang === "en" ? "I didn’t quite get that. Could you say it again in a few words?" :
        lang === "pt" ? "Não entendi bem. Pode repetir em poucas palavras?" :
        lang === "it" ? "Non ho capito bene. Puoi ripetere in poche parole?" :
        lang === "de" ? "Ich habe es nicht ganz verstanden. Kannst du es in wenigen Worten wiederholen?" :
        lang === "ca" ? "No ho he entès del tot. Ho pots repetir en poques paraules?" :
        lang === "fr" ? "Je n’ai pas bien compris. Peux-tu répéter en quelques mots ?" :
                        "No te entendí bien. ¿Podés repetirlo en pocas palabras?";
      const out = { message: msg, question: "", bible: { text: "", ref: "" } };
      mem.last_user_text = userTxt; mem.last_user_ts = now; mem.last_bot = out;
      await writeMem(userId, mem);
      return res.json(out);
    }

    if (isOffTopic(userTxt) && !isReligiousException(userTxt)) {
      const msg =
        lang === "en" ? "I’m here for your inner life: faith, personal struggles and healing. I don’t give facts or opinions on sports, entertainment, technical, food or general topics." :
        lang === "pt" ? "Estou aqui para a sua vida interior: fé, questões pessoais e cura. Não trato esportes, entretenimento, técnica, gastronomia o temas gerais." :
        lang === "it" ? "Sono qui per la tua vida interiore: fede, difficoltà personali e guarigione. Non tratto sport, spettacolo, tecnica, gastronomia o temi generali." :
        lang === "de" ? "Ich bin für dein inneres Leben da: Glaube, persönliche Themen und Heilung. Keine Fakten/Meinungen zu Sport, Unterhaltung, Technik, Gastronomie oder Allgemeinwissen." :
        lang === "ca" ? "Sóc aquí per a la teva vida interior: fe, dificultats personals i sanació. No tracto esports, entreteniment, tècnica, gastronomia o temes generals." :
        lang === "fr" ? "Je suis là pour ta vie intérieure : foi, difficultés personnelles et guérison. Je ne traite pas le sport, le divertissement, la technique, la gastronomie ni les sujets généraux." :
                        "Estoy aquí para tu vida interior: fe, dificultades personales y sanación. No doy datos ni opiniones de deportes, espectáculos, técnica, gastronomía o temas generales.";
      const q =
        lang === "en" ? "What would help you most right now—your emotions, a relationship, or your prayer life?" :
        lang === "pt" ? "O que mais ajudaria agora — suas emoções, uma relação, ou a sua vida de oração?" :
        lang === "it" ? "Cosa ti aiuterebbe ora — le emozioni, una relazione o la tua vida di preghiera?" :
        lang === "de" ? "Was würde dir jetzt am meisten helfen – deine Gefühle, eine Beziehung oder dein Gebetsleben?" :
        lang === "ca" ? "Què t’ajudaria ara — les teves emocions, una relació o la teva vida de pregària?" :
        lang === "fr" ? "Qu’est-ce qui t’aiderait le plus — tes émotions, une relation ou ta vie de prière ?" :
                        "¿Qué te ayudaría ahora — tus emociones, una relación o tu vida de oración?";
      const out = { message: msg, question: q, bible: { text: "", ref: "" } };
      mem.last_user_text = userTxt; mem.last_user_ts = now; mem.last_bot = out;
      await writeMem(userId, mem);
      return res.json(out);
    }

    const SYS = `
Eres cercano, claro y compasivo, desde una voz cristiana (católica).
Alcance: espiritualidad/fe católica, psicología/autoayuda personal, relaciones y emociones. Evita lo demás.
Varía el lenguaje; no repitas muletillas. No hagas cuestionarios; 1 sola pregunta breve y pertinente.
Formato (JSON en ${langLabel(lang)}): {"message":"...", "question":"...?", "bible":{"text":"...","ref":"Libro 0:0"}}
- "message": natural y concreto.
- "question": **una** pregunta simple.
- "bible": SIEMPRE incluida; pertinente; NO Mateo/Matthew 11:28 (ninguna variante).
NO incluyas el versículo dentro de "message"; va SOLO en "bible".
No incluyas nada fuera del JSON.
`.trim();

    const convo = [];
    const recent = Array.isArray(history) ? history.slice(-8) : [];
    for (const h of recent) if (typeof h === "string") convo.push({ role: "user", content: h });
    convo.push({ role: "user", content: userTxt });

    const r = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.6,
      max_tokens: 380,
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

    const content = r?.choices?.[0]?.message?.content || "{}";
    let data = {};
    try { data = JSON.parse(content); } catch { data = {}; }

    let out = {
      message: String(data?.message || "").trim() || (lang === "en" ? "I’m with you." : "Estoy contigo."),
      question: String(data?.question || "").trim() || "",
      bible: {
        text: String(data?.bible?.text || "").trim(),
        ref:  String(data?.bible?.ref  || "").trim(),
      }
    };

    const banned = /mateo\s*11\s*:\s*28|matt(hew)?\s*11\s*:\s*28|matteo\s*11\s*:\s*28|matthäus\s*11\s*:\s*28|matthieu\s*11\s*:\s*28|mateu\s*11\s*:\s*28|mateus\s*11\s*:\s*28/i;
    const used = new Set((mem.last_refs || []).map((x) => NORM(x)));
    const invalid = !out.bible.text || !out.bible.ref || banned.test(out.bible.ref) || used.has(NORM(out.bible.ref));

    if (invalid) {
      const altSys = `
Devuélveme SOLO un JSON {"bible":{"text":"...","ref":"Libro 0:0"}} en ${langLabel(lang)}.
Cita bíblica pertinente al mensaje del usuario, evita Mateo/Matthew 11:28 y evita estas referencias ya usadas: ${Array.from(used).join(", ") || "ninguna"}.
No incluyas nada fuera del JSON. Texto exacto y referencia legible.
`.trim();

      try {
        const alt = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          temperature: 0.5,
          max_tokens: 180,
          messages: [
            { role: "system", content: altSys },
            { role: "user", content: userTxt }
          ],
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

        const altContent = alt?.choices?.[0]?.message?.content || "{}";
        let altData = {};
        try { altData = JSON.parse(altContent); } catch { altData = {}; }
        const t = String(altData?.bible?.text || "").trim();
        const r2 = String(altData?.bible?.ref || "").trim();
        if (t && r2 && !banned.test(r2) && !used.has(NORM(r2))) {
          out.bible = { text: t, ref: r2 };
        } else {
          out.bible = { text: "", ref: "" };
        }
      } catch {
        out.bible = { text: "", ref: "" };
      }
    }

    const finalRef = String(out?.bible?.ref || "").trim();
    if (finalRef) mem.last_refs = [...(mem.last_refs || []), finalRef].slice(-8);
    mem.last_user_text = userTxt;
    mem.last_user_ts = now;
    mem.last_bot = out;
    await writeMem(userId, mem);

    res.json(out);
  } catch (e) {
    console.error("ASK ERROR:", e);
    res.json({
      message: "La paz sea contigo. Decime en pocas palabras qué está pasando y vemos un paso simple y concreto.",
      question: "¿Qué te gustaría trabajar primero?",
      bible: { text: "", ref: "" }
    });
  }
});

// ====================================================
// ===============  RUTAS DE VOZ (XTTS)  ==============
// ====================================================

function _base(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host  = req.headers["x-forwarded-host"]  || req.get("host");
  return `${proto}://${host}`;
}

// Health del proxy + upstream FastAPI
app.get("/api/health", async (req, res) => {
  try {
    let upstream = null;
    try {
      const r = await fetch(`${VOZ_URL}/health`, { method: "GET", ...agentFor(VOZ_URL) });
      upstream = await r.json().catch(() => null);
    } catch (_) {}
    res.json({ ok: true, proxy: "node", voz_url: VOZ_URL, upstream });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e?.message || e) });
  }
});

// === Precargar TTS (llamar APENAS el usuario habilita audio en el front) ===
app.post("/api/voice/warmup", async (_req, res) => {
  try {
    const url = `${VOZ_URL}/tts?text=${encodeURIComponent("ok")}&lang=es&trim_db=0&gap_ms=0&fade_ms=0`;
    await fetch(url, { method: "GET", ...agentFor(VOZ_URL) });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Passthrough WAV directo (bufferizado controlado; simple)
app.get("/api/tts", async (req, res) => {
  try {
    const q = new URLSearchParams();
    if (req.query.text) q.set("text", String(req.query.text));
    if (req.query.lang) q.set("lang", String(req.query.lang));
    if (req.query.rate) q.set("rate", String(req.query.rate));
    if (req.query.temp) q.set("temp", String(req.query.temp));
    if (req.query.fx)   q.set("fx",   String(req.query.fx));
    if (req.query.t)    q.set("t",    String(req.query.t));
    if (req.query.seg_max) q.set("seg_max", String(req.query.seg_max));
    if (req.query.trim_db) q.set("trim_db", String(req.query.trim_db));
    if (req.query.gap_ms)  q.set("gap_ms",  String(req.query.gap_ms));
    if (req.query.fade_ms) q.set("fade_ms", String(req.query.fade_ms));
    if (req.query.mode)    q.set("mode",    String(req.query.mode));

    const url = `${VOZ_URL}/tts?${q.toString()}`;
    const up  = await fetch(url, { headers: { Accept: "audio/wav" }, ...agentFor(VOZ_URL) });
    const ct = up.headers.get("content-type") || "audio/wav";
    const ab = await up.arrayBuffer();
    const buf = Buffer.from(ab);

    res.status(up.status).set("Content-Type", ct);
    res.set("Access-Control-Allow-Origin", "*");
    res.send(buf);
  } catch (e) {
    res.status(500).send("proxy_tts_error: " + String(e?.message || e));
  }
});

// Descarga del WAV: /api/files/:name —> STREAMING (sin buffer)
app.get("/api/files/:name", async (req, res) => {
  try {
    const name = String(req.params.name || "");
    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
      return res.status(400).send("bad_name");
    }

    const upstream = await fetch(`${VOZ_URL}/files/${encodeURIComponent(name)}`, {
      method: "GET",
      headers: { Accept: "audio/wav" },
      ...agentFor(VOZ_URL),
    });

    res.status(upstream.status);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "audio/wav");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("Transfer-Encoding", "chunked");
    res.setHeader("Content-Encoding", "identity");
    res.flushHeaders?.();

    if (upstream.body) {
      const nodeStream = Readable.fromWeb ? Readable.fromWeb(upstream.body) : Readable.from(upstream.body);
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (e) {
    res.status(500).send("files_proxy_error: " + String(e?.message || e));
  }
});

// Pull segmentado (descarga lista de parts)
app.get("/api/voice/segment", async (req, res) => {
  try {
    const text   = (req.query.text || "").toString();
    const lang   = (req.query.lang || "es").toString();
    const rate   = (req.query.rate || "1.0").toString();
    const segMax = (req.query.seg_max || "60").toString();
    const trimDb = (req.query.trim_db || "0").toString();
    const gapMs  = (req.query.gap_ms || "0").toString();
    const fadeMs = (req.query.fade_ms || "0").toString();

    const url = `${VOZ_URL}/tts_save_segmented?` +
      `text=${encodeURIComponent(text)}&lang=${encodeURIComponent(lang)}` +
      `&rate=${encodeURIComponent(rate)}&seg_max=${encodeURIComponent(segMax)}` +
      `&trim_db=${encodeURIComponent(trimDb)}&gap_ms=${encodeURIComponent(gapMs)}` +
      `&fade_ms=${encodeURIComponent(fadeMs)}`;

    const r = await fetch(url, { method: "GET", headers: { Accept: "application/json" }, ...agentFor(VOZ_URL) });
    const j = await r.json();
    if (!r.ok || !j?.ok || !Array.isArray(j?.parts)) {
      return res.status(r.ok ? 502 : r.status).json({ ok: false, error: "segment_failed", detail: j || {} });
    }

    const base = _base(req);
    const parts = j.parts.map((u) => {
      const name = String(u || "").split("/").pop();
      return name ? `${base}/api/files/${name}` : u;
    });

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json({ ok: true, chunks: parts.length, ttfb_ms: j.ttfb_ms || 0, parts });
  } catch (e) {
    console.error("segment_error:", e);
    res.status(500).json({ ok: false, error: "segment_error", detail: String(e) });
  }
});

// === PROXY SSE: /api/tts_stream_segmented  (baja latencia, sin buffering) ===
app.get("/api/tts_stream_segmented", async (req, res) => {
  req.socket?.setNoDelay?.(true);
  res.socket?.setNoDelay?.(true);

  // Cabeceras SSE sin buffering (importante para TTFB bajo)
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Content-Encoding", "identity");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Transfer-Encoding", "chunked");
  res.flushHeaders?.();

  // Padding anti-buffer + ping inmediato
  res.write(":" + " ".repeat(2048) + "\n");
  res.write(`event: ping\ndata: {"ts":${Date.now()}}\n\n`);
  res.flush?.();

  const hb = setInterval(() => {
    try { res.write(`event: ping\ndata: {"ts":${Date.now()}}\n\n`); res.flush?.(); } catch {}
  }, 2000);

  const url = new URL("/tts_stream_segmented", VOZ_URL);
  for (const [k, v] of Object.entries(req.query)) url.searchParams.set(k, String(v));

  const controller = new AbortController();
  req.on("close", () => controller.abort());

  try {
    const upstream = await fetch(url.toString(), {
      method: "GET",
      headers: { Accept: "text/event-stream" },
      signal: controller.signal,
      ...agentFor(VOZ_URL),
    });

    if (!upstream.ok || !upstream.body) {
      res.status(upstream.status || 502);
      res.write(`data: ${JSON.stringify({ event: "error", status: upstream.status || 502 })}\n\n`);
      return res.end();
    }

    const decoder = new TextDecoder();
    let carry = "";
    const base = _base(req);

    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      carry += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = carry.indexOf("\n")) >= 0) {
        const line = carry.slice(0, idx);
        carry = carry.slice(idx + 1);

        if (line.startsWith("data:")) {
          const raw = line.slice(5).trimStart();
          try {
            const obj = JSON.parse(raw);
            if (obj && typeof obj === "object" && typeof obj.url === "string") {
              const name = obj.url.split("/").pop();
              if (name && /^[A-Za-z0-9._-]+$/.test(name)) {
                obj.url = `${base}/api/files/${name}`;
              }
            }
            res.write(`data: ${JSON.stringify(obj)}\n\n`);
          } catch {
            res.write(line + "\n");
          }
        } else {
          res.write(line + "\n");
        }
      }
      res.flush?.();
    }

    if (carry) res.write(carry);
    res.end();
  } catch (e) {
    try {
      res.write(`data: ${JSON.stringify({ event: "error", detail: String(e?.message || e) })}\n\n`);
    } finally {
      res.end();
    }
  } finally {
    clearInterval(hb);
  }
});

// ====== /api/memory/sync (noop persistente para el front) ======
app.post("/api/memory/sync", async (req, res) => {
  try {
    const body = req.body || {};
    const userId = String(body.userId || "anon");
    const payload = body.memory ?? body;

    const safe = userId.replace(/[^a-z0-9_-]/gi, "_");
    const file = path.join(DATA_DIR, `frontend_mem_${safe}.json`);
    await ensureDataDir();
    await fs.writeFile(
      file,
      JSON.stringify({ ts: Date.now(), payload }, null, 2),
      "utf8"
    );

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json({ ok: true, saved: true });
  } catch (e) {
    console.error("MEMORY_SYNC_ERROR:", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ---------- Arranque ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor listo en puerto ${PORT}`));
