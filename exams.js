// ---------- Schulaufgaben-Planer ----------
// Prüfungen mit Fach, Art, Datum und Stoff – privat oder mit der Klasse geteilt (orbit.js).

const EXAM_KINDS = [['Schulaufgabe', 'SA'], ['Kurzarbeit', 'KA'], ['Stegreifaufgabe', 'Ex'], ['Test', 'Test'], ['Referat', 'Ref'], ['Abgabe', 'Abg'], ['Sonstiges', '!'], ['KASL', 'KASL'];
let exams = store.get('exams', []);
let examEdit = null;
let examShowPast = false;

function saveExams() {
  store.set('exams', exams);
}
const examShort = (kind) => (EXAM_KINDS.find(([k]) => k === kind) || [, '!'])[1];
const examDays = (iso) => Math.round((new Date(iso + 'T00:00') - new Date(new Date().toDateString())) / 864e5);
const examCountdown = (iso) => { const n = examDays(iso); return n === 0 ? 'heute' : n === 1 ? 'morgen' : n < 0 ? `vor ${-n} Tagen` : `in ${n} Tagen`; };
// Prüfung an diesem Tag in diesem Fach (für den Stundenplan)
const examOn = (su, iso) => exams.find((x) => x.su === su && x.date === iso);

function examSubjectOptions(sel) {
  const subs = hwSubjects();
  return '<option value="">Fach …</option>' + subs.map((s) => `<option value="${untisEsc(s.su)}"${s.su === sel ? ' selected' : ''}>${untisEsc(s.long ? `${s.su} – ${s.long}` : s.su)}</option>`).join('') +
    (sel && !subs.some((s) => s.su === sel) ? `<option value="${untisEsc(sel)}" selected>${untisEsc(sel)}</option>` : '') + '<option value="__new">Anderes Fach …</option>';
}
const examKindOptions = (sel) => EXAM_KINDS.map(([k]) => `<option${k === sel ? ' selected' : ''}>${k}</option>`).join('');
function examPickOther(sel) {
  if (sel.value !== '__new') return;
  const su = (prompt('Fach (Kürzel oder Name):') || '').trim().slice(0, 20);
  sel.value = '';
  if (!su) return;
  const o = document.createElement('option');
  o.value = o.textContent = su;
  sel.insertBefore(o, sel.lastElementChild);
  sel.value = su;
}

function renderExams() {
  const box = $('#ex-list');
  if (!box) return;
  // Formular (Fächer und Klassen können sich ändern)
  const f = $('#ex-form');
  const keep = { su: $('#ex-su') && $('#ex-su').value, kind: $('#ex-kind') && $('#ex-kind').value };
  $('#ex-su').innerHTML = examSubjectOptions(keep.su);
  $('#ex-kind').innerHTML = examKindOptions(keep.kind || 'Schulaufgabe');
  $('#ex-share-box').innerHTML = orbitShareSelect('ex-share');
  f.classList.toggle('has-share', !!$('#ex-share'));
  const today = untisIso(new Date());
  const up = exams.filter((x) => x.date >= today).sort((a, b) => a.date.localeCompare(b.date));
  const past = exams.filter((x) => x.date < today).sort((a, b) => b.date.localeCompare(a.date));
  box.innerHTML = '';
  if (!up.length) box.innerHTML = '<div class="card hw-empty muted">Keine anstehenden Prüfungen. Trag oben eine ein.</div>';
  let month = '';
  let ul = null;
  for (const x of up) {
    const m = new Date(x.date + 'T00:00').toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
    if (m !== month) {
      month = m;
      const h = document.createElement('h3');
      h.className = 'set-title';
      h.textContent = m;
      ul = document.createElement('ul');
      ul.className = 'list-group hw-items';
      box.append(h, ul);
    }
    ul.append(examItem(x));
  }
  if (past.length) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn link hw-done-toggle';
    b.textContent = `${examShowPast ? '▾' : '▸'} Vergangen (${past.length})`;
    b.addEventListener('click', () => { examShowPast = !examShowPast; renderExams(); });
    box.append(b);
    if (examShowPast) {
      const pl = document.createElement('ul');
      pl.className = 'list-group hw-items past';
      past.forEach((x) => pl.append(examItem(x)));
      box.append(pl);
    }
  }
}

function examItem(x) {
  const li = document.createElement('li');
  const n = examDays(x.date);
  li.className = 'hw-item ex-item' + (n >= 0 && n <= 3 ? ' soon' : '');
  li.style.setProperty('--c', hwColor(x.su));
  const d = new Date(x.date + 'T00:00');
  li.innerHTML = `<div class="ex-date"><b>${d.getDate()}</b><span>${d.toLocaleDateString('de-DE', { weekday: 'short' })}</span></div>` +
    '<div class="hw-main"><div class="hw-text"><b class="ex-su"></b> <span class="ex-kind"></span></div><div class="ex-topics"></div><div class="hw-meta"></div></div>' +
    `<div class="ex-count">${examCountdown(x.date)}</div>`;
  li.querySelector('.ex-su').textContent = x.suLong || x.su;
  li.querySelector('.ex-kind').textContent = !x.title ? x.kind : x.title.toLowerCase().includes(x.kind.toLowerCase()) ? x.title : `${x.kind} · ${x.title}`;
  li.querySelector('.ex-topics').textContent = x.topics || '';
  li.querySelector('.hw-meta').textContent = orbitByline(x);
  li.addEventListener('click', () => examOpenEdit(x));
  return li;
}

// ---- Bearbeiten ----
function examOpenEdit(x) {
  examEdit = x;
  const mine = orbitCanEdit(x);
  $('#exe-su').innerHTML = examSubjectOptions(x.su);
  $('#exe-kind').innerHTML = examKindOptions(x.kind);
  $('#exe-date').value = x.date;
  $('#exe-title').value = x.title || '';
  $('#exe-topics').value = x.topics || '';
  $('#ex-edit').querySelectorAll('input, select, textarea').forEach((el) => { el.disabled = !mine; });
  $('#exe-save').hidden = !mine;
  $('#exe-del').textContent = mine ? 'Löschen' : 'Ausblenden';
  $('#exe-note').textContent = x.shared ? orbitByline(x) + (mine ? '' : ' – ändern kann nur, wer es eingetragen hat') : '';
  $('#ex-edit').showModal();
}
$('#exe-su').addEventListener('change', (e) => examPickOther(e.target));
$('#exe-save').addEventListener('click', () => {
  const x = examEdit;
  const su = $('#exe-su').value;
  if (!x || !su || !$('#exe-date').value) return toast('Fach und Datum ausfüllen');
  Object.assign(x, { su, suLong: (hwSubjects().find((s) => s.su === su) || {}).long || x.suLong || '', kind: $('#exe-kind').value, date: $('#exe-date').value, title: $('#exe-title').value.trim(), topics: $('#exe-topics').value.trim() });
  orbitUpdate('exams', x);
  saveExams();
  $('#ex-edit').close();
  examsChanged();
});
$('#exe-del').addEventListener('click', () => {
  const x = examEdit;
  if (!x) return;
  if (x.shared && orbitCanEdit(x) && !confirm('Für die ganze Klasse löschen?')) return;
  orbitRemove('exams', x);
  exams.splice(exams.indexOf(x), 1);
  saveExams();
  $('#ex-edit').close();
  examsChanged();
});

// ---- Neu ----
$('#ex-su').addEventListener('change', (e) => examPickOther(e.target));
$('#ex-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const su = $('#ex-su').value, date = $('#ex-date').value;
  if (!su || !date) return toast('Fach und Datum wählen');
  const x = { id: 'x' + Date.now().toString(36), su, suLong: (hwSubjects().find((s) => s.su === su) || {}).long || '', kind: $('#ex-kind').value, title: $('#ex-title').value.trim(), date, topics: $('#ex-topics').value.trim() };
  exams.push(x);
  orbitAdd('exams', orbitShareValue('ex-share'), x);
  saveExams();
  $('#ex-title').value = '';
  $('#ex-topics').value = '';
  examsChanged();
  toast(`${x.kind} ${x.su} eingetragen – ${examCountdown(date)}`);
});

function examsChanged() {
  renderExams();
  renderUntis();
  renderExamsHome();
}

// Startseite: nächste Prüfung
function renderExamsHome() {
  const el = $('#stat-exam');
  if (!el) return;
  const next = exams.filter((x) => x.date >= untisIso(new Date())).sort((a, b) => a.date.localeCompare(b.date))[0];
  el.closest('.card').hidden = !next;
  if (!next) return;
  el.textContent = next.su;
  $('#stat-exam-sub').textContent = `${next.kind} ${examCountdown(next.date)}`;
}
$('#stat-exam').closest('.card').addEventListener('click', () => showView('exams'));

window.addEventListener('viewchange', (e) => {
  if (e.detail === 'exams') renderExams();
  if (e.detail === 'home') renderExamsHome();
});
renderExamsHome();
setTimeout(() => { if (document.body.dataset.view === 'exams') renderExams(); }, 0);
