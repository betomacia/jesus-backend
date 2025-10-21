import wrtc from "wrtc";
import fetch from "node-fetch";

const VOICE_SERVER_URL = "http://10.128.0.40:8000/webrtc/tts";

/**
 * Envía texto al servidor de voz usando WebRTC DataChannel
 * CON TIMING CORRECTO y manejo de errores mejorado
 */
export async function sendTextViaWebRTC(text, lang = "es", sessionId = "default") {
  return new Promise(async (resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("WebRTC timeout - servidor no respondió en 30s"));
      pc.close();
    }, 30000);

    try {
      console.log("──────────────────────────────────────────────");
      console.log(`🎙️ [WebRTC] Iniciando envío al servidor de voz`);
      console.log(`🌐 Destino: ${VOICE_SERVER_URL}`);
      console.log(`🗣️ Idioma: ${lang} | Session: ${sessionId}`);
      console.log(`💬 Texto (${text.length} caracteres):`);
      console.log(text);
      console.log("──────────────────────────────────────────────");

      const pc = new wrtc.RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
      });

      let dataChannel = null;
      let channelReady = false;

      // ✅ Crear DataChannel
      dataChannel = pc.createDataChannel("tts", {
        ordered: true,
        maxRetransmits: 3
      });

      // ✅ Esperar a que el canal esté realmente abierto
      dataChannel.onopen = () => {
        console.log(`[WebRTC] 📡 Canal DataChannel ABIERTO`);
        channelReady = true;
        
        // ⏱️ PEQUEÑO DELAY para asegurar que el servidor esté listo
        setTimeout(() => {
          if (dataChannel.readyState === "open") {
            const payload = { text, lang, route: "audio_on", sessionId };
            console.log(`[WebRTC] 📤 ENVIANDO payload:`, JSON.stringify(payload).substring(0, 100) + "...");
            dataChannel.send(JSON.stringify(payload));
            console.log(`[WebRTC] ✅ Mensaje enviado exitosamente`);
          } else {
            console.error(`[WebRTC] ❌ Canal no está abierto: ${dataChannel.readyState}`);
          }
        }, 100); // 100ms de espera
      };

      dataChannel.onerror = (error) => {
        console.error("[WebRTC] ❌ Error en DataChannel:", error);
        clearTimeout(timeout);
        reject(error);
      };

      dataChannel.onclose = () => {
        console.log("[WebRTC] 🔒 DataChannel cerrado");
      };

      dataChannel.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          console.log(`[WebRTC] 📨 Mensaje recibido:`, msg.event || "unknown");
          
          if (msg.event === "audio_chunk") {
            console.log(`[WebRTC] 🎧 Chunk de audio (${msg.audio?.length || 0} bytes)`);
          } else if (msg.event === "done") {
            console.log("[WebRTC] ✅ Servidor completó transmisión");
            clearTimeout(timeout);
            setTimeout(() => {
              pc.close();
              resolve({ success: true, sessionId });
            }, 500);
          } else if (msg.event === "error") {
            console.error("[WebRTC] ❌ Error del servidor:", msg.message);
            clearTimeout(timeout);
            pc.close();
            reject(new Error(msg.message));
          }
        } catch (err) {
          console.error("[WebRTC] ⚠️ Error parseando mensaje:", err);
        }
      };

      // ✅ Manejar cambios de estado de conexión
      pc.onconnectionstatechange = () => {
        console.log(`[WebRTC] 🔄 Estado de conexión: ${pc.connectionState}`);
        if (pc.connectionState === "failed" || pc.connectionState === "closed") {
          clearTimeout(timeout);
          reject(new Error(`Conexión falló: ${pc.connectionState}`));
        }
      };

      // ✅ ICE Candidates (importante para conexión)
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          console.log("[WebRTC] 🧊 ICE Candidate generado");
        } else {
          console.log("[WebRTC] 🧊 ICE gathering completado");
        }
      };

      // ✅ Crear oferta
      console.log("[WebRTC] 📝 Creando oferta SDP...");
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      console.log("[WebRTC] 📝 Oferta local establecida");

      // ⏱️ Esperar a que ICE gathering termine
      await new Promise((res) => {
        if (pc.iceGatheringState === "complete") {
          res();
        } else {
          pc.onicegatheringstatechange = () => {
            if (pc.iceGatheringState === "complete") {
              res();
            }
          };
        }
      });
      console.log("[WebRTC] 🧊 ICE gathering completado, enviando oferta al servidor...");

      // ✅ Enviar oferta al servidor
      const res = await fetch(VOICE_SERVER_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/sdp",
          "Accept": "application/sdp"
        },
        body: pc.localDescription.sdp,
      });

      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Servidor respondió ${res.status}: ${errorText}`);
      }

      const answerSdp = await res.text();
      console.log("[WebRTC] 📥 Respuesta SDP recibida del servidor");
      
      await pc.setRemoteDescription({
        type: "answer",
        sdp: answerSdp
      });
      console.log("[WebRTC] ✅ Respuesta remota establecida - conexión en proceso");

    } catch (err) {
      console.error("❌ [WebRTC] Error crítico:", err.message);
      clearTimeout(timeout);
      reject(err);
    }
  });
}
