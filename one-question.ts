const express = require("express");
const { OpenAI } = require("openai");

const router = express.Router();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYS_BASE = `Eres un asistente compasivo y concreto.
Debes devolver EXACTAMENTE UNA PREGUNTA breve y específica que ayude al usuario a avanzar.
No repitas lo que ya dijo. Evita frases genéricas como "¿cómo seguimos hoy?". 
La respuesta debe ser SOLO una pregunta terminada en "?"`;

function clampQuestion(s) {
  let t = (s || "").trim();
  if (!t.endsWith("?")) t += "?";
  return t;
}

router.post("/api/openai/one-question", async (req, res) => {
  try {
    const user_text = req.body?.user_text || "";
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      max_tokens: 100,
      messages: [
        { role: "system", content: SYS_BASE },
        { role: "user", content: user_text }
      ],
    });

    let q = (resp.choices?.[0]?.message?.content || "").trim();
    q = clampQuestion(q);
    return res.json({ text: q });
  } catch (err) {
    console.error("one-question error", err);
    return res.status(500).json({ error: "one-question_failed" });
  }
});

module.exports = router;
