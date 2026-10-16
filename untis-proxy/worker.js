// Untis-Proxy für Orbit (Cloudflare Worker, kostenlos)
//
// Browser dürfen WebUntis nicht direkt abfragen (fehlende CORS-Freigabe). Dieser Worker
// leitet die Anfragen der App an WebUntis weiter – und nur dorthin:
//   - Ziel muss https://<irgendwas>.webuntis.com/WebUntis/jsonrpc.do sein
//   - nur Anfragen von den unten eingetragenen Adressen (deine App)
//   - speichert nichts, schreibt keine Logs mit Zugangsdaten
//
// Einrichten: siehe README, Abschnitt „Untis-Stundenplan“.

// Adressen, von denen die App aufgerufen wird (ohne / am Ende)
const ALLOWED_ORIGINS = [
  'https://knaxilp.github.io',
  'http://localhost:8000'
];

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Untis-Session',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin'
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (!ALLOWED_ORIGINS.includes(origin)) return new Response('Nicht erlaubt', { status: 403, headers: cors });
    if (request.method !== 'POST') return new Response('Nur POST', { status: 405, headers: cors });

    let target;
    try { target = new URL(new URL(request.url).searchParams.get('url') || ''); } catch { target = null; }
    if (!target || target.protocol !== 'https:' || !target.hostname.endsWith('.webuntis.com') || target.pathname !== '/WebUntis/jsonrpc.do') {
      return new Response('Ungültiges Ziel', { status: 400, headers: cors });
    }

    const headers = { 'Content-Type': 'application/json', 'User-Agent': 'Orbit' };
    const sid = request.headers.get('X-Untis-Session');
    if (sid && /^[A-Za-z0-9]+$/.test(sid)) headers.Cookie = `JSESSIONID=${sid}`;

    const res = await fetch(target.toString(), { method: 'POST', headers, body: await request.text() });
    return new Response(await res.text(), { status: res.status, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
};
