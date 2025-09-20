// routes/users.js
const express = require("express");
const { query } = require("./db"); // usamos el helper query del pool PG

const router = express.Router();

// ---------- Helpers ----------
async function findUserByEmail(email) {
  if (!email) return null;
  const r = await query(`SELECT id, email, lang, platform FROM users WHERE email=$1`, [email]);
  return r[0] || null;
}

async function upsertUser(email, lang = null, platform = null) {
  if (!email) throw new Error("email_required");
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
    [email, lang, platform]
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

// ---------- Health ----------
router.get("/health", async (_req, res) => {
  try {
    const r = await query(`SELECT NOW() AS now`);
    res.json({ ok: true, db: true, now: r?.[0]?.now ?? null });
  } catch (e) {
    res.status(500).json({ ok: false, error: "db_error", detail: e.message || String(e) });
  }
});

// ---------- Register / Upsert ----------
router.post("/register", async (req, res) => {
  try {
    const { email, lang = null, platform = null } = req.body || {};
    const user = await upsertUser(String(email || "").trim(), lang, platform);
    res.json({ ok: true, user });
  } catch (e) {
    res.status(500).json({ ok: false, error: "users_register_failed", detail: e.message || String(e) });
  }
});

// ---------- Créditos: add ----------
router.post("/credit/add", async (req, res) => {
  try {
    const { user_id = null, email = null, delta = 0, reason = null, lang = null, platform = null } = req.body || {};
    const uid = await ensureUserId({ user_id, email, lang, platform });

    await query(
      `INSERT INTO credits (user_id, delta, reason) VALUES ($1, $2, $3)`,
      [uid, Number(delta) || 0, reason || null]
    );

    const b = await query(`SELECT COALESCE(SUM(delta),0)::int AS balance FROM credits WHERE user_id=$1`, [uid]);
    res.json({ ok: true, user_id: uid, balance: b?.[0]?.balance ?? 0 });
  } catch (e) {
    res.status(500).json({ ok: false, error: "credit_add_failed", detail: e.message || String(e) });
  }
});

// ---------- Créditos: balance ----------
router.get("/credit/balance", async (req, res) => {
  try {
    const { user_id = null, email = null } = req.query || {};
    let uid = user_id ? Number(user_id) : null;

    if (!uid && email) {
      const u = await findUserByEmail(String(email));
      if (!u) return res.json({ ok: true, user_id: null, balance: 0 });
      uid = u.id;
    }
    if (!uid) return res.status(400).json({ ok: false, error: "user_id_or_email_required" });

    const b = await query(`SELECT COALESCE(SUM(delta),0)::int AS balance FROM credits WHERE user_id=$1`, [uid]);
    res.json({ ok: true, user_id: uid, balance: b?.[0]?.balance ?? 0 });
  } catch (e) {
    res.status(500).json({ ok: false, error: "credit_balance_failed", detail: e.message || String(e) });
  }
});

// ---------- Mensajes: add ----------
router.post("/message/add", async (req, res) => {
  try {
    const { user_id = null, email = null, role, content, text, lang = null, client_ts = null } = req.body || {};
    const uid = await ensureUserId({ user_id, email });

    const msgText = (text ?? content ?? "").toString();
    if (!msgText.trim()) return res.status(400).json({ ok: false, error: "message_text_required" });

    const r = await query(
      `
      INSERT INTO messages (user_id, role, text, lang, created_at)
      VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, NOW()))
      RETURNING id, created_at
      `,
      [uid, (role || "user").toString(), msgText, lang || null, client_ts || null]
    );

    res.json({ ok: true, id: r?.[0]?.id ?? null, created_at: r?.[0]?.created_at ?? null });
  } catch (e) {
    res.status(500).json({ ok: false, error: "message_add_failed", detail: e.message || String(e) });
  }
});

// ---------- Mensajes: history ----------
router.get("/message/history", async (req, res) => {
  try {
    const { user_id = null, email = null } = req.query || {};
    let uid = user_id ? Number(user_id) : null;

    if (!uid && email) {
      const u = await findUserByEmail(String(email));
      if (!u) return res.json({ ok: true, user_id: null, items: [] });
      uid = u.id;
    }
    if (!uid) return res.status(400).json({ ok: false, error: "user_id_or_email_required" });

    const limit = Math.min(Math.max(parseInt(req.query.limit || "50", 10) || 50, 1), 200);

    const items = await query(
      `
      SELECT id, role, text, lang, created_at
      FROM messages
      WHERE user_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2
      `,
      [uid, limit]
    );

    res.json({ ok: true, user_id: uid, items });
  } catch (e) {
    res.status(500).json({ ok: false, error: "message_history_failed", detail: e.message || String(e) });
  }
});
// --- BORRAR 1 mensaje por id (validando email) ---
router.post("/message/delete", async (req, res) => {
  try {
    const { email, id } = req.body || {};
    const msgId = Number(id);
    if (!email || !msgId) {
      return res.status(400).json({ ok: false, error: "missing_params" });
    }

    // Buscar user_id por email
    const u = await query(`SELECT id FROM users WHERE email=$1`, [email]);
    if (!u?.[0]) return res.status(404).json({ ok: false, error: "user_not_found" });
    const userId = u[0].id;

    // Borrar solo si el mensaje es del user
    const r = await query(
      `DELETE FROM messages WHERE id=$1 AND user_id=$2 RETURNING id`,
      [msgId, userId]
    );

    if (r.length === 0) {
      return res.status(404).json({ ok: false, error: "not_found_or_not_owned" });
    }

    res.json({ ok: true, deleted_id: msgId });
  } catch (e) {
    res.status(500).json({ ok: false, error: "message_delete_failed", detail: e.message || String(e) });
  }
});


module.exports = router;
