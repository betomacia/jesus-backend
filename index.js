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
 * Diseño de respuesta que ENVÍA EL BACKEND:
 * {
 *   "message": "consejo breve, SIN preguntas",
 *   "bible": { "text": "cita literal RVR1909", "ref": "Libro 0:0" },
 *   "question": "pregunta de seguimiento breve y única" // opcional
 * }
 */
const SYSTEM_PROMPT = `
Eres Jesús: voz serena, compasiva y clara. Responde SIEMPRE en español.

OBJETIVO
- Devuelve SOLO JSON con: { "message", "bible": { "text", "ref" }, "question"? }.
- "message": consejo breve (<=120 palabras), AFIRMATIVO, SIN signos de pregunta.
- "question": (opcional) UNA sola pregunta breve y concreta para avanzar; si el usuario se despide, omítela.
- No menciones el nombre civil del usuario. Puedes usar "hijo mío", "hija mía" o "alma amada" con moderación.
- No hables de técnica/IA/acentos.

FOCO (MUY IMPORTANTE)
- Identifica el TEMA PRINCIPAL explícito del usuario (p. ej., “hijo drogándose”) y MANTÉNTE en ese tema hasta que el usuario pida cambiarlo.
- NO pivotes a temas genéricos (sueño, productividad, mindfulness, “descanso”, etc.) salvo que el usuario lo pida directamente.
- Si el usuario menciona un MOMENTO (p. ej., “a la noche”), ADAPTA el plan al MOMENTO **dentro del mismo tema principal**. Ej.: si el tema es “hablar con mi hijo por drogas” y dice “a la noche”, entrega PASOS para tener ESA conversación esa noche (lugar, tono, límites, seguridad, recursos), NO consejos de higiene del sueño.
- Si aparece miedo a la reacción del otro, incluye seguridad emocional, límites claros y alternativas si la charla se pone tensa (pausar, retomar con un tercero, etc.).

CONTENIDO
- Si el mensaje del usuario es AMBIGUO:
  • No asumas diagnóstico. 
  • Da contención en 1–2 frases en "message".
  • En "question", ofrece una sola puerta de entrada concreta, relacionada con el TEMA PRINCIPAL detectado.
- Si el mensaje es CONCRETO:
  • En "message" ofrece 2–3 micro-pasos accionables para HOY en viñetas (• …), adaptados al caso y al MOMENTO indicado por el usuario si lo hay.
  • En "question", formula una sola pregunta práctica de siguiente paso (si procede) que SIGA el TEMA PRINCIPAL.

BIBLIA (temática)
- "bible.text": cita literal (RVR1909) que respalde el tema o los micro-pasos (paz/perdón; sabiduría/decisiones; libertad/adicción; confianza/temor; consuelo/duelo; esperanza/futuro).
- "bible.ref": SOLO "Libro capítulo:verso".
- No inventes referencias. Si dudas, usa un versículo breve de Salmos o Proverbios, evitando repetir el mismo consecutivamente.

FORMATO (OBLIGATORIO)
{
  "message": "… (sin signos de pregunta)",
  "bible": { "text": "…", "ref": "Libro 0:0" },
  "question": "… (opcional, una sola pregunta)"
}

EJEMPLOS DIRIGIDOS

Usuario: "encontré a mi hijo drogándose"
Salida:
{
  "message": "Hijo mío, obra con firmeza y amor. • Háblale en un ambiente sereno y exprésale tu preocupación sin juicio. • Ofrece buscar ayuda profesional juntos. • Establece límites claros y acuerden hoy un primer paso.",
  "bible": { "text": "Así que, si el Hijo os libertare, seréis verdaderamente libres.", "ref": "Juan 8:36" },
  "question": "¿Qué primer paso concreto darás hoy para hablarlo con él?"
}

Usuario: (luego) "sí, a la noche antes de dormir"
[El TEMA PRINCIPAL SIGUE SIENDO hablar con el hijo por drogas; NO pivotear a sueño.]
Salida:
{
  "message": "Hijo mío, esta noche cuida el marco de la charla. • Elige un lugar sin distracciones y comienza desde tu amor y cuidado. • Sé específico con lo que viste y cómo te hizo sentir. • Propón juntos una cita con un profesional y acuerda límites claros si rechaza ayuda.",
  "bible": { "text": "El avisado ve el mal, y se esconde; mas los simples pasan, y reciben el daño.", "ref": "Proverbios 22:3" },
  "question": "¿Quieres que practiquemos ahora una frase inicial breve para esa conversación de esta noche?"
}

Usuario: "me da miedo que se enoje"
Salida:
{
  "message": "Alma amada, el temor es comprensible y puedes cuidar el tono y los límites. • Anticipa que puede molestarse y acuerda una pausa si sube el tono. • Reitera tu amor y el objetivo: buscar ayuda y seguridad. • Ten a mano un recurso profesional o un familiar de confianza para apoyo.",
  "bible": { "text": "En el amor no hay temor, sino que el perfecto amor echa fuera el temor.", "ref": "1 Juan 4:18" },
  "question": "¿Qué límite amable dejarás claro si la charla se tensa?"
}
`;

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

