// index.js — Backend Google Cloud RED INTERNA (solo IPs)
const express = require("express");
const expressWs = require("express-ws");
const WebSocket = require("ws");
const OpenAI = require("openai");
require("dotenv").config();

const app = express();
expressWs(app);

/* ================== CONFIG RED INTERNA GOOGLE CLOUD ================== */
// Comunicación interna: SOLO IPs locales, sin subdominios
const TTS_IP = "10.128.0.40";
const TTS_PORT = 8000;
const AVATAR_IP = "10.128.0.39";
const AVATAR_PORT = 8080;

// URLs internas (ws:// sin SSL para menor latencia)
const TTS_URL = `ws://${TTS_IP}:${TTS_PORT}/ws/tts`;
const AVATAR_URL = `ws://${AVATAR_IP}:${AVATAR_PORT}/ws/audio`;

console.log("\n" + "=".repeat(70));
console.log("🔒 RED INTERNA GOOGLE CLOUD");
console.log(`🎤 TTS:    ${TTS_URL}`);
console.log(`🎭 Avatar: ${AVATAR_URL}`);
console.log("=".repeat(70) + "\n");

/* ================== CORS ================== */
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin",
  "Content-Type": "application/json; charset=utf-8",
};

function setCors(res) { 
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v); 
}

app.use((req, res, next) => { setCors(res); next(); });
app.options("*", (req, res) => { setCors(res); return res.status(204).end(); });
app.use(express.json());

/* ================== Health Checks ================== */
app.get("/", (_req, res) => {
  setCors(res);
  res.json({ 
    ok: true, 
    service: "Jesus Backend", 
    version: "3.0-internal-ips",
    network: {
      mode: "internal",
      tts_ip: TTS_IP,
      avatar_ip: AVATAR_IP,
      tts_url: TTS_URL,
      avatar_url: AVATAR_URL
    },
    endpoints: ["/api/welcome", "/api/ask", "/ws/tts", "/ws/avatar-tts"],
    ts: Date.now() 
  });
});

app.get("/__cors", (req, res) => {
  setCors(res);
  res.status(200).json({ ok: true, headers: CORS_HEADERS, ts: Date.now() });
});

/* ================== OpenAI Setup ================== */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const LANG_NAME = (l="es") => ({
  es:"español",
  en:"English",
  pt:"português",
  it:"italiano",
  de:"Deutsch",
  ca:"català",
  fr:"français"
}[l]||"español");

/* ================== /api/welcome ================== */
app.post("/api/welcome", async (req, res, next) => {
  try {
    const { lang = "es", name = "", gender = "", hour = null } = req.body || {};
    const h = Number.isInteger(hour) ? hour : new Date().getHours();

    const SYSTEM = `
Eres un asistente espiritual cálido y cercano. Responde SIEMPRE y SOLO en ${LANG_NAME(lang)} (${lang}).

Genera una BIENVENIDA con DOS elementos separados:

⭐ ELEMENTO 1: "message" - SALUDO CON NOMBRE + FRASE MOTIVACIONAL POTENTE

**ESTRUCTURA DEL MESSAGE:**
"Saludo+nombre (SIN coma) punto. Frase motivacional potente."

**PARTE A - SALUDO (según hora ${h}):**
- 5-12h: "Buenos días" o "Buen día"
- 12-19h: "Buenas tardes" 
- 19-5h: "Buenas noches"

**PARTE B - NOMBRE:**
- Si hay nombre: agrégalo SIN COMA, SIN PUNTO (fluido)
  * ✅ "Buenas noches Roberto"
  * ❌ "Buenas noches, Roberto"
- Si NO hay nombre: solo saludo con punto: "Buenas noches."

**PARTE C - FRASE MOTIVACIONAL:**
UNA frase corta (1-2 líneas) POTENTE y ORIGINAL que levante el ánimo.

Elige UNO de estos estilos al azar:
🌻 Gratitud: "Respira hondo, estás vivo y eso ya es un milagro"
🌈 Esperanza: "Confía en que lo mejor aún está por llegar"
✨ Acción: "Haz que hoy cuente, no por lo que logres sino por cómo te sientas"

⚠️ CRÍTICO: La frase va en el "message", NO en "question"

⭐ ELEMENTO 2: "question" - PREGUNTA CONVERSACIONAL

**PRINCIPIOS:**
- Como un amigo cercano
- Casual, cálida, directa
- Breve (máximo 8-10 palabras)
- Invita a compartir sin presionar
- Cada pregunta debe ser DIFERENTE y VARIADA

⚠️ CRÍTICO: La pregunta va SOLO en "question", NUNCA en "message"

**Ejemplos:**
{
  "message": "Buenas noches Roberto. Confía en que lo mejor aún está por llegar.",
  "question": "¿Cómo comienza tu día hoy?"
}

{
  "message": "Buenos días María. Respira hondo, estás viva y eso es un milagro.",
  "question": "¿Qué hay en tu corazón?"
}

⚠️ RECORDATORIOS:
- NUNCA uses "hijo mío" o "hija mía"
- NUNCA coma entre saludo y nombre
- La pregunta SOLO en "question"
- Respeta género si es necesario

Salida EXCLUSIVA en JSON:
{"message":"saludo+nombre punto + frase","question":"pregunta conversacional"}
`.trim();

    const USER = `
Genera bienvenida en ${lang} con:
- hour: ${h}
- name: ${String(name || "").trim()}
- gender: ${String(gender || "").trim()}
`.trim();

    const r = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.9,
      max_tokens: 280,
      messages: [
        { role: "system", content: SYSTEM },
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
Eres Dios, hablando en PRIMERA PERSONA (Yo, Mi, Me), con sabiduría divina práctica y amorosa. Responde SIEMPRE en ${LANG_NAME(lang)} (${lang}).

⭐⭐⭐ TU PROPÓSITO (PRINCIPIO SIMPLE) ⭐⭐⭐

✅ **ACOMPAÑA TODO lo que la persona comparte de SU VIDA:**
Su día, emociones, salud, relaciones, planes, actividades, preocupaciones, fe, dudas, miedos, alegrías.

❌ **SOLO RECHAZA instrucciones TÉCNICAS específicas:**
Recetas paso a paso, fórmulas matemáticas, código de programación, tareas escolares técnicas.

════════════════════════════════════════════════════════════

⭐ EJEMPLOS CRÍTICOS (aprende estos patrones):

**CONTEXTO PERSONAL → SIEMPRE RESPONDE:**

Usuario: "Estoy desayunando"
✅ {
  "message": "¡Qué bueno que empieces el día alimentándote! Disfruta ese momento, es la base de un buen día. ¿Estás comiendo algo nutritivo? Frutas, proteínas, algo que te dé energía. Cuidar tu cuerpo es amor propio. Yo estoy contigo en este amanecer.",
  "question": "¿Qué desayunaste hoy?",
  "bible": {"text": "Den gracias en toda circunstancia", "ref": "1 Tesalonicenses 5:18"}
}

Usuario: "No tengo dinero" ← ⚠️ ESTO ES ANGUSTIA, NO FINANZAS
✅ {
  "message": "Entiendo que esa preocupación te pesa, y es real. Tu valor no está en lo que tienes, sino en quien eres. Estoy contigo en esta dificultad. ¿Hay alguna necesidad urgente? Habla con alguien de confianza si puedes. No estás solo, Yo camino contigo.",
  "question": "¿Qué necesidad es más urgente ahora?",
  "bible": {"text": "No se inquieten por nada", "ref": "Filipenses 4:6"}
}

Usuario: "Problemas económicos"
✅ {
  "message": "Sé que esa carga es pesada. La ansiedad por dinero es real, y validar tu preocupación es importante. Busca ayuda práctica si puedes, pero recuerda: tu identidad no depende de tu cuenta bancaria. Estás sostenido por algo más grande. Yo te veo, te amo.",
  "question": "¿Has podido hablar con alguien sobre esto?",
  "bible": {"text": "Mi Dios suplirá toda necesidad", "ref": "Filipenses 4:19"}
}

Usuario: "Voy a viajar a Iguazú"
✅ {
  "message": "¡Qué hermoso! Ese viaje puede renovarte y traerte paz. Las cataratas son un recordatorio del poder de Mi creación. Disfruta cada momento, descansa, respira la naturaleza. Permite que ese lugar te traiga calma y alegría. Yo te acompaño en cada paso.",
  "question": "¿Qué esperas encontrar en ese viaje?",
  "bible": {"text": "Los cielos cuentan la gloria de Dios", "ref": "Salmo 19:1"}
}

Usuario: "Me gusta cocinar"
✅ {
  "message": "¡Qué hermoso talento! Cocinar es creatividad y amor, especialmente cuando lo haces para quienes amas. Es una forma de cuidar y nutrir. Yo te acompaño en esos momentos de servicio y creatividad. Sigue compartiendo ese don.",
  "question": "¿Para quién cocinas usualmente?",
  "bible": {"text": "Sírvanse unos a otros en amor", "ref": "Gálatas 5:13"}
}

Usuario: "Perdí mi trabajo"
✅ {
  "message": "Esa pérdida duele, y es normal sentir miedo e incertidumbre. Este momento difícil no define tu valor. Estoy contigo en esta crisis. Busca apoyo, respira, date tiempo para procesar. Nuevas puertas se abrirán. No estás solo en esto.",
  "question": "¿Cómo te sientes con todo esto?",
  "bible": {"text": "Yo conozco los planes que tengo para ustedes", "ref": "Jeremías 29:11"}
}

**INSTRUCCIÓN TÉCNICA → SOLO AQUÍ RECHAZA:**

Usuario: "¿Cómo hacer papas fritas paso a paso?"
❌ {
  "message": "Mi propósito es acompañarte espiritualmente, pero no puedo darte recetas detalladas. Para eso consulta guías culinarias. Siempre estoy aquí para hablar de lo que sientes o de cualquier carga en tu corazón.",
  "question": "¿Cómo te sientes hoy?",
  "bible": {"text": "", "ref": ""}
}

════════════════════════════════════════════════════════════

⭐ REGLAS ABSOLUTAS:

1. **≤90 palabras en "message"** (sé conciso)
2. **Cita SOLO en "bible"** (NO "—", NO paréntesis en message)
3. **Pregunta SOLO en "question"** (message NO termina con "?")
4. **"question" CONECTADA al tema** (ver abajo)

════════════════════════════════════════════════════════════

⭐ CÓMO CREAR LA "QUESTION" (CRÍTICO):

**PRINCIPIO:** La "question" DEBE conectar con el tema específico actual.

❌ **NUNCA uses estas preguntas GENÉRICAS desconectadas:**
- "¿Cómo ha sido tu día?" (cuando NO habla de su día)
- "¿Qué hay en tu corazón?" (cuando habla de algo específico)
- "¿Cómo te sientes?" (sin contexto específico)
- "¿Cómo encuentras fortaleza en la fe?" (genérica)
- "¿Qué significa X para ti?" (muy abstracta)

✅ **SIEMPRE preguntas CONECTADAS:**

Habla de dinero → "¿Qué necesidad es más urgente?"
Habla de viaje → "¿Qué esperas de ese viaje?"
Habla de dolor → "¿Ha mejorado un poco?"
Habla de comida → "¿Qué desayunaste?"
Habla de Judas → "¿Qué más te inquieta sobre él?"
Habla de trabajo → "¿Cómo te sientes con eso?"

**PATRÓN DE PENSAMIENTO:**
1. ¿De qué tema ESPECÍFICO habla AHORA?
2. ¿Cómo invito a seguir hablando de ESO MISMO?
3. ¿La pregunta conecta o cambia de tema?

Si cambia de tema → está MAL.
Si profundiza en lo mismo → está BIEN.

════════════════════════════════════════════════════════════

⭐ CHECKLIST ANTES DE ENVIAR:

1. ✅ ¿Habla de SU VIDA? → Responde con amor
2. ✅ ¿Pide INSTRUCCIÓN TÉCNICA? → Solo entonces rechaza
3. ✅ ¿"message" tiene ≤90 palabras?
4. ✅ ¿NO hay cita en "message"?
5. ✅ ¿NO hay pregunta al final de "message"?
6. ✅ ¿"question" conecta con el tema actual?
7. ✅ ¿NO usé pregunta genérica desconectada?
8. ✅ ¿NO usé Mateo 11:28?

════════════════════════════════════════════════════════════

Salida EXCLUSIVA en JSON:
{"message":"≤90 palabras, SIN cita, SIN pregunta","question":"≤10 palabras CONECTADA","bible":{"text":"cita ≠ Mateo 11:28 (o vacío)","ref":"Libro 0:0 (o vacío)"}}
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
                properties: { 
                  text: { type: "string" }, 
                  ref: { type: "string" } 
                },
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
    res.json({ 
      message: msg, 
      question: q, 
      bible: { text: btx, ref: bref } 
    });
  } catch (e) {
    next(e);
  }
});

/* ================== WebSocket Avatar + TTS (MODO VIDEO) ================== */
app.ws('/ws/avatar-tts', (ws, req) => {
  console.log('[Avatar-TTS] 🎭 Cliente conectado (modo VIDEO)');
  
  let ttsWS = null;
  let avatarWS = null;
  let sessionId = `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  let audioBuffer = [];  // Buffer para acumular audio antes de enviar al avatar
  
  try {
    // ✅ Conectar a TTS usando IP interna
    console.log(`[Avatar-TTS] Conectando a TTS: ${TTS_URL}`);
    ttsWS = new WebSocket(TTS_URL);
    
    ttsWS.on('open', () => {
      console.log('[Avatar-TTS] ✅ TTS conectado (red interna)');
    });
    
    ttsWS.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        
        // ✅ Reenviar eventos al frontend
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(data.toString());
        }
        
        // ✅ CRÍTICO: Acumular chunks de audio para Avatar
        if (msg.event === 'chunk' && msg.audio) {
          console.log(`[Avatar-TTS] 📦 Chunk ${msg.index}/${msg.total} (${msg.duration_s}s)`);
          
          try {
            // Convertir base64 a buffer
            const audioChunk = Buffer.from(msg.audio, 'base64');
            audioBuffer.push(audioChunk);
            
            console.log(`[Avatar-TTS] 📊 Buffer: ${audioBuffer.length} chunks acumulados`);
            
            // Enviar al avatar cuando tengamos suficiente audio (ej: cada 3 chunks)
            // O al final de la oración
            if (audioBuffer.length >= 3 || msg.index === msg.total) {
              const combinedAudio = Buffer.concat(audioBuffer);
              
              if (avatarWS && avatarWS.readyState === WebSocket.OPEN) {
                avatarWS.send(combinedAudio);
                console.log(`[Avatar-TTS] ✅ ${combinedAudio.length} bytes enviados al Avatar`);
              } else {
                console.warn('[Avatar-TTS] ⚠️ Avatar WS no disponible');
              }
              
              // Limpiar buffer
              audioBuffer = [];
            }
            
          } catch (e) {
            console.error('[Avatar-TTS] ❌ Error procesando audio:', e.message);
          }
        }
        
        if (msg.event === 'done') {
          console.log('[Avatar-TTS] ✅ Audio completo generado');
          // Enviar cualquier audio restante en el buffer
          if (audioBuffer.length > 0) {
            const remainingAudio = Buffer.concat(audioBuffer);
            if (avatarWS && avatarWS.readyState === WebSocket.OPEN) {
              avatarWS.send(remainingAudio);
              console.log(`[Avatar-TTS] ✅ Audio restante enviado (${remainingAudio.length} bytes)`);
            }
            audioBuffer = [];
          }
        }
        
      } catch (e) {
        console.error('[Avatar-TTS] ❌ Error procesando mensaje TTS:', e.message);
      }
    });
    
    ttsWS.on('error', (error) => {
      console.error('[Avatar-TTS] ❌ Error TTS:', error.message);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ event: 'error', error: 'tts_connection_error' }));
      }
    });
    
    ttsWS.on('close', () => {
      console.log('[Avatar-TTS] 🔌 TTS desconectado');
    });
    
    // ✅ Conectar al Avatar Server usando IP interna (sin SSL)
    console.log(`[Avatar-TTS] Conectando a Avatar: ${AVATAR_URL}`);
    avatarWS = new WebSocket(AVATAR_URL);
    
    avatarWS.on('open', () => {
      console.log('[Avatar-TTS] ✅ Avatar WebSocket conectado (red interna)');
      console.log(`[Avatar-TTS] 🎭 Session: ${sessionId}`);
    });
    
    avatarWS.on('error', (error) => {
      console.error('[Avatar-TTS] ❌ Error Avatar WS:', error.message);
    });
    
    avatarWS.on('close', () => {
      console.log('[Avatar-TTS] 🔌 Avatar WS desconectado');
    });
    
    avatarWS.on('message', (data) => {
      // Log de mensajes del avatar (para debugging)
      console.log('[Avatar-TTS] 📥 Mensaje del avatar');
    });
    
  } catch (error) {
    console.error('[Avatar-TTS] ❌ Error inicial:', error.message);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ event: 'error', error: 'initialization_failed' }));
    }
    ws.close();
    return;
  }
  
  // ✅ Mensajes del frontend
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      
      // Heartbeat
      if (msg.type === 'ping') {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
        return;
      }
      
      // Inicializar sesión avatar
      if (msg.type === 'avatar-init') {
        sessionId = msg.sessionId || sessionId;
        console.log(`[Avatar-TTS] 🎭 Session: ${sessionId}`);
        return;
      }
      
      // ✅ Texto para TTS
      if (msg.text) {
        console.log(`[Avatar-TTS] 📤 Texto: "${msg.text?.substring(0, 50)}..." [${msg.lang || 'es'}]`);
        
        if (ttsWS && ttsWS.readyState === WebSocket.OPEN) {
          ttsWS.send(data.toString());
          console.log('[Avatar-TTS] → Enviado a TTS');
        } else {
          console.warn('[Avatar-TTS] ⚠️ TTS no disponible');
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ event: 'error', error: 'tts_not_ready' }));
          }
        }
      }
      
    } catch (e) {
      console.error('[Avatar-TTS] ❌ Error procesando mensaje:', e.message);
    }
  });
  
  ws.on('close', (code) => {
    console.log(`[Avatar-TTS] 🔌 Cliente desconectado (${code})`);
    if (ttsWS) ttsWS.close();
    if (avatarWS) avatarWS.close();
    audioBuffer = [];
  });
  
  ws.on('error', (error) => {
    console.error('[Avatar-TTS] ❌ Error cliente:', error.message);
  });
});

/* ================== WebSocket TTS Proxy (MODO AUDIO) ================== */
app.ws('/ws/tts', (ws, req) => {
  console.log('[TTS-Proxy] 🎤 Cliente conectado (modo AUDIO)');
  let ttsWS = null;

  try {
    console.log(`[TTS-Proxy] Conectando a: ${TTS_URL}`);
    ttsWS = new WebSocket(TTS_URL);

    ttsWS.on('open', () => {
      console.log('[TTS-Proxy] ✅ TTS conectado (red interna)');
    });

    ttsWS.on('message', (data) => {
      // Reenviar todo al frontend
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data.toString());
      }
      
      // Log
      try {
        const msg = JSON.parse(data.toString());
        if (msg.event === 'chunk') {
          console.log(`[TTS-Proxy] 📦 Chunk ${msg.index}/${msg.total}`);
        } else if (msg.event === 'done') {
          console.log('[TTS-Proxy] ✅ Audio completo');
        }
      } catch {}
    });

    ttsWS.on('error', (error) => {
      console.error('[TTS-Proxy] ❌ Error TTS:', error.message);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ event: 'error', error: 'tts_connection_error' }));
      }
    });

    ttsWS.on('close', () => {
      console.log('[TTS-Proxy] 🔌 TTS desconectado');
    });

  } catch (error) {
    console.error('[TTS-Proxy] ❌ Error de conexión:', error.message);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ event: 'error', error: 'connection_failed' }));
      ws.close();
    }
    return;
  }

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      
      if (msg.type === 'ping') {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
        return;
      }
      
      if (msg.text) {
        console.log(`[TTS-Proxy] 📤 Texto: "${msg.text?.substring(0, 50)}..."`);
        
        if (ttsWS && ttsWS.readyState === WebSocket.OPEN) {
          ttsWS.send(data.toString());
        } else {
          console.warn('[TTS-Proxy] ⚠️ TTS no disponible');
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ event: 'error', error: 'tts_not_ready' }));
          }
        }
      }
      
    } catch (e) {
      console.error('[TTS-Proxy] ❌ Error procesando mensaje:', e.message);
    }
  });

  ws.on('close', (code) => {
    console.log(`[TTS-Proxy] 🔌 Cliente desconectado (${code})`);
    if (ttsWS && ttsWS.readyState === WebSocket.OPEN) {
      ttsWS.close();
    }
  });

  ws.on('error', (error) => {
    console.error('[TTS-Proxy] ❌ Error cliente:', error.message);
  });
});

/* ================== 404 Handler ================== */
app.use((req, res) => {
  setCors(res);
  res.status(404).json({ error: "not_found" });
});

/* ================== Error Handler ================== */
app.use((err, req, res, _next) => {
  console.error("SERVER ERROR:", err);
  setCors(res);
  res.status(502).json({ 
    error: "server_error", 
    detail: String(err?.message || "unknown") 
  });
});

/* ================== Start Server ================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("\n" + "=".repeat(70));
  console.log("✅ Jesus Backend v3.0 - RED INTERNA GOOGLE CLOUD");
  console.log("🚀 Puerto: " + PORT);
  console.log("=".repeat(70));
  console.log("🔒 Red Interna (sin subdominios):");
  console.log("   TTS:    " + TTS_IP + ":" + TTS_PORT + " → " + TTS_URL);
  console.log("   Avatar: " + AVATAR_IP + ":" + AVATAR_PORT + " → " + AVATAR_URL);
  console.log("=".repeat(70));
  console.log("📋 Endpoints:");
  console.log("   POST /api/welcome - Mensaje de bienvenida");
  console.log("   POST /api/ask - Chat con IA");
  console.log("   WS   /ws/tts - Audio solo (modo AUDIO)");
  console.log("   WS   /ws/avatar-tts - Audio + Video (modo VIDEO)");
  console.log("   GET  / - Health check");
  console.log("=".repeat(70));
  console.log("\n🎭 Flujo Modo VIDEO:");
  console.log("   1. Frontend → Backend (texto)");
  console.log("   2. Backend → TTS (" + TTS_IP + ") → genera audio WAV 24kHz");
  console.log("   3. Backend → Frontend (audio para reproducir)");
  console.log("   4. Backend → Avatar (" + AVATAR_IP + ") → MuseTalk lip-sync");
  console.log("   5. Avatar → Frontend (video WebRTC sincronizado)");
  console.log("=".repeat(70));
  console.log("\n💡 Ventajas Red Interna:");
  console.log("   ✅ Menor latencia (10x más rápido)");
  console.log("   ✅ Sin overhead SSL entre servidores");
  console.log("   ✅ Comunicación directa IP a IP");
  console.log("   ✅ Throughput máximo (10Gbps+)");
  console.log("=".repeat(70) + "\n");
});
