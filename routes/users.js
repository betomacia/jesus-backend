// routes/users.js
const express = require("express");
const { query, pool } = require("./db"); // helper PG + pool para transacciones

const router = express.Router();

/* =========================
   Utils básicos
========================= */
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

// Purga: borra mensajes anteriores a 90 días (calendario)
async function purgeOldMessages(userId) {
  await query(
    `DELETE FROM messages WHERE user_id=$1 AND created_at < NOW() - INTERVAL '90 days'`,
    [userId]
  );
}

/* =========================
   Health & registro usuario
========================= */
router.get("/health", async (_req, res) => {
  try {
    const r = await query(`SELECT NOW() AS now`);
    res.json({ ok: true, db: true, now: r?.[0]?.now ?? null });
  } catch (e) {
    res.status(500).json({ ok: false, error: "db_error", detail: e.message || String(e) });
  }
});

router.post("/register", async (req, res) => {
  try {
    const { email, lang = null, platform = null } = req.body || {};
    const user = await upsertUser(String(email || "").trim(), lang, platform);
    res.json({ ok: true, user });
  } catch (e) {
    res.status(500).json({ ok: false, error: "users_register_failed", detail: e.message || String(e) });
  }
});

/* =========================
   Créditos
========================= */
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

router.post("/credit/spend", async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      user_id = null,
      email = null,
      amount = 1,
      reason = "spend",
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

/* =========================
   Mensajes (con purga 90 días)
========================= */
router.post("/message/add", async (req, res) => {
  try {
    const { user_id = null, email = null, role, content, text, lang = null, client_ts = null } = req.body || {};
    const uid = await ensureUserId({ user_id, email });

    // Purga 90 días para este usuario (calendario, no "días de uso")
    await purgeOldMessages(uid);

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

    // Purga 90 días (por si no hubo escrituras recientes)
    await purgeOldMessages(uid);

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

/* =========================
   Dispositivos & Push (FCM)
========================= */

// Creamos/ajustamos tabla devices on-demand por si no existe
let devicesEnsured = false;
async function ensureDevicesTable() {
  if (devicesEnsured) return;
  await query(`
    CREATE TABLE IF NOT EXISTS devices (
      id                BIGSERIAL PRIMARY KEY,
      user_id           BIGINT REFERENCES users(id) ON DELETE CASCADE,
      platform          TEXT,                    -- 'ios' | 'android' | 'web'
      device_id         TEXT,                    -- opcional: identificador local del dispositivo
      fcm_token         TEXT UNIQUE,             -- token FCM
      lang              TEXT,                    -- preferencia de idioma del device
      tz_offset_minutes INTEGER,                 -- offset de zona horaria (minutos)
      app_version       TEXT,
      os_version        TEXT,
      model             TEXT,
      last_seen_at      TIMESTAMPTZ,
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      updated_at        TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  // índices de apoyo
  await query(`CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_devices_platform ON devices(platform);`);
  devicesEnsured = true;
}

function normPlatform(p) {
  const v = (p || "").toString().toLowerCase();
  if (["ios", "android", "web"].includes(v)) return v;
  return v || null;
}

function pickLangPref({ override, deviceLang, userLang }) {
  const norm = (v) => (v || "").toString().trim().slice(0, 2).toLowerCase();
  return norm(override) || norm(deviceLang) || norm(userLang) || "es";
}

function resolveLocalized(mapOrStr, lang) {
  if (!mapOrStr) return null;
  if (typeof mapOrStr === "string") return mapOrStr;
  const m = mapOrStr || {};
  return m[lang] || m[lang?.slice(0, 2)] || m["es"] || m["en"] || Object.values(m)[0] || "";
}

async function sendFcmLegacy(toToken, payload) {
  const key = process.env.FCM_SERVER_KEY;
  if (!key) throw new Error("missing_FCM_SERVER_KEY");
  const r = await fetch("https://fcm.googleapis.com/fcm/send", {
    method: "POST",
    headers: {
      "Authorization": `key=${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ to: toToken, ...payload }),
  });
  const json = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, json };
}

// Registrar/actualizar un dispositivo y su token
router.post("/push/register", async (req, res) => {
  try {
    await ensureDevicesTable();

    const {
      user_id = null,
      email = null,
      platform = null,       // ios|android|web
      fcm_token = null,
      device_id = null,
      lang = null,           // idioma preferido de ese device (ej: 'es-AR')
      tz_offset_minutes = null,
      app_version = null,
      os_version = null,
      model = null,
    } = req.body || {};

    if (!fcm_token) return res.status(400).json({ ok: false, error: "fcm_token_required" });

    const uid = await ensureUserId({ user_id, email });

    const p = normPlatform(platform);

    // UPSERT por fcm_token (único)
    const r = await query(
      `
      INSERT INTO devices (user_id, platform, device_id, fcm_token, lang, tz_offset_minutes, app_version, os_version, model, last_seen_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
      ON CONFLICT (fcm_token)
      DO UPDATE SET user_id = EXCLUDED.user_id,
                    platform = EXCLUDED.platform,
                    device_id = EXCLUDED.device_id,
                    lang = COALESCE(EXCLUDED.lang, devices.lang),
                    tz_offset_minutes = COALESCE(EXCLUDED.tz_offset_minutes, devices.tz_offset_minutes),
                    app_version = COALESCE(EXCLUDED.app_version, devices.app_version),
                    os_version = COALESCE(EXCLUDED.os_version, devices.os_version),
                    model = COALESCE(EXCLUDED.model, devices.model),
                    last_seen_at = NOW(),
                    updated_at = NOW()
      RETURNING id, user_id, platform, lang, tz_offset_minutes, last_seen_at
      `,
      [uid, p, device_id || null, String(fcm_token), lang || null, tz_offset_minutes ?? null, app_version || null, os_version || null, model || null]
    );

    res.json({ ok: true, device: r?.[0] || null });
  } catch (e) {
    res.status(500).json({ ok: false, error: "push_register_failed", detail: e.message || String(e) });
  }
});

// Lista de dispositivos de un usuario (debug)
router.get("/push/devices", async (req, res) => {
  try {
    await ensureDevicesTable();
    const { user_id = null, email = null } = req.query || {};
    const uid = await ensureUserId({ user_id, email });
    const devs = await query(
      `
      SELECT id, platform, lang, tz_offset_minutes, app_version, os_version, model, last_seen_at
      FROM devices
      WHERE user_id=$1
      ORDER BY last_seen_at DESC NULLS LAST, id DESC
      `,
      [uid]
    );
    res.json({ ok: true, user_id: uid, devices: devs });
  } catch (e) {
    res.status(500).json({ ok: false, error: "push_devices_failed", detail: e.message || String(e) });
  }
});

// Envío simple i18n por usuario (prioridad idioma: lang override > device.lang > user.lang > 'es')
router.post("/push/send-simple", async (req, res) => {
  try {
    await ensureDevicesTable();
    const {
      user_id = null,
      email = null,
      title = null,
      body = null,
      title_i18n = null,
      body_i18n = null,
      data = null,
      platform = null,  // opcional: ios|android|web
      lang = null,      // override opcional
    } = req.body || {};

    const uid = await ensureUserId({ user_id, email });
    const userRow = (await query(`SELECT id, lang FROM users WHERE id=$1`, [uid]))[0] || {};
    const devs = await query(
      `
      SELECT id, platform, fcm_token, lang, last_seen_at
      FROM devices
      WHERE user_id=$1
      ${platform ? `AND platform = $2` : ``}
      ORDER BY last_seen_at DESC NULLS LAST, id DESC
      `,
      platform ? [uid, normPlatform(platform)] : [uid]
    );

    if (!devs.length) {
      return res.status(404).json({ ok: false, error: "no_devices_for_user" });
    }

    const results = [];
    let sent = 0, failed = 0;

    for (const d of devs) {
      const langChosen = pickLangPref({
        override: lang,
        deviceLang: d.lang,
        userLang: userRow.lang,
      });

      const t = resolveLocalized(title_i18n || title, langChosen) || "Notificación";
      const b = resolveLocalized(body_i18n || body, langChosen) || "Tienes un aviso nuevo.";

      const payload = {
        notification: { title: t, body: b },
        data: { lang: langChosen, ...(data || {}) },
      };

      try {
        const r = await sendFcmLegacy(d.fcm_token, payload);
        results.push({ device_id: d.id, platform: d.platform, lang: langChosen, status: r.status, ok: r.ok });
        if (r.ok) sent++; else failed++;
      } catch (e) {
        results.push({ device_id: d.id, platform: d.platform, lang: langChosen, ok: false, error: String(e) });
        failed++;
      }
    }

    res.json({ ok: true, user_id: uid, total: devs.length, sent, failed, results });
  } catch (e) {
    res.status(500).json({ ok: false, error: "push_send_failed", detail: e.message || String(e) });
  }
});

module.exports = router;
