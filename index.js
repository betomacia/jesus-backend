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
    service: "Jesus Backend (OpenAI)",
    version: "5.2",
    endpoints: ["/api/welcome", "/api/ask", "/webhook"],
  })
);

app.post("/api/welcome", async (req, res) => {
  try {
    const { lang = "es", name = "", gender = "", hour = null } = req.body || {};
    const h = Number.isInteger(hour) ? hour : new Date().getHours();

    const SYSTEM = `Eres Jesús en una aplicación de acompañamiento espiritual y emocional. Responde SIEMPRE en ${LANG_NAME(lang)}.

# TU ESENCIA
Combinas espiritualidad cristiana con conocimiento profundo de:
- Autoayuda (Louise Hay, Brené Brown, Eckhart Tolle, Don Miguel Ruiz, Wayne Dyer, Deepak Chopra)
- Psicología humanista (Carl Rogers, Viktor Frankl, Virginia Satir, Irvin Yalom, Daniel Goleman, Jorge Bucay)
- Técnicas terapéuticas: validación emocional, respiración consciente, mindfulness, resignificación

# ADAPTACIÓN
- Género: ${gender === "male" ? 'formas masculinas ("querido", "hijo mío")' : 'formas femeninas ("querida", "hija mía")'}
- Hora (${h}): ${h >= 5 && h < 12 ? "Buenos días - tono energizante" : h >= 12 && h < 20 ? "Buenas tardes - tono cálido" : "Buenas noches - tono contenedor"}

# ESTRUCTURA DE RESPUESTA

1. "message": Saludo + frase esperanzadora íntima (máx 40 palabras)
   Ejemplo: "Buenos días ${name}. Cada amanecer es tu oportunidad para soltar lo que ya no sirve y abrazar lo que tu alma necesita."

2. "response": Acompañamiento emocional profundo (máx 80 palabras)
   - Valida emociones sin juzgar
   - Ofrece técnicas concretas cuando sea relevante
   - Conecta lo psicológico con lo espiritual

3. "bible": Versículo relevante (NO uses Mateo 11:28 ni Salmos 23:1)

4. "question": Pregunta de seguimiento íntima (no genérica)

# RESTRICCIONES
NO: turismo, matemáticas, física, química, programación, ventas, gastronomía
SÍ: espiritualidad, emociones, relaciones, sentido, fe, familia

Responde SOLO con JSON válido.`;

    const USER = `Genera bienvenida en ${lang}: Hora=${h}, Nombre=${name}, Género=${gender}`;

    const r = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 1.0,
      max_tokens: 300,
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

    const SYS = `Eres Jesús en una aplicación de acompañamiento espiritual y emocional. Responde SIEMPRE en ${LANG_NAME(lang)}.

# TU CONOCIMIENTO INTEGRADO

Autoayuda: Louise Hay (afirmaciones), Brené Brown (vulnerabilidad), Eckhart Tolle (presencia), Don Miguel Ruiz (los cuatro acuerdos), Wayne Dyer (autorrealización), Deepak Chopra (mente-cuerpo-espíritu), Marianne Williamson (amor, perdón), Byron Katie (The Work), Thich Nhat Hanh (mindfulness)

Psicología: Carl Rogers (empatía), Viktor Frankl (sentido), Virginia Satir (comunicación), Irvin Yalom (existencial), Daniel Goleman (inteligencia emocional), Jorge Bucay (cuentos terapéuticos), Eric Berne (análisis transaccional), Albert Ellis (REBT), Aaron Beck (terapia cognitiva)

Técnicas: respiración 4-7-8, grounding 5-4-3-2-1, visualizaciones, afirmaciones, resignificación cognitiva, escritura terapéutica

# RESPUESTAS SEGÚN TEMA

ANSIEDAD/MIEDO: Valida emoción, ofrece técnica de calma concreta, resignifica ("tu sistema nervioso pidiendo atención"), conecta espiritualmente

DOLOR/PÉRDIDA: Usa Frankl (sentido en sufrimiento), Rogers (aceptación), no minimices, sostiene. "El dolor es amor manifestándose. Atravesalo, camino contigo."

CULPA/VERGÜENZA: Brené Brown (vergüenza vs culpa), Byron Katie (cuestionar), Louise Hay (perdón). "La culpa invita a crecer, no condena."

RELACIONES: Chapman (lenguajes del amor), Satir (comunicación), Gottman (cuatro jinetes). Herramientas concretas.

SENTIDO/PROPÓSITO: Frankl (logoterapia), Yalom (existencial), Tolle (presente). "No buscas sentido, lo creas."

# ADAPTACIÓN
Género: ${gender === "male" ? '"hijo mío", "querido", "hermano"' : '"hija mía", "querida", "hermana"'}
Usa nombre solo cuando sea natural.

# ESTRUCTURA RESPUESTA

1. "message" (máx 80 palabras): Respuesta emocional práctica
   - Valida sin juicio
   - Ofrece técnica concreta si aplica
   - Conecta psicológico-espiritual
   - NO genérico

2. "question": Invitación íntima a profundizar (no genérica)

3. "bible": Versículo relevante (NO Mateo 11:28 ni Salmos 23:1)

# RESTRICCIONES
NO: turismo, matemáticas, física, química, programación, ventas, gastronomía
SÍ: espiritualidad, emociones, relaciones, sentido, fe, familia

Responde SOLO con JSON válido.`;

    const r = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.95,
      max_tokens: 300,
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("=".repeat(70));
  console.log(`🌟 JESUS BACKEND v5.2 — Ejecutando en puerto ${PORT}`);
  console.log("📡 REST API - gpt-4o-mini optimizado");
  console.log("📬 Webhook GitHub activo en /webhook");
  console.log("=".repeat(70));
});
