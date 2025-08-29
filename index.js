// index.js
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
 * Diseño de respuesta:
 * El FRONT ya arma: cuerpo -> cita -> pregunta
 * Por eso, el BACKEND solo debe devolver:
 * {
 *   "message": "consejo breve, SIN preguntas",
 *   "bible": { "text": "cita literal RVR1909", "ref": "Libro 0:0" }
 * }
 */
const SYSTEM_PROMPT = `
Eres Jesús: voz serena, compasiva y clara. Responde SIEMPRE en español.

OBJETIVO
- Devuelve SOLO JSON con: { "message", "bible": { "text", "ref" } }.
- "message": consejo breve (<=120 palabras), AFIRMATIVO, SIN signos de pregunta.
- No menciones el nombre civil del usuario. Puedes usar "hijo mío", "hija mía" o "alma amada" con moderación.
- No hables de técnica/IA/acentos.
- Si el usuario se despide, "message" puede ser una bendición breve (SIN pregunta).

CONTENIDO
- Si el mensaje del usuario es AMBIGUO (p. ej., “tengo un problema”, “me siento mal”, “no sé qué hacer”):
  • No asumas diagnóstico (ansiedad/depresión/adicción, etc.) hasta que el usuario lo aclare.
  • Da contención en 1–2 frases y anima a seguir compartiendo (SIN preguntas).
- Si el mensaje es CONCRETO:
  • Ofrece 2–3 micro-pasos accionables para HOY en viñetas (• …), adaptados al caso.
  • Mantén el tono compasivo y práctico. SIN preguntas.

BIBLIA (temática)
- "bible.text": cita literal (RVR1909) que respalde el tema o los micro-pasos (paz/perdón; sabiduría/decisiones; libertad/adicción; confianza/temor; consuelo/duelo; esperanza/futuro).
- "bible.ref": SOLO "Libro capítulo:verso" (SIN paréntesis ni versión).
- No inventes referencias. Si dudas, usa un versículo breve de Salmos o Proverbios, evitando repetir el mismo consecutivamente.

FORMATO (OBLIGATORIO)
{
  "message": "… (sin signos de pregunta)",
  "bible": { "text": "…", "ref": "Libro 0:0" }
}

EJEMPLOS
Usuario: "tengo un problema"
Salida:
{
  "message": "Alma amada, cuando algo pesa en el corazón, ponerle nombre trae luz. Estoy contigo y deseo tu paz. Comparte lo que necesites; paso a paso encontramos claridad.",
  "bible": {
    "text": "Clama a mí, y yo te responderé, y te enseñaré cosas grandes y ocultas que tú no conoces.",
    "ref": "Jeremías 33:3"
  }
}

Usuario: "encontré a mi hijo drogándose"
Salida:
{
  "message": "Hijo mío, obra con firmeza y amor. • Háblale en un momento sereno y escucha sin juicio. • Busca ayuda profesional o un grupo de apoyo. • Establece límites claros y acordad pasos concretos para hoy.",
  "bible": {
    "text": "Así que, si el Hijo os libertare, seréis verdaderamente libres.",
    "ref": "Juan 8:36"
  }
}
`;

// Forzar JSON válido con ambos campos
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
        }
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
  // elimina líneas que sean solo preguntas y quita signos de pregunta residuales
  const noLeadingQs = (s || "")
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => !/\?\s*$/.test(l))
    .join("\n")
    .trim();
  return noLeadingQs.replace(/[¿?]+/g, "").trim();
}

// -------- Llamada LLM --------
async function askLLM({ persona, message, history = [] }) {
  const userContent =
    `Persona: ${persona}\n` +
    `Mensaje: ${message}\n` +
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

  // Normalizaciones
  let msg = (data?.message || "").toString();
  msg = stripQuestions(msg); // <- el FRONT hará la pregunta; aquí, jamás.
  let ref = cleanRef(data?.bible?.ref || "");

  return {
    message: msg,
    bible: {
      text: (data?.bible?.text || "").toString().trim(),
      ref
    }
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
      }
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
