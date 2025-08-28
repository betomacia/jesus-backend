// server.js
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const OpenAI = require("openai"); // SDK oficial
require("dotenv").config();

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ---- OpenAI client ----
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---- Citas de fallback (RVR1909 - dominio público) ----
const FALLBACKS = {
  ansiedad: {
    ref: "Filipenses 4:6-7 (RVR1909)",
    text:
      "Por nada estéis afanosos, sino sean notorias vuestras peticiones delante de Dios en toda oración y ruego, con hacimiento de gracias. Y la paz de Dios, que sobrepuja todo entendimiento, guardará vuestros corazones y vuestros pensamientos en Cristo Jesús."
  },
  consuelo: {
    ref: "Salmos 34:18 (RVR1909)",
    text:
      "Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu."
  },
  esperanza: {
    ref: "Jeremías 29:11 (RVR1909)",
    text:
      "Porque yo sé los pensamientos que pienso acerca de vosotros, dice Jehová, pensamientos de paz, y no de mal, para daros el fin que esperáis."
  }
};

// ---- Helpers ----
function guessTopic(msg = "") {
  const m = (msg || "").toLowerCase();
  if (m.includes("ansiedad") || m.includes("ansioso") || m.includes("preocup")) return "ansiedad";
  if (m.includes("triste") || m.includes("dolor") || m.includes("duelo") || m.includes("depres")) return "consuelo";
  return "esperanza";
}

function ensureBible(data, userMsg) {
  if (data && data.bible && data.bible.text && data.bible.ref) return data;
  const pick = FALLBACKS[guessTopic(userMsg)] || FALLBACKS.esperanza; // ✅ FIX aplicado
  return {
    ...(data || {}),
    bible: { text: pick.text, ref: pick.ref }
  };
}

// ---- Prompt base ----
const SYSTEM_PROMPT = `
Eres Jesús: voz serena, compasiva y clara. Responde SIEMPRE en español.
Devuelve JSON con esta forma:
{
  "message": "consejo breve y empático (máx. 120 palabras)",
  "bible": { "text": "cita literal", "ref": "Libro cap:verso (versión)" }
}
No inventes referencias; si dudas, elige otra que conozcas con certeza.
Evita lenguaje médico o legal; céntrate en consuelo, esperanza y dirección espiritual.
`;

// ---- Llamada al modelo ----
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
      "{}";

    let data = {};
    try { data = JSON.parse(content); } catch { data = { message: content }; }
    return data;
  } catch (err) {
    console.error("OpenAI ERROR:", err);
    return { message: "Estoy aquí contigo." };
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

    // 1) Pregunta al LLM
    let data = await askLLM({ persona, message, history });

    // 2) Garantiza que haya cita
    data = ensureBible(data, message);

    // 3) Normaliza salida
    const out = {
      message: (data?.message || "Estoy aquí contigo. ¿Qué te inquieta?").toString().trim(),
      bible: {
        text: (data?.bible?.text || "Venid a mí todos los que estáis trabajados y cargados, y yo os haré descansar.").toString().trim(),
        ref:  (data?.bible?.ref  || "Mateo 11:28 (RVR1909)").toString().trim()
      }
    };

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(200).json(out);
  } catch (err) {
    console.error("ASK ERROR:", err);
    res.status(200).json({
      message: "Estoy aquí. ¿Quieres contarme un poco más?",
      bible: {
        text: "Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu.",
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
