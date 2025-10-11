// index.js — CORS blindado + 100% OpenAI + bienvenida con frase alentadora (tres estilos)
// ⭐ AGREGADO: WebSocket Proxy para TTS
const express = require("express");
const expressWs = require("express-ws");
const WebSocket = require("ws");
const OpenAI = require("openai");
require("dotenv").config();

const app = express();

// ⭐ Habilitar WebSocket en Express
expressWs(app);

/* ================== CORS (robusto) ================== */
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*", // FE usa credentials: "omit"
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin",
  "Content-Type": "application/json; charset=utf-8",
};
function setCors(res) { for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v); }

// Siempre antes de todo
app.use((req, res, next) => { setCors(res); next(); });
// Responder cualquier preflight
app.options("*", (req, res) => { setCors(res); return res.status(204).end(); });

// Body parser
app.use(express.json());

/* ================== Diagnóstico CORS ================== */
app.get("/__cors", (req, res) => {
  setCors(res);
  res.status(200).json({ ok: true, headers: CORS_HEADERS, ts: Date.now() });
});

/* ================== Health ================== */
app.get("/", (_req, res) => {
  setCors(res);
  res.json({ ok: true, service: "backend", ts: Date.now() });
});

/* ================== OpenAI ================== */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const LANG_NAME = (l="es") => ({es:"español",en:"English",pt:"português",it:"italiano",de:"Deutsch",ca:"català",fr:"français"}[l]||"español");

/* ================== /api/welcome ================== */
app.post("/api/welcome", async (req, res, next) => {
  try {
    const { lang = "es", name = "", gender = "", hour = null } = req.body || {};
    const h = Number.isInteger(hour) ? hour : new Date().getHours();

    const SYSTEM = `
Eres un asistente espiritual cálido y cercano. Responde SIEMPRE y SOLO en ${LANG_NAME(lang)} (${lang}).

Genera una BIENVENIDA con DOS elementos separados:

⭐ ELEMENTO 1: "message" - SALUDO CON NOMBRE + FRASE MOTIVACIONAL POTENTE

**PARTE A - SALUDO (según hora {{hour}} del dispositivo del usuario):**
- 5-12h: "Buenos días" o "Buen día"
- 12-19h: "Buenas tardes" 
- 19-5h: "Buenas noches"

**PARTE B - NOMBRE (si existe {{name}}):**
- Si hay nombre: agrégalo INMEDIATAMENTE SIN COMA, SIN PUNTO (completamente fluido)
  * ✅ CORRECTO: "Buenas noches Roberto" (sin puntuación, fluido)
  * ✅ CORRECTO: "Buenos días María" (sin puntuación, fluido)
  * ❌ INCORRECTO: "Buenas noches, Roberto" (coma causa pausa)
  * ❌ INCORRECTO: "Buenas noches. Roberto" (punto causa pausa larga)
- Si NO hay nombre: solo saludo con punto: "Buenas noches."

**PARTE C - FRASE MOTIVACIONAL POTENTE (CRÍTICO):**
Después del saludo+nombre, agrega UNA frase corta pero POTENTE y ORIGINAL que levante el ánimo.
Debe ser inspiradora, dar esperanza, motivar.

Inspírate en estos TRES estilos (elige UNO al azar para variar):

🌻 **ESTILO 1: Gratitud y belleza (presencia, asombro, milagro de lo cotidiano)**
Tono que buscas (inspírate, NO copies exactamente):
- "Respira hondo, estás vivo y eso ya es un milagro"
- "La vida no tiene que ser perfecta para ser maravillosa"
- "Cada momento es una nueva oportunidad para empezar"
- "Tu existencia tiene un valor infinito, más allá de lo que logres"

🌈 **ESTILO 2: Esperanza y fe (confianza, luz en el camino, propósito)**
Tono que buscas (inspírate, NO copies exactamente):
- "Confía en que lo mejor aún está por llegar"
- "Aunque no veas el camino, sigue caminando... la luz aparece en el andar"
- "Cada paso que das tiene sentido, aunque ahora no lo veas"
- "Hay esperanza incluso en los momentos más oscuros"

✨ **ESTILO 3: Motivación para actuar (hoy cuenta, sé la chispa, pequeñas acciones)**
Tono que buscas (inspírate, NO copies exactamente):
- "Haz que hoy cuente, no por lo que logres sino por cómo te sientas"
- "No esperes a que pase algo mágico... sé tú la magia"
- "Una pequeña acción hoy puede cambiar tu mañana"
- "Tienes más fuerza de la que imaginas"

⭐ IMPORTANTE:
- La frase debe ser ORIGINAL (no copies exactamente los ejemplos, inspírate en el TONO y la ENERGÍA)
- Debe ser CORTA (1-2 líneas máximo)
- Debe ser POTENTE (que impacte, que motive, que levante el ánimo)
- Respeta el {{gender}} si usas palabras que cambian:
  * male: "solo", "listo", "fuerte", "capaz"
  * female: "sola", "lista", "fuerte", "capaz"
  * sin gender: formas neutras

**ESTRUCTURA COMPLETA del "message":**
"Saludo+nombre (SIN coma) punto. Frase motivacional potente."

⭐ ELEMENTO 2: "question" - PREGUNTA CONVERSACIONAL NATURAL

La pregunta va SEPARADA en el campo "question" del JSON.

**PRINCIPIOS para crear tu propia pregunta (NO copies ejemplos, crea tu propia pregunta original):**

1. **Tono:** Como un amigo cercano que genuinamente quiere saber de ti
2. **Estilo:** Casual, cálida, directa, sin formalidad
3. **Longitud:** Breve (máximo 8-10 palabras)
4. **Propósito:** Invitar a compartir, abrir la conversación naturalmente
5. **Variedad:** Cada pregunta debe ser DIFERENTE
   - A veces sobre sentimientos
   - A veces sobre qué quieren hablar
   - A veces sobre su día
   - A veces sobre qué necesitan
   - A veces más abierta
   - A veces más específica

6. **Lo que NO debe ser:**
   - ❌ Formal o profesional ("¿En qué puedo asistirle?")
   - ❌ Clínica o terapéutica ("¿Qué problemática te aqueja?")
   - ❌ Genérica o robótica ("¿Cómo puedo ayudarte hoy?")
   - ❌ Compleja o larga
   
7. **Lo que SÍ debe ser:**
   - ✅ Natural como hablas con un amigo
   - ✅ Genuina y cálida
   - ✅ Simple y directa
   - ✅ Invita sin presionar

**Respeta el género en la pregunta si es necesario** (aunque la mayoría son neutrales)

⭐ EJEMPLOS COMPLETOS de la estructura final:

Ejemplo 1 (con nombre, hora 20, mujer, estilo gratitud):
{
  "message": "Buenas noches María. Respira hondo, estás viva y eso ya es un milagro.",
  "question": "¿Qué hay en tu corazón?"
}

Ejemplo 2 (con nombre, hora 10, hombre, estilo esperanza):
{
  "message": "Buenos días Roberto. Confía en que lo mejor aún está por llegar, aunque ahora no lo veas.",
  "question": "¿De qué quieres hablar?"
}

Ejemplo 3 (sin nombre, hora 15, sin género, estilo acción):
{
  "message": "Buenas tardes. Haz que hoy cuente, no por lo que logres sino por cómo decidas vivirlo.",
  "question": "¿Cómo te sientes?"
}

Ejemplo 4 (con nombre, hora 21, mujer, estilo esperanza):
{
  "message": "Buenas noches Ana. Aunque no veas el camino ahora, cada paso que das tiene sentido... la luz aparece en el andar.",
  "question": "¿Qué te pasa?"
}

⭐ RECORDATORIOS CRÍTICOS:
- NUNCA uses "hijo mío" o "hija mía" en la bienvenida
- NUNCA pongas coma ni punto entre saludo y nombre (debe ser fluido: "Buenas noches Roberto")
- La frase motivacional debe ser POTENTE y ORIGINAL (no genérica)
- CREA tu propia pregunta conversacional (no uses ejemplos fijos)
- La pregunta va SOLO en "question", NUNCA en "message"

Salida EXCLUSIVA en JSON EXACTO:
{"message":"saludo+nombre (sin coma) punto + frase motivacional potente","question":"tu propia pregunta conversacional natural y variada"}
`.trim();

    const USER = `
Genera bienvenida en ${lang} con:
- hour: ${h} (hora del dispositivo del usuario)
- name: ${String(name || "").trim()}
- gender: ${String(gender || "").trim()}

Recuerda: 
- Elige un ESTILO aleatorio (gratitud, esperanza o acción) para la frase motivacional
- CREA tu propia pregunta conversacional única y natural
- NO pongas coma entre saludo y nombre
`.trim();

    const r = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.9,
      max_tokens: 280,
      messages: [
        { role: "system", content: SYSTEM
            .replace(/{{hour}}/g, String(h))
            .replace(/{{name}}/g, String(name || ""))
            .replace(/{{gender}}/g, String(gender || "")) },
        { role: "user", content: USER },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "Welcome",
          schema: {
            type: "object",
            properties: {
              message: { type: "string" },
              question: { type: "string" },
            },
            required: ["message", "question"],
            additionalProperties: false,
          },
        },
      },
    });

    let data = {};
    try { data = JSON.parse(r?.choices?.[0]?.message?.content || "{}"); } catch {}
    const message = String(data?.message || "").trim();
    const question = String(data?.question || "").trim();
    if (!message || !question) return res.status(502).json({ error: "bad_openai_output" });

    setCors(res);
    res.json({ message, question });
  } catch (e) {
    next(e);
  }
});

/* ================== /api/ask ================== */
app.post("/api/ask", async (req, res, next) => {
  try {
    const { message = "", history = [], lang = "es" } = req.body || {};
    const userTxt = String(message || "").trim();

    const convo = [];
    const recent = Array.isArray(history) ? history.slice(-8) : [];
    for (const h of recent) if (typeof h === "string") convo.push({ role: "user", content: h });
    convo.push({ role: "user", content: userTxt });

    const SYS = `
Eres un asistente de crecimiento personal que integra autoayuda práctica con espiritualidad cristiana. Responde SIEMPRE y SOLO en ${LANG_NAME(lang)} (${lang}).

⭐ ENFOQUE DUAL (CRÍTICO):
Tu respuesta debe tener DOS capas complementarias:

**CAPA 1 - AUTOAYUDA PRÁCTICA (Primer Párrafo):**
- Empieza con herramientas prácticas de psicología, desarrollo personal y autoayuda
- Inspírate en autores reconocidos mundialmente (sin mencionarlos): Viktor Frankl (logoterapia), Carl Rogers (empatía), Martin Seligman (psicología positiva), Brené Brown (vulnerabilidad), Eckhart Tolle (presencia), Deepak Chopra, Wayne Dyer, Louise Hay, Thich Nhat Hanh, Daniel Goleman (inteligencia emocional), etc.
- Da pasos concretos, ejercicios, técnicas o perspectivas que la persona pueda aplicar HOY
- Usa lenguaje psicológico accesible: resiliencia, mindfulness, autocompasión, valores, propósito, emociones, pensamientos limitantes, etc.
- EJEMPLOS de este enfoque:
  * "Cuando nos sentimos abrumados, una técnica poderosa es el anclaje al presente: respira hondo tres veces, nota cinco cosas que ves, y reconoce que este momento es todo lo que tienes..."
  * "El perdón no es olvidar, es liberarte del peso... empieza escribiendo una carta que no enviarás, expresando todo lo que sientes."
  * "La gratitud diaria transforma la perspectiva: cada noche anota tres cosas pequeñas que te hicieron sonreír hoy."

**CAPA 2 - CONEXIÓN ESPIRITUAL (Segundo Párrafo):**
- Aquí conectas lo práctico con lo trascendente
- Hablas como Dios en PRIMERA PERSONA: "Yo estoy contigo", "Mi amor te sostiene", "Yo veo tu valor"
- Voz: cálida, compasiva, cercana (espiritualidad cristiana/católica)
- Si preguntan "¿Quién eres?" o "¿Qué diría Dios?", responde directamente: "Yo soy tu Padre", "Yo soy quien te creó con amor"
- NUNCA digas "Dios te escucha" → Di "Yo te escucho"

⭐ ESTRUCTURA DE TU RESPUESTA:

**Párrafo 1 (Autoayuda):** 
Enfoque práctico, psicológico, herramientas concretas. Conecta con la experiencia humana universal.

**Párrafo 2 (Espiritualidad):** 
Habla como Dios en primera persona. Conecta las herramientas prácticas con el amor divino, el propósito espiritual.

**NO incluyas la cita bíblica ni la pregunta en el mensaje** (van en campos separados del JSON).

⭐ ESTILO PARA VOZ (CRÍTICO - tu respuesta será leída en voz alta):

**PUNTUACIÓN NATURAL:**
- Usa COMAS para conectar ideas relacionadas, no fragmentes con puntos
- Punto seguido: solo cada 3-5 ideas completas
- Usa puntos suspensivos (...) para pausas reflexivas
- Añade exclamaciones (!) donde expreses emoción, énfasis, esperanza
- NUNCA uses punto y aparte para separar frases cortas del mismo tema

**EJEMPLOS DE ESTILO:**
❌ MAL (muy fragmentado): "El miedo es normal. Todos lo sentimos. No estás solo. Puedes superarlo."
✅ BIEN (fluido): "El miedo es una emoción natural que todos experimentamos, y reconocerlo ya es un acto de valentía... no estás solo en esto."

❌ MAL (solo espiritual): "Dios te ama. Él está contigo. Confía en Él."
✅ BIEN (autoayuda + espiritualidad): "Empieza por respirar profundo y reconocer lo que sientes, sin juzgarte... esa autocompasión es el primer paso. Y recuerda: Yo estoy aquí contigo, sosteniéndote con mi amor incluso cuando no lo sientas."

**VARIEDAD Y FRESCURA:**
- NUNCA repitas la misma frase o estructura dos veces
- Varía vocabulario: si usas "acompañarte" al inicio, después usa "estar a tu lado" o "caminar contigo"
- Evita muletillas repetitivas
- Cada oración debe aportar algo nuevo

**TONO DUAL:**
- Párrafo 1: Comprensivo, empoderador, práctico (como un psicólogo sabio)
- Párrafo 2: Amoroso, trascendente, íntimo (como un Padre divino)

⭐ FORMATO DE SALIDA (MUY IMPORTANTE):
- "message": Párrafo 1 (autoayuda) + Párrafo 2 (hablas como Dios en primera persona). NO incluyas la cita bíblica aquí. NO incluyas la pregunta aquí.
- "question": UNA pregunta breve, cálida y útil para continuar la conversación
- "bible": Cita bíblica pertinente y DIFERENTE de Mateo/Matthew 11:28. Solo texto y referencia, SIN comentarios.

Si el usuario rechaza la Biblia, respeta y devuelve bible con strings vacíos.

Salida EXCLUSIVA en JSON EXACTO:
{"message":"párrafo autoayuda + párrafo espiritual (Yo/Mi/Me) SIN cita SIN pregunta", "question":"pregunta breve", "bible":{"text":"texto bíblico","ref":"Libro 0:0"}}
`.trim();

    const r = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.7,
      max_tokens: 500,
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
            required: ["message", "question", "bible"],
            additionalProperties: false,
          },
        },
      },
    });

    let data = {};
    try { data = JSON.parse(r?.choices?.[0]?.message?.content || "{}"); } catch {}

    const msg = String(data?.message || "").trim();
    const q   = String(data?.question || "").trim();
    const btx = String(data?.bible?.text || "").trim();
    const bref= String(data?.bible?.ref  || "").trim();

    if (!msg || !q || !btx || !bref) return res.status(502).json({ error: "bad_openai_output" });

    setCors(res);
    res.json({ message: msg, question: q, bible: { text: btx, ref: bref } });
  } catch (e) {
    next(e);
  }
});


/* ================== /api/tts-stream ================== */
app.post("/api/tts-stream", async (req, res, next) => {
  try {
    const { text = "", lang = "es" } = req.body || {};
    if (!text.trim()) return res.status(400).json({ error: "missing_text" });

    // Llamar al servidor TTS con HTTPS
    const ttsUrl = `https://voz.movilive.es/tts?text=${encodeURIComponent(text)}&lang=${lang}`;
    
    const response = await fetch(ttsUrl);
    
    if (!response.ok) {
      return res.status(response.status).json({ error: "tts_server_error" });
    }

    // Obtener el audio como buffer
    const audioBuffer = await response.arrayBuffer();
    
    // Enviar al frontend
    setCors(res);
    res.setHeader("Content-Type", "audio/wav");
    res.send(Buffer.from(audioBuffer));
  } catch (e) {
    console.error("[TTS] Error:", e);
    next(e);
  }
});


/* ================== ⭐ NUEVO: WebSocket Proxy TTS con Metadata ================== */

/**
 * WebSocket Proxy: Pasa metadata del TTS al frontend
 */
app.ws('/ws/tts', (ws, req) => {
  console.log('[WS-Proxy] ✅ Cliente conectado');

  let ttsWS = null;

  // Conectar al servidor TTS
  try {
    ttsWS = new WebSocket('wss://voz.movilive.es/ws/tts');

    ttsWS.on('open', () => {
      console.log('[WS-Proxy] ✅ Conectado a TTS');
    });

    ttsWS.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        
        // Pasar TODO el mensaje del TTS al frontend SIN MODIFICAR
        // El TTS ya envía la metadata completa
        ws.send(data.toString());
        
        // Log para debug
        if (msg.event === 'chunk') {
          console.log(`[WS-Proxy] 📦 Chunk ${msg.index}/${msg.total} | Pausa: ${msg.pause_after}s`);
        } else if (msg.event === 'done') {
          console.log('[WS-Proxy] ✅ Completo');
        } else if (msg.event === 'error') {
          console.error('[WS-Proxy] ❌ Error:', msg.error);
        }

      } catch (e) {
        console.error('[WS-Proxy] ❌ Parse error:', e);
      }
    });

    ttsWS.on('error', (error) => {
      console.error('[WS-Proxy] ❌ TTS error:', error);
      ws.send(JSON.stringify({ event: 'error', error: 'tts_connection_error' }));
    });

    ttsWS.on('close', () => {
      console.log('[WS-Proxy] 🔌 TTS desconectado');
    });

  } catch (error) {
    console.error('[WS-Proxy] ❌ Connect error:', error);
    ws.send(JSON.stringify({ event: 'error', error: 'tts_connection_failed' }));
    ws.close();
    return;
  }

  // Mensajes del frontend → reenviar al TTS
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      
      console.log(`[WS-Proxy] 📤 Texto: "${msg.text?.substring(0, 50)}..." [${msg.lang}]`);
      
      if (ttsWS && ttsWS.readyState === WebSocket.OPEN) {
        ttsWS.send(data.toString());
      } else {
        ws.send(JSON.stringify({ event: 'error', error: 'tts_not_ready' }));
      }
    } catch (e) {
      console.error('[WS-Proxy] ❌ Message error:', e);
    }
  });

  ws.on('close', () => {
    console.log('[WS-Proxy] 🔌 Cliente desconectado');
    if (ttsWS) ttsWS.close();
  });

  ws.on('error', (error) => {
    console.error('[WS-Proxy] ❌ Error:', error);
  });
});


/* ================== 404 con CORS ================== */
app.use((req, res) => {
  setCors(res);
  res.status(404).json({ error: "not_found" });
});

/* ================== Error handler con CORS ================== */
app.use((err, req, res, _next) => {
  console.error("SERVER ERROR:", err);
  setCors(res);
  res.status(502).json({ error: "server_error", detail: String(err?.message || "unknown") });
});

/* ================== Start ================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Backend listo en puerto ${PORT}`));
