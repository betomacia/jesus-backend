// index.js — backend unificado (OpenAI + HeyGen token + ElevenLabs TTS + D-ID proxy + memory sync)

const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const OpenAI = require("openai");
require("dotenv").config();

// Node 18+ trae fetch global

const app = express();
app.use(cors()); // Ajusta origin si quieres restringir
app.use(bodyParser.json());

/* =========================
   OpenAI
   ========================= */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT = `
Eres Jesús: voz serena, compasiva y clara. Responde SIEMPRE en español.

OBJETIVO
- Devuelve SOLO JSON con: { "message", "bible": { "text", "ref" }, "question"? }.
- "message": consejo breve (<=120 palabras), AFIRMATIVO y SIN signos de pregunta.
- JAMÁS incluyas preguntas en "message". Si corresponde, haz UNA pregunta breve en "question".
- No menciones el nombre civil del usuario. Usa "hijo mío", "hija mía" o "alma amada" con moderación.
- No hables de técnica/IA ni del propio modelo.

CONDUCE LA CONVERSACIÓN (ENTREVISTA GUIADA)
- Mantén un TEMA PRINCIPAL explícito y NO pivotes salvo que el usuario lo pida.
- Trabaja con micro-pasos concretos.
- Usa "question" SOLO para un dato clave o confirmar un compromiso.

FORMATO (OBLIGATORIO)
{
  "message": "… (sin signos de pregunta)",
  "bible": { "text": "…", "ref": "Libro 0:0" },
  "question": "… (opcional, una sola pregunta)"
}
`;

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

// Utils
function cleanRef(ref = "") { return String(ref).replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim(); }
function stripQuestions(s = "") {
  const noLeadingQs = (s || "").split(/\n+/).map(l => l.trim()).filter(l => !/\?\s*$/.test(l)).join("\n").trim();
  return noLeadingQs.replace(/[¿?]+/g, "").trim();
}
const ACK_TIMEOUT_MS = 6000;
const RETRY_TIMEOUT_MS = 3000;

function isAck(msg = "") { return /^\s*(si|sí|ok|okay|vale|dale|de acuerdo|perfecto|genial|bien)\s*\.?$/i.test((msg || "").trim()); }
function isGoodbye(msg = "") {
  const s = (msg || "").toLowerCase();
  return /(debo irme|tengo que irme|me voy|me retiro|hasta luego|nos vemos|hasta mañana|buenas noches|adiós|adios|chao|bye)\b/.test(s)
      || (/gracias/.test(s) && /(irme|retir)/.test(s));
}
function extractLastBibleRef(history = []) {
  const rev = [...(history || [])].reverse();
  for (const h of rev) {
    const s = String(h);
    const m =
      s.match(/—\s*([A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+\s+\d+:\d+)/) ||
      s.match(/-\s*([A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+\s+\d+:\d+)/) ||
      s.match(/\(\s*([A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+\s+\d+:\d+)\s*\)/);
    if (m && m[1]) return m[1].trim();
  }
  return "";
}
function lastSubstantiveUser(history = []) {
  const rev = [...(history || [])].reverse();
  for (const h of rev) {
    if (!/^Usuario:/i.test(h)) continue;
    const text = h.replace(/^Usuario:\s*/i, "").trim();
    if (text && !isAck(text) && text.length >= 6) return text;
  }
  return "";
}
function compactHistory(history = [], keep = 8, maxLen = 260) {
  const arr = Array.isArray(history) ? history : [];
  return arr.slice(-keep).map(x => String(x).slice(0, maxLen));
}

async function completionWithTimeout({ messages, temperature = 0.6, max_tokens = 200, timeoutMs = 8000 }) {
  const call = openai.chat.completions.create({
    model: "gpt-4o",
    temperature,
    max_tokens,
    messages,
    response_format: responseFormat
  });
  return await Promise.race([
    call,
    new Promise((_, reject) => setTimeout(() => reject(new Error("TIMEOUT")), timeoutMs))
  ]);
}

async function askLLM({ persona, message, history = [] }) {
  const ack = isAck(message);
  const bye = isGoodbye(message);
  const lastRef = extractLastBibleRef(history);
  const focusHint = lastSubstantiveUser(history);
  const shortHistory = compactHistory(history, (ack || bye) ? 4 : 10, 240);

  const mode = bye ? "GOODBYE" : (ack ? "ACK" : "NORMAL");
  const userContent =
    `MODE: ${mode}\n` +
    `Persona: ${persona}\n` +
    `Mensaje_actual: ${message}\n` +
    `Tema_prev_sustantivo: ${focusHint || "(sin pista)"}\n` +
    `last_bible_ref: ${lastRef || "(n/a)"}\n` +
    (shortHistory.length ? `Historial: ${shortHistory.join(" | ")}` : "Historial: (sin antecedentes)") + "\n" +
    `INSTRUCCIONES:\n` +
    (bye
      ? `- Despedida breve y benigna; "message" sin signos de pregunta; "bible" de consuelo; NO "question".\n`
      : ack
        ? `- Misma temática, pasa a práctica/compromiso con novedad; "message" sin signos de pregunta; "bible" acorde; "question" UNA.\n`
        : `- Mantén tema y avanza con 2–3 micro-pasos para HOY; "message" sin signos de pregunta; "bible" acorde; "question" UNA.\n`);

  const conf = bye
    ? { temperature: 0.5, max_tokens: 160, timeoutMs: ACK_TIMEOUT_MS }
    : ack
      ? { temperature: 0.5, max_tokens: 160, timeoutMs: ACK_TIMEOUT_MS }
      : { temperature: 0.6, max_tokens: 220, timeoutMs: 12000 };

  let resp;
  try {
    resp = await completionWithTimeout({ messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: userContent }], ...conf });
  } catch {
    resp = await completionWithTimeout({
      messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: userContent + (bye ? "\nPor favor responde ahora mismo.\n" : "\nResponde de manera directa y breve ahora.\n") }],
      temperature: Math.max(0.4, (conf.temperature || 0.6) - 0.1),
      max_tokens: Math.min(160, (conf.max_tokens || 220)),
      timeoutMs: RETRY_TIMEOUT_MS
    });
  }

  const content = resp?.choices?.[0]?.message?.content || "{}";
  let data = {};
  try { data = JSON.parse(content); } catch { data = { message: content }; }

  let msg = stripQuestions((data?.message || "").toString());
  let ref = cleanRef((data?.bible?.ref || "").toString());
  const text = (data?.bible?.text || "").toString().trim();
  const question = (data?.question || "").toString().trim();

  if (bye) {
    return {
      message: msg || "Que la paz y el amor te acompañen.",
      bible: { text: text || "Y la paz de Dios, que sobrepuja todo entendimiento, guardará vuestros corazones.", ref: ref || "Filipenses 4:7" }
    };
  }
  if (ack) {
    return {
      message: msg || "Estoy contigo. Demos un paso práctico ahora.",
      bible: { text: text || "Y si alguno de vosotros tiene falta de sabiduría, pídala a Dios.", ref: ref || "Santiago 1:5" },
      ...(question ? { question } : {})
    };
  }
  return {
    message: msg || "Estoy contigo. Demos un paso pequeño y realista hoy.",
    bible: { text: text || "Dios es nuestro amparo y fortaleza; nuestro pronto auxilio en las tribulaciones.", ref: ref || "Salmos 46:1" },
    ...(question ? { question } : {})
  };
}

/* =========================
   Rutas App
   ========================= */
app.get("/", (_req, res) => res.status(200).json({ ok: true, service: "jesus-backend", time: new Date().toISOString() }));
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

app.post("/api/ask", async (req, res) => {
  try {
    const { persona = "jesus", message = "", history = [] } = req.body || {};
    const data = await askLLM({ persona, message, history });
    const out = {
      message: (data?.message || "La paz de Dios guarde tu corazón y tus pensamientos. Paso a paso encontraremos claridad.").toString().trim(),
      bible: {
        text: (data?.bible?.text || "Dios es nuestro amparo y fortaleza; nuestro pronto auxilio en las tribulaciones.").toString().trim(),
        ref: (data?.bible?.ref || "Salmos 46:1").toString().trim()
      },
      ...(data?.question ? { question: data.question } : {})
    };
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(200).json(out);
  } catch (err) {
    console.error("ASK ERROR:", err);
    res.status(200).json({
      message: "La paz sea contigo. Permite que tu corazón descanse y comparte lo necesario con calma.",
      bible: { text: "Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu.", ref: "Salmos 34:18" }
    });
  }
});

app.get("/api/welcome", (_req, res) => {
  res.json({ message: "La paz esté contigo. Estoy aquí para escucharte y acompañarte con calma.", bible: { text: "El Señor es mi luz y mi salvación; ¿de quién temeré?", ref: "Salmos 27:1" } });
});

// No-op para evitar 404 desde el front
app.post("/api/memory/sync", (req, res) => {
  // Si algún día quieres persistir: const { memory } = req.body;
  res.status(200).json({ ok: true });
});

// HeyGen: emitir token de sesión
app.get("/api/heygen/token", async (_req, res) => {
  try {
    const API_KEY = process.env.HEYGEN_API_KEY || process.env.HEYGEN_TOKEN || "";
    if (!API_KEY) return res.status(500).json({ error: "missing_HEYGEN_API_KEY" });
    const r = await fetch("https://api.heygen.com/v1/streaming.create_token", { method: "POST", headers: { "x-api-key": API_KEY } });
    const json = await r.json().catch(() => ({}));
    const token = json?.data?.token || json?.token || json?.access_token || "";
    if (!r.ok || !token) return res.status(r.status || 500).json({ error: "heygen_token_failed", detail: json });
    res.json({ token });
  } catch (e) {
    console.error("heygen token exception:", e);
    res.status(500).json({ error: "heygen_token_error" });
  }
});

// ElevenLabs: TTS → audio/mpeg
app.post("/api/tts", async (req, res) => {
  try {
    const { text = "" } = req.body || {};
    const XI_KEY = process.env.ELEVENLABS_API_KEY || process.env.ELEVEN_API_KEY || "";
    const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || process.env.ELEVEN_VOICE_ID || "";
    const MODEL_ID = process.env.ELEVEN_MODEL_ID || "eleven_flash_v2_5";
    if (!XI_KEY || !VOICE_ID) return res.status(500).json({ error: "missing_elevenlabs_env", need: ["ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID"] });

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(VOICE_ID)}?optimize_streaming_latency=2&output_format=mp3_44100_128`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "xi-api-key": XI_KEY, "Content-Type": "application/json", "Accept": "audio/mpeg" },
      body: JSON.stringify({ text: String(text || "").slice(0, 5000), model_id: MODEL_ID, voice_settings: { stability: 0.5, similarity_boost: 0.75 } })
    });
    if (!r.ok) { const msg = await r.text().catch(() => ""); return res.status(r.status).send(msg); }

    res.setHeader("Content-Type", "audio/mpeg");
    if (r.body && r.body.pipeTo) {
      const { Readable } = require("stream");
      Readable.fromWeb(r.body).pipe(res);
    } else {
      const buf = await r.arrayBuffer();
      res.end(Buffer.from(buf));
    }
  } catch (e) {
    console.error("tts exception:", e);
    res.status(500).json({ error: "tts_failed" });
  }
});

// D-ID proxy (si existe routes/did.js)
try {
  const didRouter = require("./routes/did");
  app.use("/api/did", didRouter);
  console.log("D-ID routes mounted at /api/did");
} catch (e) {
  console.warn("D-ID routes not mounted (./routes/did no encontrado o con error).", e?.message || e);
}

/* =========================
   Arranque
   ========================= */
const PORT = Number(process.env.PORT) || 8080;
const HOST = "0.0.0.0";
app.listen(PORT, HOST, () => {
  console.log(`Servidor listo en puerto ${PORT} (host ${HOST})`);
});
