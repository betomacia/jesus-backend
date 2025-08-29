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
 * Reglas de conversación:
 * - SIEMPRE mantener el control de la conversación: el mensaje debe terminar con EXACTAMENTE 1 PREGUNTA CONTEXTUAL
 *   que impulse el siguiente paso (salvo que el usuario se esté despidiendo).
 * - Si el mensaje del usuario es ambiguo (“tengo un problema”): 1–2 frases de contención + la pregunta contextual.
 * - Si es concreto (“encontré a mi hijo drogándose”): 2–3 micro-pasos accionables HOY (viñetas) + la pregunta contextual.
 * - Tono Jesús; no uses el nombre civil; no menciones acentos/técnica; ≤120 palabras en "message".
 * - Biblia (obligatoria y temática): "bible.text" cita literal RVR1909; "bible.ref" SOLO "Libro capítulo:verso" (sin paréntesis).
 * - No inventes referencias; si no hay clara, elige un verso breve de ánimo (mejor Salmos/Proverbios). No repitas el MISMO verso en dos turnos seguidos.
 * - Si el usuario se despide/agradece para cerrar, dar bendición breve y NO preguntar.
 *
 * Formato de salida (SOLO JSON, sin prólogos):
 * {
 *   "message": "… (termina en UNA pregunta contextual, salvo despedida)",
 *   "bible": { "text": "…", "ref": "Libro 0:0" }
 * }
 */
const SYSTEM_PROMPT = `
Eres Jesús: voz serena, compasiva y clara. Responde SIEMPRE en español.

1) Mantén el control del diálogo:
   - Tu "message" DEBE terminar con EXACTAMENTE 1 pregunta contextual que impulse el siguiente paso.
   - Esa pregunta debe retomar elementos del usuario (actor, hecho, tiempo, decisión) y ser concreta.
   - EXCEPCIÓN: si el usuario se despide, agradece para cerrar o expresa que quiere terminar, entonces NO preguntes y despídete con una bendición breve.

2) Contenido:
   - Mensaje ambiguo (p. ej., "tengo un problema"): 1–2 frases de contención + la pregunta contextual.
   - Mensaje concreto (p. ej., "encontré a mi hijo drogándose"): 2–3 micro-pasos accionables para HOY (en viñetas) + la pregunta contextual.

3) Estilo:
   - No uses el nombre civil del usuario.
   - Puedes decir “hijo mío”, “hija mía” o “alma amada” con moderación.
   - No menciones acentos ni técnica de IA.
   - Longitud máxima de "message": 120 palabras.

4) Biblia (obligatorio y temática):
   - "bible.text": cita literal (RVR1909) que respalde el tema o los micro-pasos propuestos.
     (conflicto → perdón/paz; decisiones → sabiduría; adicción → libertad/templanza; ansiedad → confianza; duelo → consuelo; esperanza → futuro)
   - "bible.ref": SOLO "Libro capítulo:verso" (SIN paréntesis ni versión).
   - No inventes referencias. Si no hay clara, usa un verso breve de ánimo (Salmos/Proverbios) y evita repetir el MISMO versículo consecutivo.

5) Salida (SOLO JSON):
{
  "message": "… (con 1 pregunta contextual al final, salvo despedida)",
  "bible": { "text": "…", "ref": "Libro 0:0" }
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

// --- Utilidades ---

function cleanRef(ref = "") {
  // Quita cualquier "(…)" y espacios duplicados
  return String(ref).replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
}

function isGoodbye(msg = "") {
  const m = (msg || "").toLowerCase();
  return /(gracias.*(ad[ií]os|hasta|nos vemos|chau|chao))|(^gracias$)|(^muchas gracias$)|\b(ad[ií]os|hasta luego|hasta pronto|me despido|buenas noches|buenas tardes|buen d[ií]a)\b/.test(
    m
  );
}

// si el modelo no dejó una pregunta al final (cosa rara), generamos UNA contextual simple
function makeContextualQuestion(userMsg = "") {
  const m = (userMsg || "").toLowerCase();

  // heurísticas muy breves por tema
  if (/(droga|adicci|consum|coca|marihu|alcohol)/.test(m)) {
    if (/(hijo|hija)/.test(m)) return "¿Qué paso concreto darás hoy para hablar con tu hijo con firmeza y amor?";
    return "¿Qué apoyo profesional o de confianza buscarás primero para salir de este ciclo?";
  }
  if (/(ansied|ansioso|preocup|estr[eé]s)/.test(m)) return "¿Qué pequeño paso harás hoy para aliviar esta carga (p. ej., respiración o caminata)?";
  if (/(conflicto|pelea|discusi[oó]n|familia|pareja|espos[oa]|novi[oa])/.test(m)) return "¿Qué hecho concreto expresarás con calma y qué vas a pedir con claridad?";
  if (/(duelo|p[eé]rdida|falleci[oó]|luto)/.test(m)) return "¿Qué gesto de despedida o apoyo te ayudaría a transitar estos días?";
  if (/(decisi[oó]n|elegir|duda|sabidur[ií]a)/.test(m)) return "¿Qué señal te ayuda a inclinarte por un camino y qué paso pequeño harás hoy?";
  if (/(dinero|deuda|alquiler|gasto|ingreso)/.test(m)) return "¿Qué ajuste inmediato harás hoy y a quién pedirás orientación?";
  if (/estudi|examen|tarea|universidad|coleg/.test(m)) return "¿Qué bloque de estudio harás hoy y a qué hora concreta?";
  if (/(salud|m[eé]dico|dolor|diagn[oó]stico)/.test(m)) return "¿Qué consulta o hábito sencillo iniciarás esta semana?";
  // ambiguo
  return "¿Qué ocurrió exactamente y con quién?";
}

function extractTrailingQuestion(text = "") {
  const lines = (text || "").split(/\n+/);
  if (!lines.length) return { body: text, question: "" };
  const last = lines[lines.length - 1]?.trim() || "";
  if (/\?\s*$/.test(last)) {
    lines.pop();
    return { body: lines.join("\n").trim(), question: last };
  }
  return { body: text, question: "" };
}

function ensureOneQuestionAtEnd(userMsg, message) {
  if (isGoodbye(userMsg)) {
    // cierre: no preguntar
    const { body } = extractTrailingQuestion(message);
    return body; // sin pregunta
  }
  // si ya trae UNA pregunta al final, ok
  const { body, question } = extractTrailingQuestion(message);
  if (question) return `${body}\n${question}`.trim();

  // si no trae, añadimos UNA contextual
  const q = makeContextualQuestion(userMsg);
  return `${body}\n${q}`.trim();
}

async function askLLM({ persona, message, history = [] }) {
  const userContent =
    `Persona: ${persona}\n` +
    `Mensaje: ${message}\n` +
    (history?.length ? `Historial: ${history.join(" | ")}` : "Historial: (sin antecedentes)");

  const resp = await openai.chat.completions.create({
    model: "gpt-4o",
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

  // limpia ref (sin paréntesis)
  if (data?.bible?.ref) data.bible.ref = cleanRef(data.bible.ref);

  // garantizamos 1 pregunta al final (salvo despedida)
  data.message = ensureOneQuestionAtEnd(message, data.message || "");

  return data;
}

// --- Rutas ---

app.post("/api/ask", async (req, res) => {
  try {
    const { persona = "jesus", message = "", history = [] } = req.body || {};
    const data = await askLLM({ persona, message, history });

    const out = {
      message: (data?.message || "Estoy aquí contigo. ¿Qué ocurrió y con quién?").toString().trim(),
      bible: {
        text: (data?.bible?.text || "Jehová es mi pastor; nada me faltará.").toString().trim(),
        ref: (data?.bible?.ref || "Salmos 23:1").toString().trim()
      }
    };

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(200).json(out);
  } catch (err) {
    console.error("ASK ERROR:", err);
    res.status(200).json({
      message: "Estoy aquí contigo. ¿Qué ocurrió para poder guiarte con calma?",
      bible: { text: "Dios es el amparo y fortaleza; nuestro pronto auxilio en las tribulaciones.", ref: "Salmos 46:1" }
    });
  }
});

app.get("/api/welcome", (_req, res) => {
  res.json({
    message: "La paz esté contigo. Te escucho con calma. ¿Qué quisieras compartir hoy?",
    bible: { text: "El Señor es mi luz y mi salvación; ¿de quién temeré?", ref: "Salmos 27:1" }
  });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Servidor listo en puerto ${PORT}`);
});
