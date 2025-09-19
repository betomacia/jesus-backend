// routes/contact.js
const express = require("express");
const rateLimit = require("express-rate-limit");
const nodemailer = require("nodemailer");

const router = express.Router();

// Anti-spam simple
const limiter = rateLimit({ windowMs: 60_000, max: 20 });
router.use(limiter);

// Gmail SMTP (App Password)
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER,      // quien ENVÍA (ej: info@movilive.com)
    pass: process.env.GMAIL_APP_PASS,  // App Password
  },
});

const emailRx = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Helper fecha corta para subject único (evita threading)
function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// POST /contact — envía correo
router.post("/", async (req, res) => {
  try {
    const { name, email, message, website } = req.body || {};

    // Honeypot (si viene con texto, ignoramos)
    if (website && String(website).trim() !== "") {
      return res.json({ ok: true });
    }

    if (!name || !email || !message) {
      return res.status(400).json({ ok: false, error: "Faltan campos" });
    }
    if (!emailRx.test(String(email))) {
      return res.status(400).json({ ok: false, error: "Email inválido" });
    }
    if (String(message).length > 5000) {
      return res.status(400).json({ ok: false, error: "Mensaje muy largo" });
    }

    // Si falta SMTP, no rompemos UX
    if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASS) {
      console.log("[CONTACT][NO SMTP]", { name, email, message });
      return res.json({ ok: true, note: "SMTP no configurado" });
    }

    // Reply-To forzado por env (si existe y es válido)
    const fixedReplyTo = (process.env.REPLY_TO || "").trim();
    const useReplyTo = fixedReplyTo && emailRx.test(fixedReplyTo) ? fixedReplyTo : undefined;

    // From “humano” + sender técnico
    const fromName = process.env.MAIL_FROM_NAME || "Contacto App";
    const fromAddr = process.env.GMAIL_USER; // debe ser tu cuenta Gmail/Workspace
    const toAddr   = process.env.CONTACT_TO || process.env.GMAIL_USER;

    const subject = `Nuevo contacto: ${name} — ${stamp()}`;

    const mailOptions = {
      // Cabeceras visibles
      from: `"${fromName}" <${fromAddr}>`,      // lo que ve el receptor
      sender: fromAddr,                         // “Sender” explícito
      to: toAddr,
      subject,
      text:
        `Nombre: ${name}\n` +
        `Email (usuario): ${email}\n\n` +
        `${message}`,

      // Forzamos Reply-To fijo si está configurado
      ...(useReplyTo ? { replyTo: useReplyTo, headers: { "Reply-To": useReplyTo } } : {}),

      // Envelope SMTP (remitente real/bounce address)
      envelope: {
        from: fromAddr,
        to: toAddr,
      },
    };

    console.log("[CONTACT] from:", mailOptions.from, "| sender:", mailOptions.sender, "| to:", mailOptions.to, "| replyTo:", useReplyTo || "(none)");

    await transporter.sendMail(mailOptions);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Error en servidor" });
  }
});

// GET /contact/debug — inspección rápida de variables
router.get("/debug", (_req, res) => {
  res.json({
    ok: true,
    env: {
      GMAIL_USER: !!process.env.GMAIL_USER,
      CONTACT_TO: process.env.CONTACT_TO || null,
      MAIL_FROM_NAME: process.env.MAIL_FROM_NAME || null,
      REPLY_TO: process.env.REPLY_TO || null,
    },
  });
});

module.exports = router;
