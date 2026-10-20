# MB Soundtools · MBTune

Autotune propio en tiempo real, 2 canales, sin DAW.
Funciona con cualquier tarjeta o mesa con entradas y salidas de audio
(Behringer Wing, X32, Midas, Focusrite, RME, MOTU, Universal Audio...).

## Opción A – Compilar en la nube (sin instalar nada)
1. Crea un repositorio en GitHub y sube todo el contenido de esta carpeta
   (incluida la carpeta oculta `.github`).
2. Pestaña **Actions** → "Compilar MBTune (exe + dmg)" → **Run workflow**.
3. En unos minutos descarga `MBTune-Windows` (.exe) y `MBTune-macOS` (.dmg)
   desde la sección *Artifacts*.

## Opción B – Compilar en tu ordenador
- Windows: instala Python 3.12 (marca "Add to PATH") y ejecuta `build_windows.bat`
  → `dist\MBTune.exe`
- Mac: instala Python 3.12 de python.org y ejecuta `bash build_mac.sh`
  → `dist/MBTune.dmg`

## Probar la interfaz sin compilar
Abre `assets/ui.html?demo` en el navegador (o ejecuta `python mbtune.py`
tras `pip install -r requirements.txt`).

## Canciones y modo directo
- Ajusta las voces, escribe el nombre de la canción y pulsa **Guardar canción**.
  Con el nombre vacío se actualiza la canción que tengas cargada.
- **Modo directo** muestra solo tus canciones en grande para cambiar entre ellas
  en el concierto (también con ← → o un pedal que envíe Re Pág / Av Pág).
  En este modo no se dibujan afinadores, así consume menos.

## Notas
- Windows 10/11 ya incluye WebView2, que es lo que dibuja la interfaz.
- Windows: usa el driver ASIO de tu tarjeta (lo da cada fabricante) y elige el
  mismo dispositivo ASIO en entrada y salida. Si no hay ASIO, sirve WASAPI.
- Mac: la tarjeta aparece directamente por CoreAudio. La primera vez abre
  la app con clic derecho → Abrir, y permite el acceso al micrófono.
- Windows puede mostrar el aviso "SmartScreen" porque la app no está firmada:
  "Más información" → "Ejecutar de todas formas".
