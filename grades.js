// ================= Notenrechner =================
// Noten 1–6 mit Tendenz: "2+" = 1,75 · "2" = 2,0 · "2-" = 2,25

const DEFAULT_SUBJECTS = ['Deutsch', 'Mathe', 'Englisch', 'Biologie', 'Geschichte', 'Erdkunde', 'Physik', 'Sport', 'Kunst', 'Musik'];
const GRADE_OPTIONS = [];
for (let n = 1; n <= 6; n++) {
  if (n > 1) GRADE_OPTIONS.push({ label: n + '+', value: n - 0.25 });
  GRADE_OPTIONS.push({ label: String(n), value: n });
  if (n < 6) GRADE_OPTIONS.push({ label: n + '-', value: n + 0.25 });
}
// 1+ gibt's an vielen Schulen auch
GRADE_OPTIONS.unshift({ label: '1+', value: 0.75 });

let subjects = store.get('subjects', []);
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function saveSubjects() {
  store.set('subjects', subjects);
  renderGrades();
  updateStats();
}

const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

// Schnitt eines Fachs: schriftlich und mündlich getrennt, dann gewichtet.
// Gibt es nur eine Art von Noten, zählt diese allein.
function subjectAverage(sub) {
  const s = mean(sub.grades.filter((g) => g.type === 's').map((g) => g.value));
  const m = mean(sub.grades.filter((g) => g.type === 'm').map((g) => g.value));
  if (s == null) return m;
  if (m == null) return s;
  const w = sub.weight / 100;
  return s * w + m * (1 - w);
}

window.gradeAverage = function () {
  return mean(subjects.map(subjectAverage).filter((a) => a != null));
};

function gradeColor(v) {
  if (v <= 1.5) return 'g1';
  if (v <= 2.5) return 'g2';
  if (v <= 3.5) return 'g3';
  if (v <= 4.5) return 'g4';
  return 'g5';
}

function comment(avg) {
  if (avg <= 1.5) return 'Überflieger! 🚀';
  if (avg <= 2.0) return 'Richtig stark 💪';
  if (avg <= 2.5) return 'Gut dabei 👍';
  if (avg <= 3.0) return 'Solide 🙂';
  if (avg <= 3.5) return 'Geht noch was 😅';
  if (avg <= 4.0) return 'Durchgekommen 😬';
  return 'Wir reden nicht drüber … 💀';
}

// ---------- Anzeige ----------
function gradeChip(sub, g) {
  const chip = document.createElement('button');
  chip.className = 'grade-chip ' + gradeColor(g.value);
  chip.textContent = g.label;
  if (g.note) chip.title = g.note;
  chip.addEventListener('click', () => {
    const what = g.note ? ` (${g.note})` : '';
    if (!confirm(`Note ${g.label}${what} in ${sub.name} löschen?`)) return;
    sub.grades = sub.grades.filter((x) => x !== g);
    saveSubjects();
  });
  return chip;
}

function gradeRow(sub, type, title) {
  const list = sub.grades.filter((g) => g.type === type);
  const row = document.createElement('div');
  row.className = 'grade-row';
  const label = document.createElement('div');
  label.className = 'grade-row-label muted';
  const avg = mean(list.map((g) => g.value));
  label.textContent = title + (avg != null ? ` · Ø ${formatGrade(avg)}` : '');
  const chips = document.createElement('div');
  chips.className = 'grade-chips';
  list.forEach((g) => chips.append(gradeChip(sub, g)));
  if (!list.length) {
    const none = document.createElement('span');
    none.className = 'muted small-text';
    none.textContent = 'noch keine';
    chips.append(none);
  }
  row.append(label, chips);
  return row;
}

function renderGrades() {
  const list = $('#subject-list');
  list.innerHTML = '';
  subjects.forEach((sub) => {
    const avg = subjectAverage(sub);
    const card = document.createElement('div');
    card.className = 'card subject-card';

    const head = document.createElement('div');
    head.className = 'subject-head';
    const name = document.createElement('button');
    name.className = 'subject-name';
    name.textContent = sub.name;
    name.addEventListener('click', () => openSubjectDialog(sub));
    const badge = document.createElement('div');
    badge.className = 'subject-avg ' + (avg != null ? gradeColor(avg) : 'none');
    badge.textContent = avg != null ? formatGrade(avg) : '–';
    head.append(name, badge);

    const add = document.createElement('button');
    add.className = 'btn small';
    add.textContent = '+ Note';
    add.addEventListener('click', () => openGradeDialog(sub));

    const weight = document.createElement('div');
    weight.className = 'muted small-text';
    weight.textContent = `Gewichtung ${sub.weight} : ${100 - sub.weight}`;

    const foot = document.createElement('div');
    foot.className = 'subject-foot';
    foot.append(weight, add);

    card.append(head, gradeRow(sub, 's', '✍️ Schriftlich'), gradeRow(sub, 'm', '💬 Mündlich'), foot);
    list.append(card);
  });

  const total = window.gradeAverage();
  $('#grades-empty').hidden = subjects.length > 0;
  $('#grade-total').hidden = subjects.length === 0;
  $('#grade-total-value').textContent = total != null ? formatGrade(total) : '–';
  $('#grade-total-comment').textContent = total != null ? comment(total) : 'Trag deine erste Note ein ✏️';
  const count = subjects.reduce((n, s) => n + s.grades.length, 0);
  $('#grade-total-count').textContent = `${count} ${count === 1 ? 'Note' : 'Noten'} in ${subjects.length} ${subjects.length === 1 ? 'Fach' : 'Fächern'}`;
}

// ---------- Note hinzufügen ----------
let gradeTarget = null;
let gradeType = 's';

GRADE_OPTIONS.forEach((o) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'grade-option ' + gradeColor(o.value);
  b.textContent = o.label;
  b.addEventListener('click', () => {
    if (!gradeTarget) return;
    gradeTarget.grades.push({
      value: o.value,
      label: o.label,
      type: gradeType,
      note: $('#grade-label').value.trim(),
      date: Date.now()
    });
    $('#grade-dialog').close();
    saveSubjects();
    toast(`${o.label} in ${gradeTarget.name} eingetragen`);
  });
  $('#grade-picker').append(b);
});

function setGradeType(type) {
  gradeType = type;
  document.querySelectorAll('#grade-type button').forEach((b) => b.classList.toggle('active', b.dataset.type === type));
}
document.querySelectorAll('#grade-type button').forEach((b) => b.addEventListener('click', () => setGradeType(b.dataset.type)));

function openGradeDialog(sub) {
  gradeTarget = sub;
  $('#grade-dialog-title').textContent = `Note in ${sub.name}`;
  $('#grade-label').value = '';
  $('#grade-dialog').showModal();
}

// ---------- Fach anlegen / bearbeiten ----------
let subjectTarget = null;

function updateWeightText() {
  const w = Number($('#subject-weight').value);
  $('#subject-weight-text').textContent = `${w} % schriftlich · ${100 - w} % mündlich`;
}
$('#subject-weight').addEventListener('input', updateWeightText);

function openSubjectDialog(sub) {
  subjectTarget = sub || null;
  $('#subject-dialog-title').textContent = sub ? 'Fach bearbeiten' : 'Neues Fach';
  $('#subject-name').value = sub ? sub.name : '';
  $('#subject-weight').value = sub ? sub.weight : 50;
  $('#subject-delete').hidden = !sub;
  updateWeightText();
  $('#subject-dialog').showModal();
}

$('#subject-add').addEventListener('click', () => openSubjectDialog());

$('#subject-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('#subject-name').value.trim();
  if (!name) return;
  const weight = Number($('#subject-weight').value);
  if (subjectTarget) {
    subjectTarget.name = name;
    subjectTarget.weight = weight;
  } else {
    subjects.push({ id: newId(), name, weight, grades: [] });
  }
  $('#subject-dialog').close();
  saveSubjects();
});

$('#subject-delete').addEventListener('click', () => {
  if (!subjectTarget) return;
  if (!confirm(`${subjectTarget.name} mit allen Noten löschen?`)) return;
  subjects = subjects.filter((s) => s !== subjectTarget);
  $('#subject-dialog').close();
  saveSubjects();
});

$('#subjects-default').addEventListener('click', () => {
  subjects = DEFAULT_SUBJECTS.map((name) => ({ id: newId(), name, weight: 50, grades: [] }));
  saveSubjects();
});

renderGrades();
updateStats();
