#!/usr/bin/env python3
"""
MB Soundtools · MBMix - Control remoto de mesas digitales (estilo Mixing Station).

Un pequeño servidor en tu ordenador habla con la mesa por la red (OSC/UDP)
y sirve la interfaz táctil: ábrela en el iPad con Safari en la dirección que
muestra la app (mismo Wi-Fi), o en la ventana del propio ordenador.

Mesas:  Behringer X32 / Midas M32 (todas las versiones)  ·  Demo (sin mesa)

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


# ------------------------------------------------------- MODELO X32 ----
EQ_TYPES = 6  # LCut, LShv, PEQ, VEQ, HShv, HCut


def build_x32():
    """Lista de tiras (canales, buses...) y de parámetros {ruta OSC: (tipo, valor por defecto)}.

    Los valores se guardan tal y como los usa la X32 (casi todo normalizado 0..1);
    la interfaz los convierte a dB, Hz, ms...
    """
    strips, params = [], {}

    def p(path, typ, default):
        params[path] = (typ, default)

    def strip(sid, kind, label, base, solo, *, eq=0, gate=False, dyn=False, sends=False, pan=True,
              headamp=None, trim=False, name="", color=0):
        strips.append({"id": sid, "kind": kind, "label": label, "base": base, "solo": solo, "eq": eq,
                       "gate": gate, "dyn": dyn, "sends": sends, "pan": pan, "headamp": headamp, "trim": trim})
        p(f"{base}/config/name", "s", name)
        p(f"{base}/config/color", "i", color)
        if kind == "dca":
            p(f"{base}/fader", "f", 0.75)
            p(f"{base}/on", "i", 1)
            return
        p(f"{base}/mix/fader", "f", 0.0 if kind in ("ch", "auxin", "fxrtn", "mtx") else 0.75)
        p(f"{base}/mix/on", "i", 1)
        if pan:
            p(f"{base}/mix/pan", "f", 0.5)
        if headamp is not None:
            h = f"/headamp/{headamp:03d}"
            p(f"{h}/gain", "f", 0.5)       # -12..+60 dB
            p(f"{h}/phantom", "i", 0)
        if trim:
            p(f"{base}/preamp/trim", "f", 0.5)   # -18..+18 dB
        if kind in ("ch", "auxin"):
            p(f"{base}/preamp/invert", "i", 0)
        if kind == "ch":
            p(f"{base}/preamp/hpon", "i", 0)
            p(f"{base}/preamp/hpf", "f", 0.25)   # 20..400 Hz
        if gate:
            for k, t, d in (("on", "i", 0), ("mode", "i", 3), ("thr", "f", 0.5), ("range", "f", 0.5),
                            ("attack", "f", 0.0), ("hold", "f", 0.5), ("release", "f", 0.5)):
                p(f"{base}/gate/{k}", t, d)
        if dyn:
            for k, t, d in (("on", "i", 0), ("thr", "f", 0.75), ("ratio", "i", 3), ("knee", "f", 0.2),
                            ("mgain", "f", 0.0), ("attack", "f", 0.083), ("hold", "f", 0.5),
                            ("release", "f", 0.5), ("mix", "f", 1.0), ("auto", "i", 0)):
                p(f"{base}/dyn/{k}", t, d)
        if eq:
            p(f"{base}/eq/on", "i", 0)
            freqs = [0.2, 0.4, 0.6, 0.8] if eq == 4 else [0.15, 0.3, 0.45, 0.6, 0.75, 0.9]
            for b in range(1, eq + 1):
                typ = 1 if b == 1 else 4 if b == eq else 2
                p(f"{base}/eq/{b}/type", "i", typ)
                p(f"{base}/eq/{b}/f", "f", freqs[b - 1])
                p(f"{base}/eq/{b}/g", "f", 0.5)
                p(f"{base}/eq/{b}/q", "f", 0.4648)   # Q 2.0
        if sends:
            for b in range(1, 17):
                p(f"{base}/mix/{b:02d}/on", "i", 1)
                p(f"{base}/mix/{b:02d}/level", "f", 0.0)

    for n in range(1, 33):
        strip(f"ch{n}", "ch", f"Ch {n:02d}", f"/ch/{n:02d}", n, eq=4, gate=True, dyn=True, sends=True,
              headamp=n - 1, name="", color=0)
    for n in range(1, 9):
        strip(f"aux{n}", "auxin", f"Aux {n}", f"/auxin/{n:02d}", 32 + n, eq=4, sends=True, trim=True, color=0)
    for n in range(1, 9):
        strip(f"fx{n}", "fxrtn", f"FX {n}", f"/fxrtn/{n:02d}", 40 + n, eq=4, sends=True, color=0)
    for n in range(1, 17):
        strip(f"bus{n}", "bus", f"Bus {n:02d}", f"/bus/{n:02d}", 48 + n, eq=6, dyn=True, color=0)
    for n in range(1, 7):
        strip(f"mtx{n}", "mtx", f"Mtx {n}", f"/mtx/{n:02d}", 64 + n, eq=6, dyn=True, pan=False, color=0)
    strip("lr", "main", "Main LR", "/main/st", 71, eq=6, dyn=True, color=7, name="Main")
    strip("mono", "main", "M/C", "/main/m", 72, eq=6, dyn=True, pan=False, color=7, name="Mono")
    for n in range(1, 9):
        strip(f"dca{n}", "dca", f"DCA {n}", f"/dca/{n}", 72 + n, pan=False, color=0)

    for s in strips:
        p(f"/-stat/solosw/{s['solo']:02d}", "i", 0)
    for g in range(1, 7):
        p(f"/config/mute/{g}", "i", 0)
    return strips, params


# Nombres y colores de ejemplo para el modo demo
DEMO_NAMES = {
    "ch1": ("Bombo", 1), "ch2": ("Caja", 1), "ch3": ("Charles", 1), "ch4": ("Tom 1", 1), "ch5": ("Tom 2", 1),
    "ch6": ("Floor", 1), "ch7": ("OH L", 1), "ch8": ("OH R", 1), "ch9": ("Bajo", 4), "ch10": ("Guitarra 1", 3),
    "ch11": ("Guitarra 2", 3), "ch12": ("Teclado L", 5), "ch13": ("Teclado R", 5), "ch14": ("Acústica", 3),
    "ch15": ("Voz MB", 6), "ch16": ("Coro 1", 2), "ch17": ("Coro 2", 2), "ch18": ("Coro 3", 2),
    "aux1": ("PC L/R", 7), "fx1": ("Reverb", 5), "fx2": ("Delay", 5),
    "bus1": ("Mon Batería", 1), "bus2": ("Mon Bajo", 4), "bus3": ("Mon Guitarra", 3), "bus4": ("Mon Voz", 6),
    "bus5": ("IEM MB L", 2), "bus6": ("IEM MB R", 2), "dca1": ("Batería", 1), "dca2": ("Voces", 6),
    "dca3": ("Banda", 3), "dca4": ("FX", 5),
}


# ------------------------------------------------------------ MESA ----
class Mixer:
    """Estado de la mesa + conexión. En modo demo se simula todo."""

    def __init__(self, hub):
        self.hub = hub
        self.strips, self.params = build_x32()
        self.values = {k: v[1] for k, v in self.params.items()}
        self.mode = "offline"        # offline / demo / x32
        self.ip = ""
        self.info = ""
        self.connected = False
        self.transport = None
        self.last_rx = 0.0
        self.meters = {s["id"]: [0.0, 1.0, 1.0] for s in self.strips}   # nivel, GR puerta, GR compresor
        self._pending = []

    # ---- red ----
    async def connect(self, mode, ip=""):
        await self.disconnect()
        self.mode, self.ip = mode, ip.strip()
        self.values = {k: v[1] for k, v in self.params.items()}
        if mode == "demo":
            for sid, (name, color) in DEMO_NAMES.items():
                base = self.strip(sid)["base"]
                self.values[f"{base}/config/name"] = name
                self.values[f"{base}/config/color"] = color
            for s in self.strips:
                if s["kind"] in ("ch", "auxin", "fxrtn") and self.values[f"{s['base']}/config/name"]:
                    self.values[f"{s['base']}/mix/fader"] = 0.75 if s["kind"] == "ch" else 0.6
                    self.values[f"{s['base']}/eq/on"] = 1
                    if s["kind"] == "ch":
                        self.values[f"{s['base']}/dyn/on"] = 1
            self.connected, self.info = True, "Mesa de demostración (X32)"
            return {"ok": True}
        if mode != "x32":
            self.connected = False
            return {"ok": True}
        if not self.ip:
            return {"ok": False, "msg": "Escribe la IP de la mesa."}
        loop = asyncio.get_running_loop()
        try:
            self.transport, _ = await loop.create_datagram_endpoint(
                lambda: _OscProtocol(self), remote_addr=(self.ip, 10023))
        except OSError as e:
            return {"ok": False, "msg": f"No se pudo abrir la conexión: {e}"}
        self.send("/xinfo")
        for _ in range(30):                       # espera la respuesta (3 s)
            await asyncio.sleep(0.1)
            if self.connected:
                break
        if not self.connected:
            self.transport.close()
            self.transport = None
            return {"ok": False, "msg": f"La mesa no responde en {self.ip}. Comprueba la IP y que esté en la misma red."}
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
        self.send("/xremote")                    # recibir los cambios hechos en la mesa o en otras apps
        for page in ("/meters/1", "/meters/2", "/meters/3"):
            self.send("/meters", page)

    async def _query_all(self):
        """Pide a la mesa el valor de todos los parámetros (unos 2.500)."""
        for i, path in enumerate(list(self.params)):
            if self.transport is None:
                return
            self.send(path)
            if i % 40 == 39:
                await asyncio.sleep(0.02)
        await asyncio.sleep(0.5)
        self.hub.broadcast({"t": "state", "v": self.values})

    def on_osc(self, addr, args):
        self.last_rx = time.time()
        if addr == "/xinfo" and len(args) >= 4:
            self.connected = True
            self.info = f"{args[2]} · {args[1]} · v{args[3]}"
            return
        if addr.startswith("/meters/") and args and isinstance(args[0], bytes):
            self._meters(addr, args[0])
            return
        if addr in self.params and args:
            v = args[0]
            if isinstance(v, bytes):
                return
            self.values[addr] = v
            self.hub.queue_update(addr, v)

    def _meters(self, addr, blob):
        try:
            n = struct.unpack("<i", blob[:4])[0]
            vals = struct.unpack(f"<{n}f", blob[4:4 + 4 * n])
        except struct.error:
            return
        m = self.meters
        if addr == "/meters/1" and n >= 96:
            for i in range(32):
                m[f"ch{i + 1}"] = [vals[i], vals[32 + i], vals[64 + i]]
        elif addr == "/meters/2" and n >= 49:
            for i in range(16):
                m[f"bus{i + 1}"] = [vals[i], 1.0, vals[25 + i]]
            for i in range(6):
                m[f"mtx{i + 1}"] = [vals[16 + i], 1.0, vals[41 + i]]
            m["lr"] = [max(vals[22], vals[23]), 1.0, vals[47]]
            m["mono"] = [vals[24], 1.0, vals[48]]
        elif addr == "/meters/3" and n >= 22:
            for i in range(8):
                m[f"aux{i + 1}"] = [vals[6 + i], 1.0, 1.0]
                m[f"fx{i + 1}"] = [vals[14 + i], 1.0, 1.0]

    # ---- parámetros ----
    def strip(self, sid):
        return next(s for s in self.strips if s["id"] == sid)

    def set(self, path, value):
        if path not in self.params:
            return False
        typ = self.params[path][0]
        try:
            v = float(value) if typ == "f" else int(value) if typ == "i" else str(value)[:12]
        except (TypeError, ValueError):
            return False
        if typ == "f":
            v = min(1.0, max(0.0, v))
        self.values[path] = v
        if self.mode == "x32":
            self.send(path, v)
        return True

    # ---- tareas periódicas ----
    async def tick(self):
        """Mantiene viva la suscripción y simula los vúmetros en el modo demo."""
        last_sub = 0.0
        phase = {s["id"]: random.random() * 10 for s in self.strips}
        while True:
            await asyncio.sleep(0.05)
            now = time.time()
            if self.mode == "x32" and self.transport is not None:
                if now - last_sub > 8:
                    self._subscribe()
                    last_sub = now
                if self.connected and now - self.last_rx > 12:
                    self.connected = False
                    self.hub.broadcast(self.hub.status())
                elif not self.connected and now - self.last_rx < 2:
                    self.connected = True
                    self.hub.broadcast(self.hub.status())
            elif self.mode == "demo":
                self._demo_meters(now, phase)
            if self.hub.clients:
                self.hub.send_meters()

    def _demo_meters(self, now, phase):
        v, m = self.values, self.meters
        mix = 0.0
        for s in self.strips:
            if s["kind"] not in ("ch", "auxin", "fxrtn"):
                continue
            base = s["base"]
            if not v[f"{base}/config/name"]:
                m[s["id"]] = [0.0, 1.0, 1.0]
                continue
            ph = phase[s["id"]]
            env = 0.5 + 0.5 * math.sin(now * (1.3 + ph % 1.7) + ph)
            hit = abs(math.sin(now * (2 + ph % 3) + ph)) ** 6
            lvl = min(1.0, (0.08 + 0.35 * env + 0.4 * hit) * (0.6 + 0.4 * random.random()))
            gr_dyn = 1.0
            if s["dyn"] and v[f"{base}/dyn/on"]:
                thr = 10 ** ((-60 + 60 * v[f"{base}/dyn/thr"]) / 20)
                if lvl > thr:
                    gr_dyn = max(0.1, (thr / lvl) ** 0.6)
            m[s["id"]] = [lvl, 1.0, gr_dyn]
            if v[f"{base}/mix/on"]:
                mix = max(mix, lvl * x32_fader_gain(v[f"{base}/mix/fader"]))
        for s in self.strips:
            if s["kind"] == "bus":
                lvl = mix * 0.7 * random.uniform(0.85, 1) if v[f"{s['base']}/config/name"] else 0.0
                m[s["id"]] = [lvl * x32_fader_gain(v[f"{s['base']}/mix/fader"]) * 1.5, 1.0, 1.0]
        main = mix * x32_fader_gain(v["/main/st/mix/fader"]) if v["/main/st/mix/on"] else 0.0
        m["lr"] = [min(1.0, main), 1.0, 1.0]
        m["mono"] = [min(1.0, main * 0.8) * v["/main/m/mix/on"], 1.0, 1.0]

    # ---- escenas ----
    def snapshot(self):
        return {k: v for k, v in self.values.items() if not k.startswith("/-stat/")}

    def recall(self, values):
        for k, v in values.items():
            if k in self.params:
                self.set(k, v)


def x32_fader_db(f):
    if f >= 0.5:
        return f * 40 - 30
    if f >= 0.25:
        return f * 80 - 50
    if f >= 0.0625:
        return f * 160 - 70
    return f * 480 - 90 if f > 0 else -144.0


def x32_fader_gain(f):
    return 10 ** (x32_fader_db(f) / 20)


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
    """Busca mesas X32/M32 en la red local (difusión /xinfo)."""
    found = {}
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        s.settimeout(0.25)
        for _ in range(2):
            s.sendto(osc_encode("/xinfo"), ("255.255.255.255", 10023))
            end = time.time() + timeout / 2
            while time.time() < end:
                try:
                    data, (ip, _) = s.recvfrom(2048)
                except socket.timeout:
                    continue
                msg = osc_decode(data)
                if msg and msg[0] == "/xinfo" and len(msg[1]) >= 4:
                    found[ip] = {"ip": ip, "name": msg[1][1], "model": msg[1][2], "version": msg[1][3]}
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

    def save(self):
        try:
            CONFIG_PATH.write_text(json.dumps(self.cfg, ensure_ascii=False), encoding="utf-8")
        except OSError:
            pass

    # ---- envío ----
    def status(self):
        m = self.mixer
        return {"t": "status", "mode": m.mode, "ip": m.ip, "connected": m.connected, "info": m.info,
                "url": f"http://{lan_ip()}:{PORT}", "lastIp": self.cfg.get("ip", "")}

    def broadcast(self, obj, skip=None):
        for c in list(self.clients):
            if c is not skip:
                c.send(obj)

    def queue_update(self, path, value):
        self._updates[path] = value

    def send_meters(self):
        if self._updates:
            self.broadcast({"t": "upd", "v": self._updates})
            self._updates = {}
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
                if mode == "x32":
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
            sc = {"name": name, "time": time.strftime("%d/%m %H:%M"), "values": m.snapshot()}
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
        client.send({"t": "model", "strips": m.strips, "types": {k: v[0] for k, v in m.params.items()},
                     "defaults": {k: v[1] for k, v in m.params.items()}})
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
        mode = self.cfg.get("mode", "demo")
        await self.mixer.connect(mode, self.cfg.get("ip", "")) if mode in ("demo", "x32") else None
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
