const mongoose = require("../db/mongoose");
const { Schema, model } = mongoose;

const MetricSchema = new Schema(
  {
    type: { type: String, index: true }, // e.g. "ask", "welcome", "error", "install"
    userId: { type: String, index: true },
    data:   { type: Object, default: {} },
    createdAt: { type: Date, default: Date.now, index: true, expires: "60d" },
  },
  { versionKey: false }
);

module.exports = model("Metric", MetricSchema);
