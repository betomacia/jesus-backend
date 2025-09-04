// routes/a2e.js — Proxy A2E (Agora + Direct Speak + Bootstrap de avatar)
// ENV requeridas:
// A2E_BASE=https://video.a2e.ai
// A2E_API_KEY=TU_TOKEN_A2E (NO pongas "Bearer " aquí; abajo se añade si corresponde)
// A2E_AUTH_MODE=bearer  (o x-api-key)
// A2E_API_KEY_HEADER=Authorization (si usas bearer)
// PUBLIC_BASE=https://TU-APP.up.railway.app/public  (para crear avatar desde imagen pública)

const express = require("express");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
const router = express.Router();

// ========= Config =========
const A2E_BASE = (process.env.A2E_BASE || "").replace(/\/+$/, ""); // ej: https://video.a2e.ai
const A2E_API_KEY = process.env.A2E_API_KEY || ""; // token simple; abajo se agrega "Bearer " si corresponde
const A2E_AUTH_MODE = (process.env.A2E_AUTH_MODE || "bearer").toLowerCase(); // bearer | x-api-key
const A2E_API_KEY_HEADER = process.env.A2E_API_KEY_HEADER || "Authorization";
const PUBLIC_BASE = (process.env.PUBLIC_BASE || "").replace(/\/+$/, "");

// Endpoints reales de A2E (configurables)
const A2E_AVATARS_PATH = process.env.A2E_AVATARS_PATH || "/api/v1/streaming-avatar/all_avatars";
const A2E_TOKEN_PATH = process.env.A2E_TOKEN_PATH || "/api/v1/streaming-avatar/agora-token";
// Direct Speak: dejamos 2 candidatos comunes y probamos en orden
const A2E_SPEAK_PATHS = (process.env.A2E_SPEAK_PATHS ||
  "/api/v1/streaming-avatar/direct-speak,/api/v1/streaming-avatar/speak")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// (Opcional) Endpoints de “character/anchor” (pueden variar por cuenta A2E)
const A2E_CHARACTER_LIST = process.env.A2E_CHARACTER_LIST || "/api/v1/anchor/character_list";
const A2E_CREATE_FROM_IMAGE = process.env.A2E_CREATE_FROM_IMAGE || "/api/v1/userVideoTwin/startTraining";

// ========= Helpers =========
function a2eHeaders(extra = {}) {
  const h = {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...extra,
  };
  if (A2E_AUTH_MODE === "bearer" && A2E_API_KEY) {
    h[A2E_API_KEY_HEADER] = `Bearer ${A2E_API_KEY}`;
  } else if (A2E_AUTH_MODE === "x-api-key" && A2E_API_KEY) {
    h["x-api-key"] = A2E_API_KEY;
  }
  return h;
}

function mustBaseOK(res) {
  if (!A2E_BASE) {
    res.status(500).json({ error: "A2E_BASE_missing", hint: "Define A2E_BASE" });
    return false;
  }
  return true;
}

const join = (b, p) => `${b}${p.startsWith("/") ? "" : "/"}${p}`;

// ========= Health =========
router.get("/selftest", async (_req, res) => {
  try {
    if (!mustBaseOK(res)) return;
    const r = await fetch(join(A2E_BASE, "/"), { method: "GET", headers: a2eHeaders() });
    const txt = await r.text().catch(() => "");
    res.json({
      base: A2E_BASE,
      auth: !!A2E_API_KEY,
      status: r.status,
      content_type: r.headers.get("content-type") || "",
      sample: txt.slice(0, 240),
    });
  } catch (e) {
    res.status(500).json({ error: "selftest_failed", detail: String(e?.message || e) });
  }
});

// ========= Avatares (lista A2E) =========
router.get("/avatars", async (_req, res) => {
  try {
    if (!mustBaseOK(res)) return;
    const r = await fetch(join(A2E_BASE, A2E_AVATARS_PATH), {
      method: "GET",
      headers: a2eHeaders(),
    });
    const txt = await r.text().catch(() => "");
    let data = null;
    try { data = JSON.parse(txt); } catch {}
    res.status(r.ok ? 200 : r.status).json(data ?? { raw: txt });
  } catch (e) {
    res.status(500).json({ error: "avatars_failed", detail: String(e?.message || e) });
  }
});

// ========= Token Agora =========
router.post("/token", async (req, res) => {
  try {
    if (!mustBaseOK(res)) return;
    const { avatar_id, expire_seconds = 60 } = req.body || {};
    if (!avatar_id) return res.status(400).json({ error: "missing_avatar_id" });

    const r = await fetch(join(A2E_BASE, A2E_TOKEN_PATH), {
      method: "POST",
      headers: a2eHeaders(),
      body: JSON.stringify({ avatar_id, expire_seconds }),
    });
    const txt = await r.text().catch(() => "");
    let data = null;
    try { data = JSON.parse(txt); } catch {}

    if (r.ok) {
      if (data && typeof data.code === "number" && data.code !== 0) {
        return res.status(502).json(data);
      }
      return res.json(data ?? { raw: txt });
    }
    return res.status(r.status).json(data ?? { raw: txt });
  } catch (e) {
    res.status(500).json({ error: "token_failed", detail: String(e?.message || e) });
  }
});

// ========= Direct Speak =========
router.post("/talk", async (req, res) => {
  try {
    if (!mustBaseOK(res)) return;
    const { text, lang } = req.body || {};
    if (!text) return res.status(400).json({ error: "missing_text" });

    let lastErr = null;
    for (const p of A2E_SPEAK_PATHS) {
      try {
        const r = await fetch(join(A2E_BASE, p), {
          method: "POST",
          headers: a2eHeaders(),
          body: JSON.stringify({ text, lang }),
        });
        const txt = await r.text().catch(() => "");
        let data = null;
        try { data = JSON.parse(txt); } catch {}
        if (r.ok) {
          if (data && typeof data.code === "number" && data.code !== 0) {
            lastErr = data;
            continue;
          }
          return res.json(data ?? { raw: txt });
        } else {
          lastErr = data ?? { raw: txt, status: r.status };
        }
      } catch (e) {
        lastErr = { error: "speak_attempt_failed", detail: String(e?.message || e), path: p };
      }
    }
    return res.status(502).json(lastErr || { error: "all_speak_paths_failed" });
  } catch (e) {
    res.status(500).json({ error: "talk_failed", detail: String(e?.message || e) });
  }
});

// ========= Leave (liberar canal / costes) =========
router.post("/leave", async (req, res) => {
  try {
    if (!mustBaseOK(res)) return;
    const { channel, uid } = req.body || {};
    if (!channel) return res.status(400).json({ error: "missing_channel" });

    const r = await fetch(join(A2E_BASE, "/api/v1/streaming-avatar/leave"), {
      method: "POST",
      headers: a2eHeaders(),
      body: JSON.stringify({ channel, uid }),
    });
    const txt = await r.text().catch(() => "");
    let data = null;
    try { data = JSON.parse(txt); } catch {}
    res.status(r.ok ? 200 : r.status).json(data ?? { raw: txt });
  } catch (e) {
    res.status(500).json({ error: "leave_failed", detail: String(e?.message || e) });
  }
});

// ========= Crear / asegurar avatar desde imagen pública =========
// GET /api/a2e/avatar-id?lang=es -> { avatar_id, pending }
// Reintenta cada 30-60s hasta que pending=false y tengas avatar_id.
router.get("/avatar-id", async (req, res) => {
  try {
    if (!mustBaseOK(res)) return;
    const lang = (req.query.lang || "es").toString().toLowerCase();

    // 1) ¿existe ya?
    const listResp = await fetch(join(A2E_BASE, A2E_CHARACTER_LIST), {
      method: "GET",
      headers: a2eHeaders(),
    });
    const listTxt = await listResp.text().catch(() => "");
    let list = null;
    try { list = JSON.parse(listTxt); } catch {}
    const wantedName = `jesus-${lang}`;
    const found = (list?.data || []).find((x) => x?.name === wantedName && x?._id);
    if (found?._id) return res.json({ avatar_id: found._id, pending: false });

    // 2) si no existe, lo creamos desde tu imagen pública
    if (!PUBLIC_BASE) {
      return res.status(500).json({ error: "PUBLIC_BASE_missing", hint: "Define PUBLIC_BASE (https://TU-APP/public)" });
    }
    const fileByLang = {
      es: "JESPANOL.jpeg",
      en: "JENGLISH.jpeg",
      pt: "JPORTUGUES.jpeg",
      it: "JITALIANO.jpeg",
      de: "JALEMAN.jpeg",
      ca: "JCATALAN.jpeg",
    };
    const fileName = fileByLang[lang] || fileByLang.es;
    const image_url = `${PUBLIC_BASE}/${fileName}`;

    const createResp = await fetch(join(A2E_BASE, A2E_CREATE_FROM_IMAGE), {
      method: "POST",
      headers: a2eHeaders(),
      body: JSON.stringify({
        name: wantedName,
        gender: "male",
        image_url,
      }),
    });
    const createTxt = await createResp.text().catch(() => "");
    let created = null;
    try { created = JSON.parse(createTxt); } catch {}

    // Entrenamiento asíncrono: devolvemos pending:true
    return res.json({
      pending: true,
      task_id: created?.data?._id || null,
      hint: "Reintenta en 30-60s y vuelve a llamar a /api/a2e/avatar-id",
    });
  } catch (e) {
    res.status(500).json({ error: "avatar_bootstrap_failed", detail: String(e?.message || e) });
  }
});

module.exports = router;
