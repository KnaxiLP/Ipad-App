// ---------- Diagramme teilen (Konstellation, Vergleich) ----------
// Über den Orbit-Server: Wer freigibt, bekommt zwei Links – „Nur lesen“ und „Mitbearbeiten“.
// Wer einen Link öffnet, bekommt das Diagramm als eigene Notiz, die mit dem Original verbunden
// bleibt (note.shared = { id, t, role, ver }). Änderungen gehen beim Speichern hoch, fremde
// Änderungen kommen alle paar Sekunden herein. Lesen = alles sichtbar, nichts änderbar.

const SH_KINDS = { kmap: 'kmap', cmp: 'cmp' };
const SH_POLL_MS = 12000;
let shPushTimer = null, shPushing = false, shDirty = false;

const shData = (n) => n[SH_KINDS[n.kind]];
const shLink = (id, t) => `${appBase()}?doc=${encodeURIComponent(id)}&t=${encodeURIComponent(t)}`;
const shQuery = (s) => (s.t ? `?t=${encodeURIComponent(s.t)}` : '');
// Nur lesen? (von konstellation.js und vergleich.js abgefragt)
function shRO() { return !!(note && note.shared && note.shared.role === 'read'); }
// Felder und Knöpfe sperren (nur lesen) – Ansehen, Springen, Kopieren bleibt erlaubt
function shLock(root) {
  root.querySelectorAll('input, textarea, select').forEach((el) => { el.readOnly = true; if (el.type === 'checkbox' || el.tagName === 'SELECT') el.disabled = true; });
  root.querySelectorAll('button').forEach((b) => {
    if (!b.matches('[data-x="close"], [data-x="sb"], [data-x="ov"], [data-x="sbclose"], [data-x="sbcopy"], [data-ref], [data-rel], [data-goto], [data-view]')) b.disabled = true;
  });
}
function shCanShare(n) { return !!(n && SH_KINDS[n.kind]); }

// ---- Speichern → hochladen (gebündelt) ----
const shSaveOrig = saveNote;
saveNote = function () {
  shSaveOrig();
  if (note && note.shared && note.shared.role !== 'read') {
    shDirty = true;
    clearTimeout(shPushTimer);
    shPushTimer = setTimeout(shPush, 1500);
  }
};
async function shPush() {
  const n = note;
  if (!n || !n.shared || n.shared.role === 'read' || shPushing || !orbitReady()) return;
  shPushing = true;
  shDirty = false;
  const s = n.shared;
  try {
    const r = await orbitApi('PUT', `/docs/${s.id}${shQuery(s)}`, { data: shStrip(shData(n)), title: n.title, ver: s.ver, name: orbitMe.name || '' });
    s.ver = r.ver;
    shSaveOrig();
  } catch (err) {
    if (err.status === 409) {
      // jemand anderes war schneller: dessen Stand übernehmen
      await shPull(true);
      toast('Gleichzeitig von jemand anderem geändert – neuer Stand geladen. Deine letzte Änderung bitte wiederholen.');
    } else if (err.status === 403 || err.status === 404) {
      toast(err.message);
      if (err.status === 404) { delete n.shared; shSaveOrig(); shBadge(); }
    } else shDirty = true;      // offline: später nochmal
  }
  shPushing = false;
  if (shDirty) { clearTimeout(shPushTimer); shPushTimer = setTimeout(shPush, 4000); }
}
// die eigene Ansicht (Zoom/Position) nicht mitteilen
const shStrip = (d) => { const c = JSON.parse(JSON.stringify(d)); delete c.view; return c; };

// ---- Fremde Änderungen holen ----
async function shPull(force) {
  const n = note;
  if (!n || !n.shared || !orbitReady() || document.hidden) return;
  if (!force && (shDirty || shPushing)) return;
  const s = n.shared;
  let r;
  try { r = await orbitApi('GET', `/docs/${s.id}${shQuery(s)}${s.t ? '&' : '?'}since=${force ? 0 : s.ver}`); } catch (err) {
    if (err.status === 403 || err.status === 404) { s.gone = err.message; shBadge(); }
    return;
  }
  if (note !== n) return;
  s.role = r.role === 'owner' ? 'owner' : s.role === 'owner' ? 'owner' : r.role;
  s.ownerName = r.ownerName;
  delete s.gone;
  if (r.data && r.ver !== s.ver) {
    s.ver = r.ver;
    shApply(n, r.data, r.title);
    if (!force && r.by && r.by !== orbitMe.name) toast(`${r.by} hat „${noteName(n)}“ geändert`);
  }
  shBadge();
}
function shApply(n, data, title) {
  const key = SH_KINDS[n.kind], view = n[key] && n[key].view;
  n[key] = { ...data, view };
  if (title != null) { n.title = title; $('#note-title').value = title; }
  shSaveOrig();
  if (note === n) window.dispatchEvent(new CustomEvent('noteopen', { detail: n }));
}
setInterval(() => shPull(false), SH_POLL_MS);
document.addEventListener('visibilitychange', () => { if (!document.hidden) shPull(false); });

// ---- Hinweis oben: geteilt / nur lesen ----
function shBadge() {
  let b = $('#sh-badge');
  if (!b) {
    b = document.createElement('button');
    b.id = 'sh-badge';
    b.type = 'button';
    b.className = 'sh-badge';
    b.addEventListener('click', shDialog);
    $('#note-title').after(b);
  }
  const s = note && note.shared;
  b.hidden = !s;
  document.body.classList.toggle('sh-readonly', shRO());
  $('#note-title').readOnly = shRO();
  if (!s) return;
  b.className = 'sh-badge ' + s.role + (s.gone ? ' gone' : '');
  b.textContent = s.gone ? '⚠︎ Freigabe beendet' : s.role === 'read' ? '👁 Nur lesen' : s.role === 'edit' ? '✏️ Gemeinsam' : '👥 Geteilt';
}
window.addEventListener('noteopen', () => setTimeout(() => { shBadge(); shPull(false); }, 0));

// ---- Teilen-Fenster ----
async function shDialog() {
  const n = note;
  if (!shCanShare(n)) return toast('Teilen geht bei Personenkonstellationen und Vergleichen');
  let dlg = $('#sh-dlg');
  if (!dlg) { dlg = document.createElement('dialog'); dlg.id = 'sh-dlg'; document.body.append(dlg); dlg.addEventListener('click', shClick); }
  shRender();
  if (!dlg.open) dlg.showModal();
}
function shRender() {
  const n = note, s = n.shared, dlg = $('#sh-dlg');
  let h = `<h3>„${kmEsc(noteName(n))}“ teilen</h3>`;
  if (!orbitReady()) h += '<p class="muted">Zum Teilen braucht Orbit den Klassen-Server. Trag ihn in den Einstellungen ein.</p>';
  else if (!s) {
    h += '<p class="muted small-text">Du bekommst zwei Links. Wer einen davon öffnet, hat das Diagramm in Orbit – je nach Link nur zum Ansehen oder zum gemeinsamen Bearbeiten. Deine Änderungen kommen bei allen an.</p>' +
      '<div class="sh-roles"><div><b>👁 Nur lesen</b><span class="muted small-text">sehen, durchblättern, exportieren – nichts ändern</span></div><div><b>✏️ Mitbearbeiten</b><span class="muted small-text">alles ändern – gleichzeitig mit dir</span></div></div>' +
      '<button type="button" class="btn primary" data-sh="create">Freigeben</button>';
  } else if (s.role === 'owner') {
    h += `<p class="muted small-text">Du hast das freigegeben.${s.gone ? ' ⚠︎ ' + kmEsc(s.gone) : ''}</p>`;
    for (const [k, label, hint] of [['read', '👁 Nur lesen', 'Ansehen, nichts ändern'], ['edit', '✏️ Mitbearbeiten', 'gemeinsam bearbeiten']]) {
      h += `<div class="sh-link"><div><b>${label}</b><span class="muted small-text">${hint}</span></div>` +
        (s.links && s.links[k] ? `<button type="button" class="btn small" data-sh="send" data-k="${k}">Senden</button><button type="button" class="btn small" data-sh="copy" data-k="${k}">Kopieren</button>` : '<span class="muted small-text">Link nur auf dem Gerät, das freigegeben hat</span>') +
        `<button type="button" class="btn small link" data-sh="renew" data-k="${k}" title="Neuer Link – der alte funktioniert dann nicht mehr">Neu</button></div>`;
    }
    h += '<p class="muted small-text">„Neu“ macht den alten Link ungültig – so nimmst du jemandem die Berechtigung wieder weg.</p>' +
      '<button type="button" class="btn danger-text" data-sh="stop">Freigabe beenden</button>';
  } else {
    h += `<p>${s.role === 'read' ? '👁 Du kannst das <b>nur lesen</b>.' : '✏️ Du kannst das <b>mitbearbeiten</b>.'} Freigegeben von ${kmEsc(s.ownerName || '?')}.</p>` +
      (s.gone ? `<p class="danger-text small-text">⚠︎ ${kmEsc(s.gone)}</p>` : '') +
      '<button type="button" class="btn" data-sh="copyown">Eigene Kopie anlegen (nicht mehr verbunden)</button>' +
      '<button type="button" class="btn link danger-text" data-sh="leave">Verbindung trennen</button>';
  }
  dlg.innerHTML = h + '<div class="dlg-actions"><span class="spacer"></span><button type="button" class="btn primary" data-sh="close">Fertig</button></div>';
}
async function shClick(e) {
  const b = e.target.closest('[data-sh]');
  if (!b) return;
  const n = note, s = n.shared, k = b.dataset.k, dlg = $('#sh-dlg');
  try {
    switch (b.dataset.sh) {
      case 'close': return dlg.close();
      case 'create': {
        if (!orbitAskName()) return;
        await flushNoteSave();
        const r = await orbitApi('POST', '/docs', { kind: n.kind, title: n.title, data: shStrip(shData(n)), member: { ...orbitMe } });
        n.shared = { id: r.id, role: 'owner', ver: r.ver, links: { read: r.read, edit: r.edit }, ownerName: orbitMe.name };
        shSaveOrig();
        shBadge();
        toast('Freigegeben – jetzt einen Link senden');
        return shRender();
      }
      case 'send': {
        const url = shLink(s.id, s.links[k]), txt = `${k === 'read' ? 'Zum Ansehen' : 'Zum Mitbearbeiten'}: „${noteName(n)}“ in Orbit`;
        if (navigator.share) return navigator.share({ title: noteName(n), text: txt, url }).catch(() => {});
        await navigator.clipboard.writeText(`${txt} ${url}`).catch(() => prompt('Link:', url));
        return toast('Link kopiert');
      }
      case 'copy': return navigator.clipboard.writeText(shLink(s.id, s.links[k])).then(() => toast('Link kopiert'), () => prompt('Link:', shLink(s.id, s.links[k])));
      case 'renew': {
        if (!confirm(`Neuen ${k === 'read' ? 'Lese' : 'Bearbeiten'}-Link erzeugen? Der alte funktioniert dann nicht mehr.`)) return;
        const r = await orbitApi('POST', `/docs/${s.id}/links`, { which: k });
        s.links = { ...(s.links || {}), ...r };
        shSaveOrig();
        toast('Neuer Link – den alten kann niemand mehr benutzen');
        return shRender();
      }
      case 'stop': {
        if (!confirm('Freigabe beenden? Alle Links funktionieren dann nicht mehr. Dein Diagramm bleibt.')) return;
        await orbitApi('DELETE', `/docs/${s.id}`).catch((err) => { if (err.status !== 404) throw err; });
        delete n.shared;
        shSaveOrig();
        shBadge();
        return shRender();
      }
      case 'copyown': {
        const c = { ...JSON.parse(JSON.stringify(n)), id: Date.now().toString(36), title: (n.title || noteName(n)) + ' (Kopie)', created: Date.now(), updated: Date.now() };
        delete c.shared;
        await noteDb.put(c).catch(() => {});
        dlg.close();
        await openNote(c);
        return toast('Eigene Kopie angelegt');
      }
      case 'leave': {
        if (!confirm('Verbindung trennen? Die Notiz bleibt bei dir, bekommt aber keine Änderungen mehr.')) return;
        delete n.shared;
        shSaveOrig();
        shBadge();
        return dlg.close();
      }
    }
  } catch (err) { toast(err.message || 'Fehler'); }
}

// ---- Link öffnen: …/?doc=ID&t=SCHLÜSSEL ----
const SH_INVITE = (() => { const q = new URLSearchParams(location.search); return q.get('doc') && q.get('t') ? { id: q.get('doc'), t: q.get('t') } : null; })();
if (SH_INVITE) { store.set('shPending', SH_INVITE); history.replaceState(null, '', location.pathname); }
async function shOpenPending() {
  const P = store.get('shPending', null);
  if (!P || !orbitReady()) return;
  let r;
  try { r = await orbitApi('GET', `/docs/${encodeURIComponent(P.id)}?t=${encodeURIComponent(P.t)}`); } catch (err) {
    if (err.status) store.set('shPending', null);
    return toast(err.status ? err.message : 'Server nicht erreichbar – Link später nochmal öffnen');
  }
  store.set('shPending', null);
  await flushNoteSave();
  const all = await noteDb.all().catch(() => []);
  let n = all.find((x) => x.shared && x.shared.id === r.id);
  if (n) {
    // schon da: Berechtigung ggf. ändern (z. B. jetzt Bearbeiten-Link) und neuesten Stand übernehmen
    if (n.shared.role !== 'owner') Object.assign(n.shared, { t: P.t, role: r.role });
    n[SH_KINDS[r.kind]] = { ...r.data, view: (n[SH_KINDS[r.kind]] || {}).view };
    n.shared.ver = r.ver;
    n.title = r.title;
  } else {
    n = newNote();
    n.kind = r.kind;
    n.title = r.title || '';
    n[SH_KINDS[r.kind]] = r.data;
    n.shared = { id: r.id, t: P.t, role: r.role, ver: r.ver, ownerName: r.ownerName };
  }
  await noteDb.put(n).catch(() => {});
  showView('notes');
  await openNote(n);
  toast(r.role === 'read' ? `„${noteName(n)}“ von ${r.ownerName} – nur zum Lesen` : `„${noteName(n)}“ von ${r.ownerName} – du kannst mitbearbeiten`);
}
setTimeout(shOpenPending, 600);

// Menü: „Teilen & Berechtigungen“ nur bei teilbaren Notizen
$('#note-share').addEventListener('click', () => { $('#more-dialog').close(); shDialog(); });
$('#note-more').addEventListener('click', () => { $('#note-share').hidden = !shCanShare(note); });
