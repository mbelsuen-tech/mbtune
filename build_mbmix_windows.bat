@echo off
cd /d "%~dp0"
python -m pip install --upgrade pywebview pyinstaller
python -m PyInstaller --noconfirm --clean mbmix.spec
echo.
echo Listo: dist\MBMix.exe
pause
