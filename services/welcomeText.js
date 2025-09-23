// ---------- /api/welcome ----------
app.post("/api/welcome", async (req, res) => {
  try {
    const { lang = "es", name = "", sex = "neutral", hour = null, userId = "anon" } = req.body || {};
    const hi = greetingByHour(lang, hour); // hora local que envía el móvil
    const nm = String(name || "").trim();

    // guardamos nombre/sexo en memoria
    const mem = await readMem(userId);
    if (nm) mem.name = nm;
    if (sex) mem.sex = sex;
    await writeMem(userId, mem);

    // Pedimos hasta 3 frases alentadoras a OpenAI (varían a diario)
    const sys = `Dame 3 frases breves, alentadoras y positivas, para uso diario, aptas para una audiencia cristiana, sin clichés, en ${lang}. JSON plano {"phrases":["...","...","..."]}`;
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
        "La fe abre caminos donde parece no haberlos.",
        "Un paso pequeño también es avance.",
        "La paz crece con actos sencillos."
      ];
    }

    // ✅ FRASE FIJA EN ESPAÑOL (siempre presente y primera)
    if (lang === "es") {
      const MUST = "Hoy es un buen día para empezar de nuevo.";
      // Evitar duplicados si la IA casualmente la trajo
      phrases = [MUST, ...phrases.filter(p => NORM(p) !== NORM(MUST))];
    }

    let sal = nm ? `${hi}, ${nm}.` : `${hi}.`;
    // uso ocasional de “Hijo/Hija mía”
    if (Math.random() < 0.33) {
      if (sex === "female") sal = `${sal} Hija mía,`;
      else if (sex === "male") sal = `${sal} Hijo mío,`;
      else sal = `${sal} Hijo/a mío/a,`;
    }

    // Tomamos las 3 primeras (la 1ª es la fija en ES)
    const picked = phrases.slice(0, 3).join(" ");

    // Puente suave si hubo conversación previa
    let bridge = "";
    if (mem?.last_user_text && Math.random() < 0.5) {
      bridge =
        lang === "en" ? " ¿Cómo te sentís con lo que veníamos conversando?" :
        lang === "pt" ? " Como você se sente sobre o que conversamos?" :
        lang === "it" ? " Come ti senti rispetto a ciò che conversavamo?" :
        lang === "de" ? " Wie fühlst du dich in Bezug auf nuestra conversación anterior?" :
        lang === "ca" ? " Com et sents respecte del que parlàvem?" :
        lang === "fr" ? " Comment te sens-tu par rapport à ce dont nous parlions ?" :
                        " ¿Cómo te sentís con lo que veníamos conversando?";
    }

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
    res.json({ message: "La paz sea contigo. ¿De qué te gustaría hablar hoy?", question: "¿Qué te gustaría compartir hoy?" });
  }
});
