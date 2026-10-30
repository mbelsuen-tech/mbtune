#!/bin/bash
# Genera dist/MBMix.app y dist/MBMix.dmg (ejecutar en un Mac)
set -e
cd "$(dirname "$0")"
python3 -m pip install --upgrade pywebview pyinstaller
python3 -m PyInstaller --noconfirm --clean mbmix.spec
codesign --force --deep -s - dist/MBMix.app   # firma local (ad-hoc)
rm -rf dmg_tmp && mkdir dmg_tmp
cp -R dist/MBMix.app dmg_tmp/
ln -s /Applications dmg_tmp/Applications
hdiutil create -volname "MB Soundtools MBMix" -srcfolder dmg_tmp -ov -format UDZO dist/MBMix.dmg
rm -rf dmg_tmp
echo "Listo: dist/MBMix.dmg"
