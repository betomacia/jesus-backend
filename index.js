// index.js — Backend limpio solo con OpenAI
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const OpenAI = require("openai");
const path = require("path");
const fs = require("fs/promises");
require("dotenv").config();

const app = express();
app.use(cors({ origin: true }));
app.use(bodyParser.json());

// OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Utils
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
    default: return g("Buenos días", "Buenas tardes", "Buenas noches");
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
    "La fede rende possibile l'impossibile.",
    "Oggi è un buon giorno per ricominciare.",
    "La pace cresce a piccoli passi.",
    "L'amore che doni ritorna a te.",
  ],
  de: [
    "Eine kleine Freundlichkeit kann deinen Tag verändern.",
    "Glaube macht das Unmögliche möglich.",
    "Heute ist ein guter Tag für einen Neuanfang.",
    "Frieden wächst aus kleinen Schritten.",
    "Die Liebe, die du gibst, kehrt zu dir zurück.",
  ],
  ca: [
    "Un gest d'amabilitat pot canviar el teu dia.",
    "La fe fa possible l'impossible.",
    "Avui és un bon dia per començar de nou.",
    "La pau creix amb petits passos.",
    "L'amor que dones torna a tu.",
  ],
  fr: [
    "Un geste de bonté peut changer ta journée.",
    "La foi rend possible l'impossible.",
    "Aujourd'hui est un bon jour pour recommencer.",
    "La paix grandit à petits pas.",
    "L'amour que tu donnes te revient.",
  ],
};

function dayPhrase(lang = "es") {
  const arr = DAILY_PHRASES[lang] || DAILY_PHRASES["es"];
  return arr[Math.floor(Math.random() * arr.length)];
}

// Fallback de versículos
const FALLBACK_VERSES = {
  es: [
    { ref: "Salmos 34:18", text: "Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu." },
    { ref: "Isaías 41:10", text: "No temas, porque yo estoy contigo; no desmayes, porque yo soy tu Dios que te esfuerzo; siempre te ayudaré." },
    { ref: "Salmo 23:1", text: "El Señor es mi pastor; nada me faltará." },
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
    { ref: "Salm 34:19", text: "El Senyor és a prop dels cors trencats, salva els que tenen l'esperit abatut." },
    { ref: "Isaïes 41:10", text: "No tinguis por, que jo sóc amb tu; no t'esglaiïs, que jo sóc el teu Déu." },
  ],
  fr: [
    { ref: "Psaume 34:19", text: "L'Éternel est près de ceux qui ont le cœur brisé; il sauve ceux qui ont l'esprit dans l'abattement." },
    { ref: "Ésaïe 41:10", text: "Ne crains rien, car je suis avec toi." },
  ],
};

function pickFallbackVerse(lang = "es", avoidSet = new Set()) {
  const list = FALLBACK_VERSES[lang] || FALLBACK_VERSES["es"];
  for (const v of list) {
    if (!avoidSet.has(NORM(v.ref))) return v;
  }
  return list[0];
}

// Memoria simple en FS
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
      last_refs: Array.isArray(m.last_refs) ? m.last_refs : [],
    };
  } catch {
    return {
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

// Filtros de alcance
const OFFTOPIC = [
  /\b(f[úu]tbol|futbol|deporte|champions|nba|tenis|selecci[oó]n|mundial|goles?)\b/i,
  /\b(pel[ií]cula|serie|netflix|hbo|max|disney|spotify|cantante|concierto|celebridad|famos[oa]s?)\b/i,
  /\b(program(a|ar|aci[oó]n)|c[oó]digo|javascript|react|inform[aá]tica|pc|ordenador|linux|windows|red(es)?|wifi|driver|api|prompt)\b/i,
  /\b(matem[aá]ticas?|algebra|c[aá]lculo|geometr[ií]a|f[ií]sica|qu[ií]mica|biolog[ií]a|cient[ií]fico|ecuaci[oó]n)\b/i,
  /\b(mec[aá]nica|alternador|bater[ií]a del auto|motor|embrague|inyector|buj[ií]a|correa|nafta|diesel)\b/i,
  /\b(circuito|voltaje|ohmios|arduino|raspberry|microcontrolador|placa)\b/i,
  /\b(videojuego|fortnite|minecraft|playstation|xbox|nintendo|steam)\b/i,
  /\b(pa[ií]s|capital|mapa|d[oó]nde queda|ubicaci[oó]n|distancia|kil[oó]metros|frontera|r[íi]o|monta[ñn]a|cordillera)\b/i,
  /\b(viaje|hotel|playa|turismo|destino|vuelo|itinerario|tour|gu[ií]a tur[ií]stica)\b/i,
  /\b(gastronom[ií]a|gastronomia|cocina|recet(a|ario)s?|platos?|ingredientes?|men[uú]|men[uú]s|postres?|dulces?|salado?s?)\b/i,
  /\b(comida|comidas|almuerzo|cena|desayuno|merienda|vianda|raci[oó]n|calor[ií]as|nutrici[oó]n|dieta)\b/i,
  /\b(bebidas?|vino|cerveza|licor|coctel|c[oó]ctel|trago|fermentado|maridaje|bar|caf[eé]|cafeter[ií]a|restaurante|restaurantes?)\b/i,
  /\b(pol[ií]tica|elecci[oó]n|partido|diputado|senador|presidente|gobierno)\b/i,
  /\b(criptomonedas?|bitcoin|acciones|bolsa|nasdaq|d[oó]lar|euro)\b/i,
];

const RELIGIOUS_ALLOW = [
  /\b(iglesia|templo|catedral|parroquia|misa|sacramento|oraci[oó]n|santuario|santo|santos|biblia|evangelio|rosario|confesi[oó]n|eucarist[ií]a|liturgia|vaticano|lourdes|f[aá]tima|peregrinaci[oó]n|camino de santiago)\b/i,
];

function isReligiousException(s) {
  return RELIGIOUS_ALLOW.some((r) => r.test(NORM(s)));
}
function isOffTopic(s) {
  return OFFTOPIC.some((r) => r.test(NORM(s)));
}
function isGibberish(s) {
  const x = (s || "").trim();
  if (!x || x.length < 2) return true;
  const letters = (x.match(/[a-záéíóúüñàèìòùçâêîôûäëïöüß]/gi) || []).length;
  return letters < Math.ceil(x.length * 0.25);
}

// Health
app.get("/", (_req, res) => res.json({ ok: true, service: "backend", ts: Date.now() }));

// Welcome
app.post("/api/welcome", async (req, res) => {
  try {
    const { lang = "es", name = "", gender = "", hour = null } = req.body || {};
    const h = Number.isInteger(hour) ? hour : new Date().getHours();
    const greeting = greetingByHour(lang, h);
    const phrase = dayPhrase(lang);
    const nm = String(name || "").trim();
    
    let sal = nm ? `${greeting}, ${nm}.` : `${greeting}.`;
    
    // Opcional: agregar hijo/hija según género
    if (gender === "male") sal += " Hijo mío,";
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
    res.json({
      message: "La paz sea contigo. ¿De qué te gustaría hablar hoy?",
      question: "¿Qué te gustaría compartir hoy?",
    });
  }
});

// Ask
app.post("/api/ask", async (req, res) => {
  try {
    const { message = "", history = [], userId = "anon", lang = "es" } = req.body || {};
    const userTxt = String(message || "").trim();

    const mem = await readMem(userId);
    const now = Date.now();

    // Anti-duplicados
    if (userTxt && mem.last_user_text && userTxt === mem.last_user_text && now - mem.last_user_ts < 7000) {
      if (mem.last_bot) return res.json(mem.last_bot);
    }

    // Ruido
    if (isGibberish(userTxt)) {
      const msg =
        lang === "en" ? "I didn't quite get that. Could you say it again in a few words?" :
        lang === "pt" ? "Não entendi bem. Pode repetir em poucas palavras?" :
        lang === "it" ? "Non ho capito bene. Puoi ripetere in poche parole?" :
        lang === "de" ? "Ich habe es nicht ganz verstanden. Kannst du es in wenigen Worten wiederholen?" :
        lang === "ca" ? "No ho he entès del tot. Ho pots repetir en poques paraules?" :
        lang === "fr" ? "Je n'ai pas bien compris. Peux-tu répéter en quelques mots ?" :
        "No te entendí bien. ¿Podés repetirlo en pocas palabras?";
      const out = { message: msg, question: "", bible: { text: "", ref: "" } };
      mem.last_user_text = userTxt;
      mem.last_user_ts = now;
      mem.last_bot = out;
      await writeMem(userId, mem);
      return res.json(out);
    }

    // Alcance
    if (isOffTopic(userTxt) && !isReligiousException(userTxt)) {
      const msg =
        lang === "en" ? "I'm here for your inner life: faith, personal struggles and healing." :
        lang === "pt" ? "Estou aqui para a sua vida interior: fé, questões pessoais e cura." :
        lang === "it" ? "Sono qui per la tua vida interiore: fede, difficoltà personali e guarigione." :
        lang === "de" ? "Ich bin für dein inneres Leben da: Glaube, persönliche Themen und Heilung." :
        lang === "ca" ? "Sóc aquí per a la teva vida interior: fe, dificultats personals i sanació." :
        lang === "fr" ? "Je suis là pour ta vie intérieure : foi, difficultés personnelles et guérison." :
        "Estoy aquí para tu vida interior: fe, dificultades personales y sanación.";
      const q =
        lang === "en" ? "What would help you most right now—your emotions, a relationship, or your prayer life?" :
        lang === "pt" ? "O que mais ajudaria agora — suas emoções, uma relação, ou a sua vida de oração?" :
        lang === "it" ? "Cosa ti aiuterebbe ora — le emozioni, una relazione o la tua vida di preghiera?" :
        lang === "de" ? "Was würde dir jetzt am meisten helfen – deine Gefühle, eine Beziehung oder dein Gebetsleben?" :
        lang === "ca" ? "Què t'ajudaria ara — les teves emocions, una relació o la tua vida de pregària?" :
        lang === "fr" ? "Qu'est-ce qui t'aiderait le plus — tes émotions, une relation ou ta vie de prière ?" :
        "¿Qué te ayudaría ahora — tus emociones, una relación o tu vida de oración?";
      const out = { message: msg, question: q, bible: { text: "", ref: "" } };
      mem.last_user_text = userTxt;
      mem.last_user_ts = now;
      mem.last_bot = out;
      await writeMem(userId, mem);
      return res.json(out);
    }

    // OpenAI
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

    const convo = [];
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
            required: ["message", "bible"],
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

    let out = {
      message: String(data?.message || "").trim() || (lang === "en" ? "I'm with you." : "Estoy contigo."),
      question: String(data?.question || "").trim() || "",
    };

    const banned = /mateo\s*11\s*:\s*28|matt(hew)?\s*11\s*:\s*28|matteo\s*11\s*:\s*28|matthäus\s*11\s*:\s*28|matthieu\s*11\s*:\s*28|mateu\s*11\s*:\s*28|mateus\s*11\s*:\s*28/i;
    const refRaw = String(data?.bible?.ref || "").trim();
    const txtRaw = String(data?.bible?.text || "").trim();
    const used = new Set((mem.last_refs || []).map((x) => NORM(x)));

    let finalVerse = null;
    if (txtRaw && refRaw && !banned.test(refRaw) && !used.has(NORM(refRaw))) {
      finalVerse = { ref: refRaw, text: txtRaw };
    } else {
      finalVerse = pickFallbackVerse(lang, used);
    }

    out.bible = finalVerse;
    mem.last_refs = [...(mem.last_refs || []), finalVerse.ref].slice(-8);
    mem.last_user_text = userTxt;
    mem.last_user_ts = now;
    mem.last_bot = out;
    await writeMem(userId, mem);

    res.json(out);
  } catch (e) {
    console.error("ASK ERROR:", e);
    res.json({
      message: "La paz sea contigo. Decime en pocas palabras qué está pasando.",
      question: "¿Qué te gustaría trabajar primero?",
      bible: {
        ref: "Salmos 34:18",
        text: "Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu.",
      },
    });
  }
});

// Arranque
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Backend listo en puerto ${PORT}`));
