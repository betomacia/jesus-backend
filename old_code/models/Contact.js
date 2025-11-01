const mongoose = require("../db/mongoose");
const { Schema, model } = mongoose;

const ContactSchema = new Schema(
  {
    name:  { type: String },
    email: { type: String, index: true },
    message: { type: String },
    status:  { type: String, enum: ["new","read","replied"], default: "new", index: true },
    createdAt: { type: Date, default: Date.now, index: true, expires: "60d" },
  },
  { versionKey: false }
);

module.exports = model("Contact", ContactSchema);
