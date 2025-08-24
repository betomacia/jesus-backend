/* ====== D-ID TALK-STREAM (texto → voz D-ID en streaming) ====== */
/**
 * POST /api/did/talk-stream
 * body: { id: string, session_id: string, text: string, voice_id?: string }
 * - id, session_id: vienen de /api/did/streams (tu router de WebRTC)
 * - text: lo que debe decir el avatar
 * - voice_id: opcional; si no lo pasas, D-ID usa su voz por defecto
 */
app.post("/api/did/talk-stream", async (req, res) => {
  try {
    const { id, session_id, text, voice_id } = req.body || {};
    if (!id || !session_id || !text || !String(text).trim()) {
      return res.status(400).json({ error: "missing_fields" });
    }

    // Payload para hablar con TEXTO usando voces nativas de D-ID
    const payload = {
      session_id,
      script: {
        type: "text",
        input: String(text).slice(0, 5000),
        // provider "d-id" con voice_id (si lo envías)
        provider: voice_id ? { type: "d-id", voice_id } : { type: "d-id" }
      }
    };

    const r = await _fetch(`https://api.d-id.com/talks/streams/${id}`, {
      method: "POST",
      headers: didHeaders(),
      body: JSON.stringify(payload),
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error("D-ID talk-stream failed:", r.status, data);
      return res.status(r.status).json(data);
    }
    return res.json(data);
  } catch (e) {
    console.error("talk-stream error", e);
    return res.status(500).json({ error: "talk_stream_failed", detail: e?.message || String(e) });
  }
});
