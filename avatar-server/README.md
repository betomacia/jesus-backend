# Avatar Server - Servidor de Avatares Interactivos Ultra-Realistas

Sistema de avatares interactivos en tiempo real con **videos MP4** reales, optimizado para GPU L4.

## 🎯 Características

- **Ultra-Realista**: Usa videos MP4 reales en lugar de generación sintética
- **Baja Latencia**: <150ms de extremo a extremo
- **Dos Estados**:
  - **Gestos**: Video cuando el avatar está hablando
  - **Reposo**: Video cuando el avatar está en silencio
- **WebRTC**: Streaming en tiempo real sin intermediarios
- **GPU Optimizado**: Diseñado específicamente para L4
- **Sin IA Requerida**: Por defecto usa solo los videos (opcional: procesamiento con IA)

## 📹 Preparando tus Videos MP4

### Requisitos de los Videos

Necesitas **DOS videos MP4**:

1. **Video de Gestos** (`jesus_gestos.mp4`):
   - El avatar hablando o haciendo gestos
   - Movimientos de boca, expresiones faciales
   - Duración: 10-30 segundos (se reproduce en loop)

2. **Video de Reposo** (`jesus_reposo.mp4`):
   - El avatar en estado neutral/tranquilo
   - Movimientos sutiles, respiración, parpadeo
   - Duración: 10-30 segundos (se reproduce en loop)

### Especificaciones Técnicas Recomendadas

```yaml
Resolución: 512x512 o 1024x1024 (cuadrado preferido)
FPS: 25-30 fps
Codec: H.264
Bitrate: 2-5 Mbps
Formato: MP4
Duración: 10-30 segundos
Audio: No necesario (se elimina automáticamente)
```

### Cómo Preparar los Videos

#### Opción 1: Con FFmpeg (Recomendado)

```bash
# Convertir y optimizar tu video de gestos
ffmpeg -i tu_video_gestos_original.mp4 \
  -vf "scale=512:512:force_original_aspect_ratio=increase,crop=512:512" \
  -r 25 \
  -c:v libx264 \
  -preset slow \
  -crf 18 \
  -an \
  -t 30 \
  jesus_gestos.mp4

# Convertir y optimizar tu video de reposo
ffmpeg -i tu_video_reposo_original.mp4 \
  -vf "scale=512:512:force_original_aspect_ratio=increase,crop=512:512" \
  -r 25 \
  -c:v libx264 \
  -preset slow \
  -crf 18 \
  -an \
  -t 30 \
  jesus_reposo.mp4
```

**Explicación de parámetros**:
- `scale=512:512`: Redimensiona a 512x512
- `-r 25`: 25 FPS
- `-preset slow`: Mejor calidad (usa `fast` si es muy lento)
- `-crf 18`: Calidad alta (18-23 es bueno, menor = mejor calidad)
- `-an`: Eliminar audio
- `-t 30`: Limitar a 30 segundos

#### Opción 2: Extraer de un Video Largo

Si tienes un video largo y quieres extraer segmentos:

```bash
# Extraer 20 segundos desde el minuto 1:30
ffmpeg -i video_largo.mp4 -ss 00:01:30 -t 20 \
  -vf "scale=512:512:force_original_aspect_ratio=increase,crop=512:512" \
  -r 25 -c:v libx264 -preset slow -crf 18 -an \
  jesus_gestos.mp4
```

#### Opción 3: Con Iluminación y Color Optimizado

```bash
# Con ajustes de color y estabilización
ffmpeg -i tu_video.mp4 \
  -vf "scale=512:512:force_original_aspect_ratio=increase,crop=512:512,\
       eq=brightness=0.05:contrast=1.1:saturation=1.1,\
       unsharp=5:5:1.0:5:5:0.0" \
  -r 25 -c:v libx264 -preset slow -crf 18 -an \
  jesus_gestos_optimizado.mp4
```

### Tips para Videos de Calidad

#### Video de Gestos:
- ✅ Movimientos naturales de boca
- ✅ Expresiones faciales variadas
- ✅ Contacto visual directo a cámara
- ✅ Iluminación frontal uniforme
- ❌ Evitar movimientos bruscos
- ❌ Evitar sombras fuertes

#### Video de Reposo:
- ✅ Expresión neutral/serena
- ✅ Movimientos muy sutiles
- ✅ Puede incluir parpadeo natural
- ✅ Ligeros movimientos de respiración
- ❌ No debe verse "congelado"
- ❌ Evitar movimientos de boca

## 📦 Instalación

### 1. Copiar Videos al Servidor

```bash
# Conectar a tu servidor
ssh usuario@tu-servidor

# Crear directorio de videos
sudo mkdir -p /opt/avatar-server/videos

# Copiar tus videos
# Desde tu computadora local:
scp jesus_gestos.mp4 usuario@tu-servidor:/opt/avatar-server/videos/
scp jesus_reposo.mp4 usuario@tu-servidor:/opt/avatar-server/videos/
```

### 2. Verificar Videos

```bash
# Verificar que los videos existen
ls -lh /opt/avatar-server/videos/

# Obtener información de los videos
ffmpeg -i /opt/avatar-server/videos/jesus_gestos.mp4
ffmpeg -i /opt/avatar-server/videos/jesus_reposo.mp4
```

### 3. Ejecutar Instalación Automática

```bash
cd /ruta/a/jesus-backend/avatar-server
chmod +x install.sh
sudo ./install.sh
```

## 🚀 Uso

### Iniciar el Servidor

```bash
# Con systemd (recomendado)
sudo systemctl start avatar-server
sudo systemctl enable avatar-server  # Inicio automático

# O manual
cd /opt/avatar-server
source venv/bin/activate
python3 server.py
```

### Crear Sesión de Avatar

```bash
# Usando los videos por defecto
curl -X POST http://localhost:8765/streams \
  -H "Content-Type: application/json" \
  -d '{
    "video_id": "jesus_default"
  }'

# O especificando videos personalizados
curl -X POST http://localhost:8765/streams \
  -H "Content-Type: application/json" \
  -d '{
    "gesture_video": "/opt/avatar-server/videos/jesus_gestos.mp4",
    "idle_video": "/opt/avatar-server/videos/jesus_reposo.mp4",
    "use_ai": false
  }'
```

### Verificar Estado

```bash
# Health check
curl http://localhost:8765/health | jq

# Estado completo
curl http://localhost:8765/status | jq
```

## 🔧 Integración con Backend

El backend en Node.js ya incluye los endpoints de integración en `routes/avatar.js`:

```javascript
// En tu aplicación cliente:
const response = await fetch('http://tu-servidor:3100/api/avatar/streams', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    portrait_id: 'jesus_default'  // Usa videos configurados
  })
});

const { id, session_id, offer } = await response.json();
// Continuar con WebRTC handshake...
```

## 📊 Estructura de Directorios

```
/opt/avatar-server/
├── server.py              # Servidor principal
├── video_processor.py     # Procesador de videos MP4
├── config.yaml           # Configuración
├── videos/               # TUS VIDEOS AQUÍ
│   ├── jesus_gestos.mp4
│   ├── jesus_reposo.mp4
│   └── ...otros videos...
├── models/               # Modelos de IA (opcional)
├── logs/                 # Logs del servidor
└── venv/                 # Entorno virtual Python
```

## ⚡ Optimización

### Para Mejor Calidad:
- Usa videos en 1024x1024 en lugar de 512x512
- Aumenta el bitrate a 5 Mbps
- Usa `-crf 15` en lugar de 18

### Para Menor Latencia:
- Reduce resolución a 256x256
- Aumenta FPS a 30
- Reduce duración a 10 segundos

### Para Menos Memoria:
- Reduce `cache_frames` en config.yaml
- Usa videos más cortos (10-15 seg)

## 🐛 Troubleshooting

### Videos no se encuentran:
```bash
# Verificar paths
ls -la /opt/avatar-server/videos/

# Ver logs
journalctl -u avatar-server -f
```

### Calidad baja:
```bash
# Re-encodear con mayor calidad
ffmpeg -i video_original.mp4 -crf 15 -preset slow video_mejorado.mp4
```

### Latencia alta:
```bash
# Verificar GPU
nvidia-smi

# Reducir resolución en config.yaml
# resolution: [256, 256]
```

## 📝 Notas

- **Sin IA**: Por defecto, el sistema solo reproduce tus videos MP4 reales. Es más rápido y ultra-realista.
- **Con IA (Opcional)**: Puedes habilitar `use_ai: true` para procesamiento adicional con LivePortrait, pero aumenta latencia.
- **Loops Suaves**: El sistema detecta automáticamente puntos de corte para loops suaves.
- **Caché**: Los frames se cachean en memoria para acceso instantáneo.

## 🎬 Ejemplo Completo

```bash
# 1. Preparar videos
ffmpeg -i mi_video_hablando.mp4 -vf "scale=512:512:force_original_aspect_ratio=increase,crop=512:512" -r 25 -c:v libx264 -crf 18 -an -t 20 jesus_gestos.mp4
ffmpeg -i mi_video_quieto.mp4 -vf "scale=512:512:force_original_aspect_ratio=increase,crop=512:512" -r 25 -c:v libx264 -crf 18 -an -t 20 jesus_reposo.mp4

# 2. Copiar al servidor
scp jesus_*.mp4 usuario@servidor:/opt/avatar-server/videos/

# 3. Iniciar servidor
ssh usuario@servidor
sudo systemctl start avatar-server

# 4. Probar
curl http://localhost:8765/health
```

¡Listo! Tu avatar ultra-realista con videos MP4 está funcionando. 🎉
