import express from 'express';
import fetch from 'node-fetch';

const router = express.Router();
const DID_BASE = 'https://api.d-id.com';
const DID_API_KEY = process.env.DID_API_KEY || '';

if (!DID_API_KEY) {
  console.warn('[WARN] DID_API_KEY no está definida. Configúrala en Railway > Variables.');
}

function didHeaders() {
  return {
    'Authorization': 'Basic ' + Buffer.from(`${DID_API_KEY}:`).toString('base64'),
    'Content-Type': 'application/json'
  };
}

// 1) Crear stream: POST /talks/streams
router.post('/streams', async (req, res) => {
  try {
    const { source_url } = req.body || {};
    const r = await fetch(`${DID_BASE}/talks/streams`, {
      method: 'POST',
      headers: didHeaders(),
      body: JSON.stringify({ source_url })
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    // devolvemos solo lo necesario
    return res.json({
      id: data.id,
      offer: data.offer,
      ice_servers: data.ice_servers,
      session_id: data.session_id
    });
  } catch (e: any) {
    console.error('DID /streams error:', e?.message || e);
    return res.status(500).json({ error: 'streams_failed' });
  }
});

// 2) Enviar SDP answer: POST /talks/streams/{id}/sdp
router.post('/streams/:id/sdp', async (req, res) => {
  try {
    const { id } = req.params;
    const { answer, session_id } = req.body || {};
    const r = await fetch(`${DID_BASE}/talks/streams/${id}/sdp`, {
      method: 'POST',
      headers: didHeaders(),
      body: JSON.stringify({ answer, session_id })
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    return res.json(data);
  } catch (e: any) {
    console.error('DID /sdp error:', e?.message || e);
    return res.status(500).json({ error: 'sdp_failed' });
  }
});

// 3) Enviar ICE candidates: POST /talks/streams/{id}/ice
router.post('/streams/:id/ice', async (req, res) => {
  try {
    const { id } = req.params;
    const { candidate, session_id } = req.body || {};
    const r = await fetch(`${DID_BASE}/talks/streams/${id}/ice`, {
      method: 'POST',
      headers: didHeaders(),
      body: JSON.stringify({ candidate, session_id })
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    return res.json(data);
  } catch (e: any) {
    console.error('DID /ice error:', e?.message || e);
    return res.status(500).json({ error: 'ice_failed' });
  }
});

// 4) Hacer hablar al avatar en la sesión: POST /talks/streams/{id}
router.post('/streams/:id/talk', async (req, res) => {
  try {
    const { id } = req.params;
    const { session_id, script, driver_url, config, voice } = req.body || {};
    const r = await fetch(`${DID_BASE}/talks/streams/${id}`, {
      method: 'POST',
      headers: didHeaders(),
      body: JSON.stringify({ session_id, script, driver_url, config, voice })
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    return res.json(data);
  } catch (e: any) {
    console.error('DID /talk error:', e?.message || e);
    return res.status(500).json({ error: 'talk_failed' });
  }
});

export default router;
