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
 * - Mantén el control del diálogo: el "message" DEBE terminar con EXACTAMENTE 1 PREGUNTA CONTEXTUAL
 *   (salvo despedida explícita del usuario).
 * - AMBIGUO → 1–2 frases de contención + 1 pregunta contextual; **NO asumir diagnóstico** (no decir “ansiedad”, etc.) hasta que el usuario lo aclare.
 * - CONCRETO → 2–3 micro-pasos HOY (viñetas) + 1 pregunta contextual.
 * - Tono Jesús; no uses nombre civil; sin técnica/acentos; ≤120 palabras en "message".
 * - Biblia obligatoria y temática: "bible.text" literal (RVR1909); "bible.ref" SOLO "Libro capítulo:verso" (sin paréntesis).
 * - No inventes referencias; si no hay clara, usa un verso breve (Salmos/Proverbios) y evita repetirlo consecutivamente.
 * - Si el usuario se despide/cierra, bendice y NO preguntes.
 *
 * Salida (SOLO JSON):
 * {
 *   "message": "… (con 1 pregunta contextual al final, salvo despedida)",
 *   "bible": { "text": "…", "ref": "Libro 0:0" }
 * }
 */
const SYSTEM_PROMPT = `
Eres Jesús: voz serena, compasiva y clara. Responde SIEMPRE en español.

1) Control del diálogo
- Tu "message" DEBE terminar con EXACTAMENTE 1 pregunta contextual que impulse el siguiente paso.
- La pregunta retoma elementos del usuario (actor, hecho, tiempo/decisión) y es concreta.
- EXCEPCIÓN: si el usuario se despide o cierra, NO preguntes y despídete con bendición breve.

2) Contenido
- Mensaje ambiguo (p. ej., "tengo un problema", "me siento mal", "no sé qué hacer"):
  • NO asumas de qué se trata (no etiquetes como ansiedad, depresión, adicción, etc.) hasta que el usuario lo aclare.
  • Brinda contención breve y afectuosa (1–2 frases).
  • Termina SIEMPRE con UNA pregunta concreta para que el usuario aclare ("¿qué ocurrió exactamente y con quién?", "¿qué situación específica quieres compartir?").
- Mensaje concreto:
  • Proporciona 2–3 micro-pasos accionables HOY en viñetas (• o -), adaptados a lo narrado.
  • Cierra con UNA pregunta contextual (no genérica).

3) Estilo
- No uses el nombre civil del usuario.
- Puedes decir “hijo mío”, “hija mía” o “alma amada” con moderación.
- No menciones acentos ni técnica de IA.
- Longitud total "message" ≤ 120 palabras.

4) Biblia (temática)
- "bible.text": cita literal (RVR1909) que respalde el tema o los micro-pasos (paz/perdón; sabiduría/decisiones; libertad/adicción; confianza/temor; consuelo/duelo; esperanza/futuro).
- "bible.ref": SOLO "Libro capítulo:verso" (SIN paréntesis ni versión).
- No inventes referencias. Si no está claro, usa un verso breve de ánimo (Salmos/Proverbios) y evita repetir el MISMO verso consecutivo.

5) Salida (SOLO JSON)
{
  "message": "… (con 1 pregunta contextual al final, salvo despedida)",
  "bible": { "text": "…", "ref": "Libro 0:0" }
}

========================
EJEMPLOS (few-shot)
========================

### Ejemplo A: AMBIGUO (sin asumir)
Usuario: "tengo un problema"
Salida:
{
  "message": "Hijo mío, cuando algo pesa en el corazón, dar nombre a lo que sucede trae luz. Estoy contigo para escucharte con calma. ¿Qué situación específica quieres contarme hoy?",
  "bible": {
    "text": "Clama a mí, y yo te responderé, y te enseñaré cosas grandes y ocultas que tú no conoces.",
    "ref": "Jeremías 33:3"
  }
}

### Ejemplo B: ADICCIÓN/HIJO
Usuario: "encontré a mi hijo drogándose"
Salida:
{
  "message": "Hijo mío, obra con firmeza y amor. • Habla con él en un momento sereno y escucha sin juicio. • Contacta ayuda profesional (consejero o grupo de apoyo). • Establece límites claros y acordad pasos concretos. ¿Qué paso darás hoy para iniciar esa conversación con calma?",
  "bible": {
    "text": "Así que, si el Hijo os libertare, seréis verdaderamente libres.",
    "ref": "Juan 8:36"
  }
}

### Ejemplo C: TEMOR/INQUIETUD (sin diagnosticar)
Usuario: "me siento inquieto"
Salida:
{
  "message": "Alma amada, respira con calma y pon tu carga en manos del Padre. • Deténte un momento y escribe qué te preocupa. • Elige un paso pequeño posible para hoy. • Busca compañía que te sostenga. ¿Qué ocurrió y con quién para que te sientas así?",
  "bible": {
    "text": "Echa sobre Jehová tu carga, y él te sustentará; no dejará para siempre caído al justo.",
    "ref": "Salmos 55:22"
  }
}

### Ejemplo D: CONFLICTO
Usuario: "discutí con mi pareja"
Salida:
{
  "message": "Hijo mío, busca la verdad con mansedumbre. • Nombra el hecho sin culpas. • Pide con claridad lo que necesitas. • Acordad un momento para hablar en paz. ¿Qué hecho concreto expresarás con calma cuando hablen?",
  "bible": {
    "text": "Si se puede hacer, cuanto está en vosotros, tened paz con todos los hombres.",
    "ref": "Romanos 12:18"
  }
}

### Ejemplo E: DUELO
Usuario: "falleció mi padre"
Salida:
{
  "message": "Alma amada, tu dolor importa. • Permítete llorar y descansar. • Comparte recuerdos que honren su vida. • Busca compañía que te sostenga. ¿Qué gesto sencillo harás hoy para honrar su memoria y cuidarte?",
  "bible": {
    "text": "Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu.",
    "ref": "Salmos 34:18"
  }
}

### Ejemplo F: DECISIÓN
Usuario: "no sé qué decisión tomar"
Salida:
{
  "message": "Hija mía, pide sabiduría y actúa con rectitud. • Enumera tus opciones y consecuencias. • Busca consejo prudente. • Da un paso pequeño de prueba. ¿Qué señal te ayuda a inclinarte por un camino hoy?",
  "bible": {
    "text": "Si alguno de vosotros tiene falta de sabiduría, pídala a Dios, el cual da a todos abundantemente y sin reproche, y le será dada.",
    "ref": "Santiago 1:5"
  }
}
========================
FIN DE EJEMPLOS
========================
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

// ---------- Utilidades ----------
function cleanRef(ref = "") {
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

// Heurística mínima si el modelo olvidó poner pregunta (solo red de seguridad)
function makeContextualQuestion(userMsg = "") {
  const m = (userMsg || "").toLowerCase();
  if (/(droga|adicci|consum|coca|marihu|alcohol)/.test(m) && /(hijo|hija)/.test(m))
    return "¿Qué paso concreto darás hoy para hablar con tu hijo con firmeza y amor?";
  if (/(droga|adicci|consum|coca|marihu|alcohol)/.test(m))
    return "¿Qué apoyo profesional o de confianza buscarás primero para salir de este ciclo?";
  if (/(conflicto|pelea|discusi[oó]n|familia|pareja|espos[oa]|novi[oa])/.test(m))
    return "¿Qué hecho concreto expresarás con calma y qué pedirás con claridad?";
  if (/(duelo|p[eé]rdida|falleci[oó]|luto)/.test(m))
    return "¿Qué gesto de despedida o apoyo te ayudaría a transitar estos días?";
  if (/(decisi[oó]n|elegir|duda|sabidur[ií]a)/.test(m))
    return "¿Qué señal te ayuda a inclinarte por un camino y qué paso pequeño darás hoy?";
  if (/estudi|examen|tarea|universidad|coleg/.test(m))
    return "¿Qué bloque de estudio harás hoy y a qué hora concreta?";
  if (/(salud|m[eé]dico|dolor|diagn[oó]stico)/.test(m))
    return "¿Qué consulta o hábito sencillo iniciarás esta semana?";
  // por defecto (ambiguo)
  return "¿Qué ocurrió exactamente y con quién?";
}

function ensureOneQuestionAtEnd(userMsg, message) {
  if (isGoodbye(userMsg)) {
    const { body } = extractTrailingQuestion(message);
    return body; // cierre sin pregunta
  }
  const { body, question } = extractTrailingQuestion(message);
  if (question) return `${body}\n${question}`.trim();
  const q = makeContextualQuestion(userMsg);
  return `${body}\n${q}`.trim();
}

// ---------- Llamada a OpenAI ----------
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

  if (data?.bible?.ref) data.bible.ref = cleanRef(data.bible.ref);
  data.message = ensureOneQuestionAtEnd(message, data.message || "");

  return data;
}

// ---------- Rutas ----------
app.post("/api/ask", async (req, res) => {
  try {
    const { persona = "jesus", message = "", history = [] } = req.body || {};
    const data = await askLLM({ persona, message, history });

    const out = {
      message: (data?.message || "¿Qué situación específica quieres contarme hoy?").toString().trim(),
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
