#!/bin/bash
# Genera dist/MBTune.app y dist/MBTune.dmg (ejecutar en un Mac)
set -e
cd "$(dirname "$0")"
python3 -m pip install --upgrade -r requirements.txt pyinstaller
python3 -m PyInstaller --noconfirm --clean mbtune.spec
codesign --force --deep -s - dist/MBTune.app   # firma local (ad-hoc)
rm -rf dmg_tmp && mkdir dmg_tmp
cp -R dist/MBTune.app dmg_tmp/
ln -s /Applications dmg_tmp/Applications
hdiutil create -volname "MB Soundtools MBTune" -srcfolder dmg_tmp -ov -format UDZO dist/MBTune.dmg
rm -rf dmg_tmp
echo "Listo: dist/MBTune.dmg"
