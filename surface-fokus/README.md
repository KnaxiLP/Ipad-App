# Fokus-Modus fürs Surface (Notlösung)

Ein kleines Python-Programm, das im Hintergrund läuft und jedes Fenster schließt, das nicht
**Chrome** (darin läuft die Test-App), **Teams** oder ein wichtiger Teil von Windows ist.

> ⚠️ Das ist **keine echte Sperre**. Abmelden, der Task-Manager oder ein anderes Benutzerkonto
> umgehen sie. Für „nicht aus Versehen abgelenkt werden“ reicht es.

## Einrichten

1. **Python installieren** (falls noch nicht da): Microsoft Store → „Python 3.12“ (oder neuer)
2. Diesen Ordner `surface-fokus` aufs Surface kopieren, z. B. nach `Dokumente\surface-fokus`
3. **Starten:** Doppelklick auf `start-fokus.bat`
   → Chrome öffnet die Test-App, alles andere wird geschlossen
4. **Automatisch bei jeder Anmeldung:** Doppelklick auf `autostart-einrichten.bat`

## Beenden

1. **Strg + Alt + Umschalt + Q** drücken (Umschalt = die **Shift-Taste ⇧** für Großbuchstaben)
2. Zweimal mit **Ja** bestätigen (vorausgewählt ist jeweils **Nein**)
3. Die Lautstärke geht auf Maximum und ein **lauter Ton** ertönt – so merkt jeder im Raum,
   dass der Fokus-Modus aus ist

Solange der Fokus-Modus läuft, steht oben in der Bildschirmmitte das Schild
**„Fokus-Modus aktiv – nur Chrome und Teams“**. Ist das Schild weg, ist auch der Modus aus.

Autostart wieder entfernen: `autostart-entfernen.bat`

> Hinweis: Über den Task-Manager lässt sich das Programm ohne Ton beenden. Dann
> verschwindet aber auch das Schild – das sieht man.

## Was bleibt offen, was wird geschlossen?

| Bleibt offen | Wird geschlossen |
|---|---|
| Chrome (auch die installierte Test-App) | alle anderen Programme (Edge, Spiele, Discord …) |
| Teams | Datei-Explorer-Fenster |
| Taskleiste, Startmenü, Bildschirmtastatur | Windows-Einstellungen und Store-Apps |
| WLAN/Lautstärke über die Schnelleinstellungen | |

Programme, die sich nicht schließen lassen, werden nach 5 Sekunden hart beendet
(Windows-Teile wie die Taskleiste nie).

## Anpassen

Oben in `fokus.py`:

- `ALLOWED` – weitere erlaubte Programme (Dateiname der .exe, z. B. `"onenote.exe"`)
- `START_URLS` – was beim Start in Chrome geöffnet wird
- `CLOSE_FILE_EXPLORER` – Datei-Explorer erlauben (`False`)
- `KILL_AFTER_SECONDS` – `0` = nie hart beenden

Welches Programm wann geschlossen wurde, steht in `fokus-log.txt`. Das hilft, wenn ein
benötigtes Programm fehlt: den Namen aus dem Protokoll bei `ALLOWED` eintragen.
