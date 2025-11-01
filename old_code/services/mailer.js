const nodemailer = require("nodemailer");

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = +(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const MAIL_TO   = process.env.MAIL_TO || process.env.SMTP_USER; // destino por defecto

let transporter = null;

function getTx() {
  if (transporter) return transporter;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    console.warn("[mailer] Faltan variables SMTP_* para enviar correos");
    return null;
  }
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  return transporter;
}

async function sendContactMail({ name, email, message }) {
  const tx = getTx();
  if (!tx) throw new Error("mailer_not_configured");
  const subj = `[Contacto] ${name || "Usuario"} <${email || "sin-email"}>`;
  const html = `
    <h2>Nuevo mensaje de contacto</h2>
    <p><b>Nombre:</b> ${name || "-"}</p>
    <p><b>Email:</b> ${email || "-"}</p>
    <p><b>Mensaje:</b></p>
    <pre style="white-space:pre-wrap">${(message || "").replace(/[<>&]/g, s => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[s]))}</pre>
  `;
  await tx.sendMail({
    from: `"Contacto" <${SMTP_USER}>`,
    to: MAIL_TO,
    subject: subj,
    html,
  });
}

module.exports = { sendContactMail };
