// server.js
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const OpenAI = require("openai");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ---- Cliente OpenAI ----
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---- Prompt base ----
const SYSTEM_PROMPT = `
Eres Jesús: voz serena, compasiva y clara.
Responde SIEMPRE en español.
Devuelve un JSON con:
{
  "message": "Consejo breve y empático (máx. 120 palabras)",
  "bible": {
    "text": "Cita bíblica literal (dominio público o paráfrasis breve)",
    "ref": "Libro capítulo:verso (RVR1909)"
  }
}
No inventes referencias; si dudas, elige otra que conozcas bien.
No añadas nada fuera del JSON.
`;

// ---- Schema para obligar a incluir la cita ----
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

// ---- Función principal ----
async function askLLM({ persona, message, history = [] }) {
  const userContent = `Persona: ${persona}\nMensaje: ${message}\nHistorial: ${history.join(" | ")}`;

  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o", // ⚠️ mejor que mini para respetar schema
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
    return {
      message: "Estoy aquí contigo. Respira hondo, comparte lo que sientes.",
      bible: {
        text:
          "Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu.",
        ref: "Salmos 34:18 (RVR1909)"
      }
    };
  }
}

// ---- Rutas ----
app.get("/api/welcome", (_req, res) => {
  res.json({
    message: "La paz esté contigo. ¿Qué te gustaría compartir hoy?",
    bible: {
      text:
        "Venid a mí todos los que estáis trabajados y cargados, y yo os haré descansar.",
      ref: "Mateo 11:28 (RVR1909)"
    }
  });
});

app.post("/api/ask", async (req, res) => {
  try {
    const { persona = "jesus", message = "", history = [] } = req.body || {};
    let data = await askLLM({ persona, message, history });

    // Normaliza salida y asegura que siempre haya message + bible
    const out = {
      message:
        (data?.message || "Estoy aquí contigo. ¿Qué te inquieta?").toString().trim(),
      bible: {
        text:
          (data?.bible?.text ||
            "Venid a mí todos los que estáis trabajados y cargados, y yo os haré descansar.").toString().trim(),
        ref:
          (data?.bible?.ref || "Mateo 11:28 (RVR1909)").toString().trim()
      }
    };

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(200).json(out);
  } catch (err) {
    console.error("ASK ERROR:", err);
    res.status(200).json({
      message: "Estoy aquí. ¿Quieres contarme un poco más?",
      bible: {
        text:
          "Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu.",
        ref: "Salmos 34:18 (RVR1909)"
      }
    });
  }
});

// ---- Arranque ----
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Servidor listo en puerto ${PORT}`);
});
