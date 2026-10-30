#!/usr/bin/env python3
"""
MB Soundtools · MBMix - Control remoto de mesas digitales (estilo Mixing Station).

Un pequeño servidor en tu ordenador habla con la mesa por la red (OSC/UDP)
y sirve la interfaz táctil: ábrela en el iPad con Safari en la dirección que
muestra la app (mismo Wi-Fi), o en la ventana del propio ordenador.

Mesas:  Behringer WING Rack, WING y WING Compact  ·  Behringer XR18 (X Air)  ·  Demo (sin mesa)

Requisitos:  Python 3.9+  (sin librerías externas; pywebview es opcional)
Ejecutar:    python mbmix.py            -> abre ventana / navegador
             python mbmix.py --server   -> solo servidor (p. ej. en una Raspberry)
"""
import os
import sys
import json
import math
import time
import base64
import random
import socket
import struct
import asyncio
import hashlib
import threading
import mimetypes
from pathlib import Path

PORT = int(os.environ.get("MBMIX_PORT", "8080"))
CONFIG_PATH = Path.home() / ".mbmix.json"
WEB_DIR = os.path.join(getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__))), "web")
WING_OSC_PORT = 2223       # OSC de la WING
WING_INFO_PORT = 2222      # descubrimiento ("WING?")
XAIR_PORT = 10024          # OSC de la XR18 / X Air


# ---------------------------------------------------------------- OSC ----
def _pad(b):
    return b + b"\0" * (4 - len(b) % 4)


def osc_encode(addr, *args):
    tags, data = ",", b""
    for a in args:
        if isinstance(a, bool) or isinstance(a, int):
            tags += "i"
            data += struct.pack(">i", int(a))
        elif isinstance(a, float):
            tags += "f"
            data += struct.pack(">f", a)
        elif isinstance(a, bytes):
            tags += "b"
            data += struct.pack(">i", len(a)) + a + b"\0" * (-len(a) % 4)
        else:
            tags += "s"
            data += _pad(str(a).encode("utf-8"))
    return _pad(addr.encode()) + _pad(tags.encode()) + data


def osc_decode(pkt):
    """Devuelve (dirección, [argumentos]) o None si el paquete no se entiende."""
    try:
        end = pkt.index(b"\0")
        addr = pkt[:end].decode("utf-8", "replace")
        i = (end + 4) & ~3
        if i >= len(pkt) or pkt[i:i + 1] != b",":
            return addr, []
        end = pkt.index(b"\0", i)
        tags = pkt[i + 1:end].decode()
        i = (end + 4) & ~3
        args = []
        for t in tags:
            if t == "i":
                args.append(struct.unpack(">i", pkt[i:i + 4])[0]); i += 4
            elif t == "f":
                args.append(struct.unpack(">f", pkt[i:i + 4])[0]); i += 4
            elif t == "s":
                end = pkt.index(b"\0", i)
                args.append(pkt[i:end].decode("utf-8", "replace")); i = (end + 4) & ~3
            elif t == "b":
                n = struct.unpack(">i", pkt[i:i + 4])[0]
                args.append(pkt[i + 4:i + 4 + n]); i += 4 + n + (-n % 4)
        return addr, args
    except (ValueError, struct.error, UnicodeDecodeError):
        return None


# ----------------------------------------------------------- MODELOS ----
# La interfaz trabaja siempre con claves propias ("ch1.fader", "bus3.eq.2.g"...) en
# unidades reales (dB, Hz, ms). Cada modelo de mesa dice dónde está cada parámetro
# en su protocolo y cómo convertir el valor.
#   spec = [tipo, mín, máx, curva, defecto(, lista)]
#   tipo: n (número), b (sí/no), s (texto), i (entero)   curva: lin, log, log1, fdr, enum

def x32_fader_pos(db):
    """Ley de fader de Behringer (X32 / X Air): dB -> posición 0..1."""
    if db >= -10:
        return (db + 30) / 40
    if db >= -30:
        return (db + 50) / 80
    if db >= -60:
        return (db + 70) / 160
    if db > -90:
        return (db + 90) / 480
    return 0.0


def x32_fader_db(f):
    if f >= 0.5:
        return f * 40 - 30
    if f >= 0.25:
        return f * 80 - 50
    if f >= 0.0625:
        return f * 160 - 70
    return f * 480 - 90 if f > 0 else -144.0


def conv_lin(lo, hi):
    return (lambda v: (v - lo) / (hi - lo)), (lambda x: lo + x * (hi - lo))


def conv_log(lo, hi):
    r = math.log(hi / lo)
    return (lambda v: math.log(max(1e-9, v) / lo) / r), (lambda x: lo * math.exp(x * r))


def conv_enum(values):
    return (lambda v: min(range(len(values)), key=lambda i: abs(values[i] - v))), (lambda x: values[int(x)])


CONV_FADER = (x32_fader_pos, x32_fader_db)
CONV_INV = ((lambda v: 0 if v else 1), (lambda x: 0 if x else 1))     # mute <-> "on"
CONV_PAN = conv_lin(-100, 100)


class Model:
    """Descripción de una mesa: tiras, parámetros, rutas OSC y conversiones."""

    def __init__(self, kind, name):
        self.kind, self.name = kind, name
        self.strips, self.spec, self.path, self.conv, self.otype = [], {}, {}, {}, {}
        self.layers, self.targets, self.colors = [], [], []
        self.master, self.mgroups = "", 0
        self.mains = []            # salidas principales a las que se puede asignar un canal
        self.mtx_targets = []      # matrices a las que envían los buses y los mains (WING)

    def p(self, key, path, typ, lo=0, hi=1, curve="lin", default=0, conv=None, otype=None, values=None):
        self.spec[key] = [typ, lo, hi, curve, default] + ([values] if values else [])
        if path:
            self.path[key] = path
        if conv:
            self.conv[key] = conv
        self.otype[key] = otype or {"s": "s", "b": "i", "i": "i"}.get(typ, "f")

    def add_strip(self, sid, kind, label, **feat):
        st = {"id": sid, "kind": kind, "label": label, "eq": [], "eqTypes": False, "gate": False, "dyn": False,
              "sends": False, "pan": True, "inp": False, "trim": False, "solo": True}
        st.update(feat)
        self.strips.append(st)
        return st

    def describe(self):
        return {"t": "model", "kind": self.kind, "name": self.name, "strips": self.strips, "spec": self.spec,
                "layers": self.layers, "targets": self.targets, "colors": self.colors, "master": self.master,
                "mgroups": self.mgroups, "mains": self.mains, "mtxTargets": self.mtx_targets}


# ---------------------------------------------------- Behringer WING ----
WING_COLORS = [["#4a4a52", "Ninguno"], ["#7b8fb0", "Gris azul"], ["#2f7bf2", "Azul"], ["#3346c8", "Azul oscuro"],
               ["#1fc2d4", "Turquesa"], ["#2fbf5b", "Verde"], ["#8fae2a", "Oliva"], ["#f2c230", "Amarillo"],
               ["#ff8a1f", "Naranja"], ["#e3101c", "Rojo"], ["#ff6b5a", "Coral"], ["#ff5fb0", "Rosa"],
               ["#b06ad8", "Malva"]]
EQ_WING_SMALL = ["l", "1", "2", "3", "4", "h"]                 # canales y aux: grave + 4 medios + agudo
EQ_WING_BIG = ["l", "1", "2", "3", "4", "5", "6", "h"]          # buses, main y matrices


def build_wing():
    m = Model("wing", "Behringer WING")
    m.colors, m.master, m.mgroups = WING_COLORS, "main1", 8

    def strip(sid, kind, label, base, *, eq=None, gate=False, dyn=False, sends=False, pan=True, inp=False, mtx=False):
        m.add_strip(sid, kind, label, eq=eq or [], gate=gate, dyn=dyn, sends=sends, pan=pan, inp=inp, trim=inp, mtxSends=mtx)
        k, p = sid + ".", m.p
        p(k + "name", base + "/name", "s", default="")
        p(k + "color", base + "/col", "i", 0, 12, default=0)
        p(k + "fader", base + "/fdr", "n", -144, 10, "fdr", -144.0 if kind in ("ch", "aux", "mtx") else 0.0)
        p(k + "mute", base + "/mute", "b", default=0)
        p(k + "solo", base + "/$solo", "b", default=0)
        if pan:
            p(k + "pan", base + "/pan", "n", -100, 100, default=0.0)
        if inp:
            p(k + "gain", None, "n", -3, 60, default=0.0)      # previo: depende de la fuente del canal
            p(k + "p48", None, "b", default=0)
            p(k + "trim", base + "/in/set/trim", "n", -18, 18, default=0.0)
            p(k + "invert", base + "/in/set/inv", "b", default=0)
            p(k + "lc", base + "/flt/lc", "b", default=0)
            p(k + "lcf", base + "/flt/lcf", "n", 20, 2000, "log", 100.0)
            p(k + "src.grp", base + "/in/conn/grp", "s", default="")
            p(k + "src.in", base + "/in/conn/in", "i", 0, 64, default=0)
        if gate:
            g = k + "gate."
            p(g + "on", base + "/gate/on", "b")
            p(g + "thr", base + "/gate/thr", "n", -80, 0, default=-40.0)
            p(g + "range", base + "/gate/range", "n", 3, 60, default=30.0)
            p(g + "att", base + "/gate/att", "n", 0, 120, default=0.0)
            p(g + "hld", base + "/gate/hld", "n", 0, 2000, "log1", 50.0)
            p(g + "rel", base + "/gate/rel", "n", 4, 4000, "log", 200.0)
        if dyn:
            d = k + "dyn."
            p(d + "on", base + "/dyn/on", "b")
            p(d + "thr", base + "/dyn/thr", "n", -60, 0, default=-15.0)
            p(d + "ratio", base + "/dyn/ratio", "n", 1.1, 100, "log", 3.0)
            p(d + "knee", base + "/dyn/knee", "n", 0, 5, default=1.0)
            p(d + "att", base + "/dyn/att", "n", 0, 120, default=10.0)
            p(d + "rel", base + "/dyn/rel", "n", 4, 4000, "log", 150.0)
            p(d + "gain", base + "/dyn/gain", "n", -6, 12, default=0.0)
            p(d + "mix", base + "/dyn/mix", "n", 0, 100, default=100.0)
        if eq:
            p(k + "eq.on", base + "/eq/on", "b")
            freqs = [80, 250, 800, 2500, 6000, 10000] if len(eq) == 6 else [80, 150, 300, 700, 1500, 3500, 7000, 10000]
            for b, f in zip(eq, freqs):
                p(f"{k}eq.{b}.g", f"{base}/eq/{b}g", "n", -15, 15, default=0.0)
                p(f"{k}eq.{b}.f", f"{base}/eq/{b}f", "n", 20, 20000, "log", float(f))
                p(f"{k}eq.{b}.q", f"{base}/eq/{b}q", "n", 0.44, 10, "log", 2.0 if b not in "lh" else 0.7)
        if sends:
            for b in range(1, 17):
                p(f"{k}send.{b}.lvl", f"{base}/send/{b}/lvl", "n", -144, 10, "fdr", -144.0)
                p(f"{k}send.{b}.on", f"{base}/send/{b}/on", "b", default=1)
            for mn in range(1, 5):
                p(f"{k}main.{mn}.on", f"{base}/main/{mn}/on", "b", default=1 if mn == 1 else 0)
        if mtx:   # envíos de buses y mains a las matrices 1-8 (clave 101-108 para no chocar con los buses)
            for x in range(1, 9):
                p(f"{k}send.{100 + x}.lvl", f"{base}/send/{x}/lvl", "n", -144, 10, "fdr", -144.0)
                p(f"{k}send.{100 + x}.on", f"{base}/send/{x}/on", "b", default=1)

    for n in range(1, 41):
        strip(f"ch{n}", "ch", f"Canal {n}", f"/ch/{n}", eq=EQ_WING_SMALL, gate=True, dyn=True, sends=True, inp=True)
    for n in range(1, 9):
        strip(f"aux{n}", "aux", f"Aux {n}", f"/aux/{n}", eq=EQ_WING_SMALL, dyn=True, sends=True, inp=True)
    for n in range(1, 17):
        strip(f"bus{n}", "bus", f"Bus {n}", f"/bus/{n}", eq=EQ_WING_BIG, dyn=True, mtx=True)
    for n in range(1, 5):
        strip(f"main{n}", "main", f"Main {n}", f"/main/{n}", eq=EQ_WING_BIG, dyn=True, mtx=True)
    for n in range(1, 9):
        strip(f"mtx{n}", "mtx", f"Matriz {n}", f"/mtx/{n}", eq=EQ_WING_BIG, dyn=True)
    for n in range(1, 17):
        strip(f"dca{n}", "dca", f"DCA {n}", f"/dca/{n}", pan=False)
    for g in range(1, 9):
        m.p(f"mg{g}.mute", f"/mgrp/{g}/mute", "b")
        m.p(f"mg{g}.name", f"/mgrp/{g}/name", "s", default="")
    m.targets = [{"n": b, "id": f"bus{b}"} for b in range(1, 17)]
    m.mains = [{"n": n, "id": f"main{n}"} for n in range(1, 5)]
    m.mtx_targets = [{"n": 100 + x, "id": f"mtx{x}"} for x in range(1, 9)]
    ids = lambda pre, a, b: [f"{pre}{i}" for i in range(a, b + 1)]
    m.layers = [{"id": "in1", "name": "1–16", "ids": ids("ch", 1, 16)},
                {"id": "in2", "name": "17–32", "ids": ids("ch", 17, 32)},
                {"id": "in3", "name": "33–40", "ids": ids("ch", 33, 40)},
                {"id": "aux", "name": "Aux", "ids": ids("aux", 1, 8)},
                {"id": "bus", "name": "Buses", "ids": ids("bus", 1, 16)},
                {"id": "out", "name": "Salidas", "ids": ids("main", 1, 4) + ids("mtx", 1, 8)},
                {"id": "dca", "name": "DCA", "ids": ids("dca", 1, 16)}]
    return m


# ------------------------------------------- Behringer XR18 (X Air) ----
XAIR_COLORS = [["#4a4a52", "Ninguno"], ["#e3101c", "Rojo"], ["#2fbf5b", "Verde"], ["#f2c230", "Amarillo"],
               ["#2f7bf2", "Azul"], ["#c23be0", "Magenta"], ["#1fc2d4", "Cian"], ["#e8e8ec", "Blanco"]]
XAIR_RATIOS = [1.1, 1.3, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0, 7.0, 10.0, 20.0, 100.0]
XAIR_SOLO = {}


def build_xair():
    m = Model("xair", "Behringer XR18")
    m.colors, m.master, m.mgroups = XAIR_COLORS, "lr", 4
    p = m.p

    def strip(sid, kind, label, base, solo, *, eq=0, gate=False, dyn=False, sends=False, pan=True, inp=None):
        bands = [str(i) for i in range(1, eq + 1)]
        m.add_strip(sid, kind, label, eq=bands, eqTypes=bool(eq), gate=gate, dyn=dyn, sends=sends, pan=pan,
                    inp=inp is not None, solo=solo is not None)
        k = sid + "."
        dca = kind == "dca"
        p(k + "name", base + "/config/name", "s", default="")
        p(k + "color", base + "/config/color", "i", 0, 7, default=0)
        mix = base if dca else base + "/mix"
        p(k + "fader", mix + "/fader", "n", -144, 10, "fdr", -144.0 if kind in ("ch", "aux", "fxrtn") else 0.0,
          conv=CONV_FADER)
        p(k + "mute", mix + "/on", "b", conv=CONV_INV)
        if solo is not None:
            p(k + "solo", f"/-stat/solosw/{solo:02d}", "b")
        if pan:
            p(k + "pan", mix + "/pan", "n", -100, 100, default=0.0, conv=CONV_PAN)
        if inp is not None:
            h = f"/headamp/{inp:02d}"
            p(k + "gain", h + "/gain", "n", -12, 60, default=0.0, conv=conv_lin(-12, 60))
            p(k + "p48", h + "/phantom", "b")
            p(k + "invert", base + "/preamp/invert", "b")
            p(k + "lc", base + "/preamp/hpon", "b")
            p(k + "lcf", base + "/preamp/hpf", "n", 20, 400, "log", 100.0, conv=conv_log(20, 400))
        if gate:
            g, gp = k + "gate.", base + "/gate/"
            p(g + "on", gp + "on", "b")
            p(g + "thr", gp + "thr", "n", -80, 0, default=-40.0, conv=conv_lin(-80, 0))
            p(g + "range", gp + "range", "n", 3, 60, default=30.0, conv=conv_lin(3, 60))
            p(g + "att", gp + "attack", "n", 0, 120, default=0.0, conv=conv_lin(0, 120))
            p(g + "hld", gp + "hold", "n", 0.02, 2000, "log", 50.0, conv=conv_log(0.02, 2000))
            p(g + "rel", gp + "release", "n", 5, 4000, "log", 200.0, conv=conv_log(5, 4000))
        if dyn:
            d, dp = k + "dyn.", base + "/dyn/"
            p(d + "on", dp + "on", "b")
            p(d + "thr", dp + "thr", "n", -60, 0, default=-15.0, conv=conv_lin(-60, 0))
            p(d + "ratio", dp + "ratio", "n", 1.1, 100, "enum", 3.0, conv=conv_enum(XAIR_RATIOS), otype="i",
              values=XAIR_RATIOS)
            p(d + "knee", dp + "knee", "n", 0, 5, default=1.0, conv=conv_lin(0, 5))
            p(d + "att", dp + "attack", "n", 0, 120, default=10.0, conv=conv_lin(0, 120))
            p(d + "rel", dp + "release", "n", 5, 4000, "log", 150.0, conv=conv_log(5, 4000))
            p(d + "gain", dp + "mgain", "n", 0, 24, default=0.0, conv=conv_lin(0, 24))
            p(d + "mix", dp + "mix", "n", 0, 100, default=100.0, conv=conv_lin(0, 100))
        if eq:
            p(k + "eq.on", base + "/eq/on", "b")
            freqs = [100, 500, 2000, 8000] if eq == 4 else [80, 200, 500, 1500, 4000, 10000]
            for i, f in enumerate(freqs, 1):
                e = f"{base}/eq/{i}/"
                typ = 1 if i == 1 else 4 if i == eq else 2
                p(f"{k}eq.{i}.type", e + "type", "i", 0, 5, default=typ)
                p(f"{k}eq.{i}.f", e + "f", "n", 20, 20000, "log", float(f), conv=conv_log(20, 20000))
                p(f"{k}eq.{i}.g", e + "g", "n", -15, 15, default=0.0, conv=conv_lin(-15, 15))
                p(f"{k}eq.{i}.q", e + "q", "n", 0.3, 10, "log", 2.0, conv=conv_log(10, 0.3))
        if sends:
            for b in range(1, 11):
                p(f"{k}send.{b}.lvl", f"{mix}/{b:02d}/level", "n", -144, 10, "fdr", -144.0, conv=CONV_FADER)
            p(f"{k}main.1.on", f"{mix}/lr", "b", default=1)

    for n in range(1, 17):
        strip(f"ch{n}", "ch", f"Canal {n}", f"/ch/{n:02d}", n, eq=4, gate=True, dyn=True, sends=True, inp=n)
    strip("aux1", "aux", "Aux 17-18", "/rtn/aux", 17, sends=True)
    for n in range(1, 5):
        strip(f"fx{n}", "fxrtn", f"Retorno FX {n}", f"/rtn/{n}", 17 + n, sends=True)
    for n in range(1, 7):
        strip(f"bus{n}", "bus", f"Bus {n}", f"/bus/{n}", 21 + n, eq=6, dyn=True)
    for n in range(1, 5):
        strip(f"fxs{n}", "fxsend", f"Envío FX {n}", f"/fxsend/{n}", 27 + n, pan=False)
    strip("lr", "main", "Principal L/R", "/lr", 32, eq=6, dyn=True)
    for n in range(1, 5):
        strip(f"dca{n}", "dca", f"DCA {n}", f"/dca/{n}", None, pan=False)
    for g in range(1, 5):
        p(f"mg{g}.mute", f"/config/mute/{g}", "b")
    m.targets = [{"n": b, "id": f"bus{b}"} for b in range(1, 7)] + [{"n": 6 + f, "id": f"fxs{f}"} for f in range(1, 5)]
    m.mains = [{"n": 1, "id": "lr"}]
    m.layers = [{"id": "in1", "name": "1–16", "ids": [f"ch{i}" for i in range(1, 17)]},
                {"id": "rtn", "name": "Aux · FX", "ids": ["aux1"] + [f"fx{i}" for i in range(1, 5)]},
                {"id": "bus", "name": "Buses", "ids": [f"bus{i}" for i in range(1, 7)] + [f"fxs{i}" for i in range(1, 5)]},
                {"id": "dca", "name": "DCA", "ids": [f"dca{i}" for i in range(1, 5)]}]
    return m


MODELS = {"wing": build_wing, "xair": build_xair}
MODEL_NAMES = {"wing": "Behringer WING", "xair": "Behringer XR18"}

# Nombres de ejemplo para el modo demo: (nombre, color en WING, color en X Air)
DEMO_NAMES = {
    "ch1": ("Bombo", 9, 1), "ch2": ("Caja", 9, 1), "ch3": ("Charles", 9, 1), "ch4": ("Tom 1", 9, 1),
    "ch5": ("Tom 2", 9, 1), "ch6": ("Base", 9, 1), "ch7": ("Aéreo I", 9, 1), "ch8": ("Aéreo D", 9, 1),
    "ch9": ("Bajo", 2, 4), "ch10": ("Guitarra 1", 7, 3), "ch11": ("Guitarra 2", 7, 3), "ch12": ("Teclado I", 12, 5),
    "ch13": ("Teclado D", 12, 5), "ch14": ("Acústica", 8, 3), "ch15": ("Voz MB", 4, 6), "ch16": ("Coro 1", 5, 2),
    "ch17": ("Coro 2", 5, 2), "ch18": ("Coro 3", 5, 2),
    "aux1": ("Ordenador", 1, 7), "aux2": ("Reverb", 11, 5), "fx1": ("Reverb", 11, 5), "fx2": ("Delay", 11, 5),
    "bus1": ("Mon Batería", 9, 1), "bus2": ("Mon Bajo", 2, 4), "bus3": ("Mon Guitarra", 7, 3),
    "bus4": ("Mon Voz", 4, 6), "bus5": ("Cascos MB I", 5, 2), "bus6": ("Cascos MB D", 5, 2),
    "fxs1": ("Reverb", 11, 5), "fxs2": ("Delay", 11, 5),
    "main1": ("Principal", 1, 7), "lr": ("Principal", 1, 7),
    "dca1": ("Batería", 9, 1), "dca2": ("Voces", 4, 6), "dca3": ("Banda", 7, 3), "dca4": ("Efectos", 11, 5),
    "mg1": ("Banda",), "mg2": ("Efectos",),
}


def fader_gain(db):
    return 0.0 if db <= -140 else 10 ** (db / 20)


# ------------------------------------------------------------ MESA ----
class Mixer:
    """Estado de la mesa + conexión. En modo demo se simula todo."""

    def __init__(self, hub):
        self.hub = hub
        self.mode = "offline"        # offline / demo / live
        self.ip = ""
        self.info = ""
        self.connected = False
        self.transport = None
        self.last_rx = 0.0
        self.has_meters = False
        self.use_model("wing")

    def use_model(self, kind):
        self.model = MODELS.get(kind, build_wing)()
        self.kind = self.model.kind
        self.strips, self.spec, self.path = self.model.strips, self.model.spec, dict(self.model.path)
        self.by_path = {v: k for k, v in self.path.items()}
        self.values = {k: v[4] for k, v in self.spec.items()}
        self.meters = {s["id"]: [0.0, 1.0, 1.0] for s in self.strips}   # nivel, GR puerta, GR compresor

    # ---- red ----
    async def connect(self, kind, demo, ip=""):
        await self.disconnect()
        self.use_model(kind)
        self.ip = ip.strip()
        if demo:
            self.mode = "demo"
            self._demo_setup()
            self.connected, self.has_meters = True, True
            self.info = f"Demo · {MODEL_NAMES[self.kind]}"
            return {"ok": True}
        self.mode = "live"
        if not self.ip:
            self.mode = "offline"
            return {"ok": False, "msg": "Escribe la dirección IP de la mesa."}
        port = WING_OSC_PORT if self.kind == "wing" else XAIR_PORT
        loop = asyncio.get_running_loop()
        try:
            self.transport, _ = await loop.create_datagram_endpoint(
                lambda: _OscProtocol(self), remote_addr=(self.ip, port))
        except OSError as e:
            self.mode = "offline"
            return {"ok": False, "msg": f"No se pudo abrir la conexión: {e}"}
        if self.kind == "wing":
            self.send("/?")
            self.send("/ch/1/name")
        else:
            self.send("/xinfo")
        for _ in range(30):                       # espera respuesta (3 s)
            await asyncio.sleep(0.1)
            if self.connected:
                break
        if not self.connected:
            self.transport.close()
            self.transport = None
            self.mode = "offline"
            return {"ok": False, "msg": f"La mesa no responde en {self.ip}. Revisa la IP, que hayas elegido el "
                                        "modelo correcto y que el ordenador esté en la misma red que la mesa."}
        if not self.info:
            self.info = f"{MODEL_NAMES[self.kind]} · {self.ip}"
        self.has_meters = self.kind == "xair"     # la WING no da vúmetros por OSC
        self._subscribe()
        asyncio.ensure_future(self._query_all())
        return {"ok": True}

    async def disconnect(self):
        if self.transport is not None:
            self.transport.close()
            self.transport = None
        self.connected = False
        self.info = ""

    def send(self, addr, *args):
        if self.transport is not None:
            self.transport.sendto(osc_encode(addr, *args))

    def _subscribe(self):
        if self.kind == "wing":
            self.send("/*S")                      # recibir los cambios hechos en la mesa
        else:
            self.send("/xremote")
            self.send("/meters", "/meters/1")

    async def _query_all(self):
        """Pide a la mesa el valor de todos los parámetros."""
        for i, wpath in enumerate(list(self.path.values())):
            if self.transport is None:
                return
            self.send(wpath)
            if i % 20 == 19:
                await asyncio.sleep(0.02)
        await asyncio.sleep(0.6)
        if self.kind == "wing":
            for s in self.strips:
                if s["inp"]:
                    self._map_source(s["id"])
            await asyncio.sleep(0.4)
        self.hub.broadcast({"t": "state", "v": self.values})

    def _map_source(self, sid):
        """WING: la ganancia y los 48V están en la entrada física conectada al canal."""
        grp, n = self.values.get(sid + ".src.grp"), self.values.get(sid + ".src.in")
        for k in ("gain", "p48"):
            old = self.path.pop(f"{sid}.{k}", None)
            if old:
                self.by_path.pop(old, None)
        if grp and grp != "OFF" and n:
            for k, suffix in (("gain", "g"), ("p48", "vph")):
                wp = f"/io/in/{grp}/{int(n)}/{suffix}"
                self.path[f"{sid}.{k}"] = wp
                self.by_path[wp] = f"{sid}.{k}"
                self.send(wp)

    def on_osc(self, addr, args):
        self.last_rx = time.time()
        if not self.connected:
            self.connected = True
        if addr == "/?" and args and isinstance(args[0], str) and args[0].startswith("WING"):
            parts = args[0].split(",")
            if len(parts) >= 4:
                self.info = f"WING ({parts[3]}) · {parts[2]} · {parts[1]}"
            return
        if addr == "/xinfo" and len(args) >= 4:
            self.info = f"{args[2]} · {args[1]} · {args[0]}"
            return
        if addr == "/meters/1" and args and isinstance(args[0], bytes):
            self._xair_meters(args[0])
            return
        key = self.by_path.get(addr)
        if key is None or not args:
            return
        typ = self.spec[key][0]
        if self.kind == "wing":                  # la WING responde ,sff: texto, normalizado, valor real
            nums = [a for a in args if isinstance(a, (int, float))]
            raw = str(args[0]) if typ == "s" else nums[-1] if nums else args[0]
        else:
            raw = args[0]
        if isinstance(raw, bytes):
            return
        try:
            if key in self.model.conv and typ != "s":
                raw = self.model.conv[key][1](float(raw))
            if typ == "s":
                v = str(raw)
            elif typ == "n":
                v = round(float(raw), 3)
            else:
                v = int(round(float(raw)))
        except (TypeError, ValueError):
            return
        self.values[key] = v
        self.hub.queue_update(key, v)
        if key.endswith(".src.grp") or key.endswith(".src.in"):
            self._map_source(key.split(".")[0])

    def _xair_meters(self, blob):
        """X Air /meters/1: 16 canales, aux L/R, 4 FX L/R, 6 buses, 4 envíos FX, L/R, monitor (dB x 256)."""
        try:
            n = struct.unpack("<i", blob[:4])[0]
            vals = struct.unpack(f"<{n}h", blob[4:4 + 2 * n])
        except struct.error:
            return
        if n < 38:
            return
        lin = lambda i: 10 ** ((vals[i] / 256.0) / 20)
        m = self.meters
        for i in range(16):
            m[f"ch{i + 1}"] = [lin(i), 1.0, 1.0]
        m["aux1"] = [max(lin(16), lin(17)), 1.0, 1.0]
        for i in range(4):
            m[f"fx{i + 1}"] = [max(lin(18 + 2 * i), lin(19 + 2 * i)), 1.0, 1.0]
        for i in range(6):
            m[f"bus{i + 1}"] = [lin(26 + i), 1.0, 1.0]
        for i in range(4):
            m[f"fxs{i + 1}"] = [lin(32 + i), 1.0, 1.0]
        m["lr"] = [max(lin(36), lin(37)), 1.0, 1.0]

    # ---- parámetros ----
    def set(self, key, value):
        if key not in self.spec:
            return False
        sp = self.spec[key]
        typ, lo, hi = sp[:3]
        try:
            if typ == "s":
                v = str(value)[:16 if self.kind == "wing" else 12]
            elif typ == "n":
                v = min(float(hi), max(float(lo), float(value)))
                if sp[3] == "enum":
                    v = min(sp[5], key=lambda x: abs(x - v))
            else:
                v = int(min(hi, max(lo, int(value)))) if typ == "i" else (1 if value else 0)
        except (TypeError, ValueError):
            return False
        self.values[key] = v
        if self.mode == "live" and key in self.path:
            out, ot = v, self.model.otype[key]
            if key in self.model.conv:
                out = self.model.conv[key][0](v)
                if ot == "f":
                    out = min(1.0, max(0.0, out))
            self.send(self.path[key], int(round(out)) if ot == "i" else float(out) if ot == "f" else str(out))
        return True

    # ---- tareas periódicas ----
    async def tick(self):
        """Mantiene viva la suscripción y simula los vúmetros en el modo demo."""
        last_sub = 0.0
        phase = {}
        while True:
            await asyncio.sleep(0.05)
            now = time.time()
            if self.mode == "live" and self.transport is not None:
                if now - last_sub > 7:
                    self._subscribe()
                    self.send("/?" if self.kind == "wing" else "/xinfo")
                    last_sub = now
                if self.connected and now - self.last_rx > 20:
                    self.connected = False
                    self.hub.broadcast(self.hub.status())
                elif not self.connected and now - self.last_rx < 2:
                    self.connected = True
                    self.hub.broadcast(self.hub.status())
            elif self.mode == "demo":
                self._demo_meters(now, phase)
            if self.hub.clients:
                self.hub.send_meters()

    def _demo_setup(self):
        v, wing = self.values, self.kind == "wing"
        for sid, data in DEMO_NAMES.items():
            if sid + ".name" in v:
                v[sid + ".name"] = data[0]
                if len(data) > 1:
                    v[sid + ".color"] = data[1] if wing else data[2]
        for s in self.strips:
            sid = s["id"]
            if s["kind"] in ("ch", "aux", "fxrtn") and v[sid + ".name"]:
                v[sid + ".fader"] = 0.0 if s["kind"] == "ch" else -6.0
                if s["eq"]:
                    v[sid + ".eq.on"] = 1
                if s["kind"] == "ch":
                    v[sid + ".dyn.on"] = 1
                    v[sid + ".gain"] = 30.0
                    v[sid + ".lc"] = 1
            if s["kind"] in ("bus", "fxsend") and v[sid + ".name"]:
                v[sid + ".fader"] = 0.0
        for n in range(1, 16):
            if f"ch{n}.send.4.lvl" in v:
                v[f"ch{n}.send.4.lvl"] = -10.0 if n != 15 else 0.0

    def _demo_meters(self, now, phase):
        v, m = self.values, self.meters
        mix = 0.0
        for s in self.strips:
            sid = s["id"]
            if s["kind"] not in ("ch", "aux", "fxrtn"):
                continue
            if not v[sid + ".name"]:
                m[sid] = [0.0, 1.0, 1.0]
                continue
            ph = phase.setdefault(sid, random.random() * 10)
            env = 0.5 + 0.5 * math.sin(now * (1.3 + ph % 1.7) + ph)
            hit = abs(math.sin(now * (2 + ph % 3) + ph)) ** 6
            lvl = min(1.0, (0.08 + 0.35 * env + 0.4 * hit) * (0.6 + 0.4 * random.random()))
            gr = 1.0
            if s["dyn"] and v[sid + ".dyn.on"]:
                thr = 10 ** (v[sid + ".dyn.thr"] / 20)
                if lvl > thr:
                    gr = max(0.1, (thr / lvl) ** (1 - 1 / max(1.1, v[sid + ".dyn.ratio"])))
            m[sid] = [lvl, 1.0, gr]
            if not v[sid + ".mute"]:
                mix = max(mix, lvl * fader_gain(v[sid + ".fader"]))
        for s in self.strips:
            sid = s["id"]
            if s["kind"] in ("bus", "fxsend"):
                lvl = mix * 0.7 * random.uniform(0.85, 1) if v[sid + ".name"] else 0.0
                m[sid] = [min(1.0, lvl * fader_gain(v[sid + ".fader"]) * 1.5), 1.0, 1.0]
        main = self.model.master
        m[main] = [min(1.0, mix * fader_gain(v[main + ".fader"])) if not v[main + ".mute"] else 0.0, 1.0, 1.0]

    # ---- escenas ----
    def snapshot(self):
        return {k: v for k, v in self.values.items() if not k.endswith(".solo") and ".src." not in k}

    def recall(self, values):
        for k, v in values.items():
            if k in self.spec:
                self.set(k, v)


class _OscProtocol(asyncio.DatagramProtocol):
    def __init__(self, mixer):
        self.mixer = mixer

    def datagram_received(self, data, addr):
        msg = osc_decode(data)
        if msg:
            self.mixer.on_osc(*msg)

    def error_received(self, exc):
        pass


def discover(timeout=1.6):
    """Busca mesas en la red local: WING ("WING?" al puerto 2222) y X Air (/xinfo al 10024)."""
    found = {}
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        s.settimeout(0.25)
        for _ in range(2):
            s.sendto(b"WING?", ("255.255.255.255", WING_INFO_PORT))
            s.sendto(osc_encode("/xinfo"), ("255.255.255.255", XAIR_PORT))
            end = time.time() + timeout / 2
            while time.time() < end:
                try:
                    data, (ip, _) = s.recvfrom(2048)
                except socket.timeout:
                    continue
                if data.startswith(b"WING,"):
                    parts = data.decode("utf-8", "replace").strip("\0").split(",")
                    if len(parts) >= 4:
                        found[ip] = {"ip": ip, "kind": "wing", "name": parts[2], "model": "WING " + parts[3]}
                else:
                    msg = osc_decode(data)
                    if msg and msg[0] == "/xinfo" and len(msg[1]) >= 3:
                        found[ip] = {"ip": ip, "kind": "xair", "name": msg[1][1], "model": msg[1][2]}
    except OSError:
        pass
    finally:
        s.close()
    return list(found.values())


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


# --------------------------------------------------- SERVIDOR WEB ----
class Client:
    def __init__(self, writer):
        self.writer = writer
        self.closed = False

    def send(self, obj):
        if self.closed:
            return
        data = json.dumps(obj, separators=(",", ":"), ensure_ascii=False).encode()
        n = len(data)
        head = bytes([0x81]) + (bytes([n]) if n < 126 else bytes([126]) + struct.pack(">H", n)
                                if n < 65536 else bytes([127]) + struct.pack(">Q", n))
        try:
            self.writer.write(head + data)
        except (ConnectionError, RuntimeError):
            self.closed = True


class Hub:
    """Une los iPads/navegadores conectados con la mesa."""

    def __init__(self):
        self.clients = set()
        self.mixer = Mixer(self)
        self.cfg = {"kind": "wing", "demo": True, "ip": "", "ips": {}, "scenes": [], "layouts": {}}
        self._updates = {}
        self.load()

    # ---- configuración ----
    def load(self):
        try:
            self.cfg.update(json.loads(CONFIG_PATH.read_text(encoding="utf-8")))
        except (OSError, ValueError):
            pass
        if self.cfg.get("kind") not in MODELS:
            self.cfg["kind"] = "wing"
        self.cfg["scenes"] = [s for s in self.cfg.get("scenes", []) if s.get("model") in MODELS]
        if not isinstance(self.cfg.get("layouts"), dict):
            self.cfg["layouts"] = {}

    def save(self):
        try:
            CONFIG_PATH.write_text(json.dumps(self.cfg, ensure_ascii=False), encoding="utf-8")
        except OSError:
            pass

    # ---- envío ----
    def status(self):
        m = self.mixer
        return {"t": "status", "mode": m.mode, "kind": m.kind, "ip": m.ip, "connected": m.connected,
                "info": m.info, "meters": m.has_meters, "url": f"http://{lan_ip()}:{PORT}",
                "ips": self.cfg.get("ips", {})}

    def broadcast(self, obj, skip=None):
        for c in list(self.clients):
            if c is not skip:
                c.send(obj)

    def queue_update(self, key, value):
        self._updates[key] = value

    def send_meters(self):
        if self._updates:
            self.broadcast({"t": "upd", "v": self._updates})
            self._updates = {}
        if self.mixer.has_meters:
            meters = {k: [round(v[0], 4), round(v[1], 3), round(v[2], 3)] for k, v in self.mixer.meters.items()}
            self.broadcast({"t": "m", "v": meters})

    def scenes(self):
        kind = self.mixer.kind
        return {"t": "scenes", "v": [{"i": i, "name": s["name"], "time": s.get("time", "")}
                                     for i, s in enumerate(self.cfg["scenes"]) if s.get("model") == kind]}

    def layout(self):
        return {"t": "layout", "v": self.cfg["layouts"].get(self.mixer.kind, {})}

    # ---- canales enlazados (pares 1-2, 3-4...) ----
    NO_LINK = ("name", "color", "gain", "p48", "trim", "invert", "pan", "solo")

    def links(self):
        return self.cfg["layouts"].setdefault(self.mixer.kind, {}).setdefault("links", [])

    def partner(self, key):
        """Clave equivalente en el canal enlazado, o None."""
        sid, _, rest = key.partition(".")
        if not sid.startswith("ch") or not rest or rest.split(".")[0] in self.NO_LINK or rest.startswith("src."):
            return None
        n = int(sid[2:])
        odd = n if n % 2 else n - 1
        if odd not in self.links():
            return None
        other = f"ch{odd + 1 if n == odd else odd}.{rest}"
        return other if other in self.mixer.spec else None

    def link(self, odd, on):
        m, links = self.mixer, self.links()
        a, b = f"ch{odd}", f"ch{odd + 1}"
        if a + ".fader" not in m.spec or b + ".fader" not in m.spec:
            return
        if on and odd not in links:
            links.append(odd)
            for key in list(m.spec):
                if key.startswith(a + "."):
                    other = self.partner(key)
                    if other:
                        m.set(other, m.values[key])
            if a + ".pan" in m.spec:
                m.set(a + ".pan", -100)
                m.set(b + ".pan", 100)
        elif not on and odd in links:
            links.remove(odd)
        self.save()
        self.broadcast(self.layout())
        self.broadcast({"t": "state", "v": m.values})

    def full(self, target):
        """Modelo + estado completo (al conectar un iPad o al cambiar de mesa)."""
        m = self.mixer
        for msg in (m.model.describe(), self.status(), {"t": "state", "v": m.values}, self.scenes(), self.layout()):
            target(msg)

    # ---- mensajes de la interfaz ----
    async def handle(self, client, msg):
        t = msg.get("t")
        m = self.mixer
        if t == "set":
            key = msg.get("p")
            if m.set(key, msg.get("v")):
                self.broadcast({"t": "upd", "v": {key: m.values[key]}}, skip=client)
                other = self.partner(key)
                if other and m.set(other, m.values[key]):
                    self.broadcast({"t": "upd", "v": {other: m.values[other]}})
        elif t == "link":
            self.link(int(msg.get("ch", 0)), bool(msg.get("on")))
        elif t == "connect":
            kind = msg.get("kind") if msg.get("kind") in MODELS else "wing"
            demo, ip = bool(msg.get("demo")), str(msg.get("ip", ""))
            res = await m.connect(kind, demo, ip)
            self.cfg["kind"], self.cfg["demo"] = kind, demo
            if res["ok"]:
                if not demo:
                    self.cfg["ip"] = ip
                    self.cfg.setdefault("ips", {})[kind] = ip
                self.save()
            client.send({"t": "connectResult", **res})
            self.full(self.broadcast)
        elif t == "discover":
            found = await asyncio.get_running_loop().run_in_executor(None, discover)
            client.send({"t": "found", "v": found})
        elif t == "sceneSave":
            kind = m.kind
            name = " ".join(str(msg.get("name", "")).split())[:40]
            if not name:
                name = f"Mezcla {sum(1 for s in self.cfg['scenes'] if s.get('model') == kind) + 1}"
            sc = {"name": name, "time": time.strftime("%d/%m %H:%M"), "model": kind, "values": m.snapshot()}
            for i, s in enumerate(self.cfg["scenes"]):
                if s.get("model") == kind and s["name"].lower() == name.lower():
                    self.cfg["scenes"][i] = sc
                    break
            else:
                self.cfg["scenes"].append(sc)
            self.save()
            self.broadcast(self.scenes())
        elif t == "sceneLoad":
            i = int(msg.get("i", -1))
            if 0 <= i < len(self.cfg["scenes"]) and self.cfg["scenes"][i].get("model") == m.kind:
                m.recall(self.cfg["scenes"][i]["values"])
                self.broadcast({"t": "state", "v": m.values})
        elif t == "sceneDelete":
            i = int(msg.get("i", -1))
            if 0 <= i < len(self.cfg["scenes"]):
                self.cfg["scenes"].pop(i)
                self.save()
                self.broadcast(self.scenes())
        elif t == "layout":
            v = msg.get("v") if isinstance(msg.get("v"), dict) else {}
            cur = self.cfg["layouts"].setdefault(m.kind, {})
            for k in ("custom", "groups", "views"):
                if isinstance(v.get(k), list):
                    cur[k] = v[k]
            self.save()
            self.broadcast(self.layout(), skip=client)
        elif t == "reset":
            self.cfg["layouts"][m.kind] = {}
            self.save()
            self.broadcast(self.layout())

    def welcome(self, client):
        self.full(client.send)


    # ---- HTTP + WebSocket (solo biblioteca estándar) ----
    async def serve_conn(self, reader, writer):
        try:
            req = await reader.readuntil(b"\r\n\r\n")
        except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, ConnectionError):
            writer.close()
            return
        lines = req.decode("latin-1").split("\r\n")
        try:
            method, path, _ = lines[0].split(" ", 2)
        except ValueError:
            writer.close()
            return
        headers = {}
        for ln in lines[1:]:
            if ":" in ln:
                k, v = ln.split(":", 1)
                headers[k.strip().lower()] = v.strip()
        path = path.split("?", 1)[0]
        if path == "/ws" and "sec-websocket-key" in headers:
            await self._websocket(reader, writer, headers["sec-websocket-key"])
        else:
            await self._static(writer, path)

    async def _static(self, writer, path):
        rel = "index.html" if path in ("/", "") else path.lstrip("/")
        full = os.path.normpath(os.path.join(WEB_DIR, rel))
        if not full.startswith(os.path.normpath(WEB_DIR)) or not os.path.isfile(full):
            writer.write(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        else:
            with open(full, "rb") as f:
                body = f.read()
            ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
            if full.endswith(".webmanifest"):
                ctype = "application/manifest+json"
            writer.write((f"HTTP/1.1 200 OK\r\nContent-Type: {ctype}\r\nContent-Length: {len(body)}\r\n"
                          "Cache-Control: no-cache\r\nConnection: close\r\n\r\n").encode() + body)
        try:
            await writer.drain()
        finally:
            writer.close()

    async def _websocket(self, reader, writer, key):
        accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest())
        writer.write(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                     b"Sec-WebSocket-Accept: " + accept + b"\r\n\r\n")
        sock = writer.get_extra_info("socket")
        if sock is not None:
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        client = Client(writer)
        self.clients.add(client)
        self.welcome(client)
        buf = b""
        try:
            while True:
                b0, b1 = await reader.readexactly(2)
                op, n = b0 & 0x0F, b1 & 0x7F
                if n == 126:
                    n = struct.unpack(">H", await reader.readexactly(2))[0]
                elif n == 127:
                    n = struct.unpack(">Q", await reader.readexactly(8))[0]
                mask = await reader.readexactly(4) if b1 & 0x80 else b"\0\0\0\0"
                data = bytearray(await reader.readexactly(n))
                for i in range(n):
                    data[i] ^= mask[i & 3]
                if op == 8:
                    break
                if op == 9:   # ping -> pong
                    writer.write(bytes([0x8A, len(data)]) + bytes(data[:125]))
                    continue
                if op in (0, 1):
                    buf += data
                    if b0 & 0x80:
                        try:
                            msg = json.loads(buf.decode())
                        except ValueError:
                            msg = None
                        buf = b""
                        if isinstance(msg, dict):
                            await self.handle(client, msg)
        except (asyncio.IncompleteReadError, ConnectionError):
            pass
        finally:
            client.closed = True
            self.clients.discard(client)
            writer.close()

    async def run(self, ready=None):
        global PORT
        server = None
        for port in [PORT] + [p for p in range(8081, 8100) if p != PORT]:   # si el puerto está ocupado, prueba otro
            try:
                server = await asyncio.start_server(self.serve_conn, "0.0.0.0", port)
                PORT = port
                break
            except OSError:
                continue
        if server is None:
            raise OSError("no hay ningún puerto libre entre 8080 y 8099")
        asyncio.ensure_future(self.mixer.tick())
        res = await self.mixer.connect(self.cfg["kind"], self.cfg.get("demo", True),
                                       self.cfg.get("ips", {}).get(self.cfg["kind"], self.cfg.get("ip", "")))
        if not res["ok"]:
            await self.mixer.connect(self.cfg["kind"], True)   # sin mesa: arranca en demo
        if ready:
            ready.set()
        async with server:
            await server.serve_forever()


def run_server(ready=None):
    hub = Hub()
    try:
        asyncio.run(hub.run(ready))
    except OSError as e:
        print(f"No se pudo abrir el puerto {PORT}: {e}")
        os._exit(1)


def main():
    if "--server" in sys.argv:
        print(f"MB Soundtools · MBMix\n  En el iPad (mismo Wi-Fi): http://{lan_ip()}:{PORT}")
        run_server()
        return
    ready = threading.Event()
    threading.Thread(target=run_server, args=(ready,), daemon=True).start()
    ready.wait(10)
    url = f"http://127.0.0.1:{PORT}"
    print(f"MB Soundtools · MBMix\n  En este ordenador: {url}\n  En el iPad (mismo Wi-Fi): http://{lan_ip()}:{PORT}")
    try:
        import webview  # pip install pywebview (opcional)
        webview.create_window("MB Soundtools · MBMix", url=url, width=1366, height=1024,
                              min_size=(1024, 700), background_color="#050505")
        webview.start()
    except Exception:   # sin pywebview o sin WebView2: se abre en el navegador
        import webbrowser
        webbrowser.open(url)
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
