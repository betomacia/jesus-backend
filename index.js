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

const SYSTEM_PROMPT = `
Eres Jesús: voz serena, compasiva y clara. Responde SIEMPRE en español.

Instrucciones clave:
- No asumas diagnósticos ni temas (ansiedad, depresión, trauma, etc.) si el usuario NO los menciona explícitamente.
- Si el mensaje es ambiguo (ej. "tengo un problema"), mantén neutralidad, ofrece contención breve y formula 1 pregunta aclaratoria simple y concreta.
- Devuelve SIEMPRE un JSON con exactamente dos campos:
{
  "message": "Consejo breve y empático (máx. 120 palabras). Si el tema no está claro, sé neutral y formula 1 pregunta aclaratoria al final.",
  "bible": {
    "text": "Cita bíblica literal en español (RVR1909, dominio público). Si el tema es ambiguo, elige una cita neutral de consuelo/guía (p. ej., Mateo 11:28 o Salmo 121:1-2).",
    "ref": "Libro capítulo:verso (RVR1909)"
  }
}
- No inventes referencias. Si dudas, usa una que conozcas bien (p. ej., Mateo 11:28; Salmo 121:1-2).
- No devuelvas nada fuera del JSON.
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
  const userContent = `Persona: ${persona}\nMensaje: ${message}\nHistorial: ${history.join(" | ")}`;

  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o",   // NO usar mini
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
    return data;
  } catch (err) {
    console.error("OpenAI ERROR:", err?.message || err);
    // Fallback seguro y neutral
    return {
      message: "Estoy aquí contigo. Si quieres, cuéntame un poco más para entender mejor qué pasó. ¿Qué te preocupa exactamente?",
      bible: {
        text: "Venid a mí todos los que estáis trabajados y cargados, y yo os haré descansar.",
        ref: "Mateo 11:28 (RVR1909)"
      }
    };
  }
}

app.get("/api/welcome", (_req, res) => {
  res.json({
    message: "La paz esté contigo. ¿Qué te gustaría compartir hoy?",
    bible: {
      text: "Alzaré mis ojos a los montes, ¿de dónde vendrá mi socorro? Mi socorro viene de Jehová, que hizo los cielos y la tierra.",
      ref: "Salmos 121:1-2 (RVR1909)"
    }
  });
});

app.post("/api/ask", async (req, res) => {
  try {
    const { persona = "jesus", message = "", history = [] } = req.body || {};
    let data = await askLLM({ persona, message, history });

    const out = {
      message: (data?.message || "Estoy aquí contigo. ¿Qué te inquieta?").toString().trim(),
      bible: {
        text:
          (data?.bible?.text ||
            "Alzaré mis ojos a los montes, ¿de dónde vendrá mi socorro? Mi socorro viene de Jehová, que hizo los cielos y la tierra.").toString().trim(),
        ref: (data?.bible?.ref || "Salmos 121:1-2 (RVR1909)").toString().trim()
      }
    };

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(200).json(out);
  } catch (err) {
    console.error("ASK ERROR:", err);
    res.status(200).json({
      message: "Estoy aquí. ¿Quieres contarme un poco más para entender mejor?",
      bible: {
        text: "Venid a mí todos los que estáis trabajados y cargados, y yo os haré descansar.",
        ref: "Mateo 11:28 (RVR1909)"
      }
    });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Servidor listo en puerto ${PORT}`);
});
