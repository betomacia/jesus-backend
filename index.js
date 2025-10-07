// index.js — Backend monolítico, dominios acotados y respuestas naturales (multi-idioma)
// Esta versión es AUTOCONTENIDA (sin require de ./service/welcometext)
// - /api/welcome: Saludo por hora + nombre + (opcional hijo/hija 25%) + 1 frase IA + 1 pregunta IA (variada, íntima)
// - /api/ask: TODA la Biblia viene de OpenAI. Si es inválida/repetida/prohibida, se pide una alternativa a OpenAI.
// - VOZ (XTTS FastAPI): /api/tts, /api/tts_save, /api/tts_save_segmented, /api/files/:name, /api/voice/diag
// - Se eliminaron rutas de HeyGen/ElevenLabs.

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const OpenAI = require("openai");
const path = require("path");
const fs = require("fs/promises");
const { query, ping } = require("./db/pg");

// Node 18+ tiene fetch global, pero usamos node-fetch v2 por compatibilidad estricta
const fetch = require("node-fetch");

// ---------------- VOZ (FastAPI) ----------------
const VOZ_URL = process.env.VOZ_URL || "http://136.114.108.182:8000";

// ---------------- App ----------------
const app = express();
app.use(cors({ origin: true }));
app.use(bodyParser.json());

// ---------- OpenAI ----------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------- Utils ----------
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

// Hora local: si el móvil manda `hour` (0-23) o tzOffsetMinutes (min respecto a UTC).
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

// Fallbacks mínimos (solo por si OpenAI falla por completo)
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
  pt: [
    "Um passo sincero hoje abre caminhos.",
  ],
  it: [
    "Un passo sincero oggi apre la strada.",
  ],
  de: [
    "Ein ehrlicher Schritt heute öffnet Wege.",
  ],
  ca: [
    "Un pas sincer avui obre camins.",
  ],
  fr: [
    "Un pas sincère aujourd’hui ouvre la voie.",
  ],
};

function dayFallback(lang = "es") {
  const arr = DAILY_FALLBACKS[lang] || DAILY_FALLBACKS["es"];
  return arr[Math.floor(Math.random() * arr.length)];
}

// ---------- Memoria en FS (simple) ----------
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
async function ensureDataDir() { try { await fs.mkdir(DATA_DIR, { recursive: true }); } catch (e) {} }
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
      sex: m.sex || "", // "male" | "female" | "" (unknown)
      last_user_text: m.last_user_text || "",
      last_user_ts: m.last_user_ts || 0,
      last_bot: m.last_bot || null,
      last_refs: Array.isArray(m.last_refs) ? m.last_refs : [],
    };
  } catch (e) {
    return {
      name: "",
      sex: "",
      last_user_text: "",
      last_user_ts: 0,
      last_bot: null,
      last_refs: [],
    };
  }
}
async function writeMem(userId, mem) {
  await ensureDataDir();
  await fs.writeFile(memPath(userId), JSON.stringify(mem, null, 2), "utf8");
}

// ---------- Filtros de alcance ----------
const OFFTOPIC = [
  // entretenimiento/deporte/celebridades
  /\b(f[úu]tbol|futbol|deporte|champions|nba|tenis|selecci[oó]n|mundial|goles?)\b/i,
  /\b(pel[ií]cula|serie|netflix|hbo|max|disney|spotify|cantante|concierto|celebridad|famos[oa]s?)\b/i,

  // técnica/ciencia/educación (ampliado)
  /\b(program(a|ar|aci[oó]n)|c[oó]digo|javascript|react|inform[aá]tica|computaci[oó]n|pc|ordenador|linux|windows|macos|driver|api|prompt)\b/i,
  /\b(ingenier[ií]a|software|hardware|servidor|cloud|nube|red(es)?|wifi|routing|docker|kubernetes)\b/i,
  /\b(matem[aá]ticas?|algebra|c[aá]lculo|geometr[ií]a|trigonometr[ií]a)\b/i,
  /\b(f[ií]sica|qu[ií]mica|biolog[ií]a|geolog[ií]a|astronom[ií]a|laboratorio)\b/i,

  // mecánica/electrónica/juegos
  /\b(mec[aá]nica|alternador|bater[ií]a del auto|motor|embrague|inyector|buj[ií]a|correa|nafta|diesel)\b/i,
  /\b(circuito|voltaje|ohmios|arduino|raspberry|microcontrolador|placa)\b/i,
  /\b(videojuego|fortnite|minecraft|playstation|xbox|nintendo|steam)\b/i,

  // geografía/turismo no religioso
  /\b(pa[ií]s|capital|mapa|d[oó]nde queda|ubicaci[oó]n|distancia|kil[oó]metros|frontera|r[íi]o|monta[ñn]a|cordillera)\b/i,
  /\b(viaje|hotel|playa|turismo|destino|vuelo|itinerario|tour|gu[ií]a tur[ií]stica)\b/i,

  // gastronomía / comidas / bebidas
  /\b(gastronom[ií]a|gastronomia|cocina|recet(a|ario)s?|platos?|ingredientes?|men[uú]|men[uú]s|postres?|dulces?|salado?s?)\b/i,
  /\b(comida|comidas|almuerzo|cena|desayuno|merienda|vianda|raci[oó]n|calor[ií]as|nutrici[oó]n|dieta)\b/i,
  /\b(bebidas?|vino|cerveza|licor|coctel|c[oó]ctel|trago|fermentado|maridaje|bar|caf[eé]|cafeter[ií]a|restaurante|restaurantes?)\b/i,

  // política/negocios/finanzas
  /\b(pol[ií]tica|elecci[oó]n|partido|diputado|senador|presidente|gobierno)\b/i,
  /\b(criptomonedas?|bitcoin|acciones|bolsa|nasdaq|d[oó]lar|euro)\b/i,
];

const RELIGIOUS_ALLOW = [
  /\b(iglesia|templo|catedral|parroquia|misa|sacramento|oraci[oó]n|santuario|santo|santos|biblia|evangelio|rosario|confesi[oó]n|eucarist[ií]a|liturgia|vaticano|lourdes|f[aá]tima|peregrinaci[oó]n|camino de santiago)\b/i,
];

function isReligiousException(s) {
  const x = NORM(s);
  return RELIGIOUS_ALLOW.some((r) => r.test(x));
}
function isOffTopic(s) {
  const x = NORM(s);
  return OFFTOPIC.some((r) => r.test(x));
}

function isGibberish(s) {
  const x = (s || "").trim();
  if (!x) return true;
  if (x.length < 2) return true;
  const letters = (x.match(/[a-záéíóúüñàèìòùçâêîôûäëïöüß]/gi) || []).length;
  return letters < Math.ceil(x.length * 0.25);
}

// ---------- Health ----------
app.get("/", (_req, res) => res.json({ ok: true, service: "backend", ts: Date.now() }));

// ---------- DB Health ----------
app.get("/db/health", async (_req, res) => {
  try {
    const now = await ping();
    res.json({ ok: true, now });
  } catch (e) {
    console.error("DB HEALTH ERROR:", e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// (Opcional) Conteo rápido de usuarios
app.get("/db/test", async (_req, res) => {
  try {
    const r = await query("SELECT COUNT(*)::int AS users FROM users");
    res.json({ users: r.rows?.[0]?.users ?? 0 });
  } catch (e) {
    console.error("DB TEST ERROR:", e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ---------- /api/welcome ----------
app.post("/api/welcome", async (req, res) => {
  try {
    const {
      lang = "es",
      name = "",
      sex = "",
      userId = "anon",
      history = [],
      localHour = null, // opcional directo
      hour = null,      // compat
      tzOffsetMinutes = null, // compat
    } = req.body || {};

    const resolvedHour = Number.isInteger(localHour)
      ? localHour
      : resolveLocalHour({ hour, tzOffsetMinutes });

    // persistir nombre/sexo
    const mem = await readMem(userId);
    const nm = String(name || mem.name || "").trim();
    const sx = String(sex || mem.sex || "").trim().toLowerCase(); // male|female|""
    if (nm) mem.name = nm;
    if (sx === "male" || sx === "female") mem.sex = sx;
    await writeMem(userId, mem);

    // saludo + nombre
    let sal = nm ? `${greetingByHour(lang, resolvedHour)}, ${nm}.` : `${greetingByHour(lang, resolvedHour)}.`;

    // 25% "Hijo/Hija mío/a" si hay sex
    if (Math.random() < 0.25) {
      if (mem.sex === "female") sal += " Hija mía,";
      else if (mem.sex === "male") sal += " Hijo mío,";
    }

    // Pedimos a OpenAI: 1 frase breve + 1 pregunta variada (ambas en JSON)
    const W_SYS = `
Devuélveme SOLO un JSON en ${langLabel(lang)} con este esquema:
{"phrase":"<frase alentadora breve, suave, de autoestima, sin clichés ni tono duro>",
 "question":"<UNA pregunta íntima/acompañamiento (no cuestionario), distinta a '¿Qué te gustaría compartir hoy?'>"}
Condiciones:
- Evita fórmulas gastadas: nada de “cada pequeño paso cuenta” ni “camino hacia tus metas”.
- La pregunta invita a hablar (“¿Querés que te escuche?”, “¿Cómo te gustaría empezar?”, “¿Preferís contarme algo sencillo?”… pero NO repitas literal estos ejemplos).
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
    } catch (e) {
      // fallbacks mínimos si OpenAI falla
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
    res.json({
      message: "La paz sea contigo.",
      question: "¿En qué te puedo acompañar ahora?",
    });
  }
});

// ---------- /api/ask ----------
app.post("/api/ask", async (req, res) => {
  try {
    const { message = "", history = [], userId = "anon", lang = "es" } = req.body || {};
    const userTxt = String(message || "").trim();

    const mem = await readMem(userId);
    const now = Date.now();

    // Duplicados rápidos (mismo texto en <7s)
    if (userTxt && mem.last_user_text && userTxt === mem.last_user_text && now - mem.last_user_ts < 7000) {
      if (mem.last_bot) return res.json(mem.last_bot);
    }

    // Ruido
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

    // Alcance
    if (isOffTopic(userTxt) && !isReligiousException(userTxt)) {
      const msg =
        lang === "en" ? "I’m here for your inner life: faith, personal struggles and healing. I don’t give facts or opinions on sports, entertainment, technical, food or general topics." :
        lang === "pt" ? "Estou aqui para a sua vida interior: fé, questões pessoais e cura. Não trato esportes, entretenimento, técnica, gastronomia ou temas gerais." :
        lang === "it" ? "Sono qui per la tua vita interiore: fede, difficoltà personali e guarigione. Non tratto sport, spettacolo, tecnica, gastronomia o temi generali." :
        lang === "de" ? "Ich bin für dein inneres Leben da: Glaube, persönliche Themen und Heilung. Keine Fakten/Meinungen zu Sport, Unterhaltung, Technik, Gastronomie oder Allgemeinwissen." :
        lang === "ca" ? "Sóc aquí per a la teva vida interior: fe, dificultats personals i sanació. No tracto esports, entreteniment, tècnica, gastronomia o temes generals." :
        lang === "fr" ? "Je suis là pour ta vie intérieure : foi, difficultés personnelles et guérison. Je ne traite pas le sport, le divertissement, la technique, la gastronomie ni les sujets généraux." :
                        "Estoy aquí para tu vida interior: fe, dificultades personales y sanación. No doy datos ni opiniones de deportes, espectáculos, técnica, gastronomía o temas generales.";
      const q =
        lang === "en" ? "What would help you most right now—your emotions, a relationship, or your prayer life?" :
        lang === "pt" ? "O que mais ajudaria agora — suas emoções, uma relação, ou a sua vida de oração?" :
        lang === "it" ? "Cosa ti aiuterebbe ora — le emozioni, una relazione o la tua vita di preghiera?" :
        lang === "de" ? "Was würde dir jetzt am meisten helfen – deine Gefühle, eine Beziehung oder dein Gebetsleben?" :
        lang === "ca" ? "Què t’ajudaria ara — les teves emocions, una relació o la teva vida de pregària?" :
        lang === "fr" ? "Qu’est-ce qui t’aiderait le plus — tes émotions, une relation ou ta vie de prière ?" :
                        "¿Qué te ayudaría ahora — tus emociones, una relación o tu vida de oración?";
      const out = { message: msg, question: q, bible: { text: "", ref: "" } };
      mem.last_user_text = userTxt; mem.last_user_ts = now; mem.last_bot = out;
      await writeMem(userId, mem);
      return res.json(out);
    }

    // -------- OpenAI principal (message + question + bible) --------
    const SYS = `
Eres cercano, claro y compasivo, desde una voz cristiana (católica).
Alcance: espiritualidad/fe católica, psicología/autoayuda personal, relaciones y emociones. Evita lo demás.
Varía el lenguaje; no repitas muletillas. No hagas cuestionarios; 1 sola pregunta breve y pertinente.
Formato (JSON en ${langLabel(lang)}): {"message":"...", "question":"...?", "bible":{"text":"...","ref":"Libro 0:0"}}
- "message": natural y concreto; si el usuario pide pasos, dáselos con claridad breve.
- "question": **una** pregunta simple y útil (sin interrogar de más).
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
    try { data = JSON.parse(content); } catch (e) { data = {}; }

    let out = {
      message: String(data?.message || "").trim() || (lang === "en" ? "I’m with you." : "Estoy contigo."),
      question: String(data?.question || "").trim() || "",
      bible: {
        text: String(data?.bible?.text || "").trim(),
        ref:  String(data?.bible?.ref  || "").trim(),
      }
    };

    // Validación de la cita (prohibida + repetida)
    const banned = /mateo\s*11\s*:\s*28|matt(hew)?\s*11\s*:\s*28|matteo\s*11\s*:\s*28|matthäus\s*11\s*:\s*28|matthieu\s*11\s*:\s*28|mateu\s*11\s*:\s*28|mateus\s*11\s*:\s*28/i;
    const used = new Set((mem.last_refs || []).map((x) => NORM(x)));
    const invalid =
      !out.bible.text ||
      !out.bible.ref ||
      banned.test(out.bible.ref) ||
      used.has(NORM(out.bible.ref));

    if (invalid) {
      // Pedimos SOLO una alternativa de Biblia a OpenAI (sin listas fijas)
      const altSys = `
Devuélveme SOLO un JSON {"bible":{"text":"...","ref":"Libro 0:0"}} en ${langLabel(lang)}.
Cita bíblica pertinente al siguiente mensaje del usuario, evita Mateo/Matthew 11:28 y evita estas referencias ya usadas: ${Array.from(used).join(", ") || "ninguna"}.
No incluyas nada fuera del JSON. Texto exacto de la Biblia y su referencia legible.
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
        try { altData = JSON.parse(altContent); } catch (e) { altData = {}; }
        const t = String(altData?.bible?.text || "").trim();
        const r2 = String(altData?.bible?.ref || "").trim();
        if (t && r2 && !banned.test(r2) && !used.has(NORM(r2))) {
          out.bible = { text: t, ref: r2 };
        } else {
          out.bible = { text: "", ref: "" };
        }
      } catch (e) {
        out.bible = { text: "", ref: "" };
      }
    }

    // Persistimos refs válidas (solo si hay ref)
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

const { URLSearchParams } = require("url");

// base URL del request (para reescribir URLs del upstream)
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
      const r = await fetch(`${VOZ_URL}/health`, { timeout: 8000 });
      upstream = await r.json().catch(() => null);
    } catch(_) {}
    res.json({ ok: true, proxy: "railway", voz_url: VOZ_URL, upstream });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e.message || e) });
  }
});

// /api/tts -> proxy streaming WAV (no fija Content-Length para chunked)
app.get("/api/tts", async (req, res) => {
  try {
    const q = new URLSearchParams();
    if (req.query.text) q.set("text", String(req.query.text));
    if (req.query.lang) q.set("lang", String(req.query.lang));
    if (req.query.rate) q.set("rate", String(req.query.rate));
    if (req.query.temp) q.set("temp", String(req.query.temp));   // opcional
    if (req.query.fx)   q.set("fx",   String(req.query.fx));     // opcional
    if (req.query.t)    q.set("t",    String(req.query.t));      // opcional

    const url = `${VOZ_URL}/tts?${q.toString()}`;
    const up  = await fetch(url, { headers: { Accept: "audio/wav" } });

    res.status(up.status);
    res.set("Content-Type", up.headers.get("content-type") || "audio/wav");
    up.body.pipe(res);
  } catch (e) {
    res.status(500).send("proxy_tts_error: " + String(e.message || e));
  }
});

// /api/tts_save -> JSON con url reescrita a /api/files/:name
app.get("/api/tts_save", async (req, res) => {
  try {
    const q = new URLSearchParams();
    q.set("text", String(req.query.text || "Hola"));
    q.set("lang", String(req.query.lang || "es"));
    if (req.query.rate) q.set("rate", String(req.query.rate));
    if (req.query.temp) q.set("temp", String(req.query.temp));
    if (req.query.fx)   q.set("fx",   String(req.query.fx));
    if (req.query.t)    q.set("t",    String(req.query.t));

    const r = await fetch(`${VOZ_URL}/tts_save?${q.toString()}`, {
      headers: { Accept: "application/json" }
    });
    const j = await r.json();
    if (!j || !j.ok || !(j.url || j.file || j.path)) {
      return res.status(502).json({ ok:false, error:"upstream_invalid" });
    }
    const upstreamUrl = j.url || j.file || j.path;
    const name = upstreamUrl.split("/").pop();
    if (!name) return res.status(502).json({ ok:false, error:"filename_missing" });

    const mine = `${_base(req)}/api/files/${name}`;
    res.json({ ok: true, url: mine, file: mine, path: mine });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e.message || e) });
  }
});

// /api/tts_save_segmented -> JSON con múltiples partes
// Ej: /api/tts_save_segmented?text=...&lang=es&rate=1.00&seg_max=120
app.get("/api/tts_save_segmented", async (req, res) => {
  try {
    const q = new URLSearchParams();
    q.set("text", String(req.query.text || "Hola"));
    q.set("lang", String(req.query.lang || "es"));
    if (req.query.rate)    q.set("rate",    String(req.query.rate));
    if (req.query.seg_max) q.set("seg_max", String(req.query.seg_max));

    const r = await fetch(`${VOZ_URL}/tts_save_segmented?${q.toString()}`, {
      headers: { Accept: "application/json" }
    });
    const j = await r.json();
    if (!j || !j.ok || !Array.isArray(j.parts)) {
      return res.status(502).json({ ok:false, error:"upstream_invalid" });
    }

    // reescribimos cada URL a nuestro dominio /api/files/:name
    const base = _base(req);
    const parts = j.parts.map((u) => {
      const name = String(u || "").split("/").pop();
      return name ? `${base}/api/files/${name}` : u;
    });

    res.json({ ok: true, chunks: parts.length, ttfb_ms: j.ttfb_ms || 0, parts });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e.message || e) });
  }
});

// Descarga del WAV: /api/files/:name (proxy a FastAPI)
app.get("/api/files/:name", async (req, res) => {
  try {
    const name = String(req.params.name || "");
    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
      return res.status(400).send("bad_name");
    }
    const r = await fetch(`${VOZ_URL}/files/${encodeURIComponent(name)}`);
    if (!r.ok) return res.status(r.status).send("upstream_error");

    res.status(r.status);
    res.set("Content-Type", r.headers.get("content-type") || "audio/wav");
    const len = r.headers.get("content-length");
    if (len) res.set("Content-Length", len);
    r.body.pipe(res);
  } catch (e) {
    res.status(500).send("files_proxy_error: " + String(e.message || e));
  }
});

// --- Passthrough: segmentado XTTS vía backend ---
const fetch = require("node-fetch"); // ya está en package.json, v2.x

app.get("/api/voice/segment", async (req, res) => {
  try {
    const VOZ = (process.env.VOZ_URL || "").replace(/\/+$/, "");
    if (!VOZ) return res.status(500).json({ ok: false, error: "missing_VOZ_URL" });

    const text   = (req.query.text || "").toString();
    const lang   = (req.query.lang || "es").toString();
    const rate   = (req.query.rate || "1.0").toString();
    const segMax = (req.query.seg_max || "60").toString();

    const url = `${VOZ}/tts_save_segmented?` +
      `text=${encodeURIComponent(text)}&lang=${encodeURIComponent(lang)}&rate=${encodeURIComponent(rate)}&seg_max=${encodeURIComponent(segMax)}`;

    const r = await fetch(url, { timeout: 60000 }); // 60s
    const json = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json({ ok: false, error: "segment_failed", detail: json });

    // Devuelvo tal cual para el front:
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json(json);
  } catch (e) {
    console.error("segment_passthrough_error:", e);
    res.status(500).json({ ok: false, error: "segment_error", detail: String(e) });
  }
});


// Diagnóstico rápido: /api/voice/diag
app.get("/api/voice/diag", async (req, res) => {
  const text = String(req.query.text || "hola");
  const lang = String(req.query.lang || "es");
  async function probe() {
    const u = `${VOZ_URL}/tts?` + new URLSearchParams({ text, lang }).toString();
    const t0 = Date.now();
    try {
      const r = await fetch(u, { headers: { Accept: "audio/wav" } });
      const t1 = Date.now();
      let sampled = 0;
      if (r.ok && r.body) {
        await new Promise((resolve) => {
          let done = false;
          r.body.on("data", (chunk) => {
            if (done) return;
            sampled += chunk.length || 0;
            done = true; resolve();
          });
          r.body.on("end", resolve);
          r.body.on("error", resolve);
        });
      }
      return { ok: r.ok, status: r.status, first_byte_ms: t1 - t0, sampled_bytes: sampled, provider_used: "xtts" };
    } catch (e) {
      return { ok:false, status:0, first_byte_ms:-1, sampled_bytes:0, error:String(e.message || e) };
    }
  }
  const xtts = await probe();
  res.json({ ok: true, xtts, voz_url: VOZ_URL });
});

// ---------- Arranque ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor listo en puerto ${PORT}`));

