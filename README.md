# Test App – iPad Web-App

Eine einfache Website, die sich auf dem iPad wie eine echte App anfühlt
(Progressive Web App): eigenes Icon auf dem Home-Bildschirm, Vollbild ohne
Safari-Leisten, funktioniert offline und speichert Daten auf dem Gerät.

**Inhalt:** Startseite mit Uhr, Aufgabenliste, Zähler und Info-Seite.
Auf dem iPad mit Seitenleiste, auf schmalen Bildschirmen (iPhone, Split View)
mit Tab-Leiste unten. Hell- und Dunkelmodus automatisch.

## Online stellen (GitHub Pages)

Die Seite muss über **HTTPS** erreichbar sein. Am einfachsten:

1. Auf GitHub: **Settings → Pages**
2. Unter *Source* „Deploy from a branch“ wählen, den Branch und `/ (root)` auswählen, speichern
3. Nach ~1 Minute ist die App unter `https://<benutzername>.github.io/Ipad-App/` erreichbar

## Auf dem iPad installieren

1. Die URL in **Safari** öffnen
2. Auf **Teilen** tippen (Quadrat mit Pfeil nach oben)
3. **„Zum Home-Bildschirm“** wählen → **Hinzufügen**

Jetzt startet die Seite vom Home-Bildschirm aus wie eine App.

## Lokal testen

```bash
python3 -m http.server 8000
# dann http://localhost:8000 öffnen
```

## Dateien

| Datei | Zweck |
|---|---|
| `index.html` | Aufbau der App + iOS-Meta-Tags für den App-Modus |
| `style.css` | iOS-ähnliches Design |
| `app.js` | Logik (Navigation, Aufgaben, Zähler, Speichern) |
| `manifest.webmanifest` | App-Name, Farben, Icons |
| `sw.js` | Service Worker für Offline-Nutzung |
| `icons/` | App-Icons (aus `icon.svg` erzeugt) |

> Nach Änderungen an den Dateien in `sw.js` die `CACHE`-Version erhöhen
> (z. B. `test-app-v2`), damit das iPad die neue Version lädt.
