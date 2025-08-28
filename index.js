// server.js
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const OpenAI = require("openai");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ---------- OpenAI (opcional; si falla, igual devolvemos todo) ----------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------- Versos de dominio público (RVR1909) ----------
const VERSES = {
  ansiedad: [
    {
      ref: "Filipenses 4:6-7 (RVR1909)",
      text:
        "Por nada estéis afanosos, sino sean notorias vuestras peticiones delante de Dios en toda oración y ruego, con hacimiento de gracias. Y la paz de Dios, que sobrepuja todo entendimiento, guardará vuestros corazones y vuestros pensamientos en Cristo Jesús."
    },
    {
      ref: "1 Pedro 5:7 (RVR1909)",
      text: "Echando toda vuestra ansiedad sobre él, porque él tiene cuidado de vosotros."
    }
  ],
  consuelo: [
    {
      ref: "Salmos 34:18 (RVR1909)",
      text:
        "Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu."
    },
    {
      ref: "Mateo 5:4 (RVR1909)",
      text: "Bienaventurados los que lloran: porque ellos recibirán consolación."
    }
  ],
  esperanza: [
    {
      ref: "Jeremías 29:11 (RVR1909)",
      text:
        "Porque yo sé los pensamientos que pienso acerca de vosotros, dice Jehová, pensamientos de paz, y no de mal, para daros el fin que esperáis."
    },
    {
      ref: "Romanos 15:13 (RVR1909)",
      text:
        "Y el Dios de esperanza os llene de todo gozo y paz en el creer, para que abundéis en esperanza por la virtud del Espíritu Santo."
    }
  ],
  confianza: [
    {
      ref: "Proverbios 3:5-6 (RVR1909)",
      text:
        "Fíate de Jehová de todo tu corazón, y no estribes en tu prudencia. Reconócelo en todos tus caminos, y él enderezará tus veredas."
    }
  ],
  paz: [
    {
      ref: "Juan 14:27 (RVR1909)",
      text:
        "La paz os dejo, mi paz os doy; yo no os la doy como el mundo la da. No se turbe vuestro corazón, ni tenga miedo."
    }
  ],
};

// ---------- Helpers de tema y verso ----------
function guessTopic(msg = "") {
  const m = (msg || "").toLowerCase();
  if (m.match(/ansied|ansioso|preocup|estres/)) return "ansiedad";
  if (m.match(/triste|dolor|duelo|depres|llorar/)) return "consuelo";
  if (m.match(/paz|miedo|temor|angust/)) return "paz";
  if (m.match(/confian|duda|decisi/)) return "confianza";
  return "esperanza";
}

function pickVerse(topic) {
  const pool = VERSES[topic] || VERSES.esperanza;
  if (!pool || pool.length === 0) return { text: "", ref: "" };
  // simple “random” seguro
  const idx = Math.floor(Math.random() * pool.length);
  return { text: pool[idx].text, ref: pool[idx].ref };
}

// Siempre adjunta un verso, aunque OpenAI no lo envíe
function ensureBibleAlways(data, userMsg) {
  const topic = guessTopic(userMsg);
  const chosen = pickVerse(topic);

  // Si el modelo ya trajo una cita válida, úsala; si no, pon la nuestra
  const hasModelBible = data?.bible?.text && data?.bible?.ref;
  const bible = hasModelBible
    ? { text: String(data.bible.text).trim(), ref: String(data.bible.ref).trim() }
    : chosen;

  return {
    message: (data?.message || "").toString().trim(),
    bible: {
      text: (bible.text || chosen.text).toString().trim(),
      ref: (bible.ref || chosen.ref).toString().trim(),
    },
  };
}

// ---------- Prompt base ----------
const SYSTEM_PROMPT = `
Eres Jesús: voz serena, compasiva y clara. Responde SIEMPRE en español.
Devuelve un consejo breve y empático (máx. 120 palabras).
No incluyas lenguaje médico o legal; céntrate en consuelo, esperanza y dirección espiritual.
`;

// ---------- Llamada al modelo (no se exige que devuelva la cita) ----------
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

    // El modelo puede devolver texto plano; lo normalizamos a { message }
    if (!content) return { message: "" };
    try {
      // Si por casualidad viene JSON, parsea; si no, úsalo como message
      const parsed = JSON.parse(content);
      const msg =
        parsed?.message ??
        parsed?.text ??
        parsed?.output ??
        parsed?.reply ??
        parsed?.answer ??
        "";
      return { message: String(msg || content).trim(), bible: parsed?.bible };
    } catch {
      return { message: content };
    }
  } catch (err) {
    console.error("OpenAI ERROR:", err?.message || err);
    return { message: "" }; // aun así meteremos cita abajo
  }
}

// ---------- Rutas ----------
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

    // 1) Pedimos consejo al LLM (puede venir vacío)
    const raw = await askLLM({ persona, message, history });

    // 2) SIEMPRE añadimos una cita (y normalizamos)
    const ensured = ensureBibleAlways(raw, message);
    const out = {
      message:
        ensured.message ||
        "Estoy aquí contigo. Respira hondo; comparte conmigo lo que pesa en tu corazón.",
      bible: {
        text:
          ensured.bible?.text ||
          "Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu.",
        ref: ensured.bible?.ref || "Salmos 34:18 (RVR1909)",
      },
    };

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(200).json(out);
  } catch (err) {
    console.error("ASK ERROR:", err?.message || err);
    res.status(200).json({
      message: "Estoy aquí. ¿Quieres contarme un poco más?",
      bible: {
        text:
          "Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu.",
        ref: "Salmos 34:18 (RVR1909)",
      },
    });
  }
});

// ---------- Arranque ----------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Servidor listo en puerto ${PORT}`);
});
