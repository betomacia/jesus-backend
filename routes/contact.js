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

// ⚙️ Helper: resuelve Reply-To (FORZADO por env si existe)
function resolveReplyTo(name, userEmail) {
  const fixedReplyTo = (process.env.REPLY_TO || "").trim();

  if (fixedReplyTo && emailRx.test(fixedReplyTo)) {
    // 🚩 Forzamos SIEMPRE el Reply-To desde Railway
    return fixedReplyTo;
  }
  // Si no hay REPLY_TO válido, caemos al email del usuario (comportamiento anterior)
  if (userEmail && emailRx.test(String(userEmail))) {
    return { name, address: userEmail };
  }
  // Último recurso: sin Reply-To
  return undefined;
}

// POST /contact  — envía el mail
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

    const replyTo = resolveReplyTo(name, email);

    const mailOptions = {
      from: `"${process.env.MAIL_FROM_NAME || "Contacto App"}" <${process.env.GMAIL_USER}>`,
      to: process.env.CONTACT_TO || process.env.GMAIL_USER,
      subject: `Nuevo contacto: ${name}`,
      text: `Nombre: ${name}\nEmail (usuario): ${email}\n\n${message}`,
      replyTo, // ← forzado por env si REPLY_TO está definido
    };

    // Log simple para verificar qué está usando
    console.log("[CONTACT] from:", mailOptions.from, "to:", mailOptions.to, "replyTo:", mailOptions.replyTo);

    await transporter.sendMail(mailOptions);

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Error en servidor" });
  }
});

// GET /contact/debug  — ver qué valores está leyendo el server (quitar luego si querés)
router.get("/debug", (req, res) => {
  res.json({
    ok: true,
    env: {
      GMAIL_USER: !!process.env.GMAIL_USER,
      GMAIL_APP_PASS: !!process.env.GMAIL_APP_PASS,
      CONTACT_TO: process.env.CONTACT_TO || null,
      MAIL_FROM_NAME: process.env.MAIL_FROM_NAME || null,
      REPLY_TO: process.env.REPLY_TO || null,
    },
  });
});

module.exports = router;
