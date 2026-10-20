@echo off
cd /d "%~dp0"
python -m pip install --upgrade -r requirements.txt pyinstaller
python -m PyInstaller --noconfirm --clean mbtune.spec
echo.
echo Listo: dist\MBTune.exe
pause
