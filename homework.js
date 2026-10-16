// ---------- Hausaufgaben-Übersicht ----------
// Hausaufgaben sind Aufgaben mit „hw“ (Fach, aufgegeben, fällig) – dieselben Einträge wie in
// der Aufgabenliste und im Stundenplan. Hier: nach Fälligkeit gruppiert, Filter nach Fach.

let hwFilter = store.get('hwFilter', 'all');
let hwShowDone = false;
let hwEdit = null;

// Fächer: aus dem Untis-Plan (mit Farbe), dazu alle, die schon in Hausaufgaben vorkommen
function hwSubjects() {
  const map = new Map();
  for (const l of untisAllLessons()) if (l.su && !map.has(l.su)) map.set(l.su, { su: l.su, long: l.suLong || '', bg: l.bg || '' });
  for (const t of untisHw()) if (!map.has(t.hw.su)) map.set(t.hw.su, { su: t.hw.su, long: t.hw.suLong || '', bg: '' });
  return [...map.values()].sort((a, b) => (a.long || a.su).localeCompare(b.long || b.su, 'de'));
}
const hwColor = (su) => (hwSubjects().find((s) => s.su === su) || {}).bg || 'var(--muted)';

// Fälligkeit: nächste Stunde des Fachs ab morgen, sonst in einer Woche
function hwAutoDue(su) {
  const nx = su && untisNextOf({ su, date: untisIso(new Date()) });
  return nx ? nx.date : untisIso(untisAddDays(new Date(), 7));
}

function hwGroup(due) {
  const today = untisIso(new Date()), tomorrow = untisIso(untisAddDays(new Date(), 1));
  if (due < today) return ['0', 'Überfällig'];
  if (due === today) return ['1', 'Heute'];
  if (due === tomorrow) return ['2', 'Morgen'];
  const d = new Date(due + 'T00:00'), week = untisIso(untisAddDays(new Date(), 7));
  if (due <= week) return ['3' + due, d.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'numeric' })];
  return ['9', 'Später'];
}

function renderHomework() {
  const box = $('#hw-list');
  if (!box) return;
  const subs = hwSubjects();
  if (hwFilter !== 'all' && !subs.some((s) => s.su === hwFilter)) hwFilter = 'all';
  // Filter-Chips
  const all = untisHw();
  const open = all.filter((t) => !t.done);
  const chips = $('#hw-chips');
  chips.innerHTML = '';
  const chip = (id, label, n, color) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip' + (hwFilter === id ? ' active' : '');
    b.innerHTML = (color ? `<i class="hw-dot" style="background:${color}"></i>` : '') + `<span></span>` + (n ? ` <small>${n}</small>` : '');
    b.querySelector('span').textContent = label;
    b.addEventListener('click', () => { hwFilter = id; store.set('hwFilter', id); renderHomework(); });
    chips.append(b);
  };
  chip('all', 'Alle', open.length);
  for (const s of subs) { const n = open.filter((t) => t.hw.su === s.su).length; if (n || hwFilter === s.su) chip(s.su, s.su, n, s.bg); }
  // Fach-Auswahl im Formular
  const sel = $('#hw-su');
  const cur = sel.value;
  sel.innerHTML = '<option value="">Fach …</option>' + subs.map((s) => `<option value="${untisEsc(s.su)}">${untisEsc(s.long ? `${s.su} – ${s.long}` : s.su)}</option>`).join('') + '<option value="__new">Anderes Fach …</option>';
  sel.value = subs.some((s) => s.su === cur) ? cur : hwFilter !== 'all' ? hwFilter : '';
  const share = $('#hw-share-box');
  if (share && !share.contains(document.activeElement)) share.innerHTML = orbitShareSelect('hw-share');
  // Liste nach Fälligkeit
  const shown = all.filter((t) => hwFilter === 'all' || t.hw.su === hwFilter);
  const groups = new Map();
  for (const t of shown.filter((x) => !x.done).sort((a, b) => a.hw.due.localeCompare(b.hw.due))) {
    const [k, label] = hwGroup(t.hw.due);
    if (!groups.has(k)) groups.set(k, { label, items: [] });
    groups.get(k).items.push(t);
  }
  box.innerHTML = '';
  if (!groups.size) box.innerHTML = `<div class="card hw-empty muted">${all.length ? 'Alles erledigt 🎉' : 'Noch keine Hausaufgaben. Trag oben eine ein – oder tippe im Stundenplan auf eine Stunde.'}</div>`;
  for (const [k, g] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const h = document.createElement('h3');
    h.className = 'set-title hw-group' + (k === '0' ? ' late' : '');
    h.textContent = `${g.label} · ${g.items.length}`;
    const ul = document.createElement('ul');
    ul.className = 'list-group hw-items';
    g.items.forEach((t) => ul.append(hwItem(t, k === '9' || k === '0')));
    box.append(h, ul);
  }
  // Erledigte (eingeklappt)
  const done = shown.filter((t) => t.done);
  if (done.length) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn link hw-done-toggle';
    b.textContent = `${hwShowDone ? '▾' : '▸'} Erledigt (${done.length})`;
    b.addEventListener('click', () => { hwShowDone = !hwShowDone; renderHomework(); });
    box.append(b);
    if (hwShowDone) {
      const ul = document.createElement('ul');
      ul.className = 'list-group hw-items';
      done.sort((a, b) => b.hw.due.localeCompare(a.hw.due)).forEach((t) => ul.append(hwItem(t, true)));
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'btn small hw-clear';
      clear.textContent = 'Erledigte löschen';
      clear.addEventListener('click', () => {
        if (!confirm(`${done.length} erledigte Hausaufgaben löschen?`)) return;
        todos = todos.filter((x) => !(x.hw && x.done && (hwFilter === 'all' || x.hw.su === hwFilter)));
        saveTodos();
        renderHomework();
      });
      box.append(ul, clear);
    }
  }
}

function hwItem(t, showDate) {
  const li = document.createElement('li');
  li.className = 'hw-item' + (t.done ? ' done' : '');
  li.style.setProperty('--c', hwColor(t.hw.su));
  const due = new Date(t.hw.due + 'T00:00');
  li.innerHTML = '<button type="button" class="check" aria-label="Erledigt"></button><div class="hw-main"><div class="hw-text"></div><div class="hw-meta"><b></b><span></span></div></div>';
  li.querySelector('.check').textContent = t.done ? '✓' : '';
  li.querySelector('.hw-text').textContent = t.text;
  li.querySelector('.hw-meta b').textContent = t.hw.suLong ? `${t.hw.su} · ${t.hw.suLong}` : t.hw.su;
  li.querySelector('.hw-meta span').textContent = (showDate ? ` · fällig ${due.toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'numeric' })}` : '') +
    (t.hw.assigned ? ` · aufgegeben ${new Date(t.hw.assigned + 'T00:00').toLocaleDateString('de-DE', { day: 'numeric', month: 'numeric' })}` : '') +
    (t.shared ? ' · ' + orbitByline(t) : '');
  li.querySelector('.check').addEventListener('click', () => { t.done = !t.done; saveTodos(); renderHomework(); renderUntisHome(); });
  li.querySelector('.hw-main').addEventListener('click', () => hwOpenEdit(t));
  return li;
}

// Bearbeiten
function hwOpenEdit(t) {
  hwEdit = t;
  $('#hwe-text').value = t.text;
  $('#hwe-su').value = t.hw.su;
  $('#hwe-due').value = t.hw.due;
  const mine = orbitCanEdit(t);
  ['#hwe-text', '#hwe-su', '#hwe-due'].forEach((s) => { $(s).disabled = !mine; });
  $('#hwe-save').hidden = !mine;
  $('#hwe-del').textContent = mine ? 'Löschen' : 'Ausblenden';
  $('#hwe-note').textContent = t.shared ? orbitByline(t) + (mine ? '' : ' – ändern kann nur, wer es eingetragen hat') : '';
  $('#hw-edit').showModal();
}
$('#hwe-save').addEventListener('click', () => {
  const t = hwEdit;
  if (!t) return;
  const text = $('#hwe-text').value.trim(), su = $('#hwe-su').value.trim();
  if (!text || !su || !$('#hwe-due').value) return toast('Text, Fach und Datum ausfüllen');
  t.text = text;
  if (su !== t.hw.su) { t.hw.su = su; t.hw.suLong = (hwSubjects().find((s) => s.su === su) || {}).long || ''; }
  t.hw.due = $('#hwe-due').value;
  orbitUpdate('homework', t);
  saveTodos();
  $('#hw-edit').close();
  renderHomework();
  renderUntisHome();
});
$('#hwe-del').addEventListener('click', () => {
  if (!hwEdit) return;
  if (hwEdit.shared && orbitCanEdit(hwEdit) && !confirm('Für die ganze Klasse löschen?')) return;
  orbitRemove('homework', hwEdit);
  todos.splice(todos.indexOf(hwEdit), 1);
  saveTodos();
  $('#hw-edit').close();
  renderHomework();
  renderUntisHome();
});

// Neue Hausaufgabe
let hwDueTouched = false;
$('#hw-su').addEventListener('change', (e) => {
  if (e.target.value === '__new') {
    const su = (prompt('Fach (Kürzel oder Name):') || '').trim().slice(0, 20);
    e.target.value = '';
    if (!su) return;
    const o = document.createElement('option');
    o.value = o.textContent = su;
    e.target.insertBefore(o, e.target.lastElementChild);
    e.target.value = su;
  }
  if (!hwDueTouched && e.target.value) hwRefineDue(e.target.value);
});

// Fälligkeit setzen; ist die nächste Stunde noch nicht geladen, die folgenden Wochen nachholen
async function hwRefineDue(su) {
  $('#hw-due').value = hwAutoDue(su);
  if (untisNextOf({ su, date: untisIso(new Date()) }) || !untisReady()) return;
  let m = untisMondayOf(new Date());
  for (let i = 0; i < 3; i++) {
    m = untisAddDays(m, 7);
    if (!untisCache.weeks[untisIso(m)]) { try { await untisFetchWeek(m); } catch { return; } }
    if (hwDueTouched || $('#hw-su').value !== su) return;
    if (untisNextOf({ su, date: untisIso(new Date()) })) { $('#hw-due').value = hwAutoDue(su); return; }
  }
}
$('#hw-due').addEventListener('input', () => { hwDueTouched = true; });
$('#hw-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('#hw-text').value.trim(), su = $('#hw-su').value;
  if (!text) return;
  if (!su) return toast('Bitte ein Fach wählen');
  const due = $('#hw-due').value || hwAutoDue(su);
  const t = { text, done: false, hw: { su, suLong: (hwSubjects().find((s) => s.su === su) || {}).long || '', assigned: untisIso(new Date()), due } };
  todos.push(t);
  orbitAdd('homework', orbitShareValue('hw-share'), t);
  saveTodos();
  $('#hw-text').value = '';
  hwDueTouched = false;
  hwRefineDue(su);
  renderHomework();
  renderUntisHome();
  toast(`Eingetragen – fällig ${untisDayLabel(due)}`);
});

window.addEventListener('viewchange', (e) => { if (e.detail === 'homework') { if (!$('#hw-due').value) $('#hw-due').value = untisIso(untisAddDays(new Date(), 1)); renderHomework(); } });
setTimeout(() => { if (document.body.dataset.view === 'homework') renderHomework(); }, 0);
