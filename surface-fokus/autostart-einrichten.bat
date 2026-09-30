@echo off
rem Richtet ein, dass der Fokus-Modus bei jeder Anmeldung automatisch startet.
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
> "%STARTUP%\fokus-start.bat" echo @start "" pythonw "%~dp0fokus.py"
echo Autostart eingerichtet: Der Fokus-Modus startet ab jetzt bei jeder Anmeldung.
echo Zum Entfernen: autostart-entfernen.bat ausfuehren.
pause
