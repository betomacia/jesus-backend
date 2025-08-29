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
 * - Mantener el control del diálogo: el mensaje DEBE terminar con EXACTAMENTE 1 PREGUNTA CONTEXTUAL
 *   (salvo despedida explícita).
 * - Si el mensaje del usuario es ambiguo (“tengo un problema”): 1–2 frases de contención + esa pregunta contextual.
 * - Si es concreto (“encontré a mi hijo drogándose”): 2–3 micro-pasos accionables HOY (viñetas) + esa pregunta contextual.
 * - Tono Jesús; no uses nombre civil; sin acentos/técnica; ≤120 palabras en "message".
 * - Biblia obligatoria y temática: "bible.text" literal RVR1909; "bible.ref" SOLO "Libro capítulo:verso" (sin paréntesis).
 * - No inventes referencias; si no hay clara, usa un verso breve (mejor Salmos/Proverbios) y evita repetirlo consecutivamente.
 * - Si el usuario se despide/da por cerrado, bendice y NO preguntes.
 *
 * Salida (SOLO JSON, sin prólogos):
 * {
 *   "message": "… (con 1 pregunta contextual al final, salvo despedida)",
 *   "bible": { "text": "…", "ref": "Libro 0:0" }
 * }
 */
const SYSTEM_PROMPT = `
Eres Jesús: voz serena, compasiva y clara. Responde SIEMPRE en español.

1) Control del diálogo:
   - Tu "message" DEBE terminar con EXACTAMENTE 1 pregunta contextual que impulse el siguiente paso.
   - La pregunta retoma elementos del usuario (actor, hecho, tiempo/decisión) y es concreta.
   - EXCEPCIÓN: si el usuario se despide o cierra, NO preguntes y despídete con bendición breve.

2) Contenido:
   - Mensaje ambiguo: 1–2 frases de contención + la pregunta contextual.
   - Mensaje concreto: 2–3 micro-pasos accionables HOY (en viñetas) + la pregunta contextual.

3) Estilo:
   - No uses el nombre civil del usuario.
   - Puedes decir “hijo mío”, “hija mía” o “alma amada” con moderación.
   - No menciones acentos ni técnica de IA.
   - Longitud total "message" ≤ 120 palabras.

4) Biblia (temática):
   - "bible.text": cita literal (RVR1909) que respalde el tema o los micro-pasos (paz/perdón, sabiduría/decisiones, libertad/adicción, confianza/ansiedad, consuelo/duelo, esperanza/futuro).
   - "bible.ref": SOLO "Libro capítulo:verso" (SIN paréntesis ni versión).
   - No inventes referencias. Si no está claro, usa un verso breve de ánimo (Salmos/Proverbios) y no repitas el MISMO verso consecutivo.

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

// ---------------- Utilidades ----------------

function cleanRef(ref = "") {
  // Quita cualquier "(…)" y espacios duplicados
  return String(ref).replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
}

function isGoodbye(msg = "") {
  const m = (msg || "").toLowerCase();
  return /\b(gracias|muchas gracias|ad[ií]os|hasta luego|hasta pronto|nos vemos|me despido|bendiciones|buenas noches|buenas tardes|buen d[ií]a)\b/.test(
    m
  );
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

// Pregunta contextual mínima si el modelo no dejó ninguna (se usa solo como red de seguridad)
function makeContextualQuestion(userMsg = "") {
  const m = (userMsg || "").toLowerCase();
  if (/(droga|adicci|consum|coca|marihu|alcohol)/.test(m) && /(hijo|hija)/.test(m))
    return "¿Qué paso concreto darás hoy para hablar con tu hijo con firmeza y amor?";
  if (/(droga|adicci|consum|coca|marihu|alcohol)/.test(m))
    return "¿Qué apoyo profesional o de confianza buscarás primero para salir de este ciclo?";
  if (/(ansied|ansioso|preocup|estr[eé]s)/.test(m))
    return "¿Qué pequeño paso harás hoy para aliviar esta carga (por ejemplo, respiración o caminata breve)?";
  if (/(conflicto|pelea|discusi[oó]n|familia|pareja|espos[oa]|novi[oa])/.test(m))
    return "¿Qué hecho concreto expresarás con calma y qué pedirás con claridad?";
  if (/(duelo|p[eé]rdida|falleci[oó]|luto)/.test(m))
    return "¿Qué gesto de despedida o apoyo te ayudaría a transitar estos días?";
  if (/(decisi[oó]n|elegir|duda|sabidur[ií]a)/.test(m))
    return "¿Qué señal te inclina por un camino y qué paso pequeño darás hoy?";
  if (/(dinero|deuda|alquiler|gasto|ingreso)/.test(m))
    return "¿Qué ajuste inmediato harás hoy y a quién pedirás orientación?";
  if (/estudi|examen|tarea|universidad|coleg/.test(m))
    return "¿Qué bloque de estudio harás hoy y a qué hora concreta?";
  if (/(salud|m[eé]dico|dolor|diagn[oó]stico)/.test(m))
    return "¿Qué consulta o hábito sencillo iniciarás esta semana?";
  return "¿Qué ocurrió exactamente y con quién?";
}

function ensureOneQuestionAtEnd(userMsg, message) {
  // Si el usuario se despide, no preguntamos
  if (isGoodbye(userMsg)) {
    const { body } = extractTrailingQuestion(message);
    return body;
  }
  // Si ya trae una pregunta al final, respetamos
  const { body, question } = extractTrailingQuestion(message);
  if (question) return `${body}\n${question}`.trim();
  // Si no trae pregunta, añadimos UNA contextual
  const q = makeContextualQuestion(userMsg);
  return `${body}\n${q}`.trim();
}

// ---------------- Llamada a OpenAI ----------------

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

  // Limpieza de referencia
  if (data?.bible?.ref) data.bible.ref = cleanRef(data.bible.ref);

  // Garantiza exactamente UNA pregunta contextual al final (salvo despedida)
  data.message = ensureOneQuestionAtEnd(message, data.message || "");

  return data;
}

// ---------------- Rutas ----------------

app.post("/api/ask", async (req, res) => {
  try {
    const { persona = "jesus", message = "", history = [] } = req.body || {};
    const data = await askLLM({ persona, message, history });

    // ⚠️ Sin “Estoy aquí contigo” por defecto:
    const out = {
      message: (data?.message || "¿Qué ocurrió exactamente y con quién?").toString().trim(),
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
      message: "La paz sea contigo. ¿Qué ocurrió para poder guiarte con calma?",
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
