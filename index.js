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

// ---- Citas locales (RVR1909 - dominio público) ----
const FALLBACKS = {
  ansiedad: {
    ref: "Filipenses 4:6-7 (RVR1909)",
    text: "Por nada estéis afanosos, sino sean notorias vuestras peticiones delante de Dios en toda oración y ruego, con hacimiento de gracias. Y la paz de Dios, que sobrepuja todo entendimiento, guardará vuestros corazones y vuestros pensamientos en Cristo Jesús."
  },
  consuelo: {
    ref: "Salmos 34:18 (RVR1909)",
    text: "Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu."
  },
  esperanza: {
    ref: "Jeremías 29:11 (RVR1909)",
    text: "Porque yo sé los pensamientos que pienso acerca de vosotros, dice Jehová, pensamientos de paz, y no de mal, para daros el fin que esperáis."
  }
};

function guessTopic(msg = "") {
  const m = (msg || "").toLowerCase();
  if (m.includes("ansiedad") || m.includes("ansioso") || m.includes("preocup")) return "ansiedad";
  if (m.includes("triste") || m.includes("dolor") || m.includes("duelo")) return "consuelo";
  return "esperanza";
}

// ---- Prompt base ----
const SYSTEM_PROMPT = `
Eres Jesús: voz serena, compasiva y clara.
Responde SIEMPRE en español con un consejo breve (máx. 120 palabras).
No incluyas la cita bíblica, solo el mensaje.
`;

// ---- Llamada a OpenAI ----
async function askLLM({ persona, message, history = [] }) {
  const userContent = `Persona: ${persona}\nMensaje: ${message}\nHistorial: ${history.join(" | ")}`;

  try {
    const chat = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.7,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent }
      ]
    });

    const content =
      chat.choices?.[0]?.message?.content?.trim?.() ||
      chat.choices?.[0]?.message?.content ||
      "";

    return { message: content };
  } catch (err) {
    console.error("OpenAI ERROR:", err);
    return { message: "Estoy aquí contigo. Comparte lo que sientes." };
  }
}

// ---- Rutas ----
app.get("/api/welcome", (_req, res) => {
  res.json({
    message: "La paz esté contigo. ¿Qué te gustaría compartir hoy?",
    bible: {
      text: "Venid a mí todos los que estáis trabajados y cargados, y yo os haré descansar.",
      ref: "Mateo 11:28 (RVR1909)"
    }
  });
});

app.post("/api/ask", async (req, res) => {
  try {
    const { persona = "jesus", message = "", history = [] } = req.body || {};
    const data = await askLLM({ persona, message, history });

    // Siempre añadimos una cita local basada en el tema
    const topic = guessTopic(message);
    const verse = FALLBACKS[topic] || FALLBACKS.esperanza;

    const out = {
      message: (data?.message || "Estoy aquí contigo. ¿Qué te inquieta?").trim(),
      bible: verse
    };

    res.status(200).json(out);
  } catch (err) {
    console.error("ASK ERROR:", err);
    res.status(200).json({
      message: "Estoy aquí. ¿Quieres contarme un poco más?",
      bible: FALLBACKS.consuelo
    });
  }
});

// ---- Arranque ----
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Servidor listo en puerto ${PORT}`);
});
