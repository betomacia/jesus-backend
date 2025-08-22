// routes/did.js
const express = require('express');
const router = express.Router();

const DID_BASE = 'https://api.d-id.com';
const DID_API_KEY = process.env.DID_API_KEY;

if (!DID_API_KEY) {
  console.warn('[WARN] DID_API_KEY no está definida. Agrégala en Railway > Variables.');
}

function didHeaders() {
  return {
    'Authorization': 'Basic ' + Buffer.from(`${DID_API_KEY}:`).toString('base64'),
    'Content-Type': 'application/json'
  };
}

// 1) Crear stream (devuelve offer, ice_servers y session_id)
router.post('/streams', async (req, res) => {
  try {
    const { source_url } = req.body || {};
    const r = await globalThis.fetch(`${DID_BASE}/talks/streams`, {
      method: 'POST',
      headers: didHeaders(),
      body: JSON.stringify({ source_url })
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    // devolvemos lo necesario
    return res.json({
      id: data.id,
      offer: data.offer,
      ice_servers: data.ice_servers,
      session_id: data.session_id
    });
  } catch (e) {
    console.error('DID /streams error:', e);
    return res.status(500).json({ error: 'streams_failed' });
  }
});

// 2) Enviar SDP answer
router.post('/streams/:id/sdp', async (req, res) => {
  try {
    const { id } = req.params;
    const { answer, session_id } = req.body || {};
    const r = await globalThis.fetch(`${DID_BASE}/talks/streams/${id}/sdp`, {
      method: 'POST',
      headers: didHeaders(),
      body: JSON.stringify({ answer, session_id })
    });
    const data = await r.json();
    return res.status(r.status).json(data);
  } catch (e) {
    console.error('DID /sdp error:', e);
    return res.status(500).json({ error: 'sdp_failed' });
  }
});

// 3) Enviar ICE candidates
router.post('/streams/:id/ice', async (req, res) => {
  try {
    const { id } = req.params;
    const { candidate, session_id } = req.body || {};
    const r = await globalThis.fetch(`${DID_BASE}/talks/streams/${id}/ice`, {
      method: 'POST',
      headers: didHeaders(),
      body: JSON.stringify({ candidate, session_id })
    });
    const data = await r.json();
    return res.status(r.status).json(data);
  } catch (e) {
    console.error('DID /ice error:', e);
    return res.status(500).json({ error: 'ice_failed' });
  }
});

// 4) Hacer hablar al avatar en la sesión
router.post('/streams/:id/talk', async (req, res) => {
  try {
    const { id } = req.params;
    const { session_id, script, driver_url, config, voice } = req.body || {};
    const r = await globalThis.fetch(`${DID_BASE}/talks/streams/${id}`, {
      method: 'POST',
      headers: didHeaders(),
      body: JSON.stringify({ session_id, script, driver_url, config, voice })
    });
    const data = await r.json();
    return res.status(r.status).json(data);
  } catch (e) {
    console.error('DID /talk error:', e);
    return res.status(500).json({ error: 'talk_failed' });
  }
});

module.exports = router;
