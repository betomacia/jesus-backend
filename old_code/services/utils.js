// services/utils.js — Utilidades compartidas

const NORM = (s = "") => String(s).toLowerCase().replace(/\s+/g, " ").trim();

function langLabel(l = "es") {
  const m = { es: "Español", en: "English", pt: "Português", it: "Italiano", de: "Deutsch", ca: "Català", fr: "Français" };
  return m[l] || "Español";
}

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

// --------- Fallback de versículos (por idioma) ----------
const FALLBACK_VERSES = {
  es: [
    { ref: "Salmos 34:18", text: "Cercano está Jehová a los quebrantados de corazón; y salva a los contritos de espíritu." },
    { ref: "Isaías 41:10", text: "No temas, porque yo estoy contigo; no desmayes, porque yo soy tu Dios que te esfuerzo; siempre te ayudaré." },
    { ref: "Salmo 23:1",  text: "El Señor es mi pastor; nada me faltará." },
    { ref: "Romanos 12:12", text: "Gozosos en la esperanza; sufridos en la tribulación; constantes en la oración." },
  ],
  en: [
    { ref: "Psalm 34:18", text: "The Lord is close to the brokenhearted and saves those who are crushed in spirit." },
    { ref: "Isaiah 41:10", text: "Do not fear, for I am with you; do not be dismayed, for I am your God." },
    { ref: "Psalm 23:1", text: "The Lord is my shepherd; I shall not want." },
    { ref: "Romans 12:12", text: "Be joyful in hope, patient in affliction, faithful in prayer." },
  ],
  pt: [
    { ref: "Salmos 34:18", text: "Perto está o Senhor dos que têm o coração quebrantado; e salva os contritos de espírito." },
    { ref: "Isaías 41:10", text: "Não temas, porque eu sou contigo; não te assombres, porque eu sou teu Deus." },
  ],
  it: [
    { ref: "Salmo 34:18", text: "Il Signore è vicino a chi ha il cuore spezzato; egli salva gli spiriti affranti." },
    { ref: "Isaia 41:10", text: "Non temere, perché io sono con te; non smarrirti, perché io sono il tuo Dio." },
  ],
  de: [
    { ref: "Psalm 34:18", text: "Der HERR ist nahe denen, die zerbrochenen Herzens sind." },
    { ref: "Jesaja 41:10", text: "Fürchte dich nicht, denn ich bin mit dir." },
  ],
  ca: [
    { ref: "Salm 34:19 (cat)", text: "El Senyor és a prop dels cors trencats, salva els que tenen l’esperit abatut." },
    { ref: "Isaïes 41:10", text: "No tinguis por, que jo sóc amb tu; no t’esglaiïs, que jo sóc el teu Déu." },
  ],
  fr: [
    { ref: "Psaume 34:19", text: "L’Éternel est près de ceux qui ont le cœur brisé; il sauve ceux qui ont l’esprit dans l’abattement." },
    { ref: "Ésaïe 41:10", text: "Ne crains rien, car je suis avec toi." },
  ],
};

function pickFallbackVerse(lang = "es", avoidSet = new Set()) {
  const list = FALLBACK_VERSES[lang] || FALLBACK_VERSES["es"];
  for (const v of list) {
    if (!avoidSet.has(NORM(v.ref))) return v;
  }
  return list[0];
}

// --------- Filtros de alcance reforzados ----------
const OFFTOPIC = [
  // entretenimiento/deporte/celebridades
  /\b(f[úu]tbol|futbol|deporte|champions|nba|tenis|selecci[oó]n|mundial|goles?)\b/i,
  /\b(pel[ií]cula|serie|netflix|hbo|max|disney|spotify|cantante|concierto|celebridad|famos[oa]s?)\b/i,

  // técnica/ciencia/educación
  /\b(program(a|ar|aci[oó]n)|c[oó]digo|javascript|react|inform[aá]tica|computaci[oó]n|pc|ordenador|linux|windows|red(es)?|wifi|driver|api|prompt|base de datos|docker|kubernetes|github)\b/i,
  /\b(matem[aá]ticas?|algebra|c[aá]lculo|geometr[ií]a|f[ií]sica|qu[ií]mica|biolog[ií]a|cient[ií]fico|ecuaci[oó]n|derivadas?|integrales?)\b/i,

  // mecánica/electrónica/juegos
  /\b(mec[aá]nica|alternador|bater[ií]a del auto|motor|embrague|inyector|buj[ií]a|correa|nafta|diesel)\b/i,
  /\b(circuito|voltaje|ohmios|arduino|raspberry|microcontrolador|placa)\b/i,
  /\b(videojuego|fortnite|minecraft|playstation|xbox|nintendo|steam)\b/i,

  // geografía/turismo no religioso
  /\b(pa[ií]s|capital|mapa|d[oó]nde queda|ubicaci[oó]n|distancia|kil[oó]metros|frontera|r[íi]o|monta[ñn]a|cordillera)\b/i,
  /\b(viaje|hotel|playa|turismo|destino|vuelo|itinerario|tour|gu[ií]a tur[ií]stica)\b/i,

  // gastronomía / comidas / bebidas
  /\b(gastronom[ií]a|gastronomia|cocina|recet(a|ario)s?|platos?|ingredientes?|men[uú]|men[uú]s|postres?|dulces?|salado?s?)\b/i,
  /\b(comida|comidas|almuerzo|cena|desayuno|merienda|vianda|raci[oó]n|calor[ií]as|nutrici[oó]n|dieta)\b/i,
  /\b(bebidas?|vino|cerveza|licor|coctel|c[oó]ctel|trago|fermentado|maridaje|bar|caf[eé]|cafeter[ií]a|restaurante|restaurantes?)\b/i,

  // política/negocios/finanzas
  /\b(pol[ií]tica|elecci[oó]n|partido|diputado|senador|presidente|gobierno)\b/i,
  /\b(criptomonedas?|bitcoin|acciones|bolsa|nasdaq|d[oó]lar|euro)\b/i,
];

const RELIGIOUS_ALLOW = [
  /\b(iglesia|templo|catedral|parroquia|misa|sacramento|oraci[oó]n|santuario|santo|santos|biblia|evangelio|rosario|confesi[oó]n|eucarist[ií]a|liturgia|vaticano|lourdes|f[aá]tima|peregrinaci[oó]n|camino de santiago)\b/i,
];

function isReligiousException(s) {
  const x = NORM(s);
  return RELIGIOUS_ALLOW.some((r) => r.test(x));
}
function isOffTopic(s) {
  const x = NORM(s);
  return OFFTOPIC.some((r) => r.test(x));
}

function isGibberish(s) {
  const x = (s || "").trim();
  if (!x) return true;
  if (x.length < 2) return true;
  const letters = (x.match(/[a-záéíóúüñàèìòùçâêîôûäëïöüß]/gi) || []).length;
  return letters < Math.ceil(x.length * 0.25);
}

module.exports = {
  NORM,
  langLabel,
  greetingByHour,
  pickFallbackVerse,
  isGibberish,
  isOffTopic,
  isReligiousException,
};
