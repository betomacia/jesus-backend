// service/welcometext.js
// Bienvenida: Saludo + Nombre + (Hijo/Hija 25%) + 1 frase AI + 1 pregunta AI
// Anti-repetición por usuario (memoria corta en proceso)

const OpenAI = require("openai");
const ai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ===== Cache corta por usuario (anti-repetición) =====
const USER_CACHE = new Map();
// Estructura: { lastPhrases: Set<string>, lastQuestions: Set<string>, ts: number }
function remember(userId, type, value, limit = 16) {
  if (!userId) return;
  const rec = USER_CACHE.get(userId) || { lastPhrases: new Set(), lastQuestions: new Set(), ts: Date.now() };
  const bag = type === "phrase" ? rec.lastPhrases : rec.lastQuestions;
  const norm = String(value || "").trim().toLowerCase();
  if (!norm) return;
  bag.add(norm);
  // recortar si excede
  while (bag.size > limit) {
    const first = bag.values().next().value;
    bag.delete(first);
  }
  rec.ts = Date.now();
  USER_CACHE.set(userId, rec);
}
function wasUsed(userId, type, value) {
  if (!userId || !value) return false;
  const rec = USER_CACHE.get(userId);
  if (!rec) return false;
  const bag = type === "phrase" ? rec.lastPhrases : rec.lastQuestions;
  return bag.has(String(value || "").trim().toLowerCase());
}

// ===== Saludo por hora (ES) usando hora local enviada por el front =====
function greetingByHourES(localHour) {
  const h = Number.isFinite(+localHour) ? (+localHour | 0) : new Date().getHours();
  if (h < 6) return "Buenas noches";
  if (h < 12) return "Buenos días";
  if (h < 20) return "Buenas tardes";
  return "Buenas noches";
}

// ===== “Hijo/Hija mío/a” opcional (25%) según gender =====
const HIJO_FRASES = {
  male: ["Hijo mío", "Hijo amado"],
  female: ["Hija mía", "Hija amada"],
  unknown: ["Hijo/a mío/a"],
};
function maybeHijo(gender = "unknown") {
  try {
    if (Math.random() < 0.25) {
      const pool = HIJO_FRASES[gender] || HIJO_FRASES.unknown;
      return pool[Math.floor(Math.random() * pool.length)];
    }
  } catch {}
  return null;
}

// ===== Genera 1 frase alentadora y 1 pregunta variada (ES) =====
async function generatePhraseAndQuestionES({ userId, history }) {
  const sys = [
    "Eres un asistente cristiano cálido, esperanzador y natural.",
    "Responde SIEMPRE en español.",
    "Devuelve JSON estricto con claves: frases[], preguntas[].",
    "Cada frase: 6–14 palabras, sin emojis, sin citas bíblicas ni referencias a versículos.",
    "Cada pregunta: breve, abierta, variada, sin clichés repetitivos y sin parecer formulario.",
    "Nada de duplicados exactos dentro del set retornado.",
  ].join(" ");

  const usr = [
    "Genera 6 a 10 frases breves para levantar el ánimo (sin Biblia ni emojis).",
    "Genera también 6 preguntas de apertura variadas (ej.: «¿En qué puedo acompañarte hoy?», «¿Qué te inquieta?», «¿Qué te gustaría trabajar?»).",
    "Evita repetir estructuras y palabras clave idénticas.",
  ].join("\n");

  let frases = [];
  let preguntas = [];

  try {
    const completion = await ai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      temperature: 0.9,
      messages: [
        { role: "system", content: sys },
        ...(Array.isArray(history) ? history.slice(-6).map((t) => ({ role: "user", content: String(t).slice(0, 400) })) : []),
        { role: "user", content: usr },
      ],
      response_format: { type: "json_object" },
    });

    const data = JSON.parse(completion?.choices?.[0]?.message?.content || "{}");
    const norm = (s) => String(s || "").trim();
    const uniq = (arr) => Array.from(new Set((arr || []).map(norm))).filter(Boolean);

    frases = uniq(data.frases);
    preguntas = uniq(data.preguntas);
  } catch (e) {
    // continúa con fallback abajo
  }

  // filtrar por anti-repetición de este usuario
  if (userId) {
    frases = (frases || []).filter((f) => !wasUsed(userId, "phrase", f));
    preguntas = (preguntas || []).filter((q) => !wasUsed(userId, "question", q));
  }

  // fallbacks si quedaran vacíos
  if (!frases?.length) {
    frases = [
      "La perseverancia abre puertas.",
      "Un paso pequeño también es avance.",
      "La fe abre caminos donde parece no haberlos.",
      "La constancia te acerca a la meta.",
      "Respira hondo, hoy podés volver a intentarlo.",
    ];
  }
  if (!preguntas?.length) {
    preguntas = [
      "¿En qué puedo acompañarte hoy?",
      "¿Qué te gustaría trabajar primero?",
      "¿Qué te inquieta en este momento?",
      "¿Qué te haría sentir un poco más en paz ahora?",
    ];
  }

  const pick1 = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const phrase = pick1(frases);
  const question = pick1(preguntas);

  remember(userId, "phrase", phrase);
  remember(userId, "question", question);

  return { phrase, question };
}

// ===== API principal de bienvenida (para usar desde index.js) =====
async function getWelcomeText({ lang = "es", name = "", userId = "anon", history = [], localHour, gender = "unknown" } = {}) {
  // Por ahora sólo ES para el saludo/texto (tu app principal es ES).
  const saludo = greetingByHourES(localHour);
  const nombre = String(name || "").trim();
  const hijo = maybeHijo(String(gender || "unknown"));

  const { phrase, question } = await generatePhraseAndQuestionES({ userId, history });

  // Componer: "[Saludo], [Nombre]. [Hijo/Hija… ,] [frase AI]"
  const head = nombre ? `${saludo}, ${nombre}.` : `${saludo}.`;
  const partes = [head];
  if (hijo) partes.push(`${hijo},`);
  if (phrase) partes.push(phrase);

  const message = partes.join(" ").replace(/\s+/g, " ").trim();
  return { message, question: String(question || "").trim() };
}

module.exports = {
  getWelcomeText,
};
