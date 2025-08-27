// routes/did.js
const express = require("express");
const nodeFetch = require("node-fetch");

const router = express.Router();

const DID_API_KEY = process.env.DID_API_KEY || "";
const DID_USER = process.env.DID_USERNAME || "";
const DID_PASS = process.env.DID_PASSWORD || "";

// OJO: para Streams la base es SIN /v1
const DID_BASE = process.env.DID_BASE || "https://api.d-id.com";
const fetch = (...args) => nodeFetch(...args);

// === Auth header ===
const authMode = DID_API_KEY
  ? "API_KEY"
  : (DID_USER && DID_PASS ? "USER_PASS" : "MISSING");

const didHeaders = () => {
  const h = { "Content-Type": "application/json", Accept: "application/json" };
  if (authMode === "API_KEY") {
    // Basic base64("APIKEY:")
    h.Authorization = "Basic " + Buffer.from(`${DID_API_KEY}:`).toString("base64");
  } else if (authMode === "USER_PASS") {
    // Basic base64("user:pass")
    h.Authorization = "Basic " + Buffer.from(`${DID_USER}:${DID_PASS}`).toString("base64");
  }
  return h;
};

// === Cookie jar en memoria por streamId (para stickiness del ALB) ===
const cookieJar = new Map(); // streamId -> cookie (string)

// Utilidades
const validSess = (s) => typeof s === "string" && /^sess_/i.test(s);

/** Parsea el header Set-Cookie completo y arma:
 *  - cookie: "AWSALB=...; AWSALBCORS=...; session_id=sess_..."
 *  - session_id: "sess_..."
 */
function parseSetCookie(setCookieHeader) {
  const out = { cookie: "", session_id: "" };
  if (!setCookieHeader) return out;

  const sess = setCookieHeader.match(/session_id=(sess_[^;,\s]+)/i);
  const alb = setCookieHeader.match(/AWSALB=[^;]+/);
  const cors = setCookieHeader.match(/AWSALBCORS=[^;]+/);

  const parts = [];
  if (alb) parts.push(alb[0]);
  if (cors) parts.push(cors[0]);
  if (sess) { parts.push(`session_id=${sess[1]}`); out.session_id = sess[1]; }

  out.cookie = parts.join("; ");
  return
