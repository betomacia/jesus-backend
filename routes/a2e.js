// routes/a2e.js — A2E Streaming Avatar (Agora) con avatar propio por nombre/URL
// Endpoints:
//   GET  /api/a2e/selftest
//   GET  /api/a2e/avatars
//   GET  /api/a2e/ensure-avatar-id?name=JESPANOL
//   POST /api/a2e/token   { avatar_id? | avatar_name? | avatar_url?, expire_seconds?=60 } (acepta alias camelCase avatarId/avatarName/avatarUrl)
//   POST /api/a2e/talk    { channel, text, lang?, voice? }
//   POST /api/a2e/leave   { channel, uid }
//
// ENV:
//   A2E_API_KEY  -> Bearer ***
//   (opcional) A2E_BASES = https://video.a2e.com.cn,https://video.a2e.ai
//   (opcional) A2E_BASE   = https://video.a2e.ai

const express = require("express");
const nodeFetch = require("node-fetch");
const router = express.Router();
const fetch = (...args) => nodeFetch(...args);

// === Config ===
const A2E_API_KEY = process.env.A2E_API_KEY || "";

const basesFromCsv = (process.env.A2E_BASES || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean)
  .map(s => s.replace(/\/+$/, ""));

const fallbackBases = basesFromCsv.length
  ? basesFromCsv
  : (process.env.A2E_BASE
      ? [process.env.A2E_BASE.replace(/\/+$/, "")]
      : ["https://video.a2e.ai", "https://video.a2e.com.cn"]);

function authHeaders(extra = {}) {
  const h = { "Content-Type": "application/json", Accept: "application/json", ...extra };
  if (A2E_API_KEY) h.Authorization = `Bearer ${A2E_API_KEY}`;
  return h;
}

async function tryFetchJsonAcrossBases(method, path, bodyObj = null, opts = {}) {
  const bodiestr = bodyObj ? JSON.stringify(bodyObj) : undefined;
  const maxRetriesPerBase = opts.maxRetriesPerBase ?? 1;
  const delay = (ms) => new Promise(r => setTimeout(r, ms));

  for (const base of fallbackBases) {
    const url = `${base}${path.startsWith("/") ? "" : "/"}${path}`;
    let attempt = 0;
    while (attempt <= maxRetriesPerBase) {
      try {
        const r = await fetch(url, {
          method,
          headers: authHeaders(opts.headers || {}),
          body: bodiestr
        });
        const ct = String(r.headers.get("content-type") || "");
        const raw = await r.text();
        let data = null;
        try { data = ct.includes("application/json") ? JSON.parse(raw) : null; } catch {}

        const ok = r.ok && (!data || data.code === undefined || data.code === 0);
        if (ok) return { base, status: r.status, data: data ?? raw, ok: true };

        const code = data && typeof data.code === "number" ? data.code : null;
        if (code === 1001) { // capacidad ocupada
          if (attempt < maxRetriesPerBase) { await delay(400 + attempt * 300); attempt++; continue; }
          break; // siguiente base
        }
        if (r.status >= 500) break; // siguiente base
        return { base, status: r.status, data: data ?? raw, ok: false }; // 4xx -> devolver
      } catch {
        break; // error de red => siguiente base
      }
    }
  }
  return { base: "(none)", status: 502, data: { code: -1, msg: "no_base_ok" }, ok: false };
}

// ===== Helpers de avatar por nombre/URL =====
function deriveNameFromUrl(urlOrPath = "") {
  if (!urlOrPath) return "";
  // 1) Intentar URL absoluta
  try {
    const u = new URL(urlOrPath);
    const file = (u.pathname.split("/").pop() || "").replace(/\.[a-z0-9]+$/i, "");
    return file.trim();
  } catch {}
  // 2) Relativa o path plano (incluye /public/JESPANOL.jpeg o "JESPANOL.jpeg")
  const last = urlOrPath.split(/[\\/]/).pop() || "";
  return last.replace(/\.[a-z0-9]+$/i, "").trim();
}

async function listAvatars() {
  return await tryFetchJsonAcrossBases("GET", "/api/v1/streaming-avatar/all_avatars");
}

function pickAvatarIdByName(avatarsResp, wantedName) {
  if (!avatarsResp || !avatarsResp.data || !Array.isArray(avatarsResp.data)) return null;
  const name = String(wantedName || "").trim();
  if (!name) return null;
  // match exact (case-insensitive)
  const exact = avatarsResp.data.find(a => (a.name || "").toLowerCase() === name.toLowerCase());
  if (exact) return exact._id;
  // fallback: empieza con…
  const starts = avatarsResp.data.find(a => (a.name || "").toLowerCase().startsWith(name.toLowerCase()));
  if (starts) return starts._id;
  return null;
}

// ============== Selftest ==============
router.get("/selftest", async (_req, res) => {
  try {
    const base = fallbackBases[0];
    const r = await fetch(base + "/", { headers: authHeaders() });
    const ct = String(r.headers.get("content-type") || "");
    const raw = await r.text();
    let sample = raw;
    try { if (ct.includes("application/json")) sample = JSON.parse(raw); } catch {}
    res.json({
      bases: fallbackBases,
      auth: !!A2E_API_KEY,
      status: r.status,
      content_type: ct,
      sample: sample && typeof sample === "string" ? sample.slice(0, 400) : sample
    });
  } catch (e) {
    res.status(500).json({ error: "selftest_failed", detail: String(e && e.message || e) });
  }
});

router.get("/avatars", async (_req, res) => {
  const r = await listAvatars();
  return res.status(r.status || 500).json({
    ...(r.data || {}),
    __meta: { used_base: r.base, ok: r.ok }
  });
});

router.get("/ensure-avatar-id", async (req, res) => {
  try {
    const name = (req.query.name || "").toString().trim();
    if (!name) return res.status(400).json({ error: "missing_name" });
    const r = await listAvatars();
    const id = pickAvatarIdByName(r.data, name);
    if (!id) return res.status(404).json({ error: "avatar_not_found_on_a2e", name, hint: "Crea el avatar en A2E con ese nombre exacto" });
    res.json({ _id: id, name, __meta: { used_base: r.base, ok: r.ok } });
  } catch (e) {
    res.status(500).json({ error: "ensure_avatar_failed", detail: String(e && e.message || e) });
  }
});

// ============== Token (Agora) ==============
router.post("/token", async (req, res) => {
  try {
    // admitir snake_case y camelCase
    let {
      avatar_id,
      avatar_name,
      avatar_url,
      expire_seconds = 60
    } = req.body || {};
    avatar_id   = avatar_id   || req.body?.avatarId;
    avatar_name = avatar_name || req.body?.avatarName;
    avatar_url  = avatar_url  || req.body?.avatarUrl;

    // Resolver por nombre/URL si no viene avatar_id
    if (!avatar_id) {
      if (!avatar_name && avatar_url) {
        avatar_name = deriveNameFromUrl(String(avatar_url));
      }
      if (!avatar_name) {
        return res.status(400).json({ error: "missing_avatar_id_or_name", hint: "Provee avatar_id o avatar_name (p.ej. 'JESPANOL')" });
      }
      const rList = await listAvatars();
      const foundId = pickAvatarIdByName(rList.data, avatar_name);
      if (!foundId) {
        return res.status(404).json({
          error: "avatar_not_found_on_a2e",
          name: avatar_name,
          hint: "Entra a https://video.a2e.ai y crea tu avatar con ese nombre usando tu imagen servida por /public/*.jpeg"
        });
      }
      avatar_id = foundId;
    }

    const r = await tryFetchJsonAcrossBases(
      "POST",
      "/api/v1/streaming-avatar/agora-token",
      { avatar_id, expire_seconds: Math.max(15, Math.min(300, Number(expire_seconds) || 60)) },
      { maxRetriesPerBase: 1 }
    );

    return res.status(r.status || 500).json({
      ...(r.data || {}),
      __meta: { used_base: r.base, ok: r.ok, resolved_avatar_id: avatar_id }
    });
  } catch (e) {
    return res.status(500).json({ error: "a2e_token_failed", detail: String(e && e.message || e) });
  }
});

// ============== Hablar en sala (texto->voz/avatar) ==============
router.post("/talk", async (req, res) => {
  try {
    const { channel, text, lang = "es", voice = "male_neutral" } = req.body || {};
    if (!channel || !text) return res.status(400).json({ error: "missing_fields" });

    const r = await tryFetchJsonAcrossBases(
      "POST",
      "/api/v1/streaming-avatar/talk",
      { channel, text, lang, voice }
    );
    return res.status(r.status || 500).json({
      ...(r.data || {}),
      __meta: { used_base: r.base, ok: r.ok }
    });
  } catch (e) {
    return res.status(500).json({ error: "a2e_talk_failed", detail: String(e && e.message || e) });
  }
});

// ============== Leave (liberar monedas) ==============
router.post("/leave", async (req, res) => {
  try {
    const { channel, uid } = req.body || {};
    if (!channel || !uid) return res.status(400).json({ error: "missing_fields" });

    const r = await tryFetchJsonAcrossBases(
      "POST",
      "/api/v1/streaming-avatar/leave-room",
      { channel, uid }
    );
    return res.status(r.status || 500).json({
      ...(r.data || {}),
      __meta: { used_base: r.base, ok: r.ok }
    });
  } catch (e) {
    return res.status(500).json({ error: "a2e_leave_failed", detail: String(e && e.message || e) });
  }
});

module.exports = router;
