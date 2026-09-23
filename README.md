# Test App – iPad Web-App

Eine einfache Website, die sich auf dem iPad wie eine echte App anfühlt
(Progressive Web App): eigenes Icon auf dem Home-Bildschirm, Vollbild ohne
Safari-Leisten, funktioniert offline und speichert Daten auf dem Gerät.

**Inhalt:** Startseite mit Uhr, Aufgabenliste, **Soundboard**, Zähler und Info-Seite.
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

## Soundboard

- **Klassiker:** 12 eingebaute Sounds (Trommelwirbel, Fail, Airhorn, Applaus, Schulgong …).
  Sie werden direkt im Browser erzeugt und brauchen keine Dateien.
- **Meine Sounds:** Aufnehmen per Mikrofon (max. 10 s) oder Audiodatei hochladen
  (max. 15 s / 1 MB). Wird nur auf dem eigenen Gerät gespeichert.
  Löschen über „Bearbeiten“.
- **Community:** Sounds, die mit „Mit allen teilen“ gespeichert werden, sehen und
  hören alle App-Nutzer. Dafür braucht es einmalig ein kostenloses Supabase-Projekt ↓

### Community-Sounds einrichten (einmalig, ca. 5 Minuten)

1. Auf [supabase.com](https://supabase.com) kostenlos registrieren und ein **neues Projekt** anlegen
2. Links **SQL Editor** öffnen, den Inhalt von [`supabase-setup.sql`](supabase-setup.sql)
   einfügen und auf **Run** klicken
3. Unter **Project Settings → API Keys** die **Project URL** und den
   **publishable/anon Key** kopieren
4. Beide Werte in [`config.js`](config.js) eintragen, committen und pushen

Ohne diese Einrichtung ist der Community-Bereich einfach ausgeblendet.

> ⚠️ **Nur den publishable/anon Key eintragen, niemals den secret/service_role Key!**
> Der publishable Key ist dafür gedacht, öffentlich in der Website zu stehen. Die
> Regeln in `supabase-setup.sql` erlauben damit nur Sounds ansehen und hinzufügen,
> aber nichts ändern oder löschen.
>
> **Aufräumen:** Unpassende Sounds löschst du im Supabase-Dashboard
> (Table Editor → `sounds` → Zeile löschen, dazu Storage → `sounds` → Datei löschen).

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
| `soundboard.js` | Soundboard (Klassiker, Aufnahme, Upload, Community) |
| `config.js` | Supabase-Zugangsdaten für Community-Sounds |
| `supabase-setup.sql` | Einmal in Supabase ausführen (Tabelle, Speicher, Rechte) |
| `manifest.webmanifest` | App-Name, Farben, Icons |
| `sw.js` | Service Worker für Offline-Nutzung |
| `icons/` | App-Icons (aus `icon.svg` erzeugt) |

> Die App lädt Updates im Hintergrund – Änderungen erscheinen spätestens beim
> zweiten Öffnen. Neue Dateien müssen in `sw.js` in die `FILES`-Liste.
