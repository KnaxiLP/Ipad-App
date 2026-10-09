# Lernheft – Web-App für iPad und Surface

Eine einfache Website, die sich auf dem iPad wie eine echte App anfühlt
(Progressive Web App): eigenes Icon auf dem Home-Bildschirm, Vollbild ohne
Safari-Leisten, funktioniert offline und speichert Daten auf dem Gerät.

**Inhalt:** Startseite mit Uhr, Aufgabenliste, **Notenrechner**, **Notizen zum
Schreiben mit dem Apple Pencil**, **Klammern zum Kopieren**, **Python-Editor**, Zähler und Info-Seite.
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

- Schreiben mit dem **Apple Pencil**: glatte Linien mit Druckstärke, leichte Glättung gegen Zittern
- Füller (reagiert auf Druck), Kugelschreiber (gleichmäßig), Textmarker und Radierer; 5 Farben und 3 Stärken; Rückgängig und Wiederholen
- Papier: blanko, liniert, kariert oder gepunktet; beliebig viele Seiten
- **☝️-Schalter:** Ohne Pencil zeichnet der Finger (zum Scrollen zwei Finger nehmen).
  Sobald der Pencil benutzt wird, schaltet die App automatisch um: Dann schreibt nur
  noch der Stift und der Finger scrollt. So stört der Handballen nicht.
- Mehrere Notizen (📒), Titel oben eingeben
- **Formen erkennen** wie in Goodnotes: Strich zeichnen und den Stift am Ende kurz stillhalten → gerade Linie, Kreis/Ellipse, Dreieck, Rechteck oder Winkel; danach ohne Absetzen weiterziehen = größer/kleiner
- Handballen wird ignoriert, solange der Stift schreibt oder in der Nähe ist
- Radiergummi-Ende oder Seitentaste am Stift (z. B. Surface Pen) radiert
- Läuft auf iPad **und** Windows-Tablets wie dem Surface (dort übernimmt die App Finger-Scrollen und Zoomen selbst)
- **Zoomen** mit zwei Fingern (oder − / + in der Leiste, Tippen auf die Prozentzahl = 100 %)
- **Textfelder** (T-Werkzeug): tippen = neues Feld oder vorhandenes bearbeiten, ziehen = verschieben; Farbe/Größe aus der Leiste; kommt als echter Text ins PDF
- **Import** (⋯ → „PDF oder Bild importieren“): PDFs werden zu einer neuen Notiz, auf der man schreiben kann; Bilder kommen als neue Seite dazu. Goodnotes-Notizen vorher in Goodnotes als PDF exportieren.
- Alles ist **Vektorgrafik (SVG)**: Schrift bleibt in jeder Größe gestochen scharf
- Export als **PDF (Vektor)**, ideal zum Import in Goodnotes, oder als Bild (⋯ → Teilen)
- Alles wird nur auf dem Gerät gespeichert

## Klammern (für Goodnotes)

- Geschweifte Zusammenfassungs-Klammern: nach oben offen ︸, nach unten offen ︷, links `{`, rechts `}`
- Länge, Dicke und Farbe einstellbar; durchsichtiger Hintergrund
- **📋 Kopieren** und in Goodnotes einfügen, oder per Split View hinüberziehen
- Die Länge wird beim Erzeugen gesetzt, dadurch verzerrt die Strichdicke nicht

## Python

- Python-Programme schreiben und direkt auf dem iPad ausführen (mit [Pyodide](https://pyodide.org))
- Beim ersten Öffnen werden ca. 10 MB geladen, danach funktioniert es auch offline
- `input()` funktioniert: Die Eingabe erscheint direkt in der Ausgabe
- `matplotlib` für Diagramme, `numpy` usw. werden bei `import` automatisch geladen
- Zeilennummern, Fehlerzeile wird rot markiert, automatisches Einrücken nach `:`
- Leiste mit Sonderzeichen (`: ( ) " [ ]` …), die auf der iPad-Tastatur umständlich sind
- ⏹ Stopp beendet auch Endlosschleifen
- Mehrere Programme speicherbar, Beispiele: Zahlenraten, Einmaleins, Funktionsgraph …

**Technischer Hinweis:** Python läuft in einem Hintergrund-Worker. Bei `input()` wird
das Programm angehalten und nach der Eingabe neu gestartet. Bis zu dieser Stelle wird
alles unsichtbar „vorgespult“ (gleicher Zufalls-Seed, `sleep` wird übersprungen).
Programme, die z. B. von der Uhrzeit abhängen, können sich dadurch in Einzelfällen
anders verhalten als in normalem Python.

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
| `braces.js` | Klammern-Generator zum Kopieren |
| `python.js` | Python-Editor (Oberfläche) |
| `py-worker.js` | Führt Python im Hintergrund aus (Pyodide) |
| `manifest.webmanifest` | App-Name, Farben, Icons |
| `sw.js` | Service Worker für Offline-Nutzung |
| `icons/` | App-Icons (aus `icon.svg` erzeugt) |

> Die App lädt Updates im Hintergrund – Änderungen erscheinen spätestens beim
> zweiten Öffnen. Neue Dateien müssen in `sw.js` in die `FILES`-Liste.

## Updates & Datensicherung

- **Info → „Nach Update suchen“** lädt die neueste Version. Offene Änderungen werden vorher gespeichert.
- Liegt eine neue Version bereit, erscheint unten **„Jetzt aktualisieren“**.
- Notizen, Noten, Aufgaben und Python-Programme bleiben bei Updates erhalten, weil sie getrennt von den App-Dateien gespeichert sind.
- **„Sicherung speichern“** erzeugt eine JSON-Datei mit allen Daten. **„Sicherung laden“** spielt diese Datei wieder ein. Mach das, bevor du die App vom Home-Bildschirm löschst.

## Bilder einfügen

- **Als Element** über den Bild-Knopf in der Werkzeugleiste, mit **Strg+V** oder per Ziehen auf die Seite: Das Bild liegt frei auf der aktuellen Seite.
  - Ziehen verschiebt das Bild, die Ecken ändern seine Größe, „Löschen“ entfernt es.
  - Mit dem **Auswahl-Werkzeug** (Pfeil) lässt es sich später wieder auswählen.
  - Der Radierer lässt Bilder stehen.
- **Als Seiten** über **⋯ → „PDF oder Bild als Seiten einfügen“**. Die Seiten kommen hinter die Seite, die du gerade siehst.
- **Als neue Notiz** über **⋯ → „PDF als neue Notiz importieren“**.

## Lasso

- Mit dem Lasso kreist du Handschrift, Text und Bilder ein.
- Ziehen verschiebt die Auswahl, die Ecken ändern ihre Größe.
- Im Menü: Löschen, Duplizieren und Farbe ändern.
- Mit dem Auswahl-Pfeil wählst du ein einzelnes Element durch Antippen aus.

## Ordner

- In **Meine Notizen** legst du mit **„＋ Ordner“** einen Ordner an, zum Beispiel für ein Fach.
- Über das Ordner-Symbol neben einer Notiz verschiebst du sie in einen Ordner.
- Neue Notizen landen in dem Ordner, den du gerade offen hast.
- Oben in der Liste kannst du nach Notizen suchen.

## Lineal

- Das Lineal schaltest du über das Lineal-Symbol ein und aus.
- Mit Finger oder Maus verschiebst du es. Drehen geht mit zwei Fingern, mit dem runden Knopf oder mit dem Mausrad.
- Bei 0°, 45°, 90° und so weiter rastet es ein.
- Ein Strich, der nah an einer Kante beginnt, läuft exakt gerade an der Kante entlang.

## Koordinatensystem

- Wähle das Achsen-Symbol und zieh ein Rechteck auf. Die Achsen bekommen Pfeile, Skala und Zahlen und liegen genau auf den Kästchen.
- Nur antippen ergibt ein System mit 16 × 16 Kästchen.
- Im Menü wählst du **4 Quadranten** oder **1. Quadrant** und als Einheit **1 cm** oder **1 Kästchen**.
- Beim Verschieben rastet das System auf den Kästchen ein.

## Textfelder

Beim Bearbeiten erscheint oben eine Format-Leiste:

- **Fett, kursiv, unterstrichen** (auch mit Strg+B, Strg+I, Strg+U).
- **Farben** für einzelne Wörter: Text markieren und eine Farbe wählen.
- **Schriftgröße** mit A− und A+, Überschrift mit Ü.
- **Listen** über die Knöpfe oder durch Tippen von „- “ bzw. „1. “. Ein leerer Punkt und Enter beendet die Liste.
- **Ausrichtung** links, mittig oder rechts.
- **Hintergrundfarbe**, **Rahmen** und **Rechtschreibprüfung**.
- Mit dem Griff rechts oben änderst du die **Breite** des Feldes.

Schnell-Ersetzen beim Tippen:

| Eingabe | Ergebnis |
|---|---|
| `->`, `<-`, `<->`, `=>` | → ← ↔ ⇒ |
| `<=`, `>=`, `!=`, `+-`, `~=` | ≤ ≥ ≠ ± ≈ |
| `^2`, `_2` | ² ₂ |
| `\pi`, `\alpha`, `\Delta`, `\sqrt`, `\inf` | π α Δ √ ∞ |

Im PDF-Export bleiben Sonderzeichen erhalten.

## Formeln

- Wähle das √x-Symbol und tippe auf die Seite. Es öffnet sich ein Formel-Fenster mit Vorschau und Tasten für Bruch, Wurzel, Hoch- und Tiefzahl, griechische Buchstaben und Zeichen.
- Kurzschreibweise:

| Eingabe | Ergebnis |
|---|---|
| `a/b` oder `(a+b)/(c+d)` | Bruch |
| `x^2`, `x_1` | Hochzahl, Tiefzahl |
| `sqrt(x)`, `root(3)(x)` | Wurzel, n-te Wurzel |
| `pi`, `alpha`, `Delta` | griechische Buchstaben |
| `<=`, `->`, `+-` | ≤, →, ± |

- Eine vorhandene Formel antippen öffnet sie zum Bearbeiten.

## Radierer

Bei aktivem Radierer wählst du in der Leiste aus:
- **Ganzer Strich:** löscht den ganzen Strich.
- **Teil:** löscht nur das Stück unter dem Radierer.

## Side Notes

Side Notes sind Anmerkungen an Stellen der Seite, zum Beispiel Stilmittel oder eine alternative Übersetzung.

**Markieren**
- Mit dem Side-Notes-Werkzeug (Sprechblasen-Symbol) unter Wörter ziehen oder einen Bereich aufziehen.
- Oder mit dem Lasso auswählen und **„Side Note“** wählen.
- Jeder Schlüssel hat eine Farbe und einen eigenen Strich:

| Schlüssel | Strich |
|---|---|
| Stilmittel | gewellt |
| Grammatik | doppelt |
| Übersetzung | Textmarker |
| Wichtig | gerade |

Der Stil lässt sich im Ebenen-Dialog umstellen (gerade, doppelt, wellig, gepunktet, Textmarker).

**Inhalt ansehen:** Eine Markierung kurz antippen, mit Stift, Finger oder Maus, egal welches Werkzeug gerade aktiv ist (außer Radierer). Die Sprechblase zeigt den Inhalt, **„Bearbeiten“** öffnet das Panel. Ziehen über eine Markierung schreibt ganz normal.

**Panel:** Es liegt neben der Seite bzw. unten. Getippt wird oben, darunter schreibst du mit Stift, Farbe und Dicke aus der Leiste. Alles wird sofort gespeichert. Es gibt Vorlagen je Schlüssel, und mit **„＋ Stelle“** hängst du weitere Stellen an. Bei offener Notiz verbinden Linien ihre Stellen.

**Ebenen-Dialog:** Schlüssel global oder nur für diese Notiz, ein- und ausblenden, Farbe, Stil, Name, Vorlagen. Dazu Abfrage-Modus und die Übersicht aller Side Notes.

**Export** (⋯ → „Side Notes im Export“): Aus, Markiert oder Mit Liste. Bei „Mit Liste“ stehen kleine Zahlen an den Stellen. Ausgeblendete Ebenen werden nicht exportiert.

## Einstellungen

Erreichbar über **Einstellungen** in der Seitenleiste oder in einer Notiz über **⋯ → „Einstellungen“**.

| Bereich | Einstellungen |
|---|---|
| Allgemein | Design (automatisch/hell/dunkel), Ansicht beim Öffnen |
| Stift & Schreiben | Druckempfindlichkeit, Glättung, Finger zeichnet, Handballen-Erkennung, Formerkennung und Haltedauer, Radierer-Modus |
| Papier & Lineal | Papier für neue Notizen, Lineal rastet ein |
| Text | Rechtschreibprüfung, Schnell-Ersetzen |
| Side Notes | Anzeigen, Spalte, Verbindungslinien, Export |
| Werkzeugleiste | Knöpfe ein- und ausblenden |

## Seitenübersicht

Das Vier-Kästchen-Symbol oben neben dem Titel öffnet alle Seiten als Vorschaubilder.
- **Antippen** springt zur Seite, **Ziehen** verschiebt sie.
- **⧉** doppelt die Seite, **＋** fügt danach eine leere Seite ein, **🗑** löscht sie.

## Stift-Favoriten

- **☆** in der Werkzeugleiste merkt sich den aktuellen Stift (Werkzeug, Farbe, Dicke). Es gibt bis zu 4 Favoriten.
- Antippen schaltet auf den Favoriten um. Lange drücken oder Rechtsklick entfernt ihn.

## Rückgängig

Rückgängig und Wiederholen gelten auch für Seiten-Aktionen (einfügen, verschieben, doppeln, löschen, PDF-Seiten) und für Side Notes. Eine Bearbeitung im Panel ist ein Schritt.
