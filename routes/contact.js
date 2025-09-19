// routes/contact.js
const express = require("express");
const rateLimit = require("express-rate-limit");
const nodemailer = require("nodemailer");

const router = express.Router();

// ---------- Rate limit (anti-spam) ----------
const limiter = rateLimit({ windowMs: 60_000, max: 20 });
router.use(limiter);

// ---------- ENV ----------
const {
  GMAIL_USER,
  GMAIL_APP_PASS,
  CONTACT_TO,
  MAIL_FROM_NAME,
  REPLY_TO,           // si lo pones, fuerza Reply-To fijo
  SMTP_HOST = "smtp.gmail.com",
  SMTP_PORT = "587",              // 587 = STARTTLS
  SMTP_SECURE = "false",          // false porque 587 usa STARTTLS
  RESEND_API_KEY,                 // si existe, enviamos por Resend (HTTP)
  RESEND_FROM,                    // ej: "Jesús <no-reply@tudominio.com>"
} = process.env;

// ---------- Validación básica ----------
const emailRx = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------- Resend (HTTP) ----------
async function sendViaResend({ from, to, replyTo, subject, text }) {
  if (!RESEND_API_KEY) return { ok: false, why: "no_resend_key" };
  const body = {
    from: RESEND_FROM || from, // debe ser un remitente verificado en Resend
    to: Array.isArray(to) ? to : [to],
    subject,
    text,
  };
  if (replyTo) body.reply_to = replyTo;

  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const json = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, json };
}

// ---------- Nodemailer (SMTP) ----------
let transporter = null;
if (GMAIL_USER && GMAIL_APP_PASS) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: String(SMTP_SECURE).toLowerCase() === "true", // 465=true, 587=false
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASS },
    connectionTimeout: 10_000,
    socketTimeout: 15_000,
  });
}

// ---------- POST /contact ----------
router.post("/", async (req, res) => {
  try {
    const { name, email, message, website } = req.body || {};

    // Honeypot (bot)
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

    const to = CONTACT_TO || GMAIL_USER; // destino
    const fromName = MAIL_FROM_NAME || "Contacto App";
    const from = `"${fromName}" <${GMAIL_USER || "no-reply@localhost"}>`;
    const replyToHeader = REPLY_TO || email; // si seteas REPLY_TO en env, se usa fijo

    const subject = `Nuevo contacto: ${name} — ${new Date().toISOString()}`;
    const text = `Nombre: ${name}\nEmail: ${email}\n\n${message}`;

    // 1) Si hay RESEND_API_KEY, mandamos por Resend (HTTP, evita bloqueos SMTP)
    if (RESEND_API_KEY) {
      const r = await sendViaResend({
        from,
        to,
        replyTo: replyToHeader,
        subject,
        text,
      });
      if (r.ok) return res.json({ ok: true, provider: "resend" });
      console.error("[CONTACT][RESEND_FAIL]", r);
      // si falla Resend y además tenemos SMTP, intentamos SMTP como fallback
    }

    // 2) SMTP (Gmail)
    if (transporter) {
      await transporter.sendMail({
        from,                // debe ser tu GMAIL_USER (el autenticado)
        to,
        replyTo: replyToHeader,
        subject,
        text,
      });
      return res.json({ ok: true, provider: "smtp" });
    }

    // 3) Sin provider: no rompemos UX
    console.log("[CONTACT][NO PROVIDER] Log only:", { name, email, message });
    return res.json({ ok: true, provider: "none" });
  } catch (err) {
    console.error("[CONTACT][ERROR]", err);
    // devolvemos error simplificado; el detalle queda en logs
    return res.status(500).json({ ok: false, error: "Error en servidor" });
  }
});

// ---------- DEBUG ----------
router.get("/debug", (_req, res) => {
  res.json({
    ok: true,
    env: {
      GMAIL_USER: !!GMAIL_USER,
      GMAIL_APP_PASS: !!GMAIL_APP_PASS,
      CONTACT_TO: CONTACT_TO || null,
      MAIL_FROM_NAME: MAIL_FROM_NAME || null,
      REPLY_TO: REPLY_TO || null,
      SMTP_HOST,
      SMTP_PORT,
      SMTP_SECURE,
      RESEND: !!RESEND_API_KEY,
      RESEND_FROM: RESEND_FROM || null,
    },
  });
});

// Verificación SMTP (opcional)
router.get("/verify", async (_req, res) => {
  if (!transporter) return res.json({ ok: false, error: "no_smtp_config" });
  try {
    await transporter.verify();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: "smtp_verify_failed", detail: String(e && e.message) });
  }
});

module.exports = router;
