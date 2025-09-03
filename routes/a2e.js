// routes/a2e.js — A2E Streaming (crear avatar por imagen, listar, token Agora, speak)
const express = require("express");
const nodeFetch = require("node-fetch");
const router = express.Router();
const fetch = (...args) => nodeFetch(...args);

// ========= Config =========
const A2E_BASE = (process.env.A2E_BASE || "https://video.a2e.ai").replace(/\/+$/, "");
const A2E_API_KEY = process.env.A2E_API_KEY || "";

// Header auth (Bearer por defecto)
function a2eHeaders(extra = {}) {
  const h = { Accept: "application/json", "Content-Type": "application/json", ...extra };
  if (A2E_API_KEY) h.Authorization = `Bearer ${A2E_API_KEY}`;
  return h;
}
function j(s){ try { return JSON.parse(s); } catch { return null; } }
function join(base, path){ return `${base}${path.startsWith("/")?"":"/"}${path}`; }

// ========= Selftest =========
router.get("/selftest", async (_req, res) => {
  try {
    const r = await fetch(A2E_BASE, { headers: a2eHeaders() });
    const ct = r.headers.get("content-type") || "";
    const txt = await r.text().catch(()=> "");
    let sample = txt;
    if (/json/i.test(ct)) sample = j(txt) ?? txt.slice(0,400);
    res.json({ base: A2E_BASE, auth: !!A2E_API_KEY, status: r.status, content_type: ct, sample });
  } catch (e) {
    res.status(500).json({ error: "selftest_failed", detail: String(e && e.message || e) });
  }
});

// ========= LISTAR AVATARES =========
// GET /api/a2e/avatars  -> GET /api/v1/streaming-avatar/all_avatars
router.get("/avatars", async (_req, res) => {
  try {
    const url = join(A2E_BASE, "/api/v1/streaming-avatar/all_avatars");
    const r = await fetch(url, { headers: a2eHeaders() });
    const txt = await r.text().catch(()=> "");
    const data = j(txt);
    res.status(r.ok ? 200 : r.status).json(data ?? { raw: txt });
  } catch (e) {
    res.status(500).json({ error: "avatars_failed", detail: String(e && e.message || e) });
  }
});

// ========= CREAR AVATAR DESDE IMAGEN (entrenar) =========
// POST /api/a2e/create-avatar { name, image_url }
// -> POST /api/v1/userVideoTwin/startTraining
router.post("/create-avatar", async (req, res) => {
  try {
    const { name, image_url, video_url, language, gender } = req.body || {};
    if (!image_url && !video_url) {
      return res.status(400).json({ error: "missing_image_or_video" });
    }
    const url = join(A2E_BASE, "/api/v1/userVideoTwin/startTraining");
    const body = {
      // A2E acepta image_url O video_url. Campos extra se ignoran si no aplican.
      image_url, 
      video_url,
      avatar_name: name || undefined,
      language: language || undefined,
      gender: gender || undefined
    };
    const r = await fetch(url, { method: "POST", headers: a2eHeaders(), body: JSON.stringify(body) });
    const txt = await r.text().catch(()=> "");
    const data = j(txt);
    return res.status(r.ok ? 200 : r.status).json(data ?? { raw: txt });
  } catch (e) {
    res.status(500).json({ error: "create_avatar_failed", detail: String(e && e.message || e) });
  }
});

// ========= ESTADO DE ENTRENAMIENTO =========
// GET /api/a2e/train-status/:id
// -> GET /api/v1/userVideoTwin/{id}
router.get("/train-status/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const url = join(A2E_BASE, `/api/v1/userVideoTwin/${encodeURIComponent(id)}`);
    const r = await fetch(url, { headers: a2eHeaders() });
    const txt = await r.text().catch(()=> "");
    const data = j(txt);
    return res.status(r.ok ? 200 : r.status).json(data ?? { raw: txt });
  } catch (e) {
    res.status(500).json({ error: "train_status_failed", detail: String(e && e.message || e) });
  }
});

// ========= TOKEN DE STREAMING (AGORA) =========
// POST /api/a2e/token { avatar_id, expire_seconds?=60 }
// -> POST /api/v1/streaming-avatar/agora-token
router.post("/token", async (req, res) => {
  try {
    const { avatar_id, expire_seconds = 60 } = req.body || {};
    if (!avatar_id) return res.status(400).json({ error: "missing_avatar_id" });
    const url = join(A2E_BASE, "/api/v1/streaming-avatar/agora-token");
    const r = await fetch(url, {
      method: "POST",
      headers: a2eHeaders(),
      body: JSON.stringify({ avatar_id, expire_seconds })
    });
    const txt = await r.text().catch(()=> "");
    const data = j(txt);
    return res.status(r.ok ? 200 : r.status).json(data ?? { raw: txt });
  } catch (e) {
    res.status(500).json({ error: "token_failed", detail: String(e && e.message || e) });
  }
});

// ========= HABLAR (texto directo) =========
// POST /api/a2e/speak { avatar_id, text, ssml?, channel? }
// -> POST /api/v1/streaming-avatar/speak
router.post("/speak", async (req, res) => {
  try {
    const { avatar_id, text, ssml, channel } = req.body || {};
    if (!avatar_id || !(text || ssml)) return res.status(400).json({ error: "missing_fields" });
    const url = join(A2E_BASE, "/api/v1/streaming-avatar/speak");
    const r = await fetch(url, {
      method: "POST",
      headers: a2eHeaders(),
      body: JSON.stringify({ avatar_id, text, ssml, channel })
    });
    const txt = await r.text().catch(()=> "");
    const data = j(txt);
    return res.status(r.ok ? 200 : r.status).json(data ?? { raw: txt });
  } catch (e) {
    res.status(500).json({ error: "speak_failed", detail: String(e && e.message || e) });
  }
});

// ========= BOOTSTRAP DESDE /public =========
// POST /api/a2e/bootstrap-avatars { base }
// Crea tareas de entrenamiento para: JESPANOL, JINGLE, JALEMAN, JBRASILERO, JITALIANO, JCATALAN
router.post("/bootstrap-avatars", async (req, res) => {
  try {
    const { base } = req.body || {};
    if (!base) return res.status(400).json({ error: "missing_base" });

    const names = ["JESPANOL","JINGLE","JALEMAN","JBRASILERO","JITALIANO","JCATALAN"];
    const results = [];

    // 1) Lista los ya existentes para no duplicar
    const existingReq = await fetch(join(A2E_BASE, "/api/v1/streaming-avatar/all_avatars"), { headers: a2eHeaders() });
    const existingJson = j(await existingReq.text().catch(()=> "")) || { data: [] };
    const byName = new Map();
    for (const a of (existingJson.data || [])) {
      if (a && a.name) byName.set(a.name.toUpperCase(), a);
    }

    for (const name of names) {
      const urlImg = `${base.replace(/\/+$/,"")}/${name}.jpeg`;
      // Valida que la imagen exista
      let okImage = false, imgSample = "";
      try {
        const h = await fetch(urlImg, { method: "HEAD" });
        okImage = h.ok;
        if (!okImage) {
          const t = await fetch(urlImg); // intenta GET para sample
          imgSample = await t.text().catch(()=> "");
        }
      } catch(e) { imgSample = String(e && e.message || e); }

      if (!okImage) {
        results.push({ name, image_url: urlImg, error: "image_not_reachable", sample: { raw: imgSample.slice(0,400) } });
        continue;
      }

      if (byName.has(name)) {
        const a = byName.get(name);
        results.push({ name, image_url: urlImg, status: "already_exists", avatar: { _id: a._id, name: a.name } });
        continue;
      }

      // 2) Crear tarea de entrenamiento
      const trainUrl = join(A2E_BASE, "/api/v1/userVideoTwin/startTraining");
      const body = { image_url: urlImg, avatar_name: name };
      const r = await fetch(trainUrl, { method: "POST", headers: a2eHeaders(), body: JSON.stringify(body) });
      const txt = await r.text().catch(()=> "");
      const data = j(txt);

      if (r.ok) {
        results.push({ name, image_url: urlImg, status: "training_submitted", response: data ?? { raw: txt } });
      } else {
        results.push({ name, image_url: urlImg, error: true, sample: data ?? { raw: txt } });
      }
    }

    res.json({ base, results });
  } catch (e) {
    res.status(500).json({ error: "bootstrap_failed", detail: String(e && e.message || e) });
  }
});

module.exports = router;
