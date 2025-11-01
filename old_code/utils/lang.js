// utils/lang.js
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

module.exports = { normPlatform, pickLangPref, resolveLocalized };
