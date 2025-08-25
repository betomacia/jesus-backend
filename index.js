// index.js — backend completo con D-ID ACTIVADO + CORS/OPTIONS + logs
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { OpenAI } = require('openai');
const { PassThrough } = require('stream');
const http = require('http');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

/* ---------- Middlewares base ---------- */
app.use(cors({ origin: '*', credentials: false }));
app.options('*', cors());                           // maneja preflight en TODAS las rutas
app.use(express.json({ limit: '2mb' }));

// Logger mínimo para ver método y ruta en logs (Railway)
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});

/* ---------- Keep-alive ---------- */
const httpAgent  = new http.Agent({ keepAlive: true, maxSockets: 80 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 80 });
const agentFor = (url) => (url.startsWith('https:') ? httpsAgent : httpAgent);

// fetch compatible en Node
const nodeFetch = async (...args) => {
  const f = (global.fetch || (await import('node-fetch')).default);
  return f(...args);
};

/* ---------- OpenAI ---------- */
const openai = new OpenAI({
  apiKey: (process.env.OPENAI_API_KEY || '').trim(),
  baseURL: process.env.OPENAI_BASE_URL || undefined,
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

/* =======================================================================
   1) SSE de texto — /api/guide-sse (POST)
   Eventos: start, delta, sentence, done, error
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
          for (const s of flushSentences()) res.write(sseEvent('sentence', { text: s }));
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
      model, voice, input: text, format: audioFormat, language: lang,
    }, {
      fetch: (url, opts) => nodeFetch(url, { ...opts, agent: agentFor(url) }),
    });

    const body = response.body || response;

    if (dl) {
      // descarga completa
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

    // streaming chunked
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
        } catch (e) { passthrough.destroy(e); }
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
   3) D-ID Streaming ACTIVADO — router /api/did/*
   Requiere DID_API_KEY. Autenticación Basic "<key>:"
   ======================================================================= */
const didRouter = express.Router();

function didEnabled() {
  return !!process.env.DID_API_KEY?.trim();
}
function didAuthHeader() {
  const b64 = Buffer.from(`${process.env.DID_API_KEY}:`).toString('base64');
  return `Basic ${b64}`;
}

// Probe rápido para ver estado
didRouter.get('/ping', (_req, res) => {
  res.json({ did: didEnabled() ? 'enabled' : 'disabled' });
});

// Crear stream
didRouter.post('/streams', async (_req, res) => {
  if (!didEnabled()) return res.status(501).json({ error: 'did_disabled', hint: 'Define DID_API_KEY' });
  try {
    const r = await nodeFetch('https://api.d-id.com/v1/streams', {
      method: 'POST',
      headers: { Authorization: didAuthHeader(), 'Content-Type': 'application/json' },
      agent: (u) => agentFor(u),
    });
    const text = await r.text();
    if (!r.ok) return res.status(r.status).send(text);
    return res.status(200).send(text);
  } catch (e) {
    return res.status(502).json({ error: 'did_streams_failed', detail: e?.message || String(e) });
  }
});

// Enviar SDP answer
didRouter.post('/streams/:id/sdp', async (req, res) => {
  if (!didEnabled()) return res.status(501).json({ error: 'did_disabled' });
  const { id } = req.params;
  const { answer, session_id } = req.body || {};
  try {
    const r = await nodeFetch(`https://api.d-id.com/v1/streams/${encodeURIComponent(id)}/sdp`, {
      method: 'POST',
      headers: { Authorization: didAuthHeader(), 'Content-Type': 'application/json' },
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

// Enviar ICE
didRouter.post('/streams/:id/ice', async (req, res) => {
  if (!didEnabled()) return res.status(501).json({ error: 'did_disabled' });
  const { id } = req.params;
  const { candidate, session_id } = req.body || {};
  try {
    const r = await nodeFetch(`https://api.d-id.com/v1/streams/${encodeURIComponent(id)}/ice`, {
      method: 'POST',
      headers: { Authorization: didAuthHeader(), 'Content-Type': 'application/json' },
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

// Hablar (Microsoft)
didRouter.post('/talk-stream', async (req, res) => {
  if (!didEnabled()) return res.status(501).json({ error: 'did_disabled' });
  const { id, session_id, text, lang, voice_id, style, rate, pitch } = req.body || {};
  if (!id || !session_id || !text || !voice_id) {
    return res.status(400).json({ error: 'bad_request', detail: 'id, session_id, text, voice_id requeridos' });
  }
  try {
    const r = await nodeFetch(`https://api.d-id.com/v1/streams/${encodeURIComponent(id)}/talk`, {
      method: 'POST',
      headers: { Authorization: didAuthHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
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
      }),
      agent: (u) => agentFor(u),
    });
    const textRes = await r.text();
    if (!r.ok) return res.status(r.status).send(textRes);
    return res.status(200).send(textRes);
  } catch (e) {
    return res.status(502).json({ error: 'did_talk_failed', detail: e?.message || String(e) });
  }
});

// Monta el router bajo /api/did
app.use('/api/did', didRouter);

/* =======================================================================
   4) Stubs de memoria (evitan 404 mientras no implementes persistencia)
   ======================================================================= */
app.post('/api/memory/sync', (_req, res) => res.json({ ok: true }));
app.post('/api/memory/extract', (_req, res) => res.json({ ok: true, notes: [], topics: [], mood: null }));

/* ---------- 404 debug helper ---------- */
app.use((req, res) => {
  res.status(404).json({
    error: 'not_found',
    path: req.originalUrl,
    hint: 'Revisa método/ruta. Rutas válidas: /healthz, POST /api/guide-sse, GET/POST /api/tts-openai-stream, /api/did/*, /api/memory/*'
  });
});

/* ---------- Start ---------- */
app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
});
