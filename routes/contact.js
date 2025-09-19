// routes/contact.js
const express = require("express");
const rateLimit = require("express-rate-limit");
const nodemailer = require("nodemailer");

const router = express.Router();

// Rate limit simple (anti-spam)
const limiter = rateLimit({ windowMs: 60_000, max: 20 });
router.use(limiter);

// Transporter Gmail (usa App Password)
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER,      // la cuenta que ENVÍA
    pass: process.env.GMAIL_APP_PASS,  // App Password (no tu pass normal)
  },
});

// Validación básica de email
const emailRx = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// POST /contact
router.post("/", async (req, res) => {
  try {
    const { name, email, message, website } = req.body || {};

    // Honeypot opcional: si viene con contenido, ignoramos (bot)
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

    // Si falta config SMTP, no rompemos UX: log y OK
    if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASS) {
      console.log("[CONTACT][NO SMTP]", { name, email, message });
      return res.json({ ok: true, note: "SMTP no configurado" });
    }

    // Reply-To configurable por variable de entorno:
    // - Si REPLY_TO existe y es válido -> usamos ese fijo (control total desde Railway).
    // - Si NO está, usamos el email que envía el usuario (comportamiento anterior).
    const fixedReplyTo = (process.env.REPLY_TO || "").trim();
    const useFixedReplyTo = fixedReplyTo && emailRx.test(fixedReplyTo);

    const mailOptions = {
      from: `"${process.env.MAIL_FROM_NAME || "Contacto App"}" <${process.env.GMAIL_USER}>`,
      to: process.env.CONTACT_TO || process.env.GMAIL_USER,
      subject: `Nuevo contacto: ${name}`,
      text: `Nombre: ${name}\nEmail: ${email}\n\n${message}`,
      // Si definiste REPLY_TO en Railway y es válido, se usa ese. Sino, el del usuario.
      replyTo: useFixedReplyTo ? fixedReplyTo : { name, address: email },
    };

    await transporter.sendMail(mailOptions);

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Error en servidor" });
  }
});

module.exports = router;
