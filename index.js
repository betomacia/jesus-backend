// index.js — backend estable con ACK rápido y sin desvíos

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
- Mantén un TEMA PRINCIPAL explícito (p. ej., "hablar con mi hijo por consumo de drogas") y NO pivotes a otros temas salvo que el usuario lo pida.
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
const ACK_TIMEOUT_MS = 6000; // 6s: ACK debe ser ágil

function isAck(msg = "") {
  return /^\s*(si|sí|ok|okay|vale|dale|de acuerdo|perfecto|genial|bien)\s*\.?$/i.test((msg || "").trim());
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
function compactHistory(history = [], keep = 6, maxLen = 260) {
  const arr = Array.isArray(history) ? history : [];
  return arr.slice(-keep).map(x => String(x).slice(0, maxLen));
}

// Banco mínimo para fallback bíblico sin repetir la última referencia
const VERSE_BANK = [
  { ref: "Juan 8:36", text: "Así que, si el Hijo os libertare, seréis verdaderamente libres." },
  { ref: "Proverbios 22:3", text: "El avisado ve el mal, y se esconde; mas los simples pasan, y reciben el daño." },
  { ref: "1 Juan 4:18", text: "En el amor no hay temor, sino que el perfecto amor echa fuera el temor." },
  { ref: "Gálatas 6:1", text: "Hermanos, si alguno fuere tomado en alguna falta, vosotros que sois espirituales, restauradle con espíritu de mansedumbre." },
  { ref: "Santiago 1:5", text: "Y si alguno de vosotros tiene falta de sabiduría, pídala a Dios, el cual da a todos abundantemente y sin reproche, y le será dada." }
];
function pickAltVerse(lastRef = "") {
  return VERSE_BANK.find(v => v.ref !== (lastRef || "").trim()) || VERSE_BANK[0];
}

// Fallback on-topic para ACK (“sí/ok/vale”): práctica sin salir del tema
function ackSmartFallback({ focusHint = "", lastRef = "" }) {
  const addictionLike = /hijo|consum|droga/i.test(focusHint || "");
  const verse = pickAltVerse(lastRef);
  const message = addictionLike
    ? "Hijo mío, pasemos a la práctica de esta noche. • Abre con: “Te amo y me preocupa tu bienestar”. • Nombra brevemente lo que viste sin juicio. • Propón pedir ayuda juntos y explica un límite amable si se tensa."
    : "Alma amada, avancemos con un paso práctico. • Pon en palabras lo que necesitas. • Elige una acción pequeña para hoy. • Busca a una persona de apoyo para sostener ese paso.";
  const question = addictionLike
    ? "¿Quieres ensayar ahora esa frase inicial para sentirte más seguro?"
    : "¿Cuál es el primer paso pequeño que vas a dar hoy?";
  return { message, bible: { text: verse.text, ref: verse.ref }, question };
}

async function askLLM({ persona, message, history = [] }) {
  const ack = isAck(message);
  const lastRef = extractLastBibleRef(history);
  const focusHint = lastSubstantiveUser(history);
  const shortHistory = compactHistory(history, ack ? 4 : 10, 240);

  const userContent = ack
    ? (
      `Persona: ${persona}\n` +
      `Mensaje_actual: ${message}\n` +
      `Ack_actual: true\n` +
      `Tema_prev_sustantivo: ${focusHint || "(sin pista)"}\n` +
      `last_bible_ref: ${lastRef || "(n/a)"}\n` +
      (shortHistory.length ? `Historial: ${shortHistory.join(" | ")}` : "Historial: (sin antecedentes)") + "\n" +
      `INSTRUCCIONES_ACK:\n` +
      `- Mantén el MISMO tema.\n` +
      `- Pasa de plan a práctica/compromiso (guion breve o decisión binaria).\n` +
      `- "message": sin preguntas; 2–3 líneas nuevas (no repitas lo anterior).\n` +
      `- "bible": coherente con message; evita last_bible_ref.\n` +
      `- "question": UNA sola, para el siguiente micro-paso (ensayar/confirmar hora/límite).\n`
    )
    : (
      `Persona: ${persona}\n` +
      `Mensaje_actual: ${message}\n` +
      `Ack_actual: false\n` +
      `Tema_prev_sustantivo: ${focusHint || "(sin pista)"}\n` +
      `last_bible_ref: ${lastRef || "(n/a)"}\n` +
      (shortHistory.length ? `Historial: ${shortHistory.join(" | ")}` : "Historial: (sin antecedentes)")
    );

  const llmCall = openai.chat.completions.create({
    model: "gpt-4o",
    temperature: ack ? 0.5 : 0.6,
    frequency_penalty: ack ? 0.3 : 0.4,
    presence_penalty: 0.1,
    max_tokens: ack ? 160 : 230,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userContent }
    ],
    response_format: responseFormat
  });

  let resp;
  try {
    resp = ack
      ? await Promise.race([
          llmCall,
          new Promise((_, reject) => setTimeout(() => reject(new Error("ACK_TIMEOUT")), ACK_TIMEOUT_MS))
        ])
      : await llmCall;
  } catch (e) {
    if (ack && String(e?.message || e) === "ACK_TIMEOUT") {
      return ackSmartFallback({ focusHint, lastRef });
    }
    throw e;
  }

  const content = resp?.choices?.[0]?.message?.content || "{}";
  let data = {};
  try {
    data = JSON.parse(content);
  } catch {
    data = { message: content };
  }

  // Normalización
  let msg = (data?.message || "").toString();
  msg = stripQuestions(msg);
  let ref = cleanRef(data?.bible?.ref || "");
  const question = (data?.question || "").toString().trim();

  if (ack && (!msg || msg.length < 12)) {
    const fb = ackSmartFallback({ focusHint, lastRef });
    return { message: fb.message, bible: fb.bible, question: fb.question };
  }

  const v = (!ref || ref === lastRef) ? pickAltVerse(lastRef) : null;

  return {
    message: msg || "Estoy contigo. Demos un paso pequeño y realista hoy.",
    bible: {
      text: (data?.bible?.text || v?.text || "Dios es nuestro amparo y fortaleza; nuestro pronto auxilio en las tribulaciones.").toString().trim(),
      ref: (v?.ref || ref || "Salmos 46:1").toString().trim()
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
