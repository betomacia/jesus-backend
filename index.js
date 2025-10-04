// index.js — Backend minimal para Jesús Interactivo
// Esta versión incluye soporte para el parámetro `source=xtts-jesus2`
// que se convierte en `ref=jesus2.mp3` para el backend de voz.

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const { Readable } = require("stream");

const app = express();
const PORT = process.env.PORT || 3000;
const VOZ_URL = process.env.VOZ_URL || "http://localhost:8000";

app.use(cors());
app.use(express.json());

function toQS(obj) {
  return Object.entries(obj)
    .filter(([_, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

function buildParamsFromQuery(query) {
  const baseParams = {
    text: query.text || "Hola",
    lang: query.lang || "es",
    rate: query.rate || "1.10",
    temp: query.temp || "0.6",
    fx: query.fx || "0",
    hpf: query.hpf, lpf: query.lpf, warm_db: query.warm_db,
    air_db: query.air_db, presence_db: query.presence_db,
    reverb_wet: query.reverb_wet, reverb_delay: query.reverb_delay, reverb_tail: query.reverb_tail,
    comp: query.comp, width_ms: query.width_ms, pitch_st: query.pitch_st, gain_db: query.gain_db,
    provider: query.provider || "xtts",
  };

  // Manejo del `source=xtts-jesus2` → ref=jesus2.mp3
  if (query.source && query.source.startsWith("xtts")) {
    baseParams.provider = "xtts";
    baseParams.ref = query.source.replace("xtts-", "") + ".mp3";
  }

  return baseParams;
}

async function pipeUpstream(up, res, fallbackType = "application/octet-stream") {
  res.status(up.status);
  const ct = up.headers.get("content-type");
  if (ct) res.setHeader("Content-Type", ct);
  else res.setHeader("Content-Type", fallbackType);
  const cl = up.headers.get("content-length");
  if (cl) res.setHeader("Content-Length", cl);
  const cr = up.headers.get("accept-ranges");
  if (cr) res.setHeader("Accept-Ranges", cr);
  if (!up.body) return res.end();
  return Readable.fromWeb(up.body).pipe(res);
}

// === Endpoint: WAV por streaming ===
app.get("/api/tts", async (req, res) => {
  try {
    const baseParams = buildParamsFromQuery(req.query);
    const url = new URL("/tts", VOZ_URL);
    url.search = toQS(baseParams);

    const up = await fetch(url.toString());
    if (!up.ok) return res.status(502).json({ ok: false, status: up.status });
    return pipeUpstream(up, res, "audio/wav");
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// === Endpoint: WAV generado y guardado ===
app.get("/api/tts_save", async (req, res) => {
  try {
    const baseParams = buildParamsFromQuery(req.query);
    const url = new URL("/tts_save", VOZ_URL);
    url.search = toQS(baseParams);

    const up = await fetch(url.toString());
    const txt = await up.text();
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(up.status).send(txt);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Salud
app.get("/", (req, res) => {
  res.json({ ok: true, service: "railway-proxy" });
});

app.listen(PORT, () => console.log(`Servidor backend proxy en http://localhost:${PORT}`));
