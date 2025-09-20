// routes/users.js
const express = require("express");
const { query } = require("./db");

const { findUserByEmail, upsertUser, ensureUserId } = require("../services/user.service");
const { addCredit, getBalance, spend } = require("../services/credit.service");
const {
  addMessage, getHistory, deleteById, deleteMany, deleteBefore,
} = require("../services/message.service");
const {
  ensureDevicesTable, registerDevice, listDevicesByUser, sendSimpleToUser,
} = require("../services/push.service");

const router = express.Router();

/* ============== Health & Register ============== */
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

/* ============== Créditos ============== */
router.post("/credit/add", async (req, res) => {
  try {
    const { user_id = null, email = null, delta = 0, reason = null, lang = null, platform = null } = req.body || {};
    const uid = await ensureUserId({ user_id, email, lang, platform });
    const balance = await addCredit({ uid, delta, reason });
    res.json({ ok: true, user_id: uid, balance });
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

    const balance = await getBalance({ uid });
    res.json({ ok: true, user_id: uid, balance });
  } catch (e) {
    res.status(500).json({ ok: false, error: "credit_balance_failed", detail: e.message || String(e) });
  }
});

router.post("/credit/spend", async (req, res) => {
  try {
    const { user_id = null, email = null, amount = 1, reason = "spend", lang = null, platform = null } = req.body || {};
    const uid = await ensureUserId({ user_id, email, lang, platform });
    const r = await spend({ uid, amount, reason });
    if (r.ok === false) return res.json(r);
    res.json({ ok: true, user_id: uid, spent: r.spent, reason, balance: r.balance });
  } catch (e) {
    res.status(500).json({ ok: false, error: "credit_spend_failed", detail: e.message || String(e) });
  }
});

/* ============== Mensajes (90 días calendario) ============== */
router.post("/message/add", async (req, res) => {
  try {
    const { user_id = null, email = null, role, content, text, lang = null, client_ts = null } = req.body || {};
    const uid = await ensureUserId({ user_id, email });

    const msgText = (text ?? content ?? "").toString();
    if (!msgText.trim()) return res.status(400).json({ ok: false, error: "message_text_required" });

    const r = await addMessage({ uid, role, text: msgText, lang, client_ts });
    res.json({ ok: true, id: r?.id ?? null, created_at: r?.created_at ?? null });
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

    const limit = Math.min(Math.max(parseInt(req.query.limit || "50", 10) || 50, 1), 200);
    const items = await getHistory({ uid, limit });
    res.json({ ok: true, user_id: uid, items });
  } catch (e) {
    res.status(500).json({ ok: false, error: "message_history_failed", detail: e.message || String(e) });
  }
});

router.post("/message/delete", async (req, res) => {
  try {
    const { email = null, user_id = null, id = null, ids = null, before = null } = req.body || {};

    let uid = user_id ? Number(user_id) : null;
    if (!uid && email) {
      const u = await findUserByEmail(email);
      if (!u) return res.status(404).json({ ok: false, error: "user_not_found" });
      uid = u.id;
    }
    if (!uid) return res.status(400).json({ ok: false, error: "user_id_or_email_required" });

    if (id) {
      const deleted_id = await deleteById({ uid, id });
      return res.json({ ok: true, deleted_id });
    }

    if (Array.isArray(ids) && ids.length > 0) {
      const { deleted, ids: deleted_ids } = await deleteMany({ uid, ids });
      return res.json({ ok: true, deleted, deleted_ids });
    }

    if (before) {
      const ts = new Date(before);
      if (isNaN(ts)) return res.status(400).json({ ok: false, error: "bad_before" });
      const deleted = await deleteBefore({ uid, iso: ts.toISOString() });
      return res.json({ ok: true, deleted });
    }

    return res.status(400).json({ ok: false, error: "missing_params" });
  } catch (e) {
    res.status(500).json({ ok: false, error: "message_delete_failed", detail: e.message || String(e) });
  }
});

/* ============== Dispositivos & Push ============== */
router.post("/push/register", async (req, res) => {
  try {
    await ensureDevicesTable();
    const {
      user_id = null, email = null, platform = null, fcm_token = null, device_id = null,
      lang = null, tz_offset_minutes = null, app_version = null, os_version = null, model = null,
    } = req.body || {};

    if (!fcm_token) return res.status(400).json({ ok: false, error: "fcm_token_required" });

    const uid = await ensureUserId({ user_id, email });
    const device = await registerDevice({
      uid, platform, fcm_token, device_id, lang, tz_offset_minutes, app_version, os_version, model
    });
    res.json({ ok: true, device });
  } catch (e) {
    res.status(500).json({ ok: false, error: "push_register_failed", detail: e.message || String(e) });
  }
});

router.get("/push/devices", async (req, res) => {
  try {
    await ensureDevicesTable();
    const { user_id = null, email = null, platform = null } = req.query || {};
    const uid = await ensureUserId({ user_id, email });
    const devs = await listDevicesByUser({ uid, platform });
    res.json({ ok: true, user_id: uid, devices: devs });
  } catch (e) {
    res.status(500).json({ ok: false, error: "push_devices_failed", detail: e.message || String(e) });
  }
});

router.post("/push/send-simple", async (req, res) => {
  try {
    await ensureDevicesTable();
    const {
      user_id = null, email = null,
      title = null, body = null,
      title_i18n = null, body_i18n = null,
      data = null, platform = null, lang = null,
    } = req.body || {};

    const uid = await ensureUserId({ user_id, email });
    const user = (await query(`SELECT id, lang FROM users WHERE id=$1`, [uid]))[0] || {};
    const devices = await listDevicesByUser({ uid, platform });

    if (!devices.length) {
      return res.status(404).json({ ok: false, error: "no_devices_for_user" });
    }

    const report = await sendSimpleToUser({
      user, devices, title, body, title_i18n, body_i18n, data, overrideLang: lang
    });

    res.json({ ok: true, user_id: uid, ...report });
  } catch (e) {
    res.status(500).json({ ok: false, error: "push_send_failed", detail: e.message || String(e) });
  }
});

module.exports = router;
