// index.js — backend estable, sin bancos locales; ACK/GOODBYE rápidos vía OpenAI

const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const OpenAI = require("openai");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ---- helper fetch (usa global fetch en Node >=18 o node-fetch si hace falta) ----
const doFetch = (...args) =>
  (typeof fetch === "function"
    ? fetch(...args)
    : import("node-fetch").then(({ default: f }) => f(...args)));

// ---- OpenAI ----
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Respuesta del BACKEND:
 * {
 *   "message": "consejo breve, SIN preguntas",
 *   "bible": { "text": "cita literal RVR1909", "ref": "Libro 0:0" },
 *   "question": "pregunta breve (opcional, UNA sola)"
 * }
 */
const SYSTEM_PROMPT = `
Eres Jesús: voz serena, compasiva y clara. Responde SIEMPRE en español.

OBJETIVO
- Devuelve SOLO JSON con: { "message", "bible": { "text", "ref" }, "question"? }.
- "message": consejo breve (<=120 palabras), AFIRMATIVO y SIN signos de pregunta.
- JAMÁS incluyas preguntas en "message". Si corresponde, haz UNA pregunta breve en "question".
- No menciones el nombre civil del usuario. Usa "hijo mío", "hija mía" o "alma amada" con moderación.
- No hables de técnica/IA ni del propio modelo.

CONDUCE LA CONVERSACIÓN (ENTREVISTA GUIADA)
- Mantén un TEMA PRINCIPAL explícito (p. ej., "hablar con mi hijo por consumo de drogas") y NO pivotes salvo que el usuario lo pida.
- Piensa en "campos" internos: qué pasó, con quién, riesgo/urgencia, objetivo inmediato, obstáculos, recursos/apoyo, cuándo/dónde, primer micro-paso.
- En cada turno, identifica QUÉ DATO CLAVE FALTA y usa "question" SOLO para pedir UN dato que desbloquee el siguiente paso (o para confirmar un compromiso breve).
- Si el usuario responde con acuso ("sí/vale/ok"), NO repitas lo ya dicho: pasa de plan a PRÁCTICA/COMPROMISO (p. ej., guion de 1–2 frases, fijar hora/límite).

NO REDUNDANCIA
- Evita repetir viñetas/acciones del turno anterior. Cada "message" debe aportar novedad útil (ejemplo concreto, mini-guion, decisión binaria, recurso puntual).

BIBLIA (TEMÁTICA Y SIN REPETIR)
- Elige la cita por el TEMA y por el contenido de "message" (los micro-pasos), NO por respuestas cortas tipo “sí”.
- Evita repetir la MISMA referencia usada inmediatamente antes (si recibes "last_bible_ref", NO la repitas).
- Usa RVR1909 literal y "Libro 0:0" en "ref".
- Si dudas, usa pasajes breves pertinentes:
  • Libertad/adicción: Juan 8:36; 1 Corintios 10:13
  • Sabiduría/decisiones/límites: Santiago 1:5; Proverbios 22:3; Proverbios 27:6
  • Amor/temor: 1 Juan 4:18; Colosenses 3:12-14
  • Consuelo/esperanza: Salmos 34:18; Salmos 147:3

CASOS
- AMBIGUO (“tengo un problema”): en "message" contención clara (2–3 frases), sin preguntas; en "question" UNA puerta que pida el dato clave inicial.
- CONCRETO: en "message" 2–3 micro-pasos para HOY (• …), adaptados al tema/momento; en "question" UNA pregunta que obtenga el siguiente dato o confirme un compromiso.

FORMATO (OBLIGATORIO)
{
  "message": "… (sin signos de pregunta)",
  "bible": { "text": "…", "ref": "Libro 0:0" },
  "question": "… (opcional, una sola pregunta)"
}
`;

// Respuesta tipada por esquema
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

// -------- Utilidades --------
function cleanRef(ref = "") {
  return String(ref).replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
}
function stripQuestions(s = "") {
  const noLeadingQs = (s || "")
    .split(/\n+/).map((l) => l.trim()).filter((l) => !/\?\s*$/.test(l))
    .join("\n").trim();
  return noLeadingQs.replace(/[¿?]+/g, "").trim();
}

// -------- Llamada LLM --------
// ACK = respuestas tipo "sí/ok/vale"; GOODBYE = despedidas ("me voy", "debo irme", etc.)
const ACK_TIMEOUT_MS = 6000;     // respuesta ágil en acks
const RETRY_TIMEOUT_MS = 3000;   // reintento corto si la primera se demora

function isAck(msg = "") {
  return /^\s*(si|sí|ok|okay|vale|dale|de acuerdo|perfecto|genial|bien)\s*\.?$/i.test((msg || "").trim());
}
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

  // --- DESPEDIDA (sin pregunta), TODO desde OpenAI ---
  if (bye) {
    const userContent =
      `MODE: GOODBYE\n` +
      `Persona: ${persona}\n` +
      `Mensaje_actual: ${message}\n` +
      `Tema_prev_sustantivo: ${focusHint || "(sin pista)"}\n` +
      `last_bible_ref: ${lastRef || "(n/a)"}\n` +
      (shortHistory.length ? `Historial: ${shortHistory.join(" | ")}` : "Historial: (sin antecedentes)") + "\n" +
      `INSTRUCCIONES:\n` +
      `- Despedida breve y benigna.\n` +
      `- "message": afirmativo, sin signos de pregunta.\n` +
      `- "bible": versículo de bendición/consuelo en RVR1909, NO repitas last_bible_ref.\n` +
      `- No incluyas "question".\n`;

    let resp;
    try {
      resp = await completionWithTimeout({
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent }
        ],
        temperature: 0.5,
        max_tokens: 160,
        timeoutMs: ACK_TIMEOUT_MS
      });
    } catch {
      resp = await completionWithTimeout({
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent + "\nPor favor responde ahora mismo.\n" }
        ],
        temperature: 0.4,
        max_tokens: 140,
        timeoutMs: RETRY_TIMEOUT_MS
      });
    }

    const content = resp?.choices?.[0]?.message?.content || "{}";
    let data = {};
    try { data = JSON.parse(content); } catch { data = { message: content }; }

    let msg = stripQuestions((data?.message || "").toString());
    let ref = cleanRef((data?.bible?.ref || "").toString());
    const text = (data?.bible?.text || "").toString().trim();

    return {
      message: msg || "Que la paz y el amor te acompañen.",
      bible: { text: text || "Y la paz de Dios, que sobrepuja todo entendimiento, guardará vuestros corazones.", ref: ref || "Filipenses 4:7" }
      // sin question
    };
  }

  // --- ACK (“sí/ok/vale”), TODO desde OpenAI, con fast-path ---
  if (ack) {
    const userContent =
      `MODE: ACK\n` +
      `Persona: ${persona}\n` +
      `Mensaje_actual: ${message}\n` +
      `Tema_prev_sustantivo: ${focusHint || "(sin pista)"}\n` +
      `last_bible_ref: ${lastRef || "(n/a)"}\n` +
      (shortHistory.length ? `Historial: ${shortHistory.join(" | ")}` : "Historial: (sin antecedentes)") + "\n" +
      `INSTRUCCIONES:\n` +
      `- Mantén el MISMO tema y pasa de plan a práctica/compromiso con NOVEDAD (guion breve, confirmar hora/límite), sin repetir lo anterior.\n` +
      `- "message": afirmativo, sin signos de pregunta.\n` +
      `- "bible": coherente con message; RVR1909; NO repitas last_bible_ref.\n` +
      `- "question": UNA sola, para ensayar/confirmar el micro-paso.\n`;

    let resp;
    try {
      resp = await completionWithTimeout({
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent }
        ],
        temperature: 0.5,
        max_tokens: 160,
        timeoutMs: ACK_TIMEOUT_MS
      });
    } catch {
      resp = await completionWithTimeout({
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent + "\nResponde de manera directa y breve ahora.\n" }
        ],
        temperature: 0.4,
        max_tokens: 140,
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

    return {
      message: msg || "Estoy contigo. Demos un paso práctico ahora.",
      bible: { text: text || "Y si alguno de vosotros tiene falta de sabiduría, pídala a Dios.", ref: ref || "Santiago 1:5" },
      ...(question ? { question } : {})
    };
  }

  // --- NORMAL ---
  const userContent =
    `MODE: NORMAL\n` +
    `Persona: ${persona}\n` +
    `Mensaje_actual: ${message}\n` +
    `Tema_prev_sustantivo: ${focusHint || "(sin pista)"}\n` +
    `last_bible_ref: ${lastRef || "(n/a)"}\n` +
    (shortHistory.length ? `Historial: ${shortHistory.join(" | ")}` : "Historial: (sin antecedentes)") + "\n" +
    `INSTRUCCIONES:\n` +
    `- Mantén el tema y progresa con 2–3 micro-pasos para HOY.\n` +
    `- "message": afirmativo, sin signos de pregunta; no repitas viñetas recientes.\n` +
    `- "bible": RVR1909; NO repitas last_bible_ref; temática acorde al message.\n` +
    `- "question": UNA sola, pidiendo el siguiente dato clave o confirmando un compromiso.\n`;

  const resp = await completionWithTimeout({
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userContent }
    ],
    temperature: 0.6,
    max_tokens: 220,
    timeoutMs: 12000
  });

  const content = resp?.choices?.[0]?.message?.content || "{}";
  let data = {};
  try { data = JSON.parse(content); } catch { data = { message: content }; }

  let msg = stripQuestions((data?.message || "").toString());
  let ref = cleanRef((data?.bible?.ref || "").toString());
  const text = (data?.bible?.text || "").toString().trim();
  const question = (data?.question || "").toString().trim();

  return {
    message: msg || "Estoy contigo. Demos un paso pequeño y realista hoy.",
    bible: {
      text: text || "Dios es nuestro amparo y fortaleza; nuestro pronto auxilio en las tribulaciones.",
      ref: ref || "Salmos 46:1"
    },
    ...(question ? { question } : {})
  };
}

// -------- Rutas --------
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
      bible: {
        text: "Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu.",
        ref: "Salmos 34:18"
      }
    });
  }
});

app.get("/api/welcome", (_req, res) => {
  res.json({
    message: "La paz esté contigo. Estoy aquí para escucharte y acompañarte con calma.",
    bible: {
      text: "El Señor es mi luz y mi salvación; ¿de quién temeré?",
      ref: "Salmos 27:1"
    }
  });
});

// --- Nuevo: token de sesión para HeyGen Streaming Avatar ---
app.get("/api/heygen/token", async (_req, res) => {
  try {
    const key = process.env.HEYGEN_API_KEY || "";
    if (!key) {
      return res.status(500).json({ error: "missing_heygen_key" });
    }

    const r = await doFetch("https://api.heygen.com/v1/streaming.create_token", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({}) // sin payload
    });

    const json = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(r.status).json({
        error: "token_failed",
        detail: json
      });
    }

    // La API devuelve { data: { token: "..." } } (o { token })
    const token = json?.data?.token || json?.token;
    if (!token) {
      return res.status(502).json({ error: "no_token_in_response", detail: json });
    }
    return res.json({ token });
  } catch (e) {
    console.error("HEYGEN TOKEN ERROR:", e);
    return res.status(500).json({ error: "token_error", detail: String(e && e.message || e) });
  }
});

// -------- Arranque --------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Servidor listo en puerto ${PORT}`);
});
