#!/usr/bin/env python3
"""
MB Soundtools · MBTune - Autotune propio en tiempo real para 2 canales (sin DAW, sin plugins).

Funciona con cualquier tarjeta de sonido con entradas y salidas
(ASIO, WASAPI, CoreAudio...): mesas como Behringer Wing, X32, Midas, interfaces USB.
Detecta la tarjeta, eliges 2 entradas y 2 salidas, y cada canal pasa por su propio afinador.

Requisitos:  Python 3.9+   ->   pip install numpy sounddevice pywebview
Ejecutar:    python mbtune.py

Algoritmo:
  - Detección de afinación: YIN (calculado con FFT).
  - Corrección: desplazador de tono por línea de retardo con dos cabezas
    de lectura cruzadas (baja latencia, ideal para correcciones pequeñas).
  - Cuantización a la nota más cercana de la tonalidad/escala elegida,
    con velocidad de corrección (0 ms = efecto "robot") e intensidad.
"""
import os
import sys
import json
import math
from pathlib import Path

os.environ.setdefault("SD_ENABLE_ASIO", "1")  # activa ASIO en Windows
# Python reparte el turno entre hilos cada 5 ms: el hilo de audio podía quedarse
# esperando a la interfaz más que lo que dura un buffer pequeño (32 muestras ≈ 0,7 ms)
sys.setswitchinterval(0.0005)
import numpy as np

try:
    import sounddevice as sd
    _SD_ERROR = None
except Exception as e:  # permite probar el DSP sin tarjeta de sonido
    sd = None
    _SD_ERROR = e

NOTE_NAMES = ["Do", "Do♯", "Re", "Mi♭", "Mi", "Fa", "Fa♯", "Sol", "La♭", "La", "Si♭", "Si"]
SCALES = {
    "Cromática": [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    "Mayor": [0, 2, 4, 5, 7, 9, 11],
    "Menor natural": [0, 2, 3, 5, 7, 8, 10],
    "Menor armónica": [0, 2, 3, 5, 7, 8, 11],
    "Pentatónica mayor": [0, 2, 4, 7, 9],
    "Pentatónica menor": [0, 3, 5, 7, 10],
}
CONFIG_PATH = Path.home() / ".mbtune.json"



def resource_path(rel):
    """Ruta a recursos, funciona en desarrollo y dentro del .exe/.app."""
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, rel)


def note_name(midi):
    m = int(round(midi))
    return f"{NOTE_NAMES[m % 12]}{m // 12 - 1}"


# ---------------------------------------------------------------- DSP ----
class YinDetector:
    """Detector de frecuencia fundamental YIN vectorizado."""

    def __init__(self, sr, fmin=70.0, fmax=1000.0, threshold=0.15):
        self.sr = sr
        self.threshold = threshold
        self.tau_min = max(2, int(sr / fmax))
        self.tau_max = int(sr / fmin)
        # ventana corta (2 periodos de la nota más grave): menos retraso en la detección,
        # alineada con el retardo del desplazador de tono
        self.N = 2 * self.tau_max + 2
        self.W = self.N - self.tau_max - 1
        self.nfft = 1 << int(math.ceil(math.log2(2 * self.N)))
        self.taus = np.arange(self.tau_max + 2)

    def detect(self, x, tau_max=None):
        """x: últimas muestras (al menos N). Devuelve frecuencia (Hz) o 0 si no hay tono.

        tau_max permite analizar una ventana más corta (y por tanto más reciente)
        cuando ya se conoce aproximadamente la nota: menos retraso en la corrección.
        """
        tmax = self.tau_max if tau_max is None else int(max(self.tau_min + 4, min(self.tau_max, tau_max)))
        N = 2 * tmax + 2
        x = x[-N:]
        W = N - tmax - 1
        nfft = 1 << int(math.ceil(math.log2(2 * N)))
        taus = np.arange(tmax + 2)
        X = np.fft.rfft(x, nfft)
        Y = np.fft.rfft(x[:W], nfft)
        corr = np.fft.irfft(np.conj(Y) * X, nfft)[: tmax + 2]
        e = np.concatenate(([0.0], np.cumsum(x * x)))
        d = e[W] + (e[taus + W] - e[taus]) - 2.0 * corr
        d[0] = 0.0
        cmnd = np.ones_like(d)
        cmnd[1:] = d[1:] * taus[1:] / np.maximum(np.cumsum(d[1:]), 1e-12)

        search = cmnd[self.tau_min: tmax + 1]
        # umbral relativo al mínimo global: evita confundir un armónico fuerte
        # (típico en vocales abiertas como la "a") con la nota real
        thr = min(self.threshold, float(search.min()) + 0.06)
        below = np.nonzero(search < thr)[0]
        if below.size == 0:
            return 0.0
        t = int(below[0]) + self.tau_min
        while t + 1 <= tmax and cmnd[t + 1] < cmnd[t]:
            t += 1
        a, b, c = cmnd[t - 1], cmnd[t], cmnd[t + 1]
        den = a - 2 * b + c
        shift = 0.5 * (a - c) / den if abs(den) > 1e-12 else 0.0
        return self.sr / (t + shift)


class PitchShifter:
    """Desplazador de tono por línea de retardo con empalmes sincronizados al periodo.

    Un único cabezal de lectura recorre la línea de retardo a velocidad `ratio`.
    Cuando llega al límite, salta un número entero de periodos de la voz y se
    funde (4 ms) con la posición anterior: como ambas lecturas están en fase,
    el empalme no suena y no aparece el típico efecto "flanger" de otros
    desplazadores sencillos.
    """

    def __init__(self, sr, window_ms=20.0, fade_ms=4.0):
        self.W = max(32, int(sr * window_ms / 1000.0))   # "Mín" = solo lo que exige el periodo de la voz
        self.B = 1 << int(math.ceil(math.log2(self.W * 4 + sr // 20)))
        self.buf = np.zeros(self.B)
        self.w = 0
        self.fade_len = max(16, int(sr * fade_ms / 1000.0))
        self.margin = int(0.08 * self.fade_len) + 3   # lo máximo que se mueve el cabezal durante un fundido
        self.lo = 2.0
        self.d = self.W / 2.0          # retardo del cabezal activo (muestras)
        self.old = None                # retardo del cabezal saliente durante un fundido
        self.fade_pos = 0

    def _read(self, pos):
        i0 = np.floor(pos)
        frac = pos - i0
        i0 = i0.astype(np.int64)
        a = self.buf[i0 & (self.B - 1)]
        b = self.buf[(i0 + 1) & (self.B - 1)]
        return a + (b - a) * frac

    def _jump(self, rate, period):
        T = period if period else self.W / 2.0
        hi = max(float(self.W), self.lo + T + 2 * self.margin + 1)
        if rate < 0:   # el retardo baja (subir tono): saltar hacia atrás m periodos
            m = max(1, int((hi - self.d) // T))
            new = self.d + m * T
        else:          # el retardo sube (bajar tono): saltar hacia delante m periodos
            m = max(1, int((self.d - self.lo - self.margin) // T))
            new = max(self.lo + self.margin, self.d - m * T)
        self.old, self.d, self.fade_pos = self.d, new, 0

    def process(self, x, ratio, period=None):
        n = len(x)
        self.buf[(self.w + np.arange(n)) & (self.B - 1)] = x
        rate = 1.0 - ratio            # variación del retardo por muestra
        hi = max(float(self.W), self.lo + (period or 0) + 2 * self.margin + 1)
        y = np.empty(n)
        i = 0
        while i < n:
            seg = n - i
            if self.old is not None:
                seg = min(seg, self.fade_len - self.fade_pos)
            elif rate < 0:
                seg = min(seg, max(1, int((self.d - (self.lo + self.margin)) / -rate)))
            elif rate > 0:
                seg = min(seg, max(1, int((hi - self.d) / rate)))
            k = np.arange(1, seg + 1)
            now = self.w + i + k - 1
            dd = self.d + rate * k
            out = self._read(now - dd)
            if self.old is not None:
                g = 0.5 - 0.5 * np.cos(np.pi * (self.fade_pos + k) / self.fade_len)
                out = g * out + (1.0 - g) * self._read(now - (self.old + rate * k))
                self.old += rate * seg
                self.fade_pos += seg
                if self.fade_pos >= self.fade_len:
                    self.old = None
            y[i:i + seg] = out
            self.d += rate * seg
            i += seg
            if self.old is None and ((rate < 0 and self.d <= self.lo + self.margin) or (rate > 0 and self.d >= hi)):
                self._jump(rate, period)
        self.w = (self.w + n) & (self.B - 1)
        return y


class TuneChannel:
    """Un canal de autotune: entrada -> detección -> corrección -> salida."""

    def __init__(self, name, in_ch, out_ch):
        self.name = name
        self.in_ch = in_ch          # 1-based
        self.out_ch = out_ch        # 1-based
        self.enabled = True
        self.bypass = False
        self.key = 0                # 0 = Do
        self.scale = "Cromática"
        self.speed_ms = 20.0        # 0 = robot
        self.amount = 1.0           # 0..1
        self.notes = None           # None = notas de la tonalidad; o lista de 12 (0/1) Do..Si
        self.humanize = 0.0         # 0..100: en notas largas deja pasar el vibrato natural
        self._hold = 0.0            # segundos que lleva la nota actual
        self.gate = 10 ** (-50 / 20)
        # estado / pantalla
        self.cur_semi = 0.0
        self.last_note = None
        self.detected_midi = None
        self.target_note = None
        self.sr = None
        self.level = 0.0

    def setup(self, sr, window_ms=20.0):
        self.sr = sr
        self.detector = YinDetector(sr)
        self.shifter = PitchShifter(sr, window_ms)
        self.hist = np.zeros(self.detector.N)
        self.cur_semi = 0.0
        self.last_note = None
        self.hop = int(sr * 0.004)      # se detecta la nota cada 4 ms aunque el buffer sea menor
        self._since = self.hop
        self._f0 = 0.0
        self._target = 0.0

    def allowed_notes(self):
        """Notas (0=Do..11=Si) a las que se corrige: las de la tonalidad o las elegidas a mano."""
        if self.notes and any(self.notes):
            return {i for i in range(12) if self.notes[i]}
        return {(self.key + i) % 12 for i in SCALES.get(self.scale, SCALES["Cromática"])}

    def nearest_note(self, midi):
        allowed = self.allowed_notes()
        ln = self.last_note
        if ln is not None and abs(midi - ln) < 0.6 and ln % 12 in allowed:
            return ln  # histéresis: evita saltos entre notas vecinas
        best, best_d = None, 99.0
        for nn in range(int(math.floor(midi)) - 7, int(math.ceil(midi)) + 8):
            if nn % 12 in allowed and abs(nn - midi) < best_d:
                best, best_d = nn, abs(nn - midi)
        return best

    def process(self, x):
        n = len(x)
        N = self.detector.N
        self.level = max(float(np.max(np.abs(x))), self.level * 0.85)
        # historial fijo desplazado en su sitio: no se crea memoria nueva en cada bloque
        if n >= N:
            self.hist[:] = x[-N:]
        else:
            self.hist[:-n] = self.hist[n:]
            self.hist[-n:] = x
        self._since += n
        if self._since >= self.hop:     # con buffers pequeños no se analiza en cada bloque
            self._since = 0
            f0 = 0.0
            if np.sqrt(np.mean(self.hist[-1024:] ** 2)) > self.gate:
                if self._f0 > 0:
                    # ya hay nota: ventana corta (≈1,7 periodos), más reciente → menos retraso
                    f0 = self.detector.detect(self.hist, 1.7 * self.sr / self._f0)
                    if f0 <= 0 or abs(math.log2(f0 / self._f0)) > 0.25:
                        f0 = self.detector.detect(self.hist)   # salto grande: análisis completo
                else:
                    f0 = self.detector.detect(self.hist)
            if f0 > 0:
                midi = 69.0 + 12.0 * math.log2(f0 / 440.0)
                note = self.nearest_note(midi)
                self._hold = self._hold + self.hop / self.sr if note == self.last_note else 0.0
                self.last_note = note
                self.detected_midi = midi
                self.target_note = note
                self._target = (note - midi) * self.amount
            else:
                self.last_note = None
                self._hold = 0.0
                self.detected_midi = None
                self.target_note = None
                self._target = 0.0
            self._f0 = f0
        f0, target = self._f0, self._target
        # Humanizar: en una nota sostenida la corrección se vuelve más lenta poco a poco,
        # así el vibrato y los matices de la voz se conservan; los cambios de nota siguen rápidos
        speed = self.speed_ms
        if self.humanize > 0:
            speed += (self.humanize / 100.0) * 250.0 * min(1.0, max(0.0, (self._hold - 0.12) / 0.25))
        if speed <= 0:
            alpha = 1.0
        else:
            alpha = 1.0 - math.exp(-(n / self.sr) / (speed / 1000.0))
        self.cur_semi += alpha * (target - self.cur_semi)
        y = self.shifter.process(x, 2.0 ** (self.cur_semi / 12.0), self.sr / f0 if f0 > 0 else None)
        return x if self.bypass else y


# ------------------------------------------------------------ MOTOR ----
def _notes(v):
    if v is None:
        return None
    m = [1 if x else 0 for x in list(v)[:12]]
    return m if len(m) == 12 and any(m) else None


CH_PARAMS = {"enabled": bool, "bypass": bool, "in_ch": int, "out_ch": int,
             "key": int, "scale": str, "speed_ms": float, "amount": float, "notes": _notes,
             "humanize": float}


PRESET_KEYS = ["enabled", "bypass", "key", "scale", "speed_ms", "amount", "notes", "humanize"]


class Engine:
    """Gestiona la tarjeta de sonido, los 2 canales y la configuración."""

    def __init__(self):
        self.channels = [TuneChannel("Voz 1", 1, 1), TuneChannel("Voz 2", 2, 2)]
        self.audio = {"in": "", "out": "", "sr": 48000, "bs": 64, "win": 1}
        self.stream = None
        self.error = None
        self.in_peaks = np.zeros(0)  # nivel de cada entrada de la tarjeta (diagnóstico)
        self.presets = []        # canciones guardadas: {"name", "channels": [...]}
        self.current = None      # índice de la canción cargada
        self.load()

    # dispositivos ---------------------------------------------------------
    def devices(self, rescan=False):
        if sd is None:
            return {"error": f"No se pudo cargar sounddevice: {_SD_ERROR}", "inputs": [], "outputs": []}
        if rescan and self.stream is None:
            # PortAudio solo lee la lista de tarjetas al arrancar: se reinicia para
            # detectar una tarjeta conectada o encendida después de abrir MBTune
            try:
                sd._terminate()
                sd._initialize()
            except Exception:
                pass
        devs, apis = sd.query_devices(), sd.query_hostapis()
        res = {"inputs": [], "outputs": []}
        for i, d in enumerate(devs):
            api = apis[d["hostapi"]]["name"]
            for kind, key in (("inputs", "max_input_channels"), ("outputs", "max_output_channels")):
                if d[key] > 0:
                    res[kind].append({"key": f"{api}::{d['name']}", "name": d["name"], "api": api,
                                      "channels": d[key], "asio": "ASIO" in api})
        for kind in res:
            res[kind].sort(key=lambda x: (not x["asio"], x["api"], x["name"]))
        return res

    def _resolve(self, key, kind):
        devs, apis = sd.query_devices(), sd.query_hostapis()
        field = "max_input_channels" if kind == "in" else "max_output_channels"
        for i, d in enumerate(devs):
            if d[field] > 0 and f"{apis[d['hostapi']]['name']}::{d['name']}" == key:
                return i, d[field]
        raise RuntimeError("Dispositivo no encontrado. Conéctalo y vuelve a elegirlo.")

    @staticmethod
    def _low_latency_settings(in_dev, out_dev):
        """En Mac, permite a PortAudio poner la tarjeta al buffer y la frecuencia elegidos.
        Sin esto CoreAudio mantiene el buffer que tenga la tarjeta (a menudo 512)."""
        apis = sd.query_hostapis()
        is_ca = ["Core Audio" in apis[sd.query_devices(d)["hostapi"]]["name"] for d in (in_dev, out_dev)]
        if not any(is_ca):
            return None
        return tuple(sd.CoreAudioSettings(change_device_parameters=True) if ca else None for ca in is_ca)

    # audio ----------------------------------------------------------------
    def _callback(self, indata, outdata, frames, time_info, status):
        outdata.fill(0)
        try:
            pk = np.max(np.abs(indata), axis=0)
            if self.in_peaks.shape != pk.shape:
                self.in_peaks = pk.astype(np.float64)
            else:
                self.in_peaks = np.maximum(pk, self.in_peaks * 0.8)
            for ch in self.channels:
                if not ch.enabled:
                    continue
                i, o = ch.in_ch - 1, ch.out_ch - 1
                if i >= indata.shape[1] or o >= outdata.shape[1]:
                    continue
                outdata[:, o] += ch.process(indata[:, i].astype(np.float64)).astype(np.float32)
            np.clip(outdata, -1.0, 1.0, out=outdata)
        except Exception as e:  # nunca detener el audio por un error puntual
            self.error = str(e)

    def start(self, audio=None):
        if sd is None:
            return {"ok": False, "msg": f"Falta sounddevice: {_SD_ERROR}"}
        if audio:
            self.audio.update(audio)
        self.stop()
        try:
            in_dev, nin = self._resolve(self.audio["in"], "in")
            out_dev, nout = self._resolve(self.audio["out"], "out")
            nin, nout = min(nin, 64), min(nout, 64)
            sr, bs, win = int(self.audio["sr"]), int(self.audio["bs"]), float(self.audio["win"])
            for ch in self.channels:
                ch.setup(sr, win)
            opts = dict(device=(in_dev, out_dev), samplerate=sr, blocksize=bs,
                        dtype="float32", channels=(nin, nout), latency=bs / sr,
                        callback=self._callback)
            extra = self._low_latency_settings(in_dev, out_dev)
            try:
                self.stream = sd.Stream(extra_settings=extra, **opts)
            except Exception:
                if extra is None:
                    raise
                self.stream = sd.Stream(**opts)   # tarjeta que no deja cambiar su buffer
            self.stream.start()
            lat_in, lat_out = self.stream.latency
            self.save()
            # retardo medio del afinador: la mitad del recorrido del cabezal
            # (como mínimo un periodo de una voz de ~150 Hz más los márgenes)
            sh = self.channels[0].shifter
            span = max(sh.W, sh.lo + sr / 150.0 + 2 * sh.margin + 1)
            proc_ms = (sh.lo + sh.margin + span) / 2 / sr * 1000
            return {"ok": True, "nin": nin, "nout": nout,
                    "latency": round((lat_in + lat_out) * 1000 + proc_ms, 1)}
        except Exception as e:
            self.stream = None
            return {"ok": False, "msg": f"No se pudo abrir el audio: {e}. "
                                        "Con ASIO elige el MISMO dispositivo en entrada y salida."}

    def stop(self):
        if self.stream is not None:
            try:
                self.stream.stop()
                self.stream.close()
            finally:
                self.stream = None

    def state(self):
        running = self.stream is not None
        out = {"running": running, "error": self.error, "channels": [],
               "inputs": [round(float(v), 4) for v in self.in_peaks] if running else []}
        self.error = None
        for ch in self.channels:
            if ch.detected_midi is not None and ch.target_note is not None:
                out["channels"].append({"note": note_name(ch.detected_midi), "target": note_name(ch.target_note),
                                        "cents": round((ch.detected_midi - ch.target_note) * 100, 1),
                                        "level": round(ch.level, 3)})
            else:
                out["channels"].append({"note": None, "level": round(ch.level, 3)})
        return out

    # parámetros y configuración -------------------------------------------
    def set_param(self, idx, name, value):
        if name in CH_PARAMS and 0 <= int(idx) < len(self.channels):
            setattr(self.channels[int(idx)], name, CH_PARAMS[name](value))

    def set_audio(self, audio):
        self.audio.update({k: v for k, v in audio.items() if k in self.audio})

    def config(self):
        return {"audio": dict(self.audio),
                "channels": [{k: getattr(ch, k) for k in CH_PARAMS} for ch in self.channels]}

    # canciones guardadas --------------------------------------------------
    def presets_info(self):
        return {"presets": self.presets, "current": self.current}

    def save_preset(self, name):
        name = " ".join(str(name).split())[:60]
        if not name:
            return {"ok": False, "msg": "Escribe un nombre para guardar la canción."}
        data = {"name": name, "channels": [{k: getattr(ch, k) for k in PRESET_KEYS} for ch in self.channels]}
        for i, pr in enumerate(self.presets):
            if pr["name"].lower() == name.lower():
                self.presets[i] = data
                self.current = i
                break
        else:
            self.presets.append(data)
            self.current = len(self.presets) - 1
        self.save()
        return {"ok": True, **self.presets_info()}

    def apply_preset(self, idx):
        idx = int(idx)
        if not 0 <= idx < len(self.presets):
            return {"ok": False, "msg": "Esa canción ya no existe."}
        for i, chcfg in enumerate(self.presets[idx]["channels"][:len(self.channels)]):
            self.set_param(i, "notes", None)
            for k, v in chcfg.items():
                if k in PRESET_KEYS:
                    self.set_param(i, k, v)
        self.current = idx
        self.save()
        return {"ok": True, "config": self.config(), **self.presets_info()}

    def delete_preset(self, idx):
        idx = int(idx)
        if 0 <= idx < len(self.presets):
            self.presets.pop(idx)
            if self.current == idx:
                self.current = None
            elif self.current is not None and self.current > idx:
                self.current -= 1
            self.save()
        return {"ok": True, **self.presets_info()}

    def move_preset(self, idx, delta):
        idx, j = int(idx), int(idx) + int(delta)
        if 0 <= idx < len(self.presets) and 0 <= j < len(self.presets):
            self.presets[idx], self.presets[j] = self.presets[j], self.presets[idx]
            if self.current == idx:
                self.current = j
            elif self.current == j:
                self.current = idx
            self.save()
        return {"ok": True, **self.presets_info()}

    def save(self):
        try:
            data = {**self.config(), "presets": self.presets, "current": self.current}
            CONFIG_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        except OSError:
            pass

    def load(self):
        try:
            cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
            self.set_audio(cfg.get("audio", {}))
            for i, chcfg in enumerate(cfg.get("channels", [])[:2]):
                for k, v in chcfg.items():
                    self.set_param(i, k, v)
            self.presets = [p for p in cfg.get("presets", []) if isinstance(p, dict) and p.get("name")]
            cur = cfg.get("current")
            self.current = cur if isinstance(cur, int) and 0 <= cur < len(self.presets) else None
        except (OSError, ValueError, TypeError):
            pass


class Api:
    """Funciones que la interfaz (HTML) puede llamar."""

    def __init__(self):
        self._engine = Engine()

    def get_devices(self, rescan=False):
        return self._engine.devices(bool(rescan))

    def get_config(self):
        return self._engine.config()

    def set_param(self, idx, name, value):
        self._engine.set_param(idx, name, value)

    def set_audio(self, audio):
        self._engine.set_audio(audio)

    def start(self, audio):
        return self._engine.start(audio)

    def stop(self):
        self._engine.stop()
        self._engine.save()
        return {"ok": True}

    def get_state(self):
        return self._engine.state()

    def get_presets(self):
        return self._engine.presets_info()

    def save_preset(self, name):
        return self._engine.save_preset(name)

    def apply_preset(self, idx):
        return self._engine.apply_preset(idx)

    def delete_preset(self, idx):
        return self._engine.delete_preset(idx)

    def move_preset(self, idx, delta):
        return self._engine.move_preset(idx, delta)


# -------------------------------------------------------------- APP ----
def run_app():
    import webview  # pip install pywebview

    api = Api()
    window = webview.create_window(
        "MB Soundtools · MBTune", url=resource_path("assets/ui.html"), js_api=api,
        width=1220, height=1000, min_size=(960, 700), background_color="#0a0a0b")

    def on_closing():
        api._engine.stop()
        api._engine.save()

    window.events.closing += on_closing
    webview.start()


if __name__ == "__main__":
    run_app()
