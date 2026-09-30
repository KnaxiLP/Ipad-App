@echo off
rem Entfernt den automatischen Start des Fokus-Modus.
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\fokus-start.bat" 2>nul
echo Autostart entfernt.
pause
