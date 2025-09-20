// services/message.service.js
const { query } = require("../routes/db");

const PURGE_DAYS = 90; // calendario

async function purgeOldMessages(uid) {
  await query(
    `DELETE FROM messages WHERE user_id=$1 AND created_at < NOW() - INTERVAL '${PURGE_DAYS} days'`,
    [uid]
  );
}

async function addMessage({ uid, role = "user", text, lang = null, client_ts = null }) {
  await purgeOldMessages(uid);
  const r = await query(
    `
    INSERT INTO messages (user_id, role, text, lang, created_at)
    VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, NOW()))
    RETURNING id, created_at
    `,
    [uid, String(role || "user"), String(text || ""), lang || null, client_ts || null]
  );
  return r?.[0] || null;
}

async function getHistory({ uid, limit = 50 }) {
  // purgar también en lecturas, por si no hubo escrituras recientes
  await purgeOldMessages(uid);
  const items = await query(
    `
    SELECT id, role, text, lang, created_at
    FROM messages
    WHERE user_id = $1
    ORDER BY created_at DESC, id DESC
    LIMIT $2
    `,
    [uid, Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200)]
  );
  return items;
}

async function deleteById({ uid, id }) {
  const r = await query(
    `DELETE FROM messages WHERE user_id=$1 AND id=$2 RETURNING id`,
    [uid, Number(id)]
  );
  return r?.[0]?.id ?? null;
}

async function deleteMany({ uid, ids = [] }) {
  const arr = ids.map(Number).filter(n => Number.isInteger(n));
  if (!arr.length) return { deleted: 0, ids: [] };
  const r = await query(
    `DELETE FROM messages WHERE user_id=$1 AND id = ANY($2) RETURNING id`,
    [uid, arr]
  );
  return { deleted: r.length, ids: r.map(x => x.id) };
}

async function deleteBefore({ uid, iso }) {
  const r = await query(
    `DELETE FROM messages WHERE user_id=$1 AND created_at < $2::timestamptz RETURNING id`,
    [uid, iso]
  );
  return r.length;
}

module.exports = {
  purgeOldMessages,
  addMessage,
  getHistory,
  deleteById,
  deleteMany,
  deleteBefore,
};
