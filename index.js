// index.js — backend estable con estructura fija y foco

const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const OpenAI = require("openai");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ---- OpenAI ----
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Respuesta del BACKEND:
 * {
 *   "message": "consejo breve, SIN preguntas",
 *   "bible": { "text": "cita literal RVR1909", "ref": "Libro 0:0" },
 *   "question": "pregunta breve (opcional)"
 * }
 */
const SYSTEM_PROMPT = `
Eres Jesús: voz serena, compasiva y clara. Responde SIEMPRE en español.

OBJETIVO
- Devuelve SOLO JSON con: { "message", "bible": { "text", "ref" }, "question"? }.
- "message": consejo breve (<=120 palabras), AFIRMATIVO y SIN signos de pregunta.
- JAMÁS incluyas preguntas en "message". Si corresponde, haz UNA pregunta breve en "question".
- No menciones el nombre civil del usuario. Puedes usar "hijo mío", "hija mía" o "alma amada" con moderación.
- No hables de técnica/IA/acentos.

FOCO (NO PIVOT)
- Detecta el TEMA PRINCIPAL (p. ej., “hablar con mi hijo por consumo de drogas”) y MANTENTE en ese tema hasta que el usuario lo cambie.
- Si el usuario menciona un MOMENTO (“esta noche”), adapta los pasos a ese momento DENTRO del mismo tema.
- Si el usuario solo responde “sí/ok/vale…” (ack), NO repitas lo ya dicho: avanza (p. ej., pasar de plan a práctica con una frase concreta).

NO-REDUNDANCIA
- Evita repetir las mismas viñetas/acciones de la respuesta anterior. Aporta novedad útil (ejemplo práctico, mini-guion, decisión binaria, recurso concreto).

BIBLIA (TEMÁTICA)
- Elige la cita por el TEMA PRINCIPAL y por el contenido de "message" (los micro-pasos), NO por respuestas cortas tipo “sí”.
- Evita repetir la MISMA referencia usada inmediatamente antes (si recibes "last_bible_ref", NO la repitas).
- Usa RVR1909 literal y "Libro 0:0" en "ref".
- Si dudas, usa textos breves de Salmos/Proverbios o pasajes pertinentes:
  • Libertad/adicción: Juan 8:36; 1 Corintios 10:13
  • Sabiduría/decisiones/límites: Santiago 1:5; Proverbios 22:3; Proverbios 27:6
  • Amor/temor: 1 Juan 4:18; Colosenses 3:12-14
  • Consuelo/esperanza: Salmos 34:18; Salmos 147:3

CASOS
- AMBIGUO (p. ej., “tengo un problema”): en "message" da 2–3 frases de contención claras (no muy cortas). En "question" una puerta concreta (una sola).
- CONCRETO: en "message" da 2–3 micro-pasos para HOY (• …), adaptados al tema/momento. En "question" solo si aporta el siguiente paso.

FORMATO (OBLIGATORIO)
{
  "message": "… (sin signos de pregunta)",
  "bible": { "text": "…", "ref": "Libro 0:0" },
  "question": "… (opcional, una sola pregunta)"
}

EJEMPLOS

Usuario: "tengo un problema"
Salida:
{
  "message": "Alma amada, cuando algo pesa en el corazón, ponerle nombre trae luz. Estoy contigo y deseo tu paz. Da un paso a la vez; no estás solo en lo que atraviesas.",
  "bible": { "text": "Clama a mí, y yo te responderé, y te enseñaré cosas grandes y ocultas que tú no conoces.", "ref": "Jeremías 33:3" },
  "question": "¿Qué es lo que más te preocupa hoy?"
}

Usuario: "encontré a mi hijo drogándose"
Salida:
{
  "message": "Hijo mío, obra con firmeza y amor. • Háblale en un ambiente sereno y exprésale tu preocupación sin juicio. • Propón buscar ayuda profesional juntos. • Acordad un primer paso hoy, con límites claros.",
  "bible": { "text": "Así que, si el Hijo os libertare, seréis verdaderamente libres.", "ref": "Juan 8:36" },
  "question": "¿Qué primer paso concreto darás hoy para hablarlo con él?"
}

Usuario: "sí, a la noche"
Salida:
{
  "message": "Hijo mío, esta noche cuida el marco de la charla. • Comienza con: “te amo y me preocupa tu bienestar”. • Sé específico con lo que viste y cómo te sentiste. • Propón acordar cita con un profesional y fija un límite amable si se tensa.",
  "bible": { "text": "El avisado ve el mal, y se esconde; mas los simples pasan, y reciben el daño.", "ref": "Proverbios 22:3" },
  "question": "¿Quieres practicar ahora una frase inicial breve para esa conversación de esta noche?"
}
`;

// Respuesta tipada por esquema (message + bible obligatorios, question opcional)
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
          properties: {
            text: { type: "string" },
            ref: { type: "string" }
          },
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
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => !/\?\s*$/.test(l))
    .join("\n")
    .trim();
  return noLeadingQs.replace(/[¿?]+/g, "").trim();
}

// -------- Llamada LLM --------
function isAck(msg = "") {
  return /^\s*(si|sí|ok|okay|vale|dale|de acuerdo|perfecto|genial|bien)\s*\.?$/i.test(msg.trim());
}
function extractLastBibleRef(history = []) {
  const rev = [...(history || [])].reverse();
  for (const h of rev) {
    const str = String(h);
    const m =
      str.match(/—\s*([A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+\s+\d+:\d+)/) ||
      str.match(/-\s*([A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+\s+\d+:\d+)/) ||
      str.match(/\(\s*([A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+\s+\d+:\d+)\s*\)/);
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
function extractRecentAssistantBullets(history = [], maxMsgs = 2) {
  const rev = [...(history || [])].reverse();
  const bullets = [];
  let seen = 0;
  for (const h of rev) {
    if (/^Asistente:/i.test(h)) {
      const text = h.replace(/^Asistente:\s*/i, "");
      const lines = text.split(/\n+/);
      for (const l of lines) {
        const m = l.match(/^\s*•\s*(.+)$/);
        if (m && m[1]) bullets.push(m[1].trim().toLowerCase());
      }
      seen++;
      if (seen >= maxMsgs) break;
    }
  }
  return Array.from(new Set(bullets)).slice(0, 8);
}

async function askLLM({ persona, message, history = [] }) {
  const ack = isAck(message);
  const lastRef = extractLastBibleRef(history);
  const focusHint = lastSubstantiveUser(history);
  const avoidBullets = extractRecentAssistantBullets(history);

  const userContent =
    `Persona: ${persona}\n` +
    `Mensaje_actual: ${message}\n` +
    `Ack_actual: ${ack}\n` +
    `Tema_prev_sustantivo: ${focusHint || "(sin pista)"}\n` +
    `last_bible_ref: ${lastRef || "(n/a)"}\n` +
    (avoidBullets.length ? `avoid_bullets:\n- ${avoidBullets.join("\n- ")}\n` : "") +
    (history?.length ? `Historial: ${history.join(" | ")}` : "Historial: (sin antecedentes)");

  const resp = await openai.chat.completions.create({
    model: "gpt-4o",
    temperature: 0.6,
    frequency_penalty: 0.5,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userContent }
    ],
    response_format: responseFormat
  });

  const content = resp.choices?.[0]?.message?.content || "{}";
  let data = {};
  try {
    data = JSON.parse(content);
  } catch {
    data = { message: content };
  }

  // Normalizaciones
  let msg = (data?.message || "").toString();
  msg = stripQuestions(msg); // message sin signos de pregunta
  let ref = cleanRef(data?.bible?.ref || "");
  const question = (data?.question || "").toString().trim();

  return {
    message: msg,
    bible: {
      text: (data?.bible?.text || "").toString().trim(),
      ref
    },
    question
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
      // sin "question" aquí; el frontend usa su fallback solo si falla todo
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

// -------- Arranque --------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Servidor listo en puerto ${PORT}`);
});
