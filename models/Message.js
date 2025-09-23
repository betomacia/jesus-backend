const mongoose = require("../db/mongoose");
const { Schema, model, Types } = mongoose;

const MessageSchema = new Schema(
  {
    convId:  { type: Types.ObjectId, ref: "Conversation", index: true },
    userId:  { type: String, index: true },
    role:    { type: String, enum: ["user", "assistant", "system"], index: true },
    text:    { type: String },
    tokens:  { prompt: Number, completion: Number },
    credits: { textChars: Number, audio: Number, video: Number, total: Number },
    // Para replays/debug
    raw:     { type: Object }, // opcional, guarda payloads si quieres
    createdAt: { type: Date, default: Date.now, index: true, expires: "60d" },
  },
  { versionKey: false }
);

module.exports = model("Message", MessageSchema);
