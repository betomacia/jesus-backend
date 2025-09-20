// routes/chat.js
const express = require("express");
const OpenAI = require("openai");
const { ensureUserId } = require("../services/user.service");
const { spend, getBalance } = require("../services/credit.service");
const { addMessage } = require("../services/message.service");

const router = express.Router();

// Fuerza JSON UTF-8 en este router
router.use((req, res, next) => {
  res.set("Content-Type", "application/json; charset=utf-8");
  next();
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// POST /chat
// body: { email, lang?, message }
router.post("/", async (req, res) => {
  try {
    const { email, message, lang = "es" } = req.body || {};
    if (!email || !message) {
      return res.status(400).json({ ok: false, error: "email_and_message_required" });
    }

    // 1) Resolver usuario
    const uid = await ensureUserId({ email: String(email).trim().toLowerCase(), lang });

    // 2) Gastar 1 crédito
    const rSpend = await spend({ uid, amount: 1, reason: "chat" });
    if (rSpend && rSpend.ok === false) {
      return res.json(rSpend); // { ok:false, error:"insufficient_credits", balance, need }
    }

    // 3) Guardar mensaje user
    await addMessage({ uid, role: "user", text: String(message), lang });

    // 4) Llamar a OpenAI
    const SYS = `
Eres cercano, claro y compasivo, desde una voz cristiana (católica).
Alcance: espiritualidad/fe católica, psicología/autoayuda personal, relaciones y emociones. Evita lo demás.
Formato: respuesta breve y concreta, con una **pregunta final** útil y una **cita bíblica** pertinente (una sola línea, sin repetir Mateo 11:28).
`.trim();

    const chat = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.6,
      max_tokens: 300,
      messages: [
        { role: "system", content: SYS },
        { role: "user", content: String(message) },
      ],
    });

    const reply = chat?.choices?.[0]?.message?.content?.trim() || (lang === "en" ? "I'm with you." : "Estoy contigo.");

    // 5) Guardar mensaje assistant
    await addMessage({ uid, role: "assistant", text: reply, lang });

    // 6) Balance final
    const balance = await getBalance({ uid });

    return res.json({ ok: true, reply, balance });
  } catch (e) {
    console.error("CHAT ERROR:", e);
    return res.status(500).json({ ok: false, error: "chat_failed" });
  }
});

module.exports = router;
