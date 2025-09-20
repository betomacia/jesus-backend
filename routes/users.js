// routes/users.js
const express = require("express");
const { query, pool } = require("./db"); // usamos también pool para la transacción de "spend"

const router = express.Router();

// ---------- Helpers ----------
async function findUserByEmail(email) {
  if (!email) return null;
  const r = await query(
    `SELECT id, email, lang, platform FROM users WHERE email=$1`,
    [String(email).trim().toLowerCase()]
  );
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
    [String(email).trim().toLowerCase(), lang, platform]
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

    const b = await query(
      `SELECT COALESCE(SUM(delta),0)::int AS balance FROM credits WHERE user_id=$1`,
      [uid]
    );
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

    const b = await query(
      `SELECT COALESCE(SUM(delta),0)::int AS balance FROM credits WHERE user_id=$1`,
      [uid]
    );
    res.json({ ok: true, user_id: uid, balance: b?.[0]?.balance ?? 0 });
  } catch (e) {
    res.status(500).json({ ok: false, error: "credit_balance_failed", detail: e.message || String(e) });
  }
});

// ---------- Créditos: spend (gastar) ----------
router.post("/credit/spend", async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      user_id = null,
      email = null,
      amount = 1,           // cuánto gastar (entero positivo)
      reason = "spend",     // p.ej.: 'ask', 'audio_min', etc.
      lang = null,
      platform = null,
    } = req.body || {};

    const uid = await ensureUserId({ user_id, email, lang, platform });
    const amt = Math.max(1, parseInt(amount, 10) || 1);

    await client.query("BEGIN");

    const b1 = await client.query(
      `SELECT COALESCE(SUM(delta),0)::int AS balance FROM credits WHERE user_id=$1`,
      [uid]
    );
    const balance = b1.rows?.[0]?.balance ?? 0;

    if (balance < amt) {
      await client.query("ROLLBACK");
      return res.json({ ok: false, error: "insufficient_credits", balance, need: amt });
    }

    await client.query(
      `INSERT INTO credits (user_id, delta, reason) VALUES ($1, $2, $3)`,
      [uid, -amt, reason || "spend"]
    );

    const b2 = await client.query(
      `SELECT COALESCE(SUM(delta),0)::int AS balance FROM credits WHERE user_id=$1`,
      [uid]
    );
    await client.query("COMMIT");

    res.json({
      ok: true,
      user_id: uid,
      spent: amt,
      reason: reason || "spend",
      balance: b2.rows?.[0]?.balance ?? 0,
    });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    res.status(500).json({ ok: false, error: "credit_spend_failed", detail: e.message || String(e) });
  } finally {
    client.release();
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

// ---------- Mensajes: delete (id | ids | before) ----------
router.post("/message/delete", async (req, res) => {
  try {
    const { email = null, user_id = null, id = null, ids = null, before = null } = req.body || {};

    // Resolver user_id SIN crear usuarios nuevos
    let uid = user_id ? Number(user_id) : null;
    if (!uid && email) {
      const u = await findUserByEmail(email);
      if (!u) return res.status(404).json({ ok: false, error: "user_not_found" });
      uid = u.id;
    }
    if (!uid) return res.status(400).json({ ok: false, error: "user_id_or_email_required" });

    // A) un solo id
    if (id) {
      const del = await query(
        `DELETE FROM messages WHERE user_id=$1 AND id=$2 RETURNING id`,
        [uid, Number(id)]
      );
      return res.json({ ok: true, deleted_id: del?.[0]?.id ?? null });
    }

    // B) varios ids
    if (Array.isArray(ids) && ids.length > 0) {
      const arr = ids.map(Number).filter((n) => Number.isInteger(n));
      if (!arr.length) return res.status(400).json({ ok: false, error: "bad_ids" });
      const del = await query(
        `DELETE FROM messages WHERE user_id=$1 AND id = ANY($2::bigint[]) RETURNING id`,
        [uid, arr]
      );
      return res.json({
        ok: true,
        deleted: del.length,
        deleted_ids: del.map((r) => r.id),
      });
    }

    // C) antes de una fecha/hora
    if (before) {
      const ts = new Date(before);
      if (isNaN(ts)) return res.status(400).json({ ok: false, error: "bad_before" });
      const del = await query(
        `DELETE FROM messages WHERE user_id=$1 AND created_at < $2 RETURNING id`,
        [uid, ts.toISOString()]
      );
      return res.json({ ok: true, deleted: del.length });
    }

    return res.status(400).json({ ok: false, error: "missing_params" });
  } catch (e) {
    res.status(500).json({ ok: false, error: "message_delete_failed", detail: e.message || String(e) });
  }
});

module.exports = router;
