// src/services/structured.ts
export class OpenAINoConnectionError extends Error {
  constructor(msg = "Sin conexión con el backend / OpenAI") {
    super(msg);
    this.name = "OpenAINoConnectionError";
  }
}
export class OpenAINoResponseError extends Error {
  constructor(msg = "OpenAI no devolvió contenido") {
    super(msg);
    this.name = "OpenAINoResponseError";
  }
}

const BASE_URL = "https://jesus-backend-production-1cf4.up.railway.app";
const DEV_LOG = false;

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  ms = 25000
): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

async function readJSON(r: Response): Promise<any> {
  const raw = await r.text();
  if (DEV_LOG) console.debug("[structured RAW]", raw?.slice(0, 800));
  if (!raw || !raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { message: raw };
  }
}

type StructuredOut = {
  body: string;
  verse?: string;
  question?: string;
};

// Si el modelo dejó UNA pregunta al final del message, la separamos
function extractTrailingQuestion(msg = ""): { body: string; question: string } {
  const lines = (msg || "").split(/\n+/);
  if (!lines.length) return { body: msg, question: "" };
  const last = lines[lines.length - 1]?.trim() || "";
  if (/\?\s*$/.test(last)) {
    lines.pop();
    return { body: lines.join("\n").trim(), question: last };
  }
  return { body: msg, question: "" };
}

function normalizeToStructured(data: any): StructuredOut {
  let message = (data?.message || "").toString().trim();
  const text = (data?.bible?.text || "").toString().trim();
  const ref = (data?.bible?.ref || "").toString().trim();

  if (!message && !text && !ref) throw new OpenAINoResponseError();

  const { body, question } = extractTrailingQuestion(message);

  // Cita en formato “texto — Libro 0:0”
  const verse =
    text || ref
      ? [text ? text : "", ref ? `— ${ref}` : ""].filter(Boolean).join(" ")
      : undefined;

  return {
    body: body || "¿Qué situación específica quieres contarme hoy?",
    verse,
    question // la mostrará tu App al final
  };
}

export async function getStructuredGuidance(
  persona: string,
  message: string,
  history: string[] = [],
  _memory?: unknown,
  _lastFollowUps?: string[]
): Promise<StructuredOut> {
  const payload = { persona, message, history };

  try {
    const r = await fetchWithTimeout(
      `${BASE_URL}/api/ask`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
      25000
    );

    if (!r.ok) {
      if (r.status === 0) throw new OpenAINoConnectionError();
      await readJSON(r).catch(() => ({}));
      throw new OpenAINoResponseError(`HTTP ${r.status} en /api/ask`);
    }

    const data = await readJSON(r);
    return normalizeToStructured(data);
  } catch {
    try {
      const r2 = await fetchWithTimeout(`${BASE_URL}/api/welcome`, { method: "GET" }, 8000);
      if (!r2.ok) throw new OpenAINoConnectionError();
      const d2 = await readJSON(r2);
      return normalizeToStructured(d2);
    } catch {
      return {
        body: "La paz sea contigo. ¿Qué ocurrió para poder acompañarte mejor?",
        verse: "Dios es el amparo y fortaleza; nuestro pronto auxilio en las tribulaciones. — Salmos 46:1",
        question: "¿Qué situación específica quieres contarme hoy?"
      };
    }
  }
}
