// services/affection.js
// Inserta “Hijo/Hija mía” con baja frecuencia y sin sonar repetitivo.

function pickVocativeES(gender = "unknown") {
  if (gender === "female") return "Hija mía";
  if (gender === "male") return "Hijo mío";
  return Math.random() < 0.5 ? "Hija mía" : "Hijo mío";
}

/**
 * Inserta “Hijo/Hija mía” con probabilidad controlada.
 * - Solo en ES.
 * - Evita repetición si el texto ya inicia cálido (“Hola…”, “Buenos días…”, etc.).
 */
function maybeInjectVocative({ lang = "es", gender = "unknown", chance = 0.2 }, text) {
  try {
    if (lang !== "es") return text;
    if (Math.random() > chance) return text;

    const voc = pickVocativeES(gender);
    const s = String(text || "").trim();
    if (!s) return text;

    const startsWarm = /^\s*(hola|buen[oa]s\s+(d[ií]as|tardes|noches)|querid[oa])/i.test(s);
    if (startsWarm) {
      // Cierre corto para no duplicar arranques cálidos
      return s.endsWith(".") ? `${s} ${voc}.` : `${s}. ${voc}.`;
    }

    // Si es breve, prefijar; si es más largo, intercalar tras la primera frase
    const sentences = s.split(/(?<=[.!?])\s+/).filter(Boolean);
    if (sentences.length <= 1 && s.length < 120) {
      return `${voc}, ${s}`;
    } else {
      sentences.splice(1, 0, `${voc}.`);
      return sentences.join(" ");
    }
  } catch {
    return text;
  }
}

module.exports = { maybeInjectVocative, pickVocativeES };
