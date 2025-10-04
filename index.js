// index.js — Backend minimal (sin DB) para Jesús Interactivo
// - OpenAI: /api/welcome y /api/ask
// - Voz (jesus-voz): /api/tts, /api/tts_save y /api/files/* (proxy HTTPS)
// - Ingest directo: /api/ingest/start, /api/ingest/stop
// - Viewer proxy + assets proxy: /api/viewer/offer y /api/viewer/assets/* (+ /api/assets/idle|talk)
// - Diag: /api/_diag/viewer_check
// - Health: "/"

require("dotenv").config();

if (process.env.JESUS_INSECURE_TLS === "1") {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const path = require("path");
const fs = require("fs/promises");
const OpenAI = require("openai");
const { spawn } = require("child_process");
const https = require("https");
const { Readable } = require("node:stream");

const INSECURE_AGENT =
  process.env.JESUS_INSECURE_TLS === "1"
    ? new https.Agent({ rejectUnauthorized: false })
    : undefined;

// ---- WebRTC ingest y FFmpeg ----
let wrtc = null;
try { wrtc = require("wrtc"); } catch (e) {
  console.warn("[WARN] wrtc no instalado; /api/ingest/* funcionará en modo stub.");
}
const RTCPeerConnection = wrtc?.RTCPeerConnection;
const RTCAudioSource   = wrtc?.nonstandard?.RTCAudioSource;

let ffmpegPath = process.env.FFMPEG_PATH || null;
try { if (!ffmpegPath) ffmpegPath = require("ffmpeg-static"); } catch (_) {}
if (!ffmpegPath) ffmpegPath = "ffmpeg";

(function checkFfmpeg() {
  try {
    const ps = spawn(ffmpegPath, ["-version"]);
    let head = "";
    ps.stdout.on("data", (d) => { if (!head) head = String(d || ""); });
    ps.on("close", (code) => {
      if (code === 0) console.log("[ffmpeg ok]", ffmpegPath, (head.split("\n")[0] || "").trim());
      else console.warn("[ffmpeg warn] exit", code, "path:", ffmpegPath);
    });
    ps.on("error", (e) => console.error("[ffmpeg error]", e.message));
  } catch (e) { console.error("[ffmpeg missing]", e.message); }
})();

const JESUS_URL = (process.env.JESUS_URL || "").trim();
const VOZ_URL   = (process.env.VOZ_URL   || "").trim();
if (!JESUS_URL) console.warn("[WARN] Falta JESUS_URL]");
if (!VOZ_URL)   console.warn("[WARN] Falta VOZ_URL]");

const app = express();
app.use(cors({ origin: true }));
app.use(bodyParser.json());

// Forzar JSON UTF-8 por defecto, salvo binarios/audio
app.use((req, res, next) => {
  const p = req.path || "";
  if (
    p.startsWith("/api/viewer/assets") ||
    p.startsWith("/api/assets/") ||
    p.startsWith("/api/files/") ||
    p.startsWith("/api/tts")
  ) return next();
  res.set("Content-Type", "application/json; charset=utf-8");
  next();
});

// ---------- OpenAI ----------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------- Utils ----------
const NORM = (s = "") => String(s).toLowerCase().replace(/\s+/g, " ").trim();

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
const dayPhrase = (lang="es") => {
  const arr = DAILY_PHRASES[lang] || DAILY_PHRASES["es"];
  return arr[Math.floor(Math.random() * arr.length)];
};
const langLabel = (l="es") => ({ es:"Español", en:"English", pt:"Português", it:"Italiano", de:"Deutsch", ca:"Català", fr:"Français" }[l] || "Español");
function greetingByHour(lang="es", hour=null) {
  const h = Number.isInteger(hour) ? hour : new Date().getHours();
  const g = (m,a,n)=> (h<12?m:h<19?a:n);
  switch(lang){
    case "en": return g("Good morning","Good afternoon","Good evening");
    case "pt": return g("Bom dia","Boa tarde","Boa noite");
    case "it": return g("Buongiorno","Buon pomeriggio","Buonasera");
    case "de": return g("Guten Morgen","Guten Tag","Guten Abend");
    case "ca": return g("Bon dia","Bona tarda","Bona nit");
    case "fr": return g("Bonjour","Bon après-midi","Bonsoir");
    default:   return g("Buenos días","Buenas tardes","Buenas noches");
  }
}

// ---------- Fallback de versículos ----------
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
function pickFallbackVerse(lang="es", avoidSet=new Set()){
  const list = FALLBACK_VERSES[lang] || FALLBACK_VERSES["es"];
  for (const v of list) if (!avoidSet.has(NORM(v.ref))) return v;
  return list[0];
}

// ---------- Memoria simple en FS ----------
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
async function ensureDataDir(){ try { await fs.mkdir(DATA_DIR,{recursive:true}); } catch{} }
function memPath(uid){ const safe = String(uid||"anon").replace(/[^a-z0-9_-]/gi,"_"); return path.join(DATA_DIR,`mem_${safe}.json`); }
async function readMem(userId){
  await ensureDataDir();
  try{
    const raw = await fs.readFile(memPath(userId),"utf8");
    const m = JSON.parse(raw);
    return { last_user_text:m.last_user_text||"", last_user_ts:m.last_user_ts||0, last_bot:m.last_bot||null, last_refs:Array.isArray(m.last_refs)?m.last_refs:[] };
  } catch { return { last_user_text:"", last_user_ts:0, last_bot:null, last_refs:[] }; }
}
async function writeMem(userId, mem){
  await ensureDataDir();
  await fs.writeFile(memPath(userId), JSON.stringify(mem,null,2), "utf8");
}

// ---------- Filtros de alcance ----------
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
const RELIGIOUS_ALLOW=[/\b(iglesia|templo|catedral|parroquia|misa|sacramento|oraci[oó]n|santuario|santo|santos|biblia|evangelio|rosario|confesi[oó]n|eucarist[ií]a|liturgia|vaticano|lourdes|f[aá]tima|peregrinaci[oó]n|camino de santiago)\b/i];
const isReligiousException=(s)=> RELIGIOUS_ALLOW.some((r)=> r.test(NORM(s)));
const isGibberish=(s)=>{ const x=(s||"").trim(); if(!x||x.length<2) return true; const letters=(x.match(/[a-záéíóúüñàèìòùçâêîôûäëïöüß]/gi)||[]).length; return letters < Math.ceil(x.length*0.25); };

// ---------- Health ----------
app.get("/", (_req,res)=> res.json({ ok:true, service:"backend", ts:Date.now() }));

// ---------- /api/_diag/viewer_check ----------
app.get("/api/_diag/viewer_check", async (_req,res)=>{
  try{
    if(!JESUS_URL) return res.status(500).json({ ok:false, error:"missing_JESUS_URL" });
    const r = await fetch(`${JESUS_URL}/health`, { agent:INSECURE_AGENT });
    const j = await r.json().catch(()=> ({}));
    if(!r.ok) return res.status(r.status).json({ ok:false, error:"health_non_200", detail:j, jesus_url:JESUS_URL });
    res.json({ ok:true, jesus_url:JESUS_URL, health:j });
  } catch(e){
    res.status(500).json({ ok:false, error:"viewer_check_failed", detail:String(e), jesus_url:JESUS_URL });
  }
});

// ---------- /api/welcome ----------
app.post("/api/welcome", async (req,res)=>{
  try{
    const { lang="es", name="", hour=null } = req.body || {};
    const hi = greetingByHour(lang, hour);
    const phrase = dayPhrase(lang);
    const nm = String(name||"").trim();
    const sal = nm ? `${hi}, ${nm}.` : `${hi}.`;
    const message =
      lang==="en"? `${sal} ${phrase} I'm here for you.`:
      lang==="pt"? `${sal} ${phrase} Estou aqui para você.`:
      lang==="it"? `${sal} ${phrase} Sono qui per te.`:
      lang==="de"? `${sal} ${phrase} Ich bin für dich da.`:
      lang==="ca"? `${sal} ${phrase} Sóc aquí per ajudar-te.`:
      lang==="fr"? `${sal} ${phrase} Je suis là pour toi.`:
                    `${sal} ${phrase} Estoy aquí para lo que necesites.`;
    const question =
      lang==="en"? "What would you like to share today?":
      lang==="pt"? "O que você gostaria de compartilhar hoje?":
      lang==="it"? "Di cosa ti piacerebbe parlare oggi?":
      lang==="de"? "Worüber möchtest du heute sprechen?":
      lang==="ca"? "De què t’agradaria parlar avui?":
      lang==="fr"? "De quoi aimerais-tu parler aujourd’hui ?":
                    "¿Qué te gustaría compartir hoy?";
    res.json({ message, question });
  } catch {
    res.json({ message:"La paz sea contigo. ¿De qué te gustaría hablar hoy?", question:"¿Qué te gustaría compartir hoy?" });
  }
});

// ---------- /api/ask (OpenAI) ----------
app.post("/api/ask", async (req,res)=>{
  try{
    const { message="", history=[], userId="anon", lang="es" } = req.body || {};
    const userTxt = String(message||"").trim();

    const mem = await readMem(userId);
    const now = Date.now();

    if (userTxt && mem.last_user_text && userTxt===mem.last_user_text && now - mem.last_user_ts < 7000) {
      if (mem.last_bot) return res.json(mem.last_bot);
    }

    if (isGibberish(userTxt)) {
      const msg =
        lang==="en"?"I didn’t quite get that. Could you say it again in a few words?":
        lang==="pt"?"Não entendi bem. Pode repetir em poucas palavras?":
        lang==="it"?"Non ho capito bene. Puoi ripetere in poche parole?":
        lang==="de"?"Ich habe es nicht ganz verstanden. Kannst du es in wenigen Worten wiederholen?":
        lang==="ca"?"No ho he entès del tot. Ho pots repetir en poques paraules?":
        lang==="fr"?"Je n’ai pas bien compris. Peux-tu répéter en quelques mots ?":
                     "No te entendí bien. ¿Podés repetirlo en pocas palabras?";
      const out = { message: msg, question: "" };
      mem.last_user_text = userTxt; mem.last_user_ts = now; mem.last_bot = out;
      await writeMem(userId, mem);
      return res.json(out);
    }

    if (OFFTOPIC.some((r)=> r.test(NORM(userTxt))) && !isReligiousException(userTxt)) {
      const msg =
        lang==="en"?"I’m here for your inner life: faith, personal struggles and healing. I don’t give facts or opinions on sports, entertainment, technical, food or general topics.":
        lang==="pt"?"Estou aqui para a sua vida interior: fé, questões pessoais e cura. Não trato esportes, entretenimento, técnica, gastronomia ou temas gerais.":
        lang==="it"?"Sono qui per la tua vida interiore: fede, difficoltà personali e guarigione. Non tratto sport, spettacolo, tecnica, gastronomia o temi generali.":
        lang==="de"?"Ich bin für dein inneres Leben da: Glaube, persönliche Themen und Heilung. Keine Fakten/Meinungen zu Sport, Unterhaltung, Technik, Gastronomie oder Allgemeinwissen.":
        lang==="ca"?"Sóc aquí per a la teva vida interior: fe, dificultats personals i sanació. No tracto esports, entreteniment, tècnica, gastronomia o temes generals.":
        lang==="fr"?"Je suis là pour ta vie intérieure : foi, difficultés personnelles et guérison. Je ne traite pas le sport, le divertissement, la technique, la gastronomie ni les sujets généraux.":
                     "Estoy aquí para tu vida interior: fe, dificultades personales y sanación. No doy datos ni opiniones de deportes, espectáculos, técnica, gastronomía o temas generales.";
      const q =
        lang==="en"?"What would help you most right now—your emotions, a relationship, or your prayer life?":
        lang==="pt"?"O que mais ajudaria agora — suas emoções, uma relação, ou a sua vida de oração?":
        lang==="it"?"Cosa ti aiuterebbe ora — le emozioni, una relazione o la tua vida de preghiera?":
        lang==="de"?"Was würde dir jetzt am meisten helfen – deine Gefühle, eine Beziehung oder dein Gebetsleben?":
        lang==="ca"?"Què t’ajudaria ara — les teves emocions, una relació o la teva vida de pregària?":
        lang==="fr"?"Qu’est-ce qui t’aiderait le plus — tes émotions, une relation ou ta vie de prière ?":
                     "¿Qué te ayudaría ahora — tus emociones, una relación o tu vida de oración?";
      const out = { message: msg, question: q };
      mem.last_user_text = userTxt; mem.last_user_ts = now; mem.last_bot = out;
      await writeMem(userId, mem);
      return res.json(out);
    }

    const SYS = `
Eres cercano, claro y compasivo, desde una voz cristiana (católica).
Alcance: espiritualidad/fe católica, psicología/autoayuda personal, relaciones y emociones. Evita lo demás.
Varía el lenguaje; no repitas muletillas. No hagas cuestionarios; 1 sola pregunta breve y pertinente.
Formato (JSON en ${langLabel(lang)}): {"message":"...", "question":"...?", "bible":{"text":"...","ref":"Libro 0:0"}}
- "message": natural y concreto; si el usuario pide pasos, dáselos con claridad breve.
- "question": **una** pregunta simple y útil.
- "bible": **SIEMPRE** incluida; pertinente; evita Mateo/Matthew 11:28 repetido.
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

    let out = {
      message: String(data?.message || "").trim() || (lang === "en" ? "I’m with you." : "Estoy contigo."),
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
      message: "La paz sea contigo. Decime en pocas palabras qué está pasando y vemos un paso simple y concreto.",
      question: "¿Qué te gustaría trabajar primero?",
      bible: { ref: "Salmos 34:18", text: "Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu." }
    });
  }
});

// ==================== PROXY DE VOZ — jesus-voz (VM) ====================
const TTS_PROVIDER_DEFAULT = (process.env.TTS_PROVIDER || "xtts").trim();
const TTS_RATE_BUMP = parseFloat(process.env.TTS_RATE_BUMP || "1");
const publicBase = (req) => process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;

const mergeQS = (a = {}, b = {}) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(a)) if (v !== undefined) s.append(k, String(v));
  for (const [k, v] of Object.entries(b)) if (v !== undefined) s.set(k, String(v));
  return s;
};
function applyRateBump(searchParams) {
  try {
    if (!TTS_RATE_BUMP || isNaN(TTS_RATE_BUMP) || TTS_RATE_BUMP === 1) return searchParams;
    const s = new URLSearchParams(searchParams);
    const r = parseFloat(s.get("rate") || "1");
    if (!isNaN(r)) s.set("rate", String(Math.max(0.25, Math.min(2.0, r * TTS_RATE_BUMP))));
    return s;
  } catch { return searchParams; }
}
async function pipeUpstream(up, res, fallbackType="application/octet-stream") {
  res.status(up.status);
  const ct = up.headers.get("content-type");
  if (ct) res.setHeader("Content-Type", ct);
  else res.setHeader("Content-Type", fallbackType);
  const cl = up.headers.get("content-length");
  if (cl) res.setHeader("Content-Length", cl);
  if (!up.body) return res.end();
  return Readable.fromWeb(up.body).pipe(res);
}

app.get("/api/health", async (req, res) => {
  try {
    if (!VOZ_URL) return res.status(500).json({ ok: false, error: "missing_VOZ_URL" });
    const r = await fetch(`${VOZ_URL}/health`);
    const j = await r.json().catch(() => ({}));
    res.json({ ok: true, proxy: "railway", voz_url: VOZ_URL, provider_default: TTS_PROVIDER_DEFAULT, upstream: j });
  } catch (e) { res.status(500).json({ ok:false, error:String(e) }); }
});

app.get("/api/tts", async (req, res) => {
  try {
    if (!VOZ_URL) return res.status(500).json({ ok: false, error: "missing_VOZ_URL" });
    const url = new URL("/tts", VOZ_URL);
    const q = mergeQS(req.query, { provider: TTS_PROVIDER_DEFAULT });
    url.search = applyRateBump(q).toString();
    const up = await fetch(url.toString());
    res.removeHeader("Content-Type");
    await pipeUpstream(up, res, "audio/wav");
  } catch (e) { res.status(500).json({ ok:false, error:String(e) }); }
});

app.get("/api/tts_save", async (req, res) => {
  try {
    if (!VOZ_URL) return res.status(500).json({ ok: false, error: "missing_VOZ_URL" });
    const url = new URL("/tts_save", VOZ_URL);
    const q = mergeQS(req.query, { provider: TTS_PROVIDER_DEFAULT });
    url.search = applyRateBump(q).toString();
    const up = await fetch(url.toString());
    const j = await up.json();

    const upstream = j.url || j.file || j.path;
    let name = null;
    try { name = new URL(upstream).pathname.split("/").pop(); } catch {}
    if (name) {
      const pub = `${publicBase(req)}/api/files/${encodeURIComponent(name)}`;
      j.url = j.file = j.path = pub;
    }
    res.json(j);
  } catch (e) { res.status(500).json({ ok:false, error:String(e) }); }
});

app.get("/api/files/:name", async (req, res) => {
  try {
    if (!VOZ_URL) return res.status(500).json({ ok: false, error: "missing_VOZ_URL" });
    const up = await fetch(`${VOZ_URL}/files/${encodeURIComponent(req.params.name)}`);
    res.removeHeader("Content-Type");
    await pipeUpstream(up, res, "audio/wav");
  } catch (e) { res.status(500).json({ ok:false, error:String(e) }); }
});

// ==================== VIEWER: assets proxy ====================
app.get("/api/viewer/assets/:file", async (req, res) => {
  try {
    if (!JESUS_URL) return res.status(500).json({ error: "missing_JESUS_URL" });
    const target = `${JESUS_URL}/assets/${encodeURIComponent(req.params.file)}`;
    const r = await fetch(target, { agent: INSECURE_AGENT });
    if (!r.ok) {
      const body = await r.text().catch(()=> "");
      res.status(r.status || 502).set("Content-Type","text/plain; charset=utf-8");
      return res.send(body || "asset fetch failed");
    }
    res.removeHeader("Content-Type");
    res.setHeader("Content-Type", r.headers.get("content-type") || "application/octet-stream");
    res.setHeader("Cache-Control","no-store");
    return Readable.fromWeb(r.body).pipe(res);
  } catch (e) {
    res.status(502).set("Content-Type","application/json; charset=utf-8");
    res.json({ error:"asset_proxy_exception", detail:String(e) });
  }
});
app.get("/api/assets/idle", (req, res) => {
  req.params.file = "idle_loop.mp4";
  return app._router.handle(req, res, () => {}, "get", "/api/viewer/assets/:file");
});
app.get("/api/assets/talk", (req, res) => {
  req.params.file = "talk.mp4";
  return app._router.handle(req, res, () => {}, "get", "/api/viewer/assets/:file");
});

// ==================== VIEWER PROXY ====================
app.post("/api/viewer/offer", async (req, res) => {
  try {
    if (!JESUS_URL) return res.status(500).json({ error: "missing_JESUS_URL" });
    const payload = { sdp: req.body?.sdp, type: req.body?.type };
    if (!payload.sdp || !payload.type) return res.status(400).json({ error: "bad_offer_payload" });

    const r = await fetch(`${JESUS_URL}/viewer/offer`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
      agent: INSECURE_AGENT,
    });

    if (r.ok) {
      const data = await r.json().catch(() => ({}));
      return res.json(data);
    }
    if (r.status === 501) {
      return res.json({ stub:true, webrtc:false, idleUrl:"/api/viewer/assets/idle_loop.mp4", talkUrl:"/api/viewer/assets/talk.mp4" });
    }
    const detail = await r.text().catch(() => "");
    return res.status(r.status || 502).json({ error:"viewer_proxy_failed", status:r.status||502, detail, jesus_url:JESUS_URL });
  } catch (e) {
    console.error("VIEWER PROXY ERROR:", e);
    return res.status(200).json({ stub:true, webrtc:false, idleUrl:"/api/viewer/assets/idle_loop.mp4", talkUrl:"/api/viewer/assets/talk.mp4" });
  }
});
app.get("/api/viewer/offer", (_req, res) => res.status(405).json({ ok:false, error:"use_POST_here" }));

// ---------- WebRTC ingest (audio → jesus-interactivo) ----------
const sessions = new Map();

function chunkPCM(buf, chunkBytes = 1920) {
  const chunks = [];
  for (let i = 0; i + chunkBytes <= buf.length; i += chunkBytes) chunks.push(buf.slice(i, i + chunkBytes));
  return chunks;
}

app.post("/api/ingest/start", async (req, res) => {
  // ⚠️ En Railway puede no haber wrtc: devolvemos stub 200 para no spamear 501 en el front
  if (!RTCPeerConnection || !RTCAudioSource) {
    return res.json({ ok:false, webrtc:false, stub:true, error:"wrtc_not_available" });
  }
  try {
    const { ttsUrl } = req.body || {};
    if (!ttsUrl) return res.status(400).json({ error: "missing_ttsUrl" });
    if (!JESUS_URL) return res.status(500).json({ error: "missing_JESUS_URL" });

    const pc = new RTCPeerConnection();
    const source = new RTCAudioSource();
    const track = source.createTrack();
    pc.addTrack(track);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const r = await fetch(`${JESUS_URL}/ingest/offer`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ sdp: offer.sdp, type: offer.type }),
      agent: INSECURE_AGENT,
    });
    if (!r.ok) {
      const detail = await r.text().catch(()=> "");
      return res.status(r.status || 500).json({ error: "jesus_ingest_failed", detail });
    }
    const answer = await r.json();
    await pc.setRemoteDescription(answer);

    const ff = spawn(ffmpegPath, [
      "-re","-i", ttsUrl,
      "-f","s16le","-acodec","pcm_s16le",
      "-ac","1","-ar","48000",
      "pipe:1",
    ], { stdio:["ignore","pipe","inherit"] });

    ff.on("error",(e)=> console.error("[ffmpeg error]", e));
    ff.on("close",(code)=> console.log("[ffmpeg closed]", code));

    let leftover = Buffer.alloc(0);
    ff.stdout.on("data", (buf) => {
      const data = Buffer.concat([leftover, buf]);
      const CHUNK = 1920; // 20ms @ 48kHz mono 16-bit
      const chunks = chunkPCM(data, CHUNK);
      const used = chunks.length * CHUNK;
      leftover = data.slice(used);

      for (const c of chunks) {
        const samples = new Int16Array(c.buffer, c.byteOffset, c.byteLength/2);
        source.onData({ samples, sampleRate:48000, bitsPerSample:16, channelCount:1, numberOfFrames:960 });
      }
    });

    const id = Math.random().toString(36).slice(2,10);
    sessions.set(id, { pc, source, ff, track });
    console.log("[ingest started]", id, "→", ttsUrl);
    res.json({ ok:true, id });
  } catch (e) {
    console.error("INGEST START ERROR:", e);
    res.status(500).json({ error:String(e) });
  }
});

app.post("/api/ingest/stop", async (req, res) => {
  const { id } = req.body || {};
  const s = id ? sessions.get(id) : null;
  if (!s) return res.json({ ok:true, note:"no_session" });
  try { s.ff.kill("SIGKILL"); } catch {}
  try { s.track.stop(); } catch {}
  try { await s.pc.close(); } catch {}
  sessions.delete(id);
  res.json({ ok:true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor listo en puerto ${PORT}`));
