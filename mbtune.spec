# -*- mode: python ; coding: utf-8 -*-
# PyInstaller: genera MBTune.exe (Windows) o MBTune.app (macOS)
import sys
from PyInstaller.utils.hooks import collect_data_files

datas = [("assets", "assets")]
try:
    datas += collect_data_files("_sounddevice_data")  # PortAudio (+ASIO en Windows)
except Exception:
    pass

a = Analysis(["mbtune.py"], pathex=[], datas=datas, hiddenimports=[], excludes=[])
pyz = PYZ(a.pure)

if sys.platform == "darwin":
    exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="MBTune",
              console=False, icon="assets/icon.icns")
    coll = COLLECT(exe, a.binaries, a.datas, name="MBTune")
    app = BUNDLE(
        coll, name="MBTune.app", icon="assets/icon.icns",
        bundle_identifier="com.mbsoundtools.mbtune",
        info_plist={
            "CFBundleDisplayName": "MBTune",
            "CFBundleShortVersionString": "1.0.0",
            "NSHighResolutionCapable": True,
            "NSMicrophoneUsageDescription":
                "MBTune necesita la entrada de audio para afinar la voz en tiempo real.",
        },
    )
else:
    exe = EXE(pyz, a.scripts, a.binaries, a.datas, [], name="MBTune",
              console=False, upx=False, icon="assets/icon.ico")
