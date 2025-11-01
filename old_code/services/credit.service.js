// services/credit.service.js
const { query } = require("../routes/db");

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

/**
 * Gasta créditos de forma atómica SIN pool.connect():
 * - Inserta el débito solo si el balance alcanza
 * - Devuelve { ok:false, error:'insufficient_credits', balance, need } si no alcanza
 */
async function spend({ uid, amount = 1, reason = "spend" }) {
  const amt = Math.max(1, parseInt(amount, 10) || 1);

  const rows = await query(
    `
    WITH bal AS (
      SELECT COALESCE(SUM(delta),0)::int AS balance
      FROM credits
      WHERE user_id = $1
    ),
    ins AS (
      INSERT INTO credits (user_id, delta, reason)
      SELECT $1, -$2::int, $3
      FROM bal
      WHERE balance >= $2
      RETURNING id
    )
    SELECT
      (SELECT balance FROM bal)       AS balance_before,
      (SELECT id FROM ins)            AS credit_id
    `,
    [uid, amt, reason || "spend"]
  );

  const row = rows?.[0] || {};
  const before = row.balance_before ?? 0;
  const inserted = row.credit_id != null;

  if (!inserted) {
    return { ok: false, error: "insufficient_credits", balance: before, need: amt };
  }

  const after = await getBalance({ uid });
  return { ok: true, spent: amt, balance: after };
}

module.exports = { addCredit, getBalance, spend };
