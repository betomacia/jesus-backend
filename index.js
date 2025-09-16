// index.js — Backend simple, dominios acotados y respuestas naturales (multi-idioma)

const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const OpenAI = require("openai");
const path = require("path");
const fs = require("fs/promises");
require("dotenv").config();

const app = express();
app.use(cors({ origin: true })); // CORS permisivo (refleja origin)
app.use(bodyParser.json());

// ---------- OpenAI ----------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------- Utils ----------
const NORM = (s = "") => String(s).toLowerCase().replace(/\s+/g, " ").trim();
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

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

function greetingByHour(lang = "es", hour = null) {
  const h = Number.isInteger(hour) ? hour : new Date().getHours();
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

const DAILY_PHRASES = {
  es: [
    "Un gesto de bondad puede cambiar tu día.",
    "La fe hace posible lo que parece imposible.",
    "Hoy es buen día para empezar de nuevo.",
    "La paz se cultiva con pasos pequeños.",
    "El amor que das, vuelve a ti.",
  ],
  en: [
    "A small kindness can change your day.",
    "Faith makes the impossible possible.",
    "Today is a good day to begin again.",
    "Peace grows from small steps.",
    "The love you give returns to you.",
  ],
  pt: [
    "Um gesto de bondade pode mudar o seu dia.",
    "A fé torna possível o impossível.",
    "Hoje é um bom dia para recomeçar.",
    "A paz cresce com pequenos passos.",
    "O amor que você dá volta para você.",
  ],
  it: [
    "Un gesto di gentilezza può cambiare la tua giornata.",
    "La fede rende possibile l’impossibile.",
    "Oggi è un buon giorno per ricominciare.",
    "La pace cresce a piccoli passi.",
    "L’amore che doni ritorna a te.",
  ],
  de: [
    "Eine kleine Freundlichkeit kann deinen Tag verändern.",
    "Glaube macht das Unmögliche möglich.",
    "Heute ist ein guter Tag für einen Neuanfang.",
    "Frieden wächst aus kleinen Schritten.",
    "Die Liebe, die du gibst, kehrt zu dir zurück.",
  ],
  ca: [
    "Un gest d’amabilitat pot canviar el teu dia.",
    "La fe fa possible l’impossible.",
    "Avui és un bon dia per començar de nou.",
    "La pau creix amb petits passos.",
    "L’amor que dones torna a tu.",
  ],
  fr: [
    "Un geste de bonté peut changer ta journée.",
    "La foi rend possible l’impossible.",
    "Aujourd’hui est un bon jour pour recommencer.",
    "La paix grandit à petits pas.",
    "L’amour que tu donnes te revient.",
  ],
};

function dayPhrase(lang = "es") {
  const arr = DAILY_PHRASES[lang] || DAILY_PHRASES["es"];
  return arr[Math.floor(Math.random() * arr.length)];
}

// ---------- Memoria en FS (muy simple) ----------
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
async function readMem(userId) {
  await ensureDataDir();
  try {
    const raw = await fs.readFile(memPath(userId), "utf8");
    const m = JSON.parse(raw);
    return {
      last_user_text: m.last_user_text || "",
      last_user_ts: m.last_user_ts || 0,
      last_bot: m.last_bot || null,
      verse_cooldown: clamp(m.verse_cooldown || 0, 0, 3),
      last_refs: Array.isArray(m.last_refs) ? m.last_refs : [],
    };
  } catch {
    return {
      last_user_text: "",
      last_user_ts: 0,
      last_bot: null,
      verse_cooldown: 0,
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
  // técnica/ciencia/educación
  /\b(program(a|ar|aci[oó]n)|c[oó]digo|javascript|react|inform[aá]tica|pc|ordenador|linux|windows|red(es)?|wifi|driver|api|prompt)\b/i,
  /\b(matem[aá]ticas?|algebra|c[aá]lculo|geometr[ií]a|f[ií]sica|qu[ií]mica|biolog[ií]a|cient[ií]fico|ecuaci[oó]n)\b/i,
  // mecánica/electrónica/juegos
  /\b(mec[aá]nica|alternador|bater[ií]a del auto|motor|embrague|inyector|buj[ií]a|correa|nafta|diesel)\b/i,
  /\b(circuito|voltaje|ohmios|arduino|raspberry|microcontrolador|placa)\b/i,
  /\b(videojuego|fortnite|minecraft|playstation|xbox|nintendo|steam)\b/i,
  // geografía/turismo no religioso + comida/recetas
  /\b(pa[ií]s|capital|mapa|d[oó]nde queda|ubicaci[oó]n|distancia|kil[oó]metros|frontera|r[íi]o|monta[ñn]a|cordillera)\b/i,
  /\b(viaje|hotel|playa|turismo|restaurante|comida|receta|cocinar|bar|caf[eé])\b/i,
  // política/negocios/tecnología de consumo
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
  // muy poca letra vs símbolos/números
  const letters = (x.match(/[a-záéíóúüñàèìòùçâêîôûäëïöüß]/gi) || []).length;
  return letters < Math.ceil(x.length * 0.25);
}

// ---------- Health ----------
app.get("/", (_req, res) => res.json({ ok: true, service: "backend", ts: Date.now() }));

// ---------- /api/welcome ----------
app.post("/api/welcome", async (req, res) => {
  try {
    const { lang = "es", name = "", userId = "anon", hour = null } = req.body || {};
    const hi = greetingByHour(lang, hour);
    const phrase = dayPhrase(lang);
    const nm = String(name || "").trim();
    const sal = nm ? `${hi}, ${nm}.` : `${hi}.`;

    const message =
      lang === "en"
        ? `${sal} ${phrase} I'm here for you.`
        : lang === "pt"
        ? `${sal} ${phrase} Estou aqui para você.`
        : lang === "it"
        ? `${sal} ${phrase} Sono qui per te.`
        : lang === "de"
        ? `${sal} ${phrase} Ich bin für dich da.`
        : lang === "ca"
        ? `${sal} ${phrase} Sóc aquí per ajudar-te.`
        : lang === "fr"
        ? `${sal} ${phrase} Je suis là pour toi.`
        : `${sal} ${phrase} Estoy aquí para lo que necesites.`;

    const question =
      lang === "en"
        ? "What would you like to share today?"
        : lang === "pt"
        ? "O que você gostaria de compartilhar hoje?"
        : lang === "it"
        ? "Di cosa ti piacerebbe parlare oggi?"
        : lang === "de"
        ? "Worüber möchtest du heute sprechen?"
        : lang === "ca"
        ? "De què t’agradaria parlar avui?"
        : lang === "fr"
        ? "De quoi aimerais-tu parler aujourd’hui ?"
        : "¿Qué te gustaría compartir hoy?";

    res.json({ message, question });
  } catch {
    res.json({ message: "La paz sea contigo. ¿De qué te gustaría hablar hoy?", question: "¿Qué te gustaría compartir hoy?" });
  }
});

// ---------- /api/ask ----------
app.post("/api/ask", async (req, res) => {
  try {
    const { message = "", history = [], userId = "anon", lang = "es" } = req.body || {};
    const userTxt = String(message || "").trim();

    // Memoria (dup & throttle de versículos)
    const mem = await readMem(userId);

    // Duplicados (mismo texto en segundos cercanos) → devuelve la última respuesta
    const now = Date.now();
    if (userTxt && mem.last_user_text && userTxt === mem.last_user_text && now - mem.last_user_ts < 7000) {
      if (mem.last_bot) return res.json(mem.last_bot);
    }

    // Ruido/gibberish
    if (isGibberish(userTxt)) {
      const msg =
        lang === "en"
          ? "I didn’t quite get that. Could you say it again in a few words?"
          : lang === "pt"
          ? "Não entendi bem. Pode repetir em poucas palavras?"
          : lang === "it"
          ? "Non ho capito bene. Puoi ripetere in poche parole?"
          : lang === "de"
          ? "Ich habe es nicht ganz verstanden. Kannst du es in wenigen Worten wiederholen?"
          : lang === "ca"
          ? "No ho he entès del tot. Ho pots repetir en poques paraules?"
          : lang === "fr"
          ? "Je n’ai pas bien compris. Peux-tu répéter en quelques mots ?"
          : "No te entendí bien. ¿Podés repetirlo en pocas palabras?";
      const out = { message: msg, question: "" };
      mem.last_user_text = userTxt;
      mem.last_user_ts = now;
      mem.last_bot = out;
      await writeMem(userId, mem);
      return res.json(out);
    }

    // Alcance: desviar off-topic salvo excepción religiosa
    if (isOffTopic(userTxt) && !isReligiousException(userTxt)) {
      const msg =
        lang === "en"
          ? "I’m here for your inner life: faith, personal struggles and healing. I don’t give facts or opinions on sports, entertainment, technical or general topics."
          : lang === "pt"
          ? "Estou aqui para a sua vida interior: fé, questões pessoais e cura. Não dou fatos ou opiniões sobre esportes, entretenimento, temas técnicos ou gerais."
          : lang === "it"
          ? "Sono qui per la tua vita interiore: fede, difficoltà personali e guarigione. Non tratto sport, spettacolo, argomenti tecnici o generali."
          : lang === "de"
          ? "Ich bin für dein inneres Leben da: Glaube, persönliche Themen und Heilung. Ich gebe keine Fakten oder Meinungen zu Sport, Unterhaltung oder Technik."
          : lang === "ca"
          ? "Sóc aquí per a la teva vida interior: fe, dificultats personals i sanació. No tracto esports, entreteniment ni temes tècnics o generals."
          : lang === "fr"
          ? "Je suis là pour ta vie intérieure : foi, difficultés personnelles et guérison. Je ne traite pas le sport, le divertissement ni les sujets techniques."
          : "Estoy aquí para tu vida interior: fe, dificultades personales y sanación. No doy datos ni opiniones de deportes, espectáculos, técnica o temas generales.";
      const q =
        lang === "en"
          ? "What would help you most right now—your emotions, a relationship, or your prayer life?"
          : lang === "pt"
          ? "O que mais ajudaria agora — suas emoções, uma relação, ou a sua vida de oração?"
          : lang === "it"
          ? "Cosa ti aiuterebbe ora — le emozioni, una relazione, o la tua vita di preghiera?"
          : lang === "de"
          ? "Was würde dir jetzt am meisten helfen – deine Gefühle, eine Beziehung oder dein Gebetsleben?"
          : lang === "ca"
          ? "Què t’ajudaria ara — les teves emocions, una relació o la teva vida de pregària?"
          : lang === "fr"
          ? "Qu’est-ce qui t’aiderait le plus — tes émotions, une relation ou ta vie de prière ?"
          : "¿Qué te ayudaría ahora — tus emociones, una relación o tu vida de oración?";
      const out = { message: msg, question: q };
      mem.last_user_text = userTxt;
      mem.last_user_ts = now;
      mem.last_bot = out;
      await writeMem(userId, mem);
      return res.json(out);
    }

    // -------- OpenAI: Instrucciones mínimas (sin ejemplos ni recetas) --------
    const SYS = `
Eres cercano, claro y compasivo, desde una voz cristiana (católica) que acompaña sin juzgar.
Alcance: espiritualidad/fe católica, psicología/autoayuda personal, relaciones y emociones. Evita todo lo demás.
Varía el lenguaje; no repitas fórmulas ni muletillas. No hagas cuestionarios; 1 sola pregunta breve.
Formato de salida (JSON en ${langLabel(lang)}): {"message":"...", "question":"...?", "bible":{"text":"...","ref":"Libro 0:0"}}
- "message": natural y concreto; si el usuario pide pasos, dáselos con claridad breve.
- "question": **una** pregunta simple y pertinente; evita «desde cuándo» salvo que el usuario ya hable de tiempos.
- "bible": opcional; si la incluyes, que sea pertinente y no repitas siempre la misma. Evita Mateo/Matthew 11:28.
No incluyas nada fuera del JSON.
`.trim();

    const convo = [];
    // Incluimos un resumen de historia reciente sin ejemplos adicionales.
    const recent = Array.isArray(history) ? history.slice(-8) : [];
    for (const h of recent) {
      if (typeof h === "string") convo.push({ role: "user", content: h });
    }
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
            required: ["message"],
            additionalProperties: false,
          },
        },
      },
    });

    const content = r?.choices?.[0]?.message?.content || "{}";
    let data = {};
    try {
      data = JSON.parse(content);
    } catch {
      data = {};
    }

    // Versículo: throttle y anti-repetición muy simple
    let out = {
      message: String(data?.message || "").trim() || (lang === "en" ? "I’m with you." : "Estoy contigo."),
      question: String(data?.question || "").trim() || "",
    };

    const ref = String(data?.bible?.ref || "").trim();
    const txt = String(data?.bible?.text || "").trim();
    const banned = /mateo\s*11\s*:\s*28|matt(hew)?\s*11\s*:\s*28|matteo\s*11\s*:\s*28|matthäus\s*11\s*:\s*28|matthieu\s*11\s*:\s*28|mateu\s*11\s*:\s*28|mateus\s*11\s*:\s*28/i;

    const recentlyUsed = new Set((mem.last_refs || []).map((x) => NORM(x)));
    const canVerse = mem.verse_cooldown === 0;

    if (txt && ref && canVerse && !banned.test(ref) && !recentlyUsed.has(NORM(ref))) {
      out.bible = { text: txt, ref };
      mem.last_refs = [...(mem.last_refs || []), ref].slice(-8);
      mem.verse_cooldown = 2; // 1 verso cada ~3 turnos
    } else {
      mem.verse_cooldown = clamp((mem.verse_cooldown || 0) - 1, 0, 3);
    }

    // Persistimos
    mem.last_user_text = userTxt;
    mem.last_user_ts = now;
    mem.last_bot = out;
    await writeMem(userId, mem);

    res.json(out);
  } catch (e) {
    console.error("ASK ERROR:", e);
    res.json({
      message:
        "La paz sea contigo. Decime en pocas palabras qué está pasando y vemos un paso simple y concreto.",
      question: "¿Qué te gustaría trabajar primero?",
    });
  }
});

// ---------- HeyGen ----------
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
