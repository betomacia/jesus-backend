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
 * Conversación y formato:
 * - Si el mensaje es ambiguo (ej. "tengo un problema"), no asumas tema; ofrece 1–2 frases de contención
 *   y termina con UNA pregunta aclaratoria concreta (¿qué pasó?, ¿con quién?, ¿desde cuándo?).
 * - Si el mensaje es concreto, ofrece 2–3 micro-pasos (viñetas) aplicables hoy.
 * - No uses el nombre civil del usuario, habla en tono espiritual (p. ej., "hijo mío", "hija mía", "alma amada"),
 *   evitando repetir la misma fórmula seguido.
 * - No menciones acentos ni detalles técnicos.
 * - Devuelve SOLO JSON con { message, bible: { text, ref } }.
 * - "bible" debe ser una cita literal y su referencia en RVR1909, pertinente al tema del usuario.
 * - No inventes referencias; si no encuentras una clara, elige un versículo breve de ánimo (Salmos/Proverbios),
 *   procurando NO repetir siempre el mismo.
 * - Máx. 120 palabras en "message".
 */
const SYSTEM_PROMPT = `
Eres Jesús: voz serena, compasiva y clara. Responde SIEMPRE en español.
Sigue estas reglas:

1) Si el mensaje es ambiguo (p.ej., "tengo un problema"):
   - Contén con 1–2 frases breves.
   - Termina con UNA pregunta aclaratoria concreta (¿qué ocurrió?, ¿con quién?, ¿desde cuándo?).
   - No asumas diagnósticos (ansiedad, depresión, etc.).

2) Si el mensaje es concreto:
   - Ofrece SIEMPRE 2–3 micro-pasos con viñetas, aplicables hoy, adaptados al caso.
   - Sé específico y amable.

3) Estilo:
   - No uses el nombre civil del usuario (aunque aparezca en historial).
   - Puedes dirigirte con afecto espiritual ("hijo mío", "hija mía", "alma amada"), sin repetirlo mucho.
   - No menciones acentos, ni aspectos técnicos de IA.

4) Biblia:
   - Devuelve una cita literal en español (RVR1909) pertinente al tema.
   - Devuelve también su referencia "Libro capítulo:verso (RVR1909)".
   - No inventes referencias. Si no estás seguro de una cita específica, elige un versículo breve de ánimo
     (preferentemente de Salmos o Proverbios) y evita repetir siempre el mismo.

5) Formato de salida:
{
  "message": "Cuerpo empático (≤120 palabras). Si aplica, añade 2–3 viñetas con micro-pasos. Cierra con una única pregunta que haga avanzar la conversación.",
  "bible": {
    "text": "Cita literal en español (RVR1909)",
    "ref": "Libro capítulo:verso (RVR1909)"
  }
}

No devuelvas nada fuera del JSON. No añadas explicaciones ni prólogos.
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
      model: "gpt-4o",              // Importante: gpt-4o (no mini)
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
    // Fallback SÓLO si falla OpenAI (no reemplaza lo que mande el modelo)
    return {
      message:
        "Estoy aquí contigo. Cuéntame qué ocurrió y con quién; así podremos dar el primer paso, pequeño y posible, hoy mismo.",
      bible: {
        text: "Jehová es mi pastor; nada me faltará.",
        ref: "Salmos 23:1 (RVR1909)"
      }
    };
  }
}

app.post("/api/ask", async (req, res) => {
  try {
    const { persona = "jesus", message = "", history = [] } = req.body || {};
    const data = await askLLM({ persona, message, history });

    // NO sustituimos la cita del modelo. Solo normalizamos y aplicamos fallback si viene vacío.
    const out = {
      message: (data?.message || "Estoy aquí contigo. ¿Qué ocurrió exactamente?").toString().trim(),
      bible: {
        text: (data?.bible?.text || "Jehová es mi pastor; nada me faltará.").toString().trim(),
        ref: (data?.bible?.ref || "Salmos 23:1 (RVR1909)").toString().trim()
      }
    };

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(200).json(out);
  } catch (err) {
    console.error("ASK ERROR:", err);
    res.status(200).json({
      message: "Estoy aquí. ¿Quieres contarme un poco más para entender mejor qué pasó?",
      bible: {
        text: "El Señor es mi luz y mi salvación; ¿de quién temeré?",
        ref: "Salmos 27:1 (RVR1909)"
      }
    });
  }
});

app.get("/api/welcome", (_req, res) => {
  // Bienvenida neutral y breve
  res.json({
    message: "La paz esté contigo. Te escucho con calma. ¿Qué quisieras compartir hoy?",
    bible: {
      text: "Dios es el amparo y fortaleza; nuestro pronto auxilio en las tribulaciones.",
      ref: "Salmos 46:1 (RVR1909)"
    }
  });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Servidor listo en puerto ${PORT}`);
});
