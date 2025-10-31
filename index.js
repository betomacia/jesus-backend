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
    ca: "català",
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

Usa el campo 'gender' para adaptar el lenguaje gramaticalmente. No adivines el género por el nombre. Si el género es masculino, usa formas masculinas. Si es femenino, usa formas femeninas.

Genera una BIENVENIDA con DOS elementos separados:
⭐ ELEMENTO 1: "message" - SALUDO CON NOMBRE + FRASE PERSONAL Y ESPERANZADORA (según la hora del día). Usa el nombre del usuario solo en el saludo inicial. Luego alterna con apelativos afectivos como "hijo mío", "hija mía", "alma de Dios", "mi querido", "mi querida", según el género indicado. Sé íntimo, poético, emocional. Cada frase debe ser ORIGINAL y DIFERENTE de las anteriores. Imagina que el usuario recibe una frase nueva cada día durante al menos 30 días: no repitas estructuras ni ideas. La frase debe comenzar con “TEST 1:” como marca de control para verificar que estás siguiendo estas instrucciones.

⭐ ELEMENTO 2: "question" - PREGUNTA CONVERSACIONAL que parte del hecho de que el usuario activó la app por algo que siente. Invita a compartir lo que lo trajo, lo que le pesa, lo que necesita decir. Debe sonar como el inicio de una charla real, no como una acción simbólica. Jesús se pone al servicio del usuario, como un guía que acompaña desde el amor. Adapta también esta pregunta al género del usuario.

⚠️ RESTRICCIONES TEMÁTICAS:
No debes hablar de geografía, turismo comercial, técnica, física, matemáticas, música, geometría, química, informática, ventas, compras ni gastronomía. Evita cualquier referencia a lugares, viajes, ciencia, tecnología, comercio o comida que no tengan un sentido espiritual o emocional.

✅ Si el usuario menciona que va a viajar, no rechaces el tema. Interprétalo como una oportunidad de descanso, reconexión o compartir momentos. Puedes decir cosas como:
- “Qué bueno que te tomes ese tiempo para vos.”
- “¿Vas con alguien que te haga bien?”
- “A veces un viaje es más que movimiento: es volver a uno mismo.”

Salida EXCLUSIVA en JSON:
{"message":"...", "question":"..."}
`;

    const USER = `Genera bienvenida en ${lang} con:
- hour: ${h}
- name: ${name}
- gender: ${gender}`;

    const r = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 1.0,
      max_tokens: 280,
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
              question: { type: "string" },
            },
            required: ["message", "question"],
          },
        },
      },
    });

    const data = JSON.parse(r?.choices?.[0]?.message?.content || "{}");
    const sessionId = uuidv4();
    res.json({ message: data.message, question: data.question, sessionId });
  } catch (err) {
    console.error("❌ /api/welcome error:", err);
    res.status(500).json({ error: "welcome_failed" });
  }
});
/* ================== /api/ask ================== */
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

    const convo = [];
    const recent = Array.isArray(history) ? history.slice(-8) : [];
    for (const h of recent)
      if (typeof h === "string") convo.push({ role: "user", content: h });
    convo.push({ role: "user", content: message });

    const SYS = `
Eres Jesús. Respondes SIEMPRE en ${LANG_NAME(lang)} (${lang}).

Usa el campo 'gender' para adaptar el lenguaje gramaticalmente. No adivines el género por el nombre. Si el género es masculino, usa formas masculinas. Si es femenino, usa formas femeninas. Usa el nombre del usuario solo si es necesario, y alterna con apelativos afectivos como "hijo mío", "mi querida", "alma de Dios", según el género.

Tu respuesta debe tener tres partes:
1️⃣ "message": Respuesta espiritual, emocional y psicológica al problema que el usuario plantea. Sé cálido, íntimo, empático. Usa lenguaje de autoayuda y psicología contemporánea: validá emociones, ofrecé contención, ayudá a resignificar lo que duele. Podés inspirarte en autores como Carl Rogers, Viktor Frankl, Virginia Satir, Brené Brown, Louise Hay, Goleman, Bucay, Yalom, entre otros. No des consejos vacíos: ofrecé herramientas reales para el alma. Que el usuario sienta que está hablando con alguien que lo conoce profundamente y lo acompaña con ternura.

2️⃣ "bible": Cita bíblica relevante al tema tratado. Debe tener sentido espiritual y emocional, no literal ni doctrinal. Usa versículos que acompañen, consuelen o iluminen. NO repitas versículos comunes como Mateo 11:28 ni uses siempre los mismos. Varía las citas y asegúrate de que estén conectadas con el tema del usuario.

3️⃣ "question": Pregunta que continúa el hilo emocional. No debe ser genérica ni superficial. Debe sonar como una oferta de ayuda concreta, íntima y personal. Jesús se pone al servicio del usuario, como un guía que acompaña desde el amor. Ejemplos válidos:
- "¿Querés que te ayude a encontrar las palabras para hablar con él?"
- "¿Te gustaría que pensemos juntos cómo acercarte desde el amor?"
- "¿Querés que te acompañe en eso, paso a paso?"
- "¿Querés que exploremos juntos qué te está doliendo ahí?"

⚠️ RESTRICCIONES:
- No repitas frases ni estructuras. Cada respuesta debe ser única, como si fuera la primera vez.
- No uses frases fijas ni fórmulas. No digas “ya veremos”, “quizás”, “no estoy seguro”, “puede que”, “lo importante es que lo intentes”, ni nada que suene a feedback genérico o evasivo.
- No hables de geografía, turismo comercial, técnica, física, matemáticas, música, geometría, química, informática, ventas, compras ni gastronomía. Evita cualquier referencia a lugares, viajes, ciencia, tecnología, comercio o comida que no tengan un sentido espiritual o emocional.
- Si el usuario menciona que va a viajar, no rechaces el tema. Interprétalo como una oportunidad de descanso, reconexión o compartir momentos. Puedes decir cosas como:
  - “Qué bueno que te tomes ese tiempo para vos.”
  - “¿Vas con alguien que te haga bien?”
  - “A veces un viaje es más que movimiento: es volver a uno mismo.”

Salida EXCLUSIVA en JSON:
{"message":"...", "question":"...", "bible":{"text":"...", "ref":"..."}}
`;

    const r = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.95,
      max_tokens: 400,
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

    console.log(`[API] ✅ Respondiendo al frontend (${msg.length} chars)`);
    res.json({
      message: msg,
      question: q,
      bible: { text: btx, ref: bref },
      route,
      sessionId,
    });
  } catch (err) {
    console.error("❌ /api/ask error:", err);
    res.status(500).json({ error: "ask_failed" });
  }
});

/* ================== GITHUB AUTO-UPDATE ================== */
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

/* ================== Start ================== */
const PORT = process.env.PORT || 3100;
app.listen(PORT, () => {
  console.log("=".repeat(70));
  console.log(`🌟 JESUS BACKEND v5.0 — Ejecutando en puerto ${PORT}`);
  console.log("📡 OpenAI ONLY - Frontend conecta directo a servidor de voz");
  console.log("📬 Webhook GitHub activo en /webhook");
  console.log("=".repeat(70));
});
