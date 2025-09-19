// routes/contact.js — Envío por Gmail API (HTTPS) + rate limit
const express = require("express");
const rateLimit = require("express-rate-limit");
const { google } = require("googleapis");

const router = express.Router();

// Anti-spam básico
const limiter = rateLimit({ windowMs: 60_000, max: 20 });
router.use(limiter);

// Vars
const hasGmailAPI =
  !!process.env.GOOGLE_CLIENT_ID &&
  !!process.env.GOOGLE_CLIENT_SECRET &&
  !!process.env.GOOGLE_REFRESH_TOKEN;

const emailRx = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function base64Url(str) {
  return Buffer.from(str)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function buildMime({ from, to, replyTo, subject, text }) {
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    replyTo ? `Reply-To: ${replyTo}` : null,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 7bit",
    "",
    text || "",
  ].filter(Boolean);
  return base64Url(lines.join("\r\n"));
}

function getOAuthClient() {
  const o = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  o.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return o;
}

// ---- Debug de entorno (no expone secretos)
router.get("/debug", (_req, res) => {
  res.json({
    ok: true,
    env: {
      GMAIL_API: hasGmailAPI,
      GMAIL_SENDER: process.env.GMAIL_SENDER || null,
      MAIL_FROM_NAME: process.env.MAIL_FROM_NAME || null,
      CONTACT_TO: process.env.CONTACT_TO || null,
      REPLY_TO: process.env.REPLY_TO || null,
    },
  });
});

// Autotest (intenta enviar un correo simple)
router.get("/selftest", async (_req, res) => {
  try {
    if (!hasGmailAPI) return res.json({ ok: false, error: "no_gmail_api" });
    const to = process.env.CONTACT_TO || process.env.GMAIL_SENDER;
    if (!to) return res.json({ ok: false, error: "CONTACT_TO missing" });

    const fromAddr = process.env.GMAIL_SENDER || to;
    const fromHdr = `${process.env.MAIL_FROM_NAME || "Contacto App"} <${fromAddr}>`;
    const subject = `SELFTEST contacto ${new Date().toISOString()}`;
    const text = "Autotest OK (Gmail API).";

    const auth = getOAuthClient();
    const gmail = google.gmail({ version: "v1", auth });
    const raw = buildMime({
      from: fromHdr,
      to,
      replyTo: process.env.REPLY_TO || null,
      subject,
      text,
    });

    const r = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw },
    });

    return res.json({ ok: true, id: r?.data?.id || null });
  } catch (e) {
    console.error("SELFTEST_FAIL:", e?.response?.data || e);
    return res.status(500).json({ ok: false, error: "selftest_failed" });
  }
});

// POST /contact (usa Gmail API por HTTPS)
router.post("/", async (req, res) => {
  try {
    const { name, email, message, website } = req.body || {};

    // Honeypot (bots)
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

    if (!hasGmailAPI) {
      console.log("[CONTACT][NO_GMAIL_API]", { name, email, message });
      return res.json({ ok: true, note: "gmail_api_not_configured" });
    }

    const to = process.env.CONTACT_TO || process.env.GMAIL_SENDER;
    if (!to) return res.status(500).json({ ok: false, error: "CONTACT_TO no configurado" });

    const fromAddr = process.env.GMAIL_SENDER || to;
    const fromHdr = `${process.env.MAIL_FROM_NAME || "Contacto App"} <${fromAddr}>`;
    const replyTo = (process.env.REPLY_TO && process.env.REPLY_TO.trim()) || String(email).trim();

    const now = new Date().toISOString();
    const subject = `Contacto ${now} — ${String(name).trim() || "Anónimo"}`;
    const text =
      `Nombre: ${name}\n` +
      `Email (usuario): ${email}\n` +
      `Reply-To (header): ${replyTo}\n\n` +
      `${message}`;

    // Enviar
    const auth = getOAuthClient();
    const gmail = google.gmail({ version: "v1", auth });
    const raw = buildMime({ from: fromHdr, to, replyTo, subject, text });

    const r = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw },
    });

    return res.json({ ok: true, id: r?.data?.id || null });
  } catch (err) {
    console.error("CONTACT_FAIL:", err?.response?.data || err);
    res.status(500).json({ ok: false, error: "Error en servidor" });
  }
});

module.exports = router;
