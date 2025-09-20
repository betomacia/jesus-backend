// services/credit.service.js
const { query, pool } = require("../routes/db");

async function addCredit({ uid, delta = 0, reason = null }) {
  await query(
    `INSERT INTO credits (user_id, delta, reason) VALUES ($1, $2, $3)`,
    [uid, Number(delta) || 0, reason || null]
  );
  const b = await query(
    `SELECT COALESCE(SUM(delta),0)::int AS balance FROM credits WHERE user_id=$1`,
    [uid]
  );
  return b?.[0]?.balance ?? 0;
}

async function getBalance({ uid }) {
  const b = await query(
    `SELECT COALESCE(SUM(delta),0)::int AS balance FROM credits WHERE user_id=$1`,
    [uid]
  );
  return b?.[0]?.balance ?? 0;
}

async function spend({ uid, amount = 1, reason = "spend" }) {
  const client = await pool.connect();
  try {
    const amt = Math.max(1, parseInt(amount, 10) || 1);
    await client.query("BEGIN");

    const b1 = await client.query(
      `SELECT COALESCE(SUM(delta),0)::int AS balance FROM credits WHERE user_id=$1`,
      [uid]
    );
    const balance = b1.rows?.[0]?.balance ?? 0;

    if (balance < amt) {
      await client.query("ROLLBACK");
      return { ok: false, error: "insufficient_credits", balance, need: amt };
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
    return { ok: true, spent: amt, balance: b2.rows?.[0]?.balance ?? 0 };
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { addCredit, getBalance, spend };
