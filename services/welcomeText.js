// routes/welcome.js — Generación de bienvenida dinámica
const express = require("express");
const OpenAI = require("openai");

const router = express.Router();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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

router.post("/", async (req, res) => {
  try {
    const { lang = "es", name = "", sex = "neutral", hour = null } = req.body || {};
    const hi = greetingByHour(lang, hour);
    const nm = String(name || "").trim();

    // Pedimos 2–3 frases motivadoras a OpenAI para que siempre cambien
    const sys = `
      Dame 3 frases breves, alentadoras y positivas para iniciar el día,
      sin repetir frases comunes. Escríbelas en ${lang}. 
      Devuelve un JSON: {"phrases":["...","...","..."]}.
    `.trim();

    let phrases = [];
    try {
      const r = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "system", content: sys }],
        response_format: { type: "json" },
      });
      const content = r?.choices?.[0]?.message?.content || "{}";
      const data = JSON.parse(content);
      if (Array.isArray(data.phrases)) phrases = data.phrases;
    } catch {
      phrases = ["Hoy es un buen día para empezar de nuevo.", "La fe hace posible lo que parece imposible."];
    }

    // Seleccionamos 2–3 frases
    const picked = phrases.slice(0, 3).join(" ");

    // Alternar uso de “hijo/hija mía”
    let sal = nm ? `${hi}, ${nm}.` : `${hi}.`;
    if (Math.random() < 0.3) {
      if (sex === "female") sal = `${sal} Hija mía,`;
      else if (sex === "male") sal = `${sal} Hijo mío,`;
      else sal = `${sal} Hijo/a mío/a,`;
    }

    const message = `${sal} ${picked}`;
    const question =
      lang === "en" ? "What would you like to share today?" :
      lang === "pt" ? "O que você gostaria de compartilhar hoje?" :
      lang === "it" ? "Di cosa ti piacerebbe parlare oggi?" :
      lang === "de" ? "Worüber möchtest du heute sprechen?" :
      lang === "ca" ? "De què t’agradaria parlar avui?" :
      lang === "fr" ? "De quoi aimerais-tu parler aujourd’hui ?" :
                      "¿Qué te gustaría compartir hoy?";

    res.json({ message, question });
  } catch (e) {
    res.json({
      message: "La paz sea contigo. ¿De qué te gustaría hablar hoy?",
      question: "¿Qué te gustaría compartir hoy?"
    });
  }
});

module.exports = router;
