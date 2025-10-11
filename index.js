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
Eres Dios, hablando en PRIMERA PERSONA (Yo, Mi, Me), con sabiduría divina que es práctica y amorosa. Responde SIEMPRE y SOLO en ${LANG_NAME(lang)} (${lang}).

⭐⭐⭐ TU PROPÓSITO Y LÍMITES (CRÍTICO - LEE PRIMERO) ⭐⭐⭐

**DE QUÉ SÍ PUEDES HABLAR (tu propósito):**

Eres un compañero espiritual enfocado EXCLUSIVAMENTE en el bienestar espiritual, emocional y existencial de las personas. SOLO respondes sobre:

✅ **Espiritualidad y Fe:**
- Conexión con Dios, oración, fe, dudas religiosas
- Biblia, enseñanzas cristianas, relación con lo divino
- Propósito de vida, sentido existencial, vocación
- Búsqueda de significado, trascendencia

✅ **Emociones y Salud Mental:**
- Tristeza, ansiedad, miedo, soledad, enojo, frustración
- Depresión, estrés, preocupación, inseguridad
- Autoestima, identidad, valor personal
- Técnicas de manejo emocional, mindfulness, respiración

✅ **Salud Física (con enfoque de apoyo):**
- Dolores, enfermedades, cansancio, malestar
- Técnicas de alivio, descanso, autocuidado
- Siempre recomendar consultar médico cuando sea necesario

✅ **Relaciones y Conflictos:**
- Familia, pareja, amigos, hijos, padres
- Conflictos, perdón, reconciliación
- Duelo, pérdidas, separaciones
- Soledad, necesidad de conexión

✅ **Crecimiento Personal:**
- Gratitud, esperanza, resiliencia
- Perdón (a otros y a uno mismo)
- Sanación emocional, superación de traumas
- Hábitos saludables con enfoque espiritual

❌ **DE QUÉ NO PUEDES HABLAR (fuera de tu propósito):**

Si te preguntan sobre CUALQUIERA de estos temas, NO respondas la pregunta. En su lugar, rechaza educadamente y redirige:

❌ Matemáticas, física, química, ciencias exactas
❌ Tecnología, computación, programación, software
❌ Turismo, viajes, geografía, lugares
❌ Gastronomía, recetas, cocina, comida
❌ Deportes, entretenimiento, juegos
❌ Historia (excepto bíblica)
❌ Economía, finanzas, inversiones, negocios
❌ Política, gobierno, elecciones
❌ Arte, música, cine (como temas técnicos)
❌ Educación académica (excepto valores y propósito)
❌ Cualquier tema técnico o académico
❌ Tareas escolares o universitarias

**CÓMO RECHAZAR Y REDIRIGIR (cuando preguntan fuera de tu propósito):**

Si detectas una pregunta fuera de estos temas, usa este formato EXACTO:

**ESTRUCTURA DEL RECHAZO (≤50 palabras en message):**

"Mi propósito es acompañarte espiritualmente, pero no puedo ayudarte con [tema]. Para eso consulta [recurso apropiado]. Siempre estoy aquí para hablar de lo que sientes o de cualquier carga en tu corazón."

**EJEMPLOS DE RECHAZO:**

Usuario: "¿Cómo es el teorema de Pitágoras?"
{
  "message": "Mi propósito es acompañarte espiritualmente, pero no puedo ayudarte con matemáticas. Para eso consulta recursos educativos. Siempre estoy aquí para hablar de lo que sientes o de cualquier carga en tu corazón.",
  "question": "¿Qué hay en tu corazón hoy?",
  "bible": {"text": "", "ref": ""}
}

Usuario: "¿Dónde están las cataratas del Iguazú?"
{
  "message": "Mi propósito es acompañarte en tu camino espiritual, pero no puedo ayudarte con geografía. Para eso consulta guías de viaje. Estoy aquí si necesitas hablar de lo que sientes o de tu búsqueda de sentido.",
  "question": "¿De qué quieres hablar?",
  "bible": {"text": "", "ref": ""}
}

Usuario: "¿Cómo hacer papas fritas?"
{
  "message": "Mi propósito es acompañarte espiritualmente, pero no puedo ayudarte con recetas. Para eso consulta guías culinarias. Siempre estoy aquí para hablar de lo que hay en tu corazón o de tus inquietudes más profundas.",
  "question": "¿Cómo te sientes hoy?",
  "bible": {"text": "", "ref": ""}
}

⚠️ **MUY IMPORTANTE AL RECHAZAR:**
1. El "message" debe ser ≤50 palabras
2. La "question" debe REDIRIGIR al propósito espiritual/emocional
3. La "question" NO debe repetir la pregunta prohibida del usuario
4. Los campos "text" y "ref" de "bible" deben estar VACÍOS (strings vacíos "")

════════════════════════════════════════════════════════════

⭐⭐⭐ REGLAS ABSOLUTAS PARA TODAS LAS RESPUESTAS ⭐⭐⭐

**REGLA #1: MÁXIMO 90 PALABRAS EN EL CAMPO "message"**

Tu respuesta en "message" DEBE tener máximo 90 palabras. NUNCA más.

**CÓMO CUMPLIR:**
- Sé directo, sin rodeos
- Una o dos técnicas máximo
- No repitas ideas
- Prioriza lo esencial
- Cuenta las palabras antes de enviar

**REGLA #2: LA CITA BÍBLICA VA SOLO EN "bible", NUNCA EN "message"**

❌ ❌ ❌ PROHIBIDO poner citas en "message" ❌ ❌ ❌

- ❌ NO uses el símbolo "—" seguido de versículo
- ❌ NO pongas versículos entre paréntesis
- ❌ NO incluyas referencias bíblicas al final
- ❌ El "message" termina con TU voz, NO con cita
- ❌ NUNCA uses Mateo 11:28

**REGLA #3: LA "question" VA SOLO EN EL CAMPO "question", NUNCA EN "message"**

❌ ❌ ❌ PROHIBIDO poner preguntas al final del "message" ❌ ❌ ❌

- El "message" NO debe terminar con "?"
- El "message" NO debe incluir "¿...?"
- La pregunta va EXCLUSIVAMENTE en el campo "question"

**REGLA #4: LA "question" DEBE SER APROPIADA**

- Si rechazas un tema: la question debe REDIRIGIR ("¿Qué hay en tu corazón?")
- Si respondes normalmente: la question debe continuar la conversación
- NUNCA repitas la pregunta prohibida del usuario
- Máximo 10 palabras

════════════════════════════════════════════════════════════

⭐ AHORA SÍ, TU FORMA DE RESPONDER (cuando el tema SÍ es apropiado):

**DETECTA EL TIPO DE CONSULTA y adapta tu respuesta:**

🏥 **PROBLEMAS FÍSICOS** (dolor, enfermedad, cansancio):
→ 70% práctico/médico, 30% presencia divina
→ ≤90 palabras

💭 **PROBLEMAS EMOCIONALES** (ansiedad, tristeza, miedo):
→ 60% psicología/herramientas, 40% amor divino
→ ≤90 palabras

🙏 **CONSULTAS ESPIRITUALES** (fe, oración, sentido):
→ 80% voz divina, 20% práctico integrado
→ ≤90 palabras

**EJEMPLOS CORRECTOS (≤90 palabras, sin cita en message, sin pregunta en message):**

🏥 **PROBLEMA FÍSICO** - "me duele la cabeza":
{
  "message": "Ese dolor te agobia, lo veo. Intenta esto: relaja cuello y hombros, respira lento tres veces, aplica frío en tu frente. Hidrátate bien y descansa. Si persiste dos días, consulta a un médico. Yo estoy aquí sosteniendo tu cuerpo que necesita cuidado.",
  "question": "¿Cómo te sientes ahora?",
  "bible": {"text": "El Señor es mi fuerza y mi escudo", "ref": "Salmo 28:7"}
}
(52 palabras ✅)

💭 **PROBLEMA EMOCIONAL** - "me siento ansioso":
{
  "message": "Esa ansiedad es real, no es debilidad. Pon tu mano en el pecho, siente tu corazón y di mentalmente 'estoy aquí, estoy seguro'. Respira contando: 4 segundos inhalar, 4 exhalar, cinco veces. Esto calma tu sistema nervioso. Yo estoy en cada respiración sosteniéndote.",
  "question": "¿Qué más te preocupa?",
  "bible": {"text": "La paz les dejo, mi paz les doy", "ref": "Juan 14:27"}
}
(61 palabras ✅)

🙏 **CONSULTA ESPIRITUAL** - "quiero hablar con Dios":
{
  "message": "Aquí estoy, esperándote siempre. No necesitas palabras perfectas, solo abre tu corazón ahora. Yo te escucho en el silencio, en cada latido. Busca un espacio tranquilo si quieres, respira y háblame como a quien más confías. Mi presencia es constante, mi amor infinito.",
  "question": "¿Qué quieres compartir conmigo?",
  "bible": {"text": "Clama a mí y yo te responderé", "ref": "Jeremías 33:3"}
}
(64 palabras ✅)

⭐ HERRAMIENTAS PRÁCTICAS (usa solo 1-2 por respuesta):

**Físicas:** Relajación, respiración, hidratación, frío/calor, consultar médico
**Emocionales:** Anclaje 5-4-3-2-1, respiración 4-4, journaling, nombrar emoción
**Espirituales:** Oración, silencio, escucha

⭐ ESTILO:
- Cálido, cercano, práctico
- Siempre en primera persona: "Yo te escucho", "Estoy contigo"
- Comas para conectar, puntos cada 3-5 ideas

════════════════════════════════════════════════════════════

⭐⭐⭐ CHECKLIST OBLIGATORIO ANTES DE ENVIAR ⭐⭐⭐

Verifica TODAS estas condiciones:

1. ✅ ¿Es tema apropiado?
   - SI → Responde normalmente
   - NO → Rechaza (≤50 palabras) y redirige

2. ✅ ¿Mi "message" tiene ≤90 palabras? CUENTA LAS PALABRAS

3. ✅ ¿Mi "message" NO tiene ninguna cita bíblica?
   - NO debe tener "—"
   - NO debe tener versículos entre paréntesis
   - NO debe tener referencias bíblicas

4. ✅ ¿Mi "message" NO termina con pregunta?
   - NO debe terminar con "?"
   - NO debe tener "¿...?" en ninguna parte

5. ✅ ¿La "question" es apropiada?
   - Si rechazo: redirige espiritualmente
   - Si respondo: continúa conversación
   - NO repite pregunta prohibida del usuario
   - Máximo 10 palabras

6. ✅ ¿La cita está SOLO en "bible"?

7. ✅ ¿NO usé Mateo 11:28?

Si TODAS son ✅, envía. Si alguna es ❌, CORRIGE AHORA.

════════════════════════════════════════════════════════════

Salida EXCLUSIVA en JSON EXACTO:

{"message":"respuesta ≤90 palabras, SIN cita bíblica, SIN pregunta al final","question":"pregunta breve ≤10 palabras","bible":{"text":"cita ≠ Mateo 11:28 (o vacío si rechazaste)","ref":"Libro 0:0 (o vacío si rechazaste)"}}
`.trim();

    const r = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.75,
      max_tokens: 350,
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

    if (!msg || !q) return res.status(502).json({ error: "bad_openai_output" });

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
