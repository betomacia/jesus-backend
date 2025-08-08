import React, { useState, useRef, useEffect } from "react";

const backendUrl = "https://jesus-backend-production-7f2d.up.railway.app";

export default function App() {
  const [userName, setUserName] = useState("");
  const [hasEnteredName, setHasEnteredName] = useState(false);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);

  const startStreaming = async (text: string) => {
    setIsLoading(true);
    setError("");

    try {
      const res = await fetch(`${backendUrl}/create-stream-session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });

      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(errorText);
      }

      const data = await res.json();

      // Inicializar PeerConnection
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });
      pcRef.current = pc;

      // Manejar pista remota (video/audio)
      pc.ontrack = (event) => {
        if (videoRef.current) {
          videoRef.current.srcObject = event.streams[0];
        }
      };

      // Setear descripción remota (offer desde D-ID)
      await pc.setRemoteDescription(new RTCSessionDescription(data.offer));

      // Crear answer y enviarla al backend D-ID
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      await fetch(data.answer_url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer: pc.localDescription }),
      });

      setIsLoading(false);
    } catch (err: any) {
      setError(err.message || "Error iniciando streaming");
      setIsLoading(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!userName.trim()) return;
    setHasEnteredName(true);
    startStreaming(`Hola ${userName}, ¿cómo estás?`);
  };

  return (
    <div style={{ padding: 20 }}>
      {!hasEnteredName ? (
        <form onSubmit={handleSubmit}>
          <input
            value={userName}
            onChange={(e) => setUserName(e.target.value)}
            placeholder="Ingresa tu nombre"
          />
          <button type="submit" disabled={!userName.trim()}>
            Empezar conversación
          </button>
        </form>
      ) : (
        <div>
          {isLoading && <p>Jesús está preparando su respuesta...</p>}
          {error && <p style={{ color: "red" }}>{error}</p>}
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted={false}
            style={{ width: "100%", maxWidth: 600, borderRadius: 12 }}
          />
        </div>
      )}
    </div>
  );
}
