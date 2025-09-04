const express = require("express");
}
function mustBaseOK(res) {
if (!A2E_BASE) { res.status(500).json({ error: "A2E_BASE_missing", hint: "Define A2E_BASE" }); return false; }
return true;
}
const join = (b, p) => `${b}${p.startsWith("/") ? "" : "/"}${p}`;


router.get("/selftest", async (_req, res) => {
try {
if (!mustBaseOK(res)) return;
const r = await fetch(join(A2E_BASE, "/"), { method: "GET", headers: a2eHeaders() });
const txt = await r.text().catch(() => "");
res.json({ base: A2E_BASE, auth: !!A2E_API_KEY, status: r.status, content_type: r.headers.get("content-type") || "", sample: txt.slice(0, 240) });
} catch (e) { res.status(500).json({ error: "selftest_failed", detail: String(e?.message || e) }); }
});


router.get("/avatars", async (_req, res) => {
try {
if (!mustBaseOK(res)) return;
const r = await fetch(join(A2E_BASE, A2E_AVATARS_PATH), { method: "GET", headers: a2eHeaders() });
const txt = await r.text().catch(() => "");
let data = null; try { data = JSON.parse(txt); } catch {}
res.status(r.ok ? 200 : r.status).json(data ?? { raw: txt });
} catch (e) { res.status(500).json({ error: "avatars_failed", detail: String(e?.message || e) }); }
});


router.post("/token", async (req, res) => {
try {
if (!mustBaseOK(res)) return;
const { avatar_id, expire_seconds = 60 } = req.body || {};
if (!avatar_id) return res.status(400).json({ error: "missing_avatar_id" });


const r = await fetch(join(A2E_BASE, A2E_TOKEN_PATH), {
method: "POST", headers: a2eHeaders(), body: JSON.stringify({ avatar_id, expire_seconds })
});
const txt = await r.text().catch(() => "");
let data = null; try { data = JSON.parse(txt); } catch {}


if (r.ok) {
if (data && typeof data.code === "number" && data.code !== 0) return res.status(502).json(data);
return res.json(data ?? { raw: txt });
}
return res.status(r.status).json(data ?? { raw: txt });
} catch (e) { res.status(500).json({ error: "token_failed", detail: String(e?.message || e) }); }
});


router.post("/talk", async (req, res) => {
try {
if (!mustBaseOK(res)) return;
const { text, lang } = req.body || {};
if (!text) return res.status(400).json({ error: "missing_text" });


let lastErr = null;
for (const p of A2E_SPEAK_PATHS) {
try {
const r = await fetch(join(A2E_BASE, p), { method: "POST", headers: a2eHeaders(), body: JSON.stringify({ text, lang }) });
const txt = await r.text().catch(() => "");
let data = null; try { data = JSON.parse(txt); } catch {}
if (r.ok) { if (data && typeof data.code === "number" && data.code !== 0) { lastErr = data; continue; } return res.json(data ?? { raw: txt }); }
else { lastErr = data ?? { raw: txt, status: r.status }; }
} catch (e) { lastErr = { error: "speak_attempt_failed", detail: String(e?.message || e), path: p }; }
}
return res.status(502).json(lastErr || { error: "all_speak_paths_failed" });
} catch (e) { res.status(500).json({ error: "talk_failed", detail: String(e?.message || e) }); }
});


// Compat opcional: /leave (no hace nada, para que el front no rompa si llama)
router.post("/leave", async (_req, res) => { res.json({ ok: true }); });


module.exports = router;
