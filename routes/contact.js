const express = require("express");
const Contact = require("../models/Contact");
const { sendContactMail } = require("../services/mailer");

const router = express.Router();

// POST /contact  (usado por el HelpModal del front)
router.post("/", async (req, res) => {
  try {
    const { name = "", email = "", message = "" } = req.body || {};
    if (!String(message).trim()) return res.status(400).json({ error: "missing_message" });

    // Guardar en DB
    await Contact.create({ name, email, message });

    // Enviar correo (si hay SMTP configurado)
    try { await sendContactMail({ name, email, message }); }
    catch (e) { console.warn("[contact] mail failed:", e?.message); }

    res.json({ ok: true });
  } catch (e) {
    console.error("[contact] error:", e);
    res.status(500).json({ error: "contact_error" });
  }
});

module.exports = router;
