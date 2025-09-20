// services/message.service.js
const { query } = require("../routes/db");

async function purgeOldMessages(userId) {
  await query(
    `DELETE FROM messages WHERE user_id=$1 AND created_at < NOW() - INTERVAL '90 days'`,
    [userId]
  );
}

async function addMessage({ uid, role, text, lang = null, client_ts = null }) {
  await purgeOldMessages(uid);
  const r = await query(
    `
    INSERT INTO messages (user_id, role, text, lang, created_at)
    VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, NOW()))
    RETURNING id, created_at
    `,
    [uid, (role || "user").toString(), text, lang || null, client_ts || null]
  );
  return r[0];
}

async function getHistory({ uid, limit = 50 }) {
  await purgeOldMessages(uid);
  const items = await query(
    `
    SELECT id, role, text, lang, created_at
    FROM messages
    WHERE user_id=$1
    ORDER BY created_at DESC, id DESC
    LIMIT $2
    `,
    [uid, limit]
  );
  return items;
}

async function deleteById({ uid, id }) {
  const r = await query(
    `DELETE FROM messages WHERE user_id=$1 AND id=$2 RETURNING id`,
    [uid, Number(id)]
  );
  return r[0]?.id ?? null;
}

async function deleteMany({ uid, ids = [] }) {
  const arr = ids.map(Number).filter(Number.isInteger);
  if (!arr.length) return { deleted: 0, ids: [] };
  const r = await query(
    `DELETE FROM messages WHERE user_id=$1 AND id = ANY($2::bigint[]) RETURNING id`,
    [uid, arr]
  );
  return { deleted: r.length, ids: r.map(x => x.id) };
}

async function deleteBefore({ uid, iso }) {
  const r = await query(
    `DELETE FROM messages WHERE user_id=$1 AND created_at < $2 RETURNING id`,
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
