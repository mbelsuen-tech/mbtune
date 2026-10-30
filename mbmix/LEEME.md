# MB Soundtools · MBMix

Control remoto de mesas digitales desde el iPad, al estilo de Mixing Station,
con la estética de MB Soundtools.

## Cómo funciona
Safari en el iPad no puede hablar directamente con la mesa, así que un pequeño
servidor (este programa) corre en un ordenador de la misma red: habla con la mesa
por OSC/UDP y sirve la interfaz táctil.

    iPad (Safari) ⇄ Wi-Fi ⇄ ordenador con MBMix ⇄ red ⇄ mesa (WING Rack, WING o XR18)

## Instalar
1. **En el ordenador** (el que va conectado a la mesa por cable o a su red):
   - Windows: descarga `MBMix.exe` (GitHub → Actions → «Compilar MBMix» → Artifacts) y ábrelo.
     Si sale «SmartScreen»: «Más información» → «Ejecutar de todas formas». Permite el acceso a la red.
   - Mac: abre `MBMix.dmg`, arrastra MBMix a Aplicaciones y ábrelo con clic derecho → Abrir.
     Permite «Red local» y las conexiones entrantes cuando lo pregunte.
2. **En el iPad** (mismo Wi-Fi que el ordenador):
   - Abre Safari y escribe la dirección que muestra MBMix en «Mesa» (ej. `http://192.168.1.20:8080`).
   - Compartir → «Añadir a pantalla de inicio». Desde entonces se abre a pantalla completa, como una app.

## Arrancar sin compilar
    python mbmix/mbmix.py            # abre la ventana (o el navegador) en este ordenador
    python mbmix/mbmix.py --server   # solo servidor (p. ej. en una Raspberry Pi)

No necesita librerías externas (pywebview es opcional, para la ventana).
En el iPad abre la dirección que muestra la app (p. ej. `http://192.168.1.20:8080`)
y en Safari: Compartir → «Añadir a pantalla de inicio» para usarla a pantalla completa.

## Qué incluye
- **Mesa**: tiras con nombre y color, mini EQ, indicadores de puerta/compresor, panorama,
  MUTE, SOLO, fader (arrastre relativo, doble toque = 0 dB) y vúmetro con pico.
  Main LR fijo a la derecha.
- **Vistas** según la mesa (WING: 1–16, 17–32, 33–40, Aux, Buses, Salidas, DCA · XR18: 1–16, Aux·FX,
  Buses, DCA), con grupos de mute y «Mi vista» personalizable.
- **Faders = envíos** (sends on fader): elige un bus y los faders controlan los envíos a ese bus
  (mezclas de monitores / in-ears).
- **Vista de canal** (toca el nombre): Entrada (ganancia, ajuste fino, 48V, quitar graves, fase),
  Puerta, Compresor (con curva), Ecualizador gráfico (graves, 4 medios, agudos: arrastra los puntos,
  pellizca con dos dedos para la anchura), Envíos a los 16 buses y Nombre/Color.
  Cada pantalla explica en una línea para qué sirve.
- **Mezclas guardadas**: guarda y recupera toda la mezcla; fila rápida para cargarlas con doble toque.
- **Grupos propios**: un fader que mueve varios canales a la vez manteniendo la mezcla entre ellos
  (en la mezcla principal y en cada monitor), con mute de grupo.
- **Canales enlazados** (1–2, 3–4…): fader, mute, envíos y procesado a la vez; ganancia y +48V separados.
- **Fila de monitores** para cambiar de mezcla de un toque, **envío a mains** por canal
  y **+48V con confirmación**.
- **Bloquear**: congela todos los controles durante el bolo.
- **Panel lateral**: el canal se abre a la derecha sin perder de vista los faders (o a pantalla completa).
- **Personalizar** (cada iPad a su gusto, como en Mixing Station): cuántos faders se ven (auto/8/12/16),
  qué se ve en cada tira (mini EQ, panorama, SOLO, escala, vúmetro), nombres grandes,
  doble toque a 0 dB, modo fino, color de acento y tema (automático, oscuro o claro).
- **Mis capas**: varias capas con nombre propio («Batería», «Voces», «Mi monitor»…), con canales y grupos.
- **Modo músico**: el iPad solo controla una mezcla de monitor (sus envíos), sin tocar la mezcla
  principal, el procesado ni la conexión.
- **Ajustes**: Mi vista, Grupos, Canales enlazados, Pantalla (mantener encendida, pantalla completa),
  Ayuda y Datos. Vista, grupos y enlaces se comparten entre todos los iPads.
- **Conexión**: eliges WING Rack, WING o XR18; búsqueda automática en la red o IP manual.
  Interruptor «Probar sin mesa» para practicar con cualquiera de ellas.
- **Ayuda** integrada (botón «Ayuda»).
- Varios iPads/ordenadores a la vez, sincronizados entre sí y con la propia mesa.

## Mesas
- **Behringer WING Rack, WING y WING Compact**: OSC por UDP, puerto 2223.
  40 canales, 8 aux, 16 buses, 4 main, 8 matrices, 16 DCA, 8 grupos de mute.
  La ganancia y los 48V se ajustan en la entrada física que tenga asignada cada canal.
- **Behringer XR18** (y X Air XR16/XR12, Midas MR18): OSC por UDP, puerto 10024.
  16 canales, aux 17-18, 4 retornos FX, 6 buses, 4 envíos FX, L/R, 4 DCA, 4 grupos de mute,
  ecualizador con tipo de filtro por banda y vúmetros.

## Pendiente
- Vúmetros con la WING: la mesa no los envía por OSC (usa su protocolo nativo).
  Con la WING conectada los vúmetros se ocultan; con la XR18 y en el modo demo funcionan.
