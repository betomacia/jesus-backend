// index.js
const express = require("express");
const bodyParser = require("body-parser");
const OpenAI = require("openai");
require("dotenv").config();

const app = express();
app.use(bodyParser.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT = `
Eres Jesús: voz serena, compasiva y clara.
Responde SIEMPRE en español.
Devuelve JSON con exactamente dos campos:
{
  "message": "Consejo breve y empático (máx. 120 palabras)",
  "bible": {
    "text": "Cita bíblica literal en español (RVR1909, dominio público)",
    "ref": "Libro capítulo:verso (RVR1909)"
  }
}
No inventes referencias. No devuelvas nada fuera del JSON.
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

app.post("/api/ask", async (req, res) => {
  const { persona = "jesus", message = "", history = [] } = req.body || {};
  const userContent = `Persona: ${persona}\nMensaje: ${message}\nHistorial: ${history.join(" | ")}`;

  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o",   // ⚠️ importante: no "mini"
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

    res.json(data);
  } catch (err) {
    console.error("ERROR:", err);
    res.json({
      message: "Estoy aquí contigo. Comparte lo que sientes.",
      bible: {
        text: "Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu.",
        ref: "Salmos 34:18 (RVR1909)"
      }
    });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Servidor prueba en puerto ${PORT}`));
