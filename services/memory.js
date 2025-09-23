// services/memory.js — Memoria en FS simple
const path = require("path");
const fs = require("fs/promises");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");

async function ensureDataDir() {
  try { await fs.mkdir(DATA_DIR, { recursive: true }); } catch {}
}

function memPath(uid) {
  const safe = String(uid || "anon").replace(/[^a-z0-9_-]/gi, "_");
  return path.join(DATA_DIR, `mem_${safe}.json`);
}

async function readMem(userId) {
  await ensureDataDir();
  try {
    const raw = await fs.readFile(memPath(userId), "utf8");
    const m = JSON.parse(raw);
    return {
      last_user_text: m.last_user_text || "",
      last_user_ts: m.last_user_ts || 0,
      last_bot: m.last_bot || null,
      last_refs: Array.isArray(m.last_refs) ? m.last_refs : [],
    };
  } catch {
    return {
      last_user_text: "",
      last_user_ts: 0,
      last_bot: null,
      last_refs: [],
    };
  }
}

async function writeMem(userId, mem) {
  await ensureDataDir();
  await fs.writeFile(memPath(userId), JSON.stringify(mem, null, 2), "utf8");
}

module.exports = { readMem, writeMem };
