// services/credit.service.js
const { query, pool } = require("../routes/db");

/** Suma créditos y devuelve el balance actualizado */
async function addCredit({ uid, delta = 0, reason = null }) {
  const d = Number.isFinite(+delta) ? parseInt(delta, 10) : 0;
  await query(
    `INSERT INTO credits (user_id, delta, reason) VALUES ($1, $2, $3)`,
    [uid, d, reason || null]
  );
  const rows = await query(
    `SELECT COALESCE(SUM(delta),0)::int AS balance FROM credits WHERE user_id=$1`,
    [uid]
  );
  return rows?.[0]?.balance ?? 0;
}

/** Lee el balance actual */
async function getBalance({ uid }) {
  const rows = await query(
    `SELECT COALESCE(SUM(delta),0)::int AS balance FROM credits WHERE user_id=$1`,
    [uid]
  );
  return rows?.[0]?.balance ?? 0;
}

/** Gasta créditos de forma transaccional */
async function spend({ uid, amount = 1, reason = "spend" }) {
  const amt = Math.max(1, parseInt(amount, 10) || 1);
  const client = await pool.connect();
  try {
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
