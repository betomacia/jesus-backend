// routes/ask.js — Conversación principal (bloqueo temas + pausa post-cita)
const express = require("express");
const OpenAI = require("openai");
const { readMem, writeMem } = require("../services/memory");
const { NORM, langLabel, isGibberish, isOffTopic, isReligiousException, pickFallbackVerse } = require("../services/utils");

const router = express.Router();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

router.post("/", async (req, res) => {
  try {
    const { message = "", history = [], userId = "anon", lang = "es" } = req.body || {};
    const userTxt = String(message || "").trim();

    const mem = await readMem(userId);
    const now = Date.now();

    // Duplicados rápidos (mismo texto en <7s)
    if (userTxt && mem.last_user_text && userTxt === mem.last_user_text && now - mem.last_user_ts < 7000) {
      if (mem.last_bot) return res.json(mem.last_bot);
    }

    // Ruido
    if (isGibberish(userTxt)) {
      const msg =
        lang === "en" ? "I didn’t quite get that. Could you say it again in a few words?" :
        lang === "pt" ? "Não entendi bem. Pode repetir em poucas palavras?" :
        lang === "it" ? "Non ho capito bene. Puoi ripetere in poche parole?" :
        lang === "de" ? "Ich habe es nicht ganz verstanden. Kannst du es in wenigen Worten wiederholen?" :
        lang === "ca" ? "No ho he entès del tot. Ho pots repetir en poques paraules?" :
        lang === "fr" ? "Je n’ai pas bien compris. Peux-tu répéter en quelques mots ?" :
                        "No te entendí bien. ¿Podés repetirlo en pocas palabras?";
      const out = { message: msg, question: "" };
      mem.last_user_text = userTxt; mem.last_user_ts = now; mem.last_bot = out;
      await writeMem(userId, mem);
      return res.json(out);
    }

    // Bloqueo de temas (reforzado) excepto excepción religiosa
    if (isOffTopic(userTxt) && !isReligiousException(userTxt)) {
      const msg =
        lang === "en" ? "I’m here for your inner life: faith, personal struggles and healing. I don’t give facts or opinions on sports, entertainment, technical, food, science or general topics." :
        lang === "pt" ? "Estou aqui para a sua vida interior: fé, questões pessoais e cura. Não trato esportes, entretenimento, técnica, gastronomia, ciência ou temas gerais." :
        lang === "it" ? "Sono qui per la tua vita interiore: fede, difficoltà personali e guarigione. Non tratto sport, spettacolo, tecnica, gastronomia, scienza o temi generali." :
        lang === "de" ? "Ich bin für dein inneres Leben da: Glaube, persönliche Themen und Heilung. Keine Fakten/Meinungen zu Sport, Unterhaltung, Technik, Gastronomie, Wissenschaft oder Allgemeinwissen." :
        lang === "ca" ? "Sóc aquí per a la teva vida interior: fe, dificultats personals i sanació. No tracto esports, entreteniment, tècnica, gastronomia, ciència o temes generals." :
        lang === "fr" ? "Je suis là pour ta vie intérieure : foi, difficultés personnelles et guérison. Je ne traite pas le sport, le divertissement, la technique, la gastronomie, la science ni les sujets généraux." :
                        "Estoy aquí para tu vida interior: fe, dificultades personales y sanación. No doy datos ni opiniones de deportes, espectáculos, técnica, gastronomía, ciencia o temas generales.";
      const q =
        lang === "en" ? "What would help you most right now—your emotions, a relationship, or your prayer life?" :
        lang === "pt" ? "O que mais ajudaria agora — suas emoções, uma relação, ou a sua vida de oração?" :
        lang === "it" ? "Cosa ti aiuterebbe ora — le emozioni, una relazione o la tua vida di preghiera?" :
        lang === "de" ? "Was würde dir jetzt am meisten helfen – deine Gefühle, eine Beziehung oder dein Gebetsleben?" :
        lang === "ca" ? "Què t’ajudaria ara — les teves emocions, una relació o la teva vida de pregària?" :
        lang === "fr" ? "Qu’est-ce qui t’aiderait le plus — tes émotions, une relation ou ta vie de prière ?" :
                        "¿Qué te ayudaría ahora — tus emociones, una relación o tu vida de oración?";
      const out = { message: msg, question: q };
      mem.last_user_text = userTxt; mem.last_user_ts = now; mem.last_bot = out;
      await writeMem(userId, mem);
      return res.json(out);
    }

    // -------- OpenAI: Instrucciones mínimas (con BIBLIA requerida) --------
    const SYS = `
Eres cercano, claro y compasivo, desde una voz cristiana (católica).
Alcance: espiritualidad/fe cristiana, psicología/autoayuda personal, relaciones y emociones.
Varía el lenguaje; no repitas muletillas. 1 sola pregunta breve y útil.
Formato (JSON en ${langLabel(lang)}): {"message":"...", "question":"...?", "bible":{"text":"...","ref":"Libro 0:0"}}
- "message": natural y concreto; pasos prácticos si corresponde.
- "question": una pregunta simple (no hagas cuestionarios).
- "bible": SIEMPRE incluida; pertinente; evita Mateo/Matthew 11:28 (todas las variantes).
No incluyas nada fuera del JSON.
`.trim();

    const convo = [];
    const recent = Array.isArray(history) ? history.slice(-8) : [];
    for (const h of recent) {
      if (typeof h === "string") convo.push({ role: "user", content: h });
    }
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
            additionalProperties: false,
          },
        },
      },
    });

    const content = r?.choices?.[0]?.message?.content || "{}";
    let data = {}; try { data = JSON.parse(content); } catch { data = {}; }

    // Ensamblado seguro + “pausa” después de la cita
    const verseRef = String(data?.bible?.ref || "").trim();
    const verseTxt = String(data?.bible?.text || "").trim();

    let verse = null;
    const banned = /mateo\s*11\s*:\s*28|matt(hew)?\s*11\s*:\s*28|matteo\s*11\s*:\s*28|matthäus\s*11\s*:\s*28|matthieu\s*11\s*:\s*28|mateu\s*11\s*:\s*28|mateus\s*11\s*:\s*28/i;
    if (verseRef && verseTxt && !banned.test(verseRef)) {
      verse = { ref: verseRef, text: verseTxt };
    } else {
      verse = pickFallbackVerse(lang, new Set());
    }

    // Importante: insertamos la cita **dentro de message** y NO devolvemos "bible" como campo,
    // para no duplicarla en el frontend.
    const baseMsg = String(data?.message || "").trim() || (lang === "en" ? "I’m with you." : "Estoy contigo.");
    const question = String(data?.question || "").trim() || "";

    const message = `${verse.text} (${verse.ref}) … ${baseMsg}`;
    const out = { message, question };

    // Persistimos
    mem.last_user_text = userTxt;
    mem.last_user_ts = now;
    mem.last_bot = out;
    await writeMem(userId, mem);

    res.json(out);
  } catch (e) {
    console.error("ASK ERROR:", e);
    res.json({
      message: "La paz sea contigo. Contame en pocas palabras qué está pasando y vemos un paso simple y concreto.",
      question: "¿Qué te gustaría trabajar primero?"
    });
  }
});

module.exports = router;
