// index.js — Backend monolítico, estable y sin imports externos a rutas
// Arranca incluso si faltan otras carpetas/archivos.
// Node 18+ (tiene fetch global). CommonJS.

const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const OpenAI = require("openai");
const path = require("path");
const fs = require("fs/promises");
require("dotenv").config();

// ---- (Opcional DB) si no tenés db/pg, podés comentar estas 2 líneas y los endpoints /db/*:
let query = async () => ({ rows: [] });
let ping = async () => Date.now();
try {
  const db = require("./db/pg");
  query = db.query || query;
  ping = db.ping || ping;
} catch { /* sin DB */ }

const app = express();
app.use(cors({ origin: true }));
app.use(bodyParser.json());

// ---------- OpenAI ----------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------- Utils/Memory (inline) ----------
const NORM = (s = "") => String(s).toLowerCase().replace(/\s+/g, " ").trim();

function langLabel(l = "es") {
  const m = { es: "Español", en: "English", pt: "Português", it: "Italiano", de: "Deutsch", ca: "Català", fr: "Français" };
  return m[l] || "Español";
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

// Fallback de versículos (por idioma)
const FALLBACK_VERSES = {
  es: [
    { ref: "Salmos 34:18", text: "Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu." },
    { ref: "Isaías 41:10", text: "No temas, porque yo estoy contigo; no desmayes, porque yo soy tu Dios que te esfuerzo; siempre te ayudaré." },
    { ref: "Salmo 23:1",  text: "El Señor es mi pastor; nada me faltará." },
    { ref: "Romanos 12:12", text: "Gozosos en la esperanza; sufridos en la tribulación; constantes en la oración." },
  ],
  en: [
    { ref: "Psalm 34:18", text: "The Lord is close to the brokenhearted and saves those who are crushed in spirit." },
    { ref: "Isaiah 41:10", text: "Do not fear, for I am with you; do not be dismayed, for I am your God." },
    { ref: "Psalm 23:1", text: "The Lord is my shepherd; I shall not want." },
    { ref: "Romans 12:12", text: "Be joyful in hope, patient in affliction, faithful in prayer." },
  ],
  pt: [
    { ref: "Salmos 34:18", text: "Perto está o Senhor dos que têm o coração quebrantado; e salva os contritos de espírito." },
    { ref: "Isaías 41:10", text: "Não temas, porque eu sou contigo; não te assombres, porque eu sou teu Deus." },
  ],
  it: [
    { ref: "Salmo 34:18", text: "Il Signore è vicino a chi ha il cuore spezzato; egli salva gli spiriti affranti." },
    { ref: "Isaia 41:10", text: "Non temere, perché io sono con te; non smarrirti, perché io sono il tuo Dio." },
  ],
  de: [
    { ref: "Psalm 34:18", text: "Der HERR ist nahe denen, die zerbrochenen Herzens sind." },
    { ref: "Jesaja 41:10", text: "Fürchte dich nicht, denn ich bin mit dir." },
  ],
  ca: [
    { ref: "Salm 34:19 (cat)", text: "El Senyor és a prop dels cors trencats, salva els que tenen l’esperit abatut." },
    { ref: "Isaïes 41:10", text: "No tinguis por, que jo sóc amb tu; no t’esglaiïs, que jo sóc el teu Déu." },
  ],
  fr: [
    { ref: "Psaume 34:19", text: "L’Éternel est près de ceux qui ont le cœur brisé; il sauve ceux qui ont l’esprit dans l’abattement." },
    { ref: "Ésaïe 41:10", text: "Ne crains rien, car je suis avec toi." },
  ],
};
function pickFallbackVerse(lang = "es", avoidSet = new Set()) {
  const list = FALLBACK_VERSES[lang] || FALLBACK_VERSES["es"];
  for (const v of list) if (!avoidSet.has(NORM(v.ref))) return v;
  return list[0];
}

// Filtros de alcance reforzados
const OFFTOPIC = [
  // entretenimiento/deporte/celebridades
  /\b(f[úu]tbol|futbol|deporte|champions|nba|tenis|selecci[oó]n|mundial|goles?)\b/i,
  /\b(pel[ií]cula|serie|netflix|hbo|max|disney|spotify|cantante|concierto|celebridad|famos[oa]s?)\b/i,

  // técnica/ciencia/educación
  /\b(program(a|ar|aci[oó]n)|c[oó]digo|javascript|react|inform[aá]tica|computaci[oó]n|pc|ordenador|linux|windows|red(es)?|wifi|driver|api|prompt|base de datos|docker|kubernetes|github)\b/i,
  /\b(matem[aá]ticas?|algebra|c[aá]lculo|geometr[ií]a|f[ií]sica|qu[ií]mica|biolog[ií]a|cient[ií]fico|ecuaci[oó]n|derivadas?|integrales?)\b/i,

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
function isReligiousException(s) { const x = NORM(s); return RELIGIOUS_ALLOW.some((r) => r.test(x)); }
function isOffTopic(s) { const x = NORM(s); return OFFTOPIC.some((r) => r.test(x)); }
function isGibberish(s) {
  const x = (s || "").trim();
  if (!x) return true;
  if (x.length < 2) return true;
  const letters = (x.match(/[a-záéíóúüñàèìòùçâêîôûäëïöüß]/gi) || []).length;
  return letters < Math.ceil(x.length * 0.25);
}

// Memoria FS
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
async function ensureDataDir() { try { await fs.mkdir(DATA_DIR, { recursive: true }); } catch {} }
function memPath(uid) { const safe = String(uid || "anon").replace(/[^a-z0-9_-]/gi, "_"); return path.join(DATA_DIR, `mem_${safe}.json`); }
async function readMem(userId) {
  await ensureDataDir();
  try {
    const raw = await fs.readFile(memPath(userId), "utf8");
    const m = JSON.parse(raw);
    return {
      last_user_text: m.last_user_text || "",
      last_user_ts: m.last_user_ts || 0,
      last_bot: m.last_bot || null,
      last_refs: Array.isArray(m.last_refs) ? m.last_refs : [],
      sex: m.sex || "neutral",
      name: m.name || "",
    };
  } catch {
    return { last_user_text: "", last_user_ts: 0, last_bot: null, last_refs: [], sex: "neutral", name: "" };
  }
}
async function writeMem(userId, mem) {
  await ensureDataDir();
  await fs.writeFile(memPath(userId), JSON.stringify(mem, null, 2), "utf8");
}

// ---------- DB Health ----------
app.get("/db/health", async (_req, res) => {
  try { const now = await ping(); res.json({ ok: true, now }); }
  catch (e) { console.error("DB HEALTH ERROR:", e); res.status(500).json({ ok: false, error: String(e) }); }
});
app.get("/db/test", async (_req, res) => {
  try { const r = await query("SELECT COUNT(*)::int AS users FROM users"); res.json({ users: r.rows?.[0]?.users ?? 0 }); }
  catch (e) { console.error("DB TEST ERROR:", e); res.status(500).json({ ok: false, error: String(e) }); }
});

// ---------- Health ----------
app.get("/", (_req, res) => res.json({ ok: true, service: "backend", ts: Date.now() }));

// ---------- /api/welcome ----------
app.post("/api/welcome", async (req, res) => {
  try {
    const { lang = "es", name = "", sex = "neutral", hour = null, userId = "anon" } = req.body || {};
    const hi = greetingByHour(lang, hour); // hora local que envía el móvil
    const nm = String(name || "").trim();

    // guardamos nombre/sexo en memoria (para usar a futuro)
    const mem = await readMem(userId);
    if (nm) mem.name = nm;
    if (sex) mem.sex = sex;
    await writeMem(userId, mem);

    // Pedimos 3 frases alentadoras a OpenAI
    const sys = `Dame 3 frases breves, alentadoras y positivas, para uso diario, aptas para una audiencia cristiana, sin clichés, en ${lang}. JSON plano {"phrases":["...","...","..."]}`;
    let phrases = [];
    try {
      const r = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "system", content: sys }],
        response_format: { type: "json" },
      });
      const content = r?.choices?.[0]?.message?.content || "{}";
      const data = JSON.parse(content);
      if (Array.isArray(data.phrases)) phrases = data.phrases;
    } catch {
      phrases = [
        "Hoy es un buen día para empezar de nuevo.",
        "La fe abre caminos donde parece no haberlos.",
        "Un paso pequeño también es avance."
      ];
    }

    let sal = nm ? `${hi}, ${nm}.` : `${hi}.`;
    // uso no repetitivo de "hijo/hija mía"
    if (Math.random() < 0.33) {
      if (sex === "female") sal = `${sal} Hija mía,`;
      else if (sex === "male") sal = `${sal} Hijo mío,`;
      else sal = `${sal} Hijo/a mío/a,`;
    }

    let bridge = "";
    if (mem?.last_user_text && Math.random() < 0.5) {
      bridge =
        lang === "en" ? " ¿Cómo te sentís con lo que veníamos conversando?" :
        lang === "pt" ? " Como você se sente sobre o que conversamos?" :
        lang === "it" ? " Come ti senti rispetto a ciò che conversavamo?" :
        lang === "de" ? " Wie fühlst du dich in Bezug auf nossa conversa anterior?" :
        lang === "ca" ? " Com et sents respecte del que parlàvem?" :
        lang === "fr" ? " Comment te sens-tu par rapport à ce dont nous parlions ?" :
                        " ¿Cómo te sentís con lo que veníamos conversando?";
    }

    const picked = phrases.slice(0, 3).join(" ");
    const message = `${sal} ${picked}${bridge ? bridge : ""}`;
    const question =
      lang === "en" ? "What would you like to share today?" :
      lang === "pt" ? "O que você gostaria de compartilhar hoje?" :
      lang === "it" ? "Di cosa ti piacerebbe parlare oggi?" :
      lang === "de" ? "Worüber möchtest du heute sprechen?" :
      lang === "ca" ? "De què t’agradaria parlar avui?" :
      lang === "fr" ? "De quoi aimerais-tu parler aujourd’hui ?" :
                      "¿Qué te gustaría compartir hoy?";

    res.json({ message, question });
  } catch (e) {
    console.error("WELCOME ERROR:", e);
    res.json({ message: "La paz sea contigo. ¿De qué te gustaría hablar hoy?", question: "¿Qué te gustaría compartir hoy?" });
  }
});

// ---------- /api/ask ----------
app.post("/api/ask", async (req, res) => {
  try {
    const { message = "", history = [], userId = "anon", lang = "es" } = req.body || {};
    const userTxt = String(message || "").trim();

    const mem = await readMem(userId);
    const now = Date.now();

    // de paso, si nos mandan nombre/sexo en el history estilo "SYSTEM", no lo usamos aquí
    // (lo mantiene el frontend)

    // Duplicados rápidos
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
      const out = { message: msg, question: "" };
      mem.last_user_text = userTxt; mem.last_user_ts = now; mem.last_bot = out;
      await writeMem(userId, mem);
      return res.json(out);
    }

    // Alcance
    if (isOffTopic(userTxt) && !isReligiousException(userTxt)) {
      const msg =
        lang === "en" ? "I’m here for your inner life: faith, personal struggles and healing. I don’t give facts or opinions on sports, entertainment, technical, food, science or general topics." :
        lang === "pt" ? "Estou aqui para a sua vida interior: fé, questões pessoais e cura. Não trato esportes, entretenimento, técnica, gastronomia, ciência ou temas gerais." :
        lang === "it" ? "Sono qui per la tua vita interiore: fede, difficoltà personali e guarigione. Non tratto sport, spettacolo, tecnica, gastronomia, scienza o temi generali." :
        lang === "de" ? "Ich bin für dein inneres Leben da: Glaube, persönliche Themen und Heilung. Keine Fakten/Meinungen zu Sport, Unterhaltung, Technik, Gastronomie, Wissenschaft oder Allgemeinwissen." :
        lang === "ca" ? "Sóc aquí per a la teva vida interior: fe, dificultats personals i sanació. No tracto esports, entreteniment, tècnica, gastronomia, ciència o temes generals." :
        lang === "fr" ? "Je suis là pour ta vie intérieure : foi, difficultés personnelles et guérison. Je ne traite pas le sport, le divertissement, la technique, la gastronomie, la science ni les sujets généraux." :
                        "Estoy aquí para tu vida interior: fe, dificultades personales y sanación. No doy datos ni opiniones de deportes, espectáculos, técnica, gastronomía, ciencia o temas generales.";
      const q =
        lang === "en" ? "What would help you most right now—your emotions, a relationship, or your prayer life?" :
        lang === "pt" ? "O que mais ajudaria agora — suas emoções, uma relação, ou a sua vida de oração?" :
        lang === "it" ? "Cosa ti aiuterebbe ora — le emozioni, una relazione o la tua vita di preghiera?" :
        lang === "de" ? "Was würde dir jetzt am meisten helfen – deine Gefühle, eine Beziehung oder dein Gebetsleben?" :
        lang === "ca" ? "Què t’ajudaria ara — les teves emocions, una relació o la teva vida de pregària?" :
        lang === "fr" ? "Qu’est-ce qui t’aiderait le plus — tes émotions, une relation ou ta vie de prière ?" :
                        "¿Qué te ayudaría ahora — tus emociones, una relación o tu vida de oración?";
      const out = { message: msg, question: q };
      mem.last_user_text = userTxt; mem.last_user_ts = now; mem.last_bot = out;
      await writeMem(userId, mem);
      return res.json(out);
    }

    // -------- OpenAI: Respuesta con biblia obligatoria --------
    const SYS = `
Eres cercano, claro y compasivo, desde una voz cristiana (católica).
Alcance: espiritualidad/fe cristiana, psicología/autoayuda personal, relaciones y emociones.
Varía el lenguaje; no repitas muletillas. 1 sola pregunta breve y útil.
Formato (JSON en ${langLabel(lang)}): {"message":"...", "question":"...?", "bible":{"text":"...","ref":"Libro 0:0"}}
- "message": natural y concreto; pasos prácticos si corresponde.
- "question": una pregunta simple (no hagas cuestionarios).
- "bible": SIEMPRE incluida; pertinente; evita Mateo/Matthew 11:28 (todas las variantes).
No incluyas nada fuera del JSON.
`.trim();

    const convo = [];
    const recent = Array.isArray(history) ? history.slice(-8) : [];
    for (const h of recent) if (typeof h === "string") convo.push({ role: "user", content: h });
    convo.push({ role: "user", content: userTxt });

    const r = await openai.chat.completions.create({
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

    const content = r?.choices?.[0]?.message?.content || "{}";
    let data = {}; try { data = JSON.parse(content); } catch { data = {}; }

    const banned = /mateo\s*11\s*:\s*28|matt(hew)?\s*11\s*:\s*28|matteo\s*11\s*:\s*28|matthäus\s*11\s*:\s*28|matthieu\s*11\s*:\s*28|mateu\s*11\s*:\s*28|mateus\s*11\s*:\s*28/i;

    // Versículo final (sin duplicar en message)
    let verse = null;
    const used = new Set((mem.last_refs || []).map((x) => NORM(x)));
    const refRaw = String(data?.bible?.ref || "").trim();
    const txtRaw = String(data?.bible?.text || "").trim();

    if (txtRaw && refRaw && !banned.test(refRaw) && !used.has(NORM(refRaw))) {
      verse = { ref: refRaw, text: txtRaw };
    } else {
      verse = pickFallbackVerse(lang, used);
    }

    // Forzar punto final para que el TTS haga pausa después de la cita
    if (!/[.!?…]\s*$/.test(verse.text)) verse.text = verse.text + ".";

    const baseMsg = String(data?.message || "").trim() || (lang === "en" ? "I’m with you." : "Estoy contigo.");
    const question = String(data?.question || "").trim() || "";

    const out = { message: baseMsg, question, bible: verse };

    // Persistencia
    mem.last_user_text = userTxt;
    mem.last_user_ts = now;
    mem.last_bot = out;
    mem.last_refs = [...(mem.last_refs || []), verse.ref].slice(-8);
    await writeMem(userId, mem);

    res.json(out);
  } catch (e) {
    console.error("ASK ERROR:", e);
    res.json({
      message: "La paz sea contigo. Contame en pocas palabras qué está pasando y vemos un paso simple y concreto.",
      question: "¿Qué te gustaría trabajar primero?",
      bible: { ref: "Salmos 34:18", text: "Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu." }
    });
  }
});

// ---------- /api/heygen/token ----------
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
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json({ token });
  } catch (e) {
    console.error("heygen token exception:", e);
    res.status(500).json({ error: "heygen_token_error" });
  }
});

// ---------- /api/heygen/config ----------
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
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.json({ voiceId, defaultAvatar, avatars, version });
});

// ---------- Arranque ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor listo en puerto ${PORT}`));
