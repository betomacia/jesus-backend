// services/message.service.js
const { query } = require("../routes/db");

const PURGE_DAYS = 90; // calendario

async function purgeOldMessages(uid) {
  await query(
    `DELETE FROM messages
      WHERE user_id = $1
        AND created_at < (NOW() - INTERVAL '${PURGE_DAYS} days')`,
    [uid]
  );
}

/**
 * Agrega un mensaje tal cual (sin conversiones de encoding), respetando client_ts si llega.
 * @param {{uid:number, role:string, text:any, lang:string|null, client_ts:string|null}} params
 * @returns {{id:number, created_at:string}|null}
 */
async function addMessage({ uid, role = "user", text, lang = null, client_ts = null }) {
  // Purga consistente antes de escribir
  await purgeOldMessages(uid);

  // Usar el texto tal cual si ya es string; si no, convertir una sola vez
  const msgText = (typeof text === "string") ? text : String(text ?? "");

  const rows = await query(
    `INSERT INTO messages (user_id, role, text, lang, created_at)
     VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, NOW()))
     RETURNING id, created_at`,
    [uid, String(role || "user"), msgText, lang || null, client_ts || null]
  );

  return rows?.[0] || null;
}

/**
 * Obtiene el historial (máximo 'limit' items). La purga se garantiza también aquí.
 * @param {{uid:number, limit:number}} params
 * @returns {Array<{id:number, role:string, text:string, lang:string|null, created_at:string}>}
 */
async function getHistory({ uid, limit = 50 }) {
  // Purga también en lecturas por si no hubo escrituras recientes
  await purgeOldMessages(uid);

  const rows = await query(
    `SELECT id, role, text, lang, created_at
       FROM messages
      WHERE user_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2`,
    [uid, Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200)]
  );

  // Devolver texto tal cual (sin transformaciones)
  return rows.map(r => ({
    id: r.id,
    role: r.role,
    text: r.text,
    lang: r.lang,
    created_at: r.created_at
  }));
}

/**
 * Borra un mensaje por id (verifica pertenencia al usuario).
 */
async function deleteById({ uid, id }) {
  const rows = await query(
    `DELETE FROM messages
      WHERE user_id = $1 AND id = $2
      RETURNING id`,
    [uid, Number(id)]
  );
  return rows?.[0]?.id ?? null;
}

/**
 * Borra varios mensajes por ids.
 */
async function deleteMany({ uid, ids = [] }) {
  const arr = ids.map(Number).filter(n => Number.isInteger(n));
  if (!arr.length) return { deleted: 0, ids: [] };

  const rows = await query(
    `DELETE FROM messages
      WHERE user_id = $1 AND id = ANY($2::bigint[])
      RETURNING id`,
    [uid, arr]
  );

  return { deleted: rows.length, ids: rows.map(x => x.id) };
}

/**
 * Borra todo lo anterior a una ISO para el usuario.
 */
async function deleteBefore({ uid, iso }) {
  const rows = await query(
    `DELETE FROM messages
      WHERE user_id = $1
        AND created_at < $2::timestamptz
      RETURNING id`,
    [uid, iso]
  );
  return rows.length;
}

module.exports = {
  purgeOldMessages,
  addMessage,
  getHistory,
  deleteById,
  deleteMany,
  deleteBefore,
};
