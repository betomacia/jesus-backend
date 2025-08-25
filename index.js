// index.js — Backend Express con SSE + TTS streaming
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { OpenAI } = require('openai');
const { PassThrough } = require('stream');
const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3000;
const app = express();

app.use(cors({ origin: '*', credentials: false }));
app.use(express.json({ limit: '1mb' }));

// Keep-alive para conexiones largas
const httpAgent  = new http.Agent({ keepAlive: true, maxSockets: 50 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });

// ---------- OpenAI ----------
const openai = new OpenAI({
  apiKey: (process.env.OPENAI_API_KEY || '').trim(),
  baseURL: process.env.OPENAI_BASE_URL || undefined,
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

// ===============================
// 1) SSE de texto: /api/guide-sse
// ===============================
app.post('/api/guide-sse', async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY?.trim()) {
      res.writeHead(500, sseHeaders());
      res.write(sseEvent('error', { message: 'missing_openai_key' }));
      return res.end();
    }

    const { persona, userText, history = [] } = req.body || {};
    const model = process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini';
    const maxTokens = Number(process.env.OPENAI_MAX_TOKENS || 320);
    const temperature = Number(process.env.OPENAI_TEMPERATURE || 0.4);

    const messages = [
      ...(persona ? [{ role: 'system', content: persona }] : []),
      ...history.map(h => ({ role: 'user', content: h })),
      { role: 'user', content: userText || '' },
    ];

    res.writeHead(200, sseHeaders());
    res.write(`retry: 4000\n\n`); // reconectar en 4s si se corta

    // Llamada directa a Chat Completions en modo stream
    const fetch = global.fetch || (await import('node-fetch')).default;
    const resp = await fetch((process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1') + '/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        stream: true,
        messages,
        temperature,
        max_tokens: maxTokens,
      }),
      agent: (url) => url.startsWith('https:') ? httpsAgent : httpAgent,
    });

    if (!resp.ok || !resp.body) {
      res.write(sseEvent('error', { status: resp.status, statusText: resp.statusText }));
      return res.end();
    }

    const decoder = new TextDecoder('utf-8');
    const reader = resp.body.getReader();

    let fullText = '';
    let sentenceBuf = '';

    const isEndOfSentence = (t) => /[.!?…]["')\]]?\s$/.test(t);

    const flushSentences = () => {
      const out = [];
      // separa por signos y mantiene espacios
      const parts = sentenceBuf.split(/(?<=[.!?…]["')\]]?)\s+/);
      // todas menos la última si no cierra
      for (let i = 0; i < parts.length - 1; i++) {
        const s = parts[i].trim();
        if (s) out.push(s);
      }
      // conserva el resto en buffer
      sentenceBuf = parts[parts.length - 1] || '';
      return out;
    };

    res.write(sseEvent('start', { t: Date.now() }));

    // Parse del SSE de OpenAI
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });

      for (const line of chunk.split('\n')) {
        const trimmed = line.trimStart();
        if (!trimmed.startsWith('data:')) continue;

        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') {
          // emitir lo que quede como última oración si aplica
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

        // delta inmediato para pintar typing
        res.write(sseEvent('delta', { text: delta }));

        // si cerró oración → emítela para TTS inmediato
        if (isEndOfSentence(sentenceBuf)) {
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
    'X-Accel-Buffering': 'no', // Nginx
  };
}
function sseEvent(event, payload) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

// ============================================
// 2) TTS OpenAI streaming (MP3) /api/tts-openai-stream
//    Soporta ?format=mp3|wav|opus y ?dl=1 para forzar descarga completa
// ============================================
app.get('/api/tts-openai-stream', async (req, res) => {
  try {
    const text = String(req.query.text || '');
    const voice = String(req.query.voice || 'verse');
    const lang = String(req.query.lang || 'es');
    const format = String(req.query.format || 'mp3'); // mp3|wav|opus
    const dl = String(req.query.dl || '0') === '1';

    if (!text.trim()) return res.status(400).json({ error: 'no_text' });
    if (!process.env.OPENAI_API_KEY?.trim()) return res.status(500).json({ error: 'missing_openai_key' });

    const model = process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts';
    const audioFormat = format === 'wav' ? 'wav' : format === 'opus' ? 'opus' : 'mp3';
    const mime = audioFormat === 'wav' ? 'audio/wav'
              : audioFormat === 'opus' ? 'audio/ogg'
              : 'audio/mpeg';

    // Cabeceras
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'no-store');

    // Llamada
    const response = await openai.audio.speech.create({
      model,
      voice,
      input: text,
      format: audioFormat,
      language: lang,
    }, {
      fetch: (url, opts) => {
        const agent = url.startsWith('https:') ? httpsAgent : httpAgent;
        return fetch(url, { ...opts, agent });
      },
    });

    // Normalizar body
    const body = response.body || response;

    if (dl) {
      // Modo robusto: descarga completa y envía
      if (body?.arrayBuffer) {
        const ab = await body.arrayBuffer();
        return res.end(Buffer.from(ab));
      }
      // Fallback read stream
      const bufs = [];
      const passthrough = new PassThrough();
      passthrough.on('data', (c) => bufs.push(c));
      passthrough.on('end', () => res.end(Buffer.concat(bufs)));
      passthrough.on('error', () => res.end());
      if (typeof body.pipe === 'function') body.pipe(passthrough);
      else return res.status(502).json({ error: 'no_stream_body' });
      return;
    }

    // Modo rápido: pipe chunked
    res.setHeader('Transfer-Encoding', 'chunked');
    if (res.flushHeaders) res.flushHeaders();

    const passthrough = new PassThrough();

    if (body && typeof body.getReader === 'function') {
      // WebStream → Node
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
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
});
