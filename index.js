// index.js — Backend Express con SSE, TTS y D-ID Streaming ACTIVADO
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { OpenAI } = require('openai');
const { PassThrough } = require('stream');
const http = require('http');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*', credentials: false }));
app.use(express.json({ limit: '2mb' }));

// Keep-alive para conexiones largas
const httpAgent  = new http.Agent({ keepAlive: true, maxSockets: 80 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 80 });

// ---------- OpenAI ----------
const openai = new OpenAI({
  apiKey: (process.env.OPENAI_API_KEY || '').trim(),
  baseURL: process.env.OPENAI_BASE_URL || undefined,
});

// ---------- Utils ----------
const nodeFetch = async (...args) => {
  const f = (global.fetch || (await import('node-fetch')).default);
  return f(...args);
};
const agentFor = (url) => (url.startsWith('https:') ? httpsAgent : httpAgent);

app.get('/healthz', (req, res) => res.json({ ok: true }));

/* =======================================================================
   1) SSE de texto — /api/guide-sse  (front llama por POST)
   Emite eventos: start, delta, sentence, done, error
   ======================================================================= */
app.post('/api/guide-sse', async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY?.trim()) {
      res.writeHead(200, sseHeaders());
      res.write(sseEvent('error', { message: 'missing_openai_key' }));
      return res.end();
    }

    const { persona, userText, history = [] } = req.body || {};
    const model = process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini';
    const maxTokens = Number(process.env.OPENAI_MAX_TOKENS || 320);
    const temperature = Number(process.env.OPENAI_TEMPERATURE || 0.4);

    const messages = [
      ...(persona ? [{ role: 'system', content: persona }] : []),
      ...history.map((h) => ({ role: 'user', content: h })),
      { role: 'user', content: String(userText || '') },
    ];

    res.writeHead(200, sseHeaders());
    res.write(`retry: 4000\n\n`);

    const resp = await nodeFetch((process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1') + '/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model, stream: true, messages, temperature, max_tokens: maxTokens }),
      agent: (url) => agentFor(url),
    });

    if (!resp.ok || !resp.body) {
      res.write(sseEvent('error', { status: resp.status, statusText: resp.statusText }));
      return res.end();
    }

    const decoder = new TextDecoder('utf-8');
    const reader = resp.body.getReader();
    let fullText = '';
    let sentenceBuf = '';
    const endOfSentence = (t) => /[.!?…]["')\]]?\s$/.test(t);
    const flushSentences = () => {
      const out = [];
      const parts = sentenceBuf.split(/(?<=[.!?…]["')\]]?)\s+/);
      for (let i = 0; i < parts.length - 1; i++) {
        const s = (parts[i] || '').trim();
        if (s) out.push(s);
      }
      sentenceBuf = parts[parts.length - 1] || '';
      return out;
    };

    res.write(sseEvent('start', { t: Date.now() }));

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });

      for (const line of chunk.split('\n')) {
        const trimmed = line.trimStart();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') {
          if (sentenceBuf.trim()) {
            res.write(sseEvent('sentence', { text: sentenceBuf.trim() }));
            fullText += sentenceBuf;
            sentenceBuf = '';
          }
          break;
        }
        let json;
        try { json = JSON.parse(data); } catch { continue; }
        const delta = json?.choices?.[0]?.delta?.content;
        if (!delta) continue;

        fullText += delta;
        sentenceBuf += delta;

        res.write(sseEvent('delta', { text: delta }));

        if (endOfSentence(sentenceBuf)) {
          const sentences = flushSentences();
          for (const s of sentences) {
            if (s) res.write(sseEvent('sentence', { text: s }));
          }
        }
      }
    }

    res.write(sseEvent('done', { text: fullText.trim() }));
    res.end();
  } catch (err) {
    try {
      res.writeHead(200, sseHeaders());
      res.write(sseEvent('error', { message: err?.message || String(err) }));
      res.end();
    } catch {}
  }
});

function sseHeaders() {
  return {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  };
}
function sseEvent(event, payload) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/* =======================================================================
   2) TTS OpenAI — /api/tts-openai-stream  (GET y POST)
   Query/body: text, voice, lang, format(mp3|wav|opus), dl(0|1)
   Si dl=1 → descarga completa y envía; si no → chunked streaming
   ======================================================================= */
app.get('/api/tts-openai-stream', (req, res) => handleTTS(req, res));
app.post('/api/tts-openai-stream', (req, res) => handleTTS(req, res));

async function handleTTS(req, res) {
  try {
    const q = req.method === 'GET' ? req.query : req.body || {};
    const text   = String(q.text || '');
    const voice  = String(q.voice || 'verse');
    const lang   = String(q.lang || 'es');
    const format = String(q.format || 'mp3'); // mp3|wav|opus
    const dl     = String(q.dl || '0') === '1';

    if (!text.trim()) return res.status(400).json({ error: 'no_text' });
    if (!process.env.OPENAI_API_KEY?.trim()) return res.status(500).json({ error: 'missing_openai_key' });

    const model = process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts';
    const audioFormat = format === 'wav' ? 'wav' : format === 'opus' ? 'opus' : 'mp3';
    const mime = audioFormat === 'wav' ? 'audio/wav'
              : audioFormat === 'opus' ? 'audio/ogg'
              : 'audio/mpeg';

    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'no-store');

    const response = await openai.audio.speech.create({
      model,
      voice,
      input: text,
      format: audioFormat,
      language: lang,
    }, {
      fetch: (url, opts) => nodeFetch(url, { ...opts, agent: agentFor(url) }),
    });

    const body = response.body || response;

    if (dl) {
      // descarga completa (robusto)
      if (body?.arrayBuffer) {
        const ab = await body.arrayBuffer();
        return res.end(Buffer.from(ab));
      }
      const bufs = [];
      const pt = new PassThrough();
      pt.on('data', (c) => bufs.push(c));
      pt.on('end', () => res.end(Buffer.concat(bufs)));
      pt.on('error', () => res.end());
      if (typeof body.pipe === 'function') body.pipe(pt);
      else return res.status(502).json({ error: 'no_stream_body' });
      return;
    }

    // streaming chunked (rápido)
    res.setHeader('Transfer-Encoding', 'chunked');
    if (res.flushHeaders) res.flushHeaders();

    const passthrough = new PassThrough();

    if (body && typeof body.getReader === 'function') {
      const reader = body.getReader();
      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) passthrough.write(Buffer.from(value));
          }
          passthrough.end();
        } catch (e) {
          passthrough.destroy(e);
        }
      })();
    } else if (body && typeof body.pipe === 'function') {
      body.pipe(passthrough);
      body.on('error', (e) => passthrough.destroy(e));
    } else if (body && Buffer.isBuffer(body)) {
      passthrough.end(body);
    } else if (response.arrayBuffer) {
      const ab = await response.arrayBuffer();
      passthrough.end(Buffer.from(ab));
    } else {
      return res.status(502).json({ error: 'no_stream_body' });
    }

    passthrough.pipe(res);
    passthrough.on('error', () => { try { res.end(); } catch {} });

  } catch (err) {
    if (!res.headersSent) res.status(502).json({ error: 'openai_tts_failed', detail: err?.message || String(err) });
    else { try { res.end(); } catch {} }
  }
}

/* =======================================================================
   3) D-ID Streaming ACTIVADO
   Rutas: /api/did/streams, /api/did/streams/:id/sdp, /api/did/streams/:id/ice,
          /api/did/talk-stream
   Nota: Requiere DID_API_KEY. Usamos autenticación Basic: base64("<key>:")
   ======================================================================= */
function requireDID(res) {
  if (!process.env.DID_API_KEY?.trim()) {
    res.status(501).json({ error: 'did_disabled', hint: 'Define DID_API_KEY para habilitar D-ID.' });
    return false;
  }
  return true;
}
function didAuthHeader() {
  // D-ID usa Basic con "<KEY>:" (sin password)
  const b64 = Buffer.from(`${process.env.DID_API_KEY}:`).toString('base64');
  return `Basic ${b64}`;
}

/** Crear stream: devuelve { id, session_id, offer, ice_servers } */
app.post('/api/did/streams', async (req, res) => {
  try {
    if (!requireDID(res)) return;
    const url = 'https://api.d-id.com/v1/streams';
    const r = await nodeFetch(url, {
      method: 'POST',
      headers: {
        Authorization: didAuthHeader(),
        'Content-Type': 'application/json',
      },
      // body vacío está bien
      agent: (u) => agentFor(u),
    });
    const text = await r.text();
    if (!r.ok) return res.status(r.status).send(text);
    // D-ID ya responde con JSON con {id, session_id, offer, ice_servers}
    return res.status(200).send(text);
  } catch (e) {
    return res.status(502).json({ error: 'did_streams_failed', detail: e?.message || String(e) });
  }
});

/** Enviar SDP answer */
app.post('/api/did/streams/:id/sdp', async (req, res) => {
  try {
    if (!requireDID(res)) return;
    const { id } = req.params;
    const { answer, session_id } = req.body || {};
    const url = `https://api.d-id.com/v1/streams/${encodeURIComponent(id)}/sdp`;
    const r = await nodeFetch(url, {
      method: 'POST',
      headers: {
        Authorization: didAuthHeader(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ answer, session_id }),
      agent: (u) => agentFor(u),
    });
    const text = await r.text();
    if (!r.ok) return res.status(r.status).send(text);
    return res.status(200).send(text);
  } catch (e) {
    return res.status(502).json({ error: 'did_sdp_failed', detail: e?.message || String(e) });
  }
});

/** Enviar ICE candidate */
app.post('/api/did/streams/:id/ice', async (req, res) => {
  try {
    if (!requireDID(res)) return;
    const { id } = req.params;
    const { candidate, session_id } = req.body || {};
    const url = `https://api.d-id.com/v1/streams/${encodeURIComponent(id)}/ice`;
    const r = await nodeFetch(url, {
      method: 'POST',
      headers: {
        Authorization: didAuthHeader(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ candidate, session_id }),
      agent: (u) => agentFor(u),
    });
    const text = await r.text();
    if (!r.ok) return res.status(r.status).send(text);
    return res.status(200).send(text);
  } catch (e) {
    return res.status(502).json({ error: 'did_ice_failed', detail: e?.message || String(e) });
  }
});

/**
 * Hablar (texto→voz) dentro del stream.
 * Front manda: { id, session_id, text, lang, voice_id, style, rate, pitch }
 * Proxy a D-ID: POST /v1/streams/:id/talk
 * Body (comúnmente aceptado): script + provider microsoft y voz
 */
app.post('/api/did/talk-stream', async (req, res) => {
  try {
    if (!requireDID(res)) return;
    const { id, session_id, text, lang, voice_id, style, rate, pitch } = req.body || {};
    if (!id || !session_id || !text || !voice_id) {
      return res.status(400).json({ error: 'bad_request', detail: 'id, session_id, text y voice_id son obligatorios' });
    }

    const url = `https://api.d-id.com/v1/streams/${encodeURIComponent(id)}/talk`;
    // Cuerpo basado en el esquema de D-ID Streams (proveedor Microsoft)
    const body = {
      session_id,
      script: {
        type: 'text',
        input: String(text),
        provider: {
          type: 'microsoft',
          voice_id: String(voice_id),
          ...(lang ? { language: String(lang) } : {}),
          ...(style ? { style: String(style) } : {}),
          ...(rate ? { rate: String(rate) } : {}),
          ...(pitch ? { pitch: String(pitch) } : {}),
        },
      },
    };

    const r = await nodeFetch(url, {
      method: 'POST',
      headers: {
        Authorization: didAuthHeader(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      agent: (u) => agentFor(u),
    });
    const textRes = await r.text();
    if (!r.ok) return res.status(r.status).send(textRes);
    return res.status(200).send(textRes);
  } catch (e) {
    return res.status(502).json({ error: 'did_talk_failed', detail: e?.message || String(e) });
  }
});

/* =======================================================================
   4) Stubs de memoria (evitan 404 mientras no implementes persistencia)
   ======================================================================= */
app.post('/api/memory/sync', (req, res) => res.json({ ok: true }));
app.post('/api/memory/extract', (req, res) => res.json({ ok: true, notes: [], topics: [], mood: null }));

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
});
