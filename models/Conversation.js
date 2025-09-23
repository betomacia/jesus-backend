const mongoose = require("../db/mongoose");
const { Schema, model } = mongoose;

// Una conversación agrupada (por userId o sesión)
const ConversationSchema = new Schema(
  {
    userId: { type: String, index: true },
    meta:   { type: Object, default: {} },
    // TTL: borra la conversación 60 días después de createdAt
    createdAt: { type: Date, default: Date.now, index: true, expires: "60d" },
  },
  { versionKey: false }
);

module.exports = model("Conversation", ConversationSchema);
