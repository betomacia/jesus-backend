import express from "express";
import cors from "cors";
import fetch from "node-fetch"; // Si usás Node 18+, podés omitir esto

const app = express();
app.use(cors());
app.use(express.json());

app.post("/api/avatar", async (req, res) => {
  try {
    const { text, userId = "anon" } = req.body;
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "Missing or invalid text" });
    }

    // 🔁 Llamar al servidor avatar en Google Cloud
    const avatarRes = await fetch("http://34.67.119.151:8083/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, userId }),
    });

    if (!avatarRes.ok) throw new Error("Avatar server failed");

    const buffer = await avatarRes.arrayBuffer();
    res.setHeader("Content-Type", "video/mp4");
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error("Error en /api/avatar:", err);
    res.status(500).json({ error: "No se pudo generar el video", details: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor Railway corriendo en puerto ${PORT}`);
});
