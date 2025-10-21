// index.js — Backend interno (OpenAI + WebRTC Voice Forward)
import express from "express";
import fetch from "node-fetch";
import wrtc from "wrtc";
import OpenAI from "openai";
import dotenv from "dotenv";
dotenv.config();

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
app.use((req, res, next) => { setCors(res); next(); });
app.options("*", (req, res) => { setCors(res); return res.status(204).end(); });
app.use(express.json());

/* ================== OpenAI Setup ================== */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const LANG_NAME = (l = "es") =>
  ({ es: "español", en: "English", pt: "português", it: "italiano", de: "Deutsch", ca: "català", fr: "français" }[l] || "español");

/* ================== Helper WebRTC ================== */
const VOZ_WEBRTC_URL = "http://10.128.0.40:8000/webrtc/tts";

async function sendTextToVoiceServer(text, lang, route, sessionId) {
  try {
    console.log(`🎙️ Iniciando WebRTC interno → ${VOZ_WEBRTC_URL} (route=${route})`);

    // Crear conexión Peer
    const pc = new wrtc.RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });

    // Crear canal de datos
    const dc = pc.createDataChannel("tts", { ordered: true });
    dc.onopen = () => {
      console.log("📡 Canal WebRTC abierto → enviando texto TTS");
      dc.send(JSON.stringify({ text, lang, route, sessionId }));
    };
    dc.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg?.event === "done") console.log("✅ Voz procesada correctamente (done)");
      } catch {}
    };

    // Crear oferta SDP
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // Enviar SDP al servidor de voz interno
    const res = await fetch(VOZ_WEBRTC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/sdp", "Accept": "application/sdp" },
      body: offer.sdp ?? "",
    });
    if (!res.ok) throw new Error(`Fallo en handshake: ${res.status}`);
    const answerSdp = await res.text();
    await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
    console.log("✅ WebRTC handshake con servidor de voz completado");

    // Mantener conexión viva unos segundos
    setTimeout(() => {
      try {
        dc.close();
        pc.close();
        console.log("🧹 WebRTC interno cerrado");
      } catch {}
    }, 6000);
  } catch (err) {
    console.error("❌ Error enviando texto al servidor de voz:", err.message);
  }
}

/* ================== Health Check ================== */
app.get("/", (_req, res) => {
  setCors(res);
  res.json({
    ok: true,
    service: "Jesus Backend (OpenAI + WebRTC Interno)",
    version: "3.6",
    ts: Date.now(),
    endpoints: ["/api/welcome", "/api/ask"],
  });
});

/* ================== /api/welcome ================== */
app.post("/api/welcome", async (req, res, next) => {
  try {
    const { lang = "es", name = "", gender = "", hour = null, route = "frontend", sessionId = "welcome" } = req.body || {};
    const h = Number.isInteger(hour) ? hour : new Date().getHours();

    const SYSTEM = `
Eres un asistente espiritual cálido y cercano. Responde SIEMPRE y SOLO en ${LANG_NAME(lang)} (${lang}).

Genera una BIENVENIDA con DOS elementos separados:
⭐ "message": saludo con nombre + frase motivacional
⭐ "question": pregunta conversacional`;
    const USER = `Genera bienvenida en ${lang} con name=${name}, gender=${gender}, hour=${h}`;

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
            properties: { message: { type: "string" }, question: { type: "string" } },
            required: ["message", "question"],
            additionalProperties: false,
          },
        },
      },
    });

    const data = JSON.parse(r?.choices?.[0]?.message?.content || "{}");
    const message = data.message || "";
    const question = data.question || "";

    // 🔊 Si audio/video activos → enviar al servidor de voz interno
    if (route === "audio_on" || route === "video_on") {
      sendTextToVoiceServer(`${message}\n\n${question}`, lang, route, sessionId);
    }

    setCors(res);
    res.json({ message, question });
  } catch (e) {
    next(e);
  }
});

/* ================== /api/ask ================== */
app.post("/api/ask", async (req, res, next) => {
  try {
    const { message = "", history = [], lang = "es", route = "frontend", sessionId = "" } = req.body || {};
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
                properties: { text: { type: "string" }, ref: { type: "string" } },
                required: ["text", "ref"],
              },
            },
            required: ["message", "question", "bible"],
            additionalProperties: false,
          },
        },
      },
    });

    const data = JSON.parse(r?.choices?.[0]?.message?.content || "{}");
    const msg = data.message || "";
    const q = data.question || "";
    const btx = data.bible?.text || "";
    const bref = data.bible?.ref || "";

    // 🔊 Enviar texto al servidor de voz interno solo si audio/video activado
    if (route === "audio_on" || route === "video_on") {
      sendTextToVoiceServer([msg, q].filter(Boolean).join("\n\n"), lang, route, sessionId);
    }

    // ✉️ Enviar texto siempre al frontend
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

/* ================== 404 & Error ================== */
app.use((req, res) => { setCors(res); res.status(404).json({ error: "not_found" }); });
app.use((err, req, res, _next) => {
  console.error("SERVER ERROR:", err);
  setCors(res);
  res.status(502).json({ error: "server_error", detail: String(err?.message || "unknown") });
});

/* ================== Start ================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("=".repeat(70));
  console.log("🌟 JESUS BACKEND v3.6 — WebRTC Interno en red privada Google Cloud");
  console.log("✅ Puerto:", PORT);
  console.log("=".repeat(70));
});
