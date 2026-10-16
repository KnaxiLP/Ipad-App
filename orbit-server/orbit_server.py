#!/usr/bin/env python3
"""Orbit-Klassenserver – für einen Raspberry Pi (oder jeden Rechner mit Python 3.8+).

Speichert Klassen, geteilte Hausaufgaben und Schulaufgaben in EINER JSON-Datei.
Keine Pakete nötig, nur Python. Anleitung: ANLEITUNG.md im selben Ordner.

Einstellungen über Umgebungsvariablen:
  ORBIT_PORT     Port (Standard 8787)
  ORBIT_DATA     Pfad der Datendatei (Standard: orbit-data.json neben diesem Skript)
  ORBIT_ORIGINS  erlaubte App-Adressen, durch Komma getrennt (Standard https://knaxilp.github.io)
"""
import hashlib
import json
import os
import re
import secrets
import shutil
import threading
import time
from datetime import date
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

VERSION = 1
HERE = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get('ORBIT_PORT', '8787'))
DATA = os.environ.get('ORBIT_DATA', os.path.join(HERE, 'orbit-data.json'))
ORIGINS = [o.strip().rstrip('/') for o in os.environ.get('ORBIT_ORIGINS', 'https://knaxilp.github.io').split(',') if o.strip()]
BACKUPS = os.path.join(os.path.dirname(os.path.abspath(DATA)), 'backups')

LIMITS = {'classes': 300, 'members': 80, 'items': 3000, 'body': 64 * 1024}
CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'      # ohne 0/O, 1/I
KINDS = ('homework', 'exams')
DAY = re.compile(r'^\d{4}-\d{2}-\d{2}$')
ID = re.compile(r'^[A-Za-z0-9_-]{6,40}$')

lock = threading.Lock()
join_tries = {}          # IP -> [Zeitpunkte] gegen Code-Raten


def now_ms():
    return int(time.time() * 1000)


def sha(s):
    return hashlib.sha256(s.encode()).hexdigest()


# ---------- Die Daten-Datei ----------
def load():
    if not os.path.exists(DATA):
        return {'version': VERSION, 'classes': {}}
    with open(DATA, encoding='utf-8') as f:
        return json.load(f)


def save(db):
    # erst in eine Hilfsdatei schreiben, dann austauschen – so ist die Datei nie halb geschrieben
    tmp = DATA + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(db, f, ensure_ascii=False, separators=(',', ':'))
    os.replace(tmp, DATA)
    # einmal am Tag eine Sicherung, die letzten 14 bleiben
    os.makedirs(BACKUPS, exist_ok=True)
    today = os.path.join(BACKUPS, f'orbit-data-{date.today().isoformat()}.json')
    if not os.path.exists(today):
        shutil.copyfile(DATA, today)
        old = sorted(f for f in os.listdir(BACKUPS) if f.startswith('orbit-data-'))
        for f in old[:-14]:
            os.remove(os.path.join(BACKUPS, f))


db = load()


# ---------- Prüfen der Eingaben ----------
class ApiError(Exception):
    def __init__(self, status, msg):
        super().__init__(msg)
        self.status, self.msg = status, msg


def text(v, n, required=True):
    v = (v or '').strip() if isinstance(v, str) else ''
    if required and not v:
        raise ApiError(400, 'Pflichtfeld fehlt')
    return v[:n]


def day(v):
    if not isinstance(v, str) or not DAY.match(v):
        raise ApiError(400, 'Datum ungültig')
    return v


def new_code():
    used = {c['code'] for c in db['classes'].values()}
    while True:
        c = ''.join(secrets.choice(CODE_CHARS) for _ in range(6))
        if c not in used:
            return c


def member_in(body):
    m = body.get('member') or {}
    mid, token = m.get('id'), m.get('token')
    if not (isinstance(mid, str) and ID.match(mid) and isinstance(token, str) and len(token) >= 20):
        raise ApiError(400, 'Gerätekennung fehlt')
    return mid, token, text(m.get('name'), 40)


def clean_item(kind, body):
    if kind == 'homework':
        return {'su': text(body.get('su'), 20), 'suLong': text(body.get('suLong'), 40, False),
                'text': text(body.get('text'), 500), 'due': day(body.get('due')),
                'assigned': day(body.get('assigned')) if body.get('assigned') else None}
    return {'su': text(body.get('su'), 20), 'suLong': text(body.get('suLong'), 40, False),
            'kind': text(body.get('kind'), 30), 'title': text(body.get('title'), 80, False),
            'date': day(body.get('date')), 'topics': text(body.get('topics'), 2000, False)}


def public_class(c, mid):
    return {'id': c['id'], 'name': c['name'], 'code': c['code'], 'created': c['created'],
            'role': c['members'][mid]['role'],
            'members': sorted(({'id': k, 'name': m['name'], 'role': m['role']} for k, m in c['members'].items()),
                              key=lambda m: (m['role'] != 'owner', m['name'].lower()))}


def purge(c):
    # gelöschte Einträge nach 60 Tagen endgültig entfernen
    old = now_ms() - 60 * 86400000
    for kind in KINDS:
        for iid in [k for k, it in c[kind].items() if it.get('deleted') and it['updated'] < old]:
            del c[kind][iid]


# ---------- Anfragen ----------
class Handler(BaseHTTPRequestHandler):
    server_version = 'Orbit'

    def log_message(self, fmt, *args):   # keine Zugangsdaten ins Log
        pass

    def cors(self):
        origin = (self.headers.get('Origin') or '').rstrip('/')
        if origin in ORIGINS:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-Orbit-Member, X-Orbit-Token')
            self.send_header('Access-Control-Max-Age', '86400')

    def reply(self, status, obj):
        data = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.cors()
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.end_headers()

    def do_GET(self): self.handle_api('GET')
    def do_POST(self): self.handle_api('POST')
    def do_PUT(self): self.handle_api('PUT')
    def do_DELETE(self): self.handle_api('DELETE')

    def body(self):
        n = int(self.headers.get('Content-Length') or 0)
        if n > LIMITS['body']:
            raise ApiError(413, 'Zu groß')
        if not n:
            return {}
        try:
            v = json.loads(self.rfile.read(n))
        except ValueError:
            raise ApiError(400, 'Kein gültiges JSON')
        return v if isinstance(v, dict) else {}

    def auth(self, c):
        mid, token = self.headers.get('X-Orbit-Member', ''), self.headers.get('X-Orbit-Token', '')
        m = c['members'].get(mid)
        if not m or not secrets.compare_digest(m['token'], sha(token)):
            raise ApiError(403, 'Du bist nicht (mehr) in dieser Klasse')
        m['seen'] = now_ms()
        return mid, m

    def handle_api(self, method):
        url = urlparse(self.path)
        parts = [p for p in url.path.split('/') if p]
        try:
            if not parts or parts[0] != 'api':
                raise ApiError(404, 'Nicht gefunden')
            with lock:
                status, out, changed = self.route(method, parts[1:], parse_qs(url.query))
                if changed:
                    save(db)
            self.reply(status, out)
        except ApiError as e:
            self.reply(e.status, {'error': e.msg})
        except Exception as e:      # noqa: BLE001 – Server soll weiterlaufen
            print('Fehler:', repr(e))
            self.reply(500, {'error': 'Serverfehler'})

    def route(self, method, p, query):
        # GET /api/ping
        if p == ['ping']:
            return 200, {'ok': True, 'app': 'Orbit', 'version': VERSION}, False

        # POST /api/classes  – Klasse erstellen
        if p == ['classes'] and method == 'POST':
            b = self.body()
            mid, token, name = member_in(b)
            if len(db['classes']) >= LIMITS['classes']:
                raise ApiError(507, 'Server voll')
            cid = secrets.token_urlsafe(9)
            c = {'id': cid, 'name': text(b.get('name'), 40), 'code': new_code(), 'created': now_ms(),
                 'members': {mid: {'name': name, 'token': sha(token), 'role': 'owner', 'joined': now_ms(), 'seen': now_ms()}},
                 'homework': {}, 'exams': {}}
            db['classes'][cid] = c
            return 201, public_class(c, mid), True

        # POST /api/join  – mit Code beitreten
        if p == ['join'] and method == 'POST':
            ip = self.headers.get('X-Forwarded-For', self.client_address[0]).split(',')[0].strip()
            t = [x for x in join_tries.get(ip, []) if x > time.time() - 60]
            if len(t) >= 10:
                raise ApiError(429, 'Zu viele Versuche – kurz warten')
            join_tries[ip] = t + [time.time()]
            b = self.body()
            mid, token, name = member_in(b)
            code = text(b.get('code'), 10).upper().replace(' ', '').replace('-', '')
            c = next((x for x in db['classes'].values() if x['code'] == code), None)
            if not c:
                raise ApiError(404, 'Code nicht gefunden')
            m = c['members'].get(mid)
            if m and not secrets.compare_digest(m['token'], sha(token)):
                raise ApiError(403, 'Gerätekennung passt nicht')
            if not m:
                if len(c['members']) >= LIMITS['members']:
                    raise ApiError(507, 'Klasse ist voll')
                c['members'][mid] = {'name': name, 'token': sha(token), 'role': 'member', 'joined': now_ms(), 'seen': now_ms()}
            else:
                m['name'] = name
            return 200, public_class(c, mid), True

        if len(p) < 2 or p[0] != 'classes':
            raise ApiError(404, 'Nicht gefunden')
        c = db['classes'].get(p[1])
        if not c:
            raise ApiError(404, 'Klasse gibt es nicht mehr')
        mid, me = self.auth(c)
        owner = me['role'] == 'owner'
        rest = p[2:]

        # GET /api/classes/:id/sync?since=  – alles seit dem letzten Abgleich
        if rest == ['sync'] and method == 'GET':
            since = int((query.get('since') or ['0'])[0] or 0)
            out = public_class(c, mid)
            for kind in KINDS:
                out[kind] = [it for it in c[kind].values() if it['updated'] > since]
            out['now'] = now_ms()
            return 200, out, False

        # PUT /api/classes/:id/me  – eigenen Namen ändern
        if rest == ['me'] and method == 'PUT':
            me['name'] = text(self.body().get('name'), 40)
            return 200, public_class(c, mid), True

        # POST /api/classes/:id/leave  – Klasse verlassen
        if rest == ['leave'] and method == 'POST':
            del c['members'][mid]
            if not c['members']:
                del db['classes'][c['id']]
            elif owner and not any(m['role'] == 'owner' for m in c['members'].values()):
                oldest = min(c['members'].values(), key=lambda m: m['joined'])
                oldest['role'] = 'owner'
            return 200, {'ok': True}, True

        # Nur für Ersteller: Code erneuern, Mitglied entfernen, umbenennen
        if rest == ['code'] and method == 'POST':
            if not owner:
                raise ApiError(403, 'Nur der Ersteller')
            c['code'] = new_code()
            return 200, public_class(c, mid), True
        if rest == [] and method == 'PUT':
            if not owner:
                raise ApiError(403, 'Nur der Ersteller')
            c['name'] = text(self.body().get('name'), 40)
            return 200, public_class(c, mid), True
        if len(rest) == 2 and rest[0] == 'members' and method == 'DELETE':
            if not owner or rest[1] == mid:
                raise ApiError(403, 'Nur der Ersteller')
            c['members'].pop(rest[1], None)
            return 200, public_class(c, mid), True

        # Hausaufgaben / Schulaufgaben: anlegen, ändern, löschen
        if rest and rest[0] in KINDS:
            kind = rest[0]
            if len(rest) == 1 and method == 'POST':
                b = self.body()
                iid = b.get('id')
                if not (isinstance(iid, str) and ID.match(iid)):
                    raise ApiError(400, 'ID fehlt')
                if iid in c[kind]:                  # schon da (doppelt gesendet) – einfach zurückgeben
                    return 200, c[kind][iid], False
                if len(c[kind]) >= LIMITS['items']:
                    purge(c)
                    if len(c[kind]) >= LIMITS['items']:
                        raise ApiError(507, 'Zu viele Einträge')
                it = {'id': iid, **clean_item(kind, b), 'author': mid, 'authorName': me['name'],
                      'created': now_ms(), 'updated': now_ms(), 'deleted': False}
                c[kind][iid] = it
                return 201, it, True
            if len(rest) == 2:
                it = c[kind].get(rest[1])
                if not it:
                    raise ApiError(404, 'Eintrag nicht gefunden')
                if it['author'] != mid and not owner:
                    raise ApiError(403, 'Nur wer es eingetragen hat (oder der Ersteller der Klasse)')
                if method == 'PUT':
                    it.update(clean_item(kind, self.body()))
                    it['updated'] = now_ms()
                    return 200, it, True
                if method == 'DELETE':
                    it['deleted'] = True
                    it['updated'] = now_ms()
                    purge(c)
                    return 200, it, True
        raise ApiError(404, 'Nicht gefunden')


if __name__ == '__main__':
    print(f'Orbit-Server läuft auf Port {PORT} · Daten: {DATA} · erlaubt: {", ".join(ORIGINS)}')
    ThreadingHTTPServer(('0.0.0.0', PORT), Handler).serve_forever()
