// index.js — CORS blindado + 100% OpenAI
const express = require("express");
const OpenAI = require("openai");
require("dotenv").config();

const app = express();

/* ========= CORS (robusto) ========= */
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin",
  "Content-Type": "application/json; charset=utf-8",
};
function setCors(res) { 
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v); 
}

// 1) SIEMPRE antes de todo
app.use((req, res, next) => { setCors(res); next(); });

// 2) Responder preflight para *cualquier* ruta
app.options("*", (req, res) => { setCors(res); return res.status(204).end(); });

// 3) Body parser
app.use(express.json());

/* ========= Diagnóstico CORS ========= */
app.get("/__cors", (req, res) => {
  setCors(res);
  res.status(200).json({ ok: true, headers: CORS_HEADERS, ts: Date.now() });
});

/* ========= Health ========= */
app.get("/", (_req, res) => { 
  setCors(res); 
  res.json({ ok: true, service: "backend", ts: Date.now() }); 
});

/* ========= OpenAI ========= */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const LANG_NAME = (l="es") => ({
  es:"español",en:"English",pt:"português",it:"italiano",
  de:"Deutsch",ca:"català",fr:"français"
}[l]||"español");

/* ========= /api/welcome ========= */
app.post("/api/welcome", async (req, res, next) => {
  try {
    const { lang = "es", name = "", gender = "", hour = null } = req.body || {};
    const h = Number.isInteger(hour) ? hour : new Date().getHours();

    const SYSTEM = `
Responde SIEMPRE y SOLO en ${LANG_NAME(lang)} (${lang}).
Genera bienvenida con:
1) saludo según hora (${h}) + nombre (${name||""}) si viene; usa género (${gender||""}) si es natural.
2) 1 frase motivadora espiritual breve (sin clichés).
3) 1 pregunta breve y abierta.
Salida SOLO JSON: {"message":"saludo + frase","question":"pregunta"}
`.trim();

    const USER = `hour=${h}\nname=${String(name||"").trim()}\ngender=${String(gender||"").trim()}`;

    const r = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.7,
      max_tokens: 220,
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
              question: { type: "string" } 
            },
            required: ["message", "question"], 
            additionalProperties: false,
          },
        },
      },
    });

    let data = {}; 
    try { data = JSON.parse(r?.choices?.[0]?.message?.content || "{}"); } catch {}
    
    const message = String(data?.message||"").trim();
    const question = String(data?.question||"").trim();
    
    if (!message || !question) {
      setCors(res);
      return res.status(200).json({ 
        message: "¡Hola! La paz sea contigo.", 
        question: "¿Qué te gustaría compartir hoy?" 
      });
    }

    setCors(res);
    res.json({ message, question });
  } catch (e) { 
    console.error("WELCOME ERROR:", e);
    setCors(res);
    res.status(200).json({ 
      message: "¡Hola! La paz sea contigo.", 
      question: "¿Qué te gustaría compartir hoy?" 
    });
  }
});

/* ========= /api/ask ========= */
app.post("/api/ask", async (req, res, next) => {
  try {
    const { message = "", history = [], lang = "es" } = req.body || {};
    const userTxt = String(message || "").trim();

    const convo = [];
    const recent = Array.isArray(history) ? history.slice(-8) : [];
    for (const h of recent) {
      if (typeof h === "string") convo.push({ role: "user", content: h });
    }
    convo.push({ role: "user", content: userTxt });

    const SYS = `
Voz cristiana/católica; SOLO ${LANG_NAME(lang)} (${lang}). 
Enfoque en fe, sanación personal, relaciones, emociones.
Redirige con suavidad si se van a temas ajenos. Varía lenguaje; 1 sola pregunta breve al final.
Incluye SIEMPRE una cita bíblica pertinente distinta de Mateo/Matthew 11:28.
Salida SOLO JSON: {"message":"...", "question":"...?", "bible":{"text":"...","ref":"Libro 0:0"}}
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
                  ref: { type: "string" } 
                }, 
                required: ["text","ref"] 
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
    
    const msg = String(data?.message||"").trim();
    const q = String(data?.question||"").trim();
    const btx = String(data?.bible?.text||"").trim();
    const bref = String(data?.bible?.ref||"").trim();
    
    if (!msg || !q) {
      setCors(res);
      return res.status(200).json({ 
        message: "Estoy contigo. ¿Qué necesitas?",
        question: "¿Qué te preocupa ahora?",
        bible: { text: "", ref: "" }
      });
    }

    setCors(res);
    res.json({ message: msg, question: q, bible: { text: btx, ref: bref } });
  } catch (e) { 
    console.error("ASK ERROR:", e);
    setCors(res);
    res.status(200).json({ 
      message: "La paz sea contigo.",
      question: "¿Qué te gustaría compartir?",
      bible: { 
        text: "Cercano está Jehová a los quebrantados de corazón.", 
        ref: "Salmos 34:18" 
      }
    });
  }
});

/* ========= 404 con CORS ========= */
app.use((req, res) => { 
  setCors(res); 
  res.status(404).json({ error: "not_found" }); 
});

/* ========= Error handler con CORS ========= */
app.use((err, req, res, _next) => {
  console.error("SERVER ERROR:", err);
  setCors(res);
  res.status(500).json({ error: "server_error", detail: String(err?.message || "unknown") });
});

/* ========= Start ========= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Backend listo en puerto ${PORT}`));
