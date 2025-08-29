function ensureOneQuestionAtEnd(userMsg, message) {
  // Si el usuario se despide, no preguntamos
  if (isGoodbye(userMsg)) {
    const { body } = extractTrailingQuestion(message);
    return body; // cierre sin pregunta
  }

  // 1) Partimos el texto en líneas, limpiamos espacios y vacías
  const lines = (message || "")
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);

  // 2) Identificamos TODAS las líneas que son preguntas
  const questionIndices = [];
  for (let i = 0; i < lines.length; i++) {
    if (/\?\s*$/.test(lines[i])) questionIndices.push(i);
  }

  // 3) Elegimos SOLO UNA pregunta para el final:
  //    - Preferimos la ÚLTIMA que haya escrito el modelo
  //    - Eliminamos cualquier otra pregunta "colada" al principio o en medio
  let trailingQ = "";
  if (questionIndices.length > 0) {
    const keepIdx = questionIndices[questionIndices.length - 1];
    trailingQ = lines[keepIdx];
    // quitamos todas las preguntas del cuerpo (incluida la elegida)
    for (let i = questionIndices.length - 1; i >= 0; i--) {
      lines.splice(questionIndices[i], 1);
    }
  }

  // 4) El cuerpo queda sin preguntas duplicadas
  const body = lines.join("\n").trim();

  // 5) Si no quedó ninguna pregunta, generamos una contextual como red de seguridad
  if (!trailingQ) {
    trailingQ = makeContextualQuestion(userMsg);
  }

  // 6) Devolvemos cuerpo + UNA sola pregunta (la cita la inserta el front entre ambos)
  return `${body}\n${trailingQ}`.trim();
}
