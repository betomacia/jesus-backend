const mongoose = require("../db/mongoose");
const { Schema, model } = mongoose;

// Movimientos de créditos por evento
const CreditLedgerSchema = new Schema(
  {
    userId: { type: String, index: true },
    source: { type: String, index: true }, // "ask","gift","admin","purchase"
    delta:  { type: Number, required: true }, // + o -
    meta:   { type: Object, default: {} },
    createdAt: { type: Date, default: Date.now, index: true, expires: "60d" },
  },
  { versionKey: false }
);

module.exports = model("CreditLedger", CreditLedgerSchema);
