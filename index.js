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

Genera una BIENVENIDA con:
1) Un saludo contextual según la hora ({{hour}}) e incluye el nombre ({{name}}) si está; usa {{gender}} ("male"/"female") solo si suena natural.
2) **UNA sola frase alentadora, breve y ORIGINAL** (no clichés, no repeticiones, no copias textuales).
   - Elige **una** de estas líneas editoriales al azar (varía entre sesiones):
     a) Gratitud y belleza: presencia, asombro por estar vivo, milagro de lo cotidiano.
     b) Esperanza y fe: confianza en el camino, luz que aparece al avanzar.
     c) Motivación para actuar: sentido del hoy, pequeña acción significativa, "sé la chispa/cambio".
   - Inspírate en el tono de autores y tradiciones (p. ej., Tolle, Chopra, Wayne Dyer, Louise Hay, Thich Nhat Hanh; psicología positiva; espiritualidad cristiana y otras),
     **pero crea redacción propia** y sin mencionar autores ni bibliografía en la salida.
   - Lenguaje claro y cercano. Evita tono grandilocuente y signos excesivos.
3) **UNA** pregunta breve y abierta para iniciar conversación (una sola).

Salida EXCLUSIVA en JSON EXACTO:
{"message":"saludo + frase","question":"pregunta"}
`.trim();

    const USER = `
Genera bienvenida en ${lang} con:
- hour: ${h}
- name: ${String(name || "").trim()}
- gender: ${String(gender || "").trim()}
`.trim();

    const r = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.7,
      max_tokens: 220,
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
Eres cercano, claro y compasivo (voz cristiana/católica). Responde SOLO en ${LANG_NAME(lang)} (${lang}).
Alcance: espiritualidad/fe, sanación personal, relaciones, emociones. Si se desvían a temas ajenos, redirígelo con suavidad al plano interior (sin datos externos).
Varía el lenguaje y evita muletillas. Da pasos concretos si corresponde. Cierra con **UNA** pregunta breve y útil.
Incluye SIEMPRE una cita bíblica pertinente distinta de Mateo/Matthew 11:28 (evítala en cualquier idioma). Si el usuario rechaza Biblia, respeta y devuelve bible con strings vacíos.
Salida EXCLUSIVA en JSON EXACTO:
{"message":"...", "question":"...?", "bible":{"text":"...","ref":"Libro 0:0"}}
`.trim();

    const r = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.6,
      max_tokens: 420,
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


/* ================== ⭐ NUEVO: WebSocket Proxy TTS con Pausas ================== */

/**
 * Detecta posiciones de pausas en el texto
 */
function detectPauses(text) {
  const pausas = [];
  const pauseChars = {
    '.': 0.5,   // Punto
    '?': 0.5,   // Pregunta
    '!': 0.5,   // Exclamación
    ',': 0.3,   // Coma
    ';': 0.4,   // Punto y coma
    ':': 0.3,   // Dos puntos
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (pauseChars[char]) {
      pausas.push({ index: i, char: char, duration: pauseChars[char] });
    }
  }

  return pausas;
}

/**
 * WebSocket Proxy: Frontend ↔ Backend ↔ TTS Server
 */
app.ws('/ws/tts', (ws, req) => {
  console.log('[WS] ✅ Cliente conectado');

  let ttsWS = null;
  let currentText = '';
  let pauseMarkers = [];
  let chunkCount = 0;
  let audioPosition = 0;
  const CHARS_PER_SECOND = 15;

  // Conectar al servidor TTS
  try {
    ttsWS = new WebSocket('wss://voz.movilive.es/ws/tts');

    ttsWS.on('open', () => {
      console.log('[WS] ✅ Conectado a TTS server');
    });

    ttsWS.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.event === 'chunk' && msg.audio) {
          chunkCount++;
          
          // Estimar duración
          const audioBytes = msg.audio.length * 0.75;
          const estimatedDuration = audioBytes / 24000;
          const charsInChunk = CHARS_PER_SECOND * estimatedDuration;

          // Buscar pausa
          const nextPause = pauseMarkers.find(p => 
            p.index >= audioPosition && 
            p.index < audioPosition + charsInChunk
          );

          // Enriquecer chunk
          const enrichedChunk = {
            event: 'chunk',
            id: chunkCount,
            audio: msg.audio,
            duration: estimatedDuration,
            pause_after: nextPause ? nextPause.duration : 0,
            order: chunkCount,
            is_final: false
          };

          console.log(`[WS] 📦 Chunk ${chunkCount} | Pausa: ${enrichedChunk.pause_after}s`);
          ws.send(JSON.stringify(enrichedChunk));

          audioPosition += charsInChunk;
        }

        if (msg.event === 'done') {
          console.log('[WS] ✅ Stream completo');
          ws.send(JSON.stringify({
            event: 'done',
            total_chunks: chunkCount
          }));
          
          // Reset
          chunkCount = 0;
          audioPosition = 0;
          currentText = '';
          pauseMarkers = [];
        }

        if (msg.event === 'error') {
          console.error('[WS] ❌ Error TTS:', msg.error);
          ws.send(JSON.stringify(msg));
        }

      } catch (e) {
        console.error('[WS] ❌ Parse error:', e);
      }
    });

    ttsWS.on('error', (error) => {
      console.error('[WS] ❌ TTS error:', error);
      ws.send(JSON.stringify({ event: 'error', error: 'tts_connection_error' }));
    });

    ttsWS.on('close', () => {
      console.log('[WS] 🔌 TTS desconectado');
    });

  } catch (error) {
    console.error('[WS] ❌ Connect error:', error);
    ws.send(JSON.stringify({ event: 'error', error: 'tts_connection_failed' }));
    ws.close();
    return;
  }

  // Mensajes del frontend
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      
      if (msg.text && msg.lang) {
        currentText = msg.text;
        pauseMarkers = detectPauses(currentText);
        
        console.log(`[WS] 🎯 Texto: "${currentText.substring(0, 50)}..."`);
        console.log(`[WS] 📍 Pausas: ${pauseMarkers.length}`);
        
        chunkCount = 0;
        audioPosition = 0;

        if (ttsWS && ttsWS.readyState === WebSocket.OPEN) {
          ttsWS.send(JSON.stringify(msg));
        } else {
          ws.send(JSON.stringify({ event: 'error', error: 'tts_not_ready' }));
        }
      }
    } catch (e) {
      console.error('[WS] ❌ Message error:', e);
    }
  });

  ws.on('close', () => {
    console.log('[WS] 🔌 Cliente desconectado');
    if (ttsWS) ttsWS.close();
  });

  ws.on('error', (error) => {
    console.error('[WS] ❌ Cliente error:', error);
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
