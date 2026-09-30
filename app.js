// Funktionen, die vor einem Update/Neuladen offene Änderungen speichern
window.appFlush = [];

// ---------- Speicher (bleibt auf dem Gerät erhalten) ----------
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  }
};

const $ = (sel) => document.querySelector(sel);
const isStandalone =
  window.navigator.standalone === true ||
  window.matchMedia('(display-mode: standalone)').matches;

// Note schön anzeigen: 2.25 → "2,25"
const formatGrade = (n) => n.toFixed(2).replace('.', ',');

// ---------- Kleine Meldung oben ----------
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('show'), 2500);
}

// Alle Dialoge: Buttons mit data-close schließen, Tippen auf den Hintergrund auch
document.querySelectorAll('dialog').forEach((d) => {
  d.addEventListener('click', (e) => {
    const r = d.getBoundingClientRect();
    const outside = e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    if ((e.target === d && outside) || e.target.closest('[data-close]')) d.close();
  });
});

// ---------- Navigation ----------
function showView(name) {
  document.querySelectorAll('.nav-item').forEach((b) =>
    b.classList.toggle('active', b.dataset.view === name)
  );
  document.querySelectorAll('.view').forEach((v) =>
    v.classList.toggle('active', v.id === 'view-' + name)
  );
  $('.content').scrollTop = 0;
  store.set('view', name);
  document.body.dataset.view = name;
  updateStats();
  window.dispatchEvent(new CustomEvent('viewchange', { detail: name }));
}

document.querySelectorAll('.nav-item').forEach((btn) =>
  btn.addEventListener('click', () => showView(btn.dataset.view))
);

// ---------- Start ----------
function updateClock() {
  const now = new Date();
  $('#clock').textContent = now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  $('#date').textContent = now.toLocaleDateString('de-DE', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  });
  const h = now.getHours();
  $('#greeting').textContent =
    h < 11 ? 'Guten Morgen' : h < 18 ? 'Guten Tag' : 'Guten Abend';
}

function updateStats() {
  $('#stat-todos').textContent = todos.filter((t) => !t.done).length;
  $('#stat-counter').textContent = counter;
  const avg = window.gradeAverage ? window.gradeAverage() : null;
  $('#stat-grade').textContent = avg == null ? '–' : formatGrade(avg);
}

// ---------- Aufgaben ----------
let todos = store.get('todos', []);

function renderTodos() {
  const list = $('#todo-list');
  list.innerHTML = '';
  todos.forEach((todo, i) => {
    const li = document.createElement('li');
    if (todo.done) li.classList.add('done');

    const check = document.createElement('button');
    check.className = 'check';
    check.textContent = todo.done ? '✓' : '';
    check.setAttribute('aria-label', 'Erledigt');
    check.onclick = () => { todos[i].done = !todos[i].done; saveTodos(); };

    const text = document.createElement('span');
    text.className = 'todo-text';
    text.textContent = todo.text;

    const del = document.createElement('button');
    del.className = 'delete';
    del.textContent = '×';
    del.setAttribute('aria-label', 'Löschen');
    del.onclick = () => { todos.splice(i, 1); saveTodos(); };

    li.append(check, text, del);
    list.append(li);
  });
  $('#todo-empty').hidden = todos.length > 0;
}

function saveTodos() {
  store.set('todos', todos);
  renderTodos();
  updateStats();
}

$('#todo-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#todo-input');
  const text = input.value.trim();
  if (!text) return;
  todos.push({ text, done: false });
  input.value = '';
  saveTodos();
});

// ---------- Zähler ----------
let counter = store.get('counter', 0);

function setCounter(value, haptic = true) {
  counter = value;
  store.set('counter', counter);
  $('#counter-value').textContent = counter;
  updateStats();
  if (haptic && navigator.vibrate) navigator.vibrate(10);
}

document.querySelectorAll('[data-step]').forEach((btn) =>
  btn.addEventListener('click', () => setCounter(counter + Number(btn.dataset.step)))
);
$('#counter-reset').addEventListener('click', () => setCounter(0));

// ---------- Info ----------
function updateInfo() {
  $('#info-standalone').textContent = isStandalone ? 'Ja' : 'Nein (Browser)';
  $('#info-screen').textContent = `${window.innerWidth} × ${window.innerHeight}`;
}
window.addEventListener('resize', updateInfo);

// ---------- Install-Hinweis ----------
if (!isStandalone && !store.get('bannerClosed', false)) {
  $('#install-banner').hidden = false;
}
$('#banner-close').addEventListener('click', () => {
  $('#install-banner').hidden = true;
  store.set('bannerClosed', true);
});

// ---------- Service Worker (Offline) & Updates ----------
// Die Daten (IndexedDB/localStorage) liegen getrennt vom App-Speicher des Service Workers –
// ein Update tauscht nur die Programmdateien aus. Vorher wird trotzdem alles fertig gespeichert.
async function flushAll() {
  for (const f of window.appFlush) {
    try { await f(); } catch {}
  }
}
async function applyUpdate() {
  await flushAll();
  location.reload();
}
function showUpdateBanner() {
  $('#install-banner').hidden = true;
  $('#update-banner').hidden = false;
}
$('#update-now').addEventListener('click', applyUpdate);

let swReg = null;
if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) showUpdateBanner();   // neue Version ist aktiv, Seite läuft noch mit der alten
  });
  navigator.serviceWorker.register('sw.js')
    .then((reg) => { swReg = reg; $('#info-sw').textContent = 'Aktiv'; })
    .catch(() => { $('#info-sw').textContent = 'Nicht verfügbar'; });
} else {
  $('#info-sw').textContent = 'Nicht unterstützt';
}

$('#update-check').addEventListener('click', async () => {
  const btn = $('#update-check');
  if (!navigator.onLine) return toast('Keine Internetverbindung');
  btn.disabled = true;
  btn.textContent = 'Suche…';
  try {
    await flushAll();
    const reg = swReg || (await navigator.serviceWorker?.getRegistration());
    if (!reg) { location.reload(); return; }
    await reg.update();
    const sw = reg.installing || reg.waiting;
    if (sw) {
      btn.textContent = 'Update wird geladen…';
      await new Promise((resolve) => {
        if (sw.state === 'activated') return resolve();
        sw.addEventListener('statechange', () => (sw.state === 'activated' || sw.state === 'redundant') && resolve());
        setTimeout(resolve, 15000);
      });
      toast('Update installiert');
      setTimeout(applyUpdate, 400);
      return;
    }
    toast('Du hast bereits die neueste Version');
  } catch {
    toast('Update-Suche fehlgeschlagen');
  }
  btn.disabled = false;
  btn.textContent = 'Nach Update suchen';
});

// ---------- Datensicherung (Datei) ----------
function bytesToB64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function b64ToBytes(b64) {
  const s = atob(b64);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}

$('#backup-save').addEventListener('click', async () => {
  await flushAll();
  const local = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    local[k] = localStorage.getItem(k);
  }
  let notes = [];
  try { notes = await noteDb.all(); } catch {}
  const json = JSON.stringify({ app: 'Lernheft', backup: 1, date: new Date().toISOString(), local, notes },
    (k, v) => (v instanceof Uint8Array ? { __u8: bytesToB64(v) } : v));
  const d = new Date();
  const name = `Lernheft-Sicherung-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.json`;
  shareFiles([new File([json], name, { type: 'application/json' })], 'Lernheft-Sicherung');
});

$('#backup-load').addEventListener('click', () => $('#backup-file').click());
$('#backup-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let data;
  try {
    data = JSON.parse(await file.text(), (k, v) => (v && typeof v === 'object' && typeof v.__u8 === 'string' ? b64ToBytes(v.__u8) : v));
  } catch { data = null; }
  if (!data || data.app !== 'Lernheft' || !data.local || !Array.isArray(data.notes)) return toast('Keine gültige Lernheft-Sicherung');
  const when = data.date ? new Date(data.date).toLocaleDateString('de-DE') : '?';
  if (!confirm(`Sicherung vom ${when} laden?\n${data.notes.length} Notizen. Deine jetzigen Daten werden dabei ersetzt.`)) return;
  try {
    await flushAll();
    window.appRestoring = true;
    for (const n of await noteDb.all()) await noteDb.del(n.id);
    for (const n of data.notes) await noteDb.put(n);
    localStorage.clear();
    for (const [k, v] of Object.entries(data.local)) localStorage.setItem(k, v);
  } catch {
    window.appRestoring = false;
    return toast('Laden fehlgeschlagen');
  }
  window.appRestoring = true;   // beim Neuladen nichts Altes mehr über die Sicherung schreiben
  location.reload();
});

// ---------- Start ----------
renderTodos();
setCounter(counter, false);
updateClock();
updateInfo();
setInterval(updateClock, 1000);
showView(store.get('view', 'home'));
