// index.js
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const OpenAI = require("openai");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(bodyParser.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Objetivo conversacional:
 * - Si el usuario es ambiguo ("tengo un problema"), pide una aclaración concreta.
 * - Si el usuario da detalles, ofrece 2–3 alternativas accionables (micro-pasos) PERSONALIZADAS.
 * - Siempre devuelve cita bíblica PERTINENTE AL TEMA que se desprende del mensaje (no asumir temas que no hayan sido mencionados).
 * - Tono: Jesús, sereno y compasivo, español, ≤120 palabras en el cuerpo.
 * - Formato: JSON con { message, bible: { text, ref } } ÚNICAMENTE.
 */
const SYSTEM_PROMPT = `
Eres Jesús: voz serena, compasiva y clara. Responde SIEMPRE en español.

REGLAS:
1) Si el mensaje del usuario es ambiguo (p. ej. "tengo un problema", "me va mal"), NO asumas temas como ansiedad, depresión, etc. En esos casos:
   - Sé contenedor (1–2 frases empáticas).
   - Formula 1 pregunta aclaratoria *específica* (¿Qué sucedió?, ¿con quién?, ¿desde cuándo?).
2) Si el usuario presenta un tema concreto, ofrece SIEMPRE 2–3 alternativas/acciones concretas (micro-pasos) adaptadas a lo que dijo.
   - Usa viñetas o guiones breves, orientados a lo que la persona *sí* puede hacer hoy.
3) Selecciona una cita bíblica literal (RVR1909) *pertinente al tema mencionado*. NO inventes referencias. Si dudas:
   - Usa Mateo 11:28 (consuelo general) o Salmos 121:1-2 (confianza/guía).
4) Longitud del campo "message": máx. 120 palabras.
5) Devuelve SOLO este JSON, sin texto adicional:
{
  "message": "Cuerpo empático + (si aplica) 2–3 bullets con alternativas, y, si el caso fue ambiguo, incluye al final 1 pregunta aclaratoria breve",
  "bible": {
    "text": "Cita literal (RVR1909)",
    "ref": "Libro capítulo:verso (RVR1909)"
  }
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

async function askLLM({ persona, message, history = [] }) {
  const userContent =
    `Persona: ${persona}\n` +
    `Mensaje: ${message}\n` +
    (history?.length ? `Historial: ${history.join(" | ")}` : "Historial: (sin antecedentes)");

  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o",           // Importante: usar gpt-4o (no mini)
      temperature: 0.7,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent }
      ],
      response_format: responseFormat
    });

    const content = resp.choices?.[0]?.message?.content || "{}";
    let data = {};
    try { data = JSON.parse(content); } catch { data = { message: content }; }
    return data;
  } catch (err) {
    console.error("OpenAI ERROR:", err?.message || err);
    // Fallback neutral y útil
    return {
      message:
        "Estoy aquí contigo. Quiero entenderte mejor. ¿Qué ocurrió exactamente y con quién? Si te ayuda, pensemos un primer paso pequeño que puedas dar hoy.",
      bible: {
        text: "Alzaré mis ojos a los montes, ¿de dónde vendrá mi socorro? Mi socorro viene de Jehová, que hizo los cielos y la tierra.",
        ref: "Salmos 121:1-2 (RVR1909)"
      }
    };
  }
}

app.post("/api/ask", async (req, res) => {
  try {
    const { persona = "jesus", message = "", history = [] } = req.body || {};
    let data = await askLLM({ persona, message, history });

    const out = {
      message: (data?.message || "Estoy aquí contigo. ¿Qué te inquieta?").toString().trim(),
      bible: {
        text:
          (data?.bible?.text ||
            "Venid a mí todos los que estáis trabajados y cargados, y yo os haré descansar.").toString().trim(),
        ref: (data?.bible?.ref || "Mateo 11:28 (RVR1909)").toString().trim()
      }
    };

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(200).json(out);
  } catch (err) {
    console.error("ASK ERROR:", err);
    res.status(200).json({
      message: "Estoy aquí. ¿Quieres contarme un poco más para entender mejor qué pasó?",
      bible: {
        text: "Venid a mí todos los que estáis trabajados y cargados, y yo os haré descansar.",
        ref: "Mateo 11:28 (RVR1909)"
      }
    });
  }
});

app.get("/api/welcome", (_req, res) => {
  res.json({
    message: "La paz esté contigo. ¿Qué te gustaría compartir hoy?",
    bible: {
      text: "Alzaré mis ojos a los montes, ¿de dónde vendrá mi socorro? Mi socorro viene de Jehová, que hizo los cielos y la tierra.",
      ref: "Salmos 121:1-2 (RVR1909)"
    }
  });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Servidor listo en puerto ${PORT}`);
});
