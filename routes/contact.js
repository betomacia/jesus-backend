// routes/contact.js
const express = require("express");
const rateLimit = require("express-rate-limit");
const nodemailer = require("nodemailer");

const router = express.Router();

// Rate limit anti-spam
const limiter = rateLimit({ windowMs: 60_000, max: 20 });
router.use(limiter);

// Validación básica de email
const emailRx = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---- Construcción de transportes (intenta 587 y luego 465) ----
function buildTransports() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASS;
  const host = process.env.SMTP_HOST || "smtp.gmail.com";

  const transports = [];

  // Preferido: STARTTLS (587)
  transports.push(
    nodemailer.createTransport({
      host,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: false, // STARTTLS
      auth: { user, pass },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      tls: { minVersion: "TLSv1.2" },
    })
  );

  // Fallback: SSL (465)
  transports.push(
    nodemailer.createTransport({
      host,
      port: 465,
      secure: true, // SSL directo
      auth: { user, pass },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      tls: { minVersion: "TLSv1.2" },
    })
  );

  return transports;
}

async function sendMailWithFallback(mail) {
  const transports = buildTransports();
  let lastErr;
  for (const t of transports) {
    try {
      await t.verify();           // prueba de conexión/handshake
      return await t.sendMail(mail);
    } catch (err) {
      lastErr = err;              // guarda el último error y sigue con el próximo puerto
    }
  }
  const e = new Error("smtp_failed");
  e.detail = lastErr;
  throw e;
}

// ---- Endpoints de diagnóstico ----
router.get("/debug", (_req, res) => {
  res.json({
    ok: true,
    env: {
      GMAIL_USER: !!process.env.GMAIL_USER,
      GMAIL_APP_PASS: !!process.env.GMAIL_APP_PASS,
      CONTACT_TO: process.env.CONTACT_TO || null,
      MAIL_FROM_NAME: process.env.MAIL_FROM_NAME || null,
      REPLY_TO: process.env.REPLY_TO || null,
      SMTP_HOST: process.env.SMTP_HOST || "smtp.gmail.com",
      SMTP_PORT: Number(process.env.SMTP_PORT) || 587,
    },
  });
});

router.get("/selftest", async (_req, res) => {
  const results = [];
  for (const t of buildTransports()) {
    try {
      const ok = await t.verify();
      results.push({
        ok: !!ok,
        host: t.options.host,
        port: t.options.port,
        secure: t.options.secure,
      });
    } catch (err) {
      results.push({
        ok: false,
        host: t.options.host,
        port: t.options.port,
        secure: t.options.secure,
        code: err.code,
        command: err.command,
        responseCode: err.responseCode,
        message: err.message,
      });
    }
  }
  res.json({ ok: results.some((r) => r.ok), results });
});

// ---- POST /contact ----
router.post("/", async (req, res) => {
  try {
    const { name, email, message, website } = req.body || {};

    // Honeypot opcional
    if (website && String(website).trim() !== "") {
      return res.json({ ok: true, skipped: "honeypot" });
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

    // Sin SMTP configurado → no romper UX
    if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASS) {
      console.log("[CONTACT][NO SMTP]", { name, email, message });
      return res.json({ ok: true, note: "SMTP no configurado" });
    }

    const fromName = process.env.MAIL_FROM_NAME || "Contacto App";
    const fromAddr = process.env.GMAIL_USER; // SIEMPRE tu Gmail
    const toAddr = process.env.CONTACT_TO || process.env.GMAIL_USER;
    const replyTo = process.env.REPLY_TO || email; // si definiste REPLY_TO, fija ese

    const subject = `Nuevo contacto: ${name} (${Date.now()})`;

    await sendMailWithFallback({
      from: `"${fromName}" <${fromAddr}>`,
      to: toAddr,
      replyTo,
      subject,
      text: `Nombre: ${name}\nEmail: ${email}\n\n${message}`,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("[CONTACT][ERROR]", err);
    const out = { ok: false, error: "Error en servidor" };
    // Información útil de SMTP (si existe)
    if (err && (err.code || err.command || err.responseCode)) {
      out.smtp = {
        code: err.code || null,
        command: err.command || null,
        responseCode: err.responseCode || null,
        response: String(err.response || err.message || ""),
      };
    }
    if (err && err.detail && (err.detail.code || err.detail.command)) {
      out.smtp = {
        code: err.detail.code || out.smtp?.code || null,
        command: err.detail.command || out.smtp?.command || null,
        responseCode: err.detail.responseCode || out.smtp?.responseCode || null,
        response: String(err.detail.response || err.detail.message || ""),
      };
    }
    res.status(500).json(out);
  }
});

module.exports = router;
