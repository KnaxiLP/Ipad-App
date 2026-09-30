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

// ---------- Plattform ----------
// iPad/iPhone: Finger scrollen nativ, der Apple Pencil wird per Touch-Event am Scrollen gehindert.
// Windows (Surface) & Co.: Dort würde der Browser auch mit dem Stift scrollen. Deshalb übernimmt
// die App Scrollen und Zoomen mit den Fingern selbst.
const IS_IOS = /iP(ad|hone|od)/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
if (!IS_IOS) document.body.classList.add('manual-touch');

// ---------- Zustand ----------
let note = null;
let tool = store.get('noteTool', 'pen');
if (!['pen', 'ball', 'marker', 'eraser', 'text'].includes(tool)) tool = 'pen';
Object.defineProperty(window, 'noteTool', { get: () => tool });
let size = store.get('noteSize', 2);
const colorSel = store.get('noteColors', { pen: 0, marker: 0 });
let fingerDraw = store.get('fingerDraw', true);
let undoStack = [];
let redoStack = [];
let pageEls = [];
let active = null;     // aktueller Strich / Radiervorgang
let saveTimer = null;

const isEmpty = (n) => !n.title && n.pages.every((p) => p.strokes.length === 0 && !p.bg);

// Gespeichert wird spätestens 1 s nach einer Änderung – auch beim Dauerschreiben.
// (Nicht bei jedem Strich sofort, weil das Speichern die ganze Notiz kopiert.)
let saveTarget = null;

function writeNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const n = saveTarget;
  saveTarget = null;
  if (n) return noteDb.put(n).catch(() => toast('Speichern fehlgeschlagen'));
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

// ---------- Zeichnen (als Vektorgrafik) ----------
// Jeder Strich wird einmal als Pfad aus Befehlen berechnet (M, L, Q, C, Z). Daraus entsteht
// SVG für den Bildschirm (immer gestochen scharf), Canvas für den Bild-Export und PDF für den
// Vektor-Export – alle drei sehen dadurch exakt gleich aus.
const SVG_NS = 'http://www.w3.org/2000/svg';
const strokeWidth = (s) => s.size * BASE_WIDTH[s.tool];
// Radius je Punkt: Füller reagiert auf Druck, Kugelschreiber bleibt fast gleich dick
function pointRadius(s, p) {
  const w = strokeWidth(s) / 2;
  return s.style === 'ball' ? w * (0.9 + 0.2 * p) : w * (0.5 + 1.2 * Math.pow(p, 0.8));
}

// Berechnet den Umriss eines Strichs (wie bei Goodnotes):
// 1. Zittern herausfiltern  2. Punkte in gleichmäßigem Abstand neu verteilen
// 3. Linie sanft glätten    4. links/rechts im Abstand des Radius den Rand bilden
const RESAMPLE_STEP = 1.5; // Abstand der Punkte in Seiten-Einheiten (≈ 0,3 mm)

function strokeOutline(s) {
  const p = s.pts, n = p.length / 3;

  // 1. Rohpunkte übernehmen, der Druck wird leicht geglättet
  const raw = [];
  let pr = p[2];
  for (let i = 0; i < n; i++) {
    pr += (p[i * 3 + 2] - pr) * 0.5;
    raw.push([p[i * 3], p[i * 3 + 1], pr]);
  }

  // 2. Gleichmäßig verteilen – ZUERST, damit die Glättung danach unabhängig von der
  //    Schreibgeschwindigkeit ist (schnell = wenige, weit entfernte Punkte, langsam = viele dichte).
  const pts = [raw[0].slice()];
  let carry = 0;
  for (let i = 1; i < raw.length; i++) {
    const a = raw[i - 1], b = raw[i];
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (!seg) continue;
    let t = RESAMPLE_STEP - carry;
    while (t <= seg) {
      const k = t / seg;
      pts.push([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]);
      t += RESAMPLE_STEP;
    }
    carry = seg - (t - RESAMPLE_STEP);
  }
  const end = raw[raw.length - 1], lastP = pts[pts.length - 1];
  if (Math.hypot(end[0] - lastP[0], end[1] - lastP[1]) > RESAMPLE_STEP * 0.3) pts.push(end.slice());

  // 3. Scharfe Kehren finden (m, n, u, h …) – die werden NICHT geglättet, sonst verschmelzen
  //    Auf- und Abstrich. Erkannte Formen (Linie, Rechteck …) werden gar nicht geglättet.
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const W = 3;
  for (let i = W; i < pts.length - W; i++) {
    const ax = pts[i][0] - pts[i - W][0], ay = pts[i][1] - pts[i - W][1];
    const bx = pts[i + W][0] - pts[i][0], by = pts[i + W][1] - pts[i][1];
    const cos = (ax * bx + ay * by) / ((Math.hypot(ax, ay) * Math.hypot(bx, by)) || 1);
    if (cos < 0.2) keep[i] = 1;   // Richtungswechsel über ~80°
  }

  // 4. Sanft glätten (nur das Zittern, gleich stark bei jeder Geschwindigkeit)
  for (let pass = 0; pass < (s.shape ? 0 : 2); pass++) {
    for (let i = pts.length - 2; i >= 1; i--) {
      if (keep[i]) continue;
      pts[i][0] = pts[i - 1][0] * 0.25 + pts[i][0] * 0.5 + pts[i + 1][0] * 0.25;
      pts[i][1] = pts[i - 1][1] * 0.25 + pts[i][1] * 0.5 + pts[i + 1][1] * 0.25;
    }
  }

  // Radien berechnen und glätten, damit die Dicke weich verläuft
  const r = pts.map((q) => pointRadius(s, q[2]));
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 1; i < r.length - 1; i++) r[i] = r[i - 1] * 0.25 + r[i] * 0.5 + r[i + 1] * 0.25;
  }

  // 4. Rand bilden. Die Richtung wird über mehrere Punkte bestimmt (ruhiger).
  const left = [], right = [], angles = [], corners = [], dirs = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 2)], b = pts[Math.min(pts.length - 1, i + 2)];
    let dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    dirs.push([dx, dy]);
    const nx = -dy, ny = dx;
    left.push([pts[i][0] + nx * r[i], pts[i][1] + ny * r[i]]);
    right.push([pts[i][0] - nx * r[i], pts[i][1] - ny * r[i]]);
    angles.push(Math.atan2(ny, nx));
    // scharfe Kehren (z. B. bei m, n, u) bekommen einen runden Punkt, sonst entstehen Kerben
    if (i > 1 && i < pts.length - 2) {
      const ax = pts[i][0] - pts[i - 2][0], ay = pts[i][1] - pts[i - 2][1];
      const bx = pts[i + 2][0] - pts[i][0], by = pts[i + 2][1] - pts[i][1];
      const dot = (ax * bx + ay * by) / ((Math.hypot(ax, ay) * Math.hypot(bx, by)) || 1);
      if (dot < 0.2) corners.push(i);
    }
  }
  // An engen Kurven läuft der innere Rand ein Stück rückwärts und bildet winzige Schleifen –
  // die sieht man als Zacken oder helle Striche. Solche Randpunkte werden weggelassen.
  const clean = (side) => {
    const out = [side[0]];
    for (let i = 1; i < side.length - 1; i++) {
      const prev = out[out.length - 1];
      if ((side[i][0] - prev[0]) * dirs[i][0] + (side[i][1] - prev[1]) * dirs[i][1] > 0) out.push(side[i]);
    }
    out.push(side[side.length - 1]);
    return out;
  };
  return { pts, r, left: clean(left), right: clean(right), angles, corners };
}

// Kreisbogen als kubische Bézierkurven – so funktioniert er in SVG, Canvas und PDF gleich
function arcTo(cmds, cx, cy, r, a0, a1) {
  const segs = Math.max(1, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 2) - 1e-9));
  const d = (a1 - a0) / segs;
  const k = (4 / 3) * Math.tan(d / 4);
  for (let i = 0; i < segs; i++) {
    const t1 = a0 + i * d, t2 = t1 + d;
    const c1 = Math.cos(t1), s1 = Math.sin(t1), c2 = Math.cos(t2), s2 = Math.sin(t2);
    cmds.push(['C', cx + r * (c1 - k * s1), cy + r * (s1 + k * c1), cx + r * (c2 + k * s2), cy + r * (s2 - k * c2), cx + r * c2, cy + r * s2]);
  }
}

function circleCmds(cmds, cx, cy, r) {
  cmds.push(['M', cx + r, cy]);
  arcTo(cmds, cx, cy, r, 0, Math.PI * 2);
  cmds.push(['Z']);
}

function smoothCmds(cmds, list) {
  if (list.length < 3) { list.forEach((q) => cmds.push(['L', q[0], q[1]])); return; }
  cmds.push(['L', list[0][0], list[0][1]]);
  for (let i = 1; i < list.length - 1; i++) {
    cmds.push(['Q', list[i][0], list[i][1], (list[i][0] + list[i + 1][0]) / 2, (list[i][1] + list[i + 1][1]) / 2]);
  }
  const last = list[list.length - 1];
  cmds.push(['L', last[0], last[1]]);
}

// Stift: gefüllter Umriss mit runden Kappen. Die runden Punkte an scharfen Kehren kommen in
// einen EIGENEN Pfad: im selben Pfad heben sie sich je nach Laufrichtung mit dem Umriss auf,
// und es entstehen weiße Löcher.
function penCmds(s) {
  const o = strokeOutline(s), cmds = [], dots = [], k = o.pts.length;
  if (k === 1) { circleCmds(cmds, o.pts[0][0], o.pts[0][1], o.r[0]); return { outline: cmds, dots }; }
  const e = k - 1;
  cmds.push(['M', o.left[0][0], o.left[0][1]]);
  smoothCmds(cmds, o.left);
  arcTo(cmds, o.pts[e][0], o.pts[e][1], o.r[e], o.angles[e], o.angles[e] - Math.PI);   // Ende
  smoothCmds(cmds, o.right.slice().reverse());
  arcTo(cmds, o.pts[0][0], o.pts[0][1], o.r[0], o.angles[0] + Math.PI, o.angles[0]);   // Anfang
  cmds.push(['Z']);
  o.corners.forEach((i) => circleCmds(dots, o.pts[i][0], o.pts[i][1], o.r[i]));
  return { outline: cmds, dots };
}

// Textmarker: Mittellinie, die mit fester Breite nachgezogen wird
function markerCmds(s) {
  const p = s.pts, n = p.length / 3, cmds = [['M', p[0], p[1]]];
  if (n === 1) cmds.push(['L', p[0] + 0.01, p[1]]);
  for (let i = 1; i < n - 1; i++) {
    cmds.push(['Q', p[i * 3], p[i * 3 + 1], (p[i * 3] + p[i * 3 + 3]) / 2, (p[i * 3 + 1] + p[i * 3 + 4]) / 2]);
  }
  if (n > 1) cmds.push(['L', p[(n - 1) * 3], p[(n - 1) * 3 + 1]]);
  return cmds;
}

const num = (v) => String(Math.round(v * 100) / 100);

function cmdsToSvg(cmds) {
  let d = '';
  for (const c of cmds) {
    d += c[0];
    for (let i = 1; i < c.length; i++) d += (i > 1 ? ' ' : '') + num(c[i]);
  }
  return d;
}

function cmdsToCanvas(ctx, cmds) {
  ctx.beginPath();
  for (const c of cmds) {
    if (c[0] === 'M') ctx.moveTo(c[1], c[2]);
    else if (c[0] === 'L') ctx.lineTo(c[1], c[2]);
    else if (c[0] === 'Q') ctx.quadraticCurveTo(c[1], c[2], c[3], c[4]);
    else if (c[0] === 'C') ctx.bezierCurveTo(c[1], c[2], c[3], c[4], c[5], c[6]);
    else ctx.closePath();
  }
}

// SVG-Code eines Strichs – wird pro Strich gemerkt, damit Neuzeichnen schnell geht
const svgCache = new WeakMap();
function markerAttrs(color, width) {
  return `fill="none" stroke="${color}" stroke-width="${num(width)}" stroke-linecap="round" stroke-linejoin="round" style="mix-blend-mode:multiply"`;
}
// ---------- Textfelder ----------
// Ein Textfeld liegt wie ein Strich in page.strokes: { tool: 'text', x, y, w, size, color, text }
// (x/y = linke obere Ecke, w = Breite, alles in Seiten-Einheiten). Die Zeilenumbrüche werden
// einmal berechnet und für Bildschirm, Bild- und PDF-Export gleich benutzt.
const TEXT_FONT = 'Helvetica, Arial, sans-serif';
const TEXT_SIZES = { 1: 18, 2: 24, 4: 36 };   // Schriftgröße je Stärke-Knopf (24 ≈ 14 pt auf A4)
const TEXT_LH = 1.3;                          // Zeilenabstand
const measureCtx = document.createElement('canvas').getContext('2d');
const linesCache = new WeakMap();

function textLines(t) {
  let lines = linesCache.get(t);
  if (lines) return lines;
  measureCtx.font = `${t.size}px ${TEXT_FONT}`;
  lines = [];
  for (const para of t.text.split('\n')) {
    let line = '';
    for (const word of para.split(/(\s+)/)) {
      const test = line + word;
      if (line && measureCtx.measureText(test.trimEnd()).width > t.w) {
        lines.push(line.trimEnd());
        line = word.trimStart();
        // sehr lange Wörter hart umbrechen
        while (measureCtx.measureText(line).width > t.w && line.length > 1) {
          let k = line.length - 1;
          while (k > 1 && measureCtx.measureText(line.slice(0, k)).width > t.w) k--;
          lines.push(line.slice(0, k));
          line = line.slice(k);
        }
      } else {
        line = test;
      }
    }
    lines.push(line.trimEnd());
  }
  linesCache.set(t, lines);
  return lines;
}

const textHeight = (t) => Math.max(1, textLines(t).length) * t.size * TEXT_LH;
const escXml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function textSvg(t) {
  const lh = t.size * TEXT_LH;
  const spans = textLines(t).map((l, i) =>
    `<tspan x="${num(t.x)}" y="${num(t.y + t.size + i * lh)}">${escXml(l) || ' '}</tspan>`).join('');
  return `<text font-family="${TEXT_FONT}" font-size="${t.size}" fill="${t.color}" xml:space="preserve">${spans}</text>`;
}

function strokeSvg(s) {
  let out = svgCache.get(s);
  if (!out) {
    out = s.tool === 'text' ? textSvg(s)
      : s.tool === 'marker'
      ? `<path ${markerAttrs(s.color, strokeWidth(s))} d="${cmdsToSvg(markerCmds(s))}"/>`
      : penSvg(s);
    svgCache.set(s, out);
  }
  return out;
}

function penSvg(s) {
  const { outline, dots } = penCmds(s);
  let out = `<path fill="${s.color}" d="${cmdsToSvg(outline)}"/>`;
  if (dots.length) out += `<path fill="${s.color}" d="${cmdsToSvg(dots)}"/>`;
  return out;
}

// Canvas-Version (für den Bild-Export)
function drawStroke(ctx, s) {
  ctx.save();
  if (s.tool === 'text') {
    ctx.font = `${s.size}px ${TEXT_FONT}`;
    ctx.fillStyle = s.color;
    textLines(s).forEach((l, i) => ctx.fillText(l, s.x, s.y + s.size + i * s.size * TEXT_LH));
  } else if (s.tool === 'marker') {
    ctx.globalCompositeOperation = 'multiply';
    ctx.strokeStyle = s.color;
    ctx.lineWidth = strokeWidth(s);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    cmdsToCanvas(ctx, markerCmds(s));
    ctx.stroke();
  } else {
    ctx.fillStyle = s.color;
    const { outline, dots } = penCmds(s);
    cmdsToCanvas(ctx, outline);
    ctx.fill();
    if (dots.length) { cmdsToCanvas(ctx, dots); ctx.fill(); }
  }
  ctx.restore();
}

// ---------- Papier ----------
const GRID_STEP = 23.8; // ≈ 5 mm auf A4

function paperLines(paper) {
  // Liefert die Linien des Papiers als Liste [Farbe, Breite, Pfad-Befehle]
  const out = [];
  if (paper === 'lines') {
    const cmds = [];
    for (let y = 130; y < PAGE_H - 40; y += 42) cmds.push(['M', 0, y], ['L', PAGE_W, y]);
    out.push(['#c7d2fe', 1.2, cmds], ['#fca5a5', 1.2, [['M', 90, 0], ['L', 90, PAGE_H]]]);
  } else if (paper === 'grid') {
    const cmds = [];
    for (let x = GRID_STEP; x < PAGE_W; x += GRID_STEP) cmds.push(['M', x, 0], ['L', x, PAGE_H]);
    for (let y = GRID_STEP; y < PAGE_H; y += GRID_STEP) cmds.push(['M', 0, y], ['L', PAGE_W, y]);
    out.push(['#dcdce1', 0.9, cmds]);
  }
  return out;
}

function forEachDot(fn) {
  for (let x = 30; x < PAGE_W; x += 30) for (let y = 30; y < PAGE_H; y += 30) fn(x, y);
}

function paperSvg(paper) {
  let s = `<rect width="${PAGE_W}" height="${PAGE_H}" fill="#fff"/>`;
  paperLines(paper).forEach(([color, w, cmds]) => {
    s += `<path fill="none" stroke="${color}" stroke-width="${w}" d="${cmdsToSvg(cmds)}"/>`;
  });
  if (paper === 'dots') s += `<rect width="${PAGE_W}" height="${PAGE_H}" fill="url(#paper-dots)"/>`;
  return s;
}

function drawPaper(ctx, paper) {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, PAGE_W, PAGE_H);
  paperLines(paper).forEach(([color, w, cmds]) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = w;
    cmdsToCanvas(ctx, cmds);
    ctx.stroke();
  });
  if (paper === 'dots') {
    ctx.fillStyle = '#b4b4bb';
    forEachDot((x, y) => { ctx.beginPath(); ctx.arc(x, y, 1.4, 0, Math.PI * 2); ctx.fill(); });
  }
}

function renderPageTo(ctx, page, scale) {
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  drawPaper(ctx, note.paper);
  if (page.bg) {
    bgUrl(page.bg);
    const img = bgImgs.get(page.bg);
    if (img && img.complete && img.naturalWidth) ctx.drawImage(img, page.bg.x, page.bg.y, page.bg.width, page.bg.height);
  }
  page.strokes.forEach((s) => drawStroke(ctx, s));
}

// Punkt-Muster einmal für alle Seiten anlegen
(() => {
  const defs = document.createElementNS(SVG_NS, 'svg');
  defs.setAttribute('width', '0');
  defs.setAttribute('height', '0');
  defs.style.position = 'absolute';
  defs.innerHTML = '<defs><pattern id="paper-dots" x="15" y="15" width="30" height="30" patternUnits="userSpaceOnUse"><circle cx="15" cy="15" r="1.4" fill="#b4b4bb"/></pattern></defs>';
  document.body.append(defs);
})();

// ---------- Seiten aufbauen ----------
function svgEl(name, attrs = {}) {
  const el = document.createElementNS(SVG_NS, name);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}

function buildPages() {
  const box = $('#pages-inner');
  box.innerHTML = '';
  pageEls = note.pages.map((_, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'page';
    const svg = svgEl('svg', { viewBox: `0 0 ${PAGE_W} ${PAGE_H}`, class: 'page-live', 'data-page': i });
    const paper = svgEl('g');
    const ink = svgEl('g');
    const live = svgEl('path');                 // der Strich, der gerade geschrieben wird
    const liveDots = svgEl('path');             // seine runden Punkte an Kehren
    const eraser = svgEl('circle', { fill: 'none', stroke: '#8e8e93', 'stroke-width': 1.5, r: 0 });
    svg.append(paper, ink, live, liveDots, eraser);
    const numEl = document.createElement('span');
    numEl.className = 'page-num';
    numEl.textContent = i + 1;
    wrap.append(svg, numEl);
    box.append(wrap);
    return { wrap, svg, paper, ink, live, liveDots, eraser };
  });
  pageEls.forEach((_, i) => drawPage(i));
  $('#add-page').hidden = note.pages.length >= MAX_PAGES;
}

// ---------- Hintergrundbilder (importierte PDF-Seiten und Bilder) ----------
// Gespeichert als JPEG-Bytes auf der Seite: page.bg = { data, w, h, x, y, width, height }
// (w/h = Pixel, x/y/width/height = Position auf der Seite in Seiten-Einheiten)
const bgUrls = new WeakMap();
const bgImgs = new WeakMap();

function bgUrl(bg) {
  let u = bgUrls.get(bg);
  if (!u) {
    u = URL.createObjectURL(new Blob([bg.data], { type: 'image/jpeg' }));
    bgUrls.set(bg, u);
    const img = new Image();       // für den Bild-Export schon mal laden
    img.src = u;
    bgImgs.set(bg, img);
  }
  return u;
}

function bgSvg(bg) {
  return bg ? `<image href="${bgUrl(bg)}" x="${num(bg.x)}" y="${num(bg.y)}" width="${num(bg.width)}" height="${num(bg.height)}" preserveAspectRatio="none"/>` : '';
}

function drawPage(i) {
  const pe = pageEls[i];
  if (!pe) return;
  pe.paper.innerHTML = paperSvg(note.paper) + bgSvg(note.pages[i].bg);
  pe.ink.innerHTML = note.pages[i].strokes.map(strokeSvg).join('');
}

// Live-Vorschau: nur der Pfad des aktuellen Strichs wird neu berechnet
// ---------- Schnelle Vorschau (Surface, Android, PC) ----------
// Chrome kann eine Zeichenfläche "desynchronized" direkt auf den Bildschirm bringen – ohne
// den üblichen Umweg über den Seitenaufbau. Der Strich, der gerade geschrieben wird, landet
// deshalb dort; erst beim Absetzen wird er als Vektor (SVG) in die Seite übernommen.
// Auf dem iPad bleibt es beim SVG – dort ist es schon schnell genug.
const FAST_INK = !IS_IOS;
let fastInk = null;

function setupFastInk() {
  if (!FAST_INK || fastInk) return;
  const c = document.createElement('canvas');
  c.className = 'fast-ink';
  document.body.append(c);
  let ctx = null;
  try { ctx = c.getContext('2d', { desynchronized: true }); } catch {}
  if (!ctx) ctx = c.getContext('2d');
  fastInk = { c, ctx, left: 0, top: 0, w: 0, h: 0, dpr: 1 };
  sizeFastInk();
  window.addEventListener('resize', sizeFastInk);
  window.addEventListener('viewchange', () => requestAnimationFrame(sizeFastInk));
}

function sizeFastInk() {
  if (!fastInk) return;
  const r = pagesBox.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  if (r.left === fastInk.left && r.top === fastInk.top && r.width === fastInk.w && r.height === fastInk.h && dpr === fastInk.dpr) return;
  Object.assign(fastInk, { left: r.left, top: r.top, w: r.width, h: r.height, dpr });
  const st = fastInk.c.style;
  st.left = r.left + 'px'; st.top = r.top + 'px'; st.width = r.width + 'px'; st.height = r.height + 'px';
  fastInk.c.width = Math.max(1, Math.round(r.width * dpr));
  fastInk.c.height = Math.max(1, Math.round(r.height * dpr));
}

function clearFastInk() {
  if (!fastInk) return;
  fastInk.ctx.setTransform(1, 0, 0, 1, 0, 0);
  fastInk.ctx.clearRect(0, 0, fastInk.c.width, fastInk.c.height);
}

function drawActiveStroke(predicted) {
  const s = active.stroke;
  if (fastInk) {
    // vorhergesagte Punkte nur anzeigen, nicht speichern
    const st = predicted && predicted.length ? { ...s, pts: s.pts.concat(predicted) } : s;
    const { ctx, dpr } = fastInk, r = active.rect, k = r.width / PAGE_W;
    clearFastInk();
    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * (r.left - fastInk.left), dpr * (r.top - fastInk.top));
    drawStroke(ctx, st);
    fastInk.c.classList.toggle('blend', s.tool === 'marker');
    return;
  }
  if (s.tool === 'marker') {
    active.live.setAttribute('d', cmdsToSvg(markerCmds(s)));
  } else {
    const { outline, dots } = penCmds(s);
    active.live.setAttribute('d', cmdsToSvg(outline));
    active.liveDots.setAttribute('d', cmdsToSvg(dots));
  }
}

function clearLive(pe) {
  if (fastInk) {
    requestAnimationFrame(() => requestAnimationFrame(() => { if (!active) clearFastInk(); }));
  }
  pe.live.removeAttribute('d');
  pe.liveDots.removeAttribute('d');
  pe.eraser.setAttribute('r', 0);
}

// ---------- Rückgängig / Wiederholen ----------
function pushHistory(changes) {
  if (!changes.some((c) => c.after.length > c.before.length)) lastEnd = null;
  undoStack.push(changes);
  if (undoStack.length > 100) undoStack.shift();
  redoStack = [];
  updateUndoButtons();
}

function applyHistory(from, to, key) {
  lastEnd = null;
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

function textHit(t, x, y, pad = 0) {
  return x >= t.x - pad && x <= t.x + t.w + pad && y >= t.y - pad && y <= t.y + textHeight(t) + pad;
}

function strokeHit(s, x, y, r) {
  if (s.tool === 'text') return textHit(s, x, y, r);
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

  const c = pageEls[active.page].eraser;
  c.setAttribute('cx', num(x));
  c.setAttribute('cy', num(y));
  c.setAttribute('r', r);
}

// ---------- Formen erkennen (wie in Goodnotes: am Ende kurz stillhalten) ----------
const HOLD_MS = 550;
let shapeRecog = store.get('shapeRecog', true);

function rdp(points, eps) {
  // Ramer-Douglas-Peucker: vereinfacht eine Linie auf ihre wichtigsten Eckpunkte
  if (points.length < 3) return points.slice();
  const [a, b] = [points[0], points[points.length - 1]];
  let maxD = 0, idx = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = distToSegment(points[i][0], points[i][1], a[0], a[1], b[0], b[1]);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD <= eps) return [a, b];
  const left = rdp(points.slice(0, idx + 1), eps);
  return left.slice(0, -1).concat(rdp(points.slice(idx), eps));
}

function along(poly, step = 4) {
  // Punkte gleichmäßig entlang eines Streckenzugs verteilen
  const out = [poly[0]];
  for (let i = 1; i < poly.length; i++) {
    const [ax, ay] = poly[i - 1], [bx, by] = poly[i];
    const k = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let j = 1; j <= k; j++) out.push([ax + (bx - ax) * j / k, ay + (by - ay) * j / k]);
  }
  return out;
}

function maxDistToPoly(points, poly) {
  let worst = 0;
  for (const [x, y] of points) {
    let best = Infinity;
    for (let i = 1; i < poly.length; i++) best = Math.min(best, distToSegment(x, y, poly[i - 1][0], poly[i - 1][1], poly[i][0], poly[i][1]));
    worst = Math.max(worst, best);
  }
  return worst;
}

function fitShape(P) {
  const n = P.length;
  if (n < 5) return null;
  let len = 0;
  for (let i = 1; i < n; i++) len += Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]);
  if (len < 30) return null;
  const a = P[0], b = P[n - 1];
  const chord = Math.hypot(b[0] - a[0], b[1] - a[1]);

  // gerade Linie – fast waagerecht/senkrecht wird ganz gerade ausgerichtet
  if (chord > 0.8 * len && maxDistToPoly(P, [a, b]) < Math.max(3, chord * 0.05)) {
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const snap = Math.round(ang / (Math.PI / 2)) * (Math.PI / 2);
    if (Math.abs(ang - snap) < (5 * Math.PI) / 180) {
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, h = chord / 2;
      return { kind: 'line', pts: along([[mx - Math.cos(snap) * h, my - Math.sin(snap) * h], [mx + Math.cos(snap) * h, my + Math.sin(snap) * h]]) };
    }
    return { kind: 'line', pts: along([a, b]) };
  }

  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of P) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const diag = Math.hypot(x1 - x0, y1 - y0);
  const eps = Math.max(4, diag * 0.07);
  const closed = chord < Math.max(18, len * 0.12);

  if (closed) {
    // Dreieck oder Viereck?
    let poly = rdp(P, eps);
    if (poly.length > 2 && Math.hypot(poly[0][0] - poly[poly.length - 1][0], poly[0][1] - poly[poly.length - 1][1]) < eps * 2) poly = poly.slice(0, -1);
    if (poly.length === 3 || poly.length === 4) {
      let ring = poly.concat([poly[0]]);
      if (maxDistToPoly(P, ring) < eps * 1.3) {
        // Viereck mit fast waagerechten/senkrechten Kanten → sauberes Rechteck
        if (poly.length === 4) {
          const straight = poly.every((q, i) => {
            const r = poly[(i + 1) % 4];
            const ang = Math.abs(Math.atan2(r[1] - q[1], r[0] - q[0])) % (Math.PI / 2);
            return Math.min(ang, Math.PI / 2 - ang) < (12 * Math.PI) / 180;
          });
          if (straight) {
            const xs = poly.map((q) => q[0]).sort((m, k) => m - k);
            const ys = poly.map((q) => q[1]).sort((m, k) => m - k);
            const l = (xs[0] + xs[1]) / 2, r = (xs[2] + xs[3]) / 2, t = (ys[0] + ys[1]) / 2, btm = (ys[2] + ys[3]) / 2;
            ring = [[l, t], [r, t], [r, btm], [l, btm], [l, t]];
          }
        }
        return { kind: 'poly', pts: along(ring) };
      }
    }
    // Kreis / Ellipse
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = (x1 - x0) / 2, ry = (y1 - y0) / 2;
    if (rx > 5 && ry > 5) {
      let err = 0;
      for (const [x, y] of P) err += Math.abs(Math.hypot((x - cx) / rx, (y - cy) / ry) - 1);
      if (err / n < 0.12) {
        // fast rund → echter Kreis
        const r = Math.abs(rx - ry) < Math.max(rx, ry) * 0.12 ? (rx + ry) / 2 : null;
        const start = Math.atan2(a[1] - cy, a[0] - cx);
        const out = [];
        for (let i = 0; i <= 72; i++) {
          const t = start + (i / 72) * Math.PI * 2;
          out.push([cx + Math.cos(t) * (r || rx), cy + Math.sin(t) * (r || ry)]);
        }
        return { kind: r ? 'circle' : 'ellipse', pts: out };
      }
    }
    return null;
  }

  // offener Streckenzug mit 2–3 Abschnitten (z. B. Winkel, Pfeilspitze)
  const poly = rdp(P, eps);
  if (poly.length >= 3 && poly.length <= 4 && maxDistToPoly(P, poly) < eps * 1.2) return { kind: 'open', pts: along(poly) };
  return null;
}

function recognizeShape() {
  if (!active || !active.stroke || active.shaped || !shapeRecog) return;
  const s = active.stroke, p = s.pts, P = [];
  let pr = 0;
  for (let i = 0; i < p.length; i += 3) { P.push([p[i], p[i + 1]]); pr += p[i + 2]; }
  const shape = fitShape(P);
  if (!shape) return;
  pr = Math.round((pr / P.length) * 100) / 100;
  s.shape = true;
  active.shaped = true;
  // Für das anschließende Größer-/Kleinerziehen merken: Grundform, Ankerpunkt und Stiftposition
  const pts = shape.pts;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  pts.forEach(([x, y]) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); });
  const open = shape.kind === 'line' || shape.kind === 'open';
  active.shapeEdit = {
    kind: shape.kind,
    base: pts,
    pr,
    anchor: open ? pts[0] : [(x0 + x1) / 2, (y0 + y1) / 2],   // Linie: Anfang bleibt, Form: Mitte bleibt
    hold: active.hold.slice()
  };
  setShapePts(pts);
}

function setShapePts(pts) {
  const pr = active.shapeEdit.pr, out = [];
  pts.forEach(([x, y]) => out.push(Math.round(x * 10) / 10, Math.round(y * 10) / 10, pr));
  active.stroke.pts = out;
  drawActiveStroke();
}

// Nach dem Erkennen den Stift weiterbewegen (ohne abzusetzen) = Form vergrößern/verkleinern
function resizeShape(x, y) {
  const e = active.shapeEdit, [ax, ay] = e.anchor, [hx, hy] = e.hold;
  let pts;
  if (e.kind === 'line' || e.kind === 'open') {
    // Linie folgt dem Stift: drehen und strecken um den Anfangspunkt
    const v0 = Math.hypot(hx - ax, hy - ay) || 1, v1 = Math.hypot(x - ax, y - ay);
    const k = v1 / v0, rot = Math.atan2(y - ay, x - ax) - Math.atan2(hy - ay, hx - ax);
    const c = Math.cos(rot) * k, sn = Math.sin(rot) * k;
    pts = e.base.map(([px, py]) => [ax + (px - ax) * c - (py - ay) * sn, ay + (px - ax) * sn + (py - ay) * c]);
  } else if (e.kind === 'circle') {
    const k = Math.hypot(x - ax, y - ay) / (Math.hypot(hx - ax, hy - ay) || 1);
    pts = e.base.map(([px, py]) => [ax + (px - ax) * k, ay + (py - ay) * k]);
  } else {
    // Rechteck, Dreieck, Ellipse: Breite und Höhe getrennt
    const kx = Math.abs(hx - ax) > 10 ? Math.abs(x - ax) / Math.abs(hx - ax) : 1;
    const ky = Math.abs(hy - ay) > 10 ? Math.abs(y - ay) / Math.abs(hy - ay) : 1;
    pts = e.base.map(([px, py]) => [ax + (px - ax) * kx, ay + (py - ay) * ky]);
  }
  setShapePts(pts);
}

// ---------- Textfelder bearbeiten ----------
// Text-Werkzeug: tippen = neues Feld (oder vorhandenes bearbeiten), ziehen = Feld verschieben.
let textAction = null;
let editor = null;   // { ta, page, t, before, existing }

function textAt(i, x, y) {
  const list = note.pages[i].strokes;
  for (let k = list.length - 1; k >= 0; k--) if (list[k].tool === 'text' && textHit(list[k], x, y, 8)) return k;
  return -1;
}

function textDown(e, canvas) {
  const hadEditor = !!editor;
  if (editor) commitEditor();            // Tippen daneben schließt das offene Feld
  if (e.pointerType !== 'touch') {
    e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch {}
  }
  const i = Number(canvas.dataset.page);
  const rect = canvas.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * PAGE_W;
  const y = ((e.clientY - rect.top) / rect.height) * PAGE_H;
  textAction = { id: e.pointerId, touch: e.pointerType === 'touch', page: i, rect, x0: x, y0: y, cx: e.clientX, cy: e.clientY, k: textAt(i, x, y), moved: false, noCreate: hadEditor };
}

function textMove(e) {
  const a = textAction;
  const x = ((e.clientX - a.rect.left) / a.rect.width) * PAGE_W;
  const y = ((e.clientY - a.rect.top) / a.rect.height) * PAGE_H;
  if (!a.moved && Math.hypot(x - a.x0, y - a.y0) < 6) return;
  if (a.k < 0) {
    // Ziehen auf leerer Fläche = scrollen (auf dem iPad macht das der Browser selbst)
    a.moved = true;
    if (a.touch && !IS_IOS) {
      pagesBox.scrollLeft -= e.clientX - a.cx;
      pagesBox.scrollTop -= e.clientY - a.cy;
      a.cx = e.clientX;
      a.cy = e.clientY;
    }
    return;
  }
  e.preventDefault();
  const strokes = note.pages[a.page].strokes;
  if (!a.moved) {
    a.moved = true;
    a.before = strokes.slice();
    a.orig = strokes[a.k];
  }
  const t = a.orig, h = textHeight(t);
  strokes[a.k] = {
    ...t,
    x: Math.max(0, Math.min(PAGE_W - t.w, t.x + x - a.x0)),
    y: Math.max(0, Math.min(PAGE_H - h, t.y + y - a.y0))
  };
  drawPage(a.page);
}

function textUp(e) {
  const a = textAction;
  textAction = null;
  if (e.type === 'pointercancel') return;      // Browser hat gescrollt
  if (a.moved) {
    if (a.k >= 0) {
      pushHistory([{ page: a.page, before: a.before, after: note.pages[a.page].strokes.slice() }]);
      saveNote();
    }
    return;
  }
  if (a.noCreate && a.k < 0) return;
  openEditor(a.page, a.k, a.x0, a.y0);
}

function openEditor(i, k, x, y) {
  const page = note.pages[i];
  const before = page.strokes.slice();
  let t;
  if (k >= 0) {
    t = page.strokes[k];
    page.strokes = page.strokes.filter((_, j) => j !== k);   // während der Bearbeitung ausblenden
    drawPage(i);
  } else {
    const fs = TEXT_SIZES[size] || 24;
    let w = Math.min(600, PAGE_W - x - 30);
    if (w < 150) { x = PAGE_W - 180; w = 150; }
    t = { tool: 'text', x, y: Math.max(0, y - fs * 0.8), w, size: fs, color: PEN_COLORS[colorSel.pen], text: '' };
  }
  const wrap = pageEls[i].wrap;
  const ta = document.createElement('textarea');
  ta.className = 'text-editor';
  ta.value = t.text;
  ta.setAttribute('autocapitalize', 'sentences');
  const px = wrap.clientWidth / PAGE_W;
  Object.assign(ta.style, {
    left: (t.x / PAGE_W) * 100 + '%',
    top: (t.y / PAGE_H) * 100 + '%',
    width: (t.w / PAGE_W) * 100 + '%',
    fontSize: t.size * px + 'px',
    lineHeight: TEXT_LH,
    color: t.color,
    fontFamily: TEXT_FONT
  });
  const fit = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };
  ta.addEventListener('input', fit);
  ta.addEventListener('blur', commitEditor);
  ta.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') cancelEditor(); });
  wrap.append(ta);
  fit();
  editor = { ta, page: i, t, before, existing: k >= 0 };
  ta.focus();
  const end = ta.value.length;
  ta.setSelectionRange(end, end);
}

function commitEditor() {
  if (!editor) return;
  const { ta, page, t, before, existing } = editor;
  editor = null;
  const text = ta.value.replace(/\s+$/, '');
  ta.remove();
  if (existing && text === t.text) {            // nichts geändert
    note.pages[page].strokes = before;
    drawPage(page);
    return;
  }
  if (text) note.pages[page].strokes.push({ ...t, text });
  drawPage(page);
  if (existing || text) {
    pushHistory([{ page, before, after: note.pages[page].strokes.slice() }]);
    saveNote();
  }
}

function cancelEditor() {
  if (!editor) return;
  const { ta, page, before } = editor;
  editor = null;
  ta.remove();
  note.pages[page].strokes = before;
  drawPage(page);
}

// ---------- Stift-Eingabe ----------
const pagesBox = $('#pages');        // scrollbarer Bereich mit den Seiten
const pagesInner = $('#pages-inner');
const touches = new Map();
let pan = null;
// Handballen: Solange der Stift schreibt oder gerade eben noch in der Nähe war (auch schwebend),
// werden Berührungen komplett ignoriert – sie scrollen nicht und zeichnen nicht.
let lastPenTime = 0;
const PALM_MS = 700;
const penNear = () => (active && active.pointerType === 'pen') || performance.now() - lastPenTime < PALM_MS;
const isPalm = (e) => e.width > 45 || e.height > 45;
let pinch = null;
let inertia = null;
const touchDist = () => {
  const [a, b] = [...touches.values()];
  return Math.hypot(a.x - b.x, a.y - b.y) || 1;
};
function stopInertia() { if (inertia) cancelAnimationFrame(inertia.raf); inertia = null; }
function startInertia(vx, vy) {
  // Schwung nach dem Loslassen (px pro ms)
  stopInertia();
  if (Math.hypot(vx, vy) < 0.05) return;
  let last = performance.now();
  inertia = { vx, vy, raf: 0 };
  const step = (now) => {
    if (!inertia) return;
    const dt = Math.min(32, now - last);
    last = now;
    pagesBox.scrollLeft -= inertia.vx * dt;
    pagesBox.scrollTop -= inertia.vy * dt;
    const f = Math.pow(0.995, dt);
    inertia.vx *= f;
    inertia.vy *= f;
    if (Math.hypot(inertia.vx, inertia.vy) < 0.02) { inertia = null; return; }
    inertia.raf = requestAnimationFrame(step);
  };
  inertia.raf = requestAnimationFrame(step);
}
const avgTouch = () => {
  const list = [...touches.values()];
  return { x: list.reduce((a, t) => a + t.x, 0) / list.length, y: list.reduce((a, t) => a + t.y, 0) / list.length };
};

function toPage(e) {
  return [
    ((e.clientX - active.rect.left) / active.rect.width) * PAGE_W,
    ((e.clientY - active.rect.top) / active.rect.height) * PAGE_H,
    Math.round((e.pressure || 0.5) * 100) / 100
  ];
}

// Strich verwerfen (z. B. wenn aus einem Finger-Strich doch eine Zwei-Finger-Geste wird)
function cancelActive() {
  if (!active) return;
  clearTimeout(active.holdTimer);
  const pe = pageEls[active.page];
  if (active.tool === 'eraser' && active.before) {
    note.pages[active.page].strokes = active.before;
    drawPage(active.page);
  }
  clearLive(pe);
  active = null;
}

// Hebt der Stift beim schnellen Schreiben nur ganz kurz ab (oder meldet iOS kurz "Stift hoch"),
// wird der Strich beim erneuten Aufsetzen weitergeführt. Sonst entstehen zwei Striche, deren
// dünne Enden man als Kerbe oder Streifen sieht.
// Verbunden wird nur, wenn der vorige Strich UNSAUBER endete (vom System abgebrochen, "Stift hoch"
// kam nie an). Normales Absetzen ist beim schnellen Schreiben gewollt und wird nie verbunden –
// sonst verschmelzen Buchstaben. Auf dem iPad gibt es zusätzlich eine winzige Toleranz für
// Mikro-Unterbrechungen des Pencils.
const JOIN_MS = 120;          // Pause nach unsauberem Ende
const JOIN_DIST = 14;         // Abstand nach unsauberem Ende (≈ 3 mm)
const JOIN_MS_IOS = 60;       // iPad: Mikro-Unterbrechung nach normalem Absetzen
const JOIN_DIST_IOS = 5;      // (≈ 1 mm)
let lastEnd = null;      // { stroke, page, time, x, y, before, abnormal }

function tryJoin(i, x, y) {
  const le = lastEnd;
  if (!le || le.page !== i) return null;
  const dt = performance.now() - le.time, dist = Math.hypot(x - le.x, y - le.y);
  const ok = le.abnormal ? dt <= JOIN_MS && dist <= JOIN_DIST : IS_IOS && dt <= JOIN_MS_IOS && dist <= JOIN_DIST_IOS;
  if (!ok) return null;
  const page = note.pages[i];
  const old = page.strokes[page.strokes.length - 1];
  const s = le.stroke;
  // nur, wenn es wirklich derselbe Stift mit derselben Einstellung ist und nichts dazwischenkam
  if (old !== s || s.shape || active.shaped || s.color !== active.color || s.size !== size || (s.style || 'pen') !== active.style || s.tool !== active.strokeTool) return null;
  // letzten Eintrag in "Rückgängig" zusammenfassen: der verbundene Strich ist dann EIN Schritt
  const h = undoStack[undoStack.length - 1];
  if (h && h.length === 1 && h[0].page === i && h[0].after[h[0].after.length - 1] === old) undoStack.pop();
  page.strokes.pop();
  drawPage(i);
  return { stroke: { ...s, pts: s.pts.slice() }, before: le.before };
}

// Strich fertigstellen und speichern
function finishActive(abnormal = false) {
  if (!active) return;
  clearTimeout(active.holdTimer);
  const pe = pageEls[active.page];
  const page = note.pages[active.page];
  if (active.tool === 'eraser') {
    clearLive(pe);
    if (page.strokes.length !== active.before.length) {
      pushHistory([{ page: active.page, before: active.before, after: page.strokes.slice() }]);
      saveNote();
    }
  } else {
    const before = active.joinBefore || page.strokes.slice();
    page.strokes.push(active.stroke);
    pe.ink.insertAdjacentHTML('beforeend', strokeSvg(active.stroke));
    clearLive(pe);
    pushHistory([{ page: active.page, before, after: page.strokes.slice() }]);
    saveNote();
    const pts = active.stroke.pts;
    lastEnd = { stroke: active.stroke, page: active.page, time: performance.now(), x: pts[pts.length - 3], y: pts[pts.length - 2], before, abnormal };
  }
  active = null;
}

function onDown(e) {
  const canvas = e.target.closest && e.target.closest('.page-live');
  if (!canvas) return;

  if (e.pointerType === 'pen') {
    lastPenTime = performance.now();
    if (fingerDraw) setFingerDraw(false, true);
    if (active && active.pointerType === 'touch') cancelActive();       // Handballen war zuerst da
    else if (active && active.pointerType === 'pen') finishActive(true);    // "Loslassen" ging verloren
  }

  if (e.pointerType === 'touch') {
    if (penNear() || isPalm(e)) return;   // Handballen
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    stopInertia();
    if (touches.size >= 2) {
      // Zwei Finger = scrollen/zoomen: angefangenen Finger-Strich verwerfen
      if (active && active.pointerType === 'touch') cancelActive();
      pan = { ...avgTouch(), vx: 0, vy: 0, t: performance.now() };
      if (!IS_IOS) pinch = { dist: touchDist(), zoom };   // iPad zoomt über Safaris Gesten
      return;
    }
    if (window.noteTool === 'text' && touches.size === 1 && !active) return textDown(e, canvas);
    if (!fingerDraw) {
      // Finger scrollt: auf dem iPad macht das der Browser, sonst die App selbst
      if (!IS_IOS) pan = { ...avgTouch(), vx: 0, vy: 0, t: performance.now() };
      return;
    }
    // große Auflagefläche = Handballen, nicht zeichnen
    if (e.width > 40 || e.height > 40) return;
  }
  if (active) return;
  // Radiergummi-Ende oder Seitentaste am Stift (z. B. Surface Pen) = Radierer
  const penEraser = e.pointerType === 'pen' && ((e.buttons & 32) || (e.buttons & 2));
  const tool = penEraser ? 'eraser' : window.noteTool;
  if (tool === 'text') return textDown(e, canvas);

  e.preventDefault();
  try { canvas.setPointerCapture(e.pointerId); } catch {}
  const i = Number(canvas.dataset.page);
  active = {
    id: e.pointerId,
    pointerType: e.pointerType,
    page: i,
    tool,
    rect: (sizeFastInk(), canvas.getBoundingClientRect())
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
    active.color = colors[colorSel[isMarker ? 'marker' : 'pen']];
    active.strokeTool = isMarker ? 'marker' : 'pen';
    active.style = tool === 'ball' ? 'ball' : 'pen';
    const joined = tryJoin(i, x, y);
    if (joined) {
      // am alten Strich weiterschreiben; die Lücke wird gerade verbunden
      active.stroke = joined.stroke;
      active.joinBefore = joined.before;
      active.stroke.pts.push(Math.round(x * 10) / 10, Math.round(y * 10) / 10, active.stroke.pts[active.stroke.pts.length - 1]);
      active.pressure = active.stroke.pts[active.stroke.pts.length - 1];
    } else {
      active.stroke = { tool: active.strokeTool, color: active.color, size, pts: [x, y, p] };
      if (tool === 'ball') active.stroke.style = 'ball';
      active.pressure = p;
    }
    lastEnd = null;
    const live = pageEls[i].live;
    active.live = live;
    active.liveDots = pageEls[i].liveDots;
    active.liveDots.setAttribute('fill', active.stroke.color);
    // Aussehen des Live-Pfads passend zum Werkzeug
    for (const a of ['fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'style']) live.removeAttribute(a);
    if (isMarker) {
      live.setAttribute('fill', 'none');
      live.setAttribute('stroke', active.stroke.color);
      live.setAttribute('stroke-width', strokeWidth(active.stroke));
      live.setAttribute('stroke-linecap', 'round');
      live.setAttribute('stroke-linejoin', 'round');
      live.setAttribute('style', 'mix-blend-mode:multiply');
    } else {
      live.setAttribute('fill', active.stroke.color);
    }
    drawActiveStroke(); // sofort einen Punkt zeigen
  }
}

function onMove(e) {
  if (e.pointerType === 'pen') lastPenTime = performance.now();   // auch schwebender Stift zählt
  if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
    const t = touches.get(e.pointerId);
    t.x = e.clientX;
    t.y = e.clientY;
    if (pan && (touches.size >= 2 || (!fingerDraw && !IS_IOS))) {
      const c = avgTouch();
      if (pinch && touches.size >= 2) {
        const r = pagesBox.getBoundingClientRect();
        setZoom(pinch.zoom * touchDist() / pinch.dist, c.x - r.left, c.y - r.top);
      }
      const now = performance.now(), dt = Math.max(1, now - pan.t);
      const dx = c.x - pan.x, dy = c.y - pan.y;
      pagesBox.scrollLeft -= dx;
      pagesBox.scrollTop -= dy;
      // Geschwindigkeit für den Schwung merken (geglättet)
      pan = { ...c, vx: pan.vx * 0.6 + (dx / dt) * 0.4, vy: pan.vy * 0.6 + (dy / dt) * 0.4, t: now };
      return;
    }
  }
  if (textAction && e.pointerId === textAction.id) return textMove(e);
  if (!active || e.pointerId !== active.id) return;
  e.preventDefault();
  if (active.shaped) {
    // Form ist erkannt – Stift weiterbewegen zieht sie größer oder kleiner
    const [x, y] = toPage(e);
    resizeShape(x, y);
    return;
  }

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
      // Stift bleibt kurz still → Form erkennen
      if (!active.hold || Math.hypot(x - active.hold[0], y - active.hold[1]) > 3) {
        active.hold = [x, y];
        clearTimeout(active.holdTimer);
        active.holdTimer = setTimeout(recognizeShape, HOLD_MS);
      }
    }
  }
  if (active.tool !== 'eraser') {
    drawActiveStroke();
  }
}

function onUp(e) {
  if (e.pointerType === 'pen') lastPenTime = performance.now();
  if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
    const wasPanning = pan && !fingerDraw && !IS_IOS && touches.size === 1;
    touches.delete(e.pointerId);
    pinch = null;
    if (wasPanning && e.type === 'pointerup' && performance.now() - pan.t < 80) startInertia(pan.vx, pan.vy);
    // bleibt ein Finger liegen, scrollt er weiter – ohne Sprung
    pan = touches.size && (touches.size >= 2 || (!fingerDraw && !IS_IOS)) ? { ...avgTouch(), vx: 0, vy: 0, t: performance.now() } : null;
  }
  if (textAction && e.pointerId === textAction.id) return textUp(e);
  if (!active || e.pointerId !== active.id) return;
  // Bricht iOS einen Stift-Strich ab, wird er trotzdem behalten – bisher verschwand er dann.
  // Nur Finger-Striche werden bei einem Abbruch verworfen (dann war es meist eine Geste).
  if (e.type === 'pointercancel' && active.pointerType !== 'pen') cancelActive();
  else finishActive(e.type !== 'pointerup');   // pointercancel = vom System abgebrochen
}

pagesBox.addEventListener('pointerdown', onDown);
pagesBox.addEventListener('pointermove', onMove);
pagesBox.addEventListener('pointerup', onUp);
pagesBox.addEventListener('pointercancel', onUp);
// Scrollt die Seite während eines Strichs (z. B. durch den Handballen), bleibt der Strich unter dem Stift
pagesBox.addEventListener('scroll', () => {
  if (active) active.rect = pageEls[active.page].svg.getBoundingClientRect();
}, { passive: true });

// Langes Drücken mit dem Stift öffnet unter Windows sonst das Rechtsklick-Menü
pagesBox.addEventListener('contextmenu', (e) => e.preventDefault());
pagesBox.addEventListener('lostpointercapture', (e) => {
  if (active && e.pointerId === active.id) finishActive(true);
});
// Apple Pencil soll nie scrollen – nur der Finger (wenn "Finger zeichnet" aus ist)
const blockScroll = (e) => {
  if (!e.target.closest || !e.target.closest('.page-live')) return;
  // Stift oder Handballen (Stift schreibt gerade / war eben noch da) dürfen nicht scrollen
  if (fingerDraw || penNear() || [...e.touches].some((t) => t.touchType === 'stylus')) e.preventDefault();
};
pagesBox.addEventListener('touchstart', blockScroll, { passive: false });
pagesBox.addEventListener('touchmove', blockScroll, { passive: false });

// ---------- Zoomen ----------
// Weil alles Vektorgrafik ist, bleibt die Schrift bei jeder Zoomstufe scharf.
const ZOOM_MIN = 0.5, ZOOM_MAX = 4;
let zoom = 1;

function setZoom(z, cx, cy) {
  z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  if (Math.abs(z - zoom) < 0.001) return;
  // Punkt unter den Fingern (cx, cy) soll beim Zoomen an derselben Stelle bleiben
  if (cx == null) { cx = pagesBox.clientWidth / 2; cy = pagesBox.clientHeight / 2; }
  const ratio = z / zoom;
  const left = (pagesBox.scrollLeft + cx) * ratio - cx;
  const top = (pagesBox.scrollTop + cy) * ratio - cy;
  zoom = z;
  pagesInner.style.width = zoom * 100 + '%';
  pagesInner.style.maxWidth = 900 * zoom + 'px';
  pagesBox.scrollLeft = left;
  pagesBox.scrollTop = top;
  $('#zoom-label').textContent = Math.round(zoom * 100) + '%';
}

// Pinch-Geste mit zwei Fingern (Safari auf dem iPad)
let gestureStart = null;
pagesBox.addEventListener('gesturestart', (e) => {
  e.preventDefault();
  gestureStart = zoom;
  if (active && active.pointerType === 'touch') cancelActive();
});
pagesBox.addEventListener('gesturechange', (e) => {
  e.preventDefault();
  if (gestureStart == null) return;
  const r = pagesBox.getBoundingClientRect();
  setZoom(gestureStart * e.scale, e.clientX - r.left, e.clientY - r.top);
});
pagesBox.addEventListener('gestureend', (e) => { e.preventDefault(); gestureStart = null; });

// Trackpad / Strg + Mausrad (am Computer)
pagesBox.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  const r = pagesBox.getBoundingClientRect();
  setZoom(zoom * Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
}, { passive: false });

$('#zoom-in').addEventListener('click', () => setZoom(zoom * 1.25));
$('#zoom-out').addEventListener('click', () => setZoom(zoom / 1.25));
$('#zoom-label').addEventListener('click', () => setZoom(1));

// ---------- Werkzeugleiste ----------
function renderColors() {
  const g = $('#color-group');
  g.innerHTML = '';
  // Beim Radierer nur unsichtbar machen – sonst ändert sich die Höhe der Leiste und die Seite springt
  g.classList.toggle('invisible', tool === 'eraser');
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
    document.body.dataset.noteTool = tool;
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
  if (auto) toast('Stift erkannt – der Finger scrollt jetzt');
  else toast(on ? 'Finger zeichnet (2 Finger scrollen)' : 'Nur der Stift zeichnet, Finger scrollt');
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
  commitEditor();
  // leere Notizen nicht aufheben
  if (note && note.id !== n.id && isEmpty(note)) {
    cancelSave();
    await noteDb.del(note.id).catch(() => {});
  }
  note = n;
  store.set('currentNote', n.id);
  undoStack = [];
  lastEnd = null;
  redoStack = [];
  updateUndoButtons();
  $('#note-title').value = n.title;
  buildPages();
  $('#pages').scrollTop = 0;
  $('#pages').scrollLeft = 0;
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
  if (isEmpty(note)) return toast('Diese Notiz ist noch leer');
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

function renderShapeToggle() {
  $('#shape-toggle').classList.toggle('active', shapeRecog);
  $('#shape-toggle').setAttribute('aria-pressed', shapeRecog);
}
$('#shape-toggle').addEventListener('click', () => {
  shapeRecog = !shapeRecog;
  store.set('shapeRecog', shapeRecog);
  renderShapeToggle();
  toast(shapeRecog ? 'Formerkennung an: Stift am Ende kurz halten' : 'Formerkennung aus');
});
$('#note-back').addEventListener('click', () => showView('home'));
renderShapeToggle();

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

  shareFiles(files, base);
});

// Export als PDF: echte Vektorgrafik – bleibt z. B. in Goodnotes auch beim Zoomen scharf
function cmdsToPdf(cmds) {
  let out = '', cx = 0, cy = 0, sx = 0, sy = 0;
  for (const c of cmds) {
    if (c[0] === 'M') { out += `${num(c[1])} ${num(c[2])} m\n`; cx = sx = c[1]; cy = sy = c[2]; }
    else if (c[0] === 'L') { out += `${num(c[1])} ${num(c[2])} l\n`; cx = c[1]; cy = c[2]; }
    else if (c[0] === 'Q') {
      // PDF kennt nur kubische Kurven: quadratische umrechnen
      const [, qx, qy, x, y] = c;
      out += `${num(cx + (2 / 3) * (qx - cx))} ${num(cy + (2 / 3) * (qy - cy))} ${num(x + (2 / 3) * (qx - x))} ${num(y + (2 / 3) * (qy - y))} ${num(x)} ${num(y)} c\n`;
      cx = x; cy = y;
    } else if (c[0] === 'C') {
      out += `${num(c[1])} ${num(c[2])} ${num(c[3])} ${num(c[4])} ${num(c[5])} ${num(c[6])} c\n`;
      cx = c[5]; cy = c[6];
    } else { out += 'h\n'; cx = sx; cy = sy; }
  }
  return out;
}

// Text für PDF: Sonderzeichen escapen, Umlaute als WinAnsi-Oktalcodes (Inhalt bleibt reines ASCII)
function pdfText(s) {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (ch === '\\' || ch === '(' || ch === ')') out += '\\' + ch;
    else if (code >= 32 && code < 127) out += ch;
    else if (code === 0x20ac) out += '\\200';                     // €
    else if (code >= 160 && code <= 255) out += '\\' + code.toString(8);
    else if (code === 0x2013 || code === 0x2014) out += '-';
    else if (code === 0x201e || code === 0x201c || code === 0x201d) out += '"';
    else out += '?';
  }
  return out;
}

const pdfColor = (hex) => [1, 3, 5].map((i) => num(parseInt(hex.slice(i, i + 2), 16) / 255)).join(' ');

function buildPdf(pages, paper) {
  const S = 595.28 / PAGE_W;              // A4-Breite in PDF-Punkten
  const H = num(PAGE_H * S);
  const objs = [];                        // Index 0 = Objekt 1
  const add = (body) => { objs.push(body); return objs.length; };
  const catalog = add(null);
  const pagesObj = add(null);
  const gs = add('<< /Type /ExtGState /BM /Multiply >>');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const kids = [];

  pages.forEach((page) => {
    let c = '';
    let res = '';
    if (page.bg) {
      const bg = page.bg;
      const img = add({ head: `<< /Type /XObject /Subtype /Image /Width ${bg.w} /Height ${bg.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${bg.data.length} >>`, data: bg.data });
      res = ` /XObject << /Im1 ${img} 0 R >>`;
      // Bild in PDF-Koordinaten (Ursprung unten links)
      c += `q ${num(bg.width * S)} 0 0 ${num(bg.height * S)} ${num(bg.x * S)} ${num(PAGE_H * S - (bg.y + bg.height) * S)} cm /Im1 Do Q\n`;
    }
    c += `q\n${S.toFixed(6)} 0 0 ${(-S).toFixed(6)} 0 ${H} cm\n1 J 1 j\n`;
    if (!page.bg) paperLines(paper).forEach(([color, w, cmds]) => {
      c += `${pdfColor(color)} RG ${w} w\n${cmdsToPdf(cmds)}S\n`;
    });
    if (paper === 'dots' && !page.bg) {
      c += `${pdfColor('#b4b4bb')} rg\n`;
      forEachDot((x, y) => { const d = []; circleCmds(d, x, y, 1.4); c += cmdsToPdf(d); });
      c += 'f\n';
    }
    page.strokes.forEach((s) => {
      if (s.tool === 'text') return;   // Text kommt weiter unten
      if (s.tool === 'marker') {
        c += `q /GS1 gs ${pdfColor(s.color)} RG ${num(strokeWidth(s))} w\n${cmdsToPdf(markerCmds(s))}S Q\n`;
      } else {
        const { outline, dots } = penCmds(s);
        c += `${pdfColor(s.color)} rg\n${cmdsToPdf(outline)}f\n`;
        if (dots.length) c += `${cmdsToPdf(dots)}f\n`;
      }
    });
    c += 'Q\n';
    page.strokes.filter((t) => t.tool === 'text').forEach((t) => {
      c += `BT /F1 ${num(t.size * S)} Tf ${pdfColor(t.color)} rg\n`;
      textLines(t).forEach((l, i) => {
        const yb = PAGE_H * S - (t.y + t.size + i * t.size * TEXT_LH) * S;
        c += `1 0 0 1 ${num(t.x * S)} ${num(yb)} Tm (${pdfText(l)}) Tj\n`;
      });
      c += 'ET\n';
    });
    const content = add(`<< /Length ${c.length} >>\nstream\n${c}endstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 595.28 ${H}] /Resources << /ExtGState << /GS1 ${gs} 0 R >> /Font << /F1 ${font} 0 R >>${res} >> /Contents ${content} 0 R >>`));
  });
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => k + ' 0 R').join(' ')}] /Count ${kids.length} >>`;

  // Zusammenbauen als Bytes – Text ist reines ASCII, Bilder sind binär
  const enc = new TextEncoder();
  const chunks = [];
  let size = 0;
  const put = (x) => { const b = typeof x === 'string' ? enc.encode(x) : x; chunks.push(b); size += b.length; };
  put('%PDF-1.4\n');
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(size);
    if (typeof body === 'string') {
      put(`${i + 1} 0 obj\n${body}\nendobj\n`);
    } else {
      put(`${i + 1} 0 obj\n${body.head}\nstream\n`);
      put(body.data);
      put('\nendstream\nendobj\n');
    }
  });
  const xref = size;
  let tail = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((o) => { tail += String(o).padStart(10, '0') + ' 00000 n \n'; });
  tail += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  put(tail);
  return new Blob(chunks, { type: 'application/pdf' });
}

function shareFiles(files, title) {
  if (navigator.canShare && navigator.canShare({ files })) {
    navigator.share({ files, title }).catch(() => {});
  } else {
    files.forEach((f) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(f);
      a.download = f.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
  }
}

$('#note-export-pdf').addEventListener('click', () => {
  const base = (note.title || 'Notiz').replace(/[^\wäöüÄÖÜß -]/g, '').trim() || 'Notiz';
  let pages = note.pages.filter((p) => p.strokes.length || p.bg);
  if (!pages.length) pages = note.pages.slice(0, 1);
  const file = new File([buildPdf(pages, note.paper)], base + '.pdf', { type: 'application/pdf' });
  shareFiles([file], base);
});

// ---------- Import: PDF und Bilder ----------
const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/';
const IMPORT_WIDTH = 1600;       // Pixelbreite, in der importierte Seiten gespeichert werden
const MAX_IMPORT_PAGES = MAX_PAGES;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Laden fehlgeschlagen'));
    document.head.append(s);
  });
}

async function pdfLib() {
  if (!window.pdfjsLib) {
    await loadScript(PDFJS + 'pdf.min.js');
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js';
  }
  return window.pdfjsLib;
}

// Bild so auf die A4-Seite setzen, dass es ganz draufpasst (oben bündig)
function placeOnPage(w, h) {
  const ratio = h / w;
  if (ratio <= PAGE_H / PAGE_W) return { x: 0, y: 0, width: PAGE_W, height: PAGE_W * ratio };
  const width = PAGE_H / ratio;
  return { x: (PAGE_W - width) / 2, y: 0, width, height: PAGE_H };
}

async function canvasToBg(canvas) {
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.88));
  const data = new Uint8Array(await blob.arrayBuffer());
  return { data, w: canvas.width, h: canvas.height, ...placeOnPage(canvas.width, canvas.height) };
}

async function imageFileToBg(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const k = Math.min(1, IMPORT_WIDTH / img.naturalWidth);
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k);
    c.height = Math.round(img.naturalHeight * k);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';                 // durchsichtige PNGs auf weißem Papier
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return await canvasToBg(c);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function importPdf(file) {
  toast('PDF wird geladen …');
  let lib;
  try { lib = await pdfLib(); } catch {
    return toast('PDF-Import braucht beim ersten Mal Internet');
  }
  const pdf = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const count = Math.min(pdf.numPages, MAX_IMPORT_PAGES);
  const n = newNote();
  n.title = file.name.replace(/\.pdf$/i, '').slice(0, 40);
  n.paper = 'blank';
  n.pages = [];
  for (let i = 1; i <= count; i++) {
    toast(`Seite ${i} von ${count} …`);
    const page = await pdf.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: IMPORT_WIDTH / base.width });
    const c = document.createElement('canvas');
    c.width = Math.round(viewport.width);
    c.height = Math.round(viewport.height);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    n.pages.push({ strokes: [], bg: await canvasToBg(c) });
  }
  await noteDb.put(n);
  await openNote(n);
  toast(pdf.numPages > count ? `Importiert (nur die ersten ${count} Seiten)` : `${count} ${count === 1 ? 'Seite' : 'Seiten'} importiert`);
}

async function importImage(file) {
  if (note.pages.length >= MAX_PAGES) return toast('Diese Notiz hat schon die maximale Seitenzahl');
  const bg = await imageFileToBg(file);
  // leere letzte Seite wiederverwenden, sonst neue Seite anhängen
  const last = note.pages[note.pages.length - 1];
  if (last && !last.strokes.length && !last.bg) last.bg = bg;
  else note.pages.push({ strokes: [], bg });
  buildPages();
  saveNote();
  pageEls[pageEls.length - 1].wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
  toast('Bild importiert');
}

$('#note-import').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  $('#more-dialog').close();
  if (!file) return;
  const name = file.name.toLowerCase();
  try {
    if (name.endsWith('.goodnotes')) {
      alert('Goodnotes-Dateien haben ein eigenes, nicht offenes Format.\n\nSo geht es: In Goodnotes die Notiz öffnen → Teilen → Exportieren → PDF. Diese PDF dann hier importieren.');
    } else if (file.type === 'application/pdf' || name.endsWith('.pdf')) {
      await importPdf(file);
    } else if (file.type.startsWith('image/') || /\.(png|jpe?g|heic|gif|webp)$/.test(name)) {
      await importImage(file);
    } else {
      toast('Dieses Dateiformat wird nicht unterstützt');
    }
  } catch (err) {
    toast('Import fehlgeschlagen');
    console.error(err);
  }
});

// Beim Wechseln/Schließen der App sofort speichern
function flushNoteSave() {
  if (window.appRestoring) return cancelSave();
  if (saveTarget) return writeNow();
}
window.addEventListener('pagehide', flushNoteSave);
document.addEventListener('visibilitychange', () => document.hidden && flushNoteSave());
// Vor einem Update: offenes Textfeld übernehmen und fertig speichern
window.appFlush.push(async () => { commitEditor(); await flushNoteSave(); });

// ---------- Start ----------
setupFastInk();
(async () => {
  document.body.classList.toggle('finger-draw', fingerDraw);
  $('#finger-toggle').classList.toggle('active', fingerDraw);
  document.querySelectorAll('[data-tool]').forEach((x) => x.classList.toggle('active', x.dataset.tool === tool));
  document.body.dataset.noteTool = tool;
  renderColors();
  renderSize();
  let all = [];
  try { all = await noteDb.all(); } catch {}
  const last = all.find((n) => n.id === store.get('currentNote')) ||
    all.sort((a, b) => b.updated - a.updated)[0];
  if (last) openNote(last);
  else createNote();
})();
