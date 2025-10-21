import wrtc from "wrtc";
import fetch from "node-fetch";

const VOICE_SERVER_URL = "http://10.128.0.40:8000/webrtc/tts";
const TIMEOUT_MS = 60000; // 60 segundos

/**
 * Envía texto al servidor de voz usando WebRTC DataChannel
 * CON TIMING CORRECTO y manejo de errores mejorado
 */
export async function sendTextViaWebRTC(text, lang = "es", sessionId = "default") {
  return new Promise(async (resolve, reject) => {
    let pc = null;
    let timeoutId = null;
    let resolved = false;

    const cleanup = (reason = "unknown") => {
      if (resolved) return;
      resolved = true;
      console.log(`[WebRTC] 🧹 Limpiando recursos (${reason})`);
      if (timeoutId) clearTimeout(timeoutId);
      if (pc) {
        try {
          pc.close();
        } catch (e) {
          // ignorar errores al cerrar
        }
      }
    };

    try {
      console.log("──────────────────────────────────────────────");
      console.log(`🎙️ [WebRTC] Iniciando envío al servidor de voz`);
      console.log(`🌐 Destino: ${VOICE_SERVER_URL}`);
      console.log(`🗣️ Idioma: ${lang} | Session: ${sessionId}`);
      console.log(`💬 Texto (${text.length} caracteres):`);
      console.log(text.substring(0, 200) + (text.length > 200 ? "..." : ""));
      console.log("──────────────────────────────────────────────");

      pc = new wrtc.RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
      });

      // ✅ Timeout más largo
      timeoutId = setTimeout(() => {
        console.warn(`[WebRTC] ⏱️ Timeout (${TIMEOUT_MS/1000}s) - resolviendo de todas formas`);
        cleanup("timeout");
        resolve({ success: false, error: "timeout", sessionId });
      }, TIMEOUT_MS);

      let dataChannel = null;

      // ✅ Crear DataChannel
      dataChannel = pc.createDataChannel("tts", {
        ordered: true,
        maxRetransmits: 3
      });

      // ✅ Esperar a que el canal esté realmente abierto
      dataChannel.onopen = () => {
        console.log(`[WebRTC] 📡 Canal DataChannel ABIERTO`);
        
        // ⏱️ PEQUEÑO DELAY para asegurar que el servidor esté listo
        setTimeout(() => {
          if (dataChannel && dataChannel.readyState === "open") {
            const payload = { text, lang, route: "audio_on", sessionId };
            console.log(`[WebRTC] 📤 ENVIANDO payload (${JSON.stringify(payload).length} bytes)`);
            try {
              dataChannel.send(JSON.stringify(payload));
              console.log(`[WebRTC] ✅ Mensaje enviado exitosamente`);
            } catch (e) {
              console.error(`[WebRTC] ❌ Error enviando mensaje:`, e.message);
            }
          } else {
            console.error(`[WebRTC] ❌ Canal no está abierto: ${dataChannel?.readyState}`);
          }
        }, 100);
      };

      dataChannel.onerror = (error) => {
        console.error("[WebRTC] ❌ Error en DataChannel:", error);
        cleanup("datachannel-error");
        reject(error);
      };

      dataChannel.onclose = () => {
        console.log("[WebRTC] 🔒 DataChannel cerrado");
      };

      dataChannel.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          
          if (msg.event === "audio_chunk") {
            console.log(`[WebRTC] 🎧 Chunk de audio (${msg.audio?.length || 0} bytes)`);
          } else if (msg.event === "done") {
            console.log("[WebRTC] ✅ Servidor completó transmisión");
            cleanup("done");
            resolve({ success: true, sessionId });
          } else if (msg.event === "error") {
            console.error("[WebRTC] ❌ Error del servidor:", msg.message);
            cleanup("server-error");
            resolve({ success: false, error: msg.message, sessionId });
          } else {
            console.log(`[WebRTC] 📨 Mensaje recibido:`, msg.event || "unknown");
          }
        } catch (err) {
          console.error("[WebRTC] ⚠️ Error parseando mensaje:", err);
        }
      };

      // ✅ Manejar cambios de estado de conexión
      pc.onconnectionstatechange = () => {
        console.log(`[WebRTC] 🔄 Estado de conexión: ${pc.connectionState}`);
        if (pc.connectionState === "failed") {
          cleanup("connection-failed");
          resolve({ success: false, error: "connection failed", sessionId });
        }
      };

      // ✅ ICE Candidates
      let iceCount = 0;
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          iceCount++;
          if (iceCount <= 3) {
            console.log("[WebRTC] 🧊 ICE Candidate generado");
          }
        } else {
          console.log("[WebRTC] 🧊 ICE gathering completado");
        }
      };

      // ✅ Crear oferta
      console.log("[WebRTC] 📝 Creando oferta SDP...");
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      console.log("[WebRTC] 📝 Oferta local establecida");

      // ⏱️ Esperar a que ICE gathering termine (máximo 5s)
      await Promise.race([
        new Promise((res) => {
          if (pc.iceGatheringState === "complete") {
            res();
          } else {
            pc.onicegatheringstatechange = () => {
              if (pc.iceGatheringState === "complete") {
                res();
              }
            };
          }
        }),
        new Promise((res) => setTimeout(res, 5000)) // timeout de 5s para ICE
      ]);
      console.log("[WebRTC] 🧊 ICE gathering completado, enviando oferta al servidor...");

      // ✅ Verificar que pc aún existe antes de enviar
      if (!pc || !pc.localDescription) {
        throw new Error("PeerConnection cerrada prematuramente");
      }

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
      
      // ✅ Verificar que pc aún existe antes de setRemoteDescription
      if (!pc) {
        throw new Error("PeerConnection cerrada antes de setRemoteDescription");
      }

      await pc.setRemoteDescription({
        type: "answer",
        sdp: answerSdp
      });
      console.log("[WebRTC] ✅ Respuesta remota establecida - conexión en proceso");

    } catch (err) {
      console.error("❌ [WebRTC] Error crítico:", err.message);
      cleanup("exception");
      resolve({ success: false, error: err.message, sessionId });
    }
  });
}
