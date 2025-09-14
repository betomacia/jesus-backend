// src/App.tsx
import React, { useEffect, useRef, useState } from "react";
import { resetModelMemory } from "./services/openai";
import { OpenAINoConnectionError, OpenAINoResponseError } from "./services/structured";
import {
  api,
  GUIDANCE_PATH,
  BG_CHAT,
  BG_VIDEO,
  INITIAL_CREDITS,
  TEXT_COST_PER_CHAR,
  AUDIO_COST_PER_MSG,
  VIDEO_COST_PER_MSG,
  JESUS_PERSONA,
} from "./config";
import { Lang, Mode, Msg, UserMemory, Gender } from "./types";
import { DEFAULT_CALIB, getOrientation, loadCalib, saveCalib, titleCaseName } from "./utils/ui";
import { loadMemory, saveMemory, syncMemoryToBackend, memoryToPrompt } from "./services/memory";
import Controls from "./components/Controls";
import ChatWindow from "./components/ChatWindow";
import WelcomeScreen from "./components/WelcomeScreen";
import VideoLayer from "./components/VideoLayer";
import CalibratePanel from "./components/CalibratePanel";
import InputBar from "./components/InputBar";
import TermsModal from "./components/TermsModal";
import { inferGender } from "./utils/gender";
import { useSTT } from "./hooks/useSTT";
import { startHeygenSession, stopHeygenSession, isHeygenReady, heygenSpeak, prewarmHeygen } from "./services/heygen";
import { primeAudio } from "./services/tts";

/* ==================== TUNABLES ==================== */
// === Chat cuando VIDEO = ON ===
const CHAT_PANEL_HEIGHT = "35vh";
const CHAT_PANEL_BOTTOM_PX = 65;
const CHAT_PANEL_MAX_W = 720;

// === Chat cuando VIDEO = OFF ===
const CHAT_OFF_TOP = "calc(var(--app-top) + 12px)";
const CHAT_OFF_BOTTOM_PX = 100;
const CHAT_OFF_MAX_W = 520;

// === Streaming / tiempos ===
const HEYGEN_WAIT_READY_MS = 8000;
const TTS_CHUNK_GAP_MS = 200;
/* ================================================== */

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

function useSilenceRtcNoise() {
  useEffect(() => {
    const origError = console.error;
    const pattern = /Unknown DataChannel error on (reliable|lossy)/i;
    console.error = (...args: any[]) => {
      try {
        const a0 = args[0];
        if (typeof a0 === "string" && pattern.test(a0)) return;
        if (a0?.message && typeof a0.message === "string" && pattern.test(a0.message)) return;
        if (a0?.event?.message && typeof a0.event.message === "string" && pattern.test(a0.event.message)) return;
      } catch {}
      origError(...args);
    };
    return () => {
      console.error = origError;
    };
  }, []);
}

/** Preferir imágenes de fondo F* e ignorar J*. */
function pickBg(obj: any, lang: string, def = ""): string {
  if (!obj) return def || "";
  if (typeof obj === "string") return obj;
  const L = (lang || "es").toLowerCase();
  const UP = L.toUpperCase();
  const prefer = ["FESPANOL", `F${UP}`, `F_${UP}`, `F-${UP}`];
  for (const k of prefer) if (obj[k]) return String(obj[k]);
  if (obj[L]) return String(obj[L]);
  if (obj["es"]) return String(obj["es"]);
  for (const [k, v] of Object.entries(obj)) {
    const val = String(v || "");
    const file = val.split("/").pop() || val;
    if (k.startsWith("F") || /^F/i.test(file)) return val;
  }
  for (const [, v] of Object.entries(obj)) return String(v || "");
  return def || "";
}

/** Deriva FFONDO.jpeg usando la misma base/carpeta que un fondo ya válido. */
function deriveFFondoFrom(urlLike: string): string {
  try {
    const u = new URL(urlLike || "", window.location.origin);
    const parts = u.pathname.split("/");
    parts[parts.length - 1] = "FFONDO.jpeg";
    u.pathname = parts.join("/");
    return u.toString();
  } catch {
    if (!urlLike) return "/FFONDO.jpeg";
    const slash = urlLike.lastIndexOf("/");
    if (slash >= 0) return urlLike.slice(0, slash + 1) + "FFONDO.jpeg";
    return "/FFONDO.jpeg";
  }
}

/* ===== helpers de audio y sincronía Heygen ===== */
async function unlockAudioGlobally() {
  try {
    const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (Ctx) {
      const ctx = new Ctx();
      if (ctx.state === "suspended") await ctx.resume();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0.00001;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.05);
    }
  } catch {}
  try {
    const a = new Audio();
    a.src = "data:audio/mp3;base64,//uQZAAAAAAAAAAAAAAAAAAAAAAAWGlinZwAAAA8AAAACAAACcQCA";
    a.muted = true;
    await a.play().catch(() => {});
    a.pause();
    a.src = "";
  } catch {}
}

function forceUnmute(el: HTMLMediaElement | null) {
  if (!el) return;
  try {
    (el as any).defaultMuted = false;
    el.muted = false;
    (el as any).removeAttribute?.("muted");
    (el as any).volume = 1.0;
    (el as any).playsInline = true;
    (el as any).autoplay = true;
  } catch {}
}
async function ensureAudible(el: HTMLMediaElement | null) {
  if (!el) return;
  forceUnmute(el);
  try {
    await el.play();
  } catch {}
}

// === Cola de locuciones para evitar solapados ===
let speakChain: Promise<void> = Promise.resolve();
function enqueueSpeak(job: () => Promise<void>) {
  speakChain = speakChain.then(job).catch(() => {});
  return speakChain;
}

// Espera estricta: Heygen listo + media en playing/canplay
async function waitForHeygenReadyAndPlaying(mediaEl: HTMLMediaElement | null, maxMs = 12000) {
  const t0 = Date.now();
  while (!isHeygenReady() && Date.now() - t0 < maxMs) {
    await sleep(120);
  }
  if (mediaEl) {
    if (!mediaEl.paused && !mediaEl.ended && mediaEl.readyState >= 2) return;
    await mediaEl.play().catch(() => {});
    const ok = await new Promise<boolean>((resolve) => {
      let settled = false;
      const onPlaying = () => { if (!settled) { settled = true; cleanup(); resolve(true); } };
      const onCanPlay = () => { if (!settled) { settled = true; cleanup(); resolve(true); } };
      const to = setTimeout(() => { if (!settled) { settled = true; cleanup(); resolve(false); } }, Math.max(800, maxMs / 3));
      const cleanup = () => {
        try { mediaEl.removeEventListener("playing", onPlaying); } catch {}
        try { mediaEl.removeEventListener("canplay", onCanPlay); } catch {}
        clearTimeout(to);
      };
      mediaEl.addEventListener("playing", onPlaying);
      mediaEl.addEventListener("canplay", onCanPlay);
    });
    if (!ok) {
      await mediaEl.play().catch(() => {});
    }
  }
}

/* =================== Componente =================== */
export default function App(): JSX.Element {
  useSilenceRtcNoise();

  // Estado principal
  const [userName, setUserName] = useState("");
  const [gender, setGender] = useState<Gender>("unknown");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [loading, setLoading] = useState(false);
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [memory, setMemory] = useState<UserMemory>(loadMemory());
  const memoryRef = useRef<UserMemory>(memory);
  useEffect(() => {
    memoryRef.current = memory;
  }, [memory]);

  const [mode, setMode] = useState<Mode>({ chat: true, audio: true, video: true });
  const [started, setStarted] = useState(false);
  const [uiLang, setUiLang] = useState<Lang>("es");

  const [credits, setCredits] = useState<number>(INITIAL_CREDITS);
  const creditsPct = Math.max(0, Math.min(100, Math.round((credits / INITIAL_CREDITS) * 100)));
  const creditColor = creditsPct > 60 ? "bg-emerald-500" : creditsPct > 30 ? "bg-amber-500" : "bg-rose-600";

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const [orient, setOrient] = useState<"portrait" | "landscape">(getOrientation());
  const [calib, setCalib] = useState<any>(loadCalib(getOrientation()));
  const [calibrating, setCalibrating] = useState(false);

  const [isReady, setIsReady] = useState(false);
  const [videoPlaying, setVideoPlaying] = useState(false);
  const [userEnabledAudio, setUserEnabledAudio] = useState(false);

  const [lastError, setLastError] = useState<string | undefined>(undefined);

  const [playbackBusy, setPlaybackBusy] = useState(false);
  const busyUntilRef = useRef<number>(0);
  const setBusyFor = (ms: number) => {
    const until = Date.now() + Math.max(0, ms | 0);
    busyUntilRef.current = Math.max(busyUntilRef.current, until);
  };
  useEffect(() => {
    let alive = true;
    const tick = () => {
      if (!alive) return;
      const busy = Date.now() < busyUntilRef.current;
      setPlaybackBusy(busy);
      setTimeout(tick, 100);
    };
    tick();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    prewarmHeygen(uiLang as any).catch(() => {});
  }, [uiLang]);

  // ====== Términos ======
  const [termsOpen, setTermsOpen] = useState(false);
  const [dontShowTerms, setDontShowTerms] = useState(false);
  useEffect(() => {
    try {
      const flag = localStorage.getItem("terms_accepted") === "1";
      const dont = localStorage.getItem("terms_dont_show") === "1";
      if (flag) setDontShowTerms(dont);
    } catch {}
  }, []);

  const currentStage: "welcome" | "connecting" | "ready" = !started
    ? "welcome"
    : mode.video
    ? isReady || videoPlaying
      ? "ready"
      : "connecting"
    : "ready";

  const stt = useSTT(uiLang, Boolean(mode.audio && currentStage === "ready" && !playbackBusy), (txt) => sendMessage(txt));

  const inputElRef = useRef<HTMLInputElement | null>(null);

  // Dimensiones/orientación
  useEffect(() => {
    const setDims = () => {
      const vh = typeof window !== "undefined" ? window.innerHeight : 0;
      document.documentElement.style.setProperty("--app-h", `${vh}px`);
      document.documentElement.style.setProperty("--app-top", `${Math.round(vh * 0.12)}px`);
    };
    setDims();
    const onChange = () => {
      const o = getOrientation();
      setOrient(o);
      setCalib(loadCalib(o));
    };
    window.addEventListener("resize", setDims);
    window.addEventListener("orientationchange", setDims);
    window.addEventListener("orientationchange", onChange);
    window.addEventListener("resize", onChange);
    return () => {
      window.removeEventListener("resize", setDims);
      window.removeEventListener("orientationchange", setDims);
      window.removeEventListener("orientationchange", onChange);
      window.removeEventListener("resize", onChange);
    };
  }, []);

  useEffect(() => {
    saveMemory(memory);
  }, [memory]);

  // Listeners del <video>
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onPlaying = () => {
      setVideoPlaying(true);
      setIsReady(true);
    };
    const onPause = () => setVideoPlaying(false);
    const onEnded = () => setVideoPlaying(false);
    v.addEventListener("playing", onPlaying);
    v.addEventListener("pause", onPause);
    v.addEventListener("ended", onEnded);
    return () => {
      try { v.removeEventListener("playing", onPlaying); } catch {}
      try { v.removeEventListener("pause", onPause); } catch {}
      try { v.removeEventListener("ended", onEnded); } catch {}
    };
  }, []);

  // ===== helpers =====
  const countWords = (s: string) => (s.match(/\b[\p{L}\p{N}’'-]+\b/gu) || []).length;
  const estimateSpeakMs = (txt: string) => {
    const w = Math.max(1, countWords(txt));
    return Math.min(Math.max(380 * w + 700, 1300), 32000);
  };

  const splitSentences = (s: string) =>
    (s || "")
      .replace(/\s+/g, " ")
      .trim()
      .split(/([.!?…]+)\s+/u)
      .filter(Boolean)
      .reduce<string[]>((acc, cur, i, arr) => {
        if (i % 2 === 0) {
          const body = cur || "";
          const end = arr[i + 1] || "";
          const sent = (body + (end || "")).trim();
          if (sent) acc.push(sent);
        }
        return acc;
      }, []);

  // ===== inicio =====
  const didGreetRef = useRef(false);
  const greetScheduledRef = useRef(false);

  // Paso intermedio: desde WelcomeScreen -> abrir términos
  function beginFromWelcome() {
    try {
      const alreadyAccepted = localStorage.getItem("terms_accepted") === "1";
      const dont = localStorage.getItem("terms_dont_show") === "1";
      if (alreadyAccepted && dont) {
        startWithAudio();
        return;
      }
    } catch {}
    setTermsOpen(true);
  }

  function acceptTerms() {
    try {
      localStorage.setItem("terms_accepted", "1");
      localStorage.setItem("terms_dont_show", dontShowTerms ? "1" : "0");
    } catch {}
    setTermsOpen(false);
    startWithAudio();
  }

  function closeTerms() {
    setTermsOpen(false);
  }

  async function startWithAudio() {
    if (!userName.trim()) return;
    setStarted(true);
    didGreetRef.current = false;
    greetScheduledRef.current = false;
    setUserEnabledAudio(true);

    await unlockAudioGlobally();
    try { primeAudio(); } catch {}
    try { (window as any).speechSynthesis?.resume?.(); } catch {}
    try { await resetModelMemory(); } catch {}

    forceUnmute(videoRef.current);
    forceUnmute(audioRef.current);

    const nm = titleCaseName(userName || "");
    const inferred = gender === "unknown" ? inferGender(nm, uiLang) : gender;
    const finalGender = inferred || "unknown";
    const nextMemory: UserMemory = {
      ...memory,
      profile: { ...memory.profile, name: nm || memory.profile.name, gender: finalGender, holaCount: 0 },
      lastUpdated: Date.now(),
    };
    setMemory(nextMemory);
    memoryRef.current = nextMemory;

    if (mode.video) {
      (async () => {
        try { await stopHeygenSession(); } catch {}
        await sleep(20);
        const v = videoRef.current;
        if (!v) return;
        forceUnmute(v);
        await startHeygenSession(uiLang as any, v as any).catch(() => false);
        const t0 = Date.now();
        while (!isHeygenReady() && Date.now() - t0 < HEYGEN_WAIT_READY_MS) await sleep(140);
        await ensureAudible(v);
      })();
    } else {
      (async () => {
        try { await stopHeygenSession(); } catch {}
        await sleep(20);
        const a = audioRef.current;
        if (!a) return;
        forceUnmute(a);
        await startHeygenSession(uiLang as any, a as any).catch(() => false);
        const t0 = Date.now();
        while (!isHeygenReady() && Date.now() - t0 < HEYGEN_WAIT_READY_MS) await sleep(140);
        await ensureAudible(a);
      })();
    }
  }

  // ===== toggles =====
  const lastToggleRef = useRef(0);
  const canToggle = (gap = 600) => {
    const now = Date.now();
    if (now - lastToggleRef.current < gap) return false;
    lastToggleRef.current = now;
    return true;
  };

  const toggleVideo = () => {
    if (!canToggle()) return;
    const connecting = mode.video && !(isReady || videoPlaying);
    if (playbackBusy || connecting || loading) return;

    setMode((prev) => {
      const turningOn = !prev.video;
      const next = turningOn ? { ...prev, video: true, audio: true } : { ...prev, video: false, audio: true, chat: true };

      setTimeout(() => {
        (async () => {
          try { await stopHeygenSession(); } catch {}
          await sleep(20);

          if (turningOn) {
            setIsReady(false);
            setVideoPlaying(false);
            const v = videoRef.current;
            forceUnmute(v);
            await startHeygenSession(uiLang as any, v as any).catch(() => false);
            const t0 = Date.now();
            while (!isHeygenReady() && Date.now() - t0 < HEYGEN_WAIT_READY_MS) await sleep(140);
            await ensureAudible(v);
          } else {
            const a = audioRef.current;
            forceUnmute(a);
            await startHeygenSession(uiLang as any, a as any).catch(() => false);
            const t1 = Date.now();
            while (!isHeygenReady() && Date.now() - t1 < HEYGEN_WAIT_READY_MS) await sleep(140);
            await ensureAudible(a);
          }
        })();
      }, 0);

      return next;
    });
  };

  const toggleAudio = () => {
    if (!canToggle()) return;
    if (playbackBusy || (mode.video && currentStage === "connecting") || loading) return;
    setMode((p) => {
      const turningOn = !p.audio;
      if (!turningOn && p.video) return p;
      const next = { ...p, audio: turningOn };
      if (turningOn && !p.video) next.chat = true;
      setUserEnabledAudio(turningOn);
      if (turningOn) {
        forceUnmute(videoRef.current);
        forceUnmute(audioRef.current);
        ensureAudible(p.video ? (videoRef.current as any) : (audioRef.current as any));
      }
      return next;
    });
  };

  const toggleChat = () => setMode((p) => ({ ...p, chat: !p.chat }));

  useEffect(() => {
    if (mode.audio && !mode.video && !mode.chat) {
      setMode((p) => ({ ...p, chat: true }));
    }
  }, [mode.audio, mode.video]);

  // ===== hablar con cola y pacing =====
  async function internalSpeak(full: string) {
    const mediaEl = mode.video ? (videoRef.current as HTMLMediaElement | null) : (audioRef.current as HTMLMediaElement | null);
    forceUnmute(mediaEl);
    await waitForHeygenReadyAndPlaying(mediaEl, HEYGEN_WAIT_READY_MS);
    const chunks = splitSentences(full.trim());
    const totalMs = chunks.reduce((acc, s) => acc + estimateSpeakMs(s), 0) + 600;
    setBusyFor(totalMs);
    for (const ck of chunks) {
      try { await heygenSpeak(ck); } catch {}
      await sleep(TTS_CHUNK_GAP_MS);
    }
    await ensureAudible(mediaEl);
  }

  const speakWelcomeOnce = async (full: string) => {
    if (!full.trim()) return;
    await enqueueSpeak(() => internalSpeak(full));
  };

  const speakAssistant = async (text: string) => {
    const cleaned = (text || "").trim();
    if (!cleaned) return;
    await enqueueSpeak(() => internalSpeak(cleaned));
  };

  // Saludo inicial: SOLO desde backend (POST /api/welcome)
  useEffect(() => {
    if (!started) return;
    const canAttempt = mode.video ? isReady || videoPlaying : true;
    if (!canAttempt) return;
    const hasAssistantMsg = messages.some((m) => m.role === "assistant");
    if (didGreetRef.current || greetScheduledRef.current || hasAssistantMsg) return;

    greetScheduledRef.current = true;
    (async () => {
      try {
        const nm = titleCaseName(userName || "").trim();
        const r = await fetch(api("/api/welcome"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "omit",
          body: JSON.stringify({ lang: uiLang, name: nm, history }),
        });
        const data = await r.json().catch(() => ({}));
        const msgText = String(data?.message || "").trim();
        const qText = String(data?.question || "").toString().trim();
        const welcomeFull = [msgText, qText].filter(Boolean).join("\n\n").trim() || `Hola ${nm || "alma amada"}. ¿Qué te gustaría compartir hoy?`;

        const msg: Msg = { role: "assistant", text: welcomeFull, id: String(Date.now() + Math.random()), timestamp: new Date() } as Msg;
        setMessages((prev) => [...prev, msg]);
        setHistory((prev) => [...prev, `Asistente: ${welcomeFull}`]);
        await speakWelcomeOnce(welcomeFull);
        didGreetRef.current = true;
      } catch {
        const nm = titleCaseName(userName || "").trim();
        const w = `Hola ${nm || "alma amada"}. ¿Qué te gustaría compartir hoy?`;
        const msg: Msg = { role: "assistant", text: w, id: String(Date.now() + Math.random()), timestamp: new Date() } as Msg;
        setMessages((prev) => [...prev, msg]);
        setHistory((prev) => [...prev, `Asistente: ${w}`]);
        await speakWelcomeOnce(w);
        didGreetRef.current = true;
      }
    })();
  }, [started, mode.video, isReady, videoPlaying, messages, userName, uiLang, history]);

  // Envío de mensajes (usa backend /api/ask)
  const addMsg = (m: Omit<Msg, "id" | "timestamp"> & { asAudio?: boolean }) => {
    const newMsg: Msg = { ...m, id: String(Date.now() + Math.random()), timestamp: new Date() };
    setMessages((prev) => [...prev, newMsg]);
    setHistory((prev) => [...prev, `${m.role === "user" ? "Usuario" : "Asistente"}: ${m.text}`]);
    if (m.role === "assistant" && m.asAudio && mode.audio) speakAssistant(m.text).catch(() => {});
  };

  async function sendMessage(text: string) {
    const cleaned = (text || "").trim();
    if (!cleaned) return;
    if (loading) return;
    setInput("");
    setLoading(true);
    setLastError(undefined);
    addMsg({ role: "user", text: cleaned });

    try {
      const personaWithMemory = `${JESUS_PERSONA}\n\n${memoryToPrompt(memoryRef.current)}`;
      const r = await fetch(api(GUIDANCE_PATH), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "omit",
        body: JSON.stringify({
          persona: "jesus",
          message: cleaned,
          history,
          persona_extra: personaWithMemory,
          lang: uiLang,
        }),
      });
      if (!r.ok) throw new OpenAINoResponseError("El backend no respondió OK");

      const data = await r.json().catch(() => ({}));
      const msg = String(data?.message || "").trim();
      const verseLine =
        data?.bible?.text && data?.bible?.ref ? `— ${String(data.bible.text).trim()} (${String(data.bible.ref).trim()})` : "";
      const q = String(data?.question || "").trim();

      const finalText =
        [msg, verseLine, q].filter(Boolean).join("\n\n").trim() ||
        (uiLang === "en" ? "Thank you for sharing. Let’s take one small and concrete step." : "Gracias por contarlo. Demos un paso concreto y sencillo.");

      addMsg({ role: "assistant", text: finalText, asAudio: true });

      const textLen = (cleaned.length || 0) + (finalText.length || 0);
      let delta = textLen * TEXT_COST_PER_CHAR;
      if (mode.audio) delta += AUDIO_COST_PER_MSG;
      if (mode.video) delta += VIDEO_COST_PER_MSG;
      setCredits((prev) => Math.max(0, +(prev - delta).toFixed(2)));

      setMemory((prev) => {
        const next: UserMemory = { ...prev, lastUpdated: Date.now() };
        next.profile = { ...prev.profile, name: prev.profile.name || titleCaseName(userName || "") || undefined };
        // si tu backend implementa /api/memory/sync, esto retorna 200
        syncMemoryToBackend(next);
        memoryRef.current = next;
        return next;
      });
    } catch (e: any) {
      if (e instanceof OpenAINoConnectionError) setLastError("Sin conexión con OpenAI.");
      else if (e instanceof OpenAINoResponseError) setLastError("OpenAI no devolvió contenido.");
      else setLastError(e?.message || "Error desconocido con OpenAI.");
      addMsg({
        role: "assistant",
        text: uiLang === "en"
          ? "Thank you for sharing. Let’s take one practical step.\n\nWhat worries you right now?"
          : "Gracias por contarlo. Demos un paso concreto y sencillo.\n\n¿Qué te preocupa ahora mismo?",
        asAudio: true,
      });
    } finally {
      setLoading(false);
    }
  }

  // Fondos + fade
  const safeChatBg = pickBg(BG_CHAT as any, uiLang, "");
  const safeVideoBg = pickBg(BG_VIDEO as any, uiLang, "");
  const splashBg = deriveFFondoFrom(safeChatBg || "/FFONDO.jpeg"); // Paso 1
  const bgUrl = mode.video && videoPlaying ? safeVideoBg : safeChatBg;
  const [bgLoaded, setBgLoaded] = useState(false);
  useEffect(() => {
    setBgLoaded(false);
  }, [bgUrl]);

  const controlsLocked = playbackBusy || (mode.video && currentStage === "connecting") || loading;

  return (
    <div className="w-full relative overflow-hidden bg-black" style={{ height: "var(--app-h)" }}>
      {/* Fondo con fade */}
      <img
        src={bgUrl || undefined}
        onLoad={() => setBgLoaded(true)}
        alt=""
        className={`fixed inset-0 w-full h-full z-0 pointer-events-none select-none transition-opacity duration-500 ${
          bgLoaded ? "opacity-100" : "opacity-0"
        }`}
        draggable={false}
        style={{ objectFit: (calib?.fit as any) || "cover" }}
        aria-hidden
      />

      {/* Capa de video */}
      <div
        className={`fixed inset-0 ${videoPlaying && mode.video ? "z-10" : "-z-10"} ${
          videoPlaying && mode.video ? "pointer-events-auto" : "pointer-events-none"
        }`}
      >
        <VideoLayer
          show={mode.video}
          videoRef={videoRef}
          streamReady={isReady}
          userEnabledAudio={userEnabledAudio}
          setUserEnabledAudio={setUserEnabledAudio}
          calib={calib}
        />
      </div>

      {/* AUDIO oculto SIEMPRE presente para headless/tts */}
      <audio ref={audioRef} autoPlay playsInline style={{ display: "none" }} muted={!userEnabledAudio} />

      {/* Bienvenida */}
      {currentStage === "welcome" && (
        <div className="fixed inset-0 z-[120] pointer-events-none">
          <div className="pointer-events-auto h-full">
            <WelcomeScreen
              uiLang={uiLang || "es"}
              setUiLang={(l) => setUiLang(l as Lang)}
              userName={userName || ""}
              setUserName={setUserName}
              gender={gender || "unknown"}
              setGender={setGender}
              onStart={beginFromWelcome}
              splashBg={splashBg}
              bgUrl={safeChatBg}
            />
          </div>
        </div>
      )}

      {/* Modal de términos */}
      <TermsModal
        open={termsOpen}
        checked={dontShowTerms}
        onToggle={() => setDontShowTerms((v) => !v)}
        onAccept={acceptTerms}
        onClose={closeTerms}
        uiLang={uiLang}
      />

      {/* Conectando (solo en video) */}
      {mode.video && currentStage === "connecting" && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center pointer-events-auto">
          <style>{`
            @keyframes indet-primary{0%{left:-35%;right:100%}60%{left:100%;right:-90%}100%{left:100%;right:-90%}}
            @keyframes indet-secondary{0%{left:-200%;right:100%}60%{left:107%;right:-8%}100%{left:107%;right:-8%}}
          `}</style>
          <div className="px-6 py-5 rounded-2xl bg-white/95 shadow-xl text-gray-900 w-[92%] max-w-md text-center">
            <div className="mb-3 font-semibold tracking-wide">
              {uiLang === "es"
                ? "Aguarda, te estamos conectando con Jesús"
                : uiLang === "pt"
                ? "Aguarde, estamos conectando você com Jesus"
                : uiLang === "it"
                ? "Attendi, ti stiamo collegando con Gesù"
                : uiLang === "de"
                ? "Bitte warten, wir verbinden dich mit Jesus"
                : uiLang === "ca"
                ? "Espera, t'estem connectant amb Jesús"
                : "Please wait, we are connecting you with Jesus"}
            </div>
            <div className="relative h-1.5 w-full bg-gray-200 rounded-full overflow-hidden">
              <span
                className="absolute top-0 bottom-0 bg-emerald-500 rounded-full"
                style={{ animation: "indet-primary 2.1s cubic-bezier(0.65,0.815,0.735,0.395) infinite" }}
              />
              <span
                className="absolute top-0 bottom-0 bg-emerald-500/70 rounded-full"
                style={{ animation: "indet-secondary 2.1s cubic-bezier(0.165,0.84,0.44,1) 1.15s infinite" }}
              />
            </div>
          </div>
        </div>
      )}

      {/* UI principal */}
      {currentStage === "ready" && (
        <>
          <CalibratePanel
            visible={calibrating && mode.video}
            orient={orient}
            calib={calib}
            setCalib={setCalib}
            onSave={() => {
              saveCalib(orient, calib);
              setCalibrating(false);
            }}
            onClose={() => setCalibrating(false)}
            onReset={() => {
              const def = { ...DEFAULT_CALIB, fit: calib.fit };
              setCalib(def);
              saveCalib(orient, def);
            }}
          />

          <div className="fixed inset-x-0 top-0 z-[100]">
            <Controls
              mode={mode}
              toggleChat={toggleChat}
              toggleAudio={toggleAudio}
              toggleVideo={toggleVideo}
              credits={credits}
              creditsPct={creditsPct}
              creditColor={creditColor}
            />
          </div>

          {/* CHAT con video ON (panel transparente) */}
          {mode.chat && mode.video && (
            <section className="fixed left-0 right-0 z-[95]" style={{ bottom: `${CHAT_PANEL_BOTTOM_PX}px`, height: CHAT_PANEL_HEIGHT }}>
              <div className="mx-auto h-full px-3" style={{ maxWidth: `${CHAT_PANEL_MAX_W}px` }}>
                <div className="h-full rounded-2xl border border-white/10 bg-transparent backdrop-blur-md p-3 shadow-lg overflow-hidden">
                  <div className="h-full overflow-y-auto overscroll-contain">
                    <ChatWindow messages={messages} loading={loading} />
                  </div>
                </div>
              </div>
            </section>
          )}

          {/* CHAT con video OFF */}
          {mode.chat && !mode.video && (
            <section className="fixed left-0 right-0 z-40" style={{ top: CHAT_OFF_TOP, bottom: `${CHAT_OFF_BOTTOM_PX}px` }}>
              <div className="mx-auto flex justify-center h-full px-3" style={{ maxWidth: `${CHAT_OFF_MAX_W}px` }}>
                <ChatWindow messages={messages} loading={loading} />
              </div>
            </section>
          )}

          <div className="fixed left-0 right-0 bottom-0 z-[100]">
            <InputBar
              input={input}
              setInput={setInput}
              loading={loading}
              onSend={sendMessage}
              inputDisabled={playbackBusy || (mode.video && currentStage === "connecting") || loading}
              controlsDisabled={playbackBusy || (mode.video && currentStage === "connecting") || loading}
              sttSupported={Boolean(stt.supported && mode.audio)}
              listening={stt.listening}
              onPressHoldStart={() => stt.startHold()}
              onPressHoldEnd={(send) => stt.endHold(send)}
              uiLang={uiLang}
              inputRef={inputElRef}
              placeholderOverride={stt.listening ? "Grabando… suelta para enviar" : "Escribe o pulsa para grabar…"}
            />
          </div>
        </>
      )}
    </div>
  );
}
