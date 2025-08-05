import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

app.post("/generate-video", (req, res) => {
  console.log("POST /generate-video recibido");
  res.json({ message: "Ruta POST /generate-video funciona" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
});
