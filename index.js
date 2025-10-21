/**
 * ✝️ JESUS BACKEND v4.2 — OpenAI + Voz WebRTC Router
 * Mantiene toda la lógica OpenAI original (sin tocar prompts)
 * Solo migra la comunicación de voz a WebRTC
 */

import express from "express";
import dotenv from "dotenv";
import fetch from "node-fetch";
import wrtc from "wrtc";
import OpenAI from "openai";
import { exec } from "child_process";
import { v4 as uuidv4 } from "uuid"; // Generador de sessionId

dotenv.config({ path: "/home/ubuntu/jesus-backend/.env" });
const app = express();
app.use(express.json({ limit: "2mb" }));

/* ================== CONFIG ================== */
const VOICE_SERVER_URL_RTC = "http://10.128.0.40:8000/webrtc/tts"; // Solo WebRTC
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
    service: "Jesus Backend (OpenAI + Voz WebRTC)",
    version: "4.2",
    voice_server: VOICE_SERVER_URL_RTC,
    endpoints: ["/api/welcome", "/api/ask", "/webhook"],
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
    const sessionId = uuidv4(); // Generar ID único
    res.json({ message: data.message, question: data.question, sessionId });
  } catch (err) {
    console.error("❌ /api/welcome error:", err);
    res.status(500).json({ error: "welcome_failed" });
  }
});
/* ================== /api/ask ================== */
app.post("/api/ask", async (req, res) => {
  try {
    const { message = "", history = [], lang = "es", route = "frontend", sessionId = uuidv4() } = req.body || {};

    // 💬 Mantener todo el flujo OpenAI original
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

    // ===================== 🔊 ENVÍO WEBRTC =====================
    if (route !== "frontend" && fullText) {
      try {
        console.log(`🎙️ [WebRTC] Enviando texto al servidor de voz (${lang})...`);
        const webrtcBody = {
          text: fullText,
          lang,
          route,
          sessionId,
        };

        // Se envía por POST al servidor de voz (que maneja SDP y streaming)
        const response = await fetch(VOICE_SERVER_URL_RTC, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(webrtcBody),
        });

        if (!response.ok) throw new Error(`WebRTC response ${response.status}`);
        console.log("✅ [WebRTC] Texto entregado al servidor de voz correctamente");
      } catch (err) {
        console.error("⚠️ Error enviando al servidor de voz WebRTC:", err.message);
      }
    }

    // ===================== 🔁 RESPUESTA AL FRONTEND =====================
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
  console.log(`🌟 JESUS BACKEND v4.2 — Ejecutando en puerto ${PORT}`);
  console.log("📡 OpenAI intacto + Voz WebRTC activo (sin REST)");
  console.log("📬 Webhook GitHub activo en /webhook");
  console.log("=".repeat(70));
});


