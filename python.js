// ================= Python-Editor =================
const PY_TEMPLATES = [
  { name: 'Leeres Programm', code: '' },
  { name: '👋 Hallo', code: `name = input("Wie heißt du? ")
print("Hallo", name + "!")

alter = int(input("Wie alt bist du? "))
print("In 10 Jahren bist du", alter + 10)
` },
  { name: '🎲 Zahlenraten', code: `import random

zahl = random.randint(1, 100)
versuche = 0
print("Ich denke mir eine Zahl zwischen 1 und 100 aus.")

while True:
    tipp = int(input("Dein Tipp: "))
    versuche += 1
    if tipp < zahl:
        print("Zu klein! ⬆️")
    elif tipp > zahl:
        print("Zu groß! ⬇️")
    else:
        print(f"Richtig! 🎉 Du hast {versuche} Versuche gebraucht.")
        break
` },
  { name: '✖️ Einmaleins', code: `for i in range(1, 11):
    zeile = ""
    for j in range(1, 11):
        zeile += f"{i * j:4}"
    print(zeile)
` },
  { name: '🎓 Notenschnitt', code: `noten = [2, 3, 1, 2, 4, 2]

schnitt = sum(noten) / len(noten)
print("Noten:", noten)
print(f"Schnitt: {schnitt:.2f}")
print("Beste Note:", min(noten))
print("Schlechteste Note:", max(noten))
` },
  { name: '📈 Funktionsgraph', code: `import matplotlib.pyplot as plt

x = [i / 10 for i in range(-50, 51)]
y = [wert ** 2 - 4 for wert in x]

plt.plot(x, y, label="f(x) = x² - 4")
plt.axhline(0, color="gray", linewidth=0.8)
plt.axvline(0, color="gray", linewidth=0.8)
plt.grid(True, alpha=0.3)
plt.legend()
plt.title("Parabel")
plt.show()
` },
  { name: '⏳ Countdown', code: `import time

for i in range(5, 0, -1):
    print(i, "...")
    time.sleep(1)
print("🚀 Start!")
` }
];

const KEYS = [
  { label: '⇥', text: '    ', wide: true, title: 'Einrücken' },
  { label: ':', text: ':' }, { label: '(', text: '(' }, { label: ')', text: ')' },
  { label: '"', text: '"' }, { label: "'", text: "'" }, { label: '=', text: '=' },
  { label: '[', text: '[' }, { label: ']', text: ']' }, { label: '{', text: '{' }, { label: '}', text: '}' },
  { label: '+', text: '+' }, { label: '-', text: '-' }, { label: '*', text: '*' }, { label: '/', text: '/' },
  { label: '<', text: '<' }, { label: '>', text: '>' }, { label: '#', text: '#' }, { label: '_', text: '_' },
  { label: ',', text: ',' }, { label: '.', text: '.' },
  { label: 'print', text: 'print()', back: 1, wide: true },
  { label: 'input', text: 'input()', back: 1, wide: true },
  { label: 'if', text: 'if :', back: 1, wide: true },
  { label: 'for', text: 'for i in range():', back: 2, wide: true },
  { label: 'while', text: 'while :', back: 1, wide: true }
];

const code = $('#py-code');
const consoleEl = $('#py-console');

// ---------- Programme speichern ----------
let programs = store.get('pyPrograms', null);
if (!programs || !programs.length) {
  programs = [{ id: 'p1', name: 'Hallo', code: PY_TEMPLATES[1].code }];
}
let current = programs.find((p) => p.id === store.get('pyCurrent')) || programs[0];
let pySaveTimer = null;

function savePrograms() {
  store.set('pyPrograms', programs);
  store.set('pyCurrent', current.id);
}

function renderProgramSelect() {
  const sel = $('#py-program');
  sel.innerHTML = '';
  programs.forEach((p) => {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.name;
    sel.append(o);
  });
  sel.value = current.id;
}

function openProgram(p) {
  current = p;
  code.value = p.code;
  code.scrollTop = code.scrollLeft = 0;
  markErrorLine(null);
  updateGutter();
  renderProgramSelect();
  savePrograms();
}

$('#py-program').addEventListener('change', (e) => {
  const p = programs.find((x) => x.id === e.target.value);
  if (p) openProgram(p);
});

PY_TEMPLATES.forEach((t) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'menu-item';
  b.textContent = t.name;
  b.addEventListener('click', () => {
    $('#py-new-dialog').close();
    const base = t.code ? t.name.replace(/^\S+\s/, '') : 'Programm';
    let name = base, n = 2;
    while (programs.some((p) => p.name === name)) name = `${base} ${n++}`;
    const p = { id: Date.now().toString(36), name, code: t.code };
    programs.push(p);
    openProgram(p);
    code.focus();
  });
  $('#py-templates').append(b);
});

$('#py-new').addEventListener('click', () => $('#py-new-dialog').showModal());

$('#py-rename').addEventListener('click', () => {
  const name = prompt('Neuer Name:', current.name);
  if (!name || !name.trim()) return;
  current.name = name.trim().slice(0, 30);
  renderProgramSelect();
  savePrograms();
});

$('#py-delete').addEventListener('click', () => {
  if (!confirm(`„${current.name}“ löschen?`)) return;
  programs = programs.filter((p) => p !== current);
  if (!programs.length) programs.push({ id: Date.now().toString(36), name: 'Programm', code: '' });
  openProgram(programs[0]);
});

// ---------- Editor ----------
function updateGutter() {
  const lines = code.value.split('\n').length;
  const g = $('#py-gutter');
  if (g.childElementCount !== lines || g.dataset.err) {
    g.innerHTML = '';
    for (let i = 1; i <= lines; i++) {
      const span = document.createElement('span');
      span.textContent = i;
      if (Number(g.dataset.err) === i) span.className = 'err';
      g.append(span, '\n');
    }
  }
  g.scrollTop = code.scrollTop;
}

function markErrorLine(line) {
  const g = $('#py-gutter');
  if (line) g.dataset.err = line;
  else delete g.dataset.err;
  g.innerHTML = '';
  updateGutter();
}

code.addEventListener('scroll', () => { $('#py-gutter').scrollTop = code.scrollTop; });

code.addEventListener('input', () => {
  // iOS macht aus " gerne „ “ – das versteht Python nicht
  if (/[“”„‘’‚]/.test(code.value)) {
    const pos = code.selectionStart;
    code.value = code.value.replace(/[“”„]/g, '"').replace(/[‘’‚]/g, "'");
    code.setSelectionRange(pos, pos);
  }
  current.code = code.value;
  clearTimeout(pySaveTimer);
  pySaveTimer = setTimeout(savePrograms, 400);
  updateGutter();
});

function insert(text, back = 0) {
  const start = code.selectionStart, end = code.selectionEnd;
  code.setRangeText(text, start, end, 'end');
  const pos = start + text.length - back;
  code.setSelectionRange(pos, pos);
  code.dispatchEvent(new Event('input'));
}

code.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    insert('    ');
  } else if (e.key === 'Enter' && !e.isComposing) {
    // Automatisch einrücken: gleiche Einrückung wie die Zeile davor, nach ":" vier mehr
    e.preventDefault();
    const before = code.value.slice(0, code.selectionStart);
    const line = before.slice(before.lastIndexOf('\n') + 1);
    let indent = line.match(/^\s*/)[0];
    if (/:\s*(#.*)?$/.test(line)) indent += '    ';
    insert('\n' + indent);
    scrollCaretIntoView();
  }
});

function scrollCaretIntoView() {
  const lineIdx = code.value.slice(0, code.selectionStart).split('\n').length - 1;
  const lh = parseFloat(getComputedStyle(code).lineHeight);
  const y = lineIdx * lh + 12;
  if (y + lh * 2 > code.scrollTop + code.clientHeight) code.scrollTop = y + lh * 2 - code.clientHeight;
}

KEYS.forEach((k) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'py-key' + (k.wide ? ' wide' : '');
  b.textContent = k.label;
  if (k.title) b.setAttribute('aria-label', k.title);
  // pointerdown statt click: so bleibt die Tastatur offen
  b.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (document.activeElement !== code) code.focus();
    insert(k.text, k.back || 0);
  });
  $('#py-keys').append(b);
});

// ---------- Ausgabe ----------
function writeConsole(text, cls) {
  const last = consoleEl.lastElementChild;
  if (last && last.tagName === 'SPAN' && last.className === (cls || '')) {
    last.textContent += text;
  } else {
    const span = document.createElement('span');
    if (cls) span.className = cls;
    span.textContent = text;
    consoleEl.append(span);
  }
  consoleEl.scrollTop = consoleEl.scrollHeight;
}

function ensureNewline() {
  if (consoleEl.textContent && !consoleEl.textContent.endsWith('\n')) writeConsole('\n');
}

function setStatus(text) { $('#py-status').textContent = text; }

$('#py-clear').addEventListener('click', () => { consoleEl.innerHTML = ''; });

// ---------- Worker / Ausführung ----------
let worker = null;
let pyReady = false;
let running = false;
let run = null; // { code, inputs, seed, start }

function startWorker() {
  pyReady = false;
  setStatus('🐍 Python wird geladen … (beim ersten Mal ca. 10 MB)');
  worker = new Worker('py-worker.js');
  worker.onmessage = onWorkerMessage;
  worker.onerror = () => {
    setStatus('');
    writeConsole('Python konnte nicht geladen werden. Beim ersten Start braucht die App Internet.\n', 'err');
    worker = null;
    setRunning(false);
  };
}

function onWorkerMessage(e) {
  const m = e.data;
  if (m.type === 'ready') {
    pyReady = true;
    setStatus(running ? '⏳ Läuft …' : `Bereit · Python ${m.version ? '(Pyodide ' + m.version + ')' : ''}`);
  } else if (m.type === 'fatal') {
    setStatus('');
    writeConsole('Python konnte nicht geladen werden. Beim ersten Start braucht die App Internet.\n', 'err');
    worker.terminate();
    worker = null;
    setRunning(false);
  } else if (m.type === 'status') {
    setStatus('📦 ' + m.text.replace(/^Loading/, 'Lade').replace(/^Loaded/, 'Geladen:'));
  } else if (m.type === 'out') {
    writeConsole(m.text);
  } else if (m.type === 'err') {
    writeConsole(m.text, 'err');
  } else if (m.type === 'image') {
    const img = document.createElement('img');
    img.src = 'data:image/png;base64,' + m.data;
    img.alt = 'Diagramm';
    consoleEl.append(img);
    img.onload = () => { consoleEl.scrollTop = consoleEl.scrollHeight; };
  } else if (m.type === 'done') {
    onDone(m.result);
  }
}

function onDone(result) {
  if (result.status === 'input') {
    askInput(result.prompt);
    return;
  }
  setRunning(false);
  const secs = ((performance.now() - run.start) / 1000).toFixed(1);
  if (result.status === 'error') {
    ensureNewline();
    writeConsole(result.error, 'err');
    markErrorLine(result.line);
    setStatus(`❌ Fehler${result.line ? ' in Zeile ' + result.line : ''}`);
  } else {
    setStatus(`✅ Fertig (${secs} s)`);
  }
}

function askInput(promptText) {
  setStatus('⌨️ Wartet auf deine Eingabe');
  const row = document.createElement('div');
  row.className = 'py-input-row';
  const p = document.createElement('span');
  p.className = 'prompt';
  p.textContent = promptText;
  const input = document.createElement('input');
  input.setAttribute('autocapitalize', 'off');
  input.setAttribute('autocorrect', 'off');
  input.setAttribute('enterkeyhint', 'send');
  row.append(p, input);
  consoleEl.append(row);
  consoleEl.scrollTop = consoleEl.scrollHeight;
  input.focus();

  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !running) return;
    e.preventDefault();
    const value = input.value;
    row.remove();
    writeConsole(promptText);
    writeConsole(value + '\n', 'echo');
    run.inputs.push(value);
    setStatus('⏳ Läuft …');
    worker.postMessage({ type: 'run', code: run.code, inputs: run.inputs, seed: run.seed });
  });
}

function setRunning(on) {
  running = on;
  const b = $('#py-run');
  b.textContent = on ? '⏹ Stopp' : '▶ Ausführen';
  b.classList.toggle('stop', on);
}

function startRun() {
  code.blur();
  clearTimeout(pySaveTimer);
  savePrograms();
  markErrorLine(null);
  consoleEl.innerHTML = '';
  if (!worker) startWorker();
  run = { code: code.value, inputs: [], seed: Math.floor(Math.random() * 1e9), start: performance.now() };
  setRunning(true);
  if (pyReady) setStatus('⏳ Läuft …');
  worker.postMessage({ type: 'run', code: run.code, inputs: [], seed: run.seed });
}

function stopRun() {
  consoleEl.querySelectorAll('.py-input-row').forEach((r) => r.remove());
  ensureNewline();
  writeConsole('⏹ Programm gestoppt\n', 'info');
  setRunning(false);
  if (worker) worker.terminate();
  worker = null;
  startWorker(); // gleich wieder bereit machen (kommt aus dem Speicher, geht schnell)
}

$('#py-run').addEventListener('click', () => (running ? stopRun() : startRun()));

// Python erst laden, wenn die Seite zum ersten Mal geöffnet wird
window.addEventListener('viewchange', (e) => {
  if (e.detail === 'python' && !worker) startWorker();
});

// Beim Schließen/Wechseln der App sofort speichern
const flushSave = () => { clearTimeout(pySaveTimer); savePrograms(); };
window.addEventListener('pagehide', flushSave);
document.addEventListener('visibilitychange', () => document.hidden && flushSave());

// ---------- Start ----------
openProgram(current);
if (document.body.dataset.view === 'python') startWorker();
