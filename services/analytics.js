const Conversation = require("../models/Conversation");
const Message = require("../models/Message");
const Metric = require("../models/Metric");
const CreditLedger = require("../models/CreditLedger");

/**
 * Guarda evento de /api/ask de forma no-bloqueante.
 * Llamalo con try{ logAskEvent(...); }catch{}
 */
async function logAskEvent({
  userId = "anon",
  requestText = "",
  responseText = "",
  credits = { textChars: 0, audio: 0, video: 0, total: 0 },
  tokens = { prompt: 0, completion: 0 },
  convoId = null, // si querés forzar thread
  meta = {},
}) {
  try {
    let conv = null;

    if (convoId) {
      conv = await Conversation.findById(convoId).catch(() => null);
    }
    if (!conv) {
      // Podés reusar una conversación de hoy del mismo usuario, o crear una nueva
      conv = await Conversation.create({ userId, meta: { startedBy: "ask", ...meta } });
    }

    await Message.create({
      convId: conv._id,
      userId,
      role: "user",
      text: String(requestText || ""),
      tokens,
      credits: { textChars: 0, audio: 0, video: 0, total: 0 },
    });

    await Message.create({
      convId: conv._id,
      userId,
      role: "assistant",
      text: String(responseText || ""),
      tokens,
      credits,
    });

    if (credits && Number(credits.total) !== 0) {
      await CreditLedger.create({
        userId,
        source: "ask",
        delta: -Math.abs(Number(credits.total)),
        meta: { ...meta, breakdown: credits },
      });
    }

    await Metric.create({
      type: "ask",
      userId,
      data: { lenIn: (requestText || "").length, lenOut: (responseText || "").length, credits, tokens, meta },
    });

    return conv._id.toString();
  } catch (e) {
    console.warn("[analytics] logAskEvent failed:", e?.message);
    return null;
  }
}

module.exports = { logAskEvent };
