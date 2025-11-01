const mongoose = require("../db/mongoose");
const { Schema, model } = mongoose;

// Para Play/App Store: registro de installs/activations
const InstallSchema = new Schema(
  {
    platform: { type: String, enum: ["android", "ios", "web"], index: true },
    storeId:  { type: String }, // package/bundle id
    deviceId: { type: String, index: true }, // ID anónimo
    userId:   { type: String, index: true }, // si lo asocias luego
    meta:     { type: Object, default: {} },
    createdAt: { type: Date, default: Date.now, index: true, expires: "60d" },
  },
  { versionKey: false }
);

module.exports = model("Install", InstallSchema);
