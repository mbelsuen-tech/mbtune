#!/usr/bin/env python3
"""
MB Soundtools · MBMix - Control remoto de mesas digitales (estilo Mixing Station).

Un pequeño servidor en tu ordenador habla con la mesa por la red (OSC/UDP)
y sirve la interfaz táctil: ábrela en el iPad con Safari en la dirección que
muestra la app (mismo Wi-Fi), o en la ventana del propio ordenador.

Mesas:  Behringer WING Rack (y WING / WING Compact)  ·  Demo (sin mesa)

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


# ------------------------------------------------------ MODELO WING ----
# Cada parámetro tiene una clave propia ("ch1.fader", "bus3.eq.2.g"...) con su valor
# en unidades reales (dB, Hz, ms). spec = [tipo, mín, máx, curva, defecto]
#   tipo: n (número), b (sí/no), s (texto), i (entero)   curva: lin, log, fdr (fader)
EQ_SMALL = ["l", "1", "2", "3", "4", "h"]                 # canales y aux: grave + 4 medios + agudo
EQ_BIG = ["l", "1", "2", "3", "4", "5", "6", "h"]          # buses, main y matrices


def build_wing():
    strips, spec, path = [], {}, {}

    def p(key, wpath, typ, lo=0, hi=1, curve="lin", default=0):
        spec[key] = [typ, lo, hi, curve, default]
        if wpath:
            path[key] = wpath

    def strip(sid, kind, label, base, *, eq=None, gate=False, dyn=False, sends=False, pan=True,
              inp=False, solo=True):
        strips.append({"id": sid, "kind": kind, "label": label, "eq": eq or [], "gate": gate, "dyn": dyn,
                       "sends": sends, "pan": pan, "inp": inp, "solo": solo})
        k = sid + "."
        p(k + "name", base + "/name", "s", default="")
        p(k + "color", base + "/col", "i", 0, 12, default=0)
        p(k + "fader", base + "/fdr", "n", -144, 10, "fdr", -144.0 if kind in ("ch", "aux", "mtx") else 0.0)
        p(k + "mute", base + "/mute", "b", default=0)
        if solo:
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
            freqs = ([80, 250, 800, 2500, 6000, 10000] if len(eq) == 6 else
                     [80, 150, 300, 700, 1500, 3500, 7000, 10000])
            for b, f in zip(eq, freqs):
                p(f"{k}eq.{b}.g", f"{base}/eq/{b}g", "n", -15, 15, default=0.0)
                p(f"{k}eq.{b}.f", f"{base}/eq/{b}f", "n", 20, 20000, "log", float(f))
                p(f"{k}eq.{b}.q", f"{base}/eq/{b}q", "n", 0.44, 10, "log", 2.0 if b not in "lh" else 0.7)
        if sends:
            for b in range(1, 17):
                p(f"{k}send.{b}.lvl", f"{base}/send/{b}/lvl", "n", -144, 10, "fdr", -144.0)
                p(f"{k}send.{b}.on", f"{base}/send/{b}/on", "b", default=1)

    for n in range(1, 41):
        strip(f"ch{n}", "ch", f"Canal {n}", f"/ch/{n}", eq=EQ_SMALL, gate=True, dyn=True, sends=True, inp=True)
    for n in range(1, 9):
        strip(f"aux{n}", "aux", f"Aux {n}", f"/aux/{n}", eq=EQ_SMALL, dyn=True, sends=True, inp=True)
    for n in range(1, 17):
        strip(f"bus{n}", "bus", f"Bus {n}", f"/bus/{n}", eq=EQ_BIG, dyn=True)
    for n in range(1, 5):
        strip(f"main{n}", "main", f"Main {n}", f"/main/{n}", eq=EQ_BIG, dyn=True)
    for n in range(1, 9):
        strip(f"mtx{n}", "mtx", f"Matriz {n}", f"/mtx/{n}", eq=EQ_BIG, dyn=True)
    for n in range(1, 17):
        strip(f"dca{n}", "dca", f"DCA {n}", f"/dca/{n}", pan=False)
    for g in range(1, 9):
        p(f"mg{g}.mute", f"/mgrp/{g}/mute", "b")
        p(f"mg{g}.name", f"/mgrp/{g}/name", "s", default="")
    return strips, spec, path


# Nombres y colores de ejemplo para el modo demo (colores WING 1..12)
DEMO_NAMES = {
    "ch1": ("Bombo", 9), "ch2": ("Caja", 9), "ch3": ("Charles", 9), "ch4": ("Tom 1", 9), "ch5": ("Tom 2", 9),
    "ch6": ("Base", 9), "ch7": ("Aéreo I", 9), "ch8": ("Aéreo D", 9), "ch9": ("Bajo", 2), "ch10": ("Guitarra 1", 7),
    "ch11": ("Guitarra 2", 7), "ch12": ("Teclado I", 12), "ch13": ("Teclado D", 12), "ch14": ("Acústica", 8),
    "ch15": ("Voz MB", 4), "ch16": ("Coro 1", 5), "ch17": ("Coro 2", 5), "ch18": ("Coro 3", 5),
    "aux1": ("Ordenador", 1), "aux2": ("Reverb", 11), "aux3": ("Delay", 11),
    "bus1": ("Mon Batería", 9), "bus2": ("Mon Bajo", 2), "bus3": ("Mon Guitarra", 7), "bus4": ("Mon Voz", 4),
    "bus5": ("Cascos MB I", 5), "bus6": ("Cascos MB D", 5), "main1": ("Principal", 1),
    "dca1": ("Batería", 9), "dca2": ("Voces", 4), "dca3": ("Banda", 7), "dca4": ("Efectos", 11),
    "mg1": ("Banda",), "mg2": ("Efectos",),
}


def fader_gain(db):
    return 0.0 if db <= -140 else 10 ** (db / 20)


# ------------------------------------------------------------ MESA ----
class Mixer:
    """Estado de la mesa + conexión. En modo demo se simula todo."""

    def __init__(self, hub):
        self.hub = hub
        self.strips, self.spec, self.path = build_wing()
        self.by_path = {v: k for k, v in self.path.items()}
        self.values = self.defaults()
        self.mode = "offline"        # offline / demo / wing
        self.ip = ""
        self.info = ""
        self.connected = False
        self.transport = None
        self.last_rx = 0.0
        self.meters = {s["id"]: [0.0, 1.0, 1.0] for s in self.strips}   # nivel, GR puerta, GR compresor
        self.has_meters = False

    def defaults(self):
        return {k: v[4] for k, v in self.spec.items()}

    # ---- red ----
    async def connect(self, mode, ip=""):
        await self.disconnect()
        self.mode, self.ip = mode, ip.strip()
        self.values = self.defaults()
        self.meters = {s["id"]: [0.0, 1.0, 1.0] for s in self.strips}
        if mode == "demo":
            self._demo_setup()
            self.connected, self.info, self.has_meters = True, "Mesa de demostración (WING Rack)", True
            return {"ok": True}
        if mode != "wing":
            self.connected = False
            return {"ok": True}
        if not self.ip:
            return {"ok": False, "msg": "Escribe la dirección IP de la mesa."}
        self.has_meters = False
        loop = asyncio.get_running_loop()
        try:
            self.transport, _ = await loop.create_datagram_endpoint(
                lambda: _OscProtocol(self), remote_addr=(self.ip, WING_OSC_PORT))
        except OSError as e:
            return {"ok": False, "msg": f"No se pudo abrir la conexión: {e}"}
        self.send("/?")
        self.send("/ch/1/name")
        for _ in range(30):                       # espera respuesta (3 s)
            await asyncio.sleep(0.1)
            if self.connected:
                break
        if not self.connected:
            self.transport.close()
            self.transport = None
            return {"ok": False, "msg": f"La mesa no responde en {self.ip}. Revisa la IP y que el ordenador "
                                        "esté en la misma red que la WING."}
        if not self.info:
            self.info = f"WING · {self.ip}"
        self.send("/*S")                          # recibir los cambios hechos en la mesa
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

    async def _query_all(self):
        """Pide a la mesa el valor de todos los parámetros."""
        for i, wpath in enumerate(list(self.path.values())):
            if self.transport is None:
                return
            self.send(wpath)
            if i % 20 == 19:
                await asyncio.sleep(0.02)
        await asyncio.sleep(0.6)
        for s in self.strips:
            if s["inp"]:
                self._map_source(s["id"])
        await asyncio.sleep(0.4)
        self.hub.broadcast({"t": "state", "v": self.values})

    def _map_source(self, sid):
        """La ganancia y los 48V están en la entrada física conectada al canal."""
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
                self.info = f"WING {parts[3]} · {parts[2]} · {parts[1]}"
            return
        key = self.by_path.get(addr)
        if key is None or not args:
            return
        typ = self.spec[key][0]
        nums = [a for a in args if isinstance(a, (int, float))]
        if typ == "s":
            v = str(args[0])
        elif nums:
            v = nums[-1]
            v = int(round(v)) if typ in ("b", "i") else float(v)
        else:
            try:
                v = float(args[0]) if typ == "n" else int(float(args[0]))
            except (TypeError, ValueError):
                return
        self.values[key] = v
        self.hub.queue_update(key, v)
        if key.endswith(".src.grp") or key.endswith(".src.in"):
            self._map_source(key.split(".")[0])

    # ---- parámetros ----
    def set(self, key, value):
        if key not in self.spec:
            return False
        typ, lo, hi = self.spec[key][:3]
        try:
            if typ == "s":
                v = str(value)[:16]
            elif typ == "n":
                v = min(float(hi), max(float(lo), float(value)))
            else:
                v = int(min(hi, max(lo, int(value)))) if typ == "i" else (1 if value else 0)
        except (TypeError, ValueError):
            return False
        self.values[key] = v
        if self.mode == "wing" and key in self.path:
            self.send(self.path[key], v if typ != "n" else float(v))
        return True

    # ---- tareas periódicas ----
    async def tick(self):
        """Mantiene viva la suscripción y simula los vúmetros en el modo demo."""
        last_sub = 0.0
        phase = {s["id"]: random.random() * 10 for s in self.strips}
        while True:
            await asyncio.sleep(0.05)
            now = time.time()
            if self.mode == "wing" and self.transport is not None:
                if now - last_sub > 7:
                    self.send("/*S")
                    self.send("/?")
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
        v = self.values
        for sid, data in DEMO_NAMES.items():
            v[sid + ".name"] = data[0]
            if len(data) > 1:
                v[sid + ".color"] = data[1]
        for s in self.strips:
            sid = s["id"]
            if s["kind"] in ("ch", "aux") and v[sid + ".name"]:
                v[sid + ".fader"] = 0.0 if s["kind"] == "ch" else -6.0
                v[sid + ".eq.on"] = 1
                if s["kind"] == "ch":
                    v[sid + ".dyn.on"] = 1
                    v[sid + ".gain"] = 30.0
                    v[sid + ".lc"] = 1
            if s["kind"] == "bus" and v[sid + ".name"]:
                v[sid + ".fader"] = 0.0
        for n in range(1, 16):
            v[f"ch{n}.send.4.lvl"] = -10.0 if n != 15 else 0.0

    def _demo_meters(self, now, phase):
        v, m = self.values, self.meters
        mix = 0.0
        for s in self.strips:
            sid = s["id"]
            if s["kind"] not in ("ch", "aux"):
                continue
            if not v[sid + ".name"]:
                m[sid] = [0.0, 1.0, 1.0]
                continue
            ph = phase[sid]
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
            if s["kind"] == "bus":
                lvl = mix * 0.7 * random.uniform(0.85, 1) if v[sid + ".name"] else 0.0
                m[sid] = [min(1.0, lvl * fader_gain(v[sid + ".fader"]) * 1.5), 1.0, 1.0]
        main = mix * fader_gain(v["main1.fader"]) if not v["main1.mute"] else 0.0
        m["main1"] = [min(1.0, main), 1.0, 1.0]

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


def discover(timeout=1.5):
    """Busca mesas WING en la red local (difusión "WING?" al puerto 2222)."""
    found = {}
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        s.settimeout(0.25)
        for _ in range(2):
            s.sendto(b"WING?", ("255.255.255.255", WING_INFO_PORT))
            end = time.time() + timeout / 2
            while time.time() < end:
                try:
                    data, (ip, _) = s.recvfrom(2048)
                except socket.timeout:
                    continue
                parts = data.decode("utf-8", "replace").strip("\0").split(",")
                if parts and parts[0] == "WING" and len(parts) >= 4:
                    found[ip] = {"ip": ip, "name": parts[2], "model": parts[3],
                                 "version": parts[5] if len(parts) > 5 else ""}
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
        self.cfg = {"mode": "demo", "ip": "", "scenes": [], "layout": {}}
        self._updates = {}
        self.load()

    # ---- configuración ----
    def load(self):
        try:
            self.cfg.update(json.loads(CONFIG_PATH.read_text(encoding="utf-8")))
        except (OSError, ValueError):
            pass
        if self.cfg.get("mode") not in ("demo", "wing"):      # configuración de versiones anteriores
            self.cfg["mode"] = "demo"
        self.cfg["scenes"] = [s for s in self.cfg.get("scenes", []) if s.get("model") == "wing"]

    def save(self):
        try:
            CONFIG_PATH.write_text(json.dumps(self.cfg, ensure_ascii=False), encoding="utf-8")
        except OSError:
            pass

    # ---- envío ----
    def status(self):
        m = self.mixer
        return {"t": "status", "mode": m.mode, "ip": m.ip, "connected": m.connected, "info": m.info,
                "meters": m.has_meters, "url": f"http://{lan_ip()}:{PORT}", "lastIp": self.cfg.get("ip", "")}

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
        return {"t": "scenes", "v": [{"name": s["name"], "time": s.get("time", "")} for s in self.cfg["scenes"]]}

    # ---- mensajes de la interfaz ----
    async def handle(self, client, msg):
        t = msg.get("t")
        m = self.mixer
        if t == "set":
            if m.set(msg.get("p"), msg.get("v")):
                self.broadcast({"t": "upd", "v": {msg["p"]: m.values[msg["p"]]}}, skip=client)
        elif t == "connect":
            mode, ip = msg.get("mode", "demo"), msg.get("ip", "")
            res = await m.connect(mode, ip)
            if res["ok"]:
                self.cfg["mode"] = mode
                if mode == "wing":
                    self.cfg["ip"] = ip
                self.save()
            client.send({"t": "connectResult", **res})
            self.broadcast(self.status())
            self.broadcast({"t": "state", "v": m.values})
        elif t == "discover":
            found = await asyncio.get_running_loop().run_in_executor(None, discover)
            client.send({"t": "found", "v": found})
        elif t == "sceneSave":
            name = " ".join(str(msg.get("name", "")).split())[:40] or f"Escena {len(self.cfg['scenes']) + 1}"
            sc = {"name": name, "time": time.strftime("%d/%m %H:%M"), "model": "wing", "values": m.snapshot()}
            for i, s in enumerate(self.cfg["scenes"]):
                if s["name"].lower() == name.lower():
                    self.cfg["scenes"][i] = sc
                    break
            else:
                self.cfg["scenes"].append(sc)
            self.save()
            self.broadcast(self.scenes())
        elif t == "sceneLoad":
            i = int(msg.get("i", -1))
            if 0 <= i < len(self.cfg["scenes"]):
                m.recall(self.cfg["scenes"][i]["values"])
                self.broadcast({"t": "state", "v": m.values})
        elif t == "sceneDelete":
            i = int(msg.get("i", -1))
            if 0 <= i < len(self.cfg["scenes"]):
                self.cfg["scenes"].pop(i)
                self.save()
                self.broadcast(self.scenes())
        elif t == "layout":
            self.cfg["layout"] = msg.get("v") or {}
            self.save()

    def welcome(self, client):
        m = self.mixer
        client.send({"t": "model", "strips": m.strips, "spec": m.spec})
        client.send(self.status())
        client.send({"t": "state", "v": m.values})
        client.send(self.scenes())
        client.send({"t": "layout", "v": self.cfg.get("layout", {})})

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
        server = await asyncio.start_server(self.serve_conn, "0.0.0.0", PORT)
        asyncio.ensure_future(self.mixer.tick())
        await self.mixer.connect(self.cfg["mode"], self.cfg.get("ip", ""))
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
    url = f"http://127.0.0.1:{PORT}"
    print(f"MB Soundtools · MBMix\n  En este ordenador: {url}\n  En el iPad (mismo Wi-Fi): http://{lan_ip()}:{PORT}")
    if "--server" in sys.argv:
        run_server()
        return
    ready = threading.Event()
    threading.Thread(target=run_server, args=(ready,), daemon=True).start()
    ready.wait(10)
    try:
        import webview  # pip install pywebview (opcional)
        webview.create_window("MB Soundtools · MBMix", url=url, width=1366, height=1024,
                              min_size=(1024, 700), background_color="#050505")
        webview.start()
    except ImportError:
        import webbrowser
        webbrowser.open(url)
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
