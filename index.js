// index.js — Backend Google Cloud (OpenAI + Voz Forward)
const express = require("express");
const OpenAI = require("openai");
require("dotenv").config();

const app = express();

/* ================== CORS ================== */
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

app.use((req, res, next) => {
  setCors(res);
  next();
});
app.options("*", (req, res) => {
  setCors(res);
  return res.status(204).end();
});
app.use(express.json());

/* ================== OpenAI Setup ================== */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
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

/* ================== Health Check ================== */
app.get("/", (_req, res) => {
  setCors(res);
  res.json({
    ok: true,
    service: "Jesus Backend (OpenAI + Voz Forward)",
    version: "3.1",
    ts: Date.now(),
    endpoints: ["/api/welcome", "/api/ask"],
  });
});

/* ================== /api/welcome ================== */
app.post("/api/welcome", async (req, res, next) => {
  try {
    const { lang = "es", name = "", gender = "", hour = null } = req.body || {};
    const h = Number.isInteger(hour) ? hour : new Date().getHours();

    const SYSTEM = `
Eres un asistente espiritual cálido y cercano. Responde SIEMPRE y SOLO en ${LANG_NAME(lang)} (${lang}).

Genera una BIENVENIDA con DOS elementos separados:

⭐ ELEMENTO 1: "message" - SALUDO CON NOMBRE + FRASE MOTIVACIONAL POTENTE
⭐ ELEMENTO 2: "question" - PREGUNTA CONVERSACIONAL

Salida EXCLUSIVA en JSON:
{"message":"saludo+nombre punto + frase","question":"pregunta conversacional"}`.trim();

    const USER = `Genera bienvenida en ${lang} con:\n- hour: ${h}\n- name: ${String(
      name || ""
    ).trim()}\n- gender: ${String(gender || "").trim()}`;

    const r = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.9,
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
            additionalProperties: false,
          },
        },
      },
    });

    let data = {};
    try {
      data = JSON.parse(r?.choices?.[0]?.message?.content || "{}");
    } catch {}
    const message = String(data?.message || "").trim();
    const question = String(data?.question || "").trim();
    if (!message || !question)
      return res.status(502).json({ error: "bad_openai_output" });

    setCors(res);
    res.json({ message, question });
  } catch (e) {
    next(e);
  }
});

/* ================== /api/ask ================== */
app.post("/api/ask", async (req, res, next) => {
  try {
    const {
      message = "",
      history = [],
      lang = "es",
      route = "frontend",
      sessionId = "",
    } = req.body || {};
    const userTxt = String(message || "").trim();

    const convo = [];
    const recent = Array.isArray(history) ? history.slice(-8) : [];
    for (const h of recent)
      if (typeof h === "string") convo.push({ role: "user", content: h });
    convo.push({ role: "user", content: userTxt });

    const SYS = `Eres Dios. Responde SIEMPRE en ${LANG_NAME(lang)} (${lang}).`;

    const r = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.75,
      max_tokens: 350,
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
            additionalProperties: false,
          },
        },
      },
    });

    let data = {};
    try {
      data = JSON.parse(r?.choices?.[0]?.message?.content || "{}");
    } catch {}

    const msg = String(data?.message || "").trim();
    const q = String(data?.question || "").trim();
    const btx = String(data?.bible?.text || "").trim();
    const bref = String(data?.bible?.ref || "").trim();

    if (!msg || !q)
      return res.status(502).json({ error: "bad_openai_output" });

    /* 🔊 Reenvío al servidor de voz */
    try {
      const payload = {
        text: [msg, q].filter(Boolean).join("\n\n"),
        lang,
        route,
        sessionId,
      };

      const WebSocket = require("ws");
      const ws = new WebSocket("wss://voz.movilive.es/ws/tts");

      ws.on("open", () => {
        ws.send(JSON.stringify(payload));
        console.log(
          `📤 Enviado al servidor de voz: route=${route}, sessionId=${
            sessionId || "N/A"
          }`
        );
        ws.close();
      });

      ws.on("error", (err) => {
        console.error("⚠️ Error WS voz:", err.message);
      });
    } catch (err) {
      console.error("⚠️ Error reenviando al servidor de voz:", err.message);
    }

    setCors(res);
    res.json({
      message: msg,
      question: q,
      bible: { text: btx, ref: bref },
      route,
      sessionId,
    });
  } catch (e) {
    next(e);
  }
});

/* ================== 404 Handler ================== */
app.use((req, res) => {
  setCors(res);
  res.status(404).json({ error: "not_found" });
});

/* ================== Error Handler ================== */
app.use((err, req, res, _next) => {
  console.error("SERVER ERROR:", err);
  setCors(res);
  res.status(502).json({
    error: "server_error",
    detail: String(err?.message || "unknown"),
  });
});

/* ================== Start Server ================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("\n" + "=".repeat(70));
  console.log("✅ Jesus Backend (OpenAI + Voz Forward)");
  console.log("🚀 Puerto: " + PORT);
  console.log("📋 Endpoints: POST /api/welcome, POST /api/ask, GET /");
  console.log("=".repeat(70));
});
