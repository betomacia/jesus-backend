// routes/contact.js
const express = require("express");
const rateLimit = require("express-rate-limit");
const nodemailer = require("nodemailer");

const router = express.Router();

// Anti-spam simple
const limiter = rateLimit({ windowMs: 60_000, max: 20 });
router.use(limiter);

// === SMTP Gmail explícito (evita ambigüedades de "service: gmail") ===
const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 465,           // 587 STARTTLS también sirve, pero 465+SSL suele ser más estable en cloud
  secure: true,        // true = SSL
  auth: {
    user: process.env.GMAIL_USER,      // ej: info@movilive.com (Workspace)
    pass: process.env.GMAIL_APP_PASS,  // App Password (NO la contraseña normal)
  },
  // Diagnóstico
  logger: true,
  debug: true,
});

// Validador de email
const emailRx = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Subject único (evita que Gmail “pegue” con hilos viejos)
function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ---------- DEBUG: probar login SMTP ----------
// GET /contact/selftest → te dice si Gmail acepta el login SMTP
router.get("/selftest", async (_req, res) => {
  try {
    await transporter.verify();   // intenta login/handshake
    res.json({ ok: true });
  } catch (err) {
    console.error("[CONTACT][SELFTEST] SMTP ERROR:", err);
    res.status(500).json({
      ok: false,
      smtp: {
        code: err.code || null,
        command: err.command || null,
        responseCode: err.responseCode || null,
        response: err.response || String(err),
      },
    });
  }
});

// ---------- POST /contact → envía el mail ----------
router.post("/", async (req, res) => {
  try {
    const { name, email, message, website } = req.body || {};

    // Honeypot (si viene con texto, ignoramos)
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

    // Si falta SMTP, no rompemos UX
    if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASS) {
      console.log("[CONTACT][NO SMTP]", { name, email, message });
      return res.json({ ok: true, note: "SMTP no configurado" });
    }

    // Reply-To fijo desde env (si existe y es válido). Evita “contaminación” de hilos.
    const fixedReplyTo = (process.env.REPLY_TO || "").trim();
    const useReplyTo = fixedReplyTo && emailRx.test(fixedReplyTo) ? fixedReplyTo : undefined;

    // Direcciones
    const fromName = process.env.MAIL_FROM_NAME || "Contacto App";
    const fromAddr = process.env.GMAIL_USER;             // SIEMPRE tu cuenta auténtica
    const toAddr   = process.env.CONTACT_TO || fromAddr; // destino
    const subject  = `Nuevo contacto: ${name} — ${stamp()}`;

    const mailOptions = {
      from: `"${fromName}" <${fromAddr}>`,  // visible
      sender: fromAddr,                      // “Sender” explícito
      to: toAddr,
      subject,
      text:
        `Nombre: ${name}\n` +
        `Email (usuario): ${email}\n\n` +
        `${message}`,

      // Forzar Reply-To si está configurado
      ...(useReplyTo ? { replyTo: useReplyTo, headers: { "Reply-To": useReplyTo } } : {}),

      // Envelope SMTP (remitente real/bounce)
      envelope: { from: fromAddr, to: toAddr },
    };

    console.log("[CONTACT] from:", mailOptions.from, "| sender:", mailOptions.sender, "| to:", mailOptions.to, "| replyTo:", useReplyTo || "(none)");

    await transporter.sendMail(mailOptions);
    res.json({ ok: true });
  } catch (err) {
    console.error("[CONTACT][SEND] SMTP ERROR:", err);
    // devolvemos pista concreta (sin datos sensibles)
    res.status(500).json({
      ok: false,
      error: "Error en servidor",
      smtp: {
        code: err.code || null,
        command: err.command || null,
        responseCode: err.responseCode || null,
        response: err.response || String(err),
      },
    });
  }
});

// ---------- DEBUG vars ----------
router.get("/debug", (_req, res) => {
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
