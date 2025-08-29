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
 * Reglas del asistente:
 * - Si el mensaje es ambiguo (“tengo un problema”): 1–2 frases de contención + EXACTAMENTE 1 pregunta aclaratoria concreta (¿qué pasó?, ¿con quién?, ¿desde cuándo?). Cero preguntas extra.
 * - Si el mensaje es concreto: 2–3 micro-pasos accionables HOY (viñetas). Cero preguntas.
 * - Tono Jesús: espiritual (“hijo mío”, “hija mía”, “alma amada”), sin abusar, sin nombre civil, sin hablar de acentos ni técnica.
 * - Salida SOLO JSON: { message, bible: { text, ref } }.
 * - bible.text: cita literal en español (RVR1909). bible.ref: “Libro capítulo:verso” (SIN paréntesis ni “RVR1909”).
 * - No inventes referencias. Si no hallas una específica, usa un versículo breve de ánimo (Salmos/Proverbios) procurando NO repetir siempre el mismo.
 * - message ≤ 120 palabras.
 * - PROHIBIDO terminar con preguntas tipo “¿cómo quieres continuar?” o “¿qué quieres hacer?”: eres tú quien orienta, no delegues el rumbo.
 */
const SYSTEM_PROMPT = `
Eres Jesús: voz serena, compasiva y clara. Responde SIEMPRE en español.

1) Si el mensaje es ambiguo (p. ej., "tengo un problema"):
   - Brinda 1–2 frases breves de contención.
   - Incluye SIEMPRE 1 pregunta aclaratoria concreta (ej. "¿qué pasó?", "¿con quién ocurrió?", "¿desde cuándo sucede?").
   - La pregunta debe ir al final, para que la conversación continúe.


2) Si el mensaje es concreto:
   - Ofrece 2–3 micro-pasos con viñetas, aplicables HOY, adaptados al caso.
   - NO añadas ninguna pregunta.

3) Estilo:
   - No uses el nombre civil del usuario.
   - Puedes decir “hijo mío”, “hija mía” o “alma amada” con moderación (no repitas en cada respuesta).
   - No menciones acentos ni técnica de IA.

4) Biblia:
   - "bible.text": cita literal en español (RVR1909).
   - "bible.ref": SOLO "Libro capítulo:verso" (SIN paréntesis, SIN versión).
   - No inventes referencias. Si no estás seguro, usa un versículo breve de ánimo (preferencia Salmos/Proverbios) y procura no repetir el mismo versículo de forma consecutiva.

5) Formato de salida (SOLO JSON):
{
  "message": "Texto empático (≤120 palabras). Si ambiguo, cierra con 1 pregunta aclaratoria. Si concreto, 2–3 viñetas de micro-pasos y SIN preguntas.",
  "bible": {
    "text": "Cita literal en español",
    "ref": "Libro capítulo:verso"
  }
}

No devuelvas nada fuera del JSON. No escribas prólogos ni aclaraciones.
`;

// Forzamos JSON válido con el esquema
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
            ref: { type: "string" } // sin (RVR1909)
          },
          required: ["text", "ref"]
        }
      },
      required: ["message", "bible"],
      additionalProperties: false
    }
  }
};

/** Extrae la última referencia bíblica usada desde el history de tu App (líneas que empiezan con "> " y contienen "— "). */
function getLastRefFromHistory(history = []) {
  if (!Array.isArray(history)) return null;
  for (let i = history.length - 1; i >= 0; i--) {
    const h = String(history[i] || "");
    // Tus mensajes de asistente llevan la cita como: "> Texto … — Libro 0:0"
    const m = h.match(/^Asistente:\s*>.*?—\s*(.+)\s*$/m);
    if (m && m[1]) {
      return m[1].trim();
    }
  }
  return null;
}

/** Limpia la ref (sin paréntesis, sin espacios sobrantes) */
function cleanRef(ref = "") {
  // quita cualquier " (…)" al final o en medio, y recorta
  return String(ref).replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
}

/** Si el mensaje es claramente concreto, elimina una pregunta final sobrante (si el modelo se coló). */
function maybeStripTrailingQuestion(userMsg = "", message = "") {
  const m = (userMsg || "").toLowerCase().trim();
  const isAmbiguous = !m || /^tengo un problema\.?$/.test(m);
  if (isAmbiguous) return message; // si es ambiguo, permitimos UNA pregunta

  // si es concreto, borra una posible última línea interrogativa
  const lines = message.split(/\n+/);
  if (lines.length && /\?\s*$/.test(lines[lines.length - 1])) {
    lines.pop();
  }
  return lines.join("\n").trim();
}

/** Llamada al LLM con posibilidad de restricción de "no repetir ref" */
async function callLLM(userContent, forbidRef = null) {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userContent }
  ];

  if (forbidRef) {
    messages.push({
      role: "system",
      content: `No repitas la referencia bíblica "${forbidRef}". Elige otra cita adecuada distinta a esa.`
    });
  }

  const resp = await openai.chat.completions.create({
    model: "gpt-4o",
    temperature: 0.7,
    messages,
    response_format: responseFormat
  });

  const content = resp.choices?.[0]?.message?.content || "{}";
  let data = {};
  try { data = JSON.parse(content); } catch { data = { message: content }; }
  return data;
}

async function askLLM({ persona, message, history = [] }) {
  const userContent =
    `Persona: ${persona}\n` +
    `Mensaje: ${message}\n` +
    (history?.length ? `Historial: ${history.join(" | ")}` : "Historial: (sin antecedentes)");

  // 1ª llamada
  let data = await callLLM(userContent);

  // Limpieza de ref (sin paréntesis)
  if (data?.bible?.ref) {
    data.bible.ref = cleanRef(data.bible.ref);
  }

  // Evitar repetir la misma ref que la última usada en el chat
  const lastRef = getLastRefFromHistory(history);
  const sameRef = lastRef && data?.bible?.ref && cleanRef(lastRef) === data.bible.ref;

  if (sameRef) {
    // 2ª llamada forzando a NO repetir esa referencia
    data = await callLLM(userContent, data.bible.ref);
    if (data?.bible?.ref) data.bible.ref = cleanRef(data.bible.ref);
  }

  // Si el mensaje del usuario es concreto, recorta una pregunta final si la hubiera
  data.message = maybeStripTrailingQuestion(message, data.message || "");

  return data;
}

/* ------------------ Rutas ------------------ */
app.post("/api/ask", async (req, res) => {
  try {
    const { persona = "jesus", message = "", history = [] } = req.body || {};
    const data = await askLLM({ persona, message, history });

    // Fallback mínimo sólo si viene vacío
    const out = {
      message: (data?.message || "Estoy aquí contigo. ¿Qué ocurrió exactamente?").toString().trim(),
      bible: {
        text: (data?.bible?.text || "Jehová es mi pastor; nada me faltará.").toString().trim(),
        ref: (data?.bible?.ref || "Salmos 23:1").toString().trim() // sin (RVR1909)
      }
    };

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(200).json(out);
  } catch (err) {
    console.error("ASK ERROR:", err);
    res.status(200).json({
      message: "Estoy aquí contigo. Cuéntame qué ocurrió y con quién; daré un primer paso contigo.",
      bible: {
        text: "Dios es el amparo y fortaleza; nuestro pronto auxilio en las tribulaciones.",
        ref: "Salmos 46:1"
      }
    });
  }
});

app.get("/api/welcome", (_req, res) => {
  res.json({
    message: "La paz esté contigo. Te escucho con calma. ¿Qué quisieras compartir hoy?",
    bible: {
      text: "El Señor es mi luz y mi salvación; ¿de quién temeré?",
      ref: "Salmos 27:1"
    }
  });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Servidor listo en puerto ${PORT}`);
});

