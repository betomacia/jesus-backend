const express = require("express");
const OpenAI = require("openai");
require("dotenv").config();

const app = express();

/* ===== CORS básico ===== */
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept",
  "Access-Control-Max-Age": "600",
  "Content-Type": "application/json; charset=utf-8",
};
function setCors(res) { for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v); }
app.use((req, res, next) => { setCors(res); if (req.method === "OPTIONS") return res.status(204).end(); next(); });

/* ===== JSON parser ===== */
app.use(express.json());

/* ===== Health ===== */
app.get("/", (_req, res) => { setCors(res); res.json({ ok: true, service: "backend", ts: Date.now() }); });

/* ===== OpenAI client ===== */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ===== Helpers mínimos ===== */
const LANG_NAME = (l = "es") => ({
  es: "español", en: "English", pt: "português", it: "italiano",
  de: "Deutsch", ca: "català", fr: "français",
}[l] || "español");

/* =========================================================================
   /api/welcome — SIEMPRE OpenAI (JSON Schema), sin fallback local
   ========================================================================= */
app.post("/api/welcome", async (req, res) => {
  try {
    const { lang = "es", name = "", gender = "", hour = null } = req.body || {};
    const h = Number.isInteger(hour) ? hour : new Date().getHours();

    const SYSTEM = `
Eres un asistente espiritual cálido y cercano. Siempre responde SOLO en ${LANG_NAME(lang)} (${lang}).
Genera una BIENVENIDA con:
1) Saludo por hora ({{hour}}) y usa el nombre ({{name}}) si viene; matiza con {{gender}} ("male"/"female") solo si suena natural.
2) UNA sola frase motivadora/espiritual breve y original (sin clichés ni repeticiones).
3) UNA pregunta breve y abierta para iniciar conversación.
No incluyas nada fuera de JSON. Salida EXACTA:
{"message":"saludo + frase","question":"pregunta"}
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
        { role: "system", content: SYSTEM.replace(/{{hour}}/g, String(h)).replace(/{{name}}/g, String(name || "")).replace(/{{gender}}/g, String(gender || "")) },
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
    if (!message || !question) return res.status(502).json({ error: "bad_openai_output" });

    setCors(res);
    res.json({ message, question });
  } catch (e) {
    console.error("WELCOME ERROR:", e);
    setCors(res);
    res.status(502).json({ error: "openai_failed" });
  }
});

/* =========================================================================
   /api/ask — SIEMPRE OpenAI (JSON Schema), sin fallbacks, sin texto fijo
   ========================================================================= */
app.post("/api/ask", async (req, res) => {
  try {
    const { message = "", history = [], lang = "es", userId = "anon" } = req.body || {};
    const userTxt = String(message || "").trim();

    // Construcción de conversación (solo pasamos strings previos tal cual)
    const convo = [];
    const recent = Array.isArray(history) ? history.slice(-8) : [];
    for (const h of recent) if (typeof h === "string") convo.push({ role: "user", content: h });
    convo.push({ role: "user", content: userTxt });

    const SYS = `
Eres cercano, claro y compasivo; voz cristiana (católica). Responde SIEMPRE y SOLO en ${LANG_NAME(lang)} (${lang}).
Alcance: espiritualidad/fe, sanación personal, relaciones y emociones. Si el usuario se va a temas ajenos (deportes, entretenimiento, técnica, política, gastronomía, trivia), redirígelo con suavidad al plano interior y a lo que le pasa por dentro, SIN dar datos externos.
Varía el lenguaje; evita muletillas. Da pasos concretos cuando proceda. Cierra con **UNA** pregunta breve y útil.
Incluye SIEMPRE una cita bíblica pertinente distinta de Mateo/Matthew 11:28 (evítala en cualquier idioma). Si el usuario rechaza Biblia, respeta y omite, pero igual devuelve el objeto con texto vacío.
SALIDA EXCLUSIVA en JSON, EXACTAMENTE así:
{"message":"...", "question":"...?", "bible":{"text":"...","ref":"Libro 0:0"}}
`.trim();

    const r = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.6,
      max_tokens: 420,
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
                  ref:  { type: "string" }
                },
                required: ["text", "ref"],
              },
            },
            required: ["message", "question", "bible"],
            additionalProperties: false,
          },
        },
      },
    });

    let data = {};
    try { data = JSON.parse(r?.choices?.[0]?.message?.content || "{}"); } catch {}

    // No generamos nada local: si falta algo, devolvemos error (para mantener 100% OpenAI)
    const msg = String(data?.message || "").trim();
    const q   = String(data?.question || "").trim();
    const btx = String(data?.bible?.text || "").trim();
    const bref= String(data?.bible?.ref  || "").trim();

    if (!msg || !q || !btx || !bref) {
      setCors(res);
      return res.status(502).json({ error: "bad_openai_output" });
    }

    setCors(res);
    res.json({ message: msg, question: q, bible: { text: btx, ref: bref } });
  } catch (e) {
    console.error("ASK ERROR:", e);
    setCors(res);
    res.status(502).json({ error: "openai_failed" });
  }
});

/* ===== Start ===== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Backend listo en puerto ${PORT}`));
