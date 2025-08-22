// routes/did.js
const express = require('express');
const router = express.Router();

// Usamos fetch nativo (Node 18+); si prefieres node-fetch@2, impórtalo aquí.
const DID_BASE = 'https://api.d-id.com';

/* =========================
   Credenciales D-ID (flexible)
   ========================= */
const DID_API_KEY_RAW = process.env.DID_API_KEY || '';
let DID_USER = process.env.DID_USERNAME || '';
let DID_PASS = process.env.DID_PASSWORD || '';

// Si solo nos dan DID_API_KEY en formato "user:pass", partirla
if ((!DID_USER || !DID_PASS) && DID_API_KEY_RAW.includes(':')) {
  const [u, p] = DID_API_KEY_RAW.split(':', 2);
  DID_USER = DID_USER || u;
  DID_PASS = DID_PASS || p;
}

function buildAuthHeader() {
  // 1) Preferimos user:pass
  if (DID_USER && DID_PASS) {
    const b64 = Buffer.from(`${DID_USER}:${DID_PASS}`).toString('base64');
    return `Basic ${b64}`;
  }
  // 2) Si hay DID_API_KEY pero no user/pass
  if (DID_API_KEY_RAW) {
    // a) Si parece base64: úsalo tal cual
    const looksB64 = /^[A-Za-z0-9+/]+=*$/.test(DID_API_KEY_RAW) && (DID_API_KEY_RAW.length % 4 === 0);
    if (looksB64) return `Basic ${DID_API_KEY_RAW}`;
    // b) Si parece "apikey" plano: codificar como "apikey:"
    const b64 = Buffer.from(`${DID_API_KEY_RAW}:`).toString('base64');
    return `Basic ${b64}`;
  }
  return null;
}
const didAuthHeader = buildAuthHeader();

if (!didAuthHeader) {
  console.warn('[D-ID] Faltan credenciales. Define DID_USERNAME y DID_PASSWORD o DID_API_KEY en Railway.');
}

/* =========================
   Helpers
   ========================= */
function didHeaders() {
  return {
    'Authorization': didAuthHeader,
    'Content-Type': 'application/json',
  };
}

// Imagen por defecto (tu Jesús). Si no envías body en /streams, usamos esta.
const DEFAULT_SOURCE_URL =
  'https://raw.githubusercontent.com/betomacia/imagen-jesus/refs/heads/main/jesus.jpg';

/* =========================
   Endpoint de verificación rápida (créditos)
   GET /api/did/credits
   ========================= */
router.get('/credits', async (_req, res) => {
  try {
    if (!didAuthHeader) return res.status(500).json({ error: 'missing_did_credentials' });
    const r = await fetch(`${DID_BASE}/credits`, { headers: { Authorization: didAuthHeader } });
    const txt = await r.text();
    res.status(r.status).type('application/json').send(txt);
  } catch (e) {
    console.error('DID /credits error:', e);
    res.status(500).json({ error: 'credits_check_failed', detail: String(e && e.message ? e.message : e) });
  }
});

/* =========================
   1) Crear stream
   POST /api/did/streams
   body opcional: { source_url }
   ========================= */
router.post('/streams', async (req, res) => {
  try {
    if (!didAuthHeader) return res.status(500).json({ error: 'missing_did_credentials' });
    const { source_url } = req.body || {};
    const r = await fetch(`${DID_BASE}/talks/streams`, {
      method: 'POST',
      headers: didHeaders(),
      body: JSON.stringify({
        source_url: source_url || DEFAULT_SOURCE_URL
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json(data);

    // D-ID devuelve id, session_id, offer, ice_servers
    return res.json({
      id: data.id,
      session_id: data.session_id,
      offer: data.offer,
      ice_servers: data.ice_servers || [],
    });
  } catch (e) {
    console.error('DID /streams error:', e);
    return res.status(500).json({ error: 'streams_failed', detail: String(e && e.message ? e.message : e) });
  }
});

/* =========================
   2) Enviar SDP answer
   POST /api/did/streams/:id/sdp
   body: { answer, session_id }
   ========================= */
router.post('/streams/:id/sdp', async (req, res) => {
  try {
    if (!didAuthHeader) return res.status(500).json({ error: 'missing_did_credentials' });
    const { id } = req.params;
    const { answer, session_id } = req.body || {};
    const r = await fetch(`${DID_BASE}/talks/streams/${encodeURIComponent(id)}/sdp`, {
      method: 'POST',
      headers: didHeaders(),
      body: JSON.stringify({ answer, session_id }),
    });
    const data = await r.json().catch(() => ({}));
    return res.status(r.status).json(data);
  } catch (e) {
    console.error('DID /sdp error:', e);
    return res.status(500).json({ error: 'sdp_failed', detail: String(e && e.message ? e.message : e) });
  }
});

/* =========================
   3) Enviar ICE candidates
   POST /api/did/streams/:id/ice
   body: { candidate, session_id }
   ========================= */
router.post('/streams/:id/ice', async (req, res) => {
  try {
    if (!didAuthHeader) return res.status(500).json({ error: 'missing_did_credentials' });
    const { id } = req.params;
    const { candidate, session_id } = req.body || {};
    const r = await fetch(`${DID_BASE}/talks/streams/${encodeURIComponent(id)}/ice`, {
      method: 'POST',
      headers: didHeaders(),
      body: JSON.stringify({ candidate, session_id }),
    });
    const data = await r.json().catch(() => ({}));
    return res.status(r.status).json(data);
  } catch (e) {
    console.error('DID /ice error:', e);
    return res.status(500).json({ error: 'ice_failed', detail: String(e && e.message ? e.message : e) });
  }
});

/* =========================
   4) Hablar en la sesión
   POST /api/did/streams/:id/talk
   body: { session_id, script, driver_url?, config?, voice? }
   ========================= */
router.post('/streams/:id', async (req, res) => {
  // alias por compatibilidad: /streams/:id -> talk
  return router.handle({ ...req, url: `/streams/${req.params.id}/talk` }, res);
});

router.post('/streams/:id/talk', async (req, res) => {
  try {
    if (!didAuthHeader) return res.status(500).json({ error: 'missing_did_credentials' });
    const { id } = req.params;
    const { session_id, script, driver_url, config, voice } = req.body || {};

    const r = await fetch(`${DID_BASE}/talks/streams/${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: didHeaders(),
      body: JSON.stringify({ session_id, script, driver_url, config, voice }),
    });
    const data = await r.json().catch(() => ({}));
    return res.status(r.status).json(data);
  } catch (e) {
    console.error('DID /talk error:', e);
    return res.status(500).json({ error: 'talk_failed', detail: String(e && e.message ? e.message : e) });
  }
});

module.exports = router;
