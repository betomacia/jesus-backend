// index.js — Backend simple, dominios acotados y respuestas naturales (multi-idioma)
// Bienvenida SIN cita bíblica. /api/ask mantiene la estructura {message, question, bible?}
// (no incluye Heygen; solo OpenAI).
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const OpenAI = require("openai");
require("dotenv").config();

// App
const app = express();
app.use(cors({ origin: true }));
app.use(bodyParser.json());
app.use((req, res, next) => {
  res.set("Content-Type", "application/json; charset=utf-8");
  next();
});

// OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Utils
function greetingByHour(lang = "es", hour = null) {
  const h = Number.isInteger(hour) ? hour : new Date().getHours();
  const g = (m, a, n) => (h < 12 ? m : h < 19 ? a : n);
  switch (lang) {
    case "en": return g("Good morning", "Good afternoon", "Good evening");
    case "pt": return g("Bom dia", "Boa tarde", "Boa noite");
    case "it": return g("Buongiorno", "Buon pomeriggio", "Buonasera");
    case "de": return g("Guten Morgen", "Guten Tag", "Guten Abend");
    case "ca": return g("Bon dia", "Bona tarda", "Bona nit");
    case "fr": return g("Bonjour", "Bon après-midi", "Bonsoir");
    default:   return g("Buenos días", "Buenas tardes", "Buenas noches");
  }
}
const DAILY_PHRASES = {
  es: ["Un gesto de bondad puede cambiar tu día.","La fe hace posible lo que parece imposible.","Hoy es buen día para empezar de nuevo.","La paz se cultiva con pasos pequeños.","El amor que das, vuelve a ti."],
  en: ["A small kindness can change your day.","Faith makes the impossible possible.","Today is a good day to begin again.","Peace grows from small steps.","The love you give returns to you."],
  pt: ["Um gesto de bondade pode mudar o seu dia.","A fé torna possível o impossível.","Hoje é um bom dia para recomeçar.","A paz cresce com pequenos passos.","O amor que você dá volta para você."],
  it: ["Un gesto di gentilezza può cambiare la tua giornata.","La fede rende possibile l'impossibile.","Oggi è un buon giorno per ricominciare.","La pace cresce a piccoli passi.","L'amore che doni ritorna a te."],
  de: ["Eine kleine Freundlichkeit kann deinen Tag verändern.","Glaube macht das Unmögliche möglich.","Heute ist ein guter Tag für einen Neuanfang.","Frieden wächst aus kleinen Schritten.","Die Liebe, die du gibst, kehrt zu dir zurück."],
  ca: ["Un gest d'amabilitat pot canviar el teu dia.","La fe fa possible l'impossible.","Avui és un bon dia per començar de nou.","La pau creix amb petits passos.","L'amor que dones torna a tu."],
  fr: ["Un geste de bonté peut changer ta journée.","La foi rend possible l'impossible.","Aujourd'hui est un bon jour pour recommencer.","La paix grandit à petits pas.","L'amour que tu donnes te revient."],
};
function dayPhrase(lang = "es") {
  const arr = DAILY_PHRASES[lang] || DAILY_PHRASES.es;
  return arr[Math.floor(Math.random() * arr.length)];
}

// Health
app.get("/", (_req, res) => res.json({ ok: true, service: "backend", ts: Date.now() }));

// Bienvenida (SIN Biblia)
app.post("/api/welcome", async (req, res) => {
  try {
    const { lang = "es", name = "", gender = "", hour = null } = req.body || {};
    const hi = greetingByHour(lang, hour);
    const phrase = dayPhrase(lang);
    const nm = String(name || "").trim();
    let sal = nm ? `${hi}, ${nm}.` : `${hi}.`;

    const message =
      lang === "en" ? `${sal} ${phrase} I'm here for you.` :
      lang === "pt" ? `${sal} ${phrase} Estou aqui para você.` :
      lang === "it" ? `${sal} ${phrase} Sono qui per te.` :
      lang === "de" ? `${sal} ${phrase} Ich bin für dich da.` :
      lang === "ca" ? `${sal} ${phrase} Sóc aquí per ajudar-te.` :
      lang === "fr" ? `${sal} ${phrase} Je suis là pour toi.` :
                      `${sal} ${phrase} Estoy aquí para lo que necesites.`;

    const question =
      lang === "en" ? "What would you like to share today?" :
      lang === "pt" ? "O que você gostaria de compartilhar hoje?" :
      lang === "it" ? "Di cosa ti piacerebbe parlare oggi?" :
      lang === "de" ? "Worüber möchtest du heute sprechen?" :
      lang === "ca" ? "De què t'agradaria parlar avui?" :
      lang === "fr" ? "De quoi aimerais-tu parler aujourd’hui ?" :
                      "¿Qué te gustaría compartir hoy?";

    res.json({ message, question });
  } catch {
    res.json({ message: "La paz sea contigo. ¿De qué te gustaría hablar hoy?", question: "¿Qué te gustaría compartir hoy?" });
  }
});

// Conversación (OpenAI JSON con {message, question, bible?})
app.post("/api/ask", async (req, res) => {
  try {
    const { message = "", history = [], lang = "es" } = req.body || {};
    const SYS = `
Eres cercano, claro y compasivo, desde una voz cristiana (católica).
Alcance: espiritualidad/fe católica, psicología/autoayuda personal, relaciones y emociones.
Varía el lenguaje; 1 sola pregunta breve y pertinente.
Formato (JSON): {"message":"...", "question":"...?", "bible":{"text":"...","ref":"Libro 0:0"}}
No incluyas nada fuera del JSON.
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

    const content = r?.choices?.[0]?.message?.content || "{}";
    let data = {};
    try { data = JSON.parse(content); } catch { data = {}; }
    const out = {
      message: String(data?.message || "").trim() || (lang === "en" ? "I'm with you." : "Estoy contigo."),
      question: String(data?.question || "").trim() || "",
      bible: data?.bible && data.bible.text && data.bible.ref ? data.bible : undefined
    };
    res.json(out);
  } catch (e) {
    res.json({
      message: "La paz sea contigo. Decime en pocas palabras qué está pasando.",
      question: "¿Qué te gustaría trabajar primero?"
    });
  }
});

// Arranque
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor listo en puerto ${PORT}`));
