import express from "express";

const router = express.Router();
const DID_BASE = "https://api.d-id.com/talks/streams";
const AUTH = "Basic " + Buffer.from((process.env.DID_API_KEY || "") + ":").toString("base64");

// Guardamos streamId -> sessionId (sess_...)
const streamSessions = new Map<string, string>();

async function didFetch(path: string, init?: RequestInit) {
  const r = await fetch(`${DID_BASE}${path}`, {
    ...init,
    headers: {
      "Authorization": AUTH,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
  return r;
}

// Crear stream
router.post("/streams", async (req, res) => {
  try {
    const { source_url } = req.body || {};
    const r = await didFetch("", {
      method: "POST",
      body: JSON.stringify({ source_url }),
    });
    const data = await r.json();
    // data esperado: { id, offer, ice_servers, session_id }
    // Asegurar que obtengamos el verdadero sess_...
    let sess = data?.session_id as string | undefined;

    if (!sess || !/^sess_/i.test(sess)) {
      // Algunos proxies no pasan session_id en JSON; intenta extraer de Set-Cookie si existiera
      const setCookie = r.headers.get("set-cookie") || "";
      const m = setCookie.match(/(sess_[^;]+)/i);
      if (m) sess = m[1];
    }
    if (!sess || !/^sess_/i.test(sess)) {
      console.warn("[DID] create: no valid session_id in response");
    }

    if (data?.id && sess) streamSessions.set(String(data.id), sess);

    res.status(r.status).json({
      id: data?.id,
      offer: data?.offer,
      ice_servers: data?.ice_servers,
      session_id: sess, // devolvemos el sess_… correcto
    });
  } catch (e: any) {
    res.status(500).json({ error: "streams_create_failed", detail: e?.message || String(e) });
  }
});

// Postear SDP answer
router.post("/streams/:id/sdp", async (req, res) => {
  try {
    const { id } = req.params;
    const { answer, session_id } = req.body || {};
    const sid = session_id || streamSessions.get(id);
    if (!sid) return res.status(400).json({ error: "missing_session_id" });

    const r = await didFetch(`/${id}/sdp?session_id=${encodeURIComponent(sid)}`, {
      method: "POST",
      body: JSON.stringify({ answer }),
    });
    const txt = await r.text();
    res.status(r.status).type(r.headers.get("content-type") || "text/plain").send(txt);
  } catch (e: any) {
    res.status(500).json({ error: "sdp_failed", detail: e?.message || String(e) });
  }
});

// Enviar ICE LOCAL (del browser) a D-ID
router.post("/streams/:id/ice", async (req, res) => {
  try {
    const { id } = req.params;
    const { candidate, session_id } = req.body || {};
    const sid = session_id || streamSessions.get(id);
    if (!sid) return res.status(400).json({ error: "missing_session_id" });

    const r = await didFetch(`/${id}/ice?session_id=${encodeURIComponent(sid)}`, {
      method: "POST",
      body: JSON.stringify({ candidate }),
    });
    const txt = await r.text();
    res.status(r.status).type(r.headers.get("content-type") || "text/plain").send(txt);
  } catch (e: any) {
    res.status(500).json({ error: "ice_post_failed", detail: e?.message || String(e) });
  }
});

// Obtener ICE REMOTOs de D-ID (para agregar en el RTCPeerConnection)
router.get("/streams/:id/ice", async (req, res) => {
  try {
    const { id } = req.params;
    const sid =
      (req.query.session_id as string | undefined) ||
      streamSessions.get(id);

    if (!sid) {
      // Sin session no hay candidatos remotos
      return res.json({ candidates: [] });
    }

    const r = await didFetch(`/${id}/ice?session_id=${encodeURIComponent(sid)}`, {
      method: "GET",
    });

    if (!r.ok) {
      const txt = await r.text();
      console.warn("[DID] get ICE not ok:", r.status, txt);
      return res.json({ candidates: [] });
    }
    const data = await r.json(); // { candidates: [...] }
    res.json(data || { candidates: [] });
  } catch (e: any) {
    res.status(200).json({ candidates: [] });
  }
});

// Hablar por texto
router.post("/streams/:id/talk", async (req, res) => {
  try {
    const { id } = req.params;
    const { script, session_id } = req.body || {};
    const sid = session_id || streamSessions.get(id);
    if (!sid) return res.status(400).json({ error: "missing_session_id" });

    const r = await didFetch(`/${id}?session_id=${encodeURIComponent(sid)}`, {
      method: "POST",
      body: JSON.stringify({ script }),
    });
    const txt = await r.text();
    res.status(r.status).type(r.headers.get("content-type") || "text/plain").send(txt);
  } catch (e: any) {
    res.status(500).json({ error: "talk_failed", detail: e?.message || String(e) });
  }
});

export default router;
