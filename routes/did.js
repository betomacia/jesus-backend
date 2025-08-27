// routes/did.js  (CommonJS)
const express = require("express");
const nodeFetch = require("node-fetch");

const router = express.Router();

const DID_API_KEY = process.env.DID_API_KEY || "";
const DID_USER = process.env.DID_USERNAME || "";
const DID_PASS = process.env.DID_PASSWORD || "";
const DID_BASE = process.env.DID_BASE || "https://api.d-id.com";
const fetch = (...args) => nodeFetch(...args);

// === Auth header ===
const authMode = DID_API_KEY
  ? "API_KEY"
  : (DID_USER && DID_PASS ? "USER_PASS" : "MISSING");

const didHeaders = () => {
  const h = { "Content-Type": "application/json", Accept: "application/json" };
  if (authMode === "API_KEY") {
    h.Authorization = "Basic " + Buffer.from(`${DID_API_KEY}:`).toString("base64");
  } else if (authMode === "USER_PASS") {
    h.Authorization = "Basic " + Buffer.from(`${DID_USER}:${DID_PASS}`).toString("base64");
  }
  return h;
};

// Cookie jar en memoria por streamId
const cookieJar = new Map();
const validSess = (s) => typeof s === "string" && /^sess_/i.test(s);

router.get("/selftest", async (_req, res) => {
  try {
    const r = await fetch(`${DID_BASE}/credits`, { headers: didHeaders() });
    const data = await r.json().catch(() => ({}));
    res.status(r.ok ? 200 : r.status).json({ status: r.status, authMode, base: DID_BASE, data });
  } catch (e) {
    res.status(500).json({ status: 500, authMode, base: DID_BASE, error: String(e && e.message || e) });
  }
});

router.post("/streams", async (req, res) => {
  try {
    const { source_url } = req.body || {};
    if (!source_url) return res.status(400).json({ error: "missing_source_url" });

    const baseReq = {
      method: "POST",
      headers: didHeaders(),
      body: JSON.stringify({ source_url }),
      redirect: "manual",
    };

    const doRequest = async (url) => {
      let r = await fetch(url, baseReq);
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get("location");
        if (loc) r = await fetch(loc, baseReq);
      }
      return r;
    };

    let attempt = 0, maxAttempts = 3, lastStatus = 0, lastBody = "";
    let r = await doRequest(`${DID_BASE}/talks/streams`);

    while (attempt < maxAttempts) {
      lastStatus = r.status;
      const setCookie = r.headers.get("set-cookie") || "";
      const text = await r.text().catch(() => "");
      lastBody = text;

      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = null; }

      if (r.ok && data && data.id && data.offer) {
        let cookie = "";
        if (setCookie) cookie = setCookie.split(",")[0].split(";")[0].trim();

        if (!validSess(data.session_id)) {
          console.warn("[DID] WARNING: invalid session_id from upstream y no hay sess_ en cookies:", setCookie || "(sin set-cookie)");
        }
        if (cookie) cookieJar.set(data.id, cookie);

        return res.json({
          ...data,
          cookie: cookie || undefined,
          upstream_status: lastStatus
        });
      }

      attempt++;
      if (attempt >= maxAttempts) break;
      await new Promise(r => setTimeout(r, 250 * attempt));
      r = await doRequest(`${DID_BASE}/talks/streams`);
    }

    console.error("[DID] streams create failed", lastStatus, lastBody || "");
    return res.status(502).json({ error: "streams_create_failed", upstream_status: lastStatus, detail: safeJSON(lastBody) });
  } catch (e) {
    console.error("streams create error", e);
    return res.status(500).json({ error: "streams_create_error" });
  }
});

router.post("/streams/:id/sdp", async (req, res) => {
  try {
    const { id } = req.params;
    const { answer, session_id } = req.body || {};
    if (!id || !answer || !session_id) return res.status(400).json({ error: "missing_fields" });

    const cookie = cookieJar.get(id) || "";
    if (!validSess(session_id)) {
      console.warn("[DID] BAD session_id on /sdp POST:", session_id);
    }

    const r = await fetch(`${DID_BASE}/talks/streams/${id}/sdp`, {
      method: "POST",
      headers: { ...didHeaders(), ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify({ answer, session_id })
    });

    const txt = await r.text().catch(() => "");
    const data = parseJSON(txt);
    return res.status(r.ok ? 200 : r.status).json(data ?? { raw: txt });
  } catch (e) {
    console.error("sdp post error", e);
    return res.status(500).json({ error: "sdp_failed" });
  }
});

router.post("/streams/:id/ice", async (req, res) => {
  try {
    const { id } = req.params;
    const { candidate, sdpMid, sdpMLineIndex, session_id } = req.body || {};
    if (!id || !candidate || session_id == null) return res.status(400).json({ error: "missing_fields" });

    const payload = { candidate, session_id };
    if (sdpMid != null) payload.sdpMid = sdpMid;
    if (sdpMLineIndex != null) payload.sdpMLineIndex = sdpMLineIndex;

    const cookie = cookieJar.get(id) || "";
    if (!validSess(session_id)) {
      console.warn("[DID] BAD session_id on /ice POST:", session_id);
    }

    const r = await fetch(`${DID_BASE}/talks/streams/${id}/ice`, {
      method: "POST",
      headers: { ...didHeaders(), ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(payload)
    });

    const txt = await r.text().catch(() => "");
    const data = parseJSON(txt);
    return res.status(r.ok ? 200 : r.status).json(data ?? { raw: txt });
  } catch (e) {
    console.error("ice post error", e);
    return res.status(500).json({ error: "ice_failed" });
  }
});

router.get("/streams/:id/ice", async (req, res) => {
  try {
    const { id } = req.params;
    const { session_id } = req.query || {};
    if (!id || !session_id) return res.status(400).json({ error: "missing_fields" });

    const cookie = cookieJar.get(id) || "";
    if (!validSess(String(session_id))) {
      console.warn("[DID] BAD session_id on /ice GET:", session_id);
    }

    const url = `${DID_BASE}/talks/streams/${id}/ice?session_id=${encodeURIComponent(String(session_id))}`;
    const r = await fetch(url, { method: "GET", headers: { ...didHeaders(), ...(cookie ? { Cookie: cookie } : {}) } });

    const txt = await r.text().catch(() => "");
    // D-ID puede devolver NDJSON; lo reenviamos tal cual (texto)
    res.status(r.ok ? 200 : r.status).send(txt);
  } catch (e) {
    console.error("ice get error", e);
    return res.status(500).json({ error: "ice_get_failed" });
  }
});

router.post("/streams/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { session_id, script } = req.body || {};
    if (!id || !session_id || !script) return res.status(400).json({ error: "missing_fields" });

    const cookie = cookieJar.get(id) || "";
    if (!validSess(session_id)) {
      console.warn("[DID] BAD session_id on /talk POST:", session_id);
    }

    const r = await fetch(`${DID_BASE}/talks/streams/${id}`, {
      method: "POST",
      headers: { ...didHeaders(), ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify({ session_id, script })
    });

    const txt = await r.text().catch(() => "");
    const data = parseJSON(txt);
    return res.status(r.ok ? 200 : r.status).json(data ?? { raw: txt });
  } catch (e) {
    console.error("talk post error", e);
    return res.status(500).json({ error: "talk_failed" });
  }
});

router.delete("/streams/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { session_id } = req.body || {};
    if (!id || !session_id) return res.status(400).json({ error: "missing_fields" });

    const cookie = cookieJar.get(id) || "";
    const r = await fetch(`${DID_BASE}/talks/streams/${id}`, {
      method: "DELETE",
      headers: { ...didHeaders(), ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify({ session_id })
    });

    cookieJar.delete(id);
    const txt = await r.text().catch(() => "");
    const data = parseJSON(txt);
    return res.status(r.ok ? 200 : r.status).json(data ?? { raw: txt });
  } catch (e) {
    console.error("delete stream error", e);
    return res.status(500).json({ error: "delete_stream_failed" });
  }
});

router.get("/credits", async (_req, res) => {
  try {
    const r = await fetch(`${DID_BASE}/credits`, { headers: didHeaders() });
    const txt = await r.text().catch(() => "");
    const data = parseJSON(txt);
    return res.status(r.ok ? 200 : r.status).json(data ?? { raw: txt });
  } catch (e) {
    console.error("credits error", e);
    return res.status(500).json({ error: "credits_failed" });
  }
});

function parseJSON(s) { try { return JSON.parse(s); } catch { return null; } }
function safeJSON(s) { try { return JSON.parse(s); } catch { return s; } }

module.exports = router;
