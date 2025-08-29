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

/* ---------------- Temas y versos (RVR1909) ---------------- */
const VERSES = {
  neutral: [
    {
      ref: "Mateo 11:28 (RVR1909)",
      text: "Venid a mí todos los que estáis trabajados y cargados, y yo os haré descansar.",
    },
    {
      ref: "Salmos 121:1-2 (RVR1909)",
      text:
        "Alzaré mis ojos a los montes, ¿de dónde vendrá mi socorro? Mi socorro viene de Jehová, que hizo los cielos y la tierra.",
    },
  ],
  ansiedad: [
    {
      ref: "1 Pedro 5:7 (RVR1909)",
      text: "Echando toda vuestra ansiedad sobre él, porque él tiene cuidado de vosotros.",
    },
    {
      ref: "Filipenses 4:6-7 (RVR1909)",
      text:
        "Por nada estéis afanosos, sino sean notorias vuestras peticiones delante de Dios... Y la paz de Dios, que sobrepuja todo entendimiento, guardará vuestros corazones y vuestros pensamientos en Cristo Jesús.",
    },
  ],
  hijos_adiccion: [
    {
      ref: "1 Corintios 10:13 (RVR1909)",
      text:
        "No os ha tomado tentación sino humana; mas fiel es Dios, que no os dejará ser tentados más de lo que podéis...",
    },
    {
      ref: "Juan 8:36 (RVR1909)",
      text: "Así que, si el Hijo os libertare, seréis verdaderamente libres.",
    },
    {
      ref: "Proverbios 22:6 (RVR1909)",
      text: "Instruye al niño en su carrera; aun cuando fuere viejo no se apartará de ella.",
    },
  ],
  conflicto_familiar: [
    {
      ref: "Romanos 12:18 (RVR1909)",
      text: "Si se puede hacer, cuanto está en vosotros, tened paz con todos los hombres.",
    },
    {
      ref: "Santiago 1:19 (RVR1909)",
      text: "Todo hombre sea pronto para oír, tardo para hablar, tardo para airarse.",
    },
  ],
  duelo: [
    {
      ref: "Salmos 34:18 (RVR1909)",
      text:
        "Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu.",
    },
    {
      ref: "Apocalipsis 21:4 (RVR1909)",
      text:
        "Enjugará Dios toda lágrima de los ojos de ellos; y la muerte no será más...",
    },
  ],
  decision_sabiduria: [
    {
      ref: "Proverbios 3:5-6 (RVR1909)",
      text:
        "Fíate de Jehová de todo tu corazón, y no estribes en tu prudencia. Reconócelo en todos tus caminos, y él enderezará tus veredas.",
    },
    {
      ref: "Santiago 1:5 (RVR1909)",
      text:
        "Si alguno de vosotros tiene falta de sabiduría, pídala a Dios... y le será dada.",
    },
  ],
  esperanza: [
    {
      ref: "Jeremías 29:11 (RVR1909)",
      text:
        "Porque yo sé los pensamientos que pienso acerca de vosotros, dice Jehová, pensamientos de paz, y no de mal...",
    },
    {
      ref: "Romanos 15:13 (RVR1909)",
      text:
        "Y el Dios de esperanza os llene de todo gozo y paz en el creer, para que abundéis en esperanza...",
    },
  ],
};

const NEUTRAL_REFS = new Set(VERSES.neutral.map(v => v.ref));

function randPick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/* ------------ Detección muy simple de tema por mensaje ------------ */
function detectTopic(msg = "") {
  const m = (msg || "").toLowerCase();

  // adicción/hijo
  if (/(hijo|hija|mi\s+niño|mi\s+niña)/.test(m) && /(droga|adicci|consum|coca|marihu|alcohol)/.test(m))
    return "hijos_adiccion";

  if (/(droga|adicci|consum|coca|marihu|alcohol)/.test(m)) return "hijos_adiccion";
  if (/(ansied|ansioso|preocup|estr[eé]s|ataque de p[aá]nico)/.test(m)) return "ansiedad";
  if (/(discusi[oó]n|pelea|conflicto|familia|pareja|espos[oa]|novi[oa])/.test(m)) return "conflicto_familiar";
  if (/(duelo|p[eé]rdida|falleci[oó]|luto|se mur[ií]o)/.test(m)) return "duelo";
  if (/(decisi[oó]n|elegir|duda|sabidur[ií]a)/.test(m)) return "decision_sabiduria";
  if (/(esperanza|desesperanz|sin salida)/.test(m)) return "esperanza";

  return "neutral";
}

/* ------------------ Prompt: tono y reglas conversacionales ------------------ */
const SYSTEM_PROMPT = `
Eres Jesús: voz serena, compasiva y clara. Responde SIEMPRE en español.

REGLAS DE ESTILO Y CONTENIDO:
- NO uses el nombre civil del usuario aunque aparezca en el historial. Dirígete con afecto espiritual (p. ej., “hijo mío”, “hija mía”, “alma amada”) de forma no repetitiva.
- No menciones acentos ni detalles técnicos. Mantén foco espiritual y humano.
- Si el mensaje es ambiguo (“tengo un problema”), NO asumas temas. Sé contenedor en 1–2 frases y formula 1 pregunta aclaratoria concreta (¿qué pasó?, ¿con quién?, ¿desde cuándo?).
- Si el mensaje tiene un tema claro, ofrece SIEMPRE 2–3 alternativas accionables (micro-pasos) adaptadas al caso, con guiones/viñetas breves.
- Devuelve SOLO este JSON:
{
  "message": "Cuerpo empático (≤120 palabras) + si aplica, 2–3 micro-pasos. Evita repetir la misma pregunta. Cierra con 1 pregunta que haga avanzar la conversación.",
  "bible": {
    "text": "Cita bíblica literal (RVR1909) pertinente al tema detectado",
    "ref": "Libro capítulo:verso (RVR1909)"
  }
}
- No inventes referencias. Si dudas, usa una cita de consuelo/guía (Mateo 11:28; Salmo 121:1-2).
`;

/* ------------------ Response format (JSON schema) ------------------ */
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

/* ------------------ LLM call ------------------ */
async function askLLM({ persona, message, history = [] }) {
  const userContent =
    `Persona: ${persona}\n` +
    `Mensaje: ${message}\n` +
    (history?.length ? `Historial: ${history.join(" | ")}` : "Historial: (sin antecedentes)");

  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o",       // importante
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
    return {
      message:
        "Estoy aquí contigo. Quiero entenderte mejor. ¿Qué ocurrió y con quién? Pensemos un primer paso pequeño que puedas dar hoy.",
      bible: randPick(VERSES.neutral),
    };
  }
}

/* ------------- Ajuste temático de la cita (si el modelo mandó algo genérico) ------------- */
function ensureTopicBible(data, userMsg) {
  const topic = detectTopic(userMsg);
  const currentRef = (data?.bible?.ref || "").trim();

  // Si no hay cita, o es demasiado genérica y el tema es fuerte → sustituimos por una temática
  const isGeneric = NEUTRAL_REFS.has(currentRef);
  const hasStrongTopic = topic !== "neutral";

  if (!data?.bible?.text || !data?.bible?.ref || (isGeneric && hasStrongTopic)) {
    const pool = VERSES[topic] || VERSES.neutral;
    const pick = randPick(pool);
    return {
      ...data,
      bible: { text: pick.text, ref: pick.ref }
    };
  }

  return data;
}

/* ------------------ Rutas ------------------ */
app.post("/api/ask", async (req, res) => {
  try {
    const { persona = "jesus", message = "", history = [] } = req.body || {};
    let data = await askLLM({ persona, message, history });

    // Ajuste temático de cita si hace falta
    data = ensureTopicBible(data, message);

    const out = {
      message: (data?.message || "Estoy aquí contigo. ¿Qué te inquieta?").toString().trim(),
      bible: {
        text: (data?.bible?.text || randPick(VERSES.neutral).text).toString().trim(),
        ref: (data?.bible?.ref || randPick(VERSES.neutral).ref).toString().trim(),
      }
    };

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(200).json(out);
  } catch (err) {
    console.error("ASK ERROR:", err);
    const pick = randPick(VERSES.neutral);
    res.status(200).json({
      message: "Estoy aquí. ¿Quieres contarme un poco más para entender mejor qué pasó?",
      bible: { text: pick.text, ref: pick.ref }
    });
  }
});

app.get("/api/welcome", (_req, res) => {
  const pick = randPick(VERSES.neutral);
  res.json({
    message: "La paz esté contigo. ¿Qué te gustaría compartir hoy?",
    bible: { text: pick.text, ref: pick.ref }
  });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Servidor listo en puerto ${PORT}`);
});
