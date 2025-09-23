const mongoose = require("mongoose");

const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/jesusapp";

mongoose.set("strictQuery", true);
mongoose
  .connect(MONGO_URI, { autoIndex: true })
  .then(() => console.log("[db] Mongo conectado"))
  .catch((e) => console.error("[db] Mongo error", e));

module.exports = mongoose;
