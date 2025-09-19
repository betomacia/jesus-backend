// routes/contact.js — Relay a Google Apps Script (sin googleapis / nodemailer)
const express = require("express");
const rateLimit = require("express-rate-limit");

const router = express.Router();

// Rate limit simple
const limiter = rateLimit({ windowMs: 60_000, max: 20 });
router.use(limiter);

// Validación básica
const emailRx = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Debug rápido para ver variables en Railway
router.get("/debug", (_req, res) => {
  res.json({
    ok: true,
    env: {
      APPS_SCRIPT_URL: !!process.env.APPS_SCRIPT_URL,
      APPS_SCRIPT_KEY: !!process.env.APPS_SCRIPT_KEY,
    },
  });
});

// POST /contact
router.post("/", async (req, res) => {
  try {
    const { name, email, message, website } = req.body || {};

    // Honeypot anti-bot
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

    const url = process.env.APPS_SCRIPT_URL;
    if (!url) {
      return res.status(500).json({ ok: false, error: "Falta APPS_SCRIPT_URL" });
    }

    // Timeout con AbortController (10s)
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 10_000);

    const payload = {
      name,
      email,        // el Apps Script puede usarlo como Reply-To o incluirlo en el cuerpo
      message,
      key: process.env.APPS_SCRIPT_KEY || undefined, // si configuraste clave compartida
    };

    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: ac.signal,
    }).catch((err) => {
      // fetch puede tirar error distinto si aborta
      throw new Error(`fetch_failed: ${err.message}`);
    });
    clearTimeout(t);

    const json = await r.json().catch(() => ({}));

    if (!r.ok || json?.ok === false) {
      return res
        .status(500)
        .json({ ok: false, error: "Apps Script error", detail: json });
    }

    return res.json({ ok: true });
  } catch (err) {
    const msg = err?.name === "AbortError" ? "timeout" : (err?.message || "server_error");
    return res.status(500).json({ ok: false, error: msg });
  }
});

module.exports = router;
