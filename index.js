import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

app.post("/generate-video", (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "Texto requerido" });
  // Solo respondemos con el texto recibido, sin más lógica
  res.json({ message: "Texto recibido correctamente", text });
});

const PORT = 3000;
app.listen(PORT, () => console.log(`Servidor escuchando en http://localhost:${PORT}`));
