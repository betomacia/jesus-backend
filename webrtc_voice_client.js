import wrtc from "wrtc";
import fetch from "node-fetch";

const VOICE_SERVER_URL = "http://10.128.0.40:8000/webrtc/tts";

/**
 * Envía texto al servidor de voz (jesus-voice) usando WebRTC DataChannel.
 * Incluye logs detallados del texto enviado y respuestas recibidas.
 */
export async function sendTextViaWebRTC(text, lang = "es", sessionId = "default") {
  try {
    console.log("──────────────────────────────────────────────");
    console.log(`🎙️ [WebRTC] Iniciando envío de texto al servidor de voz`);
    console.log(`🌐 Destino: ${VOICE_SERVER_URL}`);
    console.log(`🗣️ Idioma: ${lang}`);
    console.log(`💬 Texto (${text.length} caracteres):`);
    console.log(text);
    console.log("──────────────────────────────────────────────");

    const pc = new wrtc.RTCPeerConnection();
    const channel = pc.createDataChannel("tts");

    channel.onopen = () => {
      console.log(`[WebRTC] 📡 Canal abierto — enviando texto (${lang})`);
      const payload = { text, lang, route: "audio_on", sessionId };
      channel.send(JSON.stringify(payload));
    };

    channel.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.event === "audio_chunk") {
          console.log(`[WebRTC] 🎧 Chunk recibido (${msg.audio?.length || 0} bytes base64)`);
        } else if (msg.event === "done") {
          console.log("[WebRTC] ✅ Servidor completó transmisión de audio");
          pc.close();
        }
      } catch (err) {
        console.error("[WebRTC] ❌ Error procesando mensaje:", err);
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const res = await fetch(VOICE_SERVER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/sdp", Accept: "application/sdp" },
      body: offer.sdp,
    });

    if (!res.ok) throw new Error(`Servidor de voz devolvió ${res.status}`);
    const answer = await res.text();
    await pc.setRemoteDescription({ type: "answer", sdp: answer });

    console.log("✅ [WebRTC] Texto entregado al servidor de voz correctamente");
  } catch (err) {
    console.error("⚠️ [WebRTC] Error enviando al servidor de voz:", err.message);
  }
}
