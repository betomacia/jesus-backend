// services/welcomeText.js
// Bienvenida con 2–3 frases alentadoras + memoria ligera + vocativo ocasional.

const { maybeInjectVocative } = require("./affection");

/* ===== Idioma UI ===== */
function langLabel(l = "es") {
  const m = {
    es: "Español",
    en: "English",
    pt: "Português",
    it: "Italiano",
    de: "Deutsch",
    ca: "Català",
    fr: "Français",
  };
  return m[l] || "Español";
}

/* ===== Saludo por hora ===== */
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

/* ===== Frases alentadoras (ampliadas) ===== */
const DAILY_PHRASES = {
  es: [
    "Respirá hondo: cada día trae una oportunidad nueva.",
    "La fe no quita la carga, te da hombros más fuertes.",
    "Un pasito a la vez también es avanzar.",
    "Dios escribe recto en renglones torcidos.",
    "La paz empieza con un sí pequeño dentro tuyo.",
    "No estás solo: la esperanza sabe tu nombre.",
    "Lo que hoy duele, mañana puede guiarte.",
    "A veces el milagro es seguir intentando.",
    "Tu valor no depende de un día difícil.",
    "La luz más pequeña vence la oscuridad más grande.",
    "La oración simple abre puertas profundas.",
    "Tu historia no termina en este capítulo.",
    "El amor sana lento, pero sana hondo.",
    "La paciencia también es coraje en silencio.",
  ],
  en: [
    "Breathe: each day brings a fresh chance.",
    "Faith won’t remove the load—It makes your shoulders stronger.",
    "One small step is still progress.",
    "God writes straight with crooked lines.",
    "Peace begins with a small yes inside you.",
  ],
  pt: [
    "Respire: cada dia traz uma nova oportunidade.",
    "A fé fortalece os ombros para o peso de hoje.",
    "Um passo de cada vez já é caminho.",
  ],
  it: [
    "Respira: ogni giorno porta un’opportunità nuova.",
    "La fede fortifica le spalle per il peso di oggi.",
    "Un passo alla volta è già cammino.",
  ],
  de: [
    "Atme durch: Jeder Tag bringt eine neue Chance.",
    "Glaube stärkt die Schultern für die Last von heute.",
    "Ein kleiner Schritt ist immer noch Fortschritt.",
  ],
  ca: [
    "Respira: cada dia porta una nova oportunitat.",
    "La fe enforteix les espatlles per al pes d’avui.",
    "Un petit pas també és avançar.",
  ],
  fr: [
    "Respire : chaque jour apporte une chance nouvelle.",
    "La foi fortifie tes épaules pour le poids d’aujourd’hui.",
    "Un petit pas est déjà un chemin.",
  ],
};

function pickManyPhrases(lang = "es", n = 2) {
  const list = DAILY_PHRASES[lang] || DAILY_PHRASES["es"];
  const k = Math.max(2, Math.min(3, n)); // 2 o 3
  const shuffled = [...list].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, k);
}

/* ===== Resumen muy simple del último tema ===== */
function briefTopic(mem = {}) {
  try {
    const last = String(mem.last_user_text || "").trim();
    if (!last) return "";
    // Tomamos primeras ~6-10 palabras para aludir sin ser literal
    const words = last.split(/\s+/).slice(0, 10).join(" ");
    return words.replace(/\s*[,.;:!?]+$/, "");
  } catch {
    return "";
  }
}

/* ===== Build de bienvenida ===== */
function buildWelcome({ lang = "es", name = "", gender = "unknown", hour = null, mem = {} }) {
  const hi = greetingByHour(lang, hour);
  const nm = String(name || "").trim();
  const sal = nm ? `${hi}, ${nm}.` : `${hi}.`;

  // Frases (2 o 3)
  const phrases = pickManyPhrases(lang, Math.random() < 0.4 ? 3 : 2);
  const extras = phrases.length ? [phrases.join(" ")] : [];

  // Si hubo charla ayer, referencia suave al tema
  let memLine = "";
  if (mem && mem.last_user_ts) {
    const hoursAgo = Math.round((Date.now() - Number(mem.last_user_ts || 0)) / 3600000);
    if (hoursAgo >= 8 && hoursAgo <= 48) {
      const topic = briefTopic(mem);
      if (topic) {
        memLine =
          lang === "en" ? `How are you feeling today after what you shared about “${topic}”?` :
          lang === "pt" ? `Como você se sente hoje depois do que compartilhou sobre “${topic}”?` :
          lang === "it" ? `Come ti senti oggi dopo quello che hai condiviso su “${topic}”?` :
          lang === "de" ? `Wie fühlst du dich heute nach dem, was du über „${topic}” geteilt hast?` :
          lang === "ca" ? `Com et sents avui després del que vas compartir sobre «${topic}»?` :
          lang === "fr" ? `Comment te sens-tu aujourd’hui après ce que tu as partagé sur « ${topic} » ?` :
                           `¿Cómo te sentís hoy después de lo que compartiste sobre “${topic}”?`;
      }
    }
  }

  let message = [sal, ...extras, memLine].filter(Boolean).join(" ");

  // ES: a veces usa “Hijo/Hija mía”
  message = maybeInjectVocative({ lang, gender, chance: 0.25 }, message);

  const question =
    lang === "en" ? "What would help you most right now?" :
    lang === "pt" ? "O que mais te ajudaria agora?" :
    lang === "it" ? "Cosa ti aiuterebbe di più adesso?" :
    lang === "de" ? "Was würde dir jetzt am meisten helfen?" :
    lang === "ca" ? "Què t’ajudaria més ara mateix?" :
    lang === "fr" ? "Qu’est-ce qui t’aiderait le plus maintenant ?" :
                    "¿Qué te ayudaría más ahora mismo?";

  return { message, question };
}

module.exports = { buildWelcome, langLabel };
