// services/user.service.js
const { query } = require("../routes/db");

function normEmail(email) {
  return String(email || "").trim().toLowerCase();
}

async function findUserByEmail(email) {
  const r = await query(
    `SELECT id, email, lang, platform FROM users WHERE email=$1`,
    [normEmail(email)]
  );
  return r[0] || null;
}

async function upsertUser(email, lang = null, platform = null) {
  const e = normEmail(email);
  if (!e) throw new Error("email_required");
  const r = await query(
    `
    INSERT INTO users (email, lang, platform)
    VALUES ($1, $2, $3)
    ON CONFLICT (email)
    DO UPDATE SET lang = COALESCE(EXCLUDED.lang, users.lang),
                  platform = COALESCE(EXCLUDED.platform, users.platform),
                  updated_at = NOW()
    RETURNING id, email, lang, platform, created_at, updated_at
    `,
    [e, lang, platform]
  );
  return r[0];
}

async function ensureUserId({ user_id, email, lang = null, platform = null }) {
  if (user_id) return Number(user_id);
  if (email) {
    const u = await upsertUser(email, lang, platform);
    return u.id;
  }
  throw new Error("user_id_or_email_required");
}

module.exports = { findUserByEmail, upsertUser, ensureUserId };
