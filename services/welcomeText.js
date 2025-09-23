// routes/welcome.js — Generación de bienvenida dinámica
const express = require("express");
const OpenAI = require("openai");
const { greetingByHour } = require("../services/utils");
const { readMem } = require("../services/memory");

const router = express.Router();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

router.post("/", async (req, res) => {
  try {
    const { lang = "es", name = "", sex = "neutral", hour = null, userId = "anon" } = req.body || {};
    const hi = greetingByHour(lang, hour); // <- hora que manda el móvil (local del usuario)
    const nm = String(name || "").trim();

    // Pedimos 3 frases alentadoras nuevas a OpenAI (varían día a día)
    const sys = `
Dame 3 frases breves, alentadoras y positivas, aptas para personas de fe cristiana, 
sin cliché, en ${lang}. Devuelve JSON: {"phrases":["...","...","..."]}.
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
      phrases = [
        "Hoy es un buen día para empezar de nuevo.",
        "La fe abre caminos donde parece no haberlos.",
        "Un paso pequeño también es avance."
      ];
    }

    // Personalización con memoria (si hay conversación previa)
    const mem = await readMem(userId);
    let sal = nm ? `${hi}, ${nm}.` : `${hi}.`;

    // A veces usar “hijo/hija mía” (no siempre)
    if (Math.random() < 0.33) {
      if (sex === "female") sal = `${sal} Hija mía,`;
      else if (sex === "male") sal = `${sal} Hijo mío,`;
      else sal = `${sal} Hijo/a mío/a,`;
    }

    // Mención amable a lo último hablado (de forma general, no intrusiva)
    let bridge = "";
    if (mem?.last_user_text) {
      // no repitas siempre; 50% de probabilidad
      if (Math.random() < 0.5) {
        bridge =
          lang === "en" ? " ¿Cómo te sentís con lo que veníamos conversando?" :
          lang === "pt" ? " Como você se sente sobre o que conversamos?" :
          lang === "it" ? " Come ti senti rispetto a ciò che conversavamo?" :
          lang === "de" ? " Wie fühlst du dich in Bezug auf unser último diálogo?" :
          lang === "ca" ? " Com et sents respecte del que parlàvem?" :
          lang === "fr" ? " Comment te sens-tu par rapport à ce dont nous parlions ?" :
                          " ¿Cómo te sentís con lo que veníamos conversando?";
      }
    }

    const picked = phrases.slice(0, 3).join(" ");
    const message = `${sal} ${picked}${bridge ? bridge : ""}`;

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
    console.error("WELCOME ERROR:", e);
    res.json({
      message: "La paz sea contigo. ¿De qué te gustaría hablar hoy?",
      question: "¿Qué te gustaría compartir hoy?"
    });
  }
});

module.exports = router;
