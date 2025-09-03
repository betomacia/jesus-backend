// routes/a2e.js — A2E Streaming proxy (con bootstrap de avatares desde tu backend)
// - Auth: Bearer A2E_API_KEY
// - GET  /api/a2e/selftest               -> sanity
// - GET  /api/a2e/avatars                -> lista A2E
// - POST /api/a2e/create-avatar-from-url -> crear 1 avatar desde URL
// - GET  /api/a2e/ensure-avatar-id?name=JESPANOL -> resolver ID por nombre
// - POST /api/a2e/bootstrap-avatars      -> crea/reusa JESPANOL/JINGLE/... desde /public
// - POST /api/a2e/token                  -> pide token (acepta avatar_id | avatar_name | avatar_url)

const express = require("express");
const nodeFetch = require("node-fetch");

const router = express.Router();
const fetch = (...args) => nodeFetch(...args);

// ===============================
// Config (env)
// ===============================
const A2E_BASE = (process.env.A2E_BASE || "https://video.a2e.ai").replace(/\/+$/, "");
const A2E_API_KEY = process.env.A2E_API_KEY || "";

// Base pública de tus imágenes. Ej: https://jesus-backend-production-.../public
const A2E_AVATAR_BASE_URL = (process.env.A2E_AVATAR_BASE_URL || "").replace(/\/+$/, "");

// ===============================
// Helpers
// ===============================
function a2eHeaders(extra = {}) {
  const h = { Accept: "application/json", "Content-Type": "application/json", ...extra };
  if (A2E_API_KEY) h.Authorization = `Bearer ${A2E_API_KEY}`;
  return h;
}
function mustBaseOK(res) {
  if (!A2E_BASE) {
    res.status(500).json({ error: "A2E_BASE_missing", hint: "Define A2E_BASE en variables de entorno" });
    return false;
  }
  return true;
}
function pathJoin(base, path) {
  return `${base}${path.startsWith("/") ? "" : "/"}${path}`;
}
async function tryJson(r) {
  const txt = await r.text().catch(() => "");
  try { return { data: JSON.parse(txt), raw: null, txt, r }; }
  catch { return { data: null, raw: txt, txt, r }; }
}

// ===============================
// Selftest
// ===============================
router.get("/selftest", async (_req, res) => {
  try {
    if (!mustBaseOK(res)) return;
    const url = pathJoin(A2E_BASE, "/");
    const r = await fetch(url, { method: "GET", headers: a2eHeaders() });
    const ct = r.headers.get("content-type") || "";
    const { data, raw } = await tryJson(r);
    res.status(200).json({
      base: A2E_BASE,
      auth: !!A2E_API_KEY,
      status: r.status,
      content_type: ct,
      sample: data || (raw ? String(raw).slice(0, 400) : null)
    });
  } catch (e) {
    res.status(500).json({ error: "selftest_failed", detail: String(e && e.message || e) });
  }
});

// ===============================
// Listar avatares (A2E oficial)
// ===============================
router.get("/avatars", async (_req, res) => {
  try {
    if (!mustBaseOK(res)) return;
    const url = pathJoin(A2E_BASE, "/api/v1/streaming-avatar/all_avatars");
    const r = await fetch(url, { method: "GET", headers: a2eHeaders() });
    const { data, raw } = await tryJson(r);
    return res.status(r.ok ? 200 : r.status).json(data || { raw });
  } catch (e) {
    return res.status(500).json({ error: "avatars_failed", detail: String(e && e.message || e) });
  }
});

// ===============================
// Crear un avatar desde URL (intenta varias rutas conocidas)
// ===============================
router.post("/create-avatar-from-url", async (req, res) => {
  try {
    if (!mustBaseOK(res)) return;
    const { name, image_url } = req.body || {};
    if (!name || !image_url) {
      return res.status(400).json({ error: "missing_name_or_image_url" });
    }

    // 1) Si ya existe, devolverlo
    try {
      const rl = await fetch(pathJoin(A2E_BASE, "/api/v1/streaming-avatar/all_avatars"), {
        method: "GET", headers: a2eHeaders()
      });
      const { data: dl } = await tryJson(rl);
      if (Array.isArray(dl?.data)) {
        const found = dl.data.find(a => (a.name || "").toLowerCase() === String(name).toLowerCase());
        if (found?._id) return res.json({ code: 0, created: false, data: found });
      }
    } catch {}

    // 2) Intentos de creación (distintos tenants)
    const candidates = [
      { path: "/api/v1/streaming-avatar/create",        body: { name, image_url } },
      { path: "/api/v1/streaming-avatar/create_avatar", body: { name, image_url } },
      { path: "/api/v1/avatar/create",                  body: { name, image_url } },
      { path: "/api/v1/avatars",                        body: { name, image_url } },
    ];
    const errors = [];
    for (const c of candidates) {
      try {
        const url = pathJoin(A2E_BASE, c.path);
        const r = await fetch(url, { method: "POST", headers: a2eHeaders(), body: JSON.stringify(c.body) });
        const { data, raw, txt } = await tryJson(r);
        if (r.ok && (data?._id || data?.data?._id)) {
          const obj = data?._id ? data : (data?.data || data);
          return res.json({ code: 0, created: true, data: obj });
        }
        errors.push({ path: c.path, status: r.status, sample: data || (raw ? String(raw).slice(0, 200) : txt?.slice(0, 200)) });
      } catch (e) {
        errors.push({ path: c.path, error: String(e && e.message || e) });
      }
    }

    return res.status(502).json({ error: "avatar_create_failed", name, image_url, tried: errors });
  } catch (e) {
    return res.status(500).json({ error: "create_avatar_from_url_error", detail: String(e && e.message || e) });
  }
});

// ===============================
// Resolver ID por nombre
// ===============================
router.get("/ensure-avatar-id", async (req, res) => {
  try {
    if (!mustBaseOK(res)) return;
    const name = (req.query?.name || "").toString().trim();
    if (!name) return res.status(400).json({ error: "missing_name" });

    const r = await fetch(pathJoin(A2E_BASE, "/api/v1/streaming-avatar/all_avatars"), {
      method: "GET", headers: a2eHeaders()
    });
    const { data, raw } = await tryJson(r);
    if (!r.ok) return res.status(r.status).json(data || { raw });

    const av = (data?.data || []).find(a => (a.name || "").toLowerCase() === name.toLowerCase());
    if (!av?._id) return res.status(404).json({ error: "avatar_not_found", name });
    return res.json(av);
  } catch (e) {
    return res.status(500).json({ error: "ensure_avatar_id_failed", detail: String(e && e.message || e) });
  }
});

// ===============================
// Bootstrap masivo: crea/reusa tus 6 avatares desde /public
// POST /api/a2e/bootstrap-avatars
// body opcional:
//   {
//     base: "https://<tu-backend>/public",
//     avatars: [{ name:"JESPANOL", file:"JESPANOL.jpeg" }, ...]
//   }
// ===============================
router.post("/bootstrap-avatars", async (req, res) => {
  try {
    if (!mustBaseOK(res)) return;

    const base = (req.body?.base || A2E_AVATAR_BASE_URL || "").replace(/\/+$/, "");
    if (!base) {
      return res.status(400).json({
        error: "missing_base_public_url",
        hint: "Pasa 'base' en el body o define A2E_AVATAR_BASE_URL en el .env (ej: https://tu-backend/public)"
      });
    }

    const avatars = Array.isArray(req.body?.avatars) && req.body.avatars.length
      ? req.body.avatars
      : [
          { name: "JESPANOL",   file: "JESPANOL.jpeg" },
          { name: "JINGLE",     file: "JINGLE.jpeg" },
          { name: "JALEMAN",    file: "JALEMAN.jpeg" },
          { name: "JBRASILERO", file: "JBRASILERO.jpeg" },
          { name: "JITALIANO",  file: "JITALIANO.jpeg" },
          { name: "JCATALAN",   file: "JCATALAN.jpeg" },
        ];

    const results = [];
    // 1) cache de existentes
    let existing = [];
    try {
      const r = await fetch(pathJoin(A2E_BASE, "/api/v1/streaming-avatar/all_avatars"), {
        method: "GET", headers: a2eHeaders()
      });
      const { data } = await tryJson(r);
      if (Array.isArray(data?.data)) existing = data.data;
    } catch {}

    for (const av of avatars) {
      const name = av.name;
      const image_url = `${base}/${av.file}`;
      // si existe, reusar
      const found = existing.find(a => (a.name || "").toLowerCase() === name.toLowerCase());
      if (found?._id) {
        results.push({ name, image_url, id: found._id, created: false });
        continue;
      }
      // crear
      const r = await fetch(pathJoin(A2E_BASE, "/api/v1/streaming-avatar/create"), {
        method: "POST",
        headers: a2eHeaders(),
        body: JSON.stringify({ name, image_url })
      });
      const { data, raw } = await tryJson(r);
      if (r.ok && (data?._id || data?.data?._id)) {
        const obj = data?._id ? data : (data?.data || data);
        results.push({ name, image_url, id: obj._id, created: true });
      } else {
        results.push({ name, image_url, error: true, sample: data || (raw ? String(raw).slice(0, 200) : null) });
      }
    }

    return res.json({ base, results });
  } catch (e) {
    return res.status(500).json({ error: "bootstrap_failed", detail: String(e && e.message || e) });
  }
});

// ===============================
// Token (Agora) — acepta avatar_id | avatar_name | avatar_url
// ===============================
router.post("/token", async (req, res) => {
  try {
    if (!mustBaseOK(res)) return;
    let {
      avatar_id,
      avatar_name,
      avatar_url,
      expire_seconds = 60,
    } = req.body || {};

    avatar_id   = avatar_id   || req.body?.avatarId   || "";
    avatar_name = avatar_name || req.body?.avatarName || "";
    avatar_url  = avatar_url  || req.body?.avatarUrl  || "";

    // Resolver por nombre si es necesario
    if (!avatar_id && avatar_name) {
      try {
        const r = await fetch(pathJoin(A2E_BASE, "/api/v1/streaming-avatar/all_avatars"), {
          method: "GET", headers: a2eHeaders()
        });
        const { data } = await tryJson(r);
        const found = Array.isArray(data?.data)
          ? data.data.find(a => (a.name || "").toLowerCase() === avatar_name.toLowerCase())
          : null;
        if (found?._id) avatar_id = found._id;
      } catch {}
    }

    // Si nos pasan URL y no hay id -> intentar crear on-the-fly
    if (!avatar_id && avatar_url) {
      const name = avatar_name || "JESPANOL";
      const r = await fetch(pathJoin(A2E_BASE, "/api/v1/streaming-avatar/create"), {
        method: "POST",
        headers: a2eHeaders(),
        body: JSON.stringify({ name, image_url: avatar_url })
      });
      const { data } = await tryJson(r);
      const created = data?._id ? data : (data?.data || null);
      if (created?._id) avatar_id = created._id;
      else {
        return res.status(400).json({
          error: "avatar_create_needed",
          hint: "No se pudo crear automáticamente con avatar_url. Ejecuta el bootstrap o crea el avatar una vez en su panel."
        });
      }
    }

    if (!avatar_id) {
      return res.status(400).json({
        error: "missing_avatar",
        hint: "Provee avatar_id, o avatar_name existente, o corre /api/a2e/bootstrap-avatars primero."
      });
    }

    // Pedir token
    const r = await fetch(pathJoin(A2E_BASE, "/api/v1/streaming-avatar/agora-token"), {
      method: "POST",
      headers: a2eHeaders(),
      body: JSON.stringify({ avatar_id, expire_seconds })
    });
    const { data, raw } = await tryJson(r);
    return res.status(r.ok ? 200 : r.status).json(data || { raw });

  } catch (e) {
    return res.status(500).json({ error: "a2e_token_failed", detail: String(e && e.message || e) });
  }
});

module.exports = router;
