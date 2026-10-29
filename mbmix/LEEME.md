# MB Soundtools · MBMix

Control remoto de mesas digitales desde el iPad, al estilo de Mixing Station,
con la estética de MB Soundtools.

## Cómo funciona
Safari en el iPad no puede hablar directamente con la mesa, así que un pequeño
servidor (este programa) corre en un ordenador de la misma red: habla con la mesa
por OSC/UDP y sirve la interfaz táctil.

    iPad (Safari) ⇄ Wi-Fi ⇄ ordenador con MBMix ⇄ red ⇄ mesa (X32 / M32)

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
- **Capas**: 1–16, 17–32, Aux·FX, Buses, Matrices·Main, DCA (+ grupos de mute) y «Mi capa» personalizable.
- **Faders = envíos** (sends on fader): elige un bus y los faders controlan los envíos a ese bus
  (mezclas de monitores / in-ears).
- **Vista de canal** (toca el nombre): Entrada (ganancia, 48V, fase, corte de graves),
  Puerta, Compresor (con curva y GR), EQ paramétrico gráfico (arrastra los puntos,
  pellizca con dos dedos para el Q), Envíos a los 16 buses y Nombre/Color.
- **Escenas**: guarda y recupera toda la mezcla.
- **Conexión**: búsqueda automática de mesas X32/M32 en la red o IP manual. Modo Demo sin mesa.
- Varios iPads/ordenadores a la vez, sincronizados entre sí y con la propia mesa.

## Mesas
- Behringer X32 (todas las versiones) y Midas M32: protocolo OSC, puerto 10023.
- Demo.
