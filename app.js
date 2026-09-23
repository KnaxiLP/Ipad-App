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
  updateStats();
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
    h < 11 ? 'Guten Morgen! ☀️' : h < 18 ? 'Hallo! 👋' : 'Guten Abend! 🌙';
}

function updateStats() {
  $('#stat-todos').textContent = todos.filter((t) => !t.done).length;
  $('#stat-counter').textContent = counter;
  $('#stat-mode').textContent = isStandalone ? '📱 App' : '🌐 Browser';
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
    del.textContent = '🗑';
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
  $('#info-standalone').textContent = isStandalone ? 'Ja ✅' : 'Nein (Browser)';
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

// ---------- Service Worker (Offline) ----------
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js')
    .then(() => { $('#info-sw').textContent = 'Aktiv ✅'; })
    .catch(() => { $('#info-sw').textContent = 'Nicht verfügbar'; });
} else {
  $('#info-sw').textContent = 'Nicht unterstützt';
}

// ---------- Start ----------
renderTodos();
setCounter(counter, false);
updateClock();
updateInfo();
setInterval(updateClock, 1000);
showView(store.get('view', 'home'));
