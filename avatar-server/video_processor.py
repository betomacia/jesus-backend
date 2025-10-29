#!/usr/bin/env python3
"""
Video Processor - Procesa videos MP4 para avatar en tiempo real
Maneja videos de gestos y reposo para avatar ultra-realista
"""

import logging
import cv2
import numpy as np
from pathlib import Path
from typing import Dict, List, Optional, Tuple
import threading
from collections import deque

logger = logging.getLogger(__name__)


class VideoProcessor:
    """
    Procesa videos MP4 de avatar (gestos y reposo)
    Extrae frames y los prepara para streaming en tiempo real
    """

    def __init__(
        self,
        gesture_video_path: str,
        idle_video_path: str,
        target_fps: int = 25,
        target_size: Tuple[int, int] = (512, 512),
        cache_size: int = 300  # ~12 segundos a 25fps
    ):
        """
        Args:
            gesture_video_path: Path al video de gestos (cuando habla)
            idle_video_path: Path al video de reposo (estado neutral)
            target_fps: FPS objetivo para streaming
            target_size: Tamaño objetivo (width, height)
            cache_size: Número de frames a mantener en caché
        """
        self.gesture_video_path = gesture_video_path
        self.idle_video_path = idle_video_path
        self.target_fps = target_fps
        self.target_size = target_size
        self.cache_size = cache_size

        # Estado
        self.is_speaking = False
        self.current_mode = "idle"  # "idle" o "gesture"

        # Caché de frames
        self.gesture_frames: List[np.ndarray] = []
        self.idle_frames: List[np.ndarray] = []

        # Índices actuales
        self.gesture_index = 0
        self.idle_index = 0

        # Lock para thread-safety
        self.lock = threading.Lock()

        # Buffer circular para transiciones suaves
        self.frame_buffer = deque(maxlen=5)

        # Cargar y procesar videos
        self._load_videos()

        logger.info(
            f"VideoProcessor inicializado: "
            f"{len(self.gesture_frames)} frames de gestos, "
            f"{len(self.idle_frames)} frames de reposo"
        )

    def _load_videos(self):
        """Carga y procesa ambos videos"""
        try:
            # Cargar video de gestos
            if Path(self.gesture_video_path).exists():
                logger.info(f"Cargando video de gestos: {self.gesture_video_path}")
                self.gesture_frames = self._extract_frames(self.gesture_video_path)
                logger.info(f"Extraídos {len(self.gesture_frames)} frames de gestos")
            else:
                logger.warning(f"Video de gestos no encontrado: {self.gesture_video_path}")

            # Cargar video de reposo
            if Path(self.idle_video_path).exists():
                logger.info(f"Cargando video de reposo: {self.idle_video_path}")
                self.idle_frames = self._extract_frames(self.idle_video_path)
                logger.info(f"Extraídos {len(self.idle_frames)} frames de reposo")
            else:
                logger.warning(f"Video de reposo no encontrado: {self.idle_video_path}")

            # Validar que al menos uno está disponible
            if not self.gesture_frames and not self.idle_frames:
                raise ValueError("No se pudo cargar ningún video")

            # Si falta uno, usar el otro para ambos modos
            if not self.gesture_frames:
                logger.warning("Usando frames de reposo para gestos también")
                self.gesture_frames = self.idle_frames.copy()
            if not self.idle_frames:
                logger.warning("Usando frames de gestos para reposo también")
                self.idle_frames = self.gesture_frames.copy()

        except Exception as e:
            logger.error(f"Error cargando videos: {e}")
            raise

    def _extract_frames(self, video_path: str) -> List[np.ndarray]:
        """
        Extrae frames de un video y los procesa

        Args:
            video_path: Path al video MP4

        Returns:
            Lista de frames procesados (RGB)
        """
        frames = []

        try:
            cap = cv2.VideoCapture(video_path)

            if not cap.isOpened():
                raise ValueError(f"No se pudo abrir el video: {video_path}")

            # Obtener información del video
            original_fps = cap.get(cv2.CAP_PROP_FPS)
            total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
            duration = total_frames / original_fps if original_fps > 0 else 0

            logger.info(
                f"Video info: {total_frames} frames, "
                f"{original_fps:.2f} FPS, {duration:.2f}s"
            )

            # Calcular intervalo de muestreo para target_fps
            # Si el video es 30fps y queremos 25fps, tomamos cada 30/25 = 1.2 frames
            frame_interval = original_fps / self.target_fps if self.target_fps > 0 else 1.0

            frame_count = 0
            extracted_count = 0
            next_frame_to_extract = 0.0

            while True:
                ret, frame = cap.read()
                if not ret:
                    break

                # Extraer frame si corresponde según el intervalo
                if frame_count >= next_frame_to_extract:
                    # Procesar frame
                    processed = self._process_frame(frame)
                    frames.append(processed)

                    extracted_count += 1
                    next_frame_to_extract += frame_interval

                    # Limitar caché
                    if extracted_count >= self.cache_size:
                        logger.info(f"Alcanzado límite de caché: {self.cache_size} frames")
                        break

                frame_count += 1

            cap.release()

            logger.info(
                f"Extraídos {extracted_count} de {frame_count} frames "
                f"(intervalo: {frame_interval:.2f})"
            )

            if not frames:
                raise ValueError(f"No se extrajeron frames del video: {video_path}")

            return frames

        except Exception as e:
            logger.error(f"Error extrayendo frames: {e}")
            raise

    def _process_frame(self, frame: np.ndarray) -> np.ndarray:
        """
        Procesa un frame individual

        Args:
            frame: Frame BGR de OpenCV

        Returns:
            Frame procesado en RGB
        """
        # Convertir BGR a RGB
        frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)

        # Resize manteniendo aspect ratio
        h, w = frame_rgb.shape[:2]
        target_w, target_h = self.target_size

        # Calcular escala para mantener aspect ratio
        scale = min(target_w / w, target_h / h)
        new_w = int(w * scale)
        new_h = int(h * scale)

        # Resize
        resized = cv2.resize(frame_rgb, (new_w, new_h), interpolation=cv2.INTER_LANCZOS4)

        # Crear canvas con fondo negro
        canvas = np.zeros((target_h, target_w, 3), dtype=np.uint8)

        # Centrar imagen en canvas
        y_offset = (target_h - new_h) // 2
        x_offset = (target_w - new_w) // 2
        canvas[y_offset:y_offset + new_h, x_offset:x_offset + new_w] = resized

        return canvas

    def get_next_frame(self, is_speaking: bool = False) -> np.ndarray:
        """
        Obtiene el siguiente frame según el estado

        Args:
            is_speaking: True si el avatar está hablando, False si está en reposo

        Returns:
            Frame RGB como numpy array
        """
        with self.lock:
            # Actualizar estado
            self.is_speaking = is_speaking

            # Seleccionar conjunto de frames según estado
            if is_speaking:
                frames = self.gesture_frames
                current_index = self.gesture_index
            else:
                frames = self.idle_frames
                current_index = self.idle_index

            # Obtener frame actual
            frame = frames[current_index].copy()

            # Avanzar índice (loop)
            current_index = (current_index + 1) % len(frames)

            # Actualizar índice
            if is_speaking:
                self.gesture_index = current_index
            else:
                self.idle_index = current_index

            # Añadir a buffer para posibles transiciones
            self.frame_buffer.append(frame)

            return frame

    def get_frame_at_time(self, timestamp: float, is_speaking: bool = False) -> np.ndarray:
        """
        Obtiene frame en un timestamp específico (para sincronización precisa)

        Args:
            timestamp: Timestamp en segundos
            is_speaking: True si está hablando

        Returns:
            Frame correspondiente
        """
        with self.lock:
            frames = self.gesture_frames if is_speaking else self.idle_frames

            # Calcular índice según timestamp
            frame_index = int((timestamp * self.target_fps) % len(frames))

            return frames[frame_index].copy()

    def reset(self):
        """Reinicia los índices de frames"""
        with self.lock:
            self.gesture_index = 0
            self.idle_index = 0
            self.frame_buffer.clear()
            logger.info("VideoProcessor reseteado")

    def get_stats(self) -> Dict:
        """Retorna estadísticas del procesador"""
        return {
            "gesture_frames": len(self.gesture_frames),
            "idle_frames": len(self.idle_frames),
            "gesture_index": self.gesture_index,
            "idle_index": self.idle_index,
            "is_speaking": self.is_speaking,
            "target_fps": self.target_fps,
            "target_size": self.target_size,
        }


class VideoCache:
    """
    Caché inteligente de frames de video para múltiples sesiones
    Evita cargar el mismo video múltiples veces
    """

    def __init__(self):
        self.cache: Dict[str, VideoProcessor] = {}
        self.lock = threading.Lock()

    def get_processor(
        self,
        gesture_video: str,
        idle_video: str,
        **kwargs
    ) -> VideoProcessor:
        """
        Obtiene o crea un VideoProcessor

        Args:
            gesture_video: Path al video de gestos
            idle_video: Path al video de reposo
            **kwargs: Argumentos adicionales para VideoProcessor

        Returns:
            VideoProcessor (cacheado o nuevo)
        """
        # Crear key de caché
        cache_key = f"{gesture_video}::{idle_video}"

        with self.lock:
            if cache_key not in self.cache:
                logger.info(f"Creando nuevo VideoProcessor para: {cache_key}")
                processor = VideoProcessor(
                    gesture_video_path=gesture_video,
                    idle_video_path=idle_video,
                    **kwargs
                )
                self.cache[cache_key] = processor
            else:
                logger.info(f"Usando VideoProcessor cacheado: {cache_key}")

            return self.cache[cache_key]

    def clear(self):
        """Limpia toda la caché"""
        with self.lock:
            self.cache.clear()
            logger.info("VideoCache limpiada")

    def get_stats(self) -> Dict:
        """Retorna estadísticas de la caché"""
        with self.lock:
            return {
                "cached_processors": len(self.cache),
                "cache_keys": list(self.cache.keys()),
            }


# Instancia global de caché
video_cache = VideoCache()
