# MB Soundtools · MBMix

Control remoto de mesas digitales desde el iPad, al estilo de Mixing Station,
con la estética de MB Soundtools.

## Cómo funciona
Safari en el iPad no puede hablar directamente con la mesa, así que un pequeño
servidor (este programa) corre en un ordenador de la misma red: habla con la mesa
por OSC/UDP y sirve la interfaz táctil.

    iPad (Safari) ⇄ Wi-Fi ⇄ ordenador con MBMix ⇄ cable de red ⇄ Behringer WING Rack

## Arrancar
    python mbmix/mbmix.py            # abre la ventana (o el navegador) en este ordenador
    python mbmix/mbmix.py --server   # solo servidor (p. ej. en una Raspberry Pi)

No necesita librerías externas (pywebview es opcional, para la ventana).
En el iPad abre la dirección que muestra la app (p. ej. `http://192.168.1.20:8080`)
y en Safari: Compartir → «Añadir a pantalla de inicio» para usarla a pantalla completa.

## Qué incluye
- **Mesa**: tiras con nombre y color, mini EQ, indicadores de puerta/compresor, panorama,
  MUTE, SOLO, fader (arrastre relativo, doble toque = 0 dB) y vúmetro con pico.
  Main LR fijo a la derecha.
- **Vistas**: 1–16, 17–32, 33–40, Aux, Buses, Salidas (Main y matrices), DCA (+ grupos de mute) y «Mi vista».
- **Faders = envíos** (sends on fader): elige un bus y los faders controlan los envíos a ese bus
  (mezclas de monitores / in-ears).
- **Vista de canal** (toca el nombre): Entrada (ganancia, ajuste fino, 48V, quitar graves, fase),
  Puerta, Compresor (con curva), Ecualizador gráfico (graves, 4 medios, agudos: arrastra los puntos,
  pellizca con dos dedos para la anchura), Envíos a los 16 buses y Nombre/Color.
  Cada pantalla explica en una línea para qué sirve.
- **Mezclas guardadas**: guarda y recupera toda la mezcla.
- **Conexión**: búsqueda automática de la WING en la red o IP manual. Modo Demo sin mesa.
- **Ayuda** integrada (botón «Ayuda»).
- Varios iPads/ordenadores a la vez, sincronizados entre sí y con la propia mesa.

## Mesas
- Behringer WING Rack (también WING y WING Compact): OSC por UDP, puerto 2223.
  La ganancia y los 48V se ajustan en la entrada física que tenga asignada cada canal.
- Demo.

## Pendiente
- Vúmetros con la WING: la mesa no los envía por OSC (usa su protocolo nativo).
  Con la WING conectada los vúmetros se ocultan; funcionan en el modo Demo.
