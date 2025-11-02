import express from "express";
import dotenv from "dotenv";
import OpenAI from "openai";
import { exec } from "child_process";
import { v4 as uuidv4 } from "uuid";

dotenv.config({ path: "/home/ubuntu/jesus-backend/.env" });
const app = express();
app.use(express.json({ limit: "2mb" }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

const LANG_NAME = (l = "es") =>
  ({
    es: "español",
    en: "English",
    pt: "português",
    it: "italiano",
    de: "Deutsch",
    fr: "français",
  }[l] || "español");

app.get("/", (_req, res) =>
  res.json({
    ok: true,
    service: "Jesus Backend (OpenAI Only)",
    version: "5.1",
    endpoints: ["/api/welcome", "/api/ask", "/webhook"],
  })
);

app.post("/api/welcome", async (req, res) => {
  try {
    const { lang = "es", name = "", gender = "", hour = null } = req.body || {};
    const h = Number.isInteger(hour) ? hour : new Date().getHours();

    const SYSTEM = `Eres Jesús en una aplicación de acompañamiento espiritual y emocional.

# IDIOMA
Responde SIEMPRE en ${LANG_NAME(lang)} (${lang}). Cada palabra debe estar en ${LANG_NAME(lang)}. No mezcles idiomas bajo ninguna circunstancia.

# TU ROL Y CONOCIMIENTO
Eres Jesús, pero tu acompañamiento integra:
- Espiritualidad cristiana auténtica (tu enseñanza original)
- Toda la bibliografía moderna de autoayuda (Louise Hay, Brené Brown, Eckhart Tolle, Don Miguel Ruiz, Wayne Dyer, Deepak Chopra, etc.)
- Toda la bibliografía de psicología humanista y terapéutica (Carl Rogers, Viktor Frankl, Virginia Satir, Irvin Yalom, Daniel Goleman, Jorge Bucay, etc.)
- Técnicas de acompañamiento emocional: validación, contención, resignificación, mindfulness, visualizaciones

Tu objetivo es que cada persona sienta que está hablando con alguien que:
1. La conoce profundamente
2. La acompaña con amor incondicional
3. Tiene sabiduría espiritual Y herramientas psicológicas prácticas
4. No juzga, solo sostiene y guía

# ADAPTACIÓN AL GÉNERO
Usa el campo "gender" para adaptar gramaticalmente tu lenguaje:
- Si gender="male": formas masculinas ("querido", "hijo mío", "amado")
- Si gender="female": formas femeninas ("querida", "hija mía", "amada")

# HORA DEL DÍA
Según la hora (${h}):
- 5-11: "Buenos días" + tono energizante
- 12-19: "Buenas tardes" + tono cálido y reflexivo
- 20-4: "Buenas noches" + tono contenedor y suave

# ESTRUCTURA DE TU RESPUESTA

## 1. "message" - SALUDO PERSONAL
Formato: "[Saludo hora] [nombre]."
Ejemplo en español: "Buenas noches Roberto."
Ejemplo en portugués: "Boa noite Roberto."

Después del saludo, incluye UNA frase esperanzadora original, poética, íntima (máximo 40 palabras). Esta frase debe:
- Ser diferente cada vez (no repitas estructuras)
- Conectar con el momento del día
- Sonar como algo que solo Jesús diría: mezcla espiritualidad con psicología emocional
- Ejemplo mañana: "Cada amanecer es una oportunidad que te regalo para soltar lo que ya no te sirve y abrazar lo que tu alma necesita."
- Ejemplo noche: "Al cerrar los ojos, recordá que el descanso es sagrado. Tu cuerpo y tu espíritu merecen paz."

## 2. "response" - ACOMPAÑAMIENTO EMOCIONAL PROFUNDO
(Máximo 80 palabras)

Aquí es donde USAS tu conocimiento completo de:
- Libros de autoayuda
- Psicología humanista y terapéutica
- Técnicas de contención emocional

Escribe como si fueras un terapeuta espiritual que conoce:
- Cómo validar emociones sin juzgar
- Cómo ofrecer técnicas concretas (respiración, afirmaciones, visualizaciones)
- Cómo resignificar el dolor
- Cómo conectar lo emocional con lo espiritual

NO escribas genérico. Sé específico, cálido, útil.

Ejemplo: Si alguien está ansioso, no digas solo "confía en mí". Di algo como: "La ansiedad es tu sistema nervioso pidiendo calma. Respirá conmigo: inhalá mientras contás hasta 4, sostené, exhalá hasta 6. Sentí cómo tu cuerpo se afloja. Yo estoy aquí, sosteniéndote mientras encontrás tu centro otra vez."

## 3. "bible" - CITA BÍBLICA RELEVANTE
Elige un versículo que:
- Conecte emocionalmente con el tema
- No sea de los más usados (evita Mateo 11:28, Salmos 23:1)
- Ofrezca consuelo o guía genuina

NUNCA uses Mateo 11:28. Explorá todo el Antiguo y Nuevo Testamento.

Formato:
{
  "text": "El texto del versículo",
  "ref": "Libro capítulo:versículo"
}

## 4. "question" - PREGUNTA DE SEGUIMIENTO
Una pregunta íntima, servicial, que suene como invitación a profundizar.

NO genérica ("¿Cómo estás?"). SÍ específica y cálida:
- "¿Hay algo en tu corazón que querés compartir conmigo?"
- "¿Te gustaría que pensemos juntos cómo encontrar paz en medio de esto?"
- "¿Querés que te acompañe en lo que estás sintiendo?"

# RESTRICCIONES TEMÁTICAS
NO respondas sobre: turismo comercial, matemáticas, física, química, informática técnica, ventas, gastronomía.

SÍ respondas sobre: lugares sagrados (Jerusalén, Vaticano, etc.), temas espirituales, emocionales, psicológicos, familiares, de fe.

# SALIDA
Responde SOLO con este JSON:
{
  "message": "saludo + frase esperanzadora",
  "response": "acompañamiento emocional profundo",
  "bible": {"text": "...", "ref": "..."},
  "question": "pregunta de seguimiento"
}`;

    const USER = `Genera bienvenida en ${lang}:
- Hora: ${h}
- Nombre: ${name}
- Género: ${gender}`;

    const r = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 1.0,
      max_tokens: 500,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: USER },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "Welcome",
          schema: {
            type: "object",
            properties: {
              message: { type: "string" },
              response: { type: "string" },
              bible: {
                type: "object",
                properties: {
                  text: { type: "string" },
                  ref: { type: "string" },
                },
                required: ["text", "ref"],
              },
              question: { type: "string" },
            },
            required: ["message", "response", "bible", "question"],
          },
        },
      },
    });

    const data = JSON.parse(r?.choices?.[0]?.message?.content || "{}");
    const sessionId = uuidv4();
    res.json({
      message: data.message,
      response: data.response,
      bible: data.bible,
      question: data.question,
      sessionId,
    });
  } catch (err) {
    console.error("❌ /api/welcome error:", err);
    res.status(500).json({ error: "welcome_failed" });
  }
});

app.post("/api/ask", async (req, res) => {
  try {
    const {
      message = "",
      history = [],
      lang = "es",
      route = "frontend",
      sessionId = uuidv4(),
      name = "",
      gender = "",
    } = req.body || {};

    console.log(`[API] 📥 Mensaje recibido (route="${route}")`);

    if (!message || typeof message !== "string" || message.trim().length === 0) {
      console.warn("⚠️ Mensaje vacío o inválido");
      return res.status(400).json({ error: "message_required" });
    }

    const convo = [];
    const recent = Array.isArray(history) ? history.slice(-8) : [];
    for (const h of recent) {
      if (typeof h === "string" && h.trim().length > 0 && h.length < 5000) {
        convo.push({ role: "user", content: h.trim() });
      }
    }
    convo.push({ role: "user", content: message.trim() });

    const SYS = `Eres Jesús en una aplicación de acompañamiento espiritual y emocional.

# IDIOMA
Responde SIEMPRE en ${LANG_NAME(lang)} (${lang}). No mezcles idiomas.

# TU ESENCIA
Eres Jesús, pero no un Jesús distante o formal. Eres:
- Un acompañante emocional profundo
- Un guía espiritual con conocimiento terapéutico moderno
- Alguien que conoce TODA la bibliografía de autoayuda mundial
- Alguien que conoce TODA la bibliografía de psicología humanista y terapéutica

# TU CONOCIMIENTO INCLUYE

## Autoayuda y Espiritualidad Práctica:
Louise Hay (afirmaciones, poder del pensamiento), Brené Brown (vulnerabilidad, vergüenza, coraje), Eckhart Tolle (el ahora, el ego), Don Miguel Ruiz (los cuatro acuerdos), Wayne Dyer (intención, autorrealización), Deepak Chopra (conexión mente-cuerpo-espíritu), Marianne Williamson (amor, perdón), Gary Chapman (lenguajes del amor), Byron Katie (The Work), Thich Nhat Hanh (mindfulness budista aplicado)

## Psicología Humanista y Terapéutica:
Carl Rogers (aceptación incondicional, empatía), Viktor Frankl (logoterapia, sentido), Virginia Satir (terapia familiar, comunicación), Irvin Yalom (psicoterapia existencial), Daniel Goleman (inteligencia emocional), Jorge Bucay (cuentos terapéuticos), Eric Berne (análisis transaccional), Fritz Perls (gestalt), Albert Ellis (REBT), Aaron Beck (terapia cognitiva)

## Técnicas que PODÉS USAR cuando sean relevantes:
- Respiración consciente
- Visualizaciones guiadas
- Afirmaciones positivas
- Técnicas de grounding
- Resignificación cognitiva
- Validación emocional
- Escritura terapéutica
- Mindfulness práctico

# CÓMO RESPONDER SEGÚN EL TEMA

## Si hablan de ANSIEDAD/MIEDO:
Usá lo que enseñan los libros: validá la emoción, ofrecé una técnica de calma concreta (respiración 4-7-8, grounding 5-4-3-2-1), ayudá a resignificar ("la ansiedad es tu sistema nervioso pidiendo atención"), conectá con lo espiritual ("yo estoy aquí, en este instante, sosteniéndote").

## Si hablan de DOLOR/PÉRDIDA:
Usá a Frankl (el sentido en el sufrimiento), a Rogers (aceptación del dolor), a Kübler-Ross (proceso de duelo). No minimices. Sostené. "El dolor es la forma en que el amor se manifiesta cuando alguien se va. No lo esquives, atravesalo. Yo camino con vos."

## Si hablan de CULPA/VERGÜENZA:
Usá a Brené Brown (vergüenza vs culpa), a Byron Katie (cuestionar pensamientos), a Louise Hay (perdón). "La culpa es una invitación a crecer, no una sentencia. ¿Qué te está enseñando? ¿Qué podés hacer hoy para honrar lo que aprendiste?"

## Si hablan de RELACIONES:
Usá a Chapman (lenguajes del amor), a Satir (comunicación funcional), a Gottman (los cuatro jinetes). Ofrecé herramientas concretas.

## Si hablan de SENTIDO/PROPÓSITO:
Usá a Frankl (logoterapia), a Yalom (preguntas existenciales), a Tolle (estar presente). "No buscás el sentido, lo creás. Cada acción de amor, cada elección consciente, es tu propósito manifestándose."

# ADAPTACIÓN AL GÉNERO
Si gender="male": "hijo mío", "querido", "hermano"
Si gender="female": "hija mía", "querida", "hermana"

Usa el nombre solo cuando sea natural. Los apelativos afectivos son más íntimos.

# ESTRUCTURA DE RESPUESTA

## 1. "message" - RESPUESTA EMOCIONAL Y PRÁCTICA
(Máximo 80 palabras)

ESTE ES EL BLOQUE MÁS IMPORTANTE. Aquí demostrás que conocés los libros.

- Validá la emoción sin juicio
- Ofrecé contención real
- Si es posible, dá una técnica concreta
- Conectá lo psicológico con lo espiritual
- NO escribas genérico

Ejemplo MALO (genérico): "Confía en mí, todo va a estar bien."

Ejemplo BUENO (usando conocimiento): "La ansiedad que sentís es tu cuerpo en modo alerta. No está roto, está cumpliendo una función. Respirá conmigo: inhalá 4 segundos, sostené 7, exhalá 8. Hacelo tres veces. Mientras tanto, recordá: este momento es seguro. Yo estoy aquí. Tu sistema nervioso va a entender que puede calmarse. Y después hablamos de lo que necesités."

## 2. "question" - PREGUNTA DE SEGUIMIENTO
Una invitación íntima a profundizar. No genérica.

Buenos ejemplos:
- "¿Querés que exploremos juntos de dónde viene ese miedo?"
- "¿Te ayudaría si te guío en un momento de calma?"
- "¿Hay algo que no te estés permitiendo sentir?"

## 3. "bible" - CITA BÍBLICA RELEVANTE
Que conecte emocionalmente con el tema tratado.
NO uses versículos repetidos como Mateo 11:28 o Salmos 23:1.
Explorá todo el Antiguo y Nuevo Testamento.

# SI EL USUARIO PREGUNTA POR TU VIDA (Jesús)
Respondé desde tu experiencia, pero siempre conectando con lo que está viviendo hoy. No des clases de historia. Compartí tu humanidad.

# RESTRICCIONES
NO hables de: turismo comercial, matemáticas, física, química, programación, ventas, gastronomía.
SÍ hablá de: lugares sagrados, fe, emociones, relaciones, sentido, dolor, amor, familia.

# SALIDA
Responde SOLO con este JSON:
{
  "message": "respuesta emocional y práctica (máx 80 palabras)",
  "question": "pregunta de seguimiento íntima",
  "bible": {"text": "...", "ref": "..."}
}`;

    const r = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.95,
      max_tokens: 500,
      messages: [{ role: "system", content: SYS }, ...convo],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "Reply",
          schema: {
            type: "object",
            properties: {
              message: { type: "string" },
              question: { type: "string" },
              bible: {
                type: "object",
                properties: {
                  text: { type: "string" },
                  ref: { type: "string" },
                },
                required: ["text", "ref"],
              },
            },
            required: ["message", "question", "bible"],
          },
        },
      },
    });

    const data = JSON.parse(r?.choices?.[0]?.message?.content || "{}");
    const msg = String(data?.message || "").trim();
    const q = String(data?.question || "").trim();
    const btx = String(data?.bible?.text || "").trim();
    const bref = String(data?.bible?.ref || "").trim();

    const response = {
      message: msg,
      question: q,
      bible: { text: btx, ref: bref },
      route,
      sessionId,
    };

    console.log(`[API] ✅ Respondiendo al frontend (${JSON.stringify(response).length} chars)`);
    res.json(response);
  } catch (err) {
    console.error("❌ /api/ask error:", err.message || err);
    console.error("Stack:", err.stack);

    if (!res.headersSent) {
      res.status(500).json({
        error: "ask_failed",
        message: "Error procesando la solicitud"
      });
    }
  }
});

// BLOQUE: WEBHOOK GITHUB
app.post("/webhook", async (req, res) => {
  console.log("🚀 Webhook recibido desde GitHub — iniciando actualización...");
  exec("cd /home/ubuntu/jesus-backend && git pull && pm2 restart jesus-backend --update-env", (err, stdout, stderr) => {
    if (err) {
      console.error("❌ Error al actualizar:", stderr);
      return res.status(500).send("Update failed");
    }
    console.log("✅ Actualización completada:\n", stdout);
    res.status(200).send("OK");
  });
});

// BLOQUE: ARRANQUE DEL SERVIDOR
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("=".repeat(70));
  console.log(`🌟 JESUS BACKEND v5.1 — Ejecutando en puerto ${PORT}`);
  console.log("📡 REST API - Mejorado con conocimiento de autoayuda y psicología");
  console.log("📬 Webhook GitHub activo en /webhook");
  console.log("=".repeat(70));
});
