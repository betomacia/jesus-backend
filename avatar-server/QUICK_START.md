# 🚀 Quick Start - Despliegue Rápido en 5 Minutos

Guía ultra-rápida para desplegar tu avatar con videos MP4.

## ✅ Prerequisitos

- Servidor con GPU L4 (Google Cloud G2)
- Drivers NVIDIA instalados
- 2 videos MP4: gestos y reposo

## 📝 Paso 1: Preparar Videos (En tu Computadora Local)

```bash
# Instalar FFmpeg si no lo tienes
# Ubuntu/Debian: sudo apt install ffmpeg
# Mac: brew install ffmpeg
# Windows: Descargar de https://ffmpeg.org

# Convertir tu video de gestos (cuando habla)
ffmpeg -i tu_video_hablando.mp4 \
  -vf "scale=512:512:force_original_aspect_ratio=increase,crop=512:512" \
  -r 25 -c:v libx264 -crf 18 -an -t 20 \
  jesus_gestos.mp4

# Convertir tu video de reposo (quieto)
ffmpeg -i tu_video_quieto.mp4 \
  -vf "scale=512:512:force_original_aspect_ratio=increase,crop=512:512" \
  -r 25 -c:v libx264 -crf 18 -an -t 20 \
  jesus_reposo.mp4
```

## 🌐 Paso 2: Conectar a tu Servidor G2 L4

### Google Cloud:
```bash
gcloud compute ssh tu-instancia-g2 --zone=tu-zona
```

### AWS/Otro:
```bash
ssh -i tu-llave.pem usuario@ip-del-servidor
```

## 📦 Paso 3: Clonar e Instalar

```bash
# Clonar repositorio
cd /opt
sudo git clone https://github.com/betomacia/jesus-backend.git
cd jesus-backend
sudo git checkout claude/interactive-realtime-avatar-011CUbrYQx48bbE7ky9nktMQ

# Ejecutar instalación automática
cd avatar-server
sudo chmod +x install.sh
sudo ./install.sh

# Espera 5-10 minutos mientras se instalan todas las dependencias
```

## 📤 Paso 4: Subir tus Videos

### Desde tu computadora local:
```bash
# Copiar los videos al servidor
scp jesus_gestos.mp4 usuario@ip-servidor:/opt/avatar-server/videos/
scp jesus_reposo.mp4 usuario@ip-servidor:/opt/avatar-server/videos/

# O si es Google Cloud:
gcloud compute scp jesus_gestos.mp4 tu-instancia:/opt/avatar-server/videos/ --zone=tu-zona
gcloud compute scp jesus_reposo.mp4 tu-instancia:/opt/avatar-server/videos/ --zone=tu-zona
```

### O directamente en el servidor:
```bash
# Si tus videos ya están en el servidor
sudo mv /ruta/a/tus/videos/*.mp4 /opt/avatar-server/videos/
```

## ⚙️ Paso 5: Configurar

```bash
# Editar configuración
sudo nano /opt/avatar-server/.env
```

Añade tu API key de ElevenLabs (para TTS):
```bash
ELEVENLABS_API_KEY=tu_api_key_aqui
ELEVENLABS_VOICE_ID=tu_voice_id_aqui
```

Guarda (Ctrl+O, Enter, Ctrl+X)

## 🎬 Paso 6: Iniciar

```bash
# Iniciar el servidor de avatar
sudo systemctl start avatar-server
sudo systemctl enable avatar-server  # Arranque automático

# Verificar que está corriendo
sudo systemctl status avatar-server

# Ver logs en vivo
sudo journalctl -u avatar-server -f
```

## ✅ Paso 7: Probar

```bash
# Health check
curl http://localhost:8765/health | python3 -m json.tool

# Si responde con "status": "ok", ¡está funcionando!
```

## 🔗 Paso 8: Integrar con tu Backend Node.js

```bash
# Añadir ruta al backend
cd /home/ubuntu/jesus-backend

# Editar index.js para incluir la ruta de avatar
sudo nano index.js
```

Añade esta línea después de las otras rutas:
```javascript
import avatarRouter from "./routes/avatar.js";
app.use("/api/avatar", avatarRouter);
```

Reinicia el backend:
```bash
pm2 restart jesus-backend
```

## 🧪 Paso 9: Probar Todo el Sistema

```bash
# Crear una sesión de avatar
curl -X POST http://localhost:3100/api/avatar/streams \
  -H "Content-Type: application/json" \
  -d '{"video_id": "jesus_default"}' \
  | python3 -m json.tool

# Deberías ver un JSON con "id" y "offer"
```

## 🎉 ¡Listo!

Tu avatar está funcionando. Ahora puedes:

1. **Conectar desde tu app**: Usa la URL `http://tu-servidor-ip:3100/api/avatar/streams`
2. **Ver estadísticas**: `curl http://localhost:8765/status`
3. **Logs**: `sudo journalctl -u avatar-server -f`

## 🐛 Si algo falla...

### Videos no se encuentran:
```bash
sudo ls -la /opt/avatar-server/videos/
# Verifica que jesus_gestos.mp4 y jesus_reposo.mp4 existen
```

### Servidor no inicia:
```bash
sudo journalctl -u avatar-server -n 50
# Ver últimos 50 logs
```

### GPU no detectada:
```bash
nvidia-smi
# Debe mostrar tu GPU L4
```

### Puerto ocupado:
```bash
sudo lsof -i :8765
# Ver qué está usando el puerto
```

## 📊 Arquitectura Rápida

```
Cliente (App)
    ↓ HTTP/WebRTC
Backend Node.js (:3100/api/avatar/*)
    ↓ HTTP
Avatar Server Python (:8765)
    ↓ WebRTC
Videos MP4 → GPU L4 → Stream
```

## 💡 Tips

- **Latencia**: Con videos MP4 reales, latencia < 150ms
- **Sin IA**: Por defecto no usa modelos de IA (más rápido)
- **Memoria**: Cachea ~300 frames (~2GB RAM)
- **Escalado**: Un servidor L4 puede manejar ~10 sesiones simultáneas

## 📞 Soporte

Si encuentras problemas, revisa:
1. README.md - Documentación completa
2. Logs: `sudo journalctl -u avatar-server -f`
3. Estado GPU: `nvidia-smi`

---

**¡Tu avatar ultra-realista está listo en 5 minutos!** 🎬✨
