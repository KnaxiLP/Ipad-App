// ---------- Klassen (Orbit-Server auf dem Raspberry Pi) ----------
// Jedes Gerät hat eine zufällige Kennung (id + token). Klassen erstellen/beitreten per Code.
// Geteilte Hausaufgaben und Schulaufgaben werden in die lokalen Listen gespiegelt
// (mit „shared“: { cls, id, author, authorName }) – „erledigt“ bleibt immer persönlich.
// Änderungen gehen über eine Warteschlange (Outbox), damit auch offline nichts verloren geht.

const ORBIT_SYNC_MS = 2 * 60 * 1000;
let orbitServer = store.get('orbitServer', '') || ORBIT_DEFAULTS.orbitServer;
let orbitMe = store.get('orbitMe', null);
let orbitClasses = store.get('orbitClasses', []);
let orbitOutbox = store.get('orbitOutbox', []);
let orbitHidden = new Set(store.get('orbitHidden', []));
let orbitBusy = false;
let orbitStatus = '';

const orbitRand = (n) => { const a = new Uint8Array(n); crypto.getRandomValues(a); return [...a].map((b) => 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 57]).join(''); };
if (!orbitMe) { orbitMe = { id: 'm' + orbitRand(15), token: orbitRand(32), name: '' }; store.set('orbitMe', orbitMe); }
const orbitSave = () => { store.set('orbitClasses', orbitClasses); store.set('orbitOutbox', orbitOutbox); store.set('orbitHidden', [...orbitHidden]); };
const orbitReady = () => !!orbitServer;
const orbitClass = (id) => orbitClasses.find((c) => c.id === id);
const orbitList = (kind) => (kind === 'homework' ? todos : exams);
const orbitFind = (kind, cls, id) => orbitList(kind).find((x) => x.shared && x.shared.cls === cls && x.shared.id === id);

class OrbitError extends Error { constructor(msg, status) { super(msg); this.status = status; } }

async function orbitApi(method, path, body, auth = true) {
  let res;
  try {
    res = await fetch(orbitServer.replace(/\/+$/, '') + '/api' + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(auth ? { 'X-Orbit-Member': orbitMe.id, 'X-Orbit-Token': orbitMe.token } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch {
    throw new OrbitError(navigator.onLine === false ? 'Kein Internet' : 'Server nicht erreichbar', 0);
  }
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new OrbitError(data.error || `Fehler ${res.status}`, res.status);
  return data;
}

// ---- Daten ↔ Server ----
function orbitPayload(kind, it) {
  return kind === 'homework'
    ? { id: it.shared.id, su: it.hw.su, suLong: it.hw.suLong || '', text: it.text, due: it.hw.due, assigned: it.hw.assigned || null }
    : { id: it.shared.id, su: it.su, suLong: it.suLong || '', kind: it.kind, title: it.title || '', date: it.date, topics: it.topics || '' };
}

// Serverstand in die lokale Liste übernehmen
function orbitApply(cls, kind, items) {
  const list = orbitList(kind);
  for (const s of items) {
    const local = orbitFind(kind, cls.id, s.id);
    const pending = orbitOutbox.some((o) => o.cls === cls.id && o.id === s.id);
    if (s.deleted) { if (local && !pending) list.splice(list.indexOf(local), 1); continue; }
    if (orbitHidden.has(cls.id + '/' + s.id) || pending) continue;
    const shared = { cls: cls.id, id: s.id, author: s.author, authorName: s.authorName };
    if (kind === 'homework') {
      const hw = { su: s.su, suLong: s.suLong, assigned: s.assigned, due: s.due };
      if (local) { local.text = s.text; local.hw = hw; local.shared = shared; }
      else list.push({ text: s.text, done: false, hw, shared });
    } else {
      const ex = { su: s.su, suLong: s.suLong, kind: s.kind, title: s.title, date: s.date, topics: s.topics };
      if (local) Object.assign(local, ex, { shared });
      else list.push({ id: 'x' + orbitRand(10), ...ex, shared });
    }
  }
}

// Warteschlange abarbeiten (in Reihenfolge); bei Netzproblem abbrechen und später weiter
async function orbitFlush() {
  while (orbitOutbox.length) {
    const op = orbitOutbox[0];
    try {
      if (op.op === 'add') await orbitApi('POST', `/classes/${op.cls}/${op.kind}`, op.data);
      else if (op.op === 'put') await orbitApi('PUT', `/classes/${op.cls}/${op.kind}/${op.id}`, op.data);
      else await orbitApi('DELETE', `/classes/${op.cls}/${op.kind}/${op.id}`);
    } catch (err) {
      if (!err.status) throw err;              // offline → später nochmal
      toast(`Nicht gespeichert: ${err.message}`);   // abgelehnt → verwerfen
    }
    orbitOutbox.shift();
    orbitSave();
  }
}

async function orbitSync(quiet) {
  if (!orbitReady() || orbitBusy || !orbitClasses.length) return;
  orbitBusy = true;
  orbitStatus = 'Abgleich …';
  renderOrbit();
  try {
    await orbitFlush();
    for (const cls of orbitClasses.slice()) {
      let d;
      try { d = await orbitApi('GET', `/classes/${cls.id}/sync?since=${cls.since || 0}`); } catch (err) {
        if (err.status === 403 || err.status === 404) { orbitDropClass(cls, err.message); continue; }
        throw err;
      }
      Object.assign(cls, { name: d.name, code: d.code, role: d.role, members: d.members });
      orbitApply(cls, 'homework', d.homework);
      orbitApply(cls, 'exams', d.exams);
      cls.since = d.now;
    }
    orbitStatus = `Stand: ${new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`;
  } catch (err) {
    orbitStatus = err.message + (orbitOutbox.length ? ` – ${orbitOutbox.length} Änderung(en) warten` : '');
    if (!quiet) toast(orbitStatus);
  }
  orbitSave();
  saveTodos();
  saveExams();
  orbitBusy = false;
  orbitRefreshViews();
}

// Klasse weg (verlassen, entfernt, gelöscht): geteilte Einträge dieser Klasse lokal entfernen
function orbitDropClass(cls, why) {
  orbitClasses = orbitClasses.filter((c) => c !== cls);
  orbitOutbox = orbitOutbox.filter((o) => o.cls !== cls.id);
  todos = todos.filter((t) => !(t.shared && t.shared.cls === cls.id));
  exams = exams.filter((x) => !(x.shared && x.shared.cls === cls.id));
  if (why) toast(`„${cls.name}“: ${why}`);
}

function orbitRefreshViews() {
  renderOrbit();
  if (typeof renderHomework === 'function') renderHomework();
  if (typeof renderExams === 'function') renderExams();
  renderUntis();
  renderUntisHome();
}

// ---- Teilen, ändern, löschen (von Hausaufgaben/Schulaufgaben aus) ----
function orbitShareSelect(id) {
  if (!orbitReady() || !orbitClasses.length) return '';
  const last = store.get('orbitShareLast_' + id, orbitClasses[0].id);   // jedes Formular merkt sich seine Wahl
  return `<select id="${id}" class="orbit-share" aria-label="Teilen mit"><option value="">🔒 Nur für mich</option>` +
    orbitClasses.map((c) => `<option value="${c.id}"${c.id === last ? ' selected' : ''}>👥 ${untisEsc(c.name)}</option>`).join('') + '</select>';
}
function orbitShareValue(id) {
  const el = document.getElementById(id);
  if (!el) return '';
  store.set('orbitShareLast_' + id, el.value);
  return el.value;
}
function orbitCanEdit(it) {
  if (!it.shared) return true;
  const c = orbitClass(it.shared.cls);
  return it.shared.author === orbitMe.id || (c && c.role === 'owner');
}
function orbitQueue(op) { orbitOutbox.push(op); orbitSave(); orbitSync(true); }

function orbitAdd(kind, cls, it) {
  if (!cls) return;
  it.shared = { cls, id: 's' + orbitRand(14), author: orbitMe.id, authorName: orbitMe.name };
  orbitQueue({ cls, kind, op: 'add', id: it.shared.id, data: orbitPayload(kind, it) });
}
function orbitUpdate(kind, it) {
  if (!it.shared || !orbitCanEdit(it)) return;
  orbitQueue({ cls: it.shared.cls, kind, op: 'put', id: it.shared.id, data: orbitPayload(kind, it) });
}
// gibt false zurück, wenn der Eintrag nur ausgeblendet wird (fremder Eintrag)
function orbitRemove(kind, it) {
  if (!it.shared) return true;
  if (orbitCanEdit(it)) { orbitQueue({ cls: it.shared.cls, kind, op: 'del', id: it.shared.id }); return true; }
  orbitHidden.add(it.shared.cls + '/' + it.shared.id);
  orbitSave();
  return false;
}
const orbitByline = (it) => {
  if (!it.shared) return '';
  const c = orbitClass(it.shared.cls);
  return `👥 ${c ? c.name : 'Klasse'}${it.shared.author === orbitMe.id ? '' : ' · von ' + (it.shared.authorName || '?')}`;
};

// ---- Ansicht „Klasse“ ----
function orbitAskName() {
  if (orbitMe.name) return true;
  const n = (prompt('Wie heißt du? (So sehen dich die anderen in der Klasse)') || '').trim().slice(0, 40);
  if (!n) return false;
  orbitMe.name = n;
  store.set('orbitMe', orbitMe);
  return true;
}

function renderOrbit() {
  const box = $('#orbit-body');
  if (!box) return;
  $('#orbit-status').textContent = orbitReady() && orbitClasses.length ? orbitStatus : '';
  if (!orbitReady()) {
    box.innerHTML = '<div class="card ut-empty"><p><b>Klassen-Server verbinden</b></p><p class="muted">Mit dem Orbit-Server (z. B. auf einem Raspberry Pi) könnt ihr als Klasse Hausaufgaben und Schulaufgaben teilen. Trag in den Einstellungen die Adresse des Servers ein.</p><button type="button" class="btn primary" id="orbit-to-settings">Zu den Einstellungen</button></div>';
    $('#orbit-to-settings').addEventListener('click', () => { showView('settings'); setTimeout(() => $('#orbit-settings').scrollIntoView({ block: 'start' }), 50); });
    return;
  }
  let html = '';
  for (const c of orbitClasses) {
    const owner = c.role === 'owner';
    html += `<div class="card orbit-class" data-c="${c.id}"><div class="orbit-head"><h3>${untisEsc(c.name)}</h3>${owner ? '<span class="orbit-badge">Ersteller</span>' : ''}</div>` +
      `<div class="orbit-code"><span class="muted small-text">Beitritts-Code</span><b>${untisEsc(c.code)}</b>` +
      '<button type="button" class="btn small" data-a="share">Einladen</button><button type="button" class="btn small" data-a="link">Link kopieren</button>' + (owner ? '<button type="button" class="btn small link" data-a="code">Neuer Code</button>' : '') + '</div>' +
      `<p class="muted small-text">${(c.members || []).length} ${(c.members || []).length === 1 ? 'Mitglied' : 'Mitglieder'} · ${todos.filter((t) => t.shared && t.shared.cls === c.id).length} Hausaufgaben · ${exams.filter((x) => x.shared && x.shared.cls === c.id).length} Schulaufgaben</p>` +
      '<ul class="orbit-members">' + (c.members || []).map((m) => `<li><span>${untisEsc(m.name)}${m.id === orbitMe.id ? ' (du)' : ''}</span>${m.role === 'owner' ? '<span class="muted small-text">Ersteller</span>' : owner ? `<button type="button" class="btn small link" data-kick="${m.id}">Entfernen</button>` : ''}</li>`).join('') + '</ul>' +
      `<div class="orbit-actions">${owner ? '<button type="button" class="btn small" data-a="rename">Umbenennen</button>' : ''}<button type="button" class="btn small danger-text" data-a="leave">Verlassen</button></div></div>`;
  }
  html += '<div class="orbit-new"><div class="card"><h3>Klasse beitreten</h3><p class="muted small-text">Code von jemandem aus der Klasse eingeben</p><form id="orbit-join"><input id="orbit-code" placeholder="z. B. K7XM2Q" autocomplete="off" autocapitalize="characters" maxlength="8"><button type="button" class="btn small" id="orbit-paste" title="Code aus der Zwischenablage">📋</button><button type="submit" class="btn primary small">Beitreten</button></form></div>' +
    '<div class="card"><h3>Klasse erstellen</h3><p class="muted small-text">Du bekommst einen Code für die anderen</p><form id="orbit-create"><input id="orbit-name" placeholder="z. B. 10b oder Chemie-Kurs" autocomplete="off" maxlength="40"><button type="submit" class="btn small">Erstellen</button></form></div></div>';
  box.innerHTML = html;

  box.querySelectorAll('.orbit-class').forEach((card) => {
    const c = orbitClass(card.dataset.c);
    card.addEventListener('click', async (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      try {
        if (b.dataset.a === 'share') {
          const txt = `Tritt unserer Klasse „${c.name}“ in Orbit bei (Code ${c.code}):`, url = orbitInviteLink(c);
          if (navigator.share) navigator.share({ text: txt, url }).catch(() => {});
          else { await navigator.clipboard.writeText(`${txt} ${url}`).catch(() => {}); toast('Einladungslink kopiert'); }
        } else if (b.dataset.a === 'link') {
          await navigator.clipboard.writeText(orbitInviteLink(c)).then(() => toast('Einladungslink kopiert'), () => prompt('Einladungslink:', orbitInviteLink(c)));
        } else if (b.dataset.a === 'code') {
          if (!confirm('Neuen Code erzeugen? Der alte funktioniert dann nicht mehr (wer schon drin ist, bleibt drin).')) return;
          Object.assign(c, await orbitApi('POST', `/classes/${c.id}/code`));
        } else if (b.dataset.a === 'rename') {
          const n = (prompt('Neuer Name der Klasse:', c.name) || '').trim();
          if (!n) return;
          Object.assign(c, await orbitApi('PUT', `/classes/${c.id}`, { name: n }));
        } else if (b.dataset.a === 'leave') {
          if (!confirm(`„${c.name}“ verlassen? Die geteilten Einträge verschwinden von diesem Gerät.`)) return;
          await orbitApi('POST', `/classes/${c.id}/leave`).catch((err) => { if (err.status !== 403 && err.status !== 404) throw err; });
          orbitDropClass(c);
        } else if (b.dataset.kick) {
          const m = c.members.find((x) => x.id === b.dataset.kick);
          if (!confirm(`${m ? m.name : 'Mitglied'} aus der Klasse entfernen?`)) return;
          Object.assign(c, await orbitApi('DELETE', `/classes/${c.id}/members/${b.dataset.kick}`));
        }
        orbitSave();
        saveTodos();
        saveExams();
        orbitRefreshViews();
      } catch (err) { toast(err.message); }
    });
  });
  $('#orbit-join').addEventListener('submit', (e) => { e.preventDefault(); const code = $('#orbit-code').value.trim(); if (code) orbitEnter('/join', { code }); });
  $('#orbit-create').addEventListener('submit', (e) => { e.preventDefault(); const name = $('#orbit-name').value.trim(); if (name) orbitEnter('/classes', { name }); });
  // Code aus der Zwischenablage (z. B. aus der Einladung kopiert)
  $('#orbit-paste').addEventListener('click', async () => {
    let t = '';
    try { t = await navigator.clipboard.readText(); } catch { return toast('Einfügen nicht erlaubt – Code bitte eintippen'); }
    const code = orbitCodeIn(t);
    if (!code) return toast('In der Zwischenablage ist kein Klassen-Code');
    $('#orbit-code').value = code;
    orbitEnter('/join', { code });
  });
}

// Klassen-Code aus Text oder Link holen (6 Zeichen ohne 0/O/1/I)
function orbitCodeIn(t) {
  const s = String(t || '').toUpperCase(), C = '[A-HJ-NP-Z2-9]{6}';
  const m = s.match(new RegExp(`KLASSE=(${C})(?![A-Z0-9])`)) || s.match(new RegExp(`CODE[\\s:]*(${C})(?![A-Z0-9])`)) || s.trim().match(new RegExp(`^(${C})$`));
  return m ? m[1] : '';
}
// Einladungslink: öffnet Orbit, zeigt die Installation und tritt danach der Klasse bei
const orbitInviteLink = (c) => `${location.origin}${location.pathname.replace(/index\.html$/, '')}?install&klasse=${c.code}`;

// Klasse erstellen oder beitreten; gibt die Klasse zurück (oder null)
async function orbitEnter(path, body) {
  if (!orbitAskName()) return null;
  try {
    const c = await orbitApi('POST', path, { ...body, member: { ...orbitMe } });
    if (!orbitClass(c.id)) orbitClasses.push({ ...c, since: 0 });
    orbitSave();
    toast(path === '/join' ? `Willkommen in „${c.name}“` : `„${c.name}“ erstellt – Code ${c.code}`);
    await orbitSync();
    return c;
  } catch (err) { orbitEnter.lastError = err; toast(err.message); return null; }
}

// ---- Einstellungen ----
function renderOrbitSettings() {
  const box = $('#orbit-settings');
  if (!box) return;
  box.innerHTML = '<h3 class="set-title">Klassen-Server</h3><div class="list-group">' +
    `<label class="row ut-field"><span>Server<span class="muted small-text">dein Raspberry Pi</span></span><input id="or-server" type="url" value="${untisEsc(orbitServer)}" placeholder="https://…" autocomplete="off" autocapitalize="off" spellcheck="false"></label>` +
    `<label class="row ut-field"><span>Dein Name<span class="muted small-text">sehen die anderen in der Klasse</span></span><input id="or-name" value="${untisEsc(orbitMe.name)}" placeholder="Vorname" autocomplete="off" maxlength="40"></label>` +
    '</div><div class="ut-actions"><button type="button" class="btn primary small" id="or-test">Speichern & testen</button><span class="muted small-text" id="or-msg"></span></div>' +
    '<p class="muted small-text set-note">Einrichtung des Servers: <i>orbit-server/ANLEITUNG.md</i>. Untis läuft weiter über den Cloudflare-Worker.</p>';
  $('#or-test').addEventListener('click', async () => {
    orbitServer = $('#or-server').value.trim().replace(/\/+$/, '');
    store.set('orbitServer', orbitServer);
    const name = $('#or-name').value.trim().slice(0, 40);
    const renamed = name && name !== orbitMe.name;
    orbitMe.name = name;
    store.set('orbitMe', orbitMe);
    const msg = $('#or-msg');
    if (!orbitServer) { msg.textContent = 'Keine Adresse – Klassen sind aus'; return; }
    msg.textContent = 'Verbinde …';
    try {
      const p = await orbitApi('GET', '/ping', null, false);
      if (p.app !== 'Orbit') throw new OrbitError('Das ist kein Orbit-Server', 1);
      if (renamed) for (const c of orbitClasses) await orbitApi('PUT', `/classes/${c.id}/me`, { name }).catch(() => {});
      msg.textContent = '✓ Verbunden';
      orbitSync(true);
    } catch (err) { msg.textContent = '✕ ' + err.message; }
  });
}

// ---- Start ----
window.addEventListener('viewchange', (e) => {
  if (e.detail === 'orbit') { renderOrbit(); orbitSync(true); }
  if (e.detail === 'settings') renderOrbitSettings();
  if (e.detail === 'homework' || e.detail === 'exams') orbitSync(true);
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) orbitSync(true); });
window.addEventListener('online', () => orbitSync(true));
setInterval(() => { if (!document.hidden) orbitSync(true); }, ORBIT_SYNC_MS);
setTimeout(() => orbitSync(true), 1500);
renderOrbitSettings();
if (document.body.dataset.view === 'orbit') renderOrbit();
