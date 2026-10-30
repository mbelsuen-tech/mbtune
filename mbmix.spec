# -*- mode: python ; coding: utf-8 -*-
# PyInstaller: genera MBMix.exe (Windows) o MBMix.app (macOS)
import sys

datas = [("mbmix/web", "web")]

a = Analysis(["mbmix/mbmix.py"], pathex=[], datas=datas, hiddenimports=[], excludes=["numpy", "sounddevice"])
pyz = PYZ(a.pure)

if sys.platform == "darwin":
    exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="MBMix",
              console=False, icon="assets/icon.icns")
    coll = COLLECT(exe, a.binaries, a.datas, name="MBMix")
    app = BUNDLE(
        coll, name="MBMix.app", icon="assets/icon.icns",
        bundle_identifier="com.mbsoundtools.mbmix",
        info_plist={
            "CFBundleDisplayName": "MBMix",
            "CFBundleShortVersionString": "1.0.0",
            "NSHighResolutionCapable": True,
            "NSLocalNetworkUsageDescription":
                "MBMix necesita la red local para hablar con la mesa y con los iPads.",
        },
    )
else:
    exe = EXE(pyz, a.scripts, a.binaries, a.datas, [], name="MBMix",
              console=False, upx=False, icon="assets/icon.ico")
