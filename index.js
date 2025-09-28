// index.js — Backend monolítico, dominios acotados, respuestas naturales y STREAM PCM→Avatar
// - /api/welcome    : saludo contextual (OpenAI)
// - /api/ask        : respuesta estructurada (OpenAI)
// - /api/heygen/*   : token y config de Heygen
// - /api/avatar/*   : proxy a tu servidor Avatar (mp4 test, viseme script, mjpeg streaming)
// - /api/avatar/apply-viseme : NUEVO -> recibe audio_url, calcula visemas (8085) y activa script (8084)
// - /ws/pcm         : WebSocket para enviar audio PCM 16k del front hacia el servidor Avatar (baja latencia)

const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const OpenAI = require("openai");
const path = require("path");
const fs = require("fs/promises");
const { Readable } = require("stream");
const fetch = global.fetch || require("node-fetch");
const { query, ping } = require("./db/pg");
require("dotenv").config();

// =================== App base ===================
const app = express();
app.use(cors({ origin: true }));
app.use(bodyParser.json({ limit: "25mb" }));

// ---------- OpenAI ----------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------- Avatar Upstreams (IMPORTANTE) ----------
// 8085: tu Node que genera visemas ( /viseme ) y sirve /content/audio_*.wav
const AVATAR_API_BASE_URL = (process.env.AVATAR_API_BASE_URL || "http://34.139.173.100:8085").replace(/\/+$/, "");

// 8084: tu FastAPI que sirve MJPEG ( /mjpeg ) y recibe /script
const AVATAR_SCRIPT_URL = (process.env.AVATAR_SCRIPT_URL || "http://34.139.173.100:8084/script").trim();

// MJPEG directo (para proxy)
const AVATAR_MJPEG_URL = (process.env.AVATAR_MJPEG_URL || "http://34.139.173.100:8084/mjpeg").trim();

// WS PCM directo (para proxy /ws/pcm → upstream)
const AVATAR_WS_URL = (process.env.AVATAR_WS_URL || "ws://34.139.173.100:8084/pcm").trim();

// MP4 de prueba (fallback)
const AVATAR_API_TEST_VIDEO = (process.env.AVATAR_API_TEST_VIDEO || `${AVATAR_API_BASE_URL}/content/AVATARESPANOL.mp4`).replace(/\/+$/, "");

// Imagen por defecto para /script (la podés cambiar por idioma desde el front)
const AVATAR_DEFAULT_IMG = process.env.AVATAR_DEFAULT_IMG || "/opt/avatar-rt/server/content/my_avatar.jpg";

// ---------- Utils ----------
const NORM = (s = "") => String(s).toLowerCase().replace(/\s+/g, " ").trim();

function langLabel(l = "es") {
  const m = { es: "Español", en: "English", pt: "Português", it: "Italiano", de: "Deutsch", ca: "Català", fr: "Français" };
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

const DAILY_FALLBACKS = {
  es: ["La paz también crece en lo pequeño.", "Un paso honesto hoy abre caminos mañana.", "No estás solo: vamos de a poco."],
  en: ["Small honest steps open the way.", "You’re not alone; let’s start small."],
  pt: ["Um passo sincero hoje abre caminhos."],
  it: ["Un passo sincero oggi apre la strada."],
  de: ["Ein ehrlicher Schritt heute öffnet Wege."],
  ca: ["Un pas sincer avui obre camins."],
  fr: ["Un pas sincère aujourd’hui ouvre la voie."],
};
const dayFallback = (lang = "es") =>
  (DAILY_FALLBACKS[lang] || DAILY_FALLBACKS["es"])[Math.floor(Math.random() * (DAILY_FALLBACKS[lang]?.length || 3))];

// ---------- Memoria en FS (simple) ----------
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
async function ensureDataDir() { try { await fs.mkdir(DATA_DIR, { recursive: true }); } catch {} }
function memPath(uid) { const safe = String(uid || "anon").replace(/[^a-z0-9_-]/gi, "_"); return path.join(DATA_DIR, `mem_${safe}.json`); }
async function readMem(userId) {
  await ensureDataDir();
  try {
    const raw = await fs.readFile(memPath(userId), "utf8");
    const m = JSON.parse(raw);
    return { name: m.name || "", sex: m.sex || "", last_user_text: m.last_user_text || "", last_user_ts: m.last_user_ts || 0, last_bot: m.last_bot || null, last_refs: Array.isArray(m.last_refs) ? m.last_refs : [] };
  } catch { return { name: "", sex: "", last_user_text: "", last_user_ts: 0, last_bot: null, last_refs: [] }; }
}
async function writeMem(userId, mem) { await ensureDataDir(); await fs.writeFile(memPath(userId), JSON.stringify(mem, null, 2), "utf8"); }

// ---------- Health ----------
app.get("/", (_req, res) => res.json({ ok: true, service: "backend", ts: Date.now() }));

// ---------- DB Health ----------
app.get("/db/health", async (_req, res) => {
  try { const now = await ping(); res.json({ ok: true, now }); }
  catch (e) { console.error("DB HEALTH ERROR:", e); res.status(500).json({ ok: false, error: String(e) }); }
});

// (Opcional) Conteo rápido de usuarios
app.get("/db/test", async (_req, res) => {
  try { const r = await query("SELECT COUNT(*)::int AS users FROM users"); res.json({ users: r.rows?.[0]?.users ?? 0 }); }
  catch (e) { console.error("DB TEST ERROR:", e); res.status(500).json({ ok: false, error: String(e) }); }
});

// ---------- /api/welcome ----------
app.post("/api/welcome", async (req, res) => {
  try {
    const { lang = "es", name = "", sex = "", userId = "anon", history = [], localHour = null, hour = null, tzOffsetMinutes = null } = req.body || {};
    const resolvedHour = Number.isInteger(localHour) ? localHour : resolveLocalHour({ hour, tzOffsetMinutes });

    const mem = await readMem(userId);
    const nm = String(name || mem.name || "").trim();
    const sx = String(sex || mem.sex || "").trim().toLowerCase();
    if (nm) mem.name = nm;
    if (sx === "male" || sx === "female") mem.sex = sx;
    await writeMem(userId, mem);

    let sal = nm ? `${greetingByHour(lang, resolvedHour)}, ${nm}.` : `${greetingByHour(lang, resolvedHour)}.`;
    if (Math.random() < 0.25) { if (mem.sex === "female") sal += " Hija mía,"; else if (mem.sex === "male") sal += " Hijo mío,"; }

    const W_SYS = `
Devuélveme SOLO un JSON en ${langLabel(lang)} con este esquema:
{"phrase":"<frase alentadora breve, suave, de autoestima, sin clichés ni tono duro>",
 "question":"<UNA pregunta íntima/acompañamiento (no cuestionario), distinta a '¿Qué te gustaría compartir hoy?'>"}
Condiciones:
- Evita fórmulas gastadas.
- La pregunta invita a hablar (breve, íntima, no inquisitiva).
- No incluyas nada fuera del JSON.`.trim();

    let phrase = "", question = "";
    try {
      const r = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.9,
        max_tokens: 180,
        messages: [{ role: "system", content: W_SYS }, ...(Array.isArray(history) ? history.slice(-6).map(h => ({ role: "user", content: String(h) })) : []), { role: "user", content: nm ? `Nombre del usuario: ${nm}` : "Usuario anónimo" }],
        response_format: { type: "json_object" },
      });
      const content = r?.choices?.[0]?.message?.content || "{}";
      const data = JSON.parse(content);
      phrase = String(data?.phrase || "").trim();
      question = String(data?.question || "").trim();
    } catch {
      phrase = dayFallback(lang);
      question = lang === "en" ? "What would help you right now?" :
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

// ---------- /api/ask ----------
app.post("/api/ask", async (req, res) => {
  try {
    const { message = "", history = [], userId = "anon", lang = "es" } = req.body || {};
    const userTxt = String(message || "").trim();

    const mem = await readMem(userId);
    const now = Date.now();

    if (userTxt && mem.last_user_text && userTxt === mem.last_user_text && now - mem.last_user_ts < 7000) {
      if (mem.last_bot) return res.json(mem.last_bot);
    }

    // filtros simples omitidos por brevedad… (puedes pegar los tuyos si los usas)

    const SYS = `
Eres cercano, claro y compasivo, desde una voz cristiana (católica).
Alcance: espiritualidad/fe católica, psicología/autoayuda personal, relaciones y emociones.
Varía el lenguaje; 1 sola pregunta breve y pertinente.
Formato (JSON en ${langLabel(lang)}): {"message":"...", "question":"...?", "bible":{"text":"...","ref":"Libro 0:0"}}
- "message": natural y concreto; si el usuario pide pasos, dáselos breve.
- "bible": SIEMPRE incluida; evita Mateo 11:28 y repetidas.
No incluyas nada fuera del JSON.`.trim();

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
      bible: { text: String(data?.bible?.text || "").trim(), ref: String(data?.bible?.ref || "").trim() },
    };

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
      bible: { text: "", ref: "" },
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

// ---------- Avatar Health ----------
app.get("/api/avatar/health", async (_req, res) => {
  try {
    const r = await fetch(`${AVATAR_API_BASE_URL}/health`);
    const j = await r.json().catch(() => ({}));
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(r.status || 200).json(j);
  } catch (e) {
    return res.status(502).json({ error: "avatar_upstream_unreachable", detail: String(e) });
  }
});

// ---------- MP4 de prueba (streaming) ----------
app.get("/api/avatar/test-video", async (_req, res) => {
  try {
    const r = await fetch(AVATAR_API_TEST_VIDEO);
    if (!r.ok) return res.status(r.status || 502).json({ error: "upstream_error", status: r.status });
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", r.headers.get("content-type") || "video/mp4");
    if (r.body && typeof Readable.fromWeb === "function") {
      Readable.fromWeb(r.body).pipe(res);
    } else {
      const buf = Buffer.from(await r.arrayBuffer());
      res.end(buf);
    }
  } catch (e) {
    console.error("avatar test-video error:", e);
    res.status(502).json({ error: "fetch_failed", detail: String(e) });
  }
});

// ---------- MJPEG (proxy a 8084) ----------
app.get("/api/avatar/mjpeg", async (_req, res) => {
  try {
    const r = await fetch(AVATAR_MJPEG_URL);
    if (!r.ok) return res.status(r.status || 502).json({ error: "upstream_error", status: r.status });
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-store, no-transform");
    const ct = r.headers.get("content-type") || "multipart/x-mixed-replace; boundary=frame";
    res.setHeader("Content-Type", ct);
    res.setHeader("Connection", "keep-alive");
    if (r.body && typeof Readable.fromWeb === "function") {
      Readable.fromWeb(r.body).pipe(res);
    } else {
      const buf = Buffer.from(await r.arrayBuffer());
      res.end(buf);
    }
  } catch (e) {
    console.error("avatar mjpeg error:", e);
    res.status(502).json({ error: "mjpeg_proxy_failed", detail: String(e) });
  }
});

app.head("/api/avatar/mjpeg", async (_req, res) => {
  try {
    const r = await fetch(AVATAR_MJPEG_URL, { method: "HEAD" });
    const ct = r.headers.get("content-type") || "multipart/x-mixed-replace; boundary=frame";
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-store, no-transform");
    res.setHeader("Content-Type", ct);
    return res.status(r.status || 200).end();
  } catch (e) {
    console.error("avatar mjpeg HEAD error:", e);
    return res.status(502).json({ error: "mjpeg_head_proxy_failed", detail: String(e) });
  }
});

// ---------- NUEVO: aplicar visemas con audio_url ----------
app.post("/api/avatar/apply-viseme", async (req, res) => {
  try {
    const { audio_url, t0_ms, img, loop, totalSeconds } = req.body || {};
    const audioUrl = String(audio_url || "").trim();
    if (!audioUrl) return res.status(400).json({ error: "missing_audio_url" });

    // 1) pedir visemas al servidor Node (8085)
    const visemeRes = await fetch(`${AVATAR_API_BASE_URL}/viseme`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audio_url: audioUrl }),
    });
    if (!visemeRes.ok) {
      const txt = await visemeRes.text().catch(() => "");
      throw new Error(`viseme_failed: ${visemeRes.status} ${txt}`);
    }
    const vis = await visemeRes.json();
    if (!vis?.mouthCues?.length) throw new Error("no_mouthCues");

    // 2) mandar script al emisor MJPEG (8084)
    const payload = {
      mouthCues: vis.mouthCues,
      totalSeconds: totalSeconds || vis.totalSeconds || 0,
      img: img || AVATAR_DEFAULT_IMG,
      t0_ms: Number.isInteger(t0_ms) ? t0_ms : Date.now() + 120, // pequeño offset para alinear
      loop: Boolean(loop || false),
    };
    const scriptRes = await fetch(AVATAR_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!scriptRes.ok) {
      const txt = await scriptRes.text().catch(() => "");
      throw new Error(`script_failed: ${scriptRes.status} ${txt}`);
    }
    const scriptAck = await scriptRes.json().catch(() => ({}));

    res.json({ ok: true, mouthCues: vis.mouthCues, totalSeconds: vis.totalSeconds || 0, script: scriptAck });
  } catch (e) {
    console.error("apply-viseme error:", e);
    res.status(500).json({ error: "apply_viseme_failed", detail: String(e.message || e) });
  }
});

// (Opcional) Modo PROXY TALK (si tenés upstream real distinto). Aquí dejamos mock:
app.post("/api/avatar/talk", async (_req, res) => {
  const id = Math.random().toString(36).slice(2);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.json({ request_id: id, status: "queued" });
});

app.get("/api/avatar/talk/:id", async (req, res) => {
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  const videoUrl = `${baseUrl}/api/avatar/test-video?t=${Date.now()}`;
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.json({ status: "finished", video_url: videoUrl });
});

// =================== HTTP Server + WS Upgrade (PCM) ===================
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => console.log(`Servidor listo en puerto ${PORT}`));

// ===== WebSocket PCM proxy → Avatar (STREAM en tiempo real) =====
const { WebSocketServer, WebSocket } = require("ws");

// Creamos un WSS y usamos el mismo server HTTP para upgrade
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

server.on("upgrade", (req, socket, head) => {
  try {
    const url = req.url || "";
    if (!url.startsWith("/ws/pcm")) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (client) => { wss.emit("connection", client, req); });
  } catch (e) { try { socket.destroy(); } catch {} }
});

wss.on("connection", (client) => {
  // Conexión hacia el upstream (servidor Avatar FastAPI 8084) — sin compresión
  const upstream = new WebSocket(AVATAR_WS_URL, { perMessageDeflate: false });

  const closeBoth = () => { try { client.close(); } catch {}; try { upstream.close(); } catch {}; };

  upstream.on("open", () => {
    // Front → Upstream
    client.on("message", (msg, isBinary) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(msg, { binary: isBinary });
    });
    client.on("close", closeBoth);
    client.on("error", closeBoth);

    // Upstream → Front (ACK/latidos opcionales)
    upstream.on("message", (msg, isBinary) => {
      if (client.readyState === WebSocket.OPEN) client.send(msg, { binary: isBinary });
    });
  });

  upstream.on("close", closeBoth);
  upstream.on("error", closeBoth);
});

console.log("WS proxy listo en /ws/pcm →", AVATAR_WS_URL);
