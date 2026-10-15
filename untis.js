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
    const old = untisCache.weeks[untisIso(monday)];
    if (old) untisDiff(old.lessons, lessons);
    untisCache.weeks[untisIso(monday)] = { at: Date.now(), lessons };
    // nur die letzten Wochen aufheben
    const keys = Object.keys(untisCache.weeks).sort();
    while (keys.length > 12) delete untisCache.weeks[keys.shift()];
    store.set('untisCache', untisCache);
    return lessons;
  });
}

async function untisSync(force, monday = untisMonday, maxAge = UNTIS_SYNC_MS / 2) {
  if (untisBusy || !untisReady()) { renderUntis(); return; }
  const wk = untisCache.weeks[untisIso(monday)];
  if (!force && wk && Date.now() - wk.at < maxAge) return renderUntis();
  untisBusy = true;
  untisError = '';
  renderUntis();
  try { await untisFetchWeek(monday); } catch (err) { untisError = err instanceof UntisError ? err.message : 'Laden fehlgeschlagen'; console.error(err); }
  untisBusy = false;
  renderUntis();
  renderUntisHome();
}

// ---- Änderungen (Entfall, Vertretung, Raum, Hinweis) gegenüber dem letzten Stand ----
const untisKey = (l) => `${l.date} ${l.start} ${l.su}`;
const untisDayLabel = (iso) => {
  const d = new Date(iso + 'T00:00'), t = new Date(new Date().toDateString());
  const diff = Math.round((d - t) / 864e5);
  return diff === 0 ? 'Heute' : diff === 1 ? 'Morgen' : d.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'numeric' });
};
function untisDiff(oldList, newList) {
  const today = untisIso(new Date());
  const before = new Map(oldList.map((l) => [untisKey(l), l]));
  const found = [];
  for (const l of newList) {
    if (l.date < today) continue;
    const o = before.get(untisKey(l));
    const what = l.code === 'cancelled' && (!o || o.code !== 'cancelled') ? 'entfällt'
      : l.teOrg && (!o || o.te !== l.te) ? `Vertretung: ${l.te}`
      : l.roOrg && (!o || o.ro !== l.ro) ? `Raum ${l.ro} statt ${l.roOrg}`
      : !o && l.code === 'irregular' ? 'zusätzliche Stunde'
      : o && l.info && l.info !== o.info ? l.info : '';
    if (what) found.push({ id: untisKey(l) + ' ' + what, date: l.date, start: l.start, su: l.su, text: what, at: Date.now() });
  }
  if (!found.length) return;
  const known = new Set((untisCache.changes || []).map((c) => c.id));
  const fresh = found.filter((c) => !known.has(c.id));
  untisCache.changes = (untisCache.changes || []).concat(fresh).filter((c) => c.date >= today).slice(-30);
  if (fresh.length) untisNotify(fresh);
}

function untisNotify(list) {
  const lines = list.map((c) => `${untisDayLabel(c.date)} ${c.start} ${c.su}: ${c.text}`);
  toast(lines.length === 1 ? lines[0] : `${lines.length} Änderungen im Stundenplan`);
  if (!store.get('untisNotify', false) || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const title = lines.length === 1 ? 'Stundenplan geändert' : `${lines.length} Änderungen im Stundenplan`, body = lines.slice(0, 4).join('\n');
  const opts = { body, tag: 'untis', icon: 'icons/icon-192.png' };
  (navigator.serviceWorker && navigator.serviceWorker.getRegistration ? navigator.serviceWorker.getRegistration() : Promise.resolve(null))
    .then((r) => (r && r.showNotification ? r.showNotification(title, opts) : new Notification(title, opts)))
    .catch(() => { try { new Notification(title, opts); } catch {} });
}

function untisChangesOpen() { return (untisCache.changes || []).filter((c) => !c.seen && c.date >= untisIso(new Date())); }

function renderUntisChanges() {
  const box = $('#untis-changes');
  if (!box) return;
  const list = untisChangesOpen().sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  box.hidden = !list.length;
  if (!list.length) return;
  box.innerHTML = '<div class="ut-ch-head"><b>Neu im Plan</b><button type="button" class="btn small link" id="untis-seen">Gesehen</button></div>' +
    list.map((c) => `<div class="ut-ch"><span>${untisEsc(untisDayLabel(c.date))}, ${c.start}</span> <b>${untisEsc(c.su)}</b> – ${untisEsc(c.text)}</div>`).join('');
  $('#untis-seen').addEventListener('click', () => {
    for (const c of untisCache.changes || []) c.seen = true;
    store.set('untisCache', untisCache);
    renderUntisChanges();
    renderUntisHome();
  });
}

// ---- Hausaufgaben (als Aufgaben in der Aufgabenliste, mit Fach und Fälligkeit) ----
const untisHw = () => todos.filter((t) => t.hw);
function untisAllLessons() {
  return Object.values(untisCache.weeks).flatMap((w) => w.lessons).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
}
// nächste (nicht ausfallende) Stunde desselben Fachs nach dieser Stunde
function untisNextOf(l) {
  return untisAllLessons().find((x) => x.su === l.su && x.date > l.date && x.code !== 'cancelled') || null;
}
function untisNextSchoolDay(from = new Date()) {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d;
}

// ---- Notiz zum Fach: Ordner mit dem Fachnamen, heutige Notiz weiterführen oder neue anlegen ----
async function untisOpenNote(l) {
  const name = (l.suLong || l.su).slice(0, 30);
  let f = folders.find((x) => x.name.toLowerCase() === name.toLowerCase() || x.name.toLowerCase() === l.su.toLowerCase());
  if (!f) { f = { id: 'f' + Date.now().toString(36), name }; folders.push(f); saveFolders(); }
  let all = [];
  try { all = await noteDb.all(); } catch {}
  const day = new Date(l.date + 'T00:00').toDateString();
  const today = all.filter((n) => n.folder === f.id && new Date(n.created).toDateString() === day).sort((a, b) => b.updated - a.updated)[0];
  $('#untis-dialog').close();
  showView('notes');
  if (today) return openNote(today);
  const n = newNote();
  n.folder = f.id;
  n.title = `${name} ${new Date(l.date + 'T00:00').toLocaleDateString('de-DE', { day: 'numeric', month: 'numeric' })}`;
  await noteDb.put(n).catch(() => {});
  await openNote(n);
  toast(`Neue Notiz im Ordner „${f.name}“`);
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
  const hw = untisHw().some((t) => !t.done && t.hw.due === l.date && t.hw.su === l.su);
  return `<button type="button" class="ut-card${cancelled ? ' cancelled' : ''}${changed && !cancelled ? ' changed' : ''}${live ? ' live' : ''}" style="--c:${l.bg || 'var(--muted)'}" data-l="${untisEsc(JSON.stringify(l))}">` +
    `<b>${untisEsc(l.su || '—')}${hw ? '<span class="ut-hw" title="Hausaufgabe fällig">HA</span>' : ''}</b>${cancelled ? '<span class="ut-tag">Entfall</span>' : changed ? '<span class="ut-tag">Änderung</span>' : ''}` +
    `<span class="ut-meta">${[te, ro].filter(Boolean).join(' · ')}</span>` +
    (l.info ? `<span class="ut-info">${untisEsc(l.info)}</span>` : '') + '</button>';
}

function renderUntis() {
  const box = $('#untis-body');
  if (!box) return;
  renderUntisChanges();
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
    row('Info', untisEsc(l.info)) + '</div>' +
    `<button type="button" class="btn small ut-note-btn" id="ut-note">📝 Notiz zu ${untisEsc(l.suLong || l.su)}</button>` +
    '<h4 class="ut-h4">Hausaufgaben</h4><ul class="ut-hwlist" id="ut-hwlist"></ul>' +
    '<form class="ut-hwform" id="ut-hwform"><input id="ut-hwtext" placeholder="Neue Hausaufgabe …" autocomplete="off">' +
    '<label class="ut-due">fällig <input type="date" id="ut-hwdue"></label><button type="submit" class="btn primary small">Eintragen</button></form>' +
    '<p class="muted small-text" id="ut-duehint"></p>';
  $('#ut-note').addEventListener('click', () => untisOpenNote(l));
  // Fälligkeit: nächste Stunde dieses Fachs (laut Untis), sonst eine Woche später
  const dueInput = $('#ut-hwdue'), hint = $('#ut-duehint');
  let touched = false;
  dueInput.addEventListener('input', () => { touched = true; hint.textContent = ''; });
  const setDue = () => {
    const nx = untisNextOf(l);
    if (touched) return !!nx;
    dueInput.value = nx ? nx.date : untisIso(untisAddDays(new Date(l.date + 'T00:00'), 7));
    hint.textContent = nx ? `Nächste ${l.su}-Stunde: ${untisDayLabel(nx.date)}, ${nx.start}` : `Nächste ${l.su}-Stunde noch nicht geladen – vorläufig eine Woche später`;
    return !!nx;
  };
  if (!setDue() && untisReady()) {
    // folgende Wochen nachladen, bis die nächste Stunde gefunden ist
    (async () => {
      let m = untisMondayOf(new Date(l.date + 'T00:00'));
      for (let i = 0; i < 3; i++) {
        m = untisAddDays(m, 7);
        if (!untisCache.weeks[untisIso(m)]) { try { await untisFetchWeek(m); } catch { return; } }
        if (!dlg.open) return;
        if (setDue()) return;
      }
    })();
  }
  const list = () => {
    const ul = $('#ut-hwlist');
    const mine = untisHw().filter((t) => t.hw.su === l.su && (t.hw.due === l.date || t.hw.assigned === l.date));
    ul.innerHTML = mine.length ? '' : '<li class="muted small-text">Keine für diese Stunde</li>';
    for (const t of mine) {
      const li = document.createElement('li');
      li.className = t.done ? 'done' : '';
      li.innerHTML = `<button type="button" class="check">${t.done ? '✓' : ''}</button><span><span class="ut-hwt"></span><span class="muted small-text">${t.hw.due === l.date ? 'fällig in dieser Stunde' : 'fällig ' + untisEsc(untisDayLabel(t.hw.due).replace(/^(Heute|Morgen)$/, (m) => m.toLowerCase()))}</span></span><button type="button" class="delete" aria-label="Löschen">×</button>`;
      li.querySelector('.ut-hwt').textContent = t.text;
      li.querySelector('.check').addEventListener('click', () => { t.done = !t.done; saveTodos(); list(); renderUntis(); renderUntisHome(); });
      li.querySelector('.delete').addEventListener('click', () => { todos.splice(todos.indexOf(t), 1); saveTodos(); list(); renderUntis(); renderUntisHome(); });
      ul.append(li);
    }
  };
  list();
  $('#ut-hwform').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('#ut-hwtext').value.trim();
    if (!text || !dueInput.value) return;
    todos.push({ text, done: false, hw: { su: l.su, suLong: l.suLong, assigned: l.date, due: dueInput.value } });
    saveTodos();
    $('#ut-hwtext').value = '';
    list();
    renderUntis();
    renderUntisHome();
    toast(`Eingetragen – fällig ${untisDayLabel(dueInput.value)}`);
  });
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
  // Hausaufgaben bis zum nächsten Schultag (freitags: bis Montag), dazu Überfälliges
  const nsd = untisNextSchoolDay(d), until = untisIso(nsd);
  const due = untisHw().filter((t) => !t.done && t.hw.due <= until);
  const hc = $('#stat-hw').closest('.card');
  hc.hidden = !untisHw().length;
  $('#stat-hw').textContent = due.length;
  $('#stat-hw-sub').textContent = `Hausaufgaben bis ${nsd.getDay() === 1 && d.getDay() !== 0 ? 'Montag' : untisDayLabel(until).toLowerCase()}`;
  const ch = untisChangesOpen();
  $('#stat-changes').closest('.card').hidden = !ch.length;
  $('#stat-changes').textContent = ch.length;
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
    `<div class="row ut-field"><span>Mitteilungen bei Änderungen<span class="muted small-text">Entfall, Vertretung, Raum – solange die App läuft</span></span><label class="switch"><input type="checkbox" id="ut-notify"${store.get('untisNotify', false) ? ' checked' : ''}><span></span></label></div>` +
    '</div><div class="ut-actions"><button type="button" class="btn primary small" id="ut-test">Speichern & testen</button><button type="button" class="btn small" id="ut-clear">Abmelden</button><span class="muted small-text" id="ut-msg"></span></div>' +
    '<p class="muted small-text set-note">Server und Schule stehen in der Adresse von WebUntis, z. B. <i>mese</i>.webuntis.com und <i>?school=meine-schule</i>. Wie man den Proxy einrichtet, steht in der Anleitung (README).</p>';
  const read = () => {
    untisCfg = { server: $('#ut-server').value.trim(), school: $('#ut-school').value.trim(), user: $('#ut-user').value.trim(), proxy: $('#ut-proxy').value.trim().replace(/\/+$/, '') };
    store.set('untisCfg', untisCfg);
    store.set('untisPass', $('#ut-pass').value);
  };
  box.querySelectorAll('input:not([type=checkbox])').forEach((i) => i.addEventListener('change', read));
  $('#ut-notify').addEventListener('change', async (e) => {
    let on = e.target.checked;
    if (on && typeof Notification !== 'undefined' && Notification.permission !== 'granted') {
      try { on = (await Notification.requestPermission()) === 'granted'; } catch { on = false; }
      if (!on) toast('Mitteilungen wurden nicht erlaubt – Hinweise erscheinen nur in der App');
    }
    if (on && typeof Notification === 'undefined') toast('Dieser Browser kann keine Mitteilungen – Hinweise erscheinen nur in der App');
    e.target.checked = on;
    store.set('untisNotify', on);
  });
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
async function untisBackground() {
  if (document.hidden || !untisReady() || untisBusy) return;
  const d = new Date(), mon = untisMondayOf(d);
  if (document.body.dataset.view === 'untis') await untisSync(false, untisMonday);
  await untisSync(false, mon, UNTIS_SYNC_MS);
  if (d.getDay() >= 5 || d.getDay() === 0) await untisSync(false, untisAddDays(mon, d.getDay() === 0 ? 0 : 7), UNTIS_SYNC_MS);
  renderUntisHome();
}
setInterval(untisBackground, 60 * 1000);
setTimeout(untisBackground, 3000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && document.body.dataset.view === 'untis') untisSync(); });
// Startseite: Karten führen zum Stundenplan bzw. zu den Aufgaben
$('#stat-untis').closest('.card').addEventListener('click', () => showView('untis'));
$('#stat-changes').closest('.card').addEventListener('click', () => showView('untis'));
$('#stat-hw').closest('.card').addEventListener('click', () => showView('todos'));
renderUntisSettings();
renderUntisHome();
if (document.body.dataset.view === 'untis') untisSync();
