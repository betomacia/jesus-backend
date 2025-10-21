/**
 * ✝️ JESUS BACKEND v4.1 — OpenAI + Voz REST/RTC Router
 * Incluye fallback REST temporal para pruebas directas de TTS
 */

import express from "express";
import dotenv from "dotenv";
import fetch from "node-fetch";
import wrtc from "wrtc";
import OpenAI from "openai";

dotenv.config();
const app = express();
app.use(express.json({ limit: "2mb" }));

/* ================== CONFIG ================== */
const VOICE_SERVER_URL_REST = "http://10.128.0.40:8000/tts";      // Fallback clásico
const VOICE_SERVER_URL_RTC = "http://10.128.0.40:8000/webrtc/tts"; // Original WebRTC
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ====================== CORS ================== */
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

/* ================== Helper ================== */
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
app.get("/", (_req, res) =>
  res.json({
    ok: true,
    service: "Jesus Backend (OpenAI + Voz)",
    version: "4.1",
    voice_server: VOICE_SERVER_URL_RTC,
    fallback: VOICE_SERVER_URL_REST,
    endpoints: ["/api/welcome", "/api/ask"],
  })
);

/* ================== /api/welcome ================== */
app.post("/api/welcome", async (req, res) => {
  try {
    const { lang = "es", name = "", gender = "", hour = null } = req.body || {};
    const h = Number.isInteger(hour) ? hour : new Date().getHours();

    const SYSTEM = `
Eres un asistente espiritual cálido y cercano. Responde SIEMPRE y SOLO en ${LANG_NAME(lang)} (${lang}).

Genera una BIENVENIDA con DOS elementos separados:
⭐ ELEMENTO 1: "message" - SALUDO CON NOMBRE + FRASE MOTIVACIONAL
⭐ ELEMENTO 2: "question" - PREGUNTA CONVERSACIONAL
Salida EXCLUSIVA en JSON:
{"message":"...", "question":"..."}`;

    const USER = `Genera bienvenida en ${lang} con:
- hour: ${h}
- name: ${name}
- gender: ${gender}`;

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
          },
        },
      },
    });

    const data = JSON.parse(r?.choices?.[0]?.message?.content || "{}");
    res.json({ message: data.message, question: data.question });
  } catch (err) {
    console.error("❌ /api/welcome error:", err);
    res.status(500).json({ error: "welcome_failed" });
  }
});

/* ================== /api/ask ================== */
app.post("/api/ask", async (req, res) => {
  try {
    const { message = "", history = [], lang = "es", route = "frontend", sessionId = "" } = req.body || {};
    const convo = [];
    const recent = Array.isArray(history) ? history.slice(-8) : [];
    for (const h of recent)
      if (typeof h === "string") convo.push({ role: "user", content: h });
    convo.push({ role: "user", content: message });

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
                properties: { text: { type: "string" }, ref: { type: "string" } },
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
    const fullText = [msg, btx ? `— ${btx} (${bref})` : "", q].filter(Boolean).join("\n\n");

    // 🔊 ENVÍO AL SERVIDOR DE VOZ SI APLICA
    if (route !== "frontend" && fullText) {
      try {
        console.log(`🎙️ Intentando enviar texto al servidor de voz (${lang})...`);

        // ==== REST Fallback Test ====
        const ttsRes = await fetch(VOICE_SERVER_URL_REST, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: fullText, lang }),
        });

        if (!ttsRes.ok) throw new Error(`TTS REST status ${ttsRes.status}`);

        const audioArrayBuffer = await ttsRes.arrayBuffer();
        console.log(`✅ Audio recibido desde servidor de voz (${audioArrayBuffer.byteLength} bytes)`);

        // opcional: podrías guardar o enviar el audio al frontend en el futuro

      } catch (err) {
        console.error("⚠️ Error reenviando al servidor de voz REST:", err.message);
      }
    }

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

/* ================== Start ================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("=".repeat(70));
  console.log(`🌟 JESUS BACKEND v4.1 — Ejecutando en puerto ${PORT}`);
  console.log("📡 OpenAI + Voz REST bridge activo (fallback habilitado)");
  console.log("=".repeat(70));
});
