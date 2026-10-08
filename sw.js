// Service Worker: speichert alle App-Dateien, damit die App auch offline startet.
// Strategie: sofort aus dem Speicher laden und im Hintergrund aktualisieren.
// Neue Versionen erscheinen dadurch spätestens beim zweiten Öffnen.
const CACHE = 'test-app-v34';
// Python (Pyodide) separat speichern – ändert sich nie, bleibt über App-Updates erhalten
const PY_CACHE = 'pyodide-v0.26.4';
const PY_HOST = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/';
// PDF.js (für den PDF-Import) ebenfalls dauerhaft speichern
const PDF_CACHE = 'pdfjs-3.11.174';
const PDF_HOST = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/';
const FILES = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'grades.js',
  'notes.js',
  'python.js',
  'py-worker.js',
  'braces.js',
  'manifest.webmanifest',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  // am HTTP-Cache vorbei laden, damit wirklich die neue Version gespeichert wird
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE && k !== PY_CACHE && k !== PDF_CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Pyodide-Dateien: einmal laden, danach immer aus dem Speicher (auch offline)
  const cdnCache = req.url.startsWith(PY_HOST) ? PY_CACHE : req.url.startsWith(PDF_HOST) ? PDF_CACHE : null;
  if (req.method === 'GET' && cdnCache) {
    event.respondWith(
      caches.open(cdnCache).then(async (cache) => {
        const cached = await cache.match(req);
        if (cached) return cached;
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      })
    );
    return;
  }

  // Nur eigene Dateien cachen, fremde Anfragen gehen direkt ins Netz
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: true });
      const fresh = fetch(req)
        .then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => cached || Response.error());
      if (cached) {
        event.waitUntil(fresh);
        return cached;
      }
      return fresh;
    })
  );
});
