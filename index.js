// ======================================================
// ✝️ JESUS BACKEND v4.0 — OpenAI + Envío a Servidor de Voz (WebRTC)
// ======================================================
import express from "express";
import dotenv from "dotenv";
import fetch from "node-fetch";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(express.json());

// ================== CONFIG ==================
const VOZ_WEBRTC_URL = "http://10.128.0.40:8000/webrtc/tts"; // servidor de voz interno
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept",
};
app.use((req, res, next) => {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
  next();
});
app.options("*", (_, res) => res.status(204).end());

// ================== HELPERS ==================
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

const sendToVoice = async (text, lang, route, sessionId) => {
  try {
    // Crea una oferta WebRTC mínima para handshake con el servidor de voz
    const offer = `v=0
o=- 0 0 IN IP4 127.0.0.1
s=backend
t=0 0
a=group:BUNDLE data
m=application 9 UDP/DTLS/SCTP webrtc-datachannel
c=IN IP4 0.0.0.0
a=sctp-port:5000
a=max-message-size:262144`;

    const res = await fetch(VOZ_WEBRTC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/sdp", "Accept": "application/sdp" },
      body: offer,
    });

    if (!res.ok) throw new Error(`Handshake con voz falló (${res.status})`);
    console.log(`🎙️ [VOZ] Handshake con servidor de voz completado`);

    // Enviamos el texto como JSON a través de POST normal (no canal real)
    const r2 = await fetch(VOZ_WEBRTC_URL.replace("/webrtc/tts", "/tts"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, lang, route, sessionId }),
    });

    console.log(
      r2.ok
        ? `📤 [VOZ] Texto reenviado correctamente (route=${route})`
        : `⚠️ [VOZ] Error reenviando texto: ${r2.status}`
    );
  } catch (err) {
    console.error("❌ Error reenviando al servidor de voz:", err.message);
  }
};

// ================== /api/welcome ==================
app.post("/api/welcome", async (req, res) => {
  const { lang = "es", name = "", gender = "", hour = new Date().getHours() } = req.body || {};

  const SYSTEM = `
Eres un asistente espiritual cálido y cercano. Responde SIEMPRE y SOLO en ${LANG_NAME(lang)} (${lang}).
Genera una BIENVENIDA con dos campos:
{"message":"saludo + frase motivacional","question":"pregunta inicial"}`;

  const USER = `Genera bienvenida en ${lang} para ${name} (${gender}) a las ${hour}h`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    temperature: 0.9,
    max_tokens: 280,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: USER },
    ],
  });

  const raw = completion.choices?.[0]?.message?.content || "";
  let message = "", question = "";
  try {
    ({ message, question } = JSON.parse(raw));
  } catch {
    message = raw;
  }

  res.json({ message, question });
});

// ================== /api/ask ==================
app.post("/api/ask", async (req, res) => {
  try {
    const { message = "", history = [], lang = "es", route = "frontend", sessionId = "" } = req.body || {};
    const convo = Array.isArray(history)
      ? history.slice(-8).map((h) => ({ role: "user", content: h }))
      : [];
    convo.push({ role: "user", content: message });

    const SYSTEM = `Eres Dios. Responde SIEMPRE en ${LANG_NAME(lang)} (${lang}).`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.75,
      max_tokens: 350,
      messages: [{ role: "system", content: SYSTEM }, ...convo],
    });

    const raw = completion.choices?.[0]?.message?.content || "";
    let data = {};
    try {
      data = JSON.parse(raw);
    } catch {
      data = { message: raw, question: "" };
    }

    const msg = data.message?.trim() || "";
    const q = data.question?.trim() || "";
    const outText = [msg, q].filter(Boolean).join("\n\n");

    // 🔊 Enviar al servidor de voz si el audio o video están activos
    if (route === "audio_on" || route === "video_on") {
      sendToVoice(outText, lang, route, sessionId);
    }

    res.json({ message: msg, question: q, route, sessionId });
  } catch (e) {
    console.error("❌ Error /api/ask:", e.message);
    res.status(500).json({ error: "server_error", detail: e.message });
  }
});

// ================== INICIO SERVIDOR ==================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Jesus Backend escuchando en puerto ${PORT}`);
});
