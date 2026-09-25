// ================= Notizen mit Stift =================
// Striche werden als Vektordaten gespeichert (x, y, Druck) in "Seiten-Einheiten":
// Eine Seite ist immer 1000 breit und 1414 hoch (A4), egal wie groß der Bildschirm ist.
const PAGE_W = 1000;
const PAGE_H = 1414;
const MAX_PAGES = 30;
const PEN_COLORS = ['#1c1c1e', '#2563eb', '#dc2626', '#16a34a', '#9333ea'];
const MARKER_COLORS = ['#fde047', '#86efac', '#93c5fd', '#f9a8d4', '#fdba74'];
const BASE_WIDTH = { pen: 1.25, marker: 16 }; // Stift: mittel ≈ 0,5 mm auf A4
const ERASER_RADIUS = 8;

// ---------- Speicher (IndexedDB) ----------
const noteDb = {
  open() {
    return this._p || (this._p = new Promise((resolve, reject) => {
      const r = indexedDB.open('test-app', 2);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (db.objectStoreNames.contains('sounds')) db.deleteObjectStore('sounds');
        if (!db.objectStoreNames.contains('notes')) db.createObjectStore('notes', { keyPath: 'id' });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    }));
  },
  async tx(mode, fn) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const t = db.transaction('notes', mode);
      const req = fn(t.objectStore('notes'));
      t.oncomplete = () => resolve(req && req.result);
      t.onerror = () => reject(t.error);
    });
  },
  all() { return this.tx('readonly', (s) => s.getAll()); },
  put(note) { return this.tx('readwrite', (s) => s.put(note)); },
  del(id) { return this.tx('readwrite', (s) => s.delete(id)); }
};

// ---------- Zustand ----------
let note = null;
let tool = store.get('noteTool', 'pen');
if (!['pen', 'ball', 'marker', 'eraser'].includes(tool)) tool = 'pen';
let size = store.get('noteSize', 2);
const colorSel = store.get('noteColors', { pen: 0, marker: 0 });
let fingerDraw = store.get('fingerDraw', true);
let undoStack = [];
let redoStack = [];
let pageEls = [];
let active = null;     // aktueller Strich / Radiervorgang
let saveTimer = null;

const isEmpty = (n) => !n.title && n.pages.every((p) => p.strokes.length === 0);

// Gespeichert wird spätestens 1 s nach einer Änderung – auch beim Dauerschreiben.
// (Nicht bei jedem Strich sofort, weil das Speichern die ganze Notiz kopiert.)
let saveTarget = null;

function writeNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const n = saveTarget;
  saveTarget = null;
  if (n) noteDb.put(n).catch(() => toast('Speichern fehlgeschlagen 😕'));
}

function cancelSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  saveTarget = null;
}

function saveNote() {
  if (!note) return;
  note.updated = Date.now();
  if (saveTarget && saveTarget !== note) writeNow();
  saveTarget = note;
  if (!saveTimer) saveTimer = setTimeout(writeNow, 1000);
}

// ---------- Zeichnen ----------
const strokeWidth = (s) => s.size * BASE_WIDTH[s.tool];
// Radius je Punkt: Füller reagiert auf Druck, Kugelschreiber bleibt fast gleich dick
function pointRadius(s, p) {
  const w = strokeWidth(s) / 2;
  return s.style === 'ball' ? w * (0.9 + 0.2 * p) : w * (0.3 + 1.4 * Math.pow(p, 0.8));
}

// Berechnet den Umriss eines Strichs (wie bei Goodnotes): Punkte werden leicht geglättet,
// links und rechts davon liegt der Rand im Abstand des Radius.
function strokeOutline(s) {
  const p = s.pts, n = p.length / 3;
  const pts = [];
  let x = p[0], y = p[1], pr = p[2];
  pts.push([x, y, pr]);
  for (let i = 1; i < n; i++) {
    // Zittern herausfiltern: jeder Punkt zieht die Linie nur zu 55 % zu sich
    x += (p[i * 3] - x) * 0.55;
    y += (p[i * 3 + 1] - y) * 0.55;
    pr += (p[i * 3 + 2] - pr) * 0.5;
    const last = pts[pts.length - 1];
    if (Math.hypot(x - last[0], y - last[1]) >= 0.4) pts.push([x, y, pr]);
  }
  // Ende genau an der Stiftspitze, damit die Linie nicht "hinterherhängt"
  if (n > 1) {
    const ex = p[(n - 1) * 3], ey = p[(n - 1) * 3 + 1];
    const last = pts[pts.length - 1];
    if (Math.hypot(ex - last[0], ey - last[1]) >= 0.2) pts.push([ex, ey, pr]);
  }

  // Radien berechnen und in beide Richtungen glätten, damit die Dicke weich verläuft
  const r = pts.map((q) => pointRadius(s, q[2]));
  for (let i = 1; i < r.length; i++) r[i] = r[i - 1] * 0.5 + r[i] * 0.5;
  for (let i = r.length - 2; i >= 0; i--) r[i] = r[i + 1] * 0.5 + r[i] * 0.5;

  const left = [], right = [], angles = [], corners = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    let dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    const nx = -dy, ny = dx;
    left.push([pts[i][0] + nx * r[i], pts[i][1] + ny * r[i]]);
    right.push([pts[i][0] - nx * r[i], pts[i][1] - ny * r[i]]);
    angles.push(Math.atan2(ny, nx));
    // scharfe Kehren (z. B. bei m, n, u) bekommen einen runden Punkt, sonst entstehen Kerben
    if (i > 0 && i < pts.length - 1) {
      const ax = pts[i][0] - pts[i - 1][0], ay = pts[i][1] - pts[i - 1][1];
      const bx = pts[i + 1][0] - pts[i][0], by = pts[i + 1][1] - pts[i][1];
      const dot = (ax * bx + ay * by) / ((Math.hypot(ax, ay) * Math.hypot(bx, by)) || 1);
      if (dot < 0.2) corners.push(i);
    }
  }
  return { pts, r, left, right, angles, corners };
}

function smoothThrough(ctx, arr, reverse) {
  const list = reverse ? arr.slice().reverse() : arr;
  if (list.length < 3) { list.forEach((q) => ctx.lineTo(q[0], q[1])); return; }
  ctx.lineTo(list[0][0], list[0][1]);
  for (let i = 1; i < list.length - 1; i++) {
    ctx.quadraticCurveTo(list[i][0], list[i][1], (list[i][0] + list[i + 1][0]) / 2, (list[i][1] + list[i + 1][1]) / 2);
  }
  const last = list[list.length - 1];
  ctx.lineTo(last[0], last[1]);
}

function fillPenStroke(ctx, s) {
  const o = strokeOutline(s);
  ctx.fillStyle = s.color;
  const k = o.pts.length;
  if (k === 1) {
    ctx.beginPath();
    ctx.arc(o.pts[0][0], o.pts[0][1], o.r[0], 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  const e = k - 1;
  ctx.beginPath();
  ctx.moveTo(o.left[0][0], o.left[0][1]);
  smoothThrough(ctx, o.left, false);
  // runde Kappe am Ende
  ctx.arc(o.pts[e][0], o.pts[e][1], o.r[e], o.angles[e], o.angles[e] - Math.PI, true);
  smoothThrough(ctx, o.right, true);
  // runde Kappe am Anfang
  ctx.arc(o.pts[0][0], o.pts[0][1], o.r[0], o.angles[0] + Math.PI, o.angles[0], true);
  ctx.closePath();
  ctx.fill();
  o.corners.forEach((i) => {
    ctx.beginPath();
    ctx.arc(o.pts[i][0], o.pts[i][1], o.r[i], 0, Math.PI * 2);
    ctx.fill();
  });
}

function drawStroke(ctx, s) {
  const p = s.pts, n = p.length / 3, w = strokeWidth(s);
  ctx.save();
  if (s.tool === 'marker') {
    // Textmarker: ein durchgehender Pfad, "multiply" lässt die Schrift darunter sichtbar
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = s.color;
    if (!ctx.canvas.classList || !ctx.canvas.classList.contains('page-live')) ctx.globalCompositeOperation = 'multiply';
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(p[0], p[1]);
    if (n === 1) ctx.lineTo(p[0] + 0.01, p[1]);
    for (let i = 1; i < n - 1; i++) {
      ctx.quadraticCurveTo(p[i * 3], p[i * 3 + 1], (p[i * 3] + p[i * 3 + 3]) / 2, (p[i * 3 + 1] + p[i * 3 + 4]) / 2);
    }
    if (n > 1) ctx.lineTo(p[(n - 1) * 3], p[(n - 1) * 3 + 1]);
    ctx.stroke();
  } else {
    fillPenStroke(ctx, s);
  }
  ctx.restore();
}

function drawPaper(ctx, paper) {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, PAGE_W, PAGE_H);
  ctx.save();
  if (paper === 'lines') {
    ctx.strokeStyle = '#c7d2fe';
    ctx.lineWidth = 1.2;
    for (let y = 130; y < PAGE_H - 40; y += 42) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(PAGE_W, y); ctx.stroke();
    }
    ctx.strokeStyle = '#fca5a5';
    ctx.beginPath(); ctx.moveTo(90, 0); ctx.lineTo(90, PAGE_H); ctx.stroke();
  } else if (paper === 'grid') {
    ctx.strokeStyle = '#dcdce1';
    ctx.lineWidth = 0.9;
    const step = 23.8; // ≈ 5 mm auf A4
    for (let x = step; x < PAGE_W; x += step) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, PAGE_H); ctx.stroke(); }
    for (let y = step; y < PAGE_H; y += step) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(PAGE_W, y); ctx.stroke(); }
  } else if (paper === 'dots') {
    ctx.fillStyle = '#b4b4bb';
    for (let x = 30; x < PAGE_W; x += 30)
      for (let y = 30; y < PAGE_H; y += 30) { ctx.beginPath(); ctx.arc(x, y, 1.4, 0, Math.PI * 2); ctx.fill(); }
  }
  ctx.restore();
}

function renderPageTo(ctx, page, scale) {
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  drawPaper(ctx, note.paper);
  page.strokes.forEach((s) => drawStroke(ctx, s));
}

function drawPage(i) {
  const pe = pageEls[i];
  if (!pe || !pe.scale) return;
  renderPageTo(pe.base.getContext('2d'), note.pages[i], pe.scale);
}

// Live-Vorschau: nur den Bereich um den aktuellen Strich löschen und neu zeichnen.
// Das ist schnell und sieht exakt so aus wie der fertige Strich.
function drawActiveStroke() {
  const st = active.stroke, p = st.pts, ctx = active.liveCtx;
  const n = p.length / 3;
  const x = p[(n - 1) * 3], y = p[(n - 1) * 3 + 1];
  const b = active.bbox;
  b.x0 = Math.min(b.x0, x); b.y0 = Math.min(b.y0, y);
  b.x1 = Math.max(b.x1, x); b.y1 = Math.max(b.y1, y);
  const m = strokeWidth(st) * 1.5 + 4;
  ctx.clearRect(b.x0 - m, b.y0 - m, b.x1 - b.x0 + 2 * m, b.y1 - b.y0 + 2 * m);
  drawStroke(ctx, st);
}

function clearLive(pe) {
  const ctx = pe.live.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, pe.live.width, pe.live.height);
  ctx.setTransform(pe.scale, 0, 0, pe.scale, 0, 0);
  return ctx;
}

// ---------- Seiten aufbauen ----------
function buildPages() {
  const box = $('#pages');
  box.innerHTML = '';
  pageEls = note.pages.map((_, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'page';
    const base = document.createElement('canvas');
    const live = document.createElement('canvas');
    live.className = 'page-live';
    // "desynchronized" = weniger Verzögerung zwischen Stift und Bildschirm (wo unterstützt)
    try { live.getContext('2d', { desynchronized: true }); } catch {}
    live.dataset.page = i;
    const num = document.createElement('span');
    num.className = 'page-num';
    num.textContent = i + 1;
    wrap.append(base, live, num);
    box.append(wrap);
    return { wrap, base, live, scale: 0 };
  });
  $('#add-page').hidden = note.pages.length >= MAX_PAGES;
  layoutPages();
}

function layoutPages() {
  if (!note || document.body.dataset.view !== 'notes') return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  pageEls.forEach((pe, i) => {
    const w = pe.wrap.clientWidth;
    if (!w) return;
    const pw = Math.round(w * dpr), ph = Math.round((w * PAGE_H / PAGE_W) * dpr);
    if (pe.base.width !== pw || pe.base.height !== ph || !pe.scale) {
      pe.base.width = pe.live.width = pw;
      pe.base.height = pe.live.height = ph;
      pe.scale = pw / PAGE_W;
      drawPage(i);
    }
  });
}

window.addEventListener('resize', layoutPages);
window.addEventListener('viewchange', (e) => e.detail === 'notes' && requestAnimationFrame(layoutPages));

// ---------- Rückgängig / Wiederholen ----------
function pushHistory(changes) {
  undoStack.push(changes);
  if (undoStack.length > 100) undoStack.shift();
  redoStack = [];
  updateUndoButtons();
}

function applyHistory(from, to, key) {
  const changes = from.pop();
  if (!changes) return;
  changes.forEach((c) => {
    note.pages[c.page].strokes = c[key].slice();
    drawPage(c.page);
  });
  to.push(changes);
  updateUndoButtons();
  saveNote();
}

function updateUndoButtons() {
  $('#undo').disabled = undoStack.length === 0;
  $('#redo').disabled = redoStack.length === 0;
}

$('#undo').addEventListener('click', () => !active && applyHistory(undoStack, redoStack, 'before'));
$('#redo').addEventListener('click', () => !active && applyHistory(redoStack, undoStack, 'after'));

// ---------- Radierer ----------
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len = dx * dx + dy * dy;
  let t = len ? ((px - ax) * dx + (py - ay) * dy) / len : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(ax + t * dx - px, ay + t * dy - py);
}

function strokeHit(s, x, y, r) {
  const p = s.pts, reach = strokeWidth(s) / 2 + r;
  if (p.length === 3) return Math.hypot(p[0] - x, p[1] - y) <= reach;
  for (let i = 3; i < p.length; i += 3) {
    if (distToSegment(x, y, p[i - 3], p[i - 2], p[i], p[i + 1]) <= reach) return true;
  }
  return false;
}

function eraseAt(x, y) {
  const page = note.pages[active.page];
  const r = ERASER_RADIUS * size;
  // Zwischenpunkte prüfen, damit schnelle Bewegungen nichts überspringen
  const steps = Math.max(1, Math.ceil(Math.hypot(x - active.lx, y - active.ly) / r));
  let changed = false;
  for (let k = 1; k <= steps; k++) {
    const cx = active.lx + ((x - active.lx) * k) / steps;
    const cy = active.ly + ((y - active.ly) * k) / steps;
    const keep = page.strokes.filter((s) => !strokeHit(s, cx, cy, r));
    if (keep.length !== page.strokes.length) { page.strokes = keep; changed = true; }
  }
  active.lx = x;
  active.ly = y;
  if (changed) drawPage(active.page);

  const pe = pageEls[active.page];
  const ctx = clearLive(pe);
  ctx.strokeStyle = '#8e8e93';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();
}

// ---------- Stift-Eingabe ----------
const touches = new Map();
let pan = null;
const avgY = () => [...touches.values()].reduce((a, t) => a + t.y, 0) / touches.size;

function toPage(e) {
  return [
    ((e.clientX - active.rect.left) / active.rect.width) * PAGE_W,
    ((e.clientY - active.rect.top) / active.rect.height) * PAGE_H,
    Math.round((e.pressure || 0.5) * 100) / 100
  ];
}

function cancelActive() {
  if (!active) return;
  const pe = pageEls[active.page];
  if (active.tool === 'eraser' && active.before) {
    note.pages[active.page].strokes = active.before;
    drawPage(active.page);
  }
  clearLive(pe);
  active = null;
}

function onDown(e) {
  const canvas = e.target.closest('.page-live');
  if (!canvas) return;

  if (e.pointerType === 'pen' && fingerDraw) setFingerDraw(false, true);

  if (e.pointerType === 'touch') {
    touches.set(e.pointerId, { y: e.clientY });
    if (!fingerDraw) return; // Finger scrollt nur
    if (touches.size >= 2) {
      // Zwei Finger = scrollen: angefangenen Finger-Strich verwerfen
      if (active && active.pointerType === 'touch') cancelActive();
      pan = { y: avgY() };
      return;
    }
  }
  if (active) return;

  e.preventDefault();
  canvas.setPointerCapture(e.pointerId);
  const i = Number(canvas.dataset.page);
  active = {
    id: e.pointerId,
    pointerType: e.pointerType,
    page: i,
    tool,
    rect: canvas.getBoundingClientRect()
  };
  const [x, y, p] = toPage(e);
  if (tool === 'eraser') {
    active.before = note.pages[i].strokes.slice();
    active.lx = x;
    active.ly = y;
    eraseAt(x, y);
  } else {
    const isMarker = tool === 'marker';
    const colors = isMarker ? MARKER_COLORS : PEN_COLORS;
    active.stroke = { tool: isMarker ? 'marker' : 'pen', color: colors[colorSel[isMarker ? 'marker' : 'pen']], size, pts: [x, y, p] };
    if (tool === 'ball') active.stroke.style = 'ball';
    active.pressure = p;
    active.bbox = { x0: x, y0: y, x1: x, y1: y };
    const pe = pageEls[i];
    // Mischmodus nur für den Textmarker – für den Stift kostet er nur Leistung
    pe.live.classList.toggle('blend', tool === 'marker');
    active.liveCtx = clearLive(pe);
    drawActiveStroke(); // sofort einen Punkt zeigen
  }
}

function onMove(e) {
  if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
    touches.get(e.pointerId).y = e.clientY;
    if (pan && touches.size >= 2) {
      const y = avgY();
      $('.content').scrollTop -= y - pan.y;
      pan.y = y;
      return;
    }
  }
  if (!active || e.pointerId !== active.id) return;
  e.preventDefault();

  const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  for (const ev of events.length ? events : [e]) {
    const [x, y, p] = toPage(ev);
    if (active.tool === 'eraser') {
      eraseAt(x, y);
    } else {
      const pts = active.stroke.pts;
      const n = pts.length;
      if (Math.hypot(x - pts[n - 3], y - pts[n - 2]) < 0.6) continue;
      // Druck leicht glätten, sonst wird die Linie "perlig" (dick-dünn-dick)
      active.pressure = active.pressure * 0.65 + p * 0.35;
      pts.push(Math.round(x * 10) / 10, Math.round(y * 10) / 10, Math.round(active.pressure * 100) / 100);
    }
  }
  if (active.tool !== 'eraser') drawActiveStroke();
}

function onUp(e) {
  if (e.pointerType === 'touch') {
    touches.delete(e.pointerId);
    if (touches.size < 2) pan = null;
  }
  if (!active || e.pointerId !== active.id) return;

  const pe = pageEls[active.page];
  const page = note.pages[active.page];
  if (e.type === 'pointercancel') {
    cancelActive();
    return;
  }
  if (active.tool === 'eraser') {
    clearLive(pe);
    if (page.strokes.length !== active.before.length) {
      pushHistory([{ page: active.page, before: active.before, after: page.strokes.slice() }]);
      saveNote();
    }
  } else {
    const before = page.strokes.slice();
    page.strokes.push(active.stroke);
    clearLive(pe);
    const ctx = pe.base.getContext('2d');
    ctx.setTransform(pe.scale, 0, 0, pe.scale, 0, 0);
    drawStroke(ctx, active.stroke);
    pushHistory([{ page: active.page, before, after: page.strokes.slice() }]);
    saveNote();
  }
  active = null;
}

const pagesBox = $('#pages');
pagesBox.addEventListener('pointerdown', onDown);
pagesBox.addEventListener('pointermove', onMove);
pagesBox.addEventListener('pointerup', onUp);
pagesBox.addEventListener('pointercancel', onUp);
// Apple Pencil soll nie scrollen – nur der Finger (wenn "Finger zeichnet" aus ist)
const blockScroll = (e) => {
  if (fingerDraw || [...e.touches].some((t) => t.touchType === 'stylus')) e.preventDefault();
};
pagesBox.addEventListener('touchstart', blockScroll, { passive: false });
pagesBox.addEventListener('touchmove', blockScroll, { passive: false });

// ---------- Werkzeugleiste ----------
function renderColors() {
  const g = $('#color-group');
  g.innerHTML = '';
  g.hidden = tool === 'eraser';
  if (tool === 'eraser') return;
  const key = tool === 'marker' ? 'marker' : 'pen';
  const list = key === 'marker' ? MARKER_COLORS : PEN_COLORS;
  list.forEach((c, i) => {
    const b = document.createElement('button');
    b.className = 'tool swatch' + (i === colorSel[key] ? ' active' : '');
    b.style.setProperty('--c', c);
    b.setAttribute('aria-label', 'Farbe ' + (i + 1));
    b.addEventListener('click', () => {
      colorSel[key] = i;
      store.set('noteColors', colorSel);
      renderColors();
    });
    g.append(b);
  });
}

document.querySelectorAll('[data-tool]').forEach((b) =>
  b.addEventListener('click', () => {
    tool = b.dataset.tool;
    if (tool !== 'eraser') store.set('noteTool', tool);
    document.querySelectorAll('[data-tool]').forEach((x) => x.classList.toggle('active', x === b));
    renderColors();
  })
);

function renderSize() {
  document.querySelectorAll('[data-size]').forEach((b) => b.classList.toggle('active', Number(b.dataset.size) === size));
}
document.querySelectorAll('[data-size]').forEach((b) =>
  b.addEventListener('click', () => {
    size = Number(b.dataset.size);
    store.set('noteSize', size);
    renderSize();
  })
);

function setFingerDraw(on, auto) {
  fingerDraw = on;
  store.set('fingerDraw', on);
  document.body.classList.toggle('finger-draw', on);
  $('#finger-toggle').classList.toggle('active', on);
  if (auto) toast('✏️ Stift erkannt – der Finger scrollt jetzt');
  else toast(on ? '☝️ Finger zeichnet (2 Finger scrollen)' : '✏️ Nur der Stift zeichnet, Finger scrollt');
}
$('#finger-toggle').addEventListener('click', () => setFingerDraw(!fingerDraw));

$('#add-page').addEventListener('click', () => {
  note.pages.push({ strokes: [] });
  buildPages();
  saveNote();
  pageEls[pageEls.length - 1].wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

$('#note-title').addEventListener('input', (e) => {
  note.title = e.target.value.trim();
  saveNote();
});

// ---------- Notizen verwalten ----------
function newNote() {
  return { id: Date.now().toString(36), title: '', paper: store.get('notePaper', 'lines'), pages: [{ strokes: [] }], created: Date.now(), updated: Date.now() };
}

async function openNote(n) {
  // leere Notizen nicht aufheben
  if (note && note.id !== n.id && isEmpty(note)) {
    cancelSave();
    await noteDb.del(note.id).catch(() => {});
  }
  note = n;
  store.set('currentNote', n.id);
  undoStack = [];
  redoStack = [];
  updateUndoButtons();
  $('#note-title').value = n.title;
  buildPages();
  $('.content').scrollTop = 0;
}

async function createNote() {
  const n = newNote();
  await noteDb.put(n).catch(() => {});
  await openNote(n);
}

function noteName(n) {
  return n.title || 'Unbenannte Notiz';
}

async function showNotesList() {
  let all = [];
  try { all = await noteDb.all(); } catch {}
  // Aktuelle Notiz mit ihrem neuesten Stand anzeigen
  all = all.filter((n) => n.id !== note.id);
  if (!isEmpty(note)) all.push(note);
  all.sort((a, b) => b.updated - a.updated);

  const list = $('#notes-list');
  list.innerHTML = '';
  if (!all.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'Noch keine Notizen';
    list.append(li);
  }
  all.forEach((n) => {
    const li = document.createElement('li');
    li.className = 'note-item' + (n.id === note.id ? ' current' : '');
    const title = document.createElement('span');
    title.className = 'todo-text';
    title.textContent = noteName(n);
    const meta = document.createElement('span');
    meta.className = 'muted small-text';
    const date = new Date(n.updated).toLocaleDateString('de-DE', { day: 'numeric', month: 'short' });
    meta.textContent = `${n.pages.length} S. · ${date}`;
    li.append(title, meta);
    li.addEventListener('click', () => {
      $('#notes-dialog').close();
      if (n.id !== note.id) openNote(n);
    });
    list.append(li);
  });
  $('#notes-dialog').showModal();
}

$('#note-list-btn').addEventListener('click', showNotesList);
$('#note-new').addEventListener('click', () => {
  if (isEmpty(note)) return toast('Diese Notiz ist noch leer ✏️');
  createNote();
});
$('#notes-dialog-new').addEventListener('click', () => {
  $('#notes-dialog').close();
  if (!isEmpty(note)) createNote();
});

// ---------- Mehr-Menü ----------
function renderPaper() {
  document.querySelectorAll('[data-paper]').forEach((b) => b.classList.toggle('active', b.dataset.paper === note.paper));
}

$('#note-more').addEventListener('click', () => {
  renderPaper();
  $('#more-dialog').showModal();
});

document.querySelectorAll('[data-paper]').forEach((b) =>
  b.addEventListener('click', () => {
    note.paper = b.dataset.paper;
    store.set('notePaper', note.paper);
    renderPaper();
    note.pages.forEach((_, i) => drawPage(i));
    saveNote();
  })
);

$('#note-clear-page').addEventListener('click', () => {
  if (!confirm('Alle Seiten dieser Notiz leeren? (Rückgängig geht danach noch)')) return;
  const changes = note.pages
    .map((p, i) => ({ page: i, before: p.strokes.slice(), after: [] }))
    .filter((c) => c.before.length);
  if (!changes.length) return $('#more-dialog').close();
  changes.forEach((c) => { note.pages[c.page].strokes = []; drawPage(c.page); });
  pushHistory(changes);
  saveNote();
  $('#more-dialog').close();
});

$('#note-delete').addEventListener('click', async () => {
  if (!confirm(`„${noteName(note)}“ wirklich löschen?`)) return;
  cancelSave();
  await noteDb.del(note.id).catch(() => {});
  $('#more-dialog').close();
  const rest = (await noteDb.all().catch(() => [])).sort((a, b) => b.updated - a.updated);
  note = null;
  if (rest.length) openNote(rest[0]);
  else createNote();
  toast('Notiz gelöscht');
});

// Export: alle Seiten als PNG – synchron erzeugt, damit iOS das Teilen-Menü erlaubt
function dataUrlToFile(url, name) {
  const bin = atob(url.split(',')[1]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], name, { type: 'image/png' });
}

$('#note-export').addEventListener('click', () => {
  const scale = 1.5;
  const base = (note.title || 'Notiz').replace(/[^\wäöüÄÖÜß -]/g, '').trim() || 'Notiz';
  let pages = note.pages.filter((p) => p.strokes.length);
  if (!pages.length) pages = note.pages.slice(0, 1);
  const files = pages.map((page, i) => {
    const c = document.createElement('canvas');
    c.width = PAGE_W * scale;
    c.height = PAGE_H * scale;
    renderPageTo(c.getContext('2d'), page, scale);
    return dataUrlToFile(c.toDataURL('image/png'), `${base}${pages.length > 1 ? ' ' + (i + 1) : ''}.png`);
  });

  if (navigator.canShare && navigator.canShare({ files })) {
    navigator.share({ files, title: base }).catch(() => {});
  } else {
    files.forEach((f) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(f);
      a.download = f.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
  }
});

// Beim Wechseln/Schließen der App sofort speichern
function flushNoteSave() {
  if (saveTarget) writeNow();
}
window.addEventListener('pagehide', flushNoteSave);
document.addEventListener('visibilitychange', () => document.hidden && flushNoteSave());

// ---------- Start ----------
(async () => {
  document.body.classList.toggle('finger-draw', fingerDraw);
  $('#finger-toggle').classList.toggle('active', fingerDraw);
  document.querySelectorAll('[data-tool]').forEach((x) => x.classList.toggle('active', x.dataset.tool === tool));
  renderColors();
  renderSize();
  let all = [];
  try { all = await noteDb.all(); } catch {}
  const last = all.find((n) => n.id === store.get('currentNote')) ||
    all.sort((a, b) => b.updated - a.updated)[0];
  if (last) openNote(last);
  else createNote();
})();
