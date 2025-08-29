const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const OpenAI = require("openai");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ---- OpenAI ----
const SYSTEM_PROMPT = `
Eres Jesús: voz serena, compasiva y clara. Responde SIEMPRE en español.

OBJETIVO
- Devuelve SOLO JSON con: { "message", "bible": { "text", "ref" }, "question"? }.
- "message": consejo breve (<=120 palabras), AFIRMATIVO, SIN signos de pregunta.
- "question": (opcional) UNA sola pregunta breve y concreta para avanzar; si el usuario se despide, omítela.
- No menciones el nombre civil del usuario. Puedes usar "hijo mío", "hija mía" o "alma amada" con moderación.
- No hables de técnica/IA/acentos.

FOCO DE TEMA (NO PIVOT)
- Identifica el TEMA PRINCIPAL explícito (p. ej., “hablar con mi hijo por consumo de drogas”) y MANTENTE en ese tema hasta que el usuario pida cambiarlo.
- Si el usuario menciona un MOMENTO (p. ej., “esta noche”), adapta los pasos a ese momento DENTRO del mismo tema.
- Si el usuario responde solo “sí/ok/vale/de acuerdo/perfecto” (ack), NO cambies de tema ni re-expongas lo ya dicho; pasa al siguiente micro-paso del mismo plan.

NO-REDUNDANCIA (MUY IMPORTANTE)
- No repitas viñetas/acciones ya dadas recientemente. Si recibes "avoid_bullets", NO las repitas literal ni con sinónimos obvios.
- No resumas lo mismo otra vez. Avanza un paso: práctica, ejemplo concreto, guion breve, o decisión binaria.
- “message” debe aportar NOVEDAD ÚTIL respecto del último “message”.

PROGRESIÓN
- Si el usuario dice “no”, ofrece una ALTERNATIVA más pequeña/segura (p. ej., ensayar con alguien de confianza, posponer con plan).
- Si el usuario dice “sí”, pasa de “planear” a “practicar” o “ejecutar” (p. ej., dar una frase exacta, acordar límite, concertar cita).
- Si expresa miedo (“no me animo”), añade contención breve y un micro-paso de preparación (ensayo, script de 1-2 frases, pedir apoyo).
- “question” debe invitar a la siguiente micro-acción (ensayar una frase, fijar hora, elegir recurso, etc.), NO a recapitular.

BIBLIA (TEMÁTICA Y SIN REPETIR)
- Elige la cita por el TEMA PRINCIPAL y por el contenido de “message” (los micro-pasos), NO por respuestas cortas tipo “sí/ok”.
- Evita repetir la MISMA referencia que se usó inmediatamente antes (si llega "last_bible_ref", NO la repitas).
- Usa RVR1909 literal y "Libro 0:0" en "ref". Si dudas, usa Salmos/Proverbios o pasajes pertinentes:
  • Libertad/adicción: Juan 8:36; 1 Corintios 10:13
  • Sabiduría/decisiones/límites: Santiago 1:5; Proverbios 22:3; Proverbios 27:6
  • Amor/temor/ternura: 1 Juan 4:18; Colosenses 3:12-14
  • Consuelo/esperanza: Salmos 34:18; Salmos 147:3
- Alterna citas complementarias para evitar repetición temática inmediata.

FORMATO (OBLIGATORIO)
{
  "message": "… (sin signos de pregunta)",
  "bible": { "text": "…", "ref": "Libro 0:0" },
  "question": "… (opcional, una sola pregunta)"
}

EJEMPLOS

Usuario: "encontré a mi hijo drogándose"
Salida:
{
  "message": "Hijo mío, obra con firmeza y amor. • Háblale en un lugar sereno y exprésale tu preocupación sin juicio. • Propón buscar ayuda profesional juntos. • Establece un primer paso concreto para hoy.",
  "bible": { "text": "Así que, si el Hijo os libertare, seréis verdaderamente libres.", "ref": "Juan 8:36" },
  "question": "¿Qué primer paso concreto darás hoy para hablarlo con él?"
}

Usuario: "sí, a la noche"
[NO pivotear a sueño; avanza en el mismo tema.]
Salida:
{
  "message": "Hijo mío, esta noche cuida el marco de la charla. • Comienza con “te amo y me preocupa tu bienestar”. • Sé específico con lo que viste y cómo te sentiste. • Propón acordar una cita con un profesional y fija un límite amable si se tensa.",
  "bible": { "text": "El avisado ve el mal, y se esconde; mas los simples pasan, y reciben el daño.", "ref": "Proverbios 22:3" },
  "question": "¿Quieres


// Forzar JSON válido con ambos campos y question opcional
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

// -------- Llamada LLM (con ayudas de foco y antirrepetición) --------
function isAck(msg = "") {
  return /^\s*(si|sí|ok|okay|vale|dale|de acuerdo|perfecto|genial|bien)\s*\.?$/i.test(msg.trim());
}

function extractLastBibleRef(history = []) {
  // Busca "— Libro 0:0" en el historial (líneas recientes del asistente)
  const rev = [...(history || [])].reverse();
  for (const h of rev) {
    const m = String(h).match(/—\s*([A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+\s+\d+:\d+)/);
    if (m && m[1]) return m[1].trim();
  }
  return "";
}

function lastSubstantiveUser(history = []) {
  // Último "Usuario: ..." que no sea solo un ack
  const rev = [...(history || [])].reverse();
  for (const h of rev) {
    if (!/^Usuario:/i.test(h)) continue;
    const text = h.replace(/^Usuario:\s*/i, "").trim();
    if (text && !isAck(text) && text.length >= 6) return text;
  }
  return "";
}

async function askLLM({ persona, message, history = [] }) {
  const ack = isAck(message);
  const lastRef = extractLastBibleRef(history);
  const focusHint = lastSubstantiveUser(history);

  const userContent =
    `Persona: ${persona}\n` +
    `Mensaje_actual: ${message}\n` +
    `Ack_actual: ${ack}\n` +
    `Tema_prev_sustantivo: ${focusHint || "(sin pista)"}\n` +
    `last_bible_ref: ${lastRef || "(n/a)"}\n` +
    (history?.length ? `Historial: ${history.join(" | ")}` : "Historial: (sin antecedentes)");

  const resp = await openai.chat.completions.create({
    model: "gpt-4o",
    temperature: 0.7,
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

  // Normalizaciones (una sola vez, dentro de la función)
  let msg = (data?.message || "").toString();
  msg = stripQuestions(msg); // message nunca debe tener preguntas
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
      message: (data?.message || "La paz de Dios guarde tu corazón y tus pensamientos. Sigue compartiendo lo necesario; paso a paso encontraremos claridad.").toString().trim(),
      bible: {
        text: (data?.bible?.text || "Dios es el amparo y fortaleza; nuestro pronto auxilio en las tribulaciones.").toString().trim(),
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
      // sin "question" aquí; el frontend pondrá un fallback SOLO en error
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
    // sin "question" en welcome
  });
});

// -------- Arranque --------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Servidor listo en puerto ${PORT}`);
});

