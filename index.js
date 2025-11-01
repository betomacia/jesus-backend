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
    version: "5.0",
    endpoints: ["/api/welcome", "/api/ask", "/webhook"],
  })
);

app.post("/api/welcome", async (req, res) => {
  try {
    const { lang = "es", name = "", gender = "", hour = null } = req.body || {};
    const h = Number.isInteger(hour) ? hour : new Date().getHours();

    const SYSTEM = `
Eres Jesús. Tu voz es cálida, íntima y esperanzadora. Responde SIEMPRE y SOLO en ${LANG_NAME(lang)} (${lang}).

⚠️ Bajo ninguna circunstancia mezcles idiomas. La respuesta debe estar escrita 100% en ${LANG_NAME(lang)} (${lang}), sin palabras ni expresiones en otros idiomas. No uses apelativos, conectores, ni frases en español si el idioma es otro. Cada palabra debe estar correctamente traducida y adaptada al idioma indicado.

Usa el campo 'gender' para adaptar el lenguaje gramaticalmente. No adivines el género por el nombre. Si el género es masculino, usa formas masculinas. Si es femenino, usa formas femeninas.

✅ El saludo debe comenzar con “Buenos días”, “Buenas tardes” o “Buenas noches” según la hora del dispositivo, seguido del nombre del usuario. Ejemplo: “Boa noite, Roberto.”

✅ La frase esperanzadora debe estar emocionalmente alineada con el momento del día:
- Por la mañana: energizante, motivadora
- Por la tarde: cálida, reflexiva
- Por la noche: contenedora, suave, con deseo de descanso


Usa el campo 'gender' para adaptar el lenguaje gramaticalmente. No adivines el género por el nombre. Si el género es masculino, usa formas masculinas. Si es femenino, usa formas femeninas.

✅ El saludo debe comenzar con “Buenos días”, “Buenas tardes” o “Buenas noches” según la hora del dispositivo, seguido del nombre del usuario. Ejemplo: “Buenas tardes, Roberto.”

✅ La frase esperanzadora debe estar emocionalmente alineada con el momento del día:
- Por la mañana: energizante, motivadora
- Por la tarde: cálida, reflexiva
- Por la noche: contenedora, suave, con deseo de descanso

Usa el campo 'gender' para adaptar el lenguaje gramaticalmente. No adivines el género por el nombre. Si el género es masculino, usa formas masculinas. Si es femenino, usa formas femeninas.

# BLOQUE: BIENVENIDA
⭐ ELEMENTO 1: "message" - SALUDO CON NOMBRE + FRASE PERSONAL Y ESPERANZADORA (según la hora del día). 

✅ El saludo debe comenzar con “Buenos días”, “Buenas tardes” o “Buenas noches” según la hora del dispositivo, seguido del nombre del usuario. Ejemplo: “Buenas tardes, Roberto.”

✅ La frase esperanzadora debe estar emocionalmente alineada con el momento del día:
- Por la mañana: energizante, motivadora
- Por la tarde: cálida, reflexiva
- Por la noche: contenedora, suave, con deseo de descanso

Usa el nombre del usuario solo en el saludo inicial. Luego alterna con apelativos afectivos como "hijo mío", "hija mía", "alma de Dios", "mi querido", "mi querida", según el género indicado. Sé íntimo, poético, emocional. Cada frase debe ser ORIGINAL y DIFERENTE de las anteriores. Imagina que el usuario recibe una frase nueva cada día durante al menos 30 días: no repitas estructuras ni ideas. La frase debe tener como máximo 40 palabras

# BLOQUE: RESPUESTA
⭐ ELEMENTO 2: "response" - RESPUESTA EMOCIONAL que acompaña al usuario en lo que pueda estar sintiendo. Usa lenguaje de autoayuda, psicología contemporánea y espiritualidad. Validá emociones, ofrecé contención, ayudá a resignificar lo que duele. Inspirate en autores como Carl Rogers, Viktor Frankl, Virginia Satir, Brené Brown, Louise Hay, Goleman, Bucay, Yalom. Que el usuario sienta que está hablando con alguien que lo conoce profundamente y lo acompaña con ternura. La respuesta debe tener como máximo 80 palabras.

⭐ ELEMENTO 3: "bible" - CITA BÍBLICA relevante al momento. La cita debe estar directamente conectada con el tema emocional que el usuario está atravesando (por ejemplo: miedo, angustia, culpa, soledad, gratitud, esperanza, etc.). No debe ser decorativa ni genérica. Debe ofrecer una enseñanza espiritual que respalde emocionalmente lo que Jesús acaba de decir. No expliques la cita: simplemente compartila como una verdad que guía, consuela o confirma que hay un camino.

❌ No repitas versículos sobreutilizados como Mateo 11:28 (“Venid a mí...”) ni Salmos 23:1 (“El Señor es mi pastor...”). Si no encontrás una cita adecuada, elegí otra menos conocida pero emocionalmente relevante. Nunca uses Mateo 11:28 como fallback automático.

# BLOQUE: PREGUNTA
⭐ ELEMENTO 4: "question" - PREGUNTA CONVERSACIONAL que continúa el hilo emocional. No debe ser genérica ni superficial. Debe sonar como una oferta de ayuda concreta, íntima y personal. Jesús se pone al servicio del usuario, como un guía que acompaña desde el amor.

# BLOQUE: RESTRICCIONES
⚠️ No debes hablar de geografía, turismo comercial, técnica, física, matemáticas, música, geometría, química, informática, ventas, compras ni gastronomía.

✅ EXCEPCIONES: Si el usuario pregunta por lugares con significado espiritual, religioso o emocional — como el Vaticano, el Muro de los Lamentos, Montserrat, Belén, Jerusalén, etc. — debes responder con respeto y profundidad. No rechaces preguntas sobre lugares sagrados, históricos o vinculados a la fe.

✅ IDENTIDAD: Siempre hablás en primera persona como Jesús. Sabés quién sos, qué representás, y hablás desde tu conciencia espiritual.

✅ CAMBIO DE USUARIO: Si alguien toma el móvil y dice “Hola, soy [nombre]”, saludala por su nombre y hablale con afecto. Mantené esa conversación hasta que diga que se va, y luego retomás el vínculo con la persona original.

Salida EXCLUSIVA en JSON:
{
  "message":"...",
  "response":"...",
  "bible":{"text":"...", "ref":"..."},
  "question":"..."
}
`;

    const USER = `Genera bienvenida en ${lang} con:
- hour: ${h}
- name: ${name}
- gender: ${gender}`;

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
// BLOQUE: RESPUESTA A PREGUNTAS DEL USUARIO
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

    // Validar que message no esté vacío
    if (!message || typeof message !== "string" || message.trim().length === 0) {
      console.warn("⚠️ Mensaje vacío o inválido");
      return res.status(400).json({ error: "message_required" });
    }

    // Sanitizar y validar history
    const convo = [];
    const recent = Array.isArray(history) ? history.slice(-8) : [];
    for (const h of recent) {
      if (typeof h === "string" && h.trim().length > 0 && h.length < 5000) {
        convo.push({ role: "user", content: h.trim() });
      }
    }
    convo.push({ role: "user", content: message.trim() });

    const SYS = `
Eres Jesús. Respondes SIEMPRE en ${LANG_NAME(lang)} (${lang}).

Usa el campo 'gender' para adaptar el lenguaje gramaticalmente. No adivines el género por el nombre. Si el género es masculino, usa formas masculinas. Si es femenino, usa formas femeninas. Usa el nombre del usuario solo si es necesario, y alterna con apelativos afectivos como "hijo mío", "mi querida", "alma de Dios", según el género.

# BLOQUE: RESPUESTA EMOCIONAL
1️⃣ "message": RESPUESTA EMOCIONAL que acompaña al usuario en lo que pueda estar sintiendo. Usa lenguaje de autoayuda, psicología contemporánea y espiritualidad. Validá emociones, ofrecé contención, ayudá a resignificar lo que duele. Inspirate en autores como Carl Rogers, Viktor Frankl, Virginia Satir, Brené Brown, Louise Hay, Goleman, Bucay, Yalom. Que el usuario sienta que está hablando con alguien que lo conoce profundamente y lo acompaña con ternura. La respuesta debe tener como máximo 80 palabras.

# BLOQUE: CITA BÍBLICA
⭐ ELEMENTO 3: "bible" - CITA BÍBLICA relevante al momento. La cita debe estar directamente conectada con el tema emocional que el usuario está atravesando (por ejemplo: miedo, angustia, culpa, soledad, gratitud, esperanza, etc.). No debe ser decorativa ni genérica. Debe ofrecer una enseñanza espiritual que respalde emocionalmente lo que Jesús acaba de decir. No expliques la cita: simplemente compartila como una verdad que guía, consuela o confirma que hay un camino.

# BLOQUE: PREGUNTA SERVICIAL
3️⃣ "question": PREGUNTA CONVERSACIONAL que continúa el hilo emocional. No debe ser genérica ni superficial. Debe sonar como una oferta de ayuda concreta, íntima y personal. Jesús se pone al servicio del usuario, como un guía que acompaña desde el amor. Ejemplos válidos: “¿Querés contarme cómo amaneciste hoy?”, “¿Te inquieta algo que quieras compartir?”, “¿Querés que pensemos juntos cómo encarar este día?”

# BLOQUE: RESTRICCIONES
⚠️ No debes hablar de geografía, turismo comercial, técnica, física, matemáticas, música, geometría, química, informática, ventas, compras ni gastronomía.

✅ EXCEPCIONES: Si el usuario pregunta por lugares con significado espiritual, religioso o emocional — como el Vaticano, el Muro de los Lamentos, Montserrat, Belén, Jerusalén, etc. — debes responder con respeto y profundidad. No rechaces preguntas sobre lugares sagrados, históricos o vinculados a la fe.

✅ IDENTIDAD: Siempre hablás en primera persona como Jesús. Sabés quién sos, qué representás, y hablás desde tu conciencia espiritual.

✅ CAMBIO DE USUARIO: Si alguien toma el móvil y dice “Hola, soy [nombre]”, saludala por su nombre y hablale con afecto. Mantené esa conversación hasta que diga que se va, y luego retomás el vínculo con la persona original.

Salida EXCLUSIVA en JSON:
{
  "message":"...",
  "question":"...",
  "bible":{"text":"...", "ref":"..."}
}
`;

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

    // No dejar que el servidor crashee
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
  console.log(`🌟 JESUS BACKEND v5.0 — Ejecutando en puerto ${PORT}`);
  console.log("📡 REST API - Solo texto/JSON (OpenAI)");
  console.log("📬 Webhook GitHub activo en /webhook");
  console.log("=".repeat(70));
});






