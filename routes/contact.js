// routes/contact.js
// Enruta POST /contact hacia un Web App de Google Apps Script con clave compartida.
// No requiere googleapis, ni SMTP. Railway solo necesita APPS_SCRIPT_URL y APPS_SCRIPT_KEY.

const express = require("express");
const rateLimit = require("express-rate-limit");

const router = express.Router();

// ------- Rate limit (anti-spam) -------
const limiter = rateLimit({
  windowMs: 60_000, // 1 minuto
  max: 20,          // 20 req/min por IP
});
router.use(limiter);

// ------- Helpers -------
const has = (v) => typeof v === "string" && v.trim().length > 0;
const emailRx = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// fetch con timeout
async function postJson(url, data, { timeoutMs = 12_000 } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
      signal: ac.signal,
    });
    const text = await r.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { ok: r.ok, status: r.status, json };
  } finally {
    clearTimeout(t);
  }
}

// ------- Debug env -------
router.get("/debug", (_req, res) => {
  res.json({
    ok: true,
    env: {
      APPS_SCRIPT_URL: !!process.env.APPS_SCRIPT_URL,
      APPS_SCRIPT_KEY: !!process.env.APPS_SCRIPT_KEY,
    },
  });
});

// ------- Ping rápido al Script (opcional) -------
router.get("/selftest", async (_req, res) => {
  const url = process.env.APPS_SCRIPT_URL || "";
  const key = process.env.APPS_SCRIPT_KEY || "";
  if (!has(url) || !has(key)) {
    return res
      .status(500)
      .json({ ok: false, error: "missing_env", detail: { APPS_SCRIPT_URL: !!url, APPS_SCRIPT_KEY: !!key } });
  }
  try {
    const payload = { name: "SelfTest", email: "noreply@example.com", message: "Ping", key };
    const r = await postJson(url, payload, { timeoutMs: 10_000 });
    return res.status(r.ok ? 200 : 500).json({ ok: r.ok, status: r.status, script: r.json });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "script_error", detail: String(e) });
  }
});

// ------- POST /contact -------
router.post("/", async (req, res) => {
  try {
    const url = process.env.APPS_SCRIPT_URL || "";
    const key = process.env.APPS_SCRIPT_KEY || "";

    if (!has(url) || !has(key)) {
      return res
        .status(500)
        .json({ ok: false, error: "server_not_configured", detail: { APPS_SCRIPT_URL: !!url, APPS_SCRIPT_KEY: !!key } });
    }

    const { name = "", email = "", message = "", website = "" } = req.body || {};

    // Honeypot (campo oculto). Si viene con algo, lo ignoramos como OK.
    if (has(website)) return res.json({ ok: true });

    // Validaciones mínimas
    if (!has(name) || !has(email) || !has(message)) {
      return res.status(400).json({ ok: false, error: "missing_fields" });
    }
    if (!emailRx.test(String(email))) {
      return res.status(400).json({ ok: false, error: "invalid_email" });
    }
    if (String(message).length > 5000) {
      return res.status(400).json({ ok: false, error: "message_too_long" });
    }

    // Payload al Apps Script
    const payload = { name: String(name), email: String(email), message: String(message), key };

    const scriptResp = await postJson(url, payload, { timeoutMs: 12_000 });

    if (!scriptResp.ok) {
      return res.status(502).json({
        ok: false,
        error: "apps_script_bad_status",
        status: scriptResp.status,
        script: scriptResp.json,
      });
    }

    // El script responde { ok: true } en éxito
    if (scriptResp.json && scriptResp.json.ok) {
      return res.json({ ok: true });
    } else {
      return res.status(500).json({ ok: false, error: "apps_script_response", script: scriptResp.json });
    }
  } catch (err) {
    return res.status(500).json({ ok: false, error: "server_exception", detail: String(err) });
  }
});

module.exports = router;
