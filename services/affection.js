// services/affection.js
function pickVocativeES(gender = "unknown") {
  if (gender === "female") return "Hija mía";
  if (gender === "male") return "Hijo mío";
  return Math.random() < 0.5 ? "Hija mía" : "Hijo mío";
}

/**
 * Inserta “Hijo/Hija mía” con baja frecuencia (p.ej., 22%),
 * evitando sonar repetitivo. En otros idiomas no agrega nada.
 */
function maybeInjectVocative({ lang = "es", gender = "unknown", chance = 0.22 }, text) {
  try {
    if (lang !== "es") return text;
    if (Math.random() > chance) return text;

    const voc = pickVocativeES(gender);

    // Si ya empieza con “Hola/Buenos días/Querido/a”, ponlo al final como cierre corto.
    const startsWarm = /^\s*(hola|buen[oa]s\s+(d[ií]as|tardes|noches)|querid[oa])/i.test(text || "");
    if (startsWarm) return `${text} ${voc}.`;

    // Si es una sola línea corta, prefijo; si es más largo, lo metemos como 2ª frase.
    const s = String(text || "").trim();
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

module.exports = { maybeInjectVocative };
