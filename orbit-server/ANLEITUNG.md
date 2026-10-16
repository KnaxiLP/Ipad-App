# Orbit-Klassenserver auf dem Raspberry Pi

Der Server speichert **Klassen, geteilte Hausaufgaben und Schulaufgaben**. Alles liegt in **einer einzigen Datei** (`orbit-data.json`). Es gibt keine Datenbank-Software und nichts zu installieren außer dem Skript selbst. Python 3 ist auf dem Raspberry Pi schon dabei.

Untis läuft weiter über den Cloudflare-Worker. Dieser Server hat damit nichts zu tun.

---

## 1. Skript auf den Pi bringen

Auf dem Pi ein Terminal öffnen (oder per `ssh pi@raspberrypi.local`):

```bash
mkdir -p ~/orbit && cd ~/orbit
curl -fsSLO https://raw.githubusercontent.com/KnaxiLP/Ipad-App/claude/exciting-cray-gdxnse/orbit-server/orbit_server.py
```

Alternativ die Datei per USB-Stick kopieren.

Kurz testen:

```bash
python3 orbit_server.py
```

Es erscheint `Orbit-Server läuft auf Port 8787 …`. In einem zweiten Terminal:

```bash
curl http://localhost:8787/api/ping
# → {"ok": true, "app": "Orbit", "version": 1}
```

Mit **Strg+C** beenden.

## 2. Automatisch starten (auch nach einem Neustart)

```bash
sudo nano /etc/systemd/system/orbit.service
```

Diesen Inhalt einfügen (`pi` durch deinen Benutzernamen ersetzen, falls er anders heißt):

```ini
[Unit]
Description=Orbit-Klassenserver
After=network-online.target

[Service]
User=pi
WorkingDirectory=/home/pi/orbit
ExecStart=/usr/bin/python3 /home/pi/orbit/orbit_server.py
Environment=ORBIT_PORT=8787
Environment=ORBIT_ORIGINS=https://knaxilp.github.io
Restart=always

[Install]
WantedBy=multi-user.target
```

Speichern mit Strg+O, Enter, Strg+X. Dann:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now orbit
systemctl status orbit        # sollte „active (running)“ zeigen
```

`ORBIT_ORIGINS` ist die Adresse, unter der die App läuft (ohne `/Ipad-App/` am Ende). Nur von dort nimmt der Server Anfragen an. Mehrere Adressen trennst du mit Kommas.

## 3. Von überall erreichbar machen (HTTPS)

Die App läuft über **https**, also muss auch der Server über https erreichbar sein. Sonst blockiert der Browser die Verbindung. Außerdem sollen die anderen aus der Klasse auch von zu Hause darauf zugreifen können. Am einfachsten geht das ohne Router-Einstellungen über **Tailscale Funnel**. Das ist kostenlos und gibt dem Server eine feste Adresse.

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up                 # Link öffnen und kostenlos anmelden
sudo tailscale funnel --bg 8787
```

Beim ersten Mal zeigt `tailscale funnel` einen Link. Damit schaltest du Funnel für dein Konto frei, danach den Befehl noch einmal ausführen. Am Ende steht die Adresse da, etwa:

```
https://raspberrypi.tail1234.ts.net
```

Diese Adresse ist dein **Klassen-Server**. Prüfen kannst du sie im Browser: `https://raspberrypi.tail1234.ts.net/api/ping`.

**Nur zum Ausprobieren** geht auch ein Cloudflare-Schnelltunnel. Die Adresse ändert sich dabei aber bei jedem Start:

```bash
cloudflared tunnel --url http://localhost:8787
```

## 4. In der App

**Einstellungen → Klassen-Server**: Adresse eintragen, deinen Namen eingeben, dann auf **Speichern & testen** tippen.

Danach geht es unter **Klasse** weiter:
- **Klasse erstellen:** Du bekommst einen 6-stelligen Code und schickst ihn den anderen („Einladen“).
- **Klasse beitreten:** Den Code eingeben.

Beim Eintragen einer Hausaufgabe oder Schulaufgabe wählst du **👥 Klasse** oder **🔒 Nur für mich**.

---

## Die Datendatei

Alles steht in `~/orbit/orbit-data.json`. Die Datei ist lesbar, aber bitte nicht bearbeiten, während der Server läuft. Aufbau (gekürzt):

```json
{
  "version": 1,
  "classes": {
    "fBjeTScL7xw9": {
      "id": "fBjeTScL7xw9",
      "name": "10b",
      "code": "K7XM2Q",
      "created": 1792127635815,
      "members": {
        "mAbc…": { "name": "Max", "token": "<sha256>", "role": "owner", "joined": 1792…, "seen": 1792… }
      },
      "homework": {
        "sXyz…": { "su": "M", "suLong": "Mathematik", "text": "S. 42 Nr. 3", "due": "2026-10-19", "assigned": "2026-10-16",
                   "author": "mAbc…", "authorName": "Max", "created": 1792…, "updated": 1792…, "deleted": false }
      },
      "exams": {
        "sQrs…": { "su": "M", "kind": "Schulaufgabe", "title": "1. Schulaufgabe", "date": "2026-10-21", "topics": "Brüche",
                   "author": "mAbc…", "authorName": "Max", "created": 1792…, "updated": 1792…, "deleted": false }
      }
    }
  }
}
```

- Zeiten sind Millisekunden seit 1970, Daten im Format `JJJJ-MM-TT`.
- **„Erledigt“ wird nicht gespeichert.** Das bleibt auf jedem Gerät persönlich.
- Gelöschte Einträge bleiben 60 Tage als `"deleted": true` stehen, damit alle Geräte das Löschen mitbekommen. Danach verschwinden sie.
- Die Geräte-Schlüssel (`token`) werden nur als Prüfsumme (SHA-256) gespeichert.

### Sicherung

Der Server legt **jeden Tag automatisch** eine Kopie in `~/orbit/backups/` an und behält die letzten 14. Zum Zurückspielen:

```bash
sudo systemctl stop orbit
cp ~/orbit/backups/orbit-data-2026-10-16.json ~/orbit/orbit-data.json
sudo systemctl start orbit
```

## Rechte

| | Mitglied | Ersteller der Klasse |
|---|---|---|
| Einträge sehen und abhaken | ✓ | ✓ |
| Eigene Einträge ändern und löschen | ✓ | ✓ |
| Fremde Einträge ändern und löschen | – (nur für sich ausblenden) | ✓ |
| Code erneuern, umbenennen, Mitglieder entfernen | – | ✓ |

Verlässt der Ersteller die Klasse, übernimmt das am längsten dabei gewesene Mitglied.

## Datenschutz

- Gespeichert werden nur Vornamen bzw. Spitznamen, Hausaufgaben und Prüfungstermine. Keine Noten, keine Passwörter, kein Untis.
- Wer den Code kennt, kann beitreten. Wenn der Code die Runde gemacht hat: **Neuer Code**. Wer schon drin ist, bleibt drin, Unbekannte entfernst du als Ersteller.
- Gegen Code-Raten sind pro Internet-Adresse höchstens 10 Beitrittsversuche pro Minute erlaubt.

## Probleme

| Meldung in der App | Lösung |
|---|---|
| „Server nicht erreichbar“ | Läuft der Dienst? `systemctl status orbit`. Funktioniert `…/api/ping` im Browser? |
| Ping geht im Browser, aber nicht in der App | `ORBIT_ORIGINS` passt nicht zur App-Adresse → in `orbit.service` anpassen, dann `sudo systemctl restart orbit`. |
| „Code nicht gefunden“ | Tippfehler, oder der Code wurde erneuert. |
| „Du bist nicht (mehr) in dieser Klasse“ | Du wurdest entfernt. Mit dem Code neu beitreten. |

Log ansehen: `journalctl -u orbit -f`
