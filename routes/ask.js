// routes/ask.js — Conversación principal con pausa después de la cita bíblica
const express = require("express");
const OpenAI = require("openai");
const { readMem, writeMem } = require("../services/memory");
const { NORM, pickFallbackVerse } = require("../services/utils");

const router = express.Router();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

router.post("/", async (req, res) => {
  try {
    const { message = "", history = [], userId = "anon", lang = "es" } = req.body || {};
    const userTxt = String(message || "").trim();
    const mem = await readMem(userId);
    const now = Date.now();

    // -------- OpenAI --------
    const SYS = `
Eres cercano, claro y compasivo, desde una voz cristiana.
Formato: {"message":"...", "question":"...?", "bible":{"text":"...","ref":"Libro 0:0"}}
- message: texto principal
- question: una sola pregunta útil
- bible: siempre incluida
No incluyas nada fuera del JSON.
`.trim();

    const convo = [];
    const recent = Array.isArray(history) ? history.slice(-8) : [];
    for (const h of recent) if (typeof h === "string") convo.push({ role: "user", content: h });
    convo.push({ role: "user", content: userTxt });

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
                required: ["text", "ref"],
              },
            },
            required: ["message", "bible"],
          },
        },
      },
    });

    const content = r?.choices?.[0]?.message?.content || "{}";
    let data = {}; try { data = JSON.parse(content); } catch {}

    let out = {
      message: String(data?.message || "").trim(),
      question: String(data?.question || "").trim(),
    };

    // Insertamos la cita bíblica al inicio y pausa “…” después
    const ref = data?.bible?.ref || "";
    const txt = data?.bible?.text || "";
    if (ref && txt) {
      out.message = `${txt} (${ref}) … ${out.message}`;
    } else {
      const fb = pickFallbackVerse(lang, new Set());
      out.message = `${fb.text} (${fb.ref}) … ${out.message}`;
    }

    // Guardar memoria
    mem.last_user_text = userTxt;
    mem.last_user_ts = now;
    mem.last_bot = out;
    await writeMem(userId, mem);

    res.json(out);
  } catch (e) {
    res.json({
      message: "Estoy contigo. Contame en pocas palabras qué sucede.",
      question: "¿Qué te gustaría trabajar primero?",
      bible: { text: "El Señor es mi pastor; nada me faltará.", ref: "Salmo 23:1" }
    });
  }
});

module.exports = router;
