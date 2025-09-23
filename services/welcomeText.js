// service/welcometext.js
const OpenAI = require("openai");

// Saludo por hora
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

const VARIED_QUESTIONS = {
  es: [
    "¿En qué te puedo acompañar hoy?",
    "¿Qué te inquieta en este momento?",
    "¿De qué te gustaría hablar ahora?",
    "¿Qué te haría bien poner en palabras hoy?",
    "¿Qué necesitas hoy para estar en paz?",
  ],
  en: [
    "What would help you most right now?",
    "What would you like to talk about today?",
    "What is on your heart at this moment?",
  ],
  pt: ["Sobre o que você quer falar hoje?", "O que te preocupa neste momento?"],
  it: ["Di cosa vorresti parlare oggi?", "Cosa ti pesa nel cuore adesso?"],
  de: ["Worüber möchtest du heute sprechen?", "Was beschäftigt dich gerade?"],
  ca: ["De què t’agradaria parlar avui?", "Què et inquieta ara mateix?"],
  fr: ["De quoi aimerais-tu parler aujourd’hui ?", "Qu’est-ce qui te préoccupe en ce moment ?"],
};

function pick(arr = []) { return arr[Math.floor(Math.random() * arr.length)]; }

// Frase fija en ES, 1 sola vez (si está en español)
const FIXED_ES = "Hoy es un buen día para empezar de nuevo.";

async function getWelcomeText({ lang = "es", name = "", userId = "anon", history = [], localHour = null, gender = "unknown" }) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // 1) Saludo + nombre
  const hi = greetingByHour(lang, localHour);
  const nm = (name || "").trim();
  let sal = nm ? `${hi}, ${nm}.` : `${hi}.`;

  // 2) “Hijo/Hija mía” opcional (~25%), solo si gender definido
  if (Math.random() < 0.25) {
    if (gender === "female") sal += " Hija mía,";
    else if (gender === "male") sal += " Hijo mío,";
  }

  // 3) 1 frase alentadora generada por IA (no cursi, breve)
  let aiPhrase = "";
  try {
    const sys = `Devuelve SOLO JSON con este formato: {"phrase":"..."}.
Escribe 1 frase alentadora, breve, natural y cotidiana (sin citas, sin emojis), en ${lang}. No repitas ideas comunes.`;
    const r = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.9,
      messages: [{ role: "system", content: sys }],
      response_format: { type: "json_object" },
    });
    const content = r?.choices?.[0]?.message?.content || "{}";
    const data = JSON.parse(content);
    aiPhrase = String(data?.phrase || "").trim();
  } catch {
    aiPhrase = lang === "es" ? "La paz crece con pasos pequeños." : "Peace grows from small steps.";
  }

  // 4) Armar mensaje
  const parts = [sal];
  if (lang === "es") parts.push(FIXED_ES); // fija solo en español
  if (aiPhrase) parts.push(aiPhrase);
  const message = parts.join(" ").replace(/\s+/g, " ").trim();

  // 5) 1 pregunta variada
  const qList = VARIED_QUESTIONS[lang] || VARIED_QUESTIONS["es"];
  const question = pick(qList);

  return { message, question };
}

module.exports = { getWelcomeText };
