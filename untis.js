// ---------- Untis-Stundenplan ----------
// Holt den eigenen Stundenplan live von WebUntis (JSON-RPC, wie das Python-Paket „webuntis“).
// Browser dürfen WebUntis nicht direkt abfragen – deshalb läuft alles über einen kleinen
// eigenen Proxy (untis-proxy/worker.js). Zugangsdaten bleiben auf dem Gerät; das Passwort
// steht getrennt in „untisPass“ und kommt nicht in die Sicherungsdatei.

const UNTIS_SYNC_MS = 15 * 60 * 1000;
const UNTIS_DAYS = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag'];
let untisCfg = store.get('untisCfg', { server: '', school: '', user: '', proxy: '' });
let untisCache = store.get('untisCache', { weeks: {}, grid: null, subjects: {} });
let untisMonday = untisMondayOf(new Date());
let untisBusy = false;
let untisError = '';

function untisMondayOf(d) {
  const m = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  m.setDate(m.getDate() - ((m.getDay() + 6) % 7));
  return m;
}
const untisIso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const untisYmd = (d) => Number(untisIso(d).replace(/-/g, ''));
const untisDay = (ymd) => { const s = String(ymd); return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`; };
const untisHm = (n) => { const s = String(n).padStart(4, '0'); return `${s.slice(0, 2)}:${s.slice(2)}`; };
const untisAddDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const untisEsc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Servername: „https://mese.webuntis.com/…“ oder „mese“ → „mese.webuntis.com“
function untisHost(s) {
  s = String(s || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (s && !s.includes('.')) s += '.webuntis.com';
  return s;
}
const untisReady = () => !!(untisHost(untisCfg.server) && untisCfg.school && untisCfg.user && store.get('untisPass', ''));

// ---- JSON-RPC ----
class UntisError extends Error {}

async function untisCall(method, params, sid) {
  const target = `https://${untisHost(untisCfg.server)}/WebUntis/jsonrpc.do?school=${encodeURIComponent(untisCfg.school.trim())}`;
  const proxy = (untisCfg.proxy || '').trim();
  const body = JSON.stringify({ id: String(Date.now()), method, params: params || {}, jsonrpc: '2.0' });
  let res;
  try {
    res = proxy
      ? await fetch(`${proxy}${proxy.includes('?') ? '&' : '?'}url=${encodeURIComponent(target)}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(sid ? { 'X-Untis-Session': sid } : {}) }, body })
      : await fetch(target, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, credentials: 'include' });
  } catch {
    throw new UntisError(navigator.onLine === false ? 'Kein Internet' : proxy ? 'Proxy nicht erreichbar – Adresse prüfen' : 'WebUntis blockiert direkte Anfragen aus dem Browser – bitte eine Proxy-Adresse eintragen');
  }
  if (res.status === 403) throw new UntisError('Proxy lehnt ab – ist die App-Adresse im Worker eingetragen?');
  let data;
  try { data = await res.json(); } catch { throw new UntisError(`Unerwartete Antwort (HTTP ${res.status})`); }
  if (data.error) {
    const c = data.error.code;
    if (c === -8504) throw new UntisError('Benutzername oder Passwort falsch');
    if (c === -8500) throw new UntisError('Schule nicht gefunden – Schulname prüfen');
    if (c === -8520) throw new UntisError('Sitzung abgelaufen');
    if (c === -7004) throw new UntisError('Keine Berechtigung für diesen Stundenplan');
    throw new UntisError(data.error.message || `Untis-Fehler ${c}`);
  }
  return data.result;
}

// Anmelden → Aufruf → Abmelden (Sitzungen bleiben nicht offen)
async function untisSession(fn) {
  const auth = await untisCall('authenticate', { user: untisCfg.user.trim(), password: store.get('untisPass', ''), client: 'Lernheft' });
  if (!auth || !auth.sessionId) throw new UntisError('Anmeldung fehlgeschlagen');
  try { return await fn(auth); } finally { untisCall('logout', {}, auth.sessionId).catch(() => {}); }
}

async function untisTimetable(auth, el, start, end) {
  return untisCall('getTimetable', { options: {
    element: el, startDate: untisYmd(start), endDate: untisYmd(end),
    showInfo: true, showSubstText: true, showLsText: true, showStudentgroup: true,
    subjectFields: ['id', 'name', 'longname'], teacherFields: ['id', 'name', 'longname'],
    roomFields: ['id', 'name', 'longname'], klasseFields: ['id', 'name']
  } }, auth.sessionId);
}

// Eine Woche holen (Mo–Fr) und im Speicher ablegen
async function untisFetchWeek(monday) {
  return untisSession(async (auth) => {
    const sid = auth.sessionId;
    // Fachfarben und Stundenraster einmal am Tag
    if (!untisCache.subjectsAt || Date.now() - untisCache.subjectsAt > 864e5) {
      try {
        const subs = await untisCall('getSubjects', {}, sid);
        untisCache.subjects = {};
        for (const s of subs || []) untisCache.subjects[s.id] = { bg: s.backColor ? '#' + s.backColor : '', fg: s.foreColor ? '#' + s.foreColor : '', long: s.longName || s.name };
      } catch {}
      try {
        const grid = await untisCall('getTimegridUnits', {}, sid);
        const day = (grid || []).find((d) => d.timeUnits && d.timeUnits.length) || null;
        if (day) untisCache.grid = day.timeUnits.map((u) => ({ name: u.name, start: untisHm(u.startTime), end: untisHm(u.endTime) }));
      } catch {}
      untisCache.subjectsAt = Date.now();
    }
    // eigener Plan (Schüler = Typ 5); falls nicht erlaubt: Plan der Klasse
    const end = untisAddDays(monday, 4);
    let raw;
    try {
      raw = await untisTimetable(auth, { id: auth.personId, type: auth.personType || 5 }, monday, end);
    } catch (err) {
      if (!auth.klasseId) throw err;
      raw = await untisTimetable(auth, { id: auth.klasseId, type: 1 }, monday, end);
    }
    const names = (arr) => (arr || []).map((x) => x.name || x.longname || '').filter(Boolean).join(', ');
    const orig = (arr) => (arr || []).map((x) => x.orgname || '').filter(Boolean).join(', ');
    const lessons = (raw || []).map((e) => {
      const su = (e.su || [])[0] || {};
      const meta = untisCache.subjects[su.id] || {};
      return {
        date: untisDay(e.date), start: untisHm(e.startTime), end: untisHm(e.endTime),
        su: su.name || e.lstext || e.activityType || '', suLong: su.longname || meta.long || '',
        te: names(e.te), teOrg: orig(e.te), ro: names(e.ro), roOrg: orig(e.ro),
        code: e.code || '', info: [e.substText, e.info, e.lstext].filter(Boolean).join(' · '),
        bg: meta.bg || '', fg: meta.fg || ''
      };
    });
    untisCache.weeks[untisIso(monday)] = { at: Date.now(), lessons };
    // nur die letzten Wochen aufheben
    const keys = Object.keys(untisCache.weeks).sort();
    while (keys.length > 12) delete untisCache.weeks[keys.shift()];
    store.set('untisCache', untisCache);
    return lessons;
  });
}

async function untisSync(force) {
  if (untisBusy || !untisReady()) { renderUntis(); return; }
  const wk = untisCache.weeks[untisIso(untisMonday)];
  if (!force && wk && Date.now() - wk.at < UNTIS_SYNC_MS / 2) return renderUntis();
  untisBusy = true;
  untisError = '';
  renderUntis();
  try { await untisFetchWeek(untisMonday); } catch (err) { untisError = err instanceof UntisError ? err.message : 'Laden fehlgeschlagen'; console.error(err); }
  untisBusy = false;
  renderUntis();
  renderUntisHome();
}

// ---- Ansicht ----
function untisRows(lessons) {
  // Zeilen: Untis-Stundenraster, sonst aus den Stunden selbst
  if (untisCache.grid && untisCache.grid.length) return untisCache.grid;
  const set = new Map();
  for (const l of lessons) set.set(l.start, { name: '', start: l.start, end: l.end });
  return [...set.values()].sort((a, b) => a.start.localeCompare(b.start)).map((r, i) => ({ ...r, name: String(i + 1) }));
}

function untisCard(l, now) {
  const cancelled = l.code === 'cancelled', changed = l.code === 'irregular' || l.teOrg || l.roOrg;
  const te = l.teOrg ? `<s>${untisEsc(l.teOrg)}</s> ${untisEsc(l.te)}` : untisEsc(l.te);
  const ro = l.roOrg ? `<s>${untisEsc(l.roOrg)}</s> ${untisEsc(l.ro)}` : untisEsc(l.ro);
  const live = !cancelled && now >= `${l.date} ${l.start}` && now < `${l.date} ${l.end}`;
  return `<button type="button" class="ut-card${cancelled ? ' cancelled' : ''}${changed && !cancelled ? ' changed' : ''}${live ? ' live' : ''}" style="--c:${l.bg || 'var(--muted)'}" data-l="${untisEsc(JSON.stringify(l))}">` +
    `<b>${untisEsc(l.su || '—')}</b>${cancelled ? '<span class="ut-tag">Entfall</span>' : changed ? '<span class="ut-tag">Änderung</span>' : ''}` +
    `<span class="ut-meta">${[te, ro].filter(Boolean).join(' · ')}</span>` +
    (l.info ? `<span class="ut-info">${untisEsc(l.info)}</span>` : '') + '</button>';
}

function renderUntis() {
  const box = $('#untis-body');
  if (!box) return;
  const mon = untisMonday, fri = untisAddDays(mon, 4);
  $('#untis-week').textContent = `${mon.toLocaleDateString('de-DE', { day: 'numeric', month: 'numeric' })} – ${fri.toLocaleDateString('de-DE', { day: 'numeric', month: 'numeric', year: 'numeric' })}`;
  $('#untis-sync').disabled = untisBusy || !untisReady();
  $('#untis-sync').classList.toggle('spin', untisBusy);
  const wk = untisCache.weeks[untisIso(mon)];
  const st = $('#untis-status');
  st.classList.toggle('err', !!untisError);
  st.textContent = !untisReady() ? '' : untisBusy ? 'Wird geladen …' : untisError ? untisError + (wk ? ' – zeige gespeicherten Stand' : '')
    : wk ? `Stand: ${new Date(wk.at).toLocaleString('de-DE', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : '';
  if (!untisReady()) {
    box.innerHTML = '<div class="card ut-empty"><p><b>Untis verbinden</b></p><p class="muted">Trage in den Einstellungen deine WebUntis-Zugangsdaten und die Proxy-Adresse ein. Danach erscheint hier dein Stundenplan und bleibt automatisch aktuell.</p><button type="button" class="btn primary" id="untis-to-settings">Zu den Einstellungen</button></div>';
    $('#untis-to-settings').addEventListener('click', () => { showView('settings'); setTimeout(() => $('#untis-settings').scrollIntoView({ block: 'start' }), 50); });
    return;
  }
  if (!wk) { box.innerHTML = `<div class="card ut-empty muted">${untisBusy ? 'Stundenplan wird geladen …' : 'Für diese Woche ist noch nichts geladen.'}</div>`; return; }
  const lessons = wk.lessons;
  const rows = untisRows(lessons);
  const d = new Date(), today = untisIso(d), now = `${today} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const days = UNTIS_DAYS.map((n, i) => ({ n, iso: untisIso(untisAddDays(mon, i)), dt: untisAddDays(mon, i) }));
  let html = '<div class="ut-grid"><div class="ut-head ut-corner"></div>';
  for (const dy of days) html += `<div class="ut-head${dy.iso === today ? ' today' : ''}"><span>${dy.n.slice(0, 2)}</span> ${dy.dt.getDate()}.${dy.dt.getMonth() + 1}.</div>`;
  for (const r of rows) {
    html += `<div class="ut-time"><b>${untisEsc(r.name)}</b><span>${r.start}</span><span>${r.end}</span></div>`;
    for (const dy of days) {
      // Stunden, die dieses Rasterfeld überdecken (Doppelstunden erscheinen in beiden Feldern)
      const here = lessons.filter((l) => l.date === dy.iso && l.start < r.end && l.end > r.start);
      html += `<div class="ut-cell${dy.iso === today ? ' today' : ''}">${here.map((l) => untisCard(l, now)).join('')}</div>`;
    }
  }
  html += '</div>';
  if (!lessons.length) html += '<p class="muted ut-note">Keine Stunden in dieser Woche (Ferien?).</p>';
  box.innerHTML = html;
}

function untisShowDetail(l) {
  const dlg = $('#untis-dialog');
  const dt = new Date(l.date + 'T00:00');
  const row = (k, v) => (v ? `<div class="row"><span class="muted">${k}</span><span>${v}</span></div>` : '');
  $('#untis-dialog-body').innerHTML = `<h3 style="margin:0 0 4px">${untisEsc(l.suLong || l.su)}</h3>` +
    `<p class="muted" style="margin:0 0 12px">${dt.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' })}, ${l.start}–${l.end}</p>` +
    '<div class="list-group">' +
    row('Status', l.code === 'cancelled' ? '<b style="color:#dc2626">Entfällt</b>' : (l.code === 'irregular' || l.teOrg || l.roOrg) ? '<b style="color:#d97706">Geändert</b>' : '') +
    row('Lehrkraft', l.teOrg ? `<s>${untisEsc(l.teOrg)}</s> → ${untisEsc(l.te)}` : untisEsc(l.te)) +
    row('Raum', l.roOrg ? `<s>${untisEsc(l.roOrg)}</s> → ${untisEsc(l.ro)}` : untisEsc(l.ro)) +
    row('Info', untisEsc(l.info)) + '</div>';
  dlg.showModal();
}

// Startseite: aktuelle bzw. nächste Stunde
function renderUntisHome() {
  const el = $('#stat-untis');
  if (!el) return;
  const card = el.closest('.card');
  card.hidden = !untisReady();
  if (card.hidden) return;
  const d = new Date(), today = untisIso(d), hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const wk = untisCache.weeks[untisIso(untisMondayOf(d))];
  const list = wk ? wk.lessons.filter((l) => l.date === today && l.code !== 'cancelled' && l.end > hm).sort((a, b) => a.start.localeCompare(b.start)) : [];
  const l = list[0];
  el.textContent = l ? l.su : '–';
  $('#stat-untis-sub').textContent = l ? `${l.start <= hm ? 'jetzt' : 'ab ' + l.start}${l.ro ? ' · ' + l.ro : ''}` : wk ? 'heute keine Stunde mehr' : 'Stundenplan';
}

// ---- Einstellungen ----
function renderUntisSettings() {
  const box = $('#untis-settings');
  if (!box) return;
  const f = (id, label, val, type, ph, hint) => `<label class="row ut-field"><span>${label}${hint ? `<span class="muted small-text">${hint}</span>` : ''}</span><input id="${id}" type="${type}" value="${untisEsc(val)}" placeholder="${ph}" autocomplete="off" autocapitalize="off" spellcheck="false"></label>`;
  box.innerHTML = '<h3 class="set-title">Untis-Stundenplan</h3><div class="list-group">' +
    f('ut-server', 'Server', untisCfg.server, 'text', 'z. B. mese.webuntis.com', '') +
    f('ut-school', 'Schule', untisCfg.school, 'text', 'Schulname aus der Untis-Adresse', '') +
    f('ut-user', 'Benutzer', untisCfg.user, 'text', 'WebUntis-Benutzername', '') +
    f('ut-pass', 'Passwort', store.get('untisPass', ''), 'password', '••••••', 'bleibt nur auf diesem Gerät') +
    f('ut-proxy', 'Proxy', untisCfg.proxy, 'url', 'https://…workers.dev', 'eigener Cloudflare-Worker') +
    '</div><div class="ut-actions"><button type="button" class="btn primary small" id="ut-test">Speichern & testen</button><button type="button" class="btn small" id="ut-clear">Abmelden</button><span class="muted small-text" id="ut-msg"></span></div>' +
    '<p class="muted small-text set-note">Server und Schule stehen in der Adresse von WebUntis, z. B. <i>mese</i>.webuntis.com und <i>?school=meine-schule</i>. Wie man den Proxy einrichtet, steht in der Anleitung (README).</p>';
  const read = () => {
    untisCfg = { server: $('#ut-server').value.trim(), school: $('#ut-school').value.trim(), user: $('#ut-user').value.trim(), proxy: $('#ut-proxy').value.trim().replace(/\/+$/, '') };
    store.set('untisCfg', untisCfg);
    store.set('untisPass', $('#ut-pass').value);
  };
  box.querySelectorAll('input').forEach((i) => i.addEventListener('change', read));
  $('#ut-test').addEventListener('click', async () => {
    read();
    const msg = $('#ut-msg');
    if (!untisReady()) { msg.textContent = 'Bitte alle Felder ausfüllen'; return; }
    msg.textContent = 'Verbinde …';
    try {
      const n = (await untisFetchWeek(untisMondayOf(new Date()))).length;
      msg.textContent = `✓ Verbunden – ${n} Stunden diese Woche`;
      untisError = '';
      renderUntisHome();
    } catch (err) {
      msg.textContent = '✕ ' + (err instanceof UntisError ? err.message : 'Fehler');
    }
  });
  $('#ut-clear').addEventListener('click', () => {
    if (!confirm('Untis-Zugangsdaten und gespeicherten Stundenplan von diesem Gerät löschen?')) return;
    untisCfg = { server: '', school: '', user: '', proxy: '' };
    untisCache = { weeks: {}, grid: null, subjects: {} };
    store.set('untisCfg', untisCfg);
    store.set('untisCache', untisCache);
    localStorage.removeItem('untisPass');
    renderUntisSettings();
    renderUntisHome();
  });
}

// ---- Bedienung ----
$('#untis-prev').addEventListener('click', () => { untisMonday = untisAddDays(untisMonday, -7); untisSync(); });
$('#untis-next').addEventListener('click', () => { untisMonday = untisAddDays(untisMonday, 7); untisSync(); });
$('#untis-today').addEventListener('click', () => { untisMonday = untisMondayOf(new Date()); untisSync(); });
$('#untis-sync').addEventListener('click', () => untisSync(true));
$('#untis-body').addEventListener('click', (e) => {
  const c = e.target.closest('.ut-card');
  if (c) untisShowDetail(JSON.parse(c.dataset.l));
});
window.addEventListener('viewchange', (e) => {
  if (e.detail === 'untis') untisSync();
  if (e.detail === 'settings') renderUntisSettings();
  if (e.detail === 'home') renderUntisHome();
});
// automatisch aktualisieren, solange die App offen ist
setInterval(() => {
  if (document.hidden || !untisReady()) return;
  if (document.body.dataset.view === 'untis') untisSync();
  else renderUntisHome();
}, 60 * 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && document.body.dataset.view === 'untis') untisSync(); });
renderUntisSettings();
renderUntisHome();
if (document.body.dataset.view === 'untis') untisSync();
