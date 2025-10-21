import wrtc from "wrtc";
import fetch from "node-fetch";

const VOICE_SERVER_URL = "http://10.128.0.40:8000/webrtc/tts";

export async function sendTextViaWebRTC(text, lang = "es", sessionId = "default") {
  return new Promise(async (resolve, reject) => {
    try {
      const pc = new wrtc.RTCPeerConnection();
      const channel = pc.createDataChannel("tts");

      channel.onopen = () => {
        console.log(`[WebRTC-Node] 🔊 Canal abierto — enviando texto (${lang})`);
        channel.send(JSON.stringify({ text, lang, route: "audio_on", sessionId }));
      };

      channel.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.event === "done") {
            console.log("[WebRTC-Node] ✅ TTS finalizado");
            pc.close();
            resolve(true);
          }
        } catch {}
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const res = await fetch(VOICE_SERVER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/sdp", Accept: "application/sdp" },
        body: offer.sdp,
      });
      const answer = await res.text();
      await pc.setRemoteDescription({ type: "answer", sdp: answer });
    } catch (err) {
      console.error("[WebRTC-Node] ❌ Error:", err);
      reject(err);
    }
  });
}
