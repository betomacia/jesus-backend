// ---------- /api/welcome ----------
app.post("/api/welcome", async (req, res) => {
  try {
    const {
      lang = "es",
      name = "",
      sex = "",
      userId = "anon",
      history = [],
      localHour = null,
      hour = null,
      tzOffsetMinutes = null,
    } = req.body || {};

    const resolvedHour = Number.isInteger(localHour)
      ? localHour
      : resolveLocalHour({ hour, tzOffsetMinutes });

    // Memoria básica
    const mem = await readMem(userId);
    const nm = String(name || mem.name || "").trim();
    const sx = String(sex || mem.sex || "").trim().toLowerCase(); // "male" | "female" | ""
    if (nm) mem.name = nm;
    if (sx === "male" || sx === "female") mem.sex = sx;

    // Saludo + nombre
    let sal = nm
      ? `${greetingByHour(lang, resolvedHour)}, ${nm}.`
      : `${greetingByHour(lang, resolvedHour)}.`;

    // 25% "Hijo/Hija mía" si hay sexo definido
    if (Math.random() < 0.25) {
      if (mem.sex === "female") sal += " Hija mía,";
      else if (mem.sex === "male") sal += " Hijo mío,";
    }

    // Prompt a OpenAI: frase suave + pregunta íntima (nada duro / imperativo)
    const W_SYS = `
Devuélveme SOLO un JSON en ${langLabel(lang)} con este esquema:
{"phrase":"<una frase breve, amable y esperanzadora que eleve la autoestima, tono cálido, NO imperativa, NO clichés, NO 'cada pequeño paso...'>",
 "question":"<UNA sola pregunta íntima y cercana para abrir conversación: ejemplos de estilo (no repetir literal): '¿Querés que te escuche?', '¿Preferís empezar por algo sencillo?', '¿Qué te gustaría compartir primero?', '¿Cómo te gustaría comenzar?' >"}
Condiciones:
- La frase debe sentirse humana, suave, cercana (no técnica, no sermón, no moralista).
- Nada de 'cada pequeño paso cuenta', 'camino hacia tus metas' ni fórmulas gastadas.
- La pregunta debe invitar a hablar con cuidado y contención, no sonar a cuestionario.
- No incluyas nada fuera del JSON.
`.trim();

    async function fetchWelcomePair(prevPhrases = [], prevQuestions = []) {
      const r = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.9,
        presence_penalty: 0.6,
        frequency_penalty: 0.4,
        max_tokens: 180,
        messages: [
          { role: "system", content: W_SYS },
          ...(Array.isArray(history) ? history.slice(-4).map(h => ({ role: "user", content: String(h) })) : []),
          { role: "user", content: nm ? `Usuario: ${nm}` : "Usuario anónimo" },
          { role: "user", content: prevPhrases.length ? `Evita frases parecidas a: ${prevPhrases.join(" | ")}` : "Evita repetir frases recientes." },
          { role: "user", content: prevQuestions.length ? `Evita preguntas parecidas a: ${prevQuestions.join(" | ")}` : "Evita repetir preguntas recientes." },
        ],
        response_format: { type: "json_object" },
      });
      const content = r?.choices?.[0]?.message?.content || "{}";
      const data = JSON.parse(content);
      return {
        phrase: String(data?.phrase || "").trim(),
        question: String(data?.question || "").trim(),
      };
    }

    // Intento 1 (+ hasta 2 reintentos si se parece demasiado)
    let phrase = "";
    let question = "";
    const prevP = mem.last_welcome_phrases || [];
    const prevQ = mem.last_welcome_questions || [];

    let tries = 0;
    while (tries < 3) {
      tries++;
      try {
        const pair = await fetchWelcomePair(prevP.slice(-6), prevQ.slice(-6));
        phrase = pair.phrase;
        question = pair.question;

        // Validaciones de tono/contenido y anti-repetición
        const bannedStarts = [/^cada pequeño paso/i, /^cada d[ií]a es una nueva oportunidad/i];
        const looksBanned = bannedStarts.some(rx => rx.test(phrase));
        const isRepPhrase = prevP.some(p => tooSimilar(p, phrase));
        const isRepQuestion = prevQ.some(q => tooSimilar(q, question));

        const okay =
          phrase &&
          question &&
          !looksBanned &&
          !isRepPhrase &&
          !isRepQuestion;

        if (okay) break;
      } catch (e) {
        // sigue intentando con fallback al final
      }
    }

    // Si OpenAI falló todas, usa mini fallbacks suaves (rarísimo)
    if (!phrase) {
      phrase =
        lang === "en" ? "Estoy a tu lado; podés ir a tu ritmo." :
        lang === "pt" ? "Estou ao teu lado; podes ir no teu ritmo." :
        lang === "it" ? "Sono accanto a te; puoi andare al tuo ritmo." :
        lang === "de" ? "Ich bin an deiner Seite; du kannst dein Tempo wählen." :
        lang === "ca" ? "Soc al teu costat; pots anar al teu ritme." :
        lang === "fr" ? "Je suis à tes côtés; avance à ton rythme." :
                        "Estoy a tu lado; podés ir a tu ritmo.";
    }
    if (!question) {
      question =
        lang === "en" ? "¿Cómo te gustaría empezar a hablar hoy?" :
        lang === "pt" ? "Como gostarias de começar a conversar hoje?" :
        lang === "it" ? "Come ti piacerebbe iniziare a parlare oggi?" :
        lang === "de" ? "Wie möchtest du heute anfangen zu sprechen?" :
        lang === "ca" ? "Com t’agradaria començar a parlar avui?" :
        lang === "fr" ? "Comment aimerais-tu commencer à parler aujourd’hui ?" :
                        "¿Cómo te gustaría empezar a hablar hoy?";
    }

    const message = `${sal} ${phrase}`.replace(/\s+/g, " ").trim();

    // Persistimos anti-repetición (máx 10)
    if (phrase) {
      mem.last_welcome_phrases = [...(mem.last_welcome_phrases || []), phrase].slice(-10);
    }
    if (question) {
      mem.last_welcome_questions = [...(mem.last_welcome_questions || []), question].slice(-10);
    }
    await writeMem(userId, mem);

    res.json({ message, question });
  } catch (e) {
    console.error("WELCOME ERROR:", e);
    res.json({
      message: "La paz sea contigo.",
      question: "¿Querés que te escuche un momento?",
    });
  }
});
