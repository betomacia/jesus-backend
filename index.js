// index.js — CORS blindado + OpenAI (welcome/ask)

const express = require("express");
const OpenAI = require("openai");
require("dotenv").config();

const app = express();

/* ========== CORS (DEBE IR *ANTES* DE TODO) ========== */
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",                // FE usa credentials:'omit'
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept",
  "Access-Control-Max-Age": "600",
};
function setCors(res) {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
}
app.use((req, res, next) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end(); // ← preflight OK
  next();
});
/* ===================================================== */

app.use(express.json());

// Health
app.get("/", (req, res) => {
  setCors(res);
  res.json({ ok: true, ts: Date.now() });
});

// OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ===== /api/welcome =====
   Saludo por hora + 1 frase motivacional + 1 pregunta (todo desde OpenAI) */
app.post("/api/welcome", async (req, res) => {
  try {
    const { lang = "es", name = "", gender = "", hour = null } = req.body || {};
    const h = Number.isInteger(hour) ? hour : new Date().getHours();

    const SYSTEM = `
Eres un asistente espiritual cálido y cercano. Genera una BIENVENIDA en {{lang}} con:
1) Saludo por hora ({{hour}}) y usa el nombre ({{name}}) si viene; matiza con {{gender}} ("male"/"female") solo si suena natural.
2) UNA sola frase motivadora/espiritual breve y original para arrancar el día (gratitud, esperanza, acción desde el presente, mindfulness, fortaleza interior/psicología positiva). Varía el lenguaje; evita clichés.
3) UNA pregunta breve y abierta para iniciar conversación.
Salida SOLO JSON:
{"message":"saludo + frase ({{lang}})","question":"pregunta ({{lang}})"}
`.trim();

    const USER = `
Genera bienvenida en ${lang} con:
- hour: ${h}
- name: ${String(name || "").trim()}
- gender: ${String(gender || "").trim()}
`.trim();

    const r = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.7,
      max_tokens: 220,
      messages: [
        { role: "system", content: SYSTEM.replace(/{{lang}}/g, lang) },
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
            additionalProperties: false,
          },
        },
      },
    });

    let data = {};
    try { data = JSON.parse(r?.choices?.[0]?.message?.content || "{}"); } catch {}
    const message = String(data?.message || "").trim();
    const question = String(data?.question || "").trim();
    setCors(res);
    if (!message || !question) return res.status(502).json({ error: "bad_openai_output" });
    res.json({ message, question });
  } catch (e) {
    console.error("WELCOME ERROR:", e);
    setCors(res);
    res.status(500).json({ error: "welcome_failed" });
  }
});

/* ===== /api/ask =====
   Respuesta + (opcional) biblia + 1 pregunta */
app.post("/api/ask", async (req, res) => {
  try {
    const { message = "", history = [], lang = "es" } = req.body || {};
    const SYS = `
Eres cercano, claro y compasivo (voz cristiana). Alcance: fe/espiritualidad, autoayuda, emociones/relaciones.
UNA sola pregunta breve. Salida JSON: {"message":"...", "question":"...?", "bible":{"text":"...","ref":"Libro 0:0"}}.
`.trim();

    const convo = [];
    const recent = Array.isArray(history) ? history.slice(-8) : [];
    for (const h of recent) if (typeof h === "string") convo.push({ role: "user", content: h });
    convo.push({ role: "user", content: String(message || "").trim() });

    const r = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.6,
      max_tokens: 360,
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
                properties: { text: { type: "string" }, ref: { type: "string" } },
                required: ["text", "ref"]
              }
            },
            required: ["message"],
            additionalProperties: true
          }
        }
      }
    });

    let data = {};
    try { data = JSON.parse(r?.choices?.[0]?.message?.content || "{}"); } catch {}
    setCors(res);
    res.json({
      message: String(data?.message || "").trim() || (lang === "en" ? "I'm with you." : "Estoy contigo."),
      question: String(data?.question || "").trim() || "",
      bible: (data?.bible && data.bible.text && data.bible.ref) ? data.bible : undefined
    });
  } catch (e) {
    console.error("ASK ERROR:", e);
    setCors(res);
    res.json({
      message: "La paz sea contigo. Contame en pocas palabras qué está pasando.",
      question: "¿Qué te gustaría trabajar primero?"
    });
  }
});

/* ===== Start ===== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Backend listo en puerto ${PORT}`));
