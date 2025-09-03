// routes/a2e.js — A2E proxy + bootstrap de avatares desde /public

const express = require("express");
const nodeFetch = require("node-fetch");

const router = express.Router();
const fetch = (...args) => nodeFetch(...args);

// ===============================
// Config
// ===============================
const A2E_BASE = (process.env.A2E_BASE || "").replace(/\/+$/, ""); // https://video.a2e.ai
const A2E_API_KEY = process.env.A2E_API_KEY || "";
const A2E_AUTH_MODE = (process.env.A2E_AUTH_MODE || "bearer").toLowerCase();
const A2E_BASIC_USER = process.env.A2E_BASIC_USER || "";
const A2E_BASIC_PASS = process.env.A2E_BASIC_PASS || "";
const A2E_API_KEY_HEADER = process.env.A2E_API_KEY_HEADER || "x-api-key";

function a2eHeaders(extra = {}) {
  const h = { Accept: "application/json", "Content-Type": "application/json", ...extra };
  if (A2E_AUTH_MODE === "bearer" && A2E_API_KEY) h.Authorization = `Bearer ${A2E_API_KEY}`;
  else if (A2E_AUTH_MODE === "x-api-key" && A2E_API_KEY) h[A2E_API_KEY_HEADER] = A2E_API_KEY;
  else if (A2E_AUTH_MODE === "basic" && (A2E_BASIC_USER || A2E_BASIC_PASS)) {
    h.Authorization = "Basic " + Buffer.from(`${A2E_BASIC_USER}:${A2E_BASIC_PASS}`).toString("base64");
  }
  return h;
}
function mustBaseOK(res) {
  if (!A2E_BASE) { res.status(500).json({ error: "A2E_BASE_missing", hint: "Define A2E_BASE" }); return false; }
  return true;
}
function pj(base, path) { return `${base}${path.startsWith("/") ? "" : "/"}${path}`; }

async function safeJSON(res) {
  const txt = await res.text().catch(() => "");
  try { return JSON.parse(txt); } catch { return { raw: txt }; }
}

// ===============================
// Selftest / avatars
// ===============================
router.get("/selftest", async (_req, res) => {
  try {
    if (!mustBaseOK(res)) return;
    const r = await fetch(pj(A2E_BASE, "/"), { headers: a2eHeaders(), method: "GET" });
    const txt = await r.text().catch(() => "");
    res.status(200).json({
      base: A2E_BASE,
      auth: !!A2E_API_KEY,
      status: r.status,
      content_type: r.headers.get("content-type") || "",
      sample: txt.slice(0, 200)
    });
  } catch (e) {
    res.status(500).json({ error: "selftest_failed", detail: String(e?.message || e) });
  }
});

router.get("/avatars", async (_req, res) => {
  try {
    if (!mustBaseOK(res)) return;
    const url = pj(A2E_BASE, "/api/v1/streaming-avatar/all_avatars");
    const r = await fetch(url, { method: "GET", headers: a2eHeaders() });
    const data = await safeJSON(r);
    res.status(r.ok ? 200 : r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: "avatars_failed", detail: String(e?.message || e) });
  }
});

// ===============================
// Token (Agora) por nombre ó id
// ===============================
router.post("/token", async (req, res) => {
  try {
    if (!mustBaseOK(res)) return;
    let { avatar_id, avatar_name, expire_seconds = 60 } = req.body || {};

    if (!avatar_id && !avatar_name) {
      return res.status(400).json({ error: "missing_avatar", hint: "avatar_id o avatar_name" });
    }

    // Resolver id por nombre (si viene name)
    if (!avatar_id && avatar_name) {
      const list = await fetch(pj(A2E_BASE, "/api/v1/streaming-avatar/all_avatars"), {
        headers: a2eHeaders(), method: "GET"
      }).then(safeJSON);

      const found = Array.isArray(list?.data)
        ? list.data.find(a => (a.name || "").toLowerCase() === String(avatar_name).toLowerCase())
        : null;

      if (!found?._id) {
        return res.status(404).json({ error: "avatar_not_found_on_a2e", name: avatar_name, hint: "Crea el avatar en A2E con ese nombre exacto" });
      }
      avatar_id = found._id;
    }

    const r = await fetch(pj(A2E_BASE, "/api/v1/streaming-avatar/agora-token"), {
      method: "POST",
      headers: a2eHeaders(),
      body: JSON.stringify({ avatar_id, expire_seconds })
    });
    const data = await safeJSON(r);
    if (!r.ok) return res.status(r.status).json(data);

    const out = data?.data || data;
    return res.json({
      token: out?.token, appId: out?.appId, channel: out?.channel, uid: out?.uid,
      expire_epoch_timestamp: out?.expire_epoch_timestamp, expire_date_UTC: out?.expire_date_UTC
    });
  } catch (e) {
    res.status(500).json({ error: "a2e_token_failed", detail: String(e?.message || e) });
  }
});

// ===============================
// Bootstrap: crea 6 avatares desde /public
//   body: { base: "https://.../public" }
// ===============================
async function checkImageReachable(url) {
  try {
    // HEAD; si falla, GET pequeño
    let r = await fetch(url, { method: "HEAD" });
    if (!r.ok || Number(r.headers.get("content-length") || "0") === 0) {
      r = await fetch(url, { method: "GET" });
      if (!r.ok) return { ok: false, status: r.status, sample: await safeJSON(r) };
    }
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    if (!/image\//.test(ct)) return { ok: false, status: r.status, sample: { content_type: ct } };
    return { ok: true, status: r.status, content_type: ct };
  } catch (e) {
    return { ok: false, status: 0, sample: String(e?.message || e) };
  }
}

async function listAvatarsMap() {
  const list = await fetch(pj(A2E_BASE, "/api/v1/streaming-avatar/all_avatars"), {
    headers: a2eHeaders(), method: "GET"
  }).then(safeJSON);
  const map = new Map();
  for (const a of (list?.data || [])) {
    if (a?.name) map.set(a.name.toLowerCase(), a);
  }
  return map;
}

// intenta POST en varias rutas plausibles
async function tryCreateAvatar(name, imageUrl) {
  const candidates = [
    "/api/v1/streaming-avatar/create-avatar",
    "/api/v1/streaming-avatar/create",
    "/api/v1/avatar/create"
  ];
  const bodies = [
    { name, image_url: imageUrl },
    { name, imageURL: imageUrl },
    { name, img_url: imageUrl }
  ];

  for (const path of candidates) {
    for (const body of bodies) {
      try {
        const r = await fetch(pj(A2E_BASE, path), { method: "POST", headers: a2eHeaders(), body: JSON.stringify(body) });
        const data = await safeJSON(r);
        if (r.ok && (data?.data?._id || data?._id || data?.id)) {
          const id = data?.data?._id || data?._id || data?.id;
          return { ok: true, id, raw: data };
        }
        // 404/405 => probamos siguiente ruta
      } catch {}
    }
  }
  return { ok: false };
}

router.post("/bootstrap-avatars", async (req, res) => {
  try {
    if (!mustBaseOK(res)) return;
    const base = (req.body?.base || "").replace(/\/+$/, "");
    if (!base) return res.status(400).json({ error: "missing_base", hint: "body.base = https://.../public" });

    const names = ["JESPANOL","JINGLE","JALEMAN","JBRASILERO","JITALIANO","JCATALAN"];
    const results = [];
    const current = await listAvatarsMap();

    for (const name of names) {
      const image_url = `${base}/${name}.jpeg`;
      const chk = await checkImageReachable(image_url);
      if (!chk.ok) {
        results.push({ name, image_url, error: "image_not_reachable", sample: chk.sample || { status: chk.status } });
        continue;
      }

      const exists = current.get(name.toLowerCase());
      if (exists?._id) {
        results.push({ name, image_url, id: exists._id, created: false });
        continue;
      }

      const created = await tryCreateAvatar(name, image_url);
      if (created.ok) {
        results.push({ name, image_url, id: created.id, created: true });
      } else {
        results.push({ name, image_url, error: true, sample: { message: "Not Found" } });
      }
    }

    res.json({ base, results });
  } catch (e) {
    res.status(500).json({ error: "bootstrap_failed", detail: String(e?.message || e) });
  }
});

module.exports = router;
