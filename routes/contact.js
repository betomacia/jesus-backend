// routes/contact.js
//
// En producción NO expone /contact/debug ni /contact/selftest,
// salvo que pongas ALLOW_CONTACT_DEBUG=true.
// Aplica rate limit global al router (anti-spam).
//
// Env necesarios (Railway):
// - APPS_SCRIPT_URL  -> URL de tu Google Apps Script (Deployment "web app")
// - (opcional) MAIL_FROM_NAME, CONTACT_TO, REPLY_TO   // hoy los maneja el Script
//
// El asunto lleva prefijo "FORMULARIO:" para que tu regla de Gmail haga bypass de spam.

const express = require("express");
const rateLimit = require("express-rate-limit");

const router = express.Router();

// ---- Rate limit (anti-spam) ----
// 20 solicitudes por minuto por IP. Cambia 'max' si querés más/menos.
const limiter = rateLimit({
  windowMs: 60_000, // 1 minuto
  max: 20,          // 20 req/min/IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "rate_limited" },
});
router.use(limiter);

// ---- Helpers ----
const emailRx = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isProd = process.env.NODE_ENV === "production";
const allowDebug = process.env.ALLOW_CONTACT_DEBUG === "true";

// ---- POST /contact ----
// Reenvía al Apps Script vía fetch (Node 18+ trae fetch nativo)
router.post("/", async (req, res) => {
  try {
    const { name, email, message, website } = req.body || {};

    // Honeypot: si "website" viene con valor, asumimos bot y respondemos OK silencioso.
    if (website && String(website).trim() !== "") {
      return res.json({ ok: true });
    }

    // Validaciones mínimas
    if (!name || !email || !message) {
      return res.status(400).json({ ok: false, error: "Faltan campos" });
    }
    if (!emailRx.test(String(email))) {
      return res.status(400).json({ ok: false, error: "Email inválido" });
    }
    if (String(message).length > 5000) {
      return res.status(400).json({ ok: false, error: "Mensaje muy largo" });
    }

    const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
    if (!APPS_SCRIPT_URL) {
      return res.status(500).json({ ok: false, error: "APPS_SCRIPT_URL no configurada" });
    }

    // Armamos payload para el Script (incluye prefijo de asunto para bypass spam)
    const payload = {
      subject: `FORMULARIO: ${name}`, // <- mantiene el prefijo para tu regla de Gmail
      name,
      email,
      message,
    };

    const r = await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const text = await r.text(); // Apps Script suele responder texto plano/JSON
    if (!r.ok) {
      return res
        .status(500)
        .json({ ok: false, error: "apps_script_bad_status", status: r.status, script: { raw: text.slice(0, 800) } });
    }

    // Si el Script responde JSON válido, lo parseamos; si no, devolvemos ok simple
    try {
      const json = JSON.parse(text);
      return res.json(json.ok ? json : { ok: true, script: json });
    } catch {
      return res.json({ ok: true });
    }
  } catch (err) {
    console.error("[/contact] error:", err);
    return res.status(500).json({ ok: false, error: "Error en servidor" });
  }
});

// ---- Endpoints de depuración (solo no-producción o si ALLOW_CONTACT_DEBUG=true) ----
if (!isProd || allowDebug) {
  // Ver variables clave (sin valores sensibles)
  router.get("/debug", (_req, res) => {
    res.json({
      ok: true,
      env: {
        APPS_SCRIPT_URL: !!process.env.APPS_SCRIPT_URL,
        MAIL_FROM_NAME: process.env.MAIL_FROM_NAME || null,
        CONTACT_TO: process.env.CONTACT_TO || null,
        REPLY_TO: process.env.REPLY_TO || null,
        NODE_ENV: process.env.NODE_ENV || null,
        ALLOW_CONTACT_DEBUG: process.env.ALLOW_CONTACT_DEBUG || "false",
      },
    });
  });

  // Auto-test rápido (envía un mensaje de prueba al Script)
  router.get("/selftest", async (_req, res) => {
    try {
      const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
      if (!APPS_SCRIPT_URL) {
        return res.status(500).json({ ok: false, error: "APPS_SCRIPT_URL no configurada" });
      }
      const payload = {
        subject: `FORMULARIO: selftest ${new Date().toISOString()}`,
        name: "SelfTest",
        email: "no-reply@example.com",
        message: "Mensaje de prueba desde /contact/selftest",
      };
      const r = await fetch(APPS_SCRIPT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const text = await r.text();
      return res.json({ ok: r.ok, status: r.status, script: text.slice(0, 200) });
    } catch (e) {
      return res.status(500).json({ ok: false, error: "selftest_failed" });
    }
  });
}

module.exports = router;
