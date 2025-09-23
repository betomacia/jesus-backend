const express = require("express");
const Metric = require("../models/Metric");
const Message = require("../models/Message");
const Install = require("../models/Install");
const CreditLedger = require("../models/CreditLedger");

const router = express.Router();

// ¡Poné auth real! (token simple)
router.use((req, res, next) => {
  const TOKEN = process.env.ADMIN_TOKEN || "";
  if (!TOKEN) return res.status(500).json({ error: "admin_token_not_set" });
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return res.status(401).json({ error: "unauthorized" });
  next();
});

// KPIs rápidos (últimos 7 días)
router.get("/kpis", async (req, res) => {
  try {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [asks, msgs, installs, credits] = await Promise.all([
      Metric.countDocuments({ type: "ask", createdAt: { $gte: since } }),
      Message.countDocuments({ createdAt: { $gte: since } }),
      Install.countDocuments({ createdAt: { $gte: since } }),
      CreditLedger.aggregate([
        { $match: { createdAt: { $gte: since } } },
        { $group: { _id: null, total: { $sum: "$delta" } } },
      ]),
    ]);

    res.json({
      asks7d: asks,
      messages7d: msgs,
      installs7d: installs,
      netCredits7d: credits[0]?.total || 0,
    });
  } catch (e) {
    res.status(500).json({ error: "kpis_failed" });
  }
});

module.exports = router;
