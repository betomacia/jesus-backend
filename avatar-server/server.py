#!/usr/bin/env python3
"""
Avatar Server - Servidor de avatares interactivos en tiempo real
Ultra-realista con baja latencia para GPU L4
"""

import asyncio
import json
import logging
import os
import uuid
from datetime import datetime
from pathlib import Path
from typing import Dict, Optional

import cv2
import numpy as np
import torch
from aiohttp import web
from aiortc import RTCPeerConnection, RTCSessionDescription, VideoStreamTrack
from aiortc.contrib.media import MediaPlayer, MediaRelay
from av import VideoFrame

# Importar procesador de video
from video_processor import VideoProcessor, video_cache

# Configuración de logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Configuración
PORT = int(os.getenv("AVATAR_PORT", "8765"))
HOST = os.getenv("AVATAR_HOST", "0.0.0.0")
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

# Almacenamiento de sesiones activas
sessions: Dict[str, dict] = {}
relay = MediaRelay()


class AvatarVideoTrack(VideoStreamTrack):
    """
    Track de video personalizado para streaming de avatar en tiempo real
    Procesa frames con el modelo de avatar y los transmite vía WebRTC
    """

    kind = "video"

    def __init__(self, video_processor, ai_processor=None):
        super().__init__()
        self.video_processor = video_processor
        self.ai_processor = ai_processor
        self.counter = 0
        self.fps = 25  # FPS objetivo para baja latencia
        self._timestamp = 0
        self._start = None

        # Estado del avatar
        self.is_speaking = False
        self.last_audio_time = 0

        # Queue para audio que controla la animación
        self.audio_queue = asyncio.Queue(maxsize=10)

        # Obtener primer frame
        self.current_frame = self.video_processor.get_next_frame(is_speaking=False)

        logger.info(f"AvatarVideoTrack inicializado con video processor")

    async def recv(self):
        """Genera y retorna el siguiente frame de video"""
        pts, time_base = await self.next_timestamp()

        try:
            # Verificar si hay audio reciente (últimos 500ms = hablando)
            import time
            current_time = time.time()
            self.is_speaking = (current_time - self.last_audio_time) < 0.5

            # Intentar obtener audio features del queue (non-blocking)
            try:
                audio_features = self.audio_queue.get_nowait()
                self.last_audio_time = current_time
                self.is_speaking = True

                # Si hay AI processor, procesar frame con el modelo
                if self.ai_processor:
                    self.current_frame = await self._process_frame(audio_features)
                else:
                    # Sin AI: solo usar frames del video según estado
                    self.current_frame = self.video_processor.get_next_frame(
                        is_speaking=True
                    )
            except asyncio.QueueEmpty:
                # Sin audio: usar frames de reposo
                self.current_frame = self.video_processor.get_next_frame(
                    is_speaking=self.is_speaking
                )

            # Convertir a VideoFrame
            frame = VideoFrame.from_ndarray(self.current_frame, format="rgb24")
            frame.pts = pts
            frame.time_base = time_base

            self.counter += 1
            return frame

        except Exception as e:
            logger.error(f"Error generando frame: {e}")
            # Retornar frame de fallback
            fallback_frame = self.video_processor.get_next_frame(is_speaking=False)
            frame = VideoFrame.from_ndarray(fallback_frame, format="rgb24")
            frame.pts = pts
            frame.time_base = time_base
            return frame

    async def _process_frame(self, audio_features: dict) -> np.ndarray:
        """
        Procesa el frame con el modelo de IA basado en características de audio
        """
        if self.ai_processor is None:
            # Sin AI: usar frames del video
            return self.video_processor.get_next_frame(is_speaking=True)

        try:
            # Obtener frame base del video
            base_frame = self.video_processor.get_next_frame(is_speaking=True)

            # Ejecutar inferencia en GPU (si hay modelo de IA)
            loop = asyncio.get_event_loop()
            frame = await loop.run_in_executor(
                None,
                self.ai_processor.process_frame,
                base_frame,
                audio_features
            )
            return frame
        except Exception as e:
            logger.error(f"Error en procesamiento de frame: {e}")
            return self.video_processor.get_next_frame(is_speaking=True)

    async def add_audio(self, audio_data: bytes):
        """Añade datos de audio para procesamiento"""
        try:
            # Extraer features del audio (mel-spectrogram, etc)
            audio_features = self._extract_audio_features(audio_data)
            await self.audio_queue.put(audio_features)
        except asyncio.QueueFull:
            logger.warning("Audio queue llena, descartando frame")

    def _extract_audio_features(self, audio_data: bytes) -> dict:
        """Extrae características del audio para lip-sync"""
        # Aquí irá la extracción real de features
        # Por ahora retorna un placeholder
        return {
            "timestamp": datetime.now().timestamp(),
            "data": audio_data
        }


class AvatarProcessor:
    """
    Procesador de avatar que utiliza modelos de IA para generar
    avatares ultra-realistas con sincronización labial
    """

    def __init__(self, model_type: str = "liveportrait"):
        self.model_type = model_type
        self.device = DEVICE
        self.model = None

        logger.info(f"Inicializando AvatarProcessor con modelo: {model_type} en {self.device}")

        # Cargar modelo según el tipo
        self._load_model()

    def _load_model(self):
        """Carga el modelo de avatar en GPU"""
        try:
            if self.model_type == "liveportrait":
                # LivePortrait es el estado del arte para avatares realistas
                logger.info("Cargando modelo LivePortrait...")
                # Aquí se cargará el modelo real
                # from liveportrait import LivePortrait
                # self.model = LivePortrait(device=self.device)

            elif self.model_type == "sadtalker":
                # SadTalker es otra excelente opción
                logger.info("Cargando modelo SadTalker...")
                # from sadtalker import SadTalker
                # self.model = SadTalker(device=self.device)

            elif self.model_type == "wav2lip":
                # Wav2Lip para lip-sync básico
                logger.info("Cargando modelo Wav2Lip...")
                # from wav2lip import Wav2Lip
                # self.model = Wav2Lip(device=self.device)

            # Warm-up del modelo
            if self.model is not None:
                logger.info("Realizando warm-up del modelo...")
                # Ejecutar inferencia dummy para optimizar CUDA

            logger.info("Modelo cargado exitosamente")

        except Exception as e:
            logger.error(f"Error cargando modelo: {e}")
            logger.warning("Modo fallback: sin procesamiento de IA")
            self.model = None

    def process_frame(self, portrait: np.ndarray, audio_features: dict) -> np.ndarray:
        """
        Procesa un frame con el modelo de avatar

        Args:
            portrait: Imagen base del avatar (RGB)
            audio_features: Características extraídas del audio

        Returns:
            Frame procesado con animación
        """
        if self.model is None:
            # Fallback: retornar portrait sin modificar
            return portrait

        try:
            with torch.no_grad():
                # Preparar inputs para el modelo
                # portrait_tensor = torch.from_numpy(portrait).to(self.device)

                # Inferencia del modelo
                # output = self.model(portrait_tensor, audio_features)

                # Convertir output a numpy
                # result = output.cpu().numpy()

                # Por ahora retorna el portrait base
                return portrait

        except Exception as e:
            logger.error(f"Error en inferencia del modelo: {e}")
            return portrait


# Instancia global del procesador
avatar_processor = AvatarProcessor(
    model_type=os.getenv("AVATAR_MODEL", "liveportrait")
)


async def create_stream(request):
    """
    POST /streams
    Crea una nueva sesión de streaming de avatar

    Body: {
        "video_id": "jesus_default",  // ID del conjunto de videos pre-configurado
        "gesture_video": "/path/to/gestos.mp4",  // Path al video de gestos
        "idle_video": "/path/to/reposo.mp4",  // Path al video de reposo
        "use_ai": false  // Si usar modelo de IA (opcional, por defecto false)
    }

    Returns: {
        "id": "sess_xxx",
        "offer": {...}  // SDP offer para WebRTC
    }
    """
    try:
        data = await request.json()
        video_id = data.get("video_id", "")
        gesture_video = data.get("gesture_video", "")
        idle_video = data.get("idle_video", "")
        use_ai = data.get("use_ai", False)

        # Determinar paths de los videos
        if video_id:
            # Usar ID pre-configurado
            gesture_video = f"./videos/{video_id}_gestos.mp4"
            idle_video = f"./videos/{video_id}_reposo.mp4"
        elif not gesture_video or not idle_video:
            # Usar videos por defecto
            gesture_video = "./videos/jesus_gestos.mp4"
            idle_video = "./videos/jesus_reposo.mp4"

        # Verificar que existen los videos
        if not Path(gesture_video).exists():
            return web.json_response(
                {"error": "gesture_video_not_found", "path": gesture_video},
                status=400
            )
        if not Path(idle_video).exists():
            return web.json_response(
                {"error": "idle_video_not_found", "path": idle_video},
                status=400
            )

        # Crear ID de sesión
        session_id = f"sess_{uuid.uuid4().hex[:24]}"

        # Obtener o crear VideoProcessor (cacheado)
        video_processor = video_cache.get_processor(
            gesture_video=gesture_video,
            idle_video=idle_video,
            target_fps=25,
            target_size=(512, 512)
        )

        # Crear peer connection
        pc = RTCPeerConnection()

        # Decidir si usar AI processor
        ai_proc = avatar_processor if use_ai else None

        # Crear track de video del avatar
        video_track = AvatarVideoTrack(video_processor, ai_proc)
        pc.addTrack(video_track)

        # Manejar track de audio entrante (para lip-sync)
        @pc.on("track")
        async def on_track(track):
            logger.info(f"Track recibido: {track.kind}")
            if track.kind == "audio":
                # Procesar audio para lip-sync
                while True:
                    try:
                        frame = await track.recv()
                        # Extraer datos y enviar al video track
                        await video_track.add_audio(frame.to_ndarray().tobytes())
                    except Exception as e:
                        logger.error(f"Error procesando audio: {e}")
                        break

        @pc.on("connectionstatechange")
        async def on_connectionstatechange():
            logger.info(f"Connection state: {pc.connectionState}")
            if pc.connectionState == "failed" or pc.connectionState == "closed":
                await cleanup_session(session_id)

        # Crear offer
        offer = await pc.createOffer()
        await pc.setLocalDescription(offer)

        # Guardar sesión
        sessions[session_id] = {
            "id": session_id,
            "pc": pc,
            "video_track": video_track,
            "video_processor": video_processor,
            "gesture_video": gesture_video,
            "idle_video": idle_video,
            "use_ai": use_ai,
            "created_at": datetime.now().isoformat(),
            "state": "created"
        }

        logger.info(f"Stream creado: {session_id}")

        return web.json_response({
            "id": session_id,
            "session_id": session_id,
            "offer": {
                "type": offer.type,
                "sdp": offer.sdp
            }
        })

    except Exception as e:
        logger.error(f"Error creando stream: {e}", exc_info=True)
        return web.json_response(
            {"error": "stream_creation_failed", "detail": str(e)},
            status=500
        )


async def handle_sdp_answer(request):
    """
    POST /streams/{id}/sdp
    Maneja el SDP answer del cliente

    Body: {
        "answer": {...},
        "session_id": "sess_xxx"
    }
    """
    try:
        session_id = request.match_info["id"]
        data = await request.json()
        answer = data.get("answer", {})

        session = sessions.get(session_id)
        if not session:
            return web.json_response(
                {"error": "session_not_found"},
                status=404
            )

        pc = session["pc"]

        # Configurar remote description
        await pc.setRemoteDescription(
            RTCSessionDescription(
                sdp=answer["sdp"],
                type=answer["type"]
            )
        )

        session["state"] = "connected"
        logger.info(f"SDP answer procesado para sesión: {session_id}")

        return web.json_response({"status": "ok"})

    except Exception as e:
        logger.error(f"Error procesando SDP answer: {e}", exc_info=True)
        return web.json_response(
            {"error": "sdp_processing_failed", "detail": str(e)},
            status=500
        )


async def handle_ice_candidate(request):
    """
    POST /streams/{id}/ice
    Maneja ICE candidates del cliente

    Body: {
        "candidate": "...",
        "sdpMid": "...",
        "sdpMLineIndex": 0
    }
    """
    try:
        session_id = request.match_info["id"]
        data = await request.json()

        session = sessions.get(session_id)
        if not session:
            return web.json_response(
                {"error": "session_not_found"},
                status=404
            )

        # Por ahora ICE trickle no es necesario con aiortc
        # pero lo mantenemos para compatibilidad con D-ID API

        logger.info(f"ICE candidate recibido para sesión: {session_id}")
        return web.json_response({"status": "ok"})

    except Exception as e:
        logger.error(f"Error procesando ICE: {e}", exc_info=True)
        return web.json_response(
            {"error": "ice_processing_failed", "detail": str(e)},
            status=500
        )


async def handle_talk(request):
    """
    POST /streams/{id}/talk
    Envía texto para que el avatar hable (con TTS externo)

    Body: {
        "script": {
            "type": "audio",
            "audio_url": "https://..."
        }
        o
        "script": {
            "type": "text",
            "input": "Hola, ¿cómo estás?",
            "provider": {...}
        }
    }
    """
    try:
        session_id = request.match_info["id"]
        data = await request.json()
        script = data.get("script", {})

        session = sessions.get(session_id)
        if not session:
            return web.json_response(
                {"error": "session_not_found"},
                status=404
            )

        video_track = session["video_track"]

        # Procesar según el tipo
        if script.get("type") == "audio":
            # Audio directo
            audio_url = script.get("audio_url", "")
            # TODO: Descargar y procesar audio
            logger.info(f"Talk con audio URL: {audio_url}")

        elif script.get("type") == "text":
            # Texto que requiere TTS
            text = script.get("input", "")
            # TODO: Llamar a ElevenLabs u otro TTS
            logger.info(f"Talk con texto: {text}")

        return web.json_response({"status": "ok"})

    except Exception as e:
        logger.error(f"Error en talk: {e}", exc_info=True)
        return web.json_response(
            {"error": "talk_failed", "detail": str(e)},
            status=500
        )


async def delete_stream(request):
    """
    DELETE /streams/{id}
    Cierra y elimina una sesión de streaming
    """
    try:
        session_id = request.match_info["id"]

        await cleanup_session(session_id)

        logger.info(f"Stream eliminado: {session_id}")
        return web.json_response({"status": "ok"})

    except Exception as e:
        logger.error(f"Error eliminando stream: {e}", exc_info=True)
        return web.json_response(
            {"error": "delete_failed", "detail": str(e)},
            status=500
        )


async def cleanup_session(session_id: str):
    """Limpia una sesión y libera recursos"""
    session = sessions.get(session_id)
    if session:
        try:
            pc = session.get("pc")
            if pc:
                await pc.close()
            video_track = session.get("video_track")
            if video_track:
                video_track.stop()
        except Exception as e:
            logger.error(f"Error limpiando sesión {session_id}: {e}")
        finally:
            del sessions[session_id]


async def health_check(request):
    """GET /health - Health check del servidor"""
    return web.json_response({
        "status": "ok",
        "device": DEVICE,
        "cuda_available": torch.cuda.is_available(),
        "active_sessions": len(sessions),
        "model_loaded": avatar_processor.model is not None
    })


async def get_status(request):
    """GET /status - Estado detallado del servidor"""
    gpu_info = {}
    if torch.cuda.is_available():
        gpu_info = {
            "name": torch.cuda.get_device_name(0),
            "memory_allocated": torch.cuda.memory_allocated(0) / 1024**3,
            "memory_reserved": torch.cuda.memory_reserved(0) / 1024**3,
            "memory_total": torch.cuda.get_device_properties(0).total_memory / 1024**3
        }

    return web.json_response({
        "status": "running",
        "device": DEVICE,
        "gpu_info": gpu_info,
        "active_sessions": len(sessions),
        "sessions": [
            {
                "id": sid,
                "state": s["state"],
                "created_at": s["created_at"]
            }
            for sid, s in sessions.items()
        ]
    })


async def on_startup(app):
    """Callback de inicio de la aplicación"""
    logger.info(f"Avatar Server iniciando en {HOST}:{PORT}")
    logger.info(f"Device: {DEVICE}")
    if torch.cuda.is_available():
        logger.info(f"GPU: {torch.cuda.get_device_name(0)}")
        logger.info(f"CUDA Version: {torch.version.cuda}")


async def on_cleanup(app):
    """Callback de limpieza de la aplicación"""
    logger.info("Limpiando sesiones activas...")
    for session_id in list(sessions.keys()):
        await cleanup_session(session_id)
    logger.info("Avatar Server detenido")


def create_app():
    """Crea y configura la aplicación web"""
    app = web.Application()

    # Configurar CORS
    @web.middleware
    async def cors_middleware(request, handler):
        if request.method == "OPTIONS":
            return web.Response(
                headers={
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
                    "Access-Control-Allow-Headers": "Content-Type, Authorization",
                }
            )
        response = await handler(request)
        response.headers["Access-Control-Allow-Origin"] = "*"
        return response

    app.middlewares.append(cors_middleware)

    # Rutas
    app.router.add_post("/streams", create_stream)
    app.router.add_post("/streams/{id}/sdp", handle_sdp_answer)
    app.router.add_post("/streams/{id}/ice", handle_ice_candidate)
    app.router.add_post("/streams/{id}/talk", handle_talk)
    app.router.add_delete("/streams/{id}", delete_stream)
    app.router.add_get("/health", health_check)
    app.router.add_get("/status", get_status)

    # Callbacks
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)

    return app


if __name__ == "__main__":
    app = create_app()
    web.run_app(app, host=HOST, port=PORT)
