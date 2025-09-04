// routes/a2e.js — Proxy A2E (Agora + Direct Speak + Bootstrap de avatar + utilidades)
// ENV necesarias (en tu backend / Railway):
// A2E_BASE=https://api.a2e.ai
// A2E_API_KEY=TU_TOKEN_A2E
// A2E_AUTH_MODE=bearer
// A2E_API_KEY_HEADER=Authorization
// PUBLIC_BASE=https://TU-APP.up.railway.app/public
//
// (opcionales, por si tu cuenta usa paths alternativos)
// A2E_CHARACTER_LIST=/api/v1/anchor/character_list
// A2E_CREATE_FROM_IMAGE=/api/v1/userVideoTwin/startTraining
// A2E_AVATARS_PATH=/api/v1/streaming-avatar/all_avatars
// A2E_SPEAK_PATHS=/api/v1/streaming-avatar/direct-speak,/api/v1/streaming-avatar/speak
// A2E_PROGRESS_PATH=/api/v1/userVideoTwin/queryProgress   <-- si tu cuenta expone progreso por task_id

const express = require("express");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
const router = express.Router();

const A2E_BASE = (process.env.A2E_BASE || "").replace(/\/+$/, "");
const A2E_API_KEY = process.env.A2E_API_KEY || "";
const A2E_AUTH_MODE = (process.env.A2E_AUTH_MODE || "bearer").toLowerCase();
const A2E_API_KEY_HEADER = process.env.A2E_API_KEY_HEADER || "Authorization";
const PUBLIC_BASE = (process.env.PUBLIC_BASE || "").replace(/\/+$/, "");

const A2E_AVATARS_PATH = process.env.A2E_AVATARS_PATH || "/api/v1/streaming-avatar/all_avatars";
const A2E_TOKEN_PATH   = process.env.A2E_TOKEN_PATH   || "/api/v1/streaming-avatar/agora-token";
const A2E_SPEAK_PATHS  = (process.env.A2E_SPEAK_PATHS ||
  "/api/v1/streaming-avatar/direct-speak,/api/v1/streaming-avatar/speak")
  .split(",").map(s => s.trim()).filter(Boolean);

const A2E_CHARACTER_LIST    = process.env.A2E_CHARACTER_LIST    || "/api/v1/anchor/character_list";
const A2E_CREATE_FROM_IMAGE = process.env.A2E_CREATE_FROM_IMAGE || "/api/v1/userVideoTwin/startTraining";
const A2E_PROGRESS_PATH     = process.env.A2E_PROGRESS_PATH     || "/api/v1/userVideoTwin/queryProgress";

function a2eHeaders(extra = {}) {
  const h = { Accept: "application/json", "Content-Type": "application/json", ...extra };
  if (A2E_AUTH_MODE === "bearer" && A2E_API_KEY) h[A2E_API_KEY_HEADER] = `Bearer ${A2E_API_KEY}`;
  else if (A2E_AUTH_MODE === "x-api-key" && A2E_API_KEY) h["x-api-key"] = A2E_API_KEY;
  return h;
}
function mustBaseOK(res) {
  if (!A2E_BASE) { res.status(500).json({ error: "A2E_BASE_missing", hint: "Define A2E_BASE" }); return false; }
  return true;
}
const join = (b, p) => `${b}${p.startsWith("/") ? "" : "/"}${p}`;

// --- PING simple para verificar montaje del router ---
router.get("/ping", (_req, res) => { res.json({ ok: true, scope: "a2e-router" }); });

// --- health simple ---
router.get("/selftest", async (_req, res) => {
  try {
    if (!mustBaseOK(res)) return;
    const r = await fetch(join(A2E_BASE, "/"), { method: "GET", headers: a2eHeaders() });
    const txt = await r.text().catch(() => "");
    res.json({
      base: A2E_BASE, auth: !!A2E_API_KEY, status: r.status,
      content_type: r.headers.get("content-type") || "",
      sample: txt.slice(0, 240),
    });
  } catch (e) {
    res.status(500).json({ error: "selftest_failed", detail: String(e?.message || e) });
  }
});

// --- listar avatares (A2E) ---
router.get("/avatars", async (_req, res) => {
  try {
    if (!mustBaseOK(res)) return;
    const r = await fetch(join(A2E_BASE, A2E_AVATARS_PATH), { method: "GET", headers: a2eHeaders() });
    const txt = await r.text().catch(() => "");
    let data = null; try { data = JSON.parse(txt); } catch {}
    res.status(r.ok ? 200 : r.status).json(data ?? { raw: txt });
  } catch (e) {
    res.status(500).json({ error: "avatars_failed", detail: String(e?.message || e) });
  }
});

// --- token agora ---
router.post("/token", async (req, res) => {
  try {
    if (!mustBaseOK(res)) return;
    const { avatar_id, expire_seconds = 60 } = req.body || {};
    if (!avatar_id) return res.status(400).json({ error: "missing_avatar_id" });

    const r = await fetch(join(A2E_BASE, A2E_TOKEN_PATH), {
      method: "POST", headers: a2eHeaders(), body: JSON.stringify({ avatar_id, expire_seconds }),
    });
    const txt = await r.text().catch(() => "");
    let data = null; try { data = JSON.parse(txt); } catch {}

    if (r.ok) {
      if (data && typeof data.code === "number" && data.code !== 0) return res.status(502).json(data);
      return res.json(data ?? { raw: txt });
    }
    return res.status(r.status).json(data ?? { raw: txt });
  } catch (e) {
    res.status(500).json({ error: "token_failed", detail: String(e?.message || e) });
  }
});

// --- direct speak ---
router.post("/talk", async (req, res) => {
  try {
    if (!mustBaseOK(res)) return;
    const { text, lang } = req.body || {};
    if (!text) return res.status(400).json({ error: "missing_text" });

    let lastErr = null;
    for (const p of A2E_SPEAK_PATHS) {
      try {
        const r = await fetch(join(A2E_BASE, p), {
          method: "POST", headers: a2eHeaders(), body: JSON.stringify({ text, lang })
        });
        const txt = await r.text().catch(() => "");
        let data = null; try { data = JSON.parse(txt); } catch {}
        if (r.ok) {
          if (data && typeof data.code === "number" && data.code !== 0) { lastErr = data; continue; }
          return res.json(data ?? { raw: txt });
        } else {
          lastErr = data ?? { raw: txt, status: r.status };
        }
      } catch (e) {
        lastErr = { error: "speak_attempt_failed", detail: String(e?.message || e) };
      }
    }
    return res.status(502).json(lastErr || { error: "all_speak_paths_failed" });
  } catch (e) {
    res.status(500).json({ error: "talk_failed", detail: String(e?.message || e) });
  }
});

// --- leave ---
router.post("/leave", async (req, res) => {
  try {
    if (!mustBaseOK(res)) return;
    const { channel, uid } = req.body || {};
    if (!channel) return res.status(400).json({ error: "missing_channel" });

    const r = await fetch(join(A2E_BASE, "/api/v1/streaming-avatar/leave"), {
      method: "POST", headers: a2eHeaders(), body: JSON.stringify({ channel, uid })
    });
    const txt = await r.text().catch(() => "");
    let data = null; try { data = JSON.parse(txt); } catch {}
    res.status(r.ok ? 200 : r.status).json(data ?? { raw: txt });
  } catch (e) {
    res.status(500).json({ error: "leave_failed", detail: String(e?.message || e) });
  }
});

// --- UTIL DEBUG: listar en varias rutas para cazar IDs ---
router.get("/list-all", async (_req, res) => {
  try {
    if (!mustBaseOK(res)) return;
    const tries = [
      { name: "character_list", path: A2E_CHARACTER_LIST },
      { name: "all_avatars",   path: A2E_AVATARS_PATH },
      { name: "anchor_list_alt1", path: "/api/v1/anchor/list" },
      { name: "anchor_list_alt2", path: "/api/v1/streaming-avatar/anchor_list" },
    ];
    const out = [];
    for (const t of tries) {
      try {
        const r = await fetch(join(A2E_BASE, t.path), { method: "GET", headers: a2eHeaders() });
        const txt = await r.text().catch(()=> "");
        let json = null; try { json = JSON.parse(txt); } catch {}
        out.push({ ok: r.ok, name: t.name, path: t.path, status: r.status, json, head: txt.slice(0, 400) });
      } catch (e) {
        out.push({ ok: false, name: t.name, path: t.path, error: String(e?.message || e) });
      }
    }
    res.json({ base: A2E_BASE, results: out });
  } catch (e) {
    res.status(500).json({ error: "list_all_failed", detail: String(e?.message || e) });
  }
});

// --- ENSURE-AVATAR: crea/asegura un avatar desde tu imagen pública ---
router.get("/ensure-avatar", async (req, res) => {
  try {
    if (!mustBaseOK(res)) return;

    const name = String(req.query.name || "jesus-es").trim();
    const img  = String(req.query.image || "JESPANOL.jpeg").trim();

    // 1) buscar si ya existe (en varios listados)
    const listPaths = [
      A2E_CHARACTER_LIST,
      "/api/v1/anchor/list",
      "/api/v1/streaming-avatar/anchor_list",
      A2E_AVATARS_PATH,
    ];
    for (const p of listPaths) {
      try {
        const lr = await fetch(join(A2E_BASE, p), { method: "GET", headers: a2eHeaders() });
        const ltxt = await lr.text().catch(()=> "");
        let lj = null; try { lj = JSON.parse(ltxt); } catch {}
        const arr = (lj?.data && Array.isArray(lj.data)) ? lj.data : [];
        const found = arr.find((x) => String(x?.name || "").trim() === name && (x?._id || x?.id));
        if (found) {
          const id = found._id || found.id;
          return res.json({ avatar_id: id, pending: false, from: p });
        }
      } catch {}
    }

    // 2) crear si no existe aún
    if (!PUBLIC_BASE) {
      return res.status(500).json({ error: "PUBLIC_BASE_missing", hint: "Define PUBLIC_BASE (https://TU-APP/public)" });
    }
    const image_url = `${PUBLIC_BASE}/${img}`;
    const createCandidates = [
      A2E_CREATE_FROM_IMAGE,
      "/api/v1/anchor/create_from_img",
      "/api/v1/streaming-avatar/create_from_img",
    ];
    let last = null;
    for (const p of createCandidates) {
      try {
        const cr = await fetch(join(A2E_BASE, p), {
          method: "POST", headers: a2eHeaders(),
          body: JSON.stringify({ name, image_url, gender: "male" }),
        });
        const ctxt = await cr.text().catch(() => "");
        let cj = null; try { cj = JSON.parse(ctxt); } catch {}

        // Intenta extraer task_id con distintos nombres comunes
        const task_id =
          (cj && (cj.task_id || cj.taskId || cj.job_id || cj.queue_id)) || null;

        last = { path: p, status: cr.status, body: cj || ctxt.slice(0, 300), task_id };

        // Muchos endpoints devuelven 200/202 incluso en cola
        if (cr.ok && (!cj || typeof cj.code !== "number" || cj.code === 0)) {
          return res.json({ pending: true, path: p, note: "entrenando; vuelve a consultar en 30-60s", ...(task_id ? { task_id } : {}) });
        }
      } catch (e) {
        last = { path: p, error: String(e?.message || e) };
      }
    }
    return res.status(502).json({ error: "create_failed", last });
  } catch (e) {
    res.status(500).json({ error: "ensure_avatar_failed", detail: String(e?.message || e) });
  }
});

// --- ENSURE-AVATAR STATUS: verifica si ya existe o consulta progreso por task_id ---
router.get("/ensure-avatar/status", async (req, res) => {
  try {
    if (!mustBaseOK(res)) return;

    const name = String(req.query.name || "").trim();
    const task_id = String(req.query.task_id || req.query.taskId || "").trim();

    // 1) Comprobar si YA existe por nombre (método más fiable)
    if (name) {
      const listPaths = [
        A2E_CHARACTER_LIST,
        "/api/v1/anchor/list",
        "/api/v1/streaming-avatar/anchor_list",
        A2E_AVATARS_PATH,
      ];
      for (const p of listPaths) {
        try {
          const lr = await fetch(join(A2E_BASE, p), { method: "GET", headers: a2eHeaders() });
          const ltxt = await lr.text().catch(()=> "");
          let lj = null; try { lj = JSON.parse(ltxt); } catch {}
          const arr = (lj?.data && Array.isArray(lj.data)) ? lj.data : [];
          const found = arr.find((x) => String(x?.name || "").trim() === name && (x?._id || x?.id));
          if (found) {
            const id = found._id || found.id;
            return res.json({ pending: false, avatar_id: id, from: p });
          }
        } catch {}
      }
    }

    // 2) (Opcional) Si nos dieron task_id, intenta consultar progreso
    if (task_id) {
      try {
        const pr = await fetch(join(A2E_BASE, A2E_PROGRESS_PATH), {
          method: "GET",
          headers: a2eHeaders(),
        });
        // Muchas cuentas requieren query param: /queryProgress?task_id=...
        // Intento #2 con query param:
        const pr2 = await fetch(join(A2E_BASE, `${A2E_PROGRESS_PATH}?task_id=${encodeURIComponent(task_id)}`), {
          method: "GET",
          headers: a2eHeaders(),
        }).catch(() => null);

        const txt = pr2 ? await pr2.text().catch(()=> "") : await pr.text().catch(()=> "");
        let pj = null; try { pj = JSON.parse(txt); } catch {}
        return res.json({ pending: true, task_id, progress_raw: pj || txt.slice(0, 200) });
      } catch (e) {
        return res.json({ pending: true, task_id, progress_error: String(e?.message || e) });
      }
    }

    // 3) Si no hay name ni task_id válidos, seguimos pending
    return res.json({ pending: true, hint: "pasa ?name=jesus-es o ?task_id=..." });
  } catch (e) {
    res.status(500).json({ error: "ensure_avatar_status_failed", detail: String(e?.message || e) });
  }
});

module.exports = router;
