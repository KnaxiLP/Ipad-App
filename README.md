# Test App – iPad Web-App

Eine einfache Website, die sich auf dem iPad wie eine echte App anfühlt
(Progressive Web App): eigenes Icon auf dem Home-Bildschirm, Vollbild ohne
Safari-Leisten, funktioniert offline und speichert Daten auf dem Gerät.

**Inhalt:** Startseite mit Uhr, Aufgabenliste, **Notenrechner**, **Notizen zum
Schreiben mit dem Apple Pencil**, Zähler und Info-Seite.
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

## Notenrechner

- Fächer anlegen (oder mit einem Tipp die Standard-Fächer hinzufügen)
- Noten 1–6 mit Tendenz: `2+` = 1,75 · `2` = 2,0 · `2-` = 2,25
- Schriftlich und mündlich getrennt; Gewichtung pro Fach einstellbar (Tippen auf den Fachnamen)
- Schnitt pro Fach und Gesamtschnitt (auch auf der Startseite)
- Tippen auf eine Note löscht sie

## Notizen

- Schreiben mit dem **Apple Pencil**, inkl. Druckstärke
- Stift, Textmarker und Radierer; 5 Farben und 3 Stärken; Rückgängig und Wiederholen
- Papier: blanko, liniert, kariert oder gepunktet; beliebig viele Seiten
- **☝️-Schalter:** Ohne Pencil zeichnet der Finger (zum Scrollen zwei Finger nehmen).
  Sobald der Pencil benutzt wird, schaltet die App automatisch um: Dann schreibt nur
  noch der Stift und der Finger scrollt. So stört der Handballen nicht.
- Mehrere Notizen (📒), Titel oben eingeben
- Als Bild teilen oder speichern (⋯ → „Als Bild teilen“)
- Alles wird nur auf dem Gerät gespeichert

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
| `grades.js` | Notenrechner |
| `notes.js` | Notizen mit Stift |
| `manifest.webmanifest` | App-Name, Farben, Icons |
| `sw.js` | Service Worker für Offline-Nutzung |
| `icons/` | App-Icons (aus `icon.svg` erzeugt) |

> Die App lädt Updates im Hintergrund – Änderungen erscheinen spätestens beim
> zweiten Öffnen. Neue Dateien müssen in `sw.js` in die `FILES`-Liste.
