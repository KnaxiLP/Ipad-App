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
// Einstellungen: Druckempfindlichkeit (0 aus … 3 stark) und Glättung (Durchgänge)
let penPressure = store.get('penPressure', 2);
let penSmooth = store.get('penSmooth', 2);
function pointRadius(s, p) {
  const w = strokeWidth(s) / 2;
  if (s.style === 'ball') return w * (0.9 + 0.2 * p);
  if (penPressure === 0) return w * 1.15;
  if (penPressure === 1) return w * (0.8 + 0.65 * Math.pow(p, 0.8));
  if (penPressure === 3) return w * (0.25 + 1.8 * Math.pow(p, 0.9));
  return w * (0.5 + 1.2 * Math.pow(p, 0.8));
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

  // Wendepunkte im Rohstrich finden (Richtung ändert sich stark). Die bleiben beim Verteilen
  // exakt erhalten – sonst liegt die Spitze erst genau auf dem Wendepunkt und wird beim nächsten
  // Punkt abgeschnitten: der Strich "zuckt" bei schnellen Richtungswechseln zurück.
  const sharp = new Uint8Array(raw.length);
  for (let i = 1, j = 0, k = 1; i < raw.length - 1; i++) {
    while (j < i - 1 && Math.hypot(raw[i][0] - raw[j + 1][0], raw[i][1] - raw[j + 1][1]) >= 2) j++;
    if (k <= i) k = i + 1;
    while (k < raw.length - 1 && Math.hypot(raw[k][0] - raw[i][0], raw[k][1] - raw[i][1]) < 2) k++;
    const ax = raw[i][0] - raw[j][0], ay = raw[i][1] - raw[j][1];
    const bx = raw[k][0] - raw[i][0], by = raw[k][1] - raw[i][1];
    if ((ax * bx + ay * by) / ((Math.hypot(ax, ay) * Math.hypot(bx, by)) || 1) < 0.3) sharp[i] = 1;
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
    if (sharp[i] && carry > RESAMPLE_STEP * 0.2) { pts.push(b.slice()); carry = 0; }
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
  for (let pass = 0; pass < (s.shape ? 0 : penSmooth); pass++) {
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
let svgCache = new WeakMap();
// Nach geänderten Stift-Einstellungen alle Striche neu berechnen
function resetInkCache() {
  svgCache = new WeakMap();
  if (note) pageEls.forEach((_, i) => drawPage(i));
}
function markerAttrs(color, width) {
  return `fill="none" stroke="${color}" stroke-width="${num(width)}" stroke-linecap="round" stroke-linejoin="round" style="mix-blend-mode:multiply"`;
}
// ---------- Bilder als Elemente ----------
// Ein eingefügtes Bild liegt wie ein Strich in page.strokes:
// { tool: 'image', x, y, w, h, data (JPEG-Bytes), pw, ph (Pixelgröße) }
const elUrls = new WeakMap();
const elImgs = new WeakMap();

function imageUrl(data) {
  let u = elUrls.get(data);
  if (!u) {
    u = URL.createObjectURL(new Blob([data], { type: 'image/jpeg' }));
    elUrls.set(data, u);
    const img = new Image();       // für den Bild-Export schon mal laden
    img.src = u;
    elImgs.set(data, img);
  }
  return u;
}

function imageSvg(s) {
  return `<image href="${imageUrl(s.data)}" x="${num(s.x)}" y="${num(s.y)}" width="${num(s.w)}" height="${num(s.h)}" preserveAspectRatio="none"/>`;
}

// ---------- Textfelder ----------
// Ein Textfeld liegt wie ein Strich in page.strokes: { tool: 'text', x, y, w, size, color, text }
// (x/y = linke obere Ecke, w = Breite, alles in Seiten-Einheiten). Die Zeilenumbrüche werden
// einmal berechnet und für Bildschirm, Bild- und PDF-Export gleich benutzt.
const TEXT_FONT = 'Helvetica, Arial, sans-serif';
const TEXT_SIZES = { 1: 18, 2: 24, 4: 36 };   // Schriftgröße je Stärke-Knopf (24 ≈ 14 pt auf A4)
const TEXT_LH = 1.3;                          // Zeilenabstand
const measureCtx = document.createElement('canvas').getContext('2d');
const layoutCache = new WeakMap();
const TEXT_PAD = 6;                            // Innenabstand bei Hintergrund/Rahmen

// Absätze eines Textfelds. Neu: t.paras = [{ align, list: 'bullet'|'number', h, spans: [{ t, b, i, u, c }] }].
// Alte Textfelder haben nur t.text – daraus wird ein einfacher Absatz je Zeile.
function textParas(t) {
  return t.paras || t.text.split('\n').map((line) => ({ spans: [{ t: line }] }));
}

const fontOf = (st, fs) => `${st.i ? 'italic ' : ''}${st.b ? 'bold ' : ''}${fs}px ${TEXT_FONT}`;
function measure(text, font) {
  measureCtx.font = font;
  return measureCtx.measureText(text).width;
}

// Zeilen berechnen – einmal für Bildschirm, Bild- und PDF-Export gleich.
// Ergebnis: { h, lines: [{ y (Grundlinie), runs: [{ text, x, fs, b, i, u, c }] }] } in Seiten-Einheiten
function layoutText(t) {
  let L = layoutCache.get(t);
  if (L) return L;
  const lines = [];
  let y = t.y, listNo = 0;
  for (const p of textParas(t)) {
    const fs = t.size * (p.h ? 1.35 : 1), lh = fs * TEXT_LH;
    listNo = p.list === 'number' ? listNo + 1 : 0;
    const prefix = p.list === 'bullet' ? '•' : p.list === 'number' ? listNo + '.' : '';
    const indent = prefix ? fs * (p.list === 'number' ? 1.6 : 1.1) : 0;
    const avail = Math.max(fs, t.w - indent);
    // Wörter (mit Stil) sammeln
    const tokens = [];
    for (const sp of p.spans) {
      const st = { b: sp.b || p.h, i: sp.i, u: sp.u, c: sp.c || t.color };
      for (const word of sp.t.split(/(\s+)/)) if (word) tokens.push({ text: word, st, space: /^\s+$/.test(word) });
    }
    const rows = [[]];
    let width = 0;
    for (const tok of tokens) {
      const font = fontOf(tok.st, fs);
      let w = measure(tok.text, font);
      if (!tok.space && width + w > avail && rows[rows.length - 1].length) {
        // trailing spaces der Zeile vorher zählen nicht
        rows.push([]);
        width = 0;
      }
      if (tok.space && !rows[rows.length - 1].length && rows.length > 1) continue;   // kein Leerzeichen am Zeilenanfang
      // sehr lange Wörter hart umbrechen
      let text = tok.text;
      while (!tok.space && w > avail && text.length > 1) {
        let k = text.length - 1;
        while (k > 1 && measure(text.slice(0, k), font) > avail - width) k--;
        rows[rows.length - 1].push({ ...tok, text: text.slice(0, k), w: measure(text.slice(0, k), font) });
        rows.push([]);
        width = 0;
        text = text.slice(k);
        w = measure(text, font);
      }
      rows[rows.length - 1].push({ ...tok, text, w });
      width += w;
    }
    rows.forEach((row, ri) => {
      while (row.length && row[row.length - 1].space) row.pop();
      const rowW = row.reduce((sum, r) => sum + r.w, 0);
      let x = t.x + indent + (p.align === 'center' ? (avail - rowW) / 2 : p.align === 'right' ? avail - rowW : 0);
      const base = y + fs;
      const runs = [];
      if (ri === 0 && prefix) {
        const pw = measure(prefix, fontOf({ b: p.h }, fs));
        runs.push({ text: prefix, x: t.x + indent - pw - fs * 0.35, w: pw, fs, b: p.h, c: t.color, prefix: true });
      }
      for (const r of row) {
        const last = runs[runs.length - 1];
        if (last && !last.prefix && last.b === r.st.b && last.i === r.st.i && last.u === r.st.u && last.c === r.st.c && last.fs === fs) {
          last.text += r.text;
          last.w += r.w;
        } else {
          runs.push({ text: r.text, x, w: r.w, fs, b: r.st.b, i: r.st.i, u: r.st.u, c: r.st.c });
        }
        x += r.w;
      }
      lines.push({ y: base, runs });
      y += lh;
    });
  }
  L = { lines, h: Math.max(t.size * TEXT_LH, y - t.y) };
  layoutCache.set(t, L);
  return L;
}

const textHeight = (t) => layoutText(t).h;
const escXml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const TEXT_BGS = [null, '#fef3c7', '#dcfce7', '#dbeafe', '#fee2e2'];   // Hintergründe: gelb, grün, blau, rot (hell)

function textBox(t) {
  const L = layoutText(t);
  return { x: t.x - TEXT_PAD, y: t.y - TEXT_PAD, w: t.w + 2 * TEXT_PAD, h: L.h + 2 * TEXT_PAD };
}

function textSvg(t) {
  const L = layoutText(t);
  let out = '';
  if (t.bg || t.border) {
    const b = textBox(t);
    out += `<rect x="${num(b.x)}" y="${num(b.y)}" width="${num(b.w)}" height="${num(b.h)}" rx="4" fill="${t.bg || 'none'}"${t.border ? ` stroke="${t.color}" stroke-width="1.5"` : ''}/>`;
  }
  let spans = '', lines = '';
  for (const line of L.lines) {
    for (const r of line.runs) {
      spans += `<tspan x="${num(r.x)}" y="${num(line.y)}" font-size="${num(r.fs)}" fill="${r.c}"${r.b ? ' font-weight="bold"' : ''}${r.i ? ' font-style="italic"' : ''}>${escXml(r.text)}</tspan>`;
      if (r.u) lines += `<rect x="${num(r.x)}" y="${num(line.y + r.fs * 0.12)}" width="${num(r.w)}" height="${num(r.fs * 0.06)}" fill="${r.c}"/>`;
    }
  }
  return out + `<text font-family="${TEXT_FONT}" xml:space="preserve">${spans}</text>` + lines;
}

function drawText(ctx, t) {
  const L = layoutText(t);
  if (t.bg || t.border) {
    const b = textBox(t);
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(b.x, b.y, b.w, b.h, 4) : ctx.rect(b.x, b.y, b.w, b.h);
    if (t.bg) { ctx.fillStyle = t.bg; ctx.fill(); }
    if (t.border) { ctx.strokeStyle = t.color; ctx.lineWidth = 1.5; ctx.stroke(); }
  }
  for (const line of L.lines) {
    for (const r of line.runs) {
      ctx.font = fontOf(r, r.fs);
      ctx.fillStyle = r.c;
      ctx.fillText(r.text, r.x, line.y);
      if (r.u) ctx.fillRect(r.x, line.y + r.fs * 0.12, r.w, r.fs * 0.06);
    }
  }
}

function strokeSvg(s) {
  let out = svgCache.get(s);
  if (!out) {
    out = s.tool === 'text' ? textSvg(s)
      : s.tool === 'image' ? imageSvg(s)
      : s.tool === 'math' ? mathSvg(s)
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
  if (s.tool === 'image') {
    imageUrl(s.data);
    const img = elImgs.get(s.data);
    if (img.complete && img.naturalWidth) ctx.drawImage(img, s.x, s.y, s.w, s.h);
  } else if (s.tool === 'text') {
    drawText(ctx, s);
  } else if (s.tool === 'math') {
    drawMath(ctx, s);
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
  if (sel) deselectImage();
  const box = $('#pages-inner');
  box.innerHTML = '';
  pageEls = note.pages.map((_, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'page';
    const svg = svgEl('svg', { viewBox: `0 0 ${PAGE_W} ${PAGE_H}`, class: 'page-live', 'data-page': i });
    const paper = svgEl('g');
    const ink = svgEl('g');
    const notes = svgEl('g');                   // Side-Notes-Markierungen
    const live = svgEl('path');                 // der Strich, der gerade geschrieben wird
    const liveDots = svgEl('path');             // seine runden Punkte an Kehren
    const eraser = svgEl('circle', { fill: 'none', stroke: '#8e8e93', 'stroke-width': 1.5, r: 0 });
    svg.append(paper, ink, notes, live, liveDots, eraser);
    const numEl = document.createElement('span');
    numEl.className = 'page-num';
    numEl.textContent = i + 1;
    wrap.append(svg, numEl);
    const row = document.createElement('div');
    row.className = 'page-row';
    const col = document.createElement('div');
    col.className = 'sn-col';
    row.append(wrap, col);
    box.append(row);
    return { wrap, svg, paper, ink, notes, col, live, liveDots, eraser };
  });
  snClosePop();
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

let snColTimer = 0;
function drawPage(i) {
  const pe = pageEls[i];
  if (!pe) return;
  pe.paper.innerHTML = paperSvg(note.paper) + bgSvg(note.pages[i].bg);
  pe.ink.innerHTML = note.pages[i].strokes.map(strokeSvg).join('');
  pe.notes.innerHTML = snMarksSvg(i);
  clearTimeout(snColTimer);
  snColTimer = setTimeout(snRenderColumns, 30);
  if (sel && sel.page === i) {
    if (sel.items.every((s) => note.pages[i].strokes.includes(s))) placeSelection();
    else deselectImage();      // z. B. nach Rückgängig
  }
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

// Verlauf: Einträge sind Listen von Änderungen
//   { page, before, after }                 – Striche einer Seite
//   { page, before, after, nbefore, nafter } – dazu die Side Notes der Seite
//   { pages: true, before, after }          – ganze Seiten (Einfügen, Verschieben, Löschen …)
const copyPages = (pages) => pages.map((p) => ({ ...p, strokes: p.strokes.slice(), notes: p.notes ? p.notes.slice() : undefined }));
const snapPages = () => copyPages(note.pages);

// Seiten-Aktion als ein Rückgängig-Schritt
function pagesChange(fn) {
  const before = snapPages();
  fn();
  pushHistory([{ pages: true, before, after: snapPages() }]);
  buildPages();
  saveNote();
}

function applyHistory(from, to, key) {
  lastEnd = null;
  const changes = from.pop();
  if (!changes) return;
  if (typeof snOpen !== 'undefined' && snOpen) { snSession = null; closeSnPanel(); }
  let rebuild = false;
  changes.forEach((c) => {
    if (c.pages) { note.pages = copyPages(c[key]); rebuild = true; return; }
    note.pages[c.page].strokes = c[key].slice();
    if (c.nbefore) note.pages[c.page].notes = (key === 'before' ? c.nbefore : c.nafter).slice();
    if (!rebuild) drawPage(c.page);
  });
  if (rebuild) buildPages();
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
  if (s.tool === 'image') return false;   // Bilder radiert man nicht weg, man löscht sie (Auswählen)
  if (s.tool === 'text') return textHit(s, x, y, r);
  if (s.tool === 'math') { const b = mathBounds(s); return x >= b[0] - r && x <= b[2] + r && y >= b[1] - r && y <= b[3] + r; }
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
    if (eraserMode === 'part') {
      if (erasePart(page, cx, cy, r)) changed = true;
      continue;
    }
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

// ---------- Teil-Radierer ----------
// Löscht nur das Stück eines Strichs, das unter dem Radierer liegt – der Rest bleibt als
// eigene Striche stehen. Textfelder, Bilder und Formeln lässt er in Ruhe.
let eraserMode = store.get('eraserMode', 'stroke');   // 'stroke' = ganzer Strich, 'part' = Teil

function splitStroke(s, cx, cy, r) {
  const p = s.pts, pts = [];
  for (let i = 0; i < p.length; i += 3) {
    if (i) {
      // Abschnitte nahe am Radierer fein unterteilen, damit der Schnitt sauber sitzt
      const ax = p[i - 3], ay = p[i - 2], bx = p[i], by = p[i + 1];
      if (distToSegment(cx, cy, ax, ay, bx, by) <= r * 1.5) {
        const n = Math.floor(Math.hypot(bx - ax, by - ay) / (r / 4));
        for (let k = 1; k < n; k++) {
          const f = k / n;
          pts.push([ax + (bx - ax) * f, ay + (by - ay) * f, p[i - 1] + (p[i + 2] - p[i - 1]) * f]);
        }
      }
    }
    pts.push([p[i], p[i + 1], p[i + 2]]);
  }
  const pieces = [];
  let cur = [], cut = false;
  for (const q of pts) {
    if (Math.hypot(q[0] - cx, q[1] - cy) <= r) {
      cut = true;
      if (cur.length) pieces.push(cur);
      cur = [];
    } else cur.push(q);
  }
  if (cur.length) pieces.push(cur);
  if (!cut) return null;
  return pieces
    .filter((pc) => pc.length >= 2 && Math.hypot(pc[0][0] - pc[pc.length - 1][0], pc[0][1] - pc[pc.length - 1][1]) + pc.length > 3)
    .map((pc) => ({ ...s, pts: pc.flatMap((q) => [Math.round(q[0] * 10) / 10, Math.round(q[1] * 10) / 10, q[2]]) }));
}

function erasePart(page, cx, cy, r) {
  let changed = false;
  const next = [];
  for (const s of page.strokes) {
    if ((s.tool === 'pen' || s.tool === 'marker') && strokeHit(s, cx, cy, r)) {
      const parts = splitStroke(s, cx, cy, r + strokeWidth(s) / 2);
      if (parts) { next.push(...parts); changed = true; continue; }
    }
    next.push(s);
  }
  if (changed) page.strokes = next;
  return changed;
}

// ---------- Formen erkennen (wie in Goodnotes: am Ende kurz stillhalten) ----------
let HOLD_MS = store.get('holdMs', 550);
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
let editor = null;   // { ed, handle, bar, page, t, before, existing }

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
  textAction = { id: e.pointerId, touch: e.pointerType === 'touch', page: i, rect, x0: x, y0: y, cx: e.clientX, cy: e.clientY, sx: e.clientX, sy: e.clientY,
    k: textAt(i, x, y), moved: false, noCreate: hadEditor, t0: performance.now(), st: pagesBox.scrollTop, sl: pagesBox.scrollLeft };
  textSkip = 0;
}

function textMove(e) {
  const a = textAction;
  const x = ((e.clientX - a.rect.left) / a.rect.width) * PAGE_W;
  const y = ((e.clientY - a.rect.top) / a.rect.height) * PAGE_H;
  if (!a.moved && Math.hypot(e.clientX - a.sx, e.clientY - a.sy) < (a.touch ? 14 : 8)) return;
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
  if (e.type === 'pointercancel') {
    // Safari auf dem iPad bricht kurze Tipper oft ab, statt sie normal zu beenden.
    // Nur wenn wirklich gescrollt wurde, ist es kein Antippen.
    const scrolled = Math.abs(pagesBox.scrollTop - a.st) > 3 || Math.abs(pagesBox.scrollLeft - a.sl) > 3;
    if (scrolled || a.moved || performance.now() - a.t0 > 800) { textSkip = performance.now(); return; }
  }
  if (a.moved) {
    if (a.k >= 0) {
      pushHistory([{ page: a.page, before: a.before, after: note.pages[a.page].strokes.slice() }]);
      saveNote();
    }
    textSkip = performance.now();
    return;
  }
  if (a.noCreate && a.k < 0) { textSkip = performance.now(); return; }
  openEditor(a.page, a.k, a.x0, a.y0);
}
let textSkip = 0;    // Zeitpunkt, an dem ein Tipper bewusst kein Feld geöffnet hat

// Safari auf dem iPad schickt nach dem Absetzen noch Maus-Ereignisse und evtl. einen click.
// Die können dem gerade geöffneten Feld den Fokus nehmen – kurz danach holen wir ihn zurück.
// Im click selbst darf das iPad die Tastatur zeigen, deshalb dort noch einmal fokussieren.
const EDITOR_GRACE = 900;
function focusEditor() {
  if (!editor) return;
  const ed = editor.ed;
  if (document.activeElement === ed) return;
  ed.focus();
  const r = document.createRange();
  r.selectNodeContents(ed);
  r.collapse(false);
  const s = getSelection();
  s.removeAllRanges();
  s.addRange(r);
}
$('#pages').addEventListener('click', (e) => {
  if (editor) {
    if (performance.now() - editor.openedAt < EDITOR_GRACE) focusEditor();
    return;
  }
  // Letztes Sicherheitsnetz: Hat das iPad die Stift-/Finger-Ereignisse verschluckt,
  // kommt wenigstens der click an – dann das Feld hier öffnen.
  const canvas = e.target.closest && e.target.closest('.page-live');
  if (!canvas || window.noteTool !== 'text' || textAction || performance.now() - textSkip < 700) return;
  const r = canvas.getBoundingClientRect(), i = Number(canvas.dataset.page);
  const x = ((e.clientX - r.left) / r.width) * PAGE_W, y = ((e.clientY - r.top) / r.height) * PAGE_H;
  openEditor(i, textAt(i, x, y), x, y);
}, true);

// Editor: formatierbares Feld (contenteditable) + Format-Leiste oben über den Seiten
const TEXT_STEPS = [14, 18, 24, 30, 36, 48, 60];
const TEXT_COLORS = PEN_COLORS.concat(['#ea580c', '#8e8e93']);
const ALIGNS = ['left', 'center', 'right'];
let textSpell = store.get('textSpell', true);
let textReplace = store.get('textReplace', true);   // Schnell-Ersetzen (-> → , ^2 ² …)
let rulerSnap = store.get('rulerSnap', true);
let barTouch = 0;

// Schnell-Ersetzen beim Tippen
const SUP = '⁰¹²³⁴⁵⁶⁷⁸⁹', SUB = '₀₁₂₃₄₅₆₇₈₉';
const REPLACE = [
  ['<->', '↔'], ['←>', '↔'], ['->', '→'], ['<-', '←'], ['=>', '⇒'], ['<=', '≤'], ['>=', '≥'], ['!=', '≠'], ['+-', '±'],
  ['~=', '≈'], ['\\sqrt', '√'], ['\\pi', 'π'], ['\\alpha', 'α'], ['\\beta', 'β'], ['\\gamma', 'γ'], ['\\delta', 'δ'],
  ['\\Delta', 'Δ'], ['\\lambda', 'λ'], ['\\mu', 'μ'], ['\\omega', 'ω'], ['\\Omega', 'Ω'], ['\\phi', 'φ'], ['\\sigma', 'σ'],
  ['\\inf', '∞'], ['\\deg', '°'], ['\\cdot', '·'], ['\\times', '×'], ['\\div', '÷'], ['\\in', '∈'], ['\\sum', 'Σ']
];
for (let d = 0; d <= 9; d++) REPLACE.push(['^' + d, SUP[d]], ['_' + d, SUB[d]]);

const rgbHex = (rgb) => {
  const m = rgb.match(/\d+/g);
  return m ? '#' + m.slice(0, 3).map((v) => (+v).toString(16).padStart(2, '0')).join('') : rgb;
};

function parasToHtml(t) {
  return textParas(t).map((p) => {
    const inner = p.spans.map((sp) => {
      let h = escXml(sp.t);
      if (sp.b) h = `<b>${h}</b>`;
      if (sp.i) h = `<i>${h}</i>`;
      if (sp.u) h = `<u>${h}</u>`;
      if (sp.c && sp.c !== t.color) h = `<font color="${sp.c}">${h}</font>`;
      return h;
    }).join('');
    return `<div${p.list ? ` data-list="${p.list}"` : ''}${p.h ? ' data-h="1"' : ''}${p.align ? ` style="text-align:${p.align}"` : ''}>${inner || '<br>'}</div>`;
  }).join('');
}

// HTML des Editors → Absätze
function editorParas(root, t) {
  const paras = [];
  let cur = null;
  const isBlock = (n) => /^(DIV|P|LI|H[1-6]|UL|OL|BLOCKQUOTE)$/.test(n.nodeName);
  const newPara = (blk) => {
    cur = { spans: [] };
    if (blk && blk !== root) {
      if (blk.dataset.list) cur.list = blk.dataset.list;
      if (blk.dataset.h) cur.h = true;
      const al = blk.style.textAlign;
      if (al === 'center' || al === 'right') cur.align = al;
    }
    paras.push(cur);
  };
  const addText = (node, blk) => {
    const text = node.data.replace(/ /g, ' ').replace(/[​﻿]/g, '');
    if (!text) return;
    if (!cur) newPara(blk);
    const el = node.parentElement, cs = getComputedStyle(el);
    let u = false;
    for (let e = el; e && e !== root; e = e.parentElement) {
      if (e.nodeName === 'U' || /underline/.test(e.style.textDecoration + ' ' + e.style.textDecorationLine)) { u = true; break; }
    }
    const sp = { t: text };
    if (!cur.h && (parseInt(cs.fontWeight, 10) >= 600 || cs.fontWeight === 'bold')) sp.b = true;
    if (cs.fontStyle === 'italic' || cs.fontStyle === 'oblique') sp.i = true;
    if (u) sp.u = true;
    const c = rgbHex(cs.color);
    if (c !== t.color) sp.c = c;
    const last = cur.spans[cur.spans.length - 1];
    if (last && !!last.b === !!sp.b && !!last.i === !!sp.i && !!last.u === !!sp.u && last.c === sp.c) last.t += text;
    else cur.spans.push(sp);
  };
  const walk = (node, blk) => {
    for (const ch of node.childNodes) {
      if (ch.nodeType === 3) addText(ch, blk);
      else if (ch.nodeName === 'BR') { if (!cur) newPara(blk); cur = null; }
      else if (ch.nodeType === 1 && isBlock(ch)) {
        cur = null;
        const before = paras.length;
        walk(ch, ch);
        if (paras.length === before) newPara(ch);
        cur = null;
      } else if (ch.nodeType === 1) walk(ch, blk);
    }
  };
  walk(root, root);
  // leere Absätze am Ende weglassen
  while (paras.length && !paras[paras.length - 1].spans.length && !paras[paras.length - 1].list) paras.pop();
  return paras;
}

const parasText = (paras) => paras.map((p) => p.spans.map((s) => s.t).join('')).join('\n');

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
  t = { ...t };                       // Arbeitskopie (Größe, Breite, Hintergrund ändern sich live)
  const wrap = pageEls[i].wrap;
  const ed = document.createElement('div');
  ed.className = 'text-editor';
  ed.contentEditable = 'true';
  ed.spellcheck = textSpell;
  ed.lang = 'de';
  ed.setAttribute('autocapitalize', 'sentences');
  ed.innerHTML = t.text || t.paras ? parasToHtml(t) : '<div><br></div>';
  const handle = document.createElement('i');
  handle.className = 'te-handle';
  handle.title = 'Breite ändern';
  wrap.append(ed, handle);
  editor = { ed, handle, bar: null, page: i, t, before, existing: k >= 0, openedAt: performance.now(), orig: JSON.stringify([t.paras || t.text, t.size, t.w, t.bg, t.border]) };
  styleEditor();
  try { document.execCommand('defaultParagraphSeparator', false, 'div'); document.execCommand('styleWithCSS', false, false); } catch {}
  ed.addEventListener('blur', () => setTimeout(() => {
    if (!editor || editor.ed !== ed || document.activeElement === ed) return;
    const to = document.activeElement;
    const nowhere = !to || to === document.body;
    if (nowhere && performance.now() - editor.openedAt < EDITOR_GRACE) return focusEditor();   // iPad: Fokus kurz nach dem Öffnen verloren
    if (nowhere && performance.now() - barTouch < 800) return ed.focus();   // Knopf in der Format-Leiste
    commitEditor();
  }, 0));
  ed.addEventListener('keydown', editorKey);
  ed.addEventListener('input', editorInput);
  ed.addEventListener('paste', (ev) => {
    const text = ev.clipboardData && ev.clipboardData.getData('text/plain');
    if (ev.clipboardData && [...ev.clipboardData.files].some((f) => f.type.startsWith('image/'))) return;
    if (text) { ev.preventDefault(); document.execCommand('insertText', false, text); }
  });
  handle.addEventListener('pointerdown', widthDown);
  editor.bar = buildTextBar();
  ed.focus();
  const r = document.createRange();
  r.selectNodeContents(ed);
  r.collapse(false);
  const s = getSelection();
  s.removeAllRanges();
  s.addRange(r);
}

function styleEditor() {
  const { ed, handle, t } = editor;
  const px = pageEls[editor.page].wrap.clientWidth / PAGE_W;
  Object.assign(ed.style, {
    left: (t.x / PAGE_W) * 100 + '%',
    top: (t.y / PAGE_H) * 100 + '%',
    width: (t.w / PAGE_W) * 100 + '%',
    fontSize: t.size * px + 'px',
    lineHeight: TEXT_LH,
    color: t.color,
    fontFamily: TEXT_FONT,
    background: t.bg || 'rgba(255, 255, 255, .85)',
    boxShadow: t.border ? `0 0 0 ${TEXT_PAD * px}px ${t.bg || '#fff'}, 0 0 0 ${(TEXT_PAD + 1.5) * px}px ${t.color}` : t.bg ? `0 0 0 ${TEXT_PAD * px}px ${t.bg}` : 'none'
  });
  Object.assign(handle.style, { left: ((t.x + t.w) / PAGE_W) * 100 + '%', top: (t.y / PAGE_H) * 100 + '%' });
}

// Block (Absatz) um einen Knoten
function blockOf(node) {
  const ed = editor.ed;
  while (node && node.parentNode !== ed) node = node.parentNode;
  if (!node) return null;
  if (node.nodeType === 1 && node.nodeName === 'DIV') return node;
  // lose Zeile direkt im Editor: in einen Absatz packen (Cursor bleibt erhalten)
  const s = getSelection(), an = s.anchorNode, ao = s.anchorOffset;
  const div = document.createElement('div');
  let start = node;
  while (start.previousSibling && !(start.previousSibling.nodeName === 'DIV' || start.previousSibling.nodeName === 'BR')) start = start.previousSibling;
  ed.insertBefore(div, start);
  while (div.nextSibling && div.nextSibling.nodeName !== 'DIV') {
    const n = div.nextSibling;
    div.append(n);
    if (n.nodeName === 'BR') break;
  }
  if (an) s.collapse(an, ao);
  return div;
}

function selectedBlocks() {
  const s = getSelection();
  if (!s.rangeCount || !editor.ed.contains(s.anchorNode)) return [];
  const r = s.getRangeAt(0);
  const first = blockOf(r.startContainer === editor.ed ? editor.ed.childNodes[r.startOffset] || editor.ed.lastChild : r.startContainer);
  const out = [];
  for (const b of editor.ed.children) if (b === first || r.intersectsNode(b)) out.push(b);
  return out.length ? out : first ? [first] : [];
}

function editorKey(ev) {
  if (ev.key === 'Escape') return cancelEditor();
  if (ev.key === 'Enter' && !ev.shiftKey) {
    const [b] = selectedBlocks();
    if (b && b.dataset.list && !b.textContent.trim()) {   // leerer Listenpunkt + Enter = Liste beenden
      ev.preventDefault();
      delete b.dataset.list;
      return;
    }
  }
  if ((ev.ctrlKey || ev.metaKey) && !ev.altKey) {
    const k = ev.key.toLowerCase();
    if (k === 'b' || k === 'i' || k === 'u') {
      ev.preventDefault();
      document.execCommand(k === 'b' ? 'bold' : k === 'i' ? 'italic' : 'underline');
      updateTextBar();
    }
  }
}

function editorInput(ev) {
  const s = getSelection();
  if (ev.inputType === 'insertParagraph') {
    const [b] = selectedBlocks();
    if (b) {
      delete b.dataset.h;                       // nach einer Überschrift geht es normal weiter
      const prev = b.previousElementSibling;
      if (prev && prev.dataset.list && !b.dataset.list) b.dataset.list = prev.dataset.list;
    }
  }
  if (ev.inputType !== 'insertText' || !s.isCollapsed) return updateTextBar();
  const node = s.anchorNode, off = s.anchorOffset;
  if (!node || node.nodeType !== 3) return updateTextBar();
  const before = node.data.slice(0, off);
  // Listen: "- " oder "1. " am Absatzanfang
  const [b] = selectedBlocks();
  if (b && !b.dataset.list && b.textContent.startsWith(before)) {
    const m = before.match(/^(?:([-*•])|(\d+)[.)]) $/);
    if (m && b.textContent.startsWith(m[0])) {
      node.data = node.data.slice(m[0].length);
      b.dataset.list = m[1] ? 'bullet' : 'number';
      s.collapse(node, 0);
      return updateTextBar();
    }
  }
  for (const [from, to] of textReplace ? REPLACE : []) {
    if (before.endsWith(from)) {
      node.data = before.slice(0, -from.length) + to + node.data.slice(off);
      s.collapse(node, off - from.length + to.length);
      break;
    }
  }
  updateTextBar();
}

// Breite des Textfelds mit dem Griff rechts ändern
function widthDown(e) {
  e.preventDefault();
  e.stopPropagation();
  const h = editor.handle;
  try { h.setPointerCapture(e.pointerId); } catch {}
  const rect = pageEls[editor.page].svg.getBoundingClientRect();
  const move = (ev) => {
    const x = ((ev.clientX - rect.left) / rect.width) * PAGE_W;
    editor.t.w = clamp(x - editor.t.x, 60, PAGE_W - editor.t.x);
    styleEditor();
  };
  const up = () => {
    h.removeEventListener('pointermove', move);
    h.removeEventListener('pointerup', up);
    h.removeEventListener('pointercancel', up);
    editor && editor.ed.focus();
  };
  h.addEventListener('pointermove', move);
  h.addEventListener('pointerup', up);
  h.addEventListener('pointercancel', up);
}

// Format-Leiste: fest oben über den Seiten, damit sie nie von der Seite abgeschnitten wird
function buildTextBar() {
  const bar = document.createElement('div');
  bar.className = 'text-bar';
  const btn = (act, html, label) => `<button type="button" data-act="${act}" aria-label="${label}" title="${label}">${html}</button>`;
  bar.innerHTML =
    btn('bold', '<b>B</b>', 'Fett (Strg+B)') + btn('italic', '<i>I</i>', 'Kursiv (Strg+I)') + btn('underline', '<u>U</u>', 'Unterstrichen (Strg+U)') +
    '<span class="tb-sep"></span>' +
    TEXT_COLORS.map((c) => `<button type="button" class="tb-color" data-color="${c}" style="--c:${c}" aria-label="Farbe"></button>`).join('') +
    '<span class="tb-sep"></span>' +
    btn('smaller', 'A−', 'Kleiner') + '<span class="tb-size"></span>' + btn('bigger', 'A+', 'Größer') +
    '<span class="tb-sep"></span>' +
    btn('h', 'Ü', 'Überschrift') + btn('bullet', '•≡', 'Aufzählung') + btn('number', '1.≡', 'Nummerierung') + btn('align', '', 'Ausrichtung') +
    '<span class="tb-sep"></span>' +
    btn('bg', '<span class="tb-bg"></span>', 'Hintergrund') + btn('border', '▢', 'Rahmen') + btn('spell', 'ABC', 'Rechtschreibprüfung');
  document.body.append(bar);
  const r = pagesBox.getBoundingClientRect();
  bar.style.top = r.top + 8 + 'px';
  // Knöpfe dürfen den Fokus nicht aus dem Textfeld nehmen
  bar.addEventListener('pointerdown', (e) => { barTouch = performance.now(); e.preventDefault(); });
  bar.addEventListener('mousedown', (e) => e.preventDefault());
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || !editor) return;
    textBarAction(b.dataset.act, b.dataset.color);
  });
  editor.bar = bar;
  updateTextBar();
  return bar;
}

function textBarAction(act, color) {
  const t = editor.t;
  if (color) document.execCommand('foreColor', false, color);
  else if (act === 'bold' || act === 'italic' || act === 'underline') document.execCommand(act);
  else if (act === 'smaller' || act === 'bigger') {
    const i = TEXT_STEPS.findIndex((v) => v >= t.size - 0.5);
    const cur = i < 0 ? TEXT_STEPS.length - 1 : i;
    t.size = TEXT_STEPS[clamp(cur + (act === 'bigger' ? 1 : -1), 0, TEXT_STEPS.length - 1)];
    styleEditor();
  } else if (act === 'h' || act === 'bullet' || act === 'number') {
    const blocks = selectedBlocks();
    if (act === 'h') {
      const on = !blocks.every((b) => b.dataset.h);
      blocks.forEach((b) => (on ? (b.dataset.h = '1') : delete b.dataset.h));
    } else {
      const on = !blocks.every((b) => b.dataset.list === act);
      blocks.forEach((b) => (on ? (b.dataset.list = act) : delete b.dataset.list));
    }
  } else if (act === 'align') {
    const blocks = selectedBlocks();
    const cur = (blocks[0] && blocks[0].style.textAlign) || 'left';
    const next = ALIGNS[(ALIGNS.indexOf(cur) + 1) % 3];
    blocks.forEach((b) => (b.style.textAlign = next === 'left' ? '' : next));
  } else if (act === 'bg') {
    t.bg = TEXT_BGS[(TEXT_BGS.indexOf(t.bg || null) + 1) % TEXT_BGS.length] || undefined;
    styleEditor();
  } else if (act === 'border') {
    t.border = !t.border || undefined;
    styleEditor();
  } else if (act === 'spell') {
    textSpell = !textSpell;
    store.set('textSpell', textSpell);
    editor.ed.spellcheck = textSpell;
    // Browser zeigen die Änderung erst nach erneutem Fokussieren
    editor.ed.blur();
    editor.ed.focus();
  }
  editor.ed.focus();
  updateTextBar();
}

function updateTextBar() {
  if (!editor || !editor.bar) return;
  const bar = editor.bar, t = editor.t;
  const q = (c) => { try { return document.queryCommandState(c); } catch { return false; } };
  bar.querySelector('[data-act="bold"]').classList.toggle('on', q('bold'));
  bar.querySelector('[data-act="italic"]').classList.toggle('on', q('italic'));
  bar.querySelector('[data-act="underline"]').classList.toggle('on', q('underline'));
  const blocks = selectedBlocks();
  const b0 = blocks[0];
  bar.querySelector('[data-act="h"]').classList.toggle('on', !!b0 && !!b0.dataset.h);
  bar.querySelector('[data-act="bullet"]').classList.toggle('on', !!b0 && b0.dataset.list === 'bullet');
  bar.querySelector('[data-act="number"]').classList.toggle('on', !!b0 && b0.dataset.list === 'number');
  const al = (b0 && b0.style.textAlign) || 'left';
  bar.querySelector('[data-act="align"]').innerHTML = { left: '⇤', center: '↔', right: '⇥' }[al] || '⇤';
  bar.querySelector('.tb-size').textContent = Math.round(t.size);
  bar.querySelector('.tb-bg').style.background = t.bg || 'transparent';
  bar.querySelector('[data-act="border"]').classList.toggle('on', !!t.border);
  bar.querySelector('[data-act="spell"]').classList.toggle('on', textSpell);
  let col = t.color;
  try { col = rgbHex(document.queryCommandValue('foreColor')) || t.color; } catch {}
  bar.querySelectorAll('.tb-color').forEach((x) => x.classList.toggle('on', x.dataset.color === col));
}
document.addEventListener('selectionchange', () => { if (editor) updateTextBar(); });

function closeEditorUi() {
  editor.ed.remove();
  editor.handle.remove();
  if (editor.bar) editor.bar.remove();
}

function commitEditor() {
  if (!editor) return;
  const { ed, page, t, before, existing, orig } = editor;
  const paras = editorParas(ed, t);
  closeEditorUi();
  editor = null;
  const text = parasText(paras);
  const item = { ...t, paras, text };
  if (existing && JSON.stringify([paras, t.size, t.w, t.bg, t.border]) === orig) {   // nichts geändert
    note.pages[page].strokes = before;
    drawPage(page);
    return;
  }
  const empty = !text.trim() && !paras.some((p) => p.list);
  if (!empty) note.pages[page].strokes.push(item);
  drawPage(page);
  if (existing || !empty) {
    pushHistory([{ page, before, after: note.pages[page].strokes.slice() }]);
    saveNote();
  }
}

function cancelEditor() {
  if (!editor) return;
  const { page, before } = editor;
  closeEditorUi();
  editor = null;
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
// Handballen-Erkennung: [Sperrzeit nach dem Stift in ms, Auflagefläche ab der es eine Hand ist]
const PALM_LEVELS = { off: [0, 9999], normal: [700, 45], strong: [1200, 30] };
let [PALM_MS, PALM_SIZE] = PALM_LEVELS[store.get('palm', 'normal')] || PALM_LEVELS.normal;
const penNear = () => (active && active.pointerType === 'pen') || performance.now() - lastPenTime < PALM_MS;
const isPalm = (e) => e.width > PALM_SIZE || e.height > PALM_SIZE;
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
    if (page.strokes.length !== active.before.length || page.strokes.some((s, i) => s !== active.before[i])) {
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
  snClosePop();
  if (!(e.pointerType === 'touch' && (penNear() || isPalm(e)))) snTapDown(e, canvas);   // evtl. Antippen einer Side Note
  // Tippen neben ein ausgewähltes Bild hebt die Auswahl auf
  if (sel && !(e.pointerType === 'touch' && penNear())) deselectImage();
  if (window.noteTool === 'select' && !active && !(e.pointerType === 'touch' && (penNear() || isPalm(e)))) {
    const r = canvas.getBoundingClientRect(), i = Number(canvas.dataset.page);
    const k = itemAt(i, ((e.clientX - r.left) / r.width) * PAGE_W, ((e.clientY - r.top) / r.height) * PAGE_H);
    if (k >= 0) {
      selectImage(i, note.pages[i].strokes[k]);
      selDown(e);              // gleich weiterziehen können
      return;
    }
    if (e.pointerType !== 'touch') return;   // Stift/Maus ins Leere: nichts tun
  }

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
    if (window.noteTool === 'math' && touches.size === 1 && !active) return mathDown(e, canvas);
    if (window.noteTool === 'snote' && touches.size === 1 && !active && fingerDraw) return snDown(e, canvas);
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
  if (tool === 'select') return;
  if (tool === 'lasso') return lassoDown(e, canvas);
  if (tool === 'coord') return coordDown(e, canvas);
  if (tool === 'math') return mathDown(e, canvas);
  if (tool === 'snote') return snDown(e, canvas);

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
  if (tool !== 'eraser') active.edge = rulerEdge(e.clientX, e.clientY);
  const [x, y, p] = pagePoint(e);
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
    const joined = active.edge ? null : tryJoin(i, x, y);
    if (joined) {
      // am alten Strich weiterschreiben; die Lücke wird gerade verbunden
      active.stroke = joined.stroke;
      active.joinBefore = joined.before;
      active.stroke.pts.push(Math.round(x * 10) / 10, Math.round(y * 10) / 10, active.stroke.pts[active.stroke.pts.length - 1]);
      active.pressure = active.stroke.pts[active.stroke.pts.length - 1];
    } else {
      active.stroke = { tool: active.strokeTool, color: active.color, size, pts: [x, y, p] };
      if (tool === 'ball') active.stroke.style = 'ball';
      if (active.edge) active.stroke.shape = true;     // am Lineal: exakt gerade, nicht glätten
      active.pressure = p;
    }
    lastEnd = null;
    const live = pageEls[i].live;
    active.live = live;
    active.liveDots = pageEls[i].liveDots;
    active.liveDots.setAttribute('fill', active.stroke.color);
    // Aussehen des Live-Pfads passend zum Werkzeug
    for (const a of ['fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'style', 'stroke-dasharray']) live.removeAttribute(a);
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
  if (snTap) snTapMove(e);
  if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
    const t = touches.get(e.pointerId);
    t.x = e.clientX;
    t.y = e.clientY;
    if (pan && (touches.size >= 2 || (!fingerDraw && !IS_IOS))) {
      const c = avgTouch();
      if (pinch && touches.size >= 2) {
        const r = pagesBox.getBoundingClientRect();
        zoomPreview(pinch.zoom * touchDist() / pinch.dist, c.x - r.left, c.y - r.top);
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
  if (lasso && e.pointerId === lasso.id) return lassoMove(e);
  if (coordAction && e.pointerId === coordAction.id) return coordMove(e);
  if (snAction && e.pointerId === snAction.id) return snMove(e);
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
    const [x, y, p] = pagePoint(ev);
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
  if (snTap && snTapUp(e)) {
    if (e.pointerType === 'touch') { touches.delete(e.pointerId); if (!touches.size) pan = null; }
    return;
  }
  if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
    const wasPanning = pan && !fingerDraw && !IS_IOS && touches.size === 1;
    touches.delete(e.pointerId);
    if (pinch) endZoomPreview();
    pinch = null;
    if (wasPanning && e.type === 'pointerup' && performance.now() - pan.t < 80) startInertia(pan.vx, pan.vy);
    // bleibt ein Finger liegen, scrollt er weiter – ohne Sprung
    pan = touches.size && (touches.size >= 2 || (!fingerDraw && !IS_IOS)) ? { ...avgTouch(), vx: 0, vy: 0, t: performance.now() } : null;
  }
  if (textAction && e.pointerId === textAction.id) return textUp(e);
  if (lasso && e.pointerId === lasso.id) return lassoUp(e);
  if (coordAction && e.pointerId === coordAction.id) return coordUp(e);
  if (mathTap && e.pointerId === mathTap.id) return mathUp(e);
  if (snAction && e.pointerId === snAction.id) return snUp(e);
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

// Breite der Seiten aus Zoom und Side-Notes-Spalte – an genau einer Stelle
function applyZoomLayout() {
  pagesInner.style.width = zoom * 100 + '%';
  pagesInner.style.maxWidth = 900 * zoom + (pagesInner.classList.contains('sn-cols') ? 300 : 0) + 'px';
}

// Punkt (cx, cy im Seitenbereich) → welche Seite, wo auf ihr (0…1). Abstände zwischen den
// Seiten wachsen beim Zoomen nicht mit – deshalb wird an der Seite selbst festgehalten.
function zoomAnchor(cx, cy) {
  const box = pagesBox.getBoundingClientRect(), y = box.top + cy, x = box.left + cx;
  let best = null, bestD = Infinity;
  pageEls.forEach((pe, i) => {
    const r = pe.wrap.getBoundingClientRect();
    const d = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    if (d < bestD) { bestD = d; best = { i, fx: (x - r.left) / r.width, fy: (y - r.top) / r.height }; }
  });
  return best;
}

function setZoom(z, cx, cy) {
  endZoomPreview(false);
  z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  if (Math.abs(z - zoom) < 0.001) return;
  // Punkt unter den Fingern (cx, cy) soll beim Zoomen an derselben Stelle bleiben
  if (cx == null) { cx = pagesBox.clientWidth / 2; cy = pagesBox.clientHeight / 2; }
  const anchor = zoomAnchor(cx, cy);
  zoom = z;
  applyZoomLayout();
  if (anchor) {
    const box = pagesBox.getBoundingClientRect(), r = pageEls[anchor.i].wrap.getBoundingClientRect();
    pagesBox.scrollLeft += r.left - box.left + anchor.fx * r.width - cx;
    pagesBox.scrollTop += r.top - box.top + anchor.fy * r.height - cy;
  }
  $('#zoom-label').textContent = Math.round(zoom * 100) + '%';
  if (typeof ruler !== 'undefined' && ruler) requestAnimationFrame(renderRuler);
  requestAnimationFrame(snRenderColumns);
}

// Während einer Geste (Pinch, Strg+Rad) nur die Ansicht skalieren – das ist schnell, auch bei
// vielen Seiten. Erst am Ende wird die echte Größe gesetzt (einmal neu aufbauen).
let zoomPrev = null;   // { z, ox, oy } – Ursprung in Inhalts-Koordinaten
// Lage des Seiten-Inhalts im scrollbaren Bereich (ohne Skalierung)
function innerOffset() {
  const a = pagesInner.getBoundingClientRect(), b = pagesBox.getBoundingClientRect();
  return [a.left - b.left + pagesBox.scrollLeft, a.top - b.top + pagesBox.scrollTop];
}
function zoomPreview(z, cx, cy) {
  z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  if (!zoomPrev) {
    const [il, it] = innerOffset();
    const ox = pagesBox.scrollLeft + cx - il, oy = pagesBox.scrollTop + cy - it;
    zoomPrev = { ox, oy };
    pagesInner.style.transformOrigin = `${ox}px ${oy}px`;
    pagesInner.style.willChange = 'transform';
    if (fastInk) clearFastInk();
  }
  zoomPrev.z = z;
  pagesInner.style.transform = `scale(${z / zoom})`;
  $('#zoom-label').textContent = Math.round(z * 100) + '%';
}
function endZoomPreview(commit = true) {
  const p = zoomPrev;
  if (!p) return;
  zoomPrev = null;
  pagesInner.style.transform = '';
  pagesInner.style.willChange = '';
  if (!commit || p.z == null) return;
  // Der Ursprung blieb während der Geste an seiner Bildschirmstelle → dort festhalten
  const [il, it] = innerOffset();
  setZoom(p.z, p.ox + il - pagesBox.scrollLeft, p.oy + it - pagesBox.scrollTop);
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
  zoomPreview(gestureStart * e.scale, e.clientX - r.left, e.clientY - r.top);
});
pagesBox.addEventListener('gestureend', (e) => { e.preventDefault(); gestureStart = null; endZoomPreview(); });

// Trackpad / Strg + Mausrad (am Computer)
pagesBox.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  const r = pagesBox.getBoundingClientRect();
  zoomPreview((zoomPrev ? zoomPrev.z : zoom) * Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
  clearTimeout(wheelZoomTimer);
  wheelZoomTimer = setTimeout(endZoomPreview, 160);
}, { passive: false });
let wheelZoomTimer = 0;

$('#zoom-in').addEventListener('click', () => setZoom(zoom * 1.25));
$('#zoom-out').addEventListener('click', () => setZoom(zoom / 1.25));
$('#zoom-label').addEventListener('click', () => setZoom(1));

// ---------- Werkzeugleiste ----------
function renderColors() {
  const g = $('#color-group');
  g.innerHTML = '';
  // Beim Radierer nur unsichtbar machen – sonst ändert sich die Höhe der Leiste und die Seite springt
  g.classList.remove('invisible');
  if (typeof penFavs !== 'undefined') renderFavs();
  if (tool === 'snote') return renderSnBar(g);
  if (tool === 'eraser') {
    // Beim Radierer: Auswahl ganzer Strich / Teil (gleiche Höhe wie die Farben)
    [['stroke', 'Ganzer Strich'], ['part', 'Teil']].forEach(([m, label]) => {
      const b = document.createElement('button');
      b.className = 'tool erase-mode' + (eraserMode === m ? ' active' : '');
      b.textContent = label;
      b.addEventListener('click', () => {
        eraserMode = m;
        store.set('eraserMode', m);
        renderColors();
      });
      g.append(b);
    });
    return;
  }
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
    if (!['snote', 'lasso', 'select'].includes(tool) && snAddTo) snStopAdd();   // Lasso/Auswahl: weitere Stellen wählen
    if (tool !== 'eraser') store.set('noteTool', tool);
    document.body.dataset.noteTool = tool;
    document.querySelectorAll('[data-tool]').forEach((x) => x.classList.toggle('active', x === b));
    renderColors();
  })
);

function renderSize() {
  document.querySelectorAll('[data-size]').forEach((b) => b.classList.toggle('active', Number(b.dataset.size) === size));
  if (typeof penFavs !== 'undefined') renderFavs();
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
  pagesChange(() => note.pages.push({ strokes: [] }));
  pageEls[pageEls.length - 1].wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

// Auf dem iPad wandelt "Scribble" Pencil-Schrift in Text für das nächste Eingabefeld um –
// Tippen auf die Werkzeugleiste landete so im Titel. Der Titel ist deshalb nur bearbeitbar,
// nachdem man ihn bewusst antippt.
const titleEl = $('#note-title');
titleEl.readOnly = true;
titleEl.addEventListener('click', () => {
  if (!titleEl.readOnly) return;
  titleEl.readOnly = false;
  titleEl.focus();
  titleEl.select();
});
titleEl.addEventListener('blur', () => { titleEl.readOnly = true; });
titleEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') titleEl.blur(); });

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
  closePageOverview();
  if (snAddTo) snStopAdd();
  closeSnPanel();
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

async function createNote(folder) {
  const n = newNote();
  if (folder) n.folder = folder;
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
  notesCache = all;
  if (folderFilter !== 'all' && !folders.some((f) => f.id === folderFilter)) folderFilter = 'all';
  renderNotesList();
  if (!$('#notes-dialog').open) $('#notes-dialog').showModal();
}

// ---------- Ordner ----------
// Ordner stehen in localStorage (noteFolders: [{ id, name }]), jede Notiz merkt sich ihren Ordner (note.folder).
let folders = store.get('noteFolders', []);
let folderFilter = store.get('notesFolder', 'all');
let notesCache = [];
const saveFolders = () => store.set('noteFolders', folders);
const folderName = (id) => (folders.find((f) => f.id === id) || {}).name;
const FOLDER_ICON = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>';

function renderNotesList() {
  // Ordner-Leiste
  const chips = $('#folder-chips');
  chips.innerHTML = '';
  const chip = (id, label, count) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip' + (folderFilter === id ? ' active' : '');
    b.textContent = count == null ? label : `${label} ${count}`;
    b.addEventListener('click', () => {
      folderFilter = id;
      store.set('notesFolder', id);
      renderNotesList();
    });
    chips.append(b);
  };
  chip('all', 'Alle', notesCache.length);
  folders.forEach((f) => chip(f.id, f.name, notesCache.filter((n) => n.folder === f.id).length));
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'chip add';
  add.textContent = '＋ Ordner';
  add.addEventListener('click', () => {
    const f = newFolder();
    if (f) { folderFilter = f.id; store.set('notesFolder', f.id); renderNotesList(); }
  });
  chips.append(add);
  $('#folder-tools').hidden = folderFilter === 'all';

  // Notizen (gefiltert nach Ordner und Suche)
  const q = $('#notes-search').value.trim().toLowerCase();
  const shown = notesCache.filter((n) => (folderFilter === 'all' || n.folder === folderFilter) && (!q || noteName(n).toLowerCase().includes(q)));
  const list = $('#notes-list');
  list.innerHTML = '';
  if (!shown.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = q ? 'Nichts gefunden' : folderFilter === 'all' ? 'Noch keine Notizen' : 'Dieser Ordner ist leer';
    list.append(li);
  }
  shown.forEach((n) => {
    const li = document.createElement('li');
    li.className = 'note-item' + (n.id === note.id ? ' current' : '');
    const text = document.createElement('div');
    text.className = 'note-item-text';
    const title = document.createElement('span');
    title.className = 'todo-text';
    title.textContent = noteName(n);
    const meta = document.createElement('span');
    meta.className = 'muted small-text';
    const date = new Date(n.updated).toLocaleDateString('de-DE', { day: 'numeric', month: 'short' });
    const fname = folderName(n.folder);
    meta.textContent = `${n.pages.length} S. · ${date}` + (fname && folderFilter === 'all' ? ` · ${fname}` : '');
    text.append(title, meta);
    const move = document.createElement('button');
    move.type = 'button';
    move.className = 'tool note-folder-btn';
    move.setAttribute('aria-label', 'In Ordner verschieben');
    move.innerHTML = FOLDER_ICON;
    move.addEventListener('click', (e) => { e.stopPropagation(); pickFolder(n); });
    li.append(text, move);
    li.addEventListener('click', () => {
      $('#notes-dialog').close();
      if (n.id !== note.id) openNote(n);
    });
    list.append(li);
  });
}

function newFolder() {
  const name = (prompt('Name des Ordners (z. B. Mathe):') || '').trim().slice(0, 30);
  if (!name) return null;
  const f = { id: 'f' + Date.now().toString(36), name };
  folders.push(f);
  saveFolders();
  return f;
}

async function setNoteFolder(n, id) {
  n.folder = id || undefined;
  if (n.id === note.id) {
    note.folder = n.folder;
    saveNote();
  } else {
    await noteDb.put(n).catch(() => {});
  }
}

// Kleiner Dialog: Ordner für eine Notiz wählen
function pickFolder(n) {
  const box = $('#folder-pick');
  box.innerHTML = '';
  const item = (id, label) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'menu-item' + ((n.folder || '') === id ? ' active' : '');
    b.textContent = label;
    b.addEventListener('click', async () => {
      let target = id;
      if (id === '+') {
        const f = newFolder();
        if (!f) return;
        target = f.id;
      }
      await setNoteFolder(n, target);
      $('#folder-dialog').close();
      if ($('#notes-dialog').open) renderNotesList();
      toast(target ? `In „${folderName(target)}“ verschoben` : 'Aus dem Ordner genommen');
    });
    box.append(b);
  };
  item('', 'Kein Ordner');
  folders.forEach((f) => item(f.id, f.name));
  item('+', '＋ Neuer Ordner …');
  $('#folder-dialog-title').textContent = `„${noteName(n)}“ verschieben`;
  $('#folder-dialog').showModal();
}

$('#notes-search').addEventListener('input', renderNotesList);
$('#folder-rename').addEventListener('click', () => {
  const f = folders.find((x) => x.id === folderFilter);
  if (!f) return;
  const name = (prompt('Neuer Name:', f.name) || '').trim().slice(0, 30);
  if (!name) return;
  f.name = name;
  saveFolders();
  renderNotesList();
});
$('#folder-delete').addEventListener('click', async () => {
  const f = folders.find((x) => x.id === folderFilter);
  if (!f || !confirm(`Ordner „${f.name}“ löschen? Die Notizen darin bleiben erhalten.`)) return;
  folders = folders.filter((x) => x !== f);
  saveFolders();
  for (const n of notesCache.filter((x) => x.folder === f.id)) await setNoteFolder(n, null);
  folderFilter = 'all';
  store.set('notesFolder', 'all');
  renderNotesList();
});
$('#note-move-folder').addEventListener('click', () => { $('#more-dialog').close(); pickFolder(note); });

$('#note-list-btn').addEventListener('click', showNotesList);
$('#note-new').addEventListener('click', () => {
  if (isEmpty(note)) return toast('Diese Notiz ist noch leer');
  createNote(note.folder);
});
$('#notes-dialog-new').addEventListener('click', () => {
  $('#notes-dialog').close();
  const folder = folderFilter !== 'all' ? folderFilter : undefined;
  if (!isEmpty(note)) createNote(folder);
  else if (folder) setNoteFolder(note, folder);
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
  if (snPdf !== 'off') pages = snExportPages(pages, false);
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

// Text für PDF: Zeichen der Standard-Schrift (WinAnsi) als Oktalcodes, Inhalt bleibt reines ASCII.
// Alles andere (→, ₂, √, π, Emojis …) kann Helvetica nicht – das kommt als kleines Bild ins PDF.
const WIN_ANSI = { 0x20ac: 128, 0x201a: 130, 0x192: 131, 0x201e: 132, 0x2026: 133, 0x2020: 134, 0x2021: 135, 0x2c6: 136, 0x2030: 137, 0x160: 138, 0x2039: 139, 0x152: 140, 0x17d: 142, 0x2018: 145, 0x2019: 146, 0x201c: 147, 0x201d: 148, 0x2022: 149, 0x2013: 150, 0x2014: 151, 0x2dc: 152, 0x2122: 153, 0x161: 154, 0x203a: 155, 0x153: 156, 0x17e: 158, 0x178: 159 };
const pdfCode = (ch) => {
  const code = ch.codePointAt(0);
  return code >= 32 && code < 127 ? code : code >= 160 && code <= 255 ? code : WIN_ANSI[code] || 0;
};
function pdfText(s) {
  let out = '';
  for (const ch of s) {
    const code = pdfCode(ch);
    if (ch === '\\' || ch === '(' || ch === ')') out += '\\' + ch;
    else if (code >= 32 && code < 127) out += ch;
    else out += '\\' + (code || 63).toString(8);
  }
  return out;
}

// Ein Zeichen als Bild (Farbe + Deckkraft-Maske), damit es im PDF genauso aussieht wie am Bildschirm
const GLYPH_PX = 6;   // Pixel je Seiten-Einheit
function glyphImage(ch, r) {
  const fs = r.fs * GLYPH_PX;
  const w = Math.max(1, Math.ceil(measure(ch, fontOf(r, r.fs)) * GLYPH_PX) + 2), h = Math.ceil(fs * 1.35);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.font = fontOf(r, fs);
  ctx.fillStyle = '#000';
  ctx.fillText(ch, 1, fs * 1.05);
  const px = ctx.getImageData(0, 0, w, h).data;
  const alpha = new Uint8Array(w * h), rgb = new Uint8Array(w * h * 3);
  const col = [1, 3, 5].map((i) => parseInt(r.c.slice(i, i + 2), 16));
  for (let i = 0; i < w * h; i++) {
    alpha[i] = px[i * 4 + 3];
    rgb[i * 3] = col[0]; rgb[i * 3 + 1] = col[1]; rgb[i * 3 + 2] = col[2];
  }
  // Platz auf der Seite: links an der Zeichenposition, Grundlinie bei 1,05 · Größe
  return { w, h, rgb, alpha, uw: w / GLYPH_PX, uh: h / GLYPH_PX, top: fs * 1.05 / GLYPH_PX };
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
  const fonts = ['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique']
    .map((f) => add(`<< /Type /Font /Subtype /Type1 /BaseFont /${f} /Encoding /WinAnsiEncoding >>`));
  const fontRes = fonts.map((f, i) => `/F${i + 1} ${f} 0 R`).join(' ');
  const kids = [];

  pages.forEach((page) => {
    let c = '';
    const xobjs = [];
    const addImage = (data, w, h) => {
      const id = add({ head: `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${data.length} >>`, data });
      xobjs.push(`/Im${xobjs.length + 1} ${id} 0 R`);
      return `/Im${xobjs.length}`;
    };
    if (page.bg) {
      const bg = page.bg;
      const im = addImage(bg.data, bg.w, bg.h);
      // Bild in PDF-Koordinaten (Ursprung unten links)
      c += `q ${num(bg.width * S)} 0 0 ${num(bg.height * S)} ${num(bg.x * S)} ${num(PAGE_H * S - (bg.y + bg.height) * S)} cm ${im} Do Q\n`;
    }
    c += `q\n${S.toFixed(6)} 0 0 ${(-S).toFixed(6)} 0 ${H} cm\n1 J 1 j\n`;
    if (!page.bg && !page.plain) paperLines(paper).forEach(([color, w, cmds]) => {
      c += `${pdfColor(color)} RG ${w} w\n${cmdsToPdf(cmds)}S\n`;
    });
    if (paper === 'dots' && !page.bg && !page.plain) {
      c += `${pdfColor('#b4b4bb')} rg\n`;
      forEachDot((x, y) => { const d = []; circleCmds(d, x, y, 1.4); c += cmdsToPdf(d); });
      c += 'f\n';
    }
    page.strokes.forEach((s) => {
      if (s.tool === 'text' || s.tool === 'math') return;   // Text und Formeln kommen weiter unten
      if (s.tool === 'image') {
        // hier ist die y-Achse schon nach unten gedreht → Bild senkrecht spiegeln
        c += `q ${num(s.w)} 0 0 ${num(-s.h)} ${num(s.x)} ${num(s.y + s.h)} cm ${addImage(s.data, s.pw, s.ph)} Do Q\n`;
        return;
      }
      if (s.tool === 'marker') {
        c += `q /GS1 gs ${pdfColor(s.color)} RG ${num(strokeWidth(s))} w\n${cmdsToPdf(markerCmds(s))}S Q\n`;
      } else {
        const { outline, dots } = penCmds(s);
        c += `${pdfColor(s.color)} rg\n${cmdsToPdf(outline)}f\n`;
        if (dots.length) c += `${cmdsToPdf(dots)}f\n`;
      }
    });
    c += 'Q\n';
    const Y = (y) => num(PAGE_H * S - y * S);      // Seiten-Einheit → PDF (Ursprung unten)
    // Ein Stück Text: normale Zeichen als PDF-Text, andere (→, π, ₂ …) als kleines Bild
    const pdfRun = (r, text, x, y) => {
      const font = '/F' + (1 + (r.b ? 1 : 0) + (r.i ? 2 : 0));
      let buf = '';
      const flush = () => {
        if (!buf) return;
        c += `BT ${font} ${num(r.fs * S)} Tf ${pdfColor(r.c)} rg 1 0 0 1 ${num(x * S)} ${Y(y)} Tm (${pdfText(buf)}) Tj ET\n`;
        x += measure(buf, fontOf(r, r.fs));
        buf = '';
      };
      for (const ch of text) {
        if (pdfCode(ch) || ch === ' ') { buf += ch; continue; }
        flush();
        const g = glyphImage(ch, r);
        const mask = add({ head: `<< /Type /XObject /Subtype /Image /Width ${g.w} /Height ${g.h} /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${g.alpha.length} >>`, data: g.alpha });
        const id = add({ head: `<< /Type /XObject /Subtype /Image /Width ${g.w} /Height ${g.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /SMask ${mask} 0 R /Length ${g.rgb.length} >>`, data: g.rgb });
        xobjs.push(`/Im${xobjs.length + 1} ${id} 0 R`);
        c += `q ${num(g.uw * S)} 0 0 ${num(g.uh * S)} ${num((x - 1 / GLYPH_PX) * S)} ${Y(y - g.top + g.uh)} cm /Im${xobjs.length} Do Q\n`;
        x += measure(ch, fontOf(r, r.fs));
      }
      flush();
    };
    page.strokes.filter((s) => s.tool === 'math').forEach((s) => {
      const m = mathLayout(s), ox = s.x, by = s.y + m.a;
      for (const o of m.ops) {
        if (o.k === 't') pdfRun({ fs: o.fs, i: o.i, c: s.color }, o.s, ox + o.x, by + o.y);
        else {
          let d = '';
          for (let j = 0; j < o.pts.length; j += 2) d += `${num((ox + o.pts[j]) * S)} ${Y(by + o.pts[j + 1])} ${j ? 'l' : 'm'} `;
          c += `q ${pdfColor(s.color)} RG ${num(o.lw * S)} w 1 J 1 j ${d}S Q\n`;
        }
      }
    });
    page.strokes.filter((t) => t.tool === 'text').forEach((t) => {
      if (t.bg || t.border) {
        const b = textBox(t);
        c += `q ${t.bg ? pdfColor(t.bg) + ' rg ' : ''}${t.border ? pdfColor(t.color) + ' RG ' + num(1.5 * S) + ' w ' : ''}${num(b.x * S)} ${Y(b.y + b.h)} ${num(b.w * S)} ${num(b.h * S)} re ${t.bg && t.border ? 'B' : t.bg ? 'f' : 'S'} Q\n`;
      }
      for (const line of layoutText(t).lines) {
        for (const r of line.runs) {
          pdfRun(r, r.text, r.x, line.y);
          if (r.u) c += `${pdfColor(r.c)} rg ${num(r.x * S)} ${Y(line.y + r.fs * 0.18)} ${num(r.w * S)} ${num(r.fs * 0.06 * S)} re f\n`;
        }
      }
    });
    const content = add(`<< /Length ${c.length} >>\nstream\n${c}endstream`);
    const res = xobjs.length ? ` /XObject << ${xobjs.join(' ')} >>` : '';
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 595.28 ${H}] /Resources << /ExtGState << /GS1 ${gs} 0 R >> /Font << ${fontRes} >>${res} >> /Contents ${content} 0 R >>`));
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
  let pages = note.pages.filter((p) => p.strokes.length || p.bg || (p.notes && p.notes.length));
  if (!pages.length) pages = note.pages.slice(0, 1);
  if (snPdf !== 'off') pages = snExportPages(pages, snPdf !== 'marks');
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
  const c = await imageFileToCanvas(file, IMPORT_WIDTH, Infinity);
  return canvasToBg(c);
}

// Bild-Datei auf eine Zeichenfläche bringen (verkleinert, durchsichtige Stellen weiß)
async function imageFileToCanvas(file, maxW, maxH) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const k = Math.min(1, maxW / img.naturalWidth, maxH / img.naturalHeight);
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k);
    c.height = Math.round(img.naturalHeight * k);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';                 // durchsichtige PNGs auf weißem Papier
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// PDF-Seiten als Bilder rendern (höchstens `max` Seiten)
async function pdfPages(file, max) {
  toast('PDF wird geladen …');
  let lib;
  try { lib = await pdfLib(); } catch {
    toast('PDF-Import braucht beim ersten Mal Internet');
    return null;
  }
  const pdf = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const count = Math.min(pdf.numPages, max);
  const pages = [];
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
    pages.push({ strokes: [], bg: await canvasToBg(c) });
  }
  return { pages, total: pdf.numPages };
}

const pagesMsg = (n, total) => (total > n ? `Eingefügt (nur ${n} von ${total} Seiten – mehr passen nicht)` : `${n} ${n === 1 ? 'Seite' : 'Seiten'} eingefügt`);

// PDF als neue Notiz
async function importPdf(file) {
  const r = await pdfPages(file, MAX_IMPORT_PAGES);
  if (!r) return;
  const n = newNote();
  n.title = file.name.replace(/\.pdf$/i, '').slice(0, 40);
  n.paper = 'blank';
  n.folder = note && note.folder;
  n.pages = r.pages;
  await noteDb.put(n);
  await openNote(n);
  toast(pagesMsg(r.pages.length, r.total));
}

// Seiten hinter der gerade sichtbaren Seite einfügen (eine leere Notiz wird ersetzt)
function insertPages(pages, title) {
  const insertBefore = snapPages();
  if (isEmpty(note)) {
    note.pages = pages;
    if (!note.title && title) { note.title = title.slice(0, 40); $('#note-title').value = note.title; }
  } else {
    const at = viewCenter().page + 1;
    note.pages.splice(at, 0, ...pages);
  }
  pushHistory([{ pages: true, before: insertBefore, after: snapPages() }]);
  buildPages();
  saveNote();
  const first = note.pages.indexOf(pages[0]);
  if (pageEls[first]) pageEls[first].wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function insertPdfPages(file) {
  const room = MAX_PAGES - (isEmpty(note) ? 0 : note.pages.length);
  if (room <= 0) return toast('Diese Notiz hat schon die maximale Seitenzahl');
  const r = await pdfPages(file, room);
  if (!r) return;
  insertPages(r.pages, file.name.replace(/\.pdf$/i, ''));
  toast(pagesMsg(r.pages.length, r.total));
}

async function importImage(file) {
  if (!isEmpty(note) && note.pages.length >= MAX_PAGES) return toast('Diese Notiz hat schon die maximale Seitenzahl');
  const bg = await imageFileToBg(file);
  insertPages([{ strokes: [], bg }]);
  toast('Bild als Seite eingefügt');
}

// "Als Seiten einfügen" (in diese Notiz) oder "Als neue Notiz"
let importAsNote = false;
$('#note-import').addEventListener('click', () => { importAsNote = false; $('#import-file').click(); });
$('#note-import-new').addEventListener('click', () => { importAsNote = true; $('#import-file').click(); });
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
      await (importAsNote ? importPdf(file) : insertPdfPages(file));
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

// ---------- Bild als Element einfügen, verschieben, skalieren ----------
// Anders als "Importieren" (Bild wird eine eigene Seite) landet das Bild hier frei auf der
// aktuellen Seite – wie in Goodnotes. Danach ist es ausgewählt: ziehen = verschieben,
// Ecken = größer/kleiner. Später wieder auswählen mit dem Auswahl-Werkzeug.
const ELEMENT_MAX_PX = 1600;
let sel = null;        // { page, items, box }
let selDrag = null;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// Seite und Punkt in der Mitte des sichtbaren Bereichs
function viewCenter() {
  const r = pagesBox.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  let best = 0, bestD = Infinity;
  pageEls.forEach((pe, i) => {
    const b = pe.svg.getBoundingClientRect();
    const d = cy < b.top ? b.top - cy : cy > b.bottom ? cy - b.bottom : 0;
    if (d < bestD) { bestD = d; best = i; }
  });
  const b = pageEls[best].svg.getBoundingClientRect();
  return { page: best, x: clamp(((cx - b.left) / b.width) * PAGE_W, 0, PAGE_W), y: clamp(((cy - b.top) / b.height) * PAGE_H, 0, PAGE_H) };
}

async function insertImageElement(file, at) {
  if (!note) return;
  commitEditor();
  const c = await imageFileToCanvas(file, ELEMENT_MAX_PX, ELEMENT_MAX_PX);
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
  const data = new Uint8Array(await blob.arrayBuffer());
  const pos = at || viewCenter();
  let w = 500, h = (w * c.height) / c.width;
  if (h > 600) { h = 600; w = (h * c.width) / c.height; }
  const s = {
    tool: 'image',
    x: clamp(pos.x - w / 2, 0, PAGE_W - w),
    y: clamp(pos.y - h / 2, 0, PAGE_H - h),
    w, h, data, pw: c.width, ph: c.height
  };
  const page = note.pages[pos.page];
  const before = page.strokes.slice();
  page.strokes.push(s);
  pushHistory([{ page: pos.page, before, after: page.strokes.slice() }]);
  drawPage(pos.page);
  saveNote();
  selectImage(pos.page, s);
}

// ---------- Auswahl (Bilder, Striche, Text) ----------
// Gemeinsam für das Auswahl-Werkzeug (antippen) und das Lasso (einkreisen):
// ziehen = verschieben, Ecken = größer/kleiner, Menü: Löschen, Duplizieren, Farbe.
function itemAt(i, x, y) {
  const list = note.pages[i].strokes;
  for (let k = list.length - 1; k >= 0; k--) {
    const s = list[k];
    if (s.tool === 'image' ? x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h : strokeHit(s, x, y, 6)) return k;
  }
  return -1;
}

function itemBounds(s) {
  if (s.tool === 'image') return [s.x, s.y, s.x + s.w, s.y + s.h];
  if (s.tool === 'text') { const b = textBox(s); return [b.x, b.y, b.x + b.w, b.y + b.h]; }
  if (s.tool === 'math') return mathBounds(s);
  const p = s.pts, r = strokeWidth(s) / 2 + 2;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]);
    y0 = Math.min(y0, p[i + 1]); y1 = Math.max(y1, p[i + 1]);
  }
  return [x0 - r, y0 - r, x1 + r, y1 + r];
}

function selBounds(items) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  items.forEach((s) => {
    const q = itemBounds(s);
    b[0] = Math.min(b[0], q[0]); b[1] = Math.min(b[1], q[1]);
    b[2] = Math.max(b[2], q[2]); b[3] = Math.max(b[3], q[3]);
  });
  return { x: b[0], y: b[1], w: Math.max(1, b[2] - b[0]), h: Math.max(1, b[3] - b[1]) };
}

// Element verschieben/skalieren: Punkt p → n + (p - o) · k
function transformItem(s, k, ox, oy, nx, ny) {
  const tx = (x) => nx + (x - ox) * k, ty = (y) => ny + (y - oy) * k;
  if (s.tool === 'image') return { ...s, x: tx(s.x), y: ty(s.y), w: s.w * k, h: s.h * k };
  if (s.tool === 'text') return { ...s, x: tx(s.x), y: ty(s.y), w: s.w * k, size: s.size * k };
  if (s.tool === 'math') return { ...s, x: tx(s.x), y: ty(s.y), size: s.size * k };
  const p = s.pts.slice();
  for (let i = 0; i < p.length; i += 3) {
    p[i] = Math.round(tx(p[i]) * 10) / 10;
    p[i + 1] = Math.round(ty(p[i + 1]) * 10) / 10;
  }
  return { ...s, pts: p, size: s.size * k };
}

function selectItems(i, items, coord) {
  deselectImage();
  if (!items.length) return;
  const box = document.createElement('div');
  box.className = 'img-sel' + (coord ? ' coord' : '');
  const colors = items.some((s) => s.tool === 'pen' || s.tool === 'text' || s.tool === 'math')
    ? '<span class="sel-colors">' + PEN_COLORS.map((c) => `<button type="button" data-color="${c}" style="--c:${c}" aria-label="Farbe"></button>`).join('') + '</span>'
    : '';
  box.innerHTML = '<i data-h="nw"></i><i data-h="ne"></i><i data-h="sw"></i><i data-h="se"></i>' +
    '<div class="img-sel-menu"><button type="button" data-act="del">Löschen</button>' +
    '<button type="button" data-act="dup">Duplizieren</button><button type="button" data-act="sn">Side Note</button>' + colors + (coord ? coordMenu() : '') + '</div>';
  pageEls[i].wrap.append(box);
  sel = { page: i, items, box, coord };
  placeSelection();
  box.addEventListener('pointerdown', selDown);
  box.addEventListener('pointermove', selMove);
  box.addEventListener('pointerup', selUp);
  box.addEventListener('pointercancel', selUp);
  box.querySelector('[data-act="del"]').addEventListener('click', deleteSelected);
  box.querySelector('[data-act="dup"]').addEventListener('click', duplicateSelected);
  box.querySelector('[data-act="sn"]').addEventListener('click', snFromSelection);
  box.querySelectorAll('[data-color]').forEach((b) => b.addEventListener('click', () => recolorSelected(b.dataset.color)));
  box.querySelectorAll('[data-quad]').forEach((b) => b.addEventListener('click', () => coordOption('quad', Number(b.dataset.quad))));
  box.querySelectorAll('[data-unit]').forEach((b) => b.addEventListener('click', () => coordOption('unit', Number(b.dataset.unit))));
}
const selectImage = (i, s) => selectItems(i, [s]);

function placeSelection() {
  const { items, box } = sel;
  const b = selBounds(items);
  Object.assign(box.style, {
    left: (b.x / PAGE_W) * 100 + '%',
    top: (b.y / PAGE_H) * 100 + '%',
    width: (b.w / PAGE_W) * 100 + '%',
    height: (b.h / PAGE_H) * 100 + '%'
  });
  box.classList.toggle('menu-below', b.y < 70);
}

function deselectImage() {
  if (!sel) return;
  sel.box.remove();
  sel = null;
  selDrag = null;
}

// Änderung an der Auswahl als ein Schritt für "Rückgängig"
function changeSelection(fn) {
  const page = sel.page;
  const before = note.pages[page].strokes.slice();
  const items = fn(note.pages[page]);
  pushHistory([{ page, before, after: note.pages[page].strokes.slice() }]);
  drawPage(page);
  saveNote();
  if (items) selectItems(page, items);
  else deselectImage();
}

function deleteSelected() {
  if (!sel) return;
  const gone = new Set(sel.items);
  changeSelection((pg) => { pg.strokes = pg.strokes.filter((s) => !gone.has(s)); return null; });
}

function duplicateSelected() {
  if (!sel) return;
  const copies = sel.items.map((s) => { const { sn, ...c } = transformItem(s, 1, 0, 0, 20, 20); return c; });
  changeSelection((pg) => { pg.strokes.push(...copies); return copies; });
}

function recolorSelected(color) {
  if (!sel) return;
  const recolor = (s) => s.tool === 'pen' || s.tool === 'math' ? { ...s, color }
    : s.tool === 'text' ? { ...s, color, paras: s.paras && s.paras.map((p) => ({ ...p, spans: p.spans.map(({ c, ...sp }) => sp) })) } : s;
  const map = new Map(sel.items.map((s) => [s, recolor(s)]));
  changeSelection((pg) => { pg.strokes = pg.strokes.map((s) => map.get(s) || s); return [...map.values()]; });
}

function selDown(e) {
  if (!sel || (e.target.closest && e.target.closest('button'))) return;
  if (e.pointerType === 'touch' && penNear()) return;     // Handballen
  e.preventDefault();
  e.stopPropagation();
  try { sel.box.setPointerCapture(e.pointerId); } catch {}
  const rect = pageEls[sel.page].svg.getBoundingClientRect();
  const list = note.pages[sel.page].strokes;
  selDrag = {
    id: e.pointerId,
    handle: (e.target.dataset && e.target.dataset.h) || null,
    rect,
    x0: ((e.clientX - rect.left) / rect.width) * PAGE_W,
    y0: ((e.clientY - rect.top) / rect.height) * PAGE_H,
    orig: sel.items.slice(),
    idx: sel.items.map((s) => list.indexOf(s)),
    b: selBounds(sel.items),
    before: list.slice(),
    moved: false
  };
}

function selMove(e) {
  const d = selDrag;
  if (!d || e.pointerId !== d.id) return;
  e.preventDefault();
  e.stopPropagation();
  const x = ((e.clientX - d.rect.left) / d.rect.width) * PAGE_W;
  const y = ((e.clientY - d.rect.top) / d.rect.height) * PAGE_H;
  if (!d.moved && Math.hypot(x - d.x0, y - d.y0) < 2) return;
  d.moved = true;
  const B = d.b;
  let k = 1, nx, ny;
  if (!d.handle) {
    nx = clamp(B.x + x - d.x0, -B.w * 0.8, PAGE_W - B.w * 0.2);
    ny = clamp(B.y + y - d.y0, -B.h * 0.8, PAGE_H - B.h * 0.2);
    if (sel.coord) {
      nx = B.x + snapGrid(nx - B.x);
      ny = B.y + snapGrid(ny - B.y);
      d.shift = [nx - B.x, ny - B.y];
    }
  } else {
    // gegenüberliegende Ecke bleibt stehen, Seitenverhältnis bleibt gleich
    const east = d.handle.includes('e'), south = d.handle.includes('s');
    const ax = east ? B.x : B.x + B.w, ay = south ? B.y : B.y + B.h;
    const ratio = B.h / B.w;
    const w = clamp(Math.max(Math.abs(x - ax), Math.abs(y - ay) / ratio), 20, 3 * PAGE_W);
    k = w / B.w;
    nx = east ? ax : ax - w;
    ny = south ? ay : ay - B.h * k;
  }
  const list = note.pages[sel.page].strokes;
  if (d.idx.some((j, n) => list[j] !== sel.items[n])) return deselectImage();
  sel.items = d.orig.map((s, n) => (list[d.idx[n]] = transformItem(s, k, B.x, B.y, nx, ny)));
  drawPage(sel.page);
}

function selUp(e) {
  const d = selDrag;
  if (!d || e.pointerId !== d.id) return;
  e.stopPropagation();
  selDrag = null;
  if (d.moved) {
    pushHistory([{ page: sel.page, before: d.before, after: note.pages[sel.page].strokes.slice() }]);
    saveNote();
    if (sel.coord && d.shift) {
      const r = sel.coord.rect, [sx, sy] = d.shift;
      sel.coord = { rect: { x0: r.x0 + sx, y0: r.y0 + sy, x1: r.x1 + sx, y1: r.y1 + sy } };
    }
  }
}

// ---------- Lasso ----------
let lasso = null;     // { id, page, rect, pts: [x, y, …] }

function lassoPoint(e) {
  return [((e.clientX - lasso.rect.left) / lasso.rect.width) * PAGE_W, ((e.clientY - lasso.rect.top) / lasso.rect.height) * PAGE_H];
}

function lassoDown(e, canvas) {
  e.preventDefault();
  try { canvas.setPointerCapture(e.pointerId); } catch {}
  const i = Number(canvas.dataset.page);
  lasso = { id: e.pointerId, page: i, rect: canvas.getBoundingClientRect(), pts: [] };
  lasso.pts.push(...lassoPoint(e));
  const live = pageEls[i].live;
  for (const a of ['fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'style']) live.removeAttribute(a);
  live.setAttribute('fill', 'rgba(37, 99, 235, .06)');
  live.setAttribute('stroke', '#2563eb');
  live.setAttribute('stroke-width', '1.5');
  live.setAttribute('stroke-dasharray', '6 5');
}

function lassoMove(e) {
  e.preventDefault();
  const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
  for (const ev of events.length ? events : [e]) {
    const [x, y] = lassoPoint(ev), p = lasso.pts, n = p.length;
    if (Math.hypot(x - p[n - 2], y - p[n - 1]) >= 3) p.push(x, y);
  }
  let d = '';
  for (let i = 0; i < lasso.pts.length; i += 2) d += (i ? 'L' : 'M') + num(lasso.pts[i]) + ' ' + num(lasso.pts[i + 1]);
  pageEls[lasso.page].live.setAttribute('d', d + 'Z');
}

function inPoly(poly, x, y) {
  let inside = false;
  for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
    const xi = poly[i], yi = poly[i + 1], xj = poly[j], yj = poly[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function lassoUp(e) {
  const l = lasso;
  lasso = null;
  const live = pageEls[l.page].live;
  live.removeAttribute('d');
  live.removeAttribute('stroke-dasharray');
  if (e.type === 'pointercancel' || l.pts.length < 6) return;
  // Strich gehört dazu, wenn mindestens die Hälfte seiner Punkte im Lasso liegt;
  // Text und Bilder, wenn ihre Mitte drin liegt
  const items = note.pages[l.page].strokes.filter((s) => {
    if (s.tool === 'image' || s.tool === 'text' || s.tool === 'math') {
      const b = itemBounds(s);
      return inPoly(l.pts, (b[0] + b[2]) / 2, (b[1] + b[3]) / 2);
    }
    let hit = 0;
    for (let i = 0; i < s.pts.length; i += 3) if (inPoly(l.pts, s.pts[i], s.pts[i + 1])) hit++;
    return hit * 3 >= s.pts.length / 2;
  });
  if (items.length) selectItems(l.page, items);
}

// Bild-Knopf in der Werkzeugleiste
$('#image-insert').addEventListener('click', () => $('#image-file').click());
$('#note-insert-image').addEventListener('click', () => { $('#more-dialog').close(); $('#image-file').click(); });
$('#image-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try { await insertImageElement(file); } catch (err) { toast('Bild konnte nicht eingefügt werden'); console.error(err); }
});

// Einfügen aus der Zwischenablage (Strg+V / iPad: Einsetzen)
document.addEventListener('paste', async (e) => {
  if (document.body.dataset.view !== 'notes' || !note) return;
  const files = [...(e.clipboardData ? e.clipboardData.files : [])].filter((f) => f.type.startsWith('image/'));
  if (!files.length) return;          // Text normal einfügen lassen
  e.preventDefault();
  for (const f of files) {
    try { await insertImageElement(f); } catch { toast('Bild konnte nicht eingefügt werden'); }
  }
});

// Bild auf eine Seite ziehen (Surface/PC)
pagesBox.addEventListener('dragover', (e) => {
  if (e.dataTransfer && [...e.dataTransfer.items].some((it) => it.kind === 'file')) e.preventDefault();
});
pagesBox.addEventListener('drop', async (e) => {
  const files = [...(e.dataTransfer ? e.dataTransfer.files : [])];
  if (!files.length) return;
  e.preventDefault();
  const canvas = e.target.closest && e.target.closest('.page-live');
  let at = null;
  if (canvas) {
    const r = canvas.getBoundingClientRect();
    at = { page: Number(canvas.dataset.page), x: ((e.clientX - r.left) / r.width) * PAGE_W, y: ((e.clientY - r.top) / r.height) * PAGE_H };
  }
  for (const f of files) {
    if (f.type.startsWith('image/')) await insertImageElement(f, at).catch(() => toast('Bild konnte nicht eingefügt werden'));
    else if (f.type === 'application/pdf') await insertPdfPages(f).catch(() => toast('Import fehlgeschlagen'));
  }
});

// ---------- Lineal ----------
// Liegt fest über dem Bildschirm (nicht auf der Seite). Finger/Maus: ziehen = verschieben,
// zwei Finger = drehen, runder Knopf = drehen (auch mit Stift/Maus). Ein Strich, der nah an
// einer Kante beginnt, läuft exakt an dieser Kante entlang.
const RULER_LEN = 2400, RULER_W = 76, RULER_SNAP = 26;
let ruler = null;                 // { cx, cy, a } – Mitte in px im Lineal-Layer, Winkel in rad
const rulerLayer = document.createElement('div');
rulerLayer.className = 'ruler-layer';
rulerLayer.hidden = true;
const rulerEl = document.createElement('div');
rulerEl.className = 'ruler';
rulerEl.innerHTML = '<div class="ruler-ticks"></div><span class="ruler-angle"></span><i class="ruler-rot" title="Drehen"></i>';
rulerLayer.append(rulerEl);
document.body.append(rulerLayer);
let rulerMm = 0;

function sizeRulerLayer() {
  const r = pagesBox.getBoundingClientRect();
  Object.assign(rulerLayer.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
}

function renderRuler() {
  if (!ruler) return;
  rulerEl.style.transform = `translate(${ruler.cx - RULER_LEN / 2}px, ${ruler.cy - RULER_W / 2}px) rotate(${ruler.a}rad)`;
  let deg = Math.round((-ruler.a * 180) / Math.PI) % 180;
  if (deg < 0) deg += 180;
  rulerEl.querySelector('.ruler-angle').textContent = deg + '°';
  // Skala in echten Millimetern der Seite (A4 = 210 mm breit) – passt sich dem Zoom an
  const pe = pageEls[0];
  const mm = pe ? pe.svg.getBoundingClientRect().width / 210 : 4;
  if (Math.abs(mm - rulerMm) < 0.01) return;
  rulerMm = mm;
  let d = '', labels = '';
  for (let i = 0, x = 0; x <= RULER_LEN; i++, x = i * mm) {
    const len = i % 10 === 0 ? 18 : i % 5 === 0 ? 12 : 7;
    if (mm >= 2.5 || i % 5 === 0) d += `M${x.toFixed(1)} 0V${len}M${x.toFixed(1)} ${RULER_W}V${RULER_W - len}`;
    if (i % 10 === 0 && i) labels += `<text x="${x.toFixed(1)}" y="31">${i / 10}</text>`;
  }
  rulerEl.querySelector('.ruler-ticks').innerHTML =
    `<svg width="${RULER_LEN}" height="${RULER_W}"><path d="${d}" stroke="#555" stroke-width="1" fill="none"/><g font-size="10" fill="#555" text-anchor="middle">${labels}</g></svg>`;
}

function setRuler(on) {
  if (on) {
    sizeRulerLayer();
    const r = pagesBox.getBoundingClientRect();
    ruler = { cx: r.width / 2, cy: r.height / 2, a: 0 };
    rulerMm = 0;
    renderRuler();
  } else {
    ruler = null;
  }
  rulerLayer.hidden = !on;
  $('#ruler-toggle').classList.toggle('active', on);
}
$('#ruler-toggle').addEventListener('click', () => setRuler(!ruler));
window.addEventListener('resize', () => { if (ruler) { sizeRulerLayer(); renderRuler(); } });
window.addEventListener('viewchange', () => { if (ruler) requestAnimationFrame(() => { sizeRulerLayer(); renderRuler(); }); });

// Kante, an der ein Strich entlanglaufen soll (oder null, wenn zu weit weg)
function rulerEdge(clientX, clientY) {
  if (!ruler || rulerLayer.hidden) return null;
  const L = rulerLayer.getBoundingClientRect();
  const cx = L.left + ruler.cx, cy = L.top + ruler.cy;
  const dx = Math.cos(ruler.a), dy = Math.sin(ruler.a), nx = -dy, ny = dx;
  if (Math.abs((clientX - cx) * dx + (clientY - cy) * dy) > RULER_LEN / 2) return null;
  const off = (clientX - cx) * nx + (clientY - cy) * ny;
  if (Math.abs(off) - RULER_W / 2 > RULER_SNAP) return null;
  const e = (RULER_W / 2 + 1) * (off >= 0 ? 1 : -1);
  return { px: cx + nx * e, py: cy + ny * e, dx, dy };
}

// Seitenpunkt eines Stift-Ereignisses – am Lineal auf die Kante gezogen
function pagePoint(ev) {
  const g = active.edge;
  if (!g) return toPage(ev);
  const t = (ev.clientX - g.px) * g.dx + (ev.clientY - g.py) * g.dy;
  return toPage({ clientX: g.px + g.dx * t, clientY: g.py + g.dy * t, pressure: ev.pressure });
}

// Lineal bewegen und drehen
const rulerPtrs = new Map();
let rulerG = null;

function rulerStart(rot) {
  const pts = [...rulerPtrs.values()];
  rulerG = { cx: ruler.cx, cy: ruler.cy, a: ruler.a, rot, pts: pts.map((p) => ({ ...p })) };
}

rulerEl.addEventListener('pointerdown', (e) => {
  const rot = !!e.target.closest('.ruler-rot');
  if (e.pointerType === 'pen' && !rot) {
    // Stift auf dem Lineal: an die Seite darunter weitergeben (schreiben, radieren …)
    rulerEl.style.pointerEvents = 'none';
    const under = document.elementFromPoint(e.clientX, e.clientY);
    rulerEl.style.pointerEvents = '';
    const canvas = under && under.closest('.page-live');
    if (canvas) onDown(new Proxy(e, { get: (t, k) => (k === 'target' ? canvas : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) }));
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  try { rulerEl.setPointerCapture(e.pointerId); } catch {}
  rulerPtrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  rulerStart(rot);
});

rulerEl.addEventListener('pointermove', (e) => {
  if (!rulerPtrs.has(e.pointerId) || !rulerG) return;
  e.preventDefault();
  rulerPtrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const now = [...rulerPtrs.values()], g = rulerG;
  const L = rulerLayer.getBoundingClientRect();
  let a = g.a, cx = g.cx, cy = g.cy;
  if (g.rot) {
    const c = { x: L.left + g.cx, y: L.top + g.cy };
    a += Math.atan2(now[0].y - c.y, now[0].x - c.x) - Math.atan2(g.pts[0].y - c.y, g.pts[0].x - c.x);
  } else if (now.length >= 2 && g.pts.length >= 2) {
    a += Math.atan2(now[1].y - now[0].y, now[1].x - now[0].x) - Math.atan2(g.pts[1].y - g.pts[0].y, g.pts[1].x - g.pts[0].x);
    cx += (now[0].x + now[1].x - g.pts[0].x - g.pts[1].x) / 2;
    cy += (now[0].y + now[1].y - g.pts[0].y - g.pts[1].y) / 2;
  } else {
    cx += now[0].x - g.pts[0].x;
    cy += now[0].y - g.pts[0].y;
  }
  // bei 0°, 45°, 90° … leicht einrasten
  const step = Math.PI / 4, near = Math.round(a / step) * step;
  if (rulerSnap && Math.abs(a - near) < (2.5 * Math.PI) / 180) a = near;
  ruler.a = a;
  ruler.cx = clamp(cx, 0, L.width);
  ruler.cy = clamp(cy, 0, L.height);
  renderRuler();
});

function rulerEnd(e) {
  if (!rulerPtrs.delete(e.pointerId)) return;
  if (rulerPtrs.size) rulerStart(false);
  else rulerG = null;
}
rulerEl.addEventListener('pointerup', rulerEnd);
rulerEl.addEventListener('pointercancel', rulerEnd);
rulerEl.addEventListener('wheel', (e) => {     // Mausrad über dem Lineal = drehen
  e.preventDefault();
  ruler.a += (Math.sign(e.deltaY) * Math.PI) / 180;
  renderRuler();
}, { passive: false });

// ---------- Koordinatensystem ----------
// Rechteck aufziehen → Achsen mit Pfeilen, Skala und Zahlen, alles genau auf den Kästchen
// (5 mm). Danach im Menü: 4 Quadranten / nur 1. Quadrant, 1 Einheit = 1 oder 2 Kästchen.
let coordAction = null;
const coordOpt = store.get('coordOpt', { quad: 4, unit: 2 });
const snapGrid = (v) => Math.round(v / GRID_STEP) * GRID_STEP;

function coordPoint(e, rect) {
  return [snapGrid(((e.clientX - rect.left) / rect.width) * PAGE_W), snapGrid(((e.clientY - rect.top) / rect.height) * PAGE_H)];
}

function coordDown(e, canvas) {
  e.preventDefault();
  try { canvas.setPointerCapture(e.pointerId); } catch {}
  const rect = canvas.getBoundingClientRect();
  const [x, y] = coordPoint(e, rect);
  coordAction = { id: e.pointerId, page: Number(canvas.dataset.page), rect, x0: x, y0: y, x1: x, y1: y };
  const live = pageEls[coordAction.page].live;
  for (const a of ['fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'style']) live.removeAttribute(a);
  live.setAttribute('fill', 'rgba(37, 99, 235, .06)');
  live.setAttribute('stroke', '#2563eb');
  live.setAttribute('stroke-width', '1.5');
  live.setAttribute('stroke-dasharray', '6 5');
}

function coordMove(e) {
  e.preventDefault();
  const c = coordAction;
  [c.x1, c.y1] = coordPoint(e, c.rect);
  pageEls[c.page].live.setAttribute('d', `M${num(c.x0)} ${num(c.y0)}H${num(c.x1)}V${num(c.y1)}H${num(c.x0)}Z`);
}

function coordUp(e) {
  const c = coordAction;
  coordAction = null;
  const live = pageEls[c.page].live;
  live.removeAttribute('d');
  live.removeAttribute('stroke-dasharray');
  if (e.type === 'pointercancel') return;
  let r = { x0: Math.min(c.x0, c.x1), y0: Math.min(c.y0, c.y1), x1: Math.max(c.x0, c.x1), y1: Math.max(c.y0, c.y1) };
  if (r.x1 - r.x0 < GRID_STEP * 4 || r.y1 - r.y0 < GRID_STEP * 4) {
    // nur getippt: Standardgröße (16 × 16 Kästchen) um den Punkt
    const h = GRID_STEP * 8;
    r = { x0: c.x0 - h, y0: c.y0 - h, x1: c.x0 + h, y1: c.y0 + h };
  }
  // auf der Seite halten (an den Kästchen ausgerichtet)
  const fit = (a, b, max) => { const s = Math.max(0, -a) - Math.max(0, b - max); return [a + s, b + s]; };
  [r.x0, r.x1] = fit(r.x0, r.x1, snapGrid(PAGE_W - 10));
  [r.y0, r.y1] = fit(r.y0, r.y1, snapGrid(PAGE_H - 10));
  placeCoord(c.page, r, null);
}

function coordItems(r, opt) {
  const G = GRID_STEP, U = G * opt.unit, color = PEN_COLORS[colorSel.pen], FS = 14;
  let ox, oy;
  if (opt.quad === 1) { ox = r.x0 + G; oy = r.y1 - G; }
  else { ox = r.x0 + Math.round((r.x1 - r.x0) / 2 / U) * U; oy = r.y0 + Math.round((r.y1 - r.y0) / 2 / U) * U; }
  const line = (pts) => ({ tool: 'pen', style: 'ball', shape: true, color, size: 1, pts: pts.flatMap(([x, y]) => [x, y, 0.5]) });
  measureCtx.font = `${FS}px ${TEXT_FONT}`;
  const label = (text, x, y, align) => {
    const w = measureCtx.measureText(text).width + 2;
    return { tool: 'text', x: align === 'center' ? x - w / 2 : align === 'right' ? x - w : x, y, w, size: FS, color, text };
  };
  const items = [
    line([[r.x0, oy], [r.x1, oy]]), line([[r.x1 - 10, oy - 5], [r.x1, oy], [r.x1 - 10, oy + 5]]),
    line([[ox, r.y1], [ox, r.y0]]), line([[ox - 5, r.y0 + 10], [ox, r.y0], [ox + 5, r.y0 + 10]]),
    label('x', r.x1 - 4, oy + 6, 'left'), label('y', ox + 7, r.y0 - 4, 'left'), label('0', ox - 4, oy + 5, 'right')
  ];
  for (let x = ox + U, n = 1; x <= r.x1 - G; x += U, n++) items.push(line([[x, oy - 5], [x, oy + 5]]), label(String(n), x, oy + 7, 'center'));
  for (let x = ox - U, n = -1; x >= r.x0 + G * 0.5; x -= U, n--) items.push(line([[x, oy - 5], [x, oy + 5]]), label(String(n), x, oy + 7, 'center'));
  for (let y = oy - U, n = 1; y >= r.y0 + G; y -= U, n++) items.push(line([[ox - 5, y], [ox + 5, y]]), label(String(n), ox - 8, y - FS * 0.6, 'right'));
  for (let y = oy + U, n = -1; y <= r.y1 - G * 0.5; y += U, n--) items.push(line([[ox - 5, y], [ox + 5, y]]), label(String(n), ox - 8, y - FS * 0.6, 'right'));
  return items;
}

// Koordinatensystem auf die Seite setzen (oder ein ausgewähltes ersetzen) und auswählen
function placeCoord(i, r, old) {
  const page = note.pages[i];
  const before = page.strokes.slice();
  const items = coordItems(r, coordOpt);
  if (old) {
    const gone = new Set(old);
    page.strokes = page.strokes.filter((s) => !gone.has(s));
  }
  page.strokes.push(...items);
  pushHistory([{ page: i, before, after: page.strokes.slice() }]);
  drawPage(i);
  saveNote();
  selectItems(i, items, { rect: r });
}

function coordMenu() {
  const b = (k, v, label) => `<button type="button" data-${k}="${v}" class="${coordOpt[k] === v ? 'on' : ''}">${label}</button>`;
  return '<span class="sel-coord">' + b('quad', 4, '4 Quadranten') + b('quad', 1, '1. Quadrant') +
    '</span><span class="sel-coord">' + b('unit', 2, '1 cm') + b('unit', 1, '1 Kästchen') + '</span>';
}

function coordOption(k, v) {
  if (!sel || !sel.coord) return;
  coordOpt[k] = v;
  store.set('coordOpt', coordOpt);
  placeCoord(sel.page, sel.coord.rect, sel.items);
}

// ---------- Formeln ----------
// Element { tool: 'math', x, y, size, color, src }. src ist einfach zu tippen:
// a/b = Bruch, x^2 = hoch, x_1 = tief, sqrt(x) = Wurzel, pi/alpha/… = griechisch, <= ≤, -> → …
// Ein eigener kleiner Formelsatz liefert Zeichen-Befehle, die SVG, Canvas und PDF gleich zeichnen.
const MATH_SYMBOLS = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', eta: 'η', theta: 'θ', lambda: 'λ', mu: 'μ', pi: 'π',
  rho: 'ρ', sigma: 'σ', tau: 'τ', phi: 'φ', omega: 'ω', Delta: 'Δ', Sigma: 'Σ', Omega: 'Ω', Phi: 'Φ', Pi: 'Π',
  cdot: '·', times: '×', div: '÷', pm: '±', le: '≤', ge: '≥', leq: '≤', geq: '≥', neq: '≠', ne: '≠', approx: '≈',
  infty: '∞', inf: '∞', to: '→', Rightarrow: '⇒', Leftrightarrow: '⇔', in: '∈', int: '∫', sum: 'Σ', deg: '°',
  degree: '°', angle: '∠', perp: '⊥', parallel: '∥', cap: '∩', cup: '∪', subset: '⊂', emptyset: '∅'
};
const MATH_FUNCS = ['sin', 'cos', 'tan', 'cot', 'log', 'ln', 'lg', 'lim', 'exp', 'max', 'min', 'det'];
const MATH_OPS = '+−=<>≤≥≠≈±·×÷→⇒⇔∈∩∪⊂';
const MATH_COMBOS = [['<=', '≤'], ['>=', '≥'], ['!=', '≠'], ['->', '→'], ['=>', '⇒'], ['+-', '±'], ['~=', '≈'], ['*', '·'], ['-', '−']];

function mathTokens(src) {
  const out = [], chars = [...src];
  for (let i = 0; i < chars.length;) {
    const c = chars[i];
    if (c === '\\') {
      let j = i + 1, name = '';
      while (j < chars.length && /[a-zA-Z]/.test(chars[j])) name += chars[j++];
      if (name) { out.push({ k: 'cmd', v: name }); i = j; } else { out.push({ k: 'ch', v: chars[i + 1] || '\\' }); i += 2; }
      continue;
    }
    if (/[a-zA-Z]/.test(c)) {
      let j = i, word = '';
      while (j < chars.length && /[a-zA-Z]/.test(chars[j])) word += chars[j++];
      if (word === 'sqrt' || word === 'frac' || word === 'root' || MATH_SYMBOLS[word]) out.push({ k: 'cmd', v: word });
      else if (MATH_FUNCS.includes(word)) out.push({ k: 'fn', v: word });
      else for (const ch of word) out.push({ k: 'ch', v: ch });
      i = j;
      continue;
    }
    const combo = MATH_COMBOS.find(([a]) => chars.slice(i, i + a.length).join('') === a);
    if (combo) { out.push({ k: 'ch', v: combo[1], op: true }); i += combo[0].length; continue; }
    if (/[0-9]/.test(c)) {
      let j = i, n = '';
      while (j < chars.length && (/[0-9]/.test(chars[j]) || (/[.,]/.test(chars[j]) && /[0-9]/.test(chars[j + 1] || '')))) n += chars[j++];
      out.push({ k: 'num', v: n });
      i = j;
      continue;
    }
    if (c !== ' ') out.push({ k: 'ch', v: c });
    i++;
  }
  return out;
}

function parseMath(src) {
  const tk = mathTokens(src);
  let i = 0;
  const isCh = (t, v) => t && t.k === 'ch' && !t.op && v.includes(t.v);
  const unwrap = (n) => (n.t === 'paren' && n.o === '(' ? n.b : n);
  function row(stop) {
    const items = [];
    while (i < tk.length && !isCh(tk[i], stop)) items.push(atom());
    // a/b → Bruch (Klammern um Zähler/Nenner fallen weg)
    for (let j = 1; j < items.length - 1; j++) {
      if (items[j].t === 'text' && items[j].s === '/') {
        items.splice(j - 1, 3, { t: 'frac', n: unwrap(items[j - 1]), d: unwrap(items[j + 1]) });
        j--;
      }
    }
    return { t: 'row', items };
  }
  function group(close) {
    const r = row(close);
    if (i < tk.length) i++;
    return r;
  }
  function arg() {
    if (i >= tk.length) return { t: 'row', items: [] };
    if (isCh(tk[i], '{')) { i++; return group('}'); }
    return unwrap(atom(true));
  }
  function atom(noScript) {
    const base = primary();
    if (noScript) return base;
    let sup = null, sub = null;
    while (i < tk.length && isCh(tk[i], '^_')) {
      const op = tk[i++].v;
      const a = arg();
      if (op === '^') sup = a; else sub = a;
    }
    return sup || sub ? { t: 'script', base, sup, sub } : base;
  }
  function primary() {
    const t = tk[i++];
    if (t.k === 'num') return { t: 'text', s: t.v };
    if (t.k === 'fn') return { t: 'text', s: t.v, fn: true };
    if (t.k === 'cmd') {
      if (t.v === 'frac') { const n = arg(), d = arg(); return { t: 'frac', n, d }; }
      if (t.v === 'sqrt') return { t: 'sqrt', b: arg() };
      if (t.v === 'root') { const n = arg(), b = arg(); return { t: 'sqrt', b, idx: n }; }
      return { t: 'text', s: MATH_SYMBOLS[t.v] || t.v };
    }
    if (isCh(t, '{')) return group('}');
    if (isCh(t, '(')) return { t: 'paren', o: '(', c: ')', b: group(')') };
    if (isCh(t, '[')) return { t: 'paren', o: '[', c: ']', b: group(']') };
    return { t: 'text', s: t.v };
  }
  return row('');
}

// Satz: Kasten { w, a (über der Grundlinie), d (darunter), ops } – y nach unten, Grundlinie bei 0
function mathBox(node, fs) {
  const shift = (box, dx, dy) => box.ops.map((o) => (o.k === 't' ? { ...o, x: o.x + dx, y: o.y + dy } : { ...o, pts: o.pts.map((v, j) => v + (j % 2 ? dy : dx)) }));
  if (node.t === 'text') {
    const isOp = MATH_OPS.includes(node.s) && !node.unary;
    const it = !node.fn && /^[a-zA-Zα-ωΑ-Ω]$/.test(node.s) && !/[ΔΣΩΦΠ]/.test(node.s);
    const pad = isOp ? fs * 0.22 : 0;
    const w = measure(node.s, fontOf({ i: it }, fs));
    return { w: w + 2 * pad, a: fs * 0.72, d: fs * 0.22, ops: [{ k: 't', x: pad, y: 0, s: node.s, fs, i: it }] };
  }
  if (node.t === 'row') {
    if (!node.items.length) return { w: fs * 0.45, a: fs * 0.6, d: 0, ops: [] };
    let x = 0, a = 0, d = 0;
    const ops = [];
    node.items.forEach((it, j) => {
      // Vorzeichen (am Anfang oder nach einem anderen Zeichen wie = oder ±) ohne Abstand
      const prev = node.items[j - 1];
      if (it.t === 'text' && (it.s === '−' || it.s === '+') && (!prev || (prev.t === 'text' && MATH_OPS.includes(prev.s)))) it = { ...it, unary: true };
      const b = mathBox(it, fs);
      ops.push(...shift(b, x, 0));
      x += b.w;
      a = Math.max(a, b.a);
      d = Math.max(d, b.d);
    });
    return { w: x, a, d, ops };
  }
  if (node.t === 'frac') {
    const f2 = Math.max(fs * 0.85, 8);
    const n = mathBox(node.n, f2), dn = mathBox(node.d, f2);
    const axis = fs * 0.3, gap = fs * 0.12, lw = Math.max(fs * 0.055, 0.8), m = fs * 0.12;
    const w = Math.max(n.w, dn.w) + fs * 0.3;
    const ny = -(axis + gap + lw / 2 + n.d), dy = -axis + gap + lw / 2 + dn.a;
    return {
      w: w + 2 * m, a: axis + gap + lw / 2 + n.d + n.a, d: dy + dn.d,
      ops: [...shift(n, m + (w - n.w) / 2, ny), ...shift(dn, m + (w - dn.w) / 2, dy), { k: 'p', pts: [m, -axis, m + w, -axis], lw }]
    };
  }
  if (node.t === 'sqrt') {
    const b = mathBox(node.b, fs);
    const gap = fs * 0.12, lw = Math.max(fs * 0.055, 0.8), sw = fs * 0.55;
    const top = -(b.a + gap), bottom = b.d + fs * 0.02, mid = bottom - (bottom - top) * 0.42;
    let ox = 0;
    const ops = [];
    if (node.idx) {
      const ib = mathBox(node.idx, fs * 0.5);
      ox = Math.max(0, ib.w - sw * 0.3);
      ops.push(...shift(ib, 0, mid - fs * 0.12));
    }
    ops.push({ k: 'p', pts: [ox, mid + fs * 0.06, ox + sw * 0.25, mid - fs * 0.04, ox + sw * 0.55, bottom, ox + sw, top, ox + sw + b.w + fs * 0.12, top], lw });
    ops.push(...shift(b, ox + sw + fs * 0.06, 0));
    return { w: ox + sw + b.w + fs * 0.2, a: -top + lw, d: bottom + lw, ops };
  }
  if (node.t === 'script') {
    const base = mathBox(node.base, fs), f2 = Math.max(fs * 0.68, 7);
    const sup = node.sup && mathBox(node.sup, f2), sub = node.sub && mathBox(node.sub, f2);
    const ops = [...base.ops];
    let a = base.a, d = base.d, w = 0;
    if (sup) {
      const y = -Math.max(fs * 0.42, base.a - f2 * 0.45);
      ops.push(...shift(sup, base.w + fs * 0.03, y));
      a = Math.max(a, sup.a - y);
      w = sup.w;
    }
    if (sub) {
      const y = Math.max(fs * 0.24, base.d + f2 * 0.1);
      ops.push(...shift(sub, base.w + fs * 0.03, y));
      d = Math.max(d, sub.d + y);
      w = Math.max(w, sub.w);
    }
    return { w: base.w + w + fs * 0.08, a, d, ops };
  }
  if (node.t === 'paren') {
    const b = mathBox(node.b, fs);
    if (b.a + b.d <= fs * 1.2) {
      const l = mathBox({ t: 'text', s: node.o }, fs), r = mathBox({ t: 'text', s: node.c }, fs);
      return { w: l.w + b.w + r.w, a: Math.max(b.a, l.a), d: Math.max(b.d, l.d), ops: [...l.ops, ...shift(b, l.w, 0), ...shift(r, l.w + b.w, 0)] };
    }
    // hohe Klammern zeichnen (z. B. um Brüche)
    const pw = fs * 0.38, lw = Math.max(fs * 0.055, 0.8), top = -b.a - fs * 0.05, bot = b.d + fs * 0.05;
    const side = (x0, dir) => {
      if (node.o === '[') return [x0 + dir * pw * 0.6, top, x0 + dir * pw * 0.2, top, x0 + dir * pw * 0.2, bot, x0 + dir * pw * 0.6, bot];
      const pts = [];
      for (let j = 0; j <= 14; j++) {
        const t = j / 14;
        pts.push(x0 + dir * (pw * 0.75 - Math.sin(t * Math.PI) * pw * 0.5), top + (bot - top) * t);
      }
      return pts;
    };
    return {
      w: b.w + 2 * pw, a: -top + lw, d: bot + lw,
      ops: [{ k: 'p', pts: side(0, 1), lw }, ...shift(b, pw, 0), { k: 'p', pts: side(b.w + 2 * pw, -1), lw }]
    };
  }
  return { w: 0, a: 0, d: 0, ops: [] };
}

const mathCache = new WeakMap();
function mathLayout(s) {
  let m = mathCache.get(s);
  if (!m) {
    m = mathBox(parseMath(s.src), s.size);
    mathCache.set(s, m);
  }
  return m;
}
const mathBounds = (s) => { const m = mathLayout(s); return [s.x, s.y, s.x + m.w, s.y + m.a + m.d]; };

function mathSvgInner(m, ox, by, color) {
  let out = '';
  for (const o of m.ops) {
    if (o.k === 't') out += `<text x="${num(ox + o.x)}" y="${num(by + o.y)}" font-size="${num(o.fs)}" font-family="${TEXT_FONT}" fill="${color}"${o.i ? ' font-style="italic"' : ''}>${escXml(o.s)}</text>`;
    else out += `<path fill="none" stroke="${color}" stroke-width="${num(o.lw)}" stroke-linecap="round" stroke-linejoin="round" d="${o.pts.map((v, j) => (j % 2 ? '' : j ? 'L' : 'M') + num(v + (j % 2 ? by : ox)) + (j % 2 ? '' : ' ')).join('')}"/>`;
  }
  return out;
}
const mathSvg = (s) => { const m = mathLayout(s); return mathSvgInner(m, s.x, s.y + m.a, s.color); };

function drawMath(ctx, s) {
  const m = mathLayout(s), ox = s.x, by = s.y + m.a;
  ctx.fillStyle = ctx.strokeStyle = s.color;
  ctx.lineCap = ctx.lineJoin = 'round';
  for (const o of m.ops) {
    if (o.k === 't') {
      ctx.font = fontOf({ i: o.i }, o.fs);
      ctx.fillText(o.s, ox + o.x, by + o.y);
    } else {
      ctx.lineWidth = o.lw;
      ctx.beginPath();
      for (let j = 0; j < o.pts.length; j += 2) ctx[j ? 'lineTo' : 'moveTo'](ox + o.pts[j], by + o.pts[j + 1]);
      ctx.stroke();
    }
  }
}

// Formel-Werkzeug: Antippen öffnet den Formel-Dialog (neue Formel oder vorhandene bearbeiten)
let mathTap = null;
let mathEdit = null;    // { page, k, x, y }

function mathAt(i, x, y) {
  const list = note.pages[i].strokes;
  for (let k = list.length - 1; k >= 0; k--) {
    if (list[k].tool !== 'math') continue;
    const b = mathBounds(list[k]);
    if (x >= b[0] - 6 && x <= b[2] + 6 && y >= b[1] - 6 && y <= b[3] + 6) return k;
  }
  return -1;
}

function mathDown(e, canvas) {
  if (e.pointerType !== 'touch') e.preventDefault();
  const r = canvas.getBoundingClientRect();
  mathTap = { id: e.pointerId, page: Number(canvas.dataset.page), x: ((e.clientX - r.left) / r.width) * PAGE_W, y: ((e.clientY - r.top) / r.height) * PAGE_H, sx: e.clientX, sy: e.clientY, st: pagesBox.scrollTop };
}

function mathUp(e) {
  const m = mathTap;
  mathTap = null;
  if (Math.hypot(e.clientX - m.sx, e.clientY - m.sy) > 14 || Math.abs(pagesBox.scrollTop - m.st) > 3) return;   // gescrollt
  openMathDialog(m.page, mathAt(m.page, m.x, m.y), m.x, m.y);
}

function openMathDialog(page, k, x, y) {
  mathEdit = { page, k, x, y };
  const s = k >= 0 ? note.pages[page].strokes[k] : null;
  $('#math-src').value = s ? s.src : '';
  $('#math-delete').hidden = !s;
  $('#math-ok').textContent = s ? 'Übernehmen' : 'Einfügen';
  renderMathPreview();
  $('#math-dialog').showModal();
  $('#math-src').focus();
}

function renderMathPreview() {
  const src = $('#math-src').value;
  const box = $('#math-preview');
  if (!src.trim()) { box.innerHTML = '<span class="muted">Vorschau</span>'; return; }
  const m = mathBox(parseMath(src), 30), pad = 6;
  box.innerHTML = `<svg width="${Math.ceil(m.w + 2 * pad)}" height="${Math.ceil(m.a + m.d + 2 * pad)}">${mathSvgInner(m, pad, pad + m.a, '#1c1c1e')}</svg>`;
}

const MATH_KEYS = [
  ['a⁄b', '(|)/()', 'Bruch'], ['√', 'sqrt(|)', 'Wurzel'], ['ⁿ√', 'root(|)()', 'n-te Wurzel'], ['xⁿ', '^(|)', 'Hoch'], ['x₁', '_(|)', 'Tief'],
  ['( )', '(|)', 'Klammer'], ['π', 'pi', ''], ['α', 'alpha', ''], ['β', 'beta', ''], ['Δ', 'Delta', ''], ['·', '*', 'mal'],
  ['±', '+-', ''], ['≤', '<=', ''], ['≥', '>=', ''], ['≠', '!=', ''], ['≈', '~=', ''], ['∞', 'inf', ''], ['→', '->', ''],
  ['∫', 'int', ''], ['Σ', 'sum', ''], ['°', 'deg', '']
];
(() => {
  const keys = $('#math-keys');
  MATH_KEYS.forEach(([label, ins, title]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    if (title) b.title = title;
    b.addEventListener('click', () => {
      const inp = $('#math-src'), a = inp.selectionStart ?? inp.value.length, z = inp.selectionEnd ?? a;
      const tpl = ins.replace('|', inp.value.slice(a, z) + '|');   // markierter Text kommt in die Vorlage
      let caret = tpl.indexOf('|');
      let text = tpl.replace('|', '');
      // Wörter wie "pi" von Buchstaben davor trennen
      if (/^[a-zA-Z]/.test(text) && /[a-zA-Z]$/.test(inp.value.slice(0, a))) { text = ' ' + text; caret += caret >= 0 ? 1 : 0; }
      inp.value = inp.value.slice(0, a) + text + inp.value.slice(z);
      const pos = a + (caret >= 0 ? caret : text.length);
      inp.focus();
      inp.setSelectionRange(pos, pos);
      renderMathPreview();
    });
    keys.append(b);
  });
})();
$('#math-src').addEventListener('input', renderMathPreview);
$('#math-src').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#math-ok').click(); } });

$('#math-ok').addEventListener('click', () => {
  const src = $('#math-src').value.trim();
  const { page, k, x, y } = mathEdit;
  const pg = note.pages[page];
  const before = pg.strokes.slice();
  $('#math-dialog').close();
  if (k >= 0) {
    if (!src) pg.strokes = pg.strokes.filter((_, j) => j !== k);
    else if (src !== pg.strokes[k].src) pg.strokes[k] = { ...pg.strokes[k], src };
    else return;
  } else {
    if (!src) return;
    const sz = Math.round((TEXT_SIZES[size] || 24) * 1.15);
    const m = mathBox(parseMath(src), sz);
    pg.strokes.push({ tool: 'math', x: clamp(x, 0, PAGE_W - m.w), y: clamp(y - m.a, 0, PAGE_H - m.a - m.d), size: sz, color: PEN_COLORS[colorSel.pen], src });
  }
  pushHistory([{ page, before, after: pg.strokes.slice() }]);
  drawPage(page);
  saveNote();
});
$('#math-delete').addEventListener('click', () => {
  const { page, k } = mathEdit;
  if (k < 0) return;
  const pg = note.pages[page], before = pg.strokes.slice();
  pg.strokes = pg.strokes.filter((_, j) => j !== k);
  $('#math-dialog').close();
  pushHistory([{ page, before, after: pg.strokes.slice() }]);
  drawPage(page);
  saveNote();
});

// ---------- Side Notes ----------
// Anmerkungen an Stellen der Seite: an Unterstreichungen, an Bereichen oder an Handschrift/Text
// (per Lasso). Jede Notiz gehört zu einem Schlüssel (Ebene) mit Farbe – global für alle Notizen
// oder nur für diese Notiz – und lässt sich ein-/ausblenden.
// page.notes = [{ id, key, anchor, text, ink }]
//   anchor: { type: 'line', x0, y0, x1, y1 } | { type: 'rect', x, y, w, h } | { type: 'items', x, y, w, h }
//   (bei 'items' tragen die Elemente selbst s.sn = [Notiz-IDs], damit die Notiz mitwandert)
const SN_COLORS = ['#ea580c', '#2563eb', '#16a34a', '#dc2626', '#9333ea', '#0891b2', '#ca8a04', '#db2777'];
const SN_DEFAULT = [
  { id: 'g-stil', name: 'Stilmittel', color: '#ea580c' }, { id: 'g-uebers', name: 'Übersetzung', color: '#2563eb' },
  { id: 'g-gram', name: 'Grammatik', color: '#16a34a' }, { id: 'g-wichtig', name: 'Wichtig', color: '#dc2626' }
];
let snGlobal = store.get('snKeys', SN_DEFAULT);
let snHidden = new Set(store.get('snHidden', []));
let snAllHidden = store.get('snAllHidden', false);
let snKey = store.get('snKey', 'g-stil');
let snColumn = store.get('snColumn2', false);
let snPdf = store.get('snPdf', 'list');     // 'off' | 'marks' | 'list'
let snAction = null;     // Ziehen mit dem Side-Notes-Werkzeug
let snEdit = null;       // offener Dialog: { page, id | null, anchor, items }
let snPop = null;        // offene Karte

const snKeys = () => snGlobal.map((k) => ({ ...k, global: true })).concat(((note && note.keys) || []).map((k) => ({ ...k, global: false })));
const snKeyOf = (id) => snKeys().find((k) => k.id === id) || { id, name: 'Ohne Schlüssel', color: '#8e8e93' };
const snVisible = (n) => !snAllHidden && !snHidden.has(n.key);
const snSaveKeys = () => { store.set('snKeys', snGlobal); store.set('snHidden', [...snHidden]); store.set('snAllHidden', snAllHidden); };
const snId = () => 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

// Eine Notiz kann mehrere Stellen haben (n.anchors). Ältere Notizen haben nur n.anchor.
// Jede Stelle hat eine eigene ID (aid); Elemente einer Lasso-Stelle tragen sie in s.sn.
const snAnchors = (n) => n.anchors || (n.anchor ? [{ ...n.anchor, aid: n.anchor.aid || n.id }] : []);

function snABounds(page, a) {
  if (a.type === 'line') return [Math.min(a.x0, a.x1), Math.min(a.y0, a.y1) - 4, Math.max(a.x0, a.x1), Math.max(a.y0, a.y1) + 4];
  if (a.type === 'items') {
    const items = page.strokes.filter((s) => s.sn && s.sn.includes(a.aid));
    if (items.length) { const b = selBounds(items); return [b.x - 4, b.y - 4, b.x + b.w + 4, b.y + b.h + 4]; }
  }
  return [a.x, a.y, a.x + a.w, a.y + a.h];
}
// Bereich der ersten Stelle (für Spalte und Karte)
const snBounds = (page, n) => snABounds(page, snAnchors(n)[0]);

// Nummer-Marke an einer Stelle: rechts oben (bei Unterstreichung am Ende der Linie)
function snBadgeAt(page, a) {
  if (a.type === 'line') { const r = a.x1 >= a.x0; return [clamp((r ? a.x1 : a.x0) + 13, 12, PAGE_W - 12), clamp((r ? a.y1 : a.y0) + 5, 12, PAGE_H - 12)]; }
  const b = snABounds(page, a);
  return [clamp(b[2] + 2, 12, PAGE_W - 12), clamp(b[1] - 2, 12, PAGE_H - 12)];
}
const snBadgePos = (page, n) => snBadgeAt(page, snAnchors(n)[0]);

const snNumbered = (page) => (page.notes || []).map((n, j) => ({ n, no: j + 1 })).filter(({ n }) => snVisible(n));

// Markierungen als SVG (über der Tinte)
// ---------- Darstellung: farbige Unterstreichung im Stil des Schlüssels ----------
// Keine Nummern auf der Seite. Kurzes Antippen einer Markierung zeigt den Inhalt als Sprechblase.
const SN_STYLES = [['line', 'gerade'], ['double', 'doppelt'], ['wavy', 'wellig'], ['dotted', 'gepunktet'], ['marker', 'Textmarker']];
const SN_STYLE_DEFAULT = { 'g-stil': 'wavy', 'g-gram': 'double', 'g-uebers': 'marker', 'g-wichtig': 'line' };
const snStyleOf = (k) => k.style || SN_STYLE_DEFAULT[k.id] || 'line';

// Linie immer von links nach rechts (damit "oben" = Richtung Text)
function snLineDir(a) {
  let x0 = a.x0, y0 = a.y0, x1 = a.x1, y1 = a.y1;
  if (x1 < x0) [x0, y0, x1, y1] = [x1, y1, x0, y0];
  const L = Math.hypot(x1 - x0, y1 - y0) || 1, ux = (x1 - x0) / L, uy = (y1 - y0) / L;
  return { x0, y0, x1, y1, L, ux, uy, nx: -uy, ny: ux };
}

// Punkte einer Unterstreichung (für SVG und Export); liefert Listen von Linienzügen
function snLinePolys(a, style) {
  const d = snLineDir(a);
  const off = (o) => [[d.x0 + d.nx * o, d.y0 + d.ny * o], [d.x1 + d.nx * o, d.y1 + d.ny * o]];
  if (style === 'double') return [off(-2.4), off(2.4)];
  if (style === 'wavy') {
    const waves = Math.max(2, Math.round(d.L / 10)), steps = waves * 8, pts = [];
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * d.L, o = 2.6 * Math.sin((i / 8) * 2 * Math.PI);
      pts.push([d.x0 + d.ux * t + d.nx * o, d.y0 + d.uy * t + d.ny * o]);
    }
    return [pts];
  }
  if (style === 'marker') return [off(-14)];
  return [off(0)];
}

function snMarkSvg(page, a, style, col, hot) {
  const k = hot ? 1.35 : 1;
  if (a.type === 'line') {
    const polys = snLinePolys(a, style);
    const d = polys.map((p) => p.map(([x, y], j) => (j ? 'L' : 'M') + num(x) + ' ' + num(y)).join('')).join('');
    if (style === 'marker') return `<path d="${d}" stroke="${col}" stroke-width="28" stroke-linecap="butt" opacity="${hot ? '.36' : '.24'}" fill="none"/>`;
    if (style === 'dotted') return `<path d="${d}" stroke="${col}" stroke-width="${num(3.2 * k)}" stroke-linecap="round" stroke-dasharray="0.1 6.5" fill="none"/>`;
    return `<path d="${d}" stroke="${col}" stroke-width="${num((style === 'line' ? 2.4 : 1.6) * k)}" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;
  }
  const b = snABounds(page, a);
  const rect = `x="${num(b[0])}" y="${num(b[1])}" width="${num(b[2] - b[0])}" height="${num(b[3] - b[1])}" rx="6"`;
  if (style === 'marker') return `<rect ${rect} fill="${col}" opacity="${hot ? '.3' : '.18'}"/>`;
  return `<rect ${rect} fill="${col}" fill-opacity="${hot ? '.12' : '.05'}" stroke="${col}" stroke-width="${num(1.4 * k)}"${style === 'dotted' ? ' stroke-dasharray="0.1 5" stroke-linecap="round"' : ''}/>`;
}

// Mitte einer Stelle (für Verbindungslinien und die Sprechblase)
function snACenter(page, a) {
  if (a.type === 'line') return [(a.x0 + a.x1) / 2, (a.y0 + a.y1) / 2];
  const b = snABounds(page, a);
  return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
}

function snMarksSvg(i) {
  const page = note.pages[i];
  let out = '';
  const openId = (snBubble && snBubble.page === i && snBubble.id) || (snOpen && snOpen.page === i && snOpen.id) || (snAddTo && snAddTo.page === i && snAddTo.id);
  for (const { n } of snNumbered(page)) {
    const k = snKeyOf(n.key), col = k.color, style = snStyleOf(k), hot = n.id === openId;
    const anchors = snAnchors(n);
    // Verbindungslinien: immer (Einstellung) oder nur, wenn die Notiz gerade offen ist
    if ((snLinks || hot) && anchors.length > 1) {
      const pts = anchors.map((a) => snACenter(page, a));
      for (let j = 1; j < pts.length; j++) {
        const [x0, y0] = pts[j - 1], [x1, y1] = pts[j];
        out += `<path d="M${num(x0)} ${num(y0)}L${num(x1)} ${num(y1)}" fill="none" stroke="${col}" stroke-width="1.4" stroke-dasharray="4 5" opacity="${hot ? '.8' : '.45'}"/>`;
      }
    }
    for (const a of anchors) out += snMarkSvg(page, a, style, col, hot);
  }
  return out;
}

// Liegt (x, y) auf einer Markierung? → Notiz-ID (oberste zuerst)
function snHitAt(i, x, y) {
  const page = note.pages[i];
  const list = snNumbered(page);
  for (let j = list.length - 1; j >= 0; j--) {
    const n = list[j].n;
    for (const a of snAnchors(n)) {
      if (a.type === 'line') {
        const d = snLineDir(a);
        // etwas großzügiger nach oben (dort steht das unterstrichene Wort)
        if (distToSegment(x, y, d.x0, d.y0, d.x1, d.y1) <= 12 || distToSegment(x, y, d.x0 + d.nx * -14, d.y0 + d.ny * -14, d.x1 + d.nx * -14, d.y1 + d.ny * -14) <= 12) return n.id;
      } else {
        const b = snABounds(page, a);
        if (x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3]) return n.id;
      }
    }
  }
  return null;
}

// Kurzes Antippen erkennen (mit jedem Werkzeug außer Radierer)
let snTap = null;
function snTapDown(e, canvas) {
  snTap = null;
  if (snAllHidden || window.noteTool === 'eraser') return;
  const r = canvas.getBoundingClientRect(), i = Number(canvas.dataset.page);
  const id = snHitAt(i, ((e.clientX - r.left) / r.width) * PAGE_W, ((e.clientY - r.top) / r.height) * PAGE_H);
  if (id) snTap = { pid: e.pointerId, page: i, id, x: e.clientX, y: e.clientY, t: performance.now() };
}
function snTapMove(e) {
  if (snTap && e.pointerId === snTap.pid && Math.hypot(e.clientX - snTap.x, e.clientY - snTap.y) > 9) snTap = null;
}
// true = es war ein Antippen einer Markierung (Strich/Textfeld werden dann verworfen)
function snTapUp(e) {
  const t = snTap;
  snTap = null;
  if (!t || e.pointerId !== t.pid || performance.now() - t.t > 450 || Math.hypot(e.clientX - t.x, e.clientY - t.y) > 9) return false;
  if (active && active.id === e.pointerId) cancelActive();
  if (textAction && textAction.id === e.pointerId) textAction = null;
  textSkip = performance.now();   // kein Textfeld nachträglich öffnen
  if (lasso && lasso.id === e.pointerId) { pageEls[lasso.page].live.removeAttribute('d'); lasso = null; }
  if (snAction && snAction.id === e.pointerId) { pageEls[snAction.page].live.removeAttribute('d'); snAction = null; }
  if (mathTap && mathTap.id === e.pointerId) mathTap = null;
  const tn = (note.pages[t.page].notes || []).find((x) => x.id === t.id);
  if (snQuiz && tn && snHasContent(tn)) openSnPanel(t.page, t.id);
  else snShowBubble(t.page, t.id);
  return true;
}

// Sprechblase mit dem Inhalt, direkt unter der Stelle
let snBubble = null;   // { page, id }
function snShowBubble(i, id) {
  snClosePop();
  const page = note.pages[i], n = (page.notes || []).find((x) => x.id === id);
  if (!n) return;
  const a = snAnchors(n)[0], b = snABounds(page, a);
  const pop = document.createElement('div');
  pop.className = 'sn-pop';
  pop.style.setProperty('--c', snKeyOf(n.key).color);
  pop.innerHTML = snContentHtml(n) + (snHasContent(n)
    ? '<div class="sn-pop-actions"><button type="button" data-a="edit">Bearbeiten</button></div>'
    : '<div class="sn-pop-actions"><button type="button" data-a="del">Entfernen</button><button type="button" data-a="edit">Notiz schreiben</button></div>');
  const cx = (b[0] + b[2]) / 2 / PAGE_W;
  pop.style.top = ((a.type === 'line' ? Math.max(a.y0, a.y1) + 8 : b[3] + 4) / PAGE_H) * 100 + '%';
  if (cx > 0.6) pop.style.right = Math.max(0, (1 - b[2] / PAGE_W) * 100 - 2) + '%';
  else pop.style.left = Math.max(1, (b[0] / PAGE_W) * 100 - 2) + '%';
  pageEls[i].wrap.append(pop);
  pop.addEventListener('pointerdown', (e) => e.stopPropagation());
  pop.querySelector('[data-a="edit"]').addEventListener('click', () => { snClosePop(); openSnPanel(i, id, true); });
  const del = pop.querySelector('[data-a="del"]');
  if (del) del.addEventListener('click', () => {
    snClosePop();
    snBeginSession(i);
    snRemove(i, id);
    snEndSession();
  });
  snPop = pop;
  snBubble = { page: i, id };
  drawPage(i);
}

// Inhalt einer Notiz (Text + Handschrift) als HTML
const SN_INK_W = 600, SN_INK_H = 260;
function snInkSvg(ink, cls = '') {
  if (!ink || !ink.length) return '';
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  ink.forEach((s) => { const b = itemBounds(s); x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]); });
  return `<svg class="${cls}" viewBox="${num(x0 - 4)} ${num(y0 - 4)} ${num(x1 - x0 + 8)} ${num(y1 - y0 + 8)}">${ink.map(penSvg).join('')}</svg>`;
}
function snContentHtml(n) {
  const k = snKeyOf(n.key);
  if (snQuiz && !snRevealed.has(n.id)) return `<div class="sn-key" style="--c:${k.color}">${escXml(k.name)}</div><div class="sn-quiz-cover">? antippen zum Abfragen</div>`;
  return `<div class="sn-key" style="--c:${k.color}">${escXml(k.name)}</div>` +
    (n.text ? `<div class="sn-text">${escXml(n.text)}</div>` : '') + snInkSvg(n.ink, 'sn-ink-view') +
    (!snHasContent(n) ? `<div class="muted small-text">${n.mark ? 'Nur markiert' : '(leer)'}</div>` : '');
}

// Spalte neben der Seite (nur wenn genug Platz ist)
function snColumnOn() {
  return snColumn && !snAllHidden && pagesBox.clientWidth >= 1000 && note.pages.some((p) => snNumbered(p).length);
}
function snRenderColumns() {
  if (!note) return;
  const on = snColumnOn();
  pagesInner.classList.toggle('sn-cols', on);
  applyZoomLayout();
  pageEls.forEach((pe, i) => {
    pe.col.innerHTML = '';
    if (!on) return;
    const page = note.pages[i];
    const items = snNumbered(page).filter(({ n }) => snHasContent(n)).map(({ n, no }) => ({ n, no, top: snBounds(page, n)[1] / PAGE_H }));
    items.sort((a, b) => a.top - b.top);
    let bottom = 0;
    const h = pe.wrap.clientHeight;
    for (const { n, no, top } of items) {
      const card = document.createElement('div');
      card.className = 'sn-card';
      card.style.setProperty('--c', snKeyOf(n.key).color);
      card.innerHTML = `<span class="sn-no">${no}</span>` + snContentHtml(n);
      if (snOpen && snOpen.id === n.id) card.classList.add('open');
      card.addEventListener('click', () => openSnPanel(i, n.id));
      pe.col.append(card);
      const y = Math.max(top * h - 10, bottom);
      card.style.top = y + 'px';
      bottom = y + card.offsetHeight + 8;
    }
  });
}
window.addEventListener('resize', () => requestAnimationFrame(snRenderColumns));

// Karte beim Antippen einer Marke
function snClosePop() {
  if (snPop) { snPop.remove(); snPop = null; }
  if (snBubble) { const p = snBubble.page; snBubble = null; if (pageEls[p]) drawPage(p); }
}


// Werkzeug: Linie unter Wörter ziehen = Unterstreichung, sonst Rechteck = Bereich
function snDown(e, canvas) {
  e.preventDefault();
  try { canvas.setPointerCapture(e.pointerId); } catch {}
  const r = canvas.getBoundingClientRect();
  const p = [((e.clientX - r.left) / r.width) * PAGE_W, ((e.clientY - r.top) / r.height) * PAGE_H];
  snAction = { id: e.pointerId, page: Number(canvas.dataset.page), rect: r, x0: p[0], y0: p[1], x1: p[0], y1: p[1] };
  const live = pageEls[snAction.page].live;
  for (const a of ['fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'style', 'stroke-dasharray']) live.removeAttribute(a);
  const col = snKeyOf(snKey).color;
  live.setAttribute('stroke', col);
  live.setAttribute('fill', 'none');
  live.setAttribute('stroke-linecap', 'round');
}
function snShape(a) {
  const dx = a.x1 - a.x0, dy = a.y1 - a.y0;
  return Math.abs(dy) < 28 && Math.abs(dx) > 20 && Math.abs(dy) < Math.abs(dx) * 0.35 ? 'line' : 'rect';
}
function snMove(e) {
  e.preventDefault();
  const a = snAction;
  a.x1 = ((e.clientX - a.rect.left) / a.rect.width) * PAGE_W;
  a.y1 = ((e.clientY - a.rect.top) / a.rect.height) * PAGE_H;
  const live = pageEls[a.page].live;
  if (snShape(a) === 'line') {
    live.setAttribute('stroke-width', '3.2');
    live.removeAttribute('stroke-dasharray');
    live.setAttribute('d', `M${num(a.x0)} ${num(a.y0)}L${num(a.x1)} ${num(a.y1)}`);
  } else {
    live.setAttribute('stroke-width', '1.5');
    live.setAttribute('stroke-dasharray', '6 5');
    live.setAttribute('d', `M${num(a.x0)} ${num(a.y0)}H${num(a.x1)}V${num(a.y1)}H${num(a.x0)}Z`);
  }
}
function snUp(e) {
  const a = snAction;
  snAction = null;
  const live = pageEls[a.page].live;
  live.removeAttribute('d');
  live.removeAttribute('stroke-dasharray');
  if (Math.hypot(a.x1 - a.x0, a.y1 - a.y0) < 12) return;   // nur getippt
  const anchor = snShape(a) === 'line'
    ? { type: 'line', x0: a.x0, y0: a.y0, x1: a.x1, y1: a.y1 }
    : { type: 'rect', x: Math.min(a.x0, a.x1), y: Math.min(a.y0, a.y1), w: Math.abs(a.x1 - a.x0), h: Math.abs(a.y1 - a.y0) };
  if (snAddTo && snAddTo.page === a.page) return snAddAnchor(anchor);
  snCreate(a.page, anchor);
}

// ---------- Weitere Stellen zu einer Notiz hinzufügen ----------
let snAddTo = null;    // { page, id }

function snStartAdd(page, id) {
  snAddTo = { page, id };
  if (window.noteTool !== 'snote') $('[data-tool="snote"]').click();
  let bar = $('#sn-addbar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'sn-addbar';
    bar.className = 'sn-addbar';
    document.body.append(bar);
  }
  const n = note.pages[page].notes.find((x) => x.id === id);
  bar.style.setProperty('--c', snKeyOf(n.key).color);
  bar.innerHTML = '<span>Weitere Stelle unterstreichen, einrahmen oder per Lasso wählen</span><button type="button">Fertig</button>';
  bar.querySelector('button').addEventListener('click', snStopAdd);
  bar.style.top = pagesBox.getBoundingClientRect().top + 8 + 'px';
  bar.hidden = false;
  drawPage(page);
}

function snStopAdd() {
  const a = snAddTo;
  snAddTo = null;
  const bar = $('#sn-addbar');
  if (bar) bar.hidden = true;
  if (a && note.pages[a.page]) drawPage(a.page);
}

function snAddAnchor(anchor, items) {
  const { page, id } = snAddTo;
  const pg = note.pages[page];
  const own = !snSession;            // ohne offenes Panel: eigener Rückgängig-Schritt
  if (own) snBeginSession(page);
  const aid = snId();
  pg.notes = pg.notes.map((n) => (n.id === id ? { ...n, anchor: undefined, anchors: snAnchors(n).concat({ ...anchor, aid }) } : n));
  if (items) {
    const set = new Set(items);
    pg.strokes = pg.strokes.map((s) => (set.has(s) ? { ...s, sn: (s.sn || []).concat(aid) } : s));
  }
  drawPage(page);
  saveNote();
  const n = pg.notes.find((x) => x.id === id);
  toast(`Stelle hinzugefügt (jetzt ${snAnchors(n).length})`);
  if (snOpen && snOpen.id === id) snRenderAnchorList();
  if (own) snEndSession();
}

// Side Note an die Lasso-Auswahl hängen
function snFromSelection() {
  if (!sel) return;
  const b = selBounds(sel.items);
  const page = sel.page, items = sel.items;
  deselectImage();
  const anchor = { type: 'items', x: b.x - 4, y: b.y - 4, w: b.w + 8, h: b.h + 8 };
  if (snAddTo && snAddTo.page === page) return snAddAnchor(anchor, items);
  snCreate(page, anchor, items);
}

// ---------- Side-Note-Panel (statt eines Fensters) ----------
// Liegt neben der Seite (breit) oder unten (iPad hochkant). Die Seite bleibt bedienbar, die
// Werkzeugleiste auch: geschrieben wird mit dem gerade gewählten Stift, Farbe und Dicke,
// der Radierer radiert im Panel. Alles wird sofort gespeichert.
const SN_TEMPLATES = {
  'g-stil': ['Alliteration', 'Anapher', 'Antithese', 'Asyndeton', 'Polysyndeton', 'Chiasmus', 'Klimax', 'Hyperbaton', 'Trikolon', 'Parallelismus', 'Metapher', 'Personifikation', 'Rhetorische Frage', 'Litotes', 'Ellipse', 'Polyptoton', 'Hendiadyoin', 'Enjambement'],
  'g-uebers': ['wörtlich:', 'sinngemäß:', 'alternativ:', 'besser:'],
  'g-gram': ['AcI', 'NcI', 'PC', 'Abl. abs.', 'Gerundium', 'Gerundivum', 'Konjunktiv', 'Relativsatz', 'Dativus finalis', 'Genitivus obiectivus', 'Ablativus instrumentalis'],
  'g-wichtig': ['Klausur!', 'Nachfragen', 'Merken', 'Vokabel lernen']
};
const snTemplatesOf = (k) => k.templates || SN_TEMPLATES[k.id] || [];
const SN_INK = { w: 600, h: 300 };
let snOpen = null;         // { page, id }
let snQuiz = store.get('snQuiz', false);
let snLinks = store.get('snLinks2', false);
const snRevealed = new Set();
let snInkAct = null;
let snTplMore = false;
// Schreibfläche: 600 Einheiten breit, Höhe passend zur tatsächlichen Größe (Panel seitlich / unten)
function snInkH() {
  const r = $('#snp-ink').getBoundingClientRect();
  return r.width ? (SN_INK.w * r.height) / r.width : SN_INK.h;
}

const snNote = () => snOpen && (note.pages[snOpen.page].notes || []).find((x) => x.id === snOpen.id);
function snUpdate(fn) {
  const { page, id } = snOpen;
  const pg = note.pages[page];
  pg.notes = pg.notes.map((n) => (n.id === id ? fn({ ...n }) : n));
  drawPage(page);
  saveNote();
}

// Neue Notiz anlegen (leer) und gleich im Panel öffnen
function snCreate(page, anchor, items) {
  if (snOpen) closeSnPanel();
  const pg = note.pages[page];
  const session = { page, before: pg.strokes.slice(), nbefore: (pg.notes || []).slice() };
  const aid = snId(), id = snId();
  pg.notes = (pg.notes || []).concat({ id, key: snKey, anchors: [{ ...anchor, aid }], text: '', ink: [], mark: snMarkOnly || undefined });
  if (items) {
    const set = new Set(items);
    pg.strokes = pg.strokes.map((s) => (set.has(s) ? { ...s, sn: (s.sn || []).concat(aid) } : s));
  }
  drawPage(page);
  if (snMarkOnly) {
    // Nur markieren: kein Panel, gleich ein Rückgängig-Schritt
    pushHistory([{ page, before: session.before, after: pg.strokes.slice(), nbefore: session.nbefore, nafter: pg.notes.slice() }]);
    saveNote();
    return;
  }
  openSnPanel(page, id, true, session);
}

// Markierung ohne Inhalt?
const snHasContent = (n) => !!((n.text || '').trim() || (n.ink && n.ink.length));
let snMarkOnly = store.get('snMarkOnly', false);

function snRemove(page, id) {
  const pg = note.pages[page];
  const n = (pg.notes || []).find((x) => x.id === id);
  if (!n) return;
  const aids = new Set(snAnchors(n).map((a) => a.aid));
  pg.notes = pg.notes.filter((x) => x.id !== id);
  pg.strokes = pg.strokes.map((s) => (s.sn && s.sn.some((v) => aids.has(v)) ? { ...s, sn: s.sn.filter((v) => !aids.has(v)) } : s));
  if (snAddTo && snAddTo.id === id) snStopAdd();
  drawPage(page);
  saveNote();
}

function snPanelLayout() {
  const p = $('#sn-panel');
  if (p.hidden) { pagesBox.style.paddingBottom = ''; return; }
  const r = pagesBox.getBoundingClientRect();
  const side = r.width >= 1000;
  p.classList.toggle('side', side);
  p.classList.toggle('sheet', !side);
  if (side) { p.style.top = r.top + 10 + 'px'; p.style.height = ''; }
  else p.style.top = '';
  pagesBox.style.paddingBottom = side ? '' : p.offsetHeight + 'px';
}
window.addEventListener('resize', () => requestAnimationFrame(snPanelLayout));

// Eine Sitzung im Panel (öffnen … schließen) wird ein Rückgängig-Schritt
let snSession = null;
function snBeginSession(page, before) {
  const pg = note.pages[page];
  snSession = before || { page, before: pg.strokes.slice(), nbefore: (pg.notes || []).slice() };
}
function snEndSession() {
  const s = snSession;
  snSession = null;
  if (!s || !note.pages[s.page]) return;
  const pg = note.pages[s.page], after = pg.strokes.slice(), nafter = (pg.notes || []).slice();
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  if (same(after, s.before) && same(nafter, s.nbefore)) return;
  pushHistory([{ page: s.page, before: s.before, after, nbefore: s.nbefore, nafter }]);
}

function openSnPanel(page, id, fresh, session) {
  if (snOpen && (snOpen.page !== page || snOpen.id !== id)) closeSnPanel();
  if (!snOpen) snBeginSession(page, session);
  snOpen = { page, id, fresh };
  const n = snNote();
  if (!n) return;
  const p = $('#sn-panel');
  p.hidden = false;
  $('#snp-text').value = n.text || '';
  snRenderPanel();
  snPanelLayout();
  snRenderInk();          // erst jetzt ist die Größe der Schreibfläche bekannt
  pageEls[page] && drawPage(page);
  // Stelle sichtbar machen (z. B. aus der Übersicht oder der Abfrage)
  const b = snBounds(note.pages[page], n), pe = pageEls[page];
  if (pe) {
    const r = pe.svg.getBoundingClientRect(), box = pagesBox.getBoundingClientRect();
    const y = r.top + (b[1] / PAGE_H) * r.height;
    const bottomFree = p.classList.contains('sheet') ? box.bottom - p.offsetHeight : box.bottom;
    if (y < box.top + 20 || y > bottomFree - 60) pagesBox.scrollBy({ top: y - box.top - 120, behavior: 'smooth' });
  }
  if (fresh && !snQuiz) setTimeout(() => $('#snp-text').focus(), 30);
}

function closeSnPanel() {
  if (!snOpen) return;
  const n = snNote(), { page, id } = snOpen;
  snOpen = null;
  snInkAct = null;
  $('#sn-panel').hidden = true;
  snPanelLayout();
  // leere Notiz ohne Inhalt nicht aufheben
  if (n && !snHasContent(n) && !n.mark) snRemove(page, id);
  else if (note.pages[page]) drawPage(page);
  snEndSession();
}

function snRenderPanel() {
  const n = snNote();
  if (!n) return closeSnPanel();
  const k = snKeyOf(n.key), p = $('#sn-panel');
  p.style.setProperty('--c', k.color);
  $('#snp-no').textContent = (note.pages[snOpen.page].notes.findIndex((x) => x.id === n.id) + 1);
  // Schlüssel
  const keys = $('#snp-keys');
  keys.innerHTML = '';
  snKeys().forEach((kk) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sn-chip' + (kk.id === n.key ? ' active' : '');
    b.style.setProperty('--c', kk.color);
    b.textContent = kk.name;
    b.addEventListener('click', () => {
      snKey = kk.id;
      store.set('snKey', snKey);
      snUpdate((m) => ({ ...m, key: kk.id }));
      snRenderPanel();
      renderColors();
    });
    keys.append(b);
  });
  // Vorlagen des Schlüssels
  const tp = $('#snp-templates');
  tp.innerHTML = '';
  const all = snTemplatesOf(k), shown = snTplMore ? all : all.slice(0, 6);
  shown.forEach((t) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = t;
    // Vorlage antippen nimmt dem Textfeld nicht den Fokus (sonst landet weiteres Tippen im Knopf)
    b.addEventListener('pointerdown', (e) => e.preventDefault());
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => {
      const ta = $('#snp-text');
      const cur = ta.value.replace(/\s+$/, '');
      ta.value = cur ? cur + (/[:]$/.test(cur) ? ' ' : '\n') + t + (/:$/.test(t) ? ' ' : '') : t + (/:$/.test(t) ? ' ' : '');
      snUpdate((m) => ({ ...m, text: ta.value }));
      if (/:$/.test(t)) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
    });
    tp.append(b);
  });
  if (all.length > 6) {
    const m = document.createElement('button');
    m.type = 'button';
    m.className = 'snp-more';
    m.textContent = snTplMore ? 'weniger' : `mehr … (${all.length - 6})`;
    m.addEventListener('pointerdown', (e) => e.preventDefault());
    m.addEventListener('click', () => { snTplMore = !snTplMore; snRenderPanel(); snPanelLayout(); });
    tp.append(m);
  }
  tp.hidden = !tp.children.length;
  // Abfrage-Modus: Inhalt verdecken, bis aufgedeckt
  const hidden = snQuiz && !snRevealed.has(n.id);
  $('#snp-body').hidden = hidden;
  $('#snp-quiz').hidden = !hidden;
  $('#snp-grade').hidden = !snQuiz || hidden;
  $('#snp-stats').textContent = n.quiz ? `gewusst ${n.quiz.ok || 0} × · nochmal ${n.quiz.bad || 0} ×` : '';
  snRenderInk();
  snRenderAnchorList();
}

function snRenderInk() {
  const n = snNote();
  if (!n) return;
  $('#snp-ink').setAttribute('viewBox', `0 0 ${SN_INK.w} ${num(snInkH())}`);
  $('#snp-ink').innerHTML = (n.ink || []).map(strokeSvg).join('') + (snInkAct && snInkAct.stroke ? strokeSvg(snInkAct.stroke) : '');
}

// Text: speichern beim Tippen (mit Schnell-Ersetzen wie in Textfeldern: -> →, ^2 ² …)
let snTextTimer = 0;
$('#snp-text').addEventListener('input', (e) => {
  const ta = e.target, pos = ta.selectionStart;
  if (e.inputType === 'insertText' && pos === ta.selectionEnd) {
    const before = ta.value.slice(0, pos);
    for (const [from, to] of textReplace ? REPLACE : []) {
      if (before.endsWith(from)) {
        ta.value = before.slice(0, -from.length) + to + ta.value.slice(pos);
        const np = pos - from.length + to.length;
        ta.setSelectionRange(np, np);
        break;
      }
    }
  }
  clearTimeout(snTextTimer);
  snTextTimer = setTimeout(() => snOpen && snUpdate((m) => ({ ...m, text: ta.value })), 300);
});
$('#snp-text').addEventListener('blur', () => { clearTimeout(snTextTimer); if (snOpen && snNote() && snNote().text !== $('#snp-text').value) snUpdate((m) => ({ ...m, text: $('#snp-text').value })); });

// Handschrift im Panel: Werkzeug, Farbe und Dicke kommen aus der Werkzeugleiste
(() => {
  const svg = $('#snp-ink');
  const pt = (e) => {
    const r = svg.getBoundingClientRect();
    const k = SN_INK.w / r.width;
    return [(e.clientX - r.left) * k, (e.clientY - r.top) * k, Math.round((e.pressure || 0.5) * 100) / 100];
  };
  const eraseAtInk = (x, y) => {
    const n = snNote(), r = ERASER_RADIUS * size;
    const keep = (n.ink || []).filter((s) => !strokeHit(s, x, y, r));
    if (keep.length !== (n.ink || []).length) { snUpdate((m) => ({ ...m, ink: keep })); snRenderInk(); }
  };
  svg.addEventListener('pointerdown', (e) => {
    if (!snOpen) return;
    if (e.pointerType === 'pen') lastPenTime = performance.now();
    if (e.pointerType === 'touch' && (penNear() || isPalm(e))) return;   // Handballen
    e.preventDefault();
    try { svg.setPointerCapture(e.pointerId); } catch {}
    const [x, y, p] = pt(e);
    const penEraser = e.pointerType === 'pen' && ((e.buttons & 32) || (e.buttons & 2));
    if (penEraser || tool === 'eraser') { snInkAct = { id: e.pointerId, erase: true }; eraseAtInk(x, y); return; }
    const marker = tool === 'marker';
    const stroke = { tool: marker ? 'marker' : 'pen', color: (marker ? MARKER_COLORS : PEN_COLORS)[colorSel[marker ? 'marker' : 'pen']], size, pts: [x, y, p] };
    if (tool === 'ball') stroke.style = 'ball';
    snInkAct = { id: e.pointerId, stroke, pressure: p };
    snRenderInk();
  });
  svg.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'pen') lastPenTime = performance.now();
    const a = snInkAct;
    if (!a || e.pointerId !== a.id) return;
    e.preventDefault();
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    for (const ev of evs.length ? evs : [e]) {
      const [x, y, p] = pt(ev);
      if (a.erase) { eraseAtInk(x, y); continue; }
      const q = a.stroke.pts, k = q.length;
      if (Math.hypot(x - q[k - 3], y - q[k - 2]) < 0.6) continue;
      a.pressure = a.pressure * 0.65 + p * 0.35;
      q.push(Math.round(x * 10) / 10, Math.round(y * 10) / 10, Math.round(a.pressure * 100) / 100);
    }
    if (!a.erase) { a.stroke = { ...a.stroke }; snRenderInk(); }
  });
  const end = (e) => {
    const a = snInkAct;
    if (!a || e.pointerId !== a.id) return;
    snInkAct = null;
    if (a.stroke) snUpdate((m) => ({ ...m, ink: (m.ink || []).concat(a.stroke) }));
    snRenderInk();
  };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
})();
$('#snp-ink-undo').addEventListener('click', () => { snUpdate((m) => ({ ...m, ink: (m.ink || []).slice(0, -1) })); snRenderInk(); });
$('#snp-close').addEventListener('click', closeSnPanel);
$('#snp-delete').addEventListener('click', () => {
  if (!snOpen || !confirm('Diese Side Note löschen?')) return;
  const { page, id } = snOpen;
  snOpen = null;
  $('#sn-panel').hidden = true;
  snPanelLayout();
  snRemove(page, id);
  snEndSession();
});
$('#snp-add').addEventListener('click', () => { if (snOpen) snStartAdd(snOpen.page, snOpen.id); });

// Stellen der Notiz (mit ✕ entfernen)
const SN_TYPE_NAMES = { line: 'Unterstreichung', rect: 'Bereich', items: 'Auswahl' };
function snRenderAnchorList() {
  const box = $('#snp-anchors'), n = snNote();
  box.innerHTML = '';
  if (!n) return;
  const list = snAnchors(n);
  list.forEach((a, j) => {
    const row = document.createElement('span');
    row.className = 'sn-anchor';
    row.innerHTML = `${j + 1}. ${SN_TYPE_NAMES[a.type] || 'Stelle'}` + (list.length > 1 ? ' <button type="button" aria-label="Stelle entfernen">✕</button>' : '');
    const x = row.querySelector('button');
    if (x) x.addEventListener('click', () => {
      const pg = note.pages[snOpen.page];
      if (a.type === 'items') pg.strokes = pg.strokes.map((s) => (s.sn && s.sn.includes(a.aid) ? { ...s, sn: s.sn.filter((v) => v !== a.aid) } : s));
      snUpdate((m) => ({ ...m, anchor: undefined, anchors: snAnchors(m).filter((_, k) => k !== j) }));
      snRenderAnchorList();
    });
    box.append(row);
  });
}

// ---------- Abfrage-Modus ----------
// Inhalte sind verdeckt. Marke antippen → aufdecken → "Gewusst" / "Nochmal" → nächste Notiz.
function setSnQuiz(on) {
  snQuiz = on;
  store.set('snQuiz', on);
  snRevealed.clear();
  if (snOpen) snRenderPanel();
  refreshSn();
}
$('#snp-reveal').addEventListener('click', () => { const n = snNote(); if (n) { snRevealed.add(n.id); snRenderPanel(); refreshSn(); } });
function snGrade(ok) {
  const n = snNote();
  if (!n) return;
  snUpdate((m) => ({ ...m, quiz: { ok: ((m.quiz && m.quiz.ok) || 0) + (ok ? 1 : 0), bad: ((m.quiz && m.quiz.bad) || 0) + (ok ? 0 : 1) } }));
  // nächste sichtbare Notiz (gleiche Seite, dann folgende Seiten)
  const all = [];
  note.pages.forEach((pg, i) => snNumbered(pg).forEach(({ n: m }) => snHasContent(m) && all.push([i, m.id])));
  const at = all.findIndex(([i, id]) => i === snOpen.page && id === n.id);
  const next = all.slice(at + 1).find(([, id]) => !snRevealed.has(id));
  if (next) openSnPanel(next[0], next[1]);
  else { closeSnPanel(); toast('Abfrage fertig – alle Side Notes durch'); }
}
$('#snp-ok').addEventListener('click', () => snGrade(true));
$('#snp-again').addEventListener('click', () => snGrade(false));

// ---------- Übersicht aller Side Notes (alle Notizen) ----------
let snOvKey = 'all';
async function openSnOverview() {
  let all = [];
  try { all = await noteDb.all(); } catch {}
  all = all.filter((n) => n.id !== note.id).concat(note);
  const render = () => {
    const chips = $('#snov-keys');
    chips.innerHTML = '';
    [{ id: 'all', name: 'Alle', color: '#8e8e93' }].concat(snGlobal).forEach((k) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sn-chip' + (snOvKey === k.id ? ' active' : '');
      b.style.setProperty('--c', k.color);
      b.textContent = k.name;
      b.addEventListener('click', () => { snOvKey = k.id; render(); });
      chips.append(b);
    });
    const q = $('#snov-search').value.trim().toLowerCase();
    const list = $('#snov-list');
    list.innerHTML = '';
    let count = 0;
    for (const nt of all.sort((a, b) => b.updated - a.updated)) {
      nt.pages.forEach((pg, pi) => (pg.notes || []).forEach((sn, j) => {
        if (snOvKey !== 'all' && sn.key !== snOvKey) return;
        if (!snHasContent(sn)) return;
        if (q && !((sn.text || '') + ' ' + noteName(nt)).toLowerCase().includes(q)) return;
        const k = snGlobal.find((x) => x.id === sn.key) || (nt.keys || []).find((x) => x.id === sn.key) || { name: 'Ohne Schlüssel', color: '#8e8e93' };
        const li = document.createElement('li');
        li.className = 'snov-item';
        li.style.setProperty('--c', k.color);
        li.innerHTML = `<div class="snov-head"><span class="sn-key">${escXml(k.name)}</span><span class="muted small-text">${escXml(noteName(nt))} · S. ${pi + 1} · Nr. ${j + 1}</span></div>` +
          (sn.text ? `<div class="sn-text">${escXml(sn.text)}</div>` : '') + snInkSvg(sn.ink, 'sn-ink-view');
        li.addEventListener('click', async () => {
          $('#snov-dialog').close();
          if (nt.id !== note.id) await openNote(nt);
          setTimeout(() => openSnPanel(pi, sn.id), 60);
        });
        list.append(li);
        count++;
      }));
    }
    if (!count) list.innerHTML = '<li class="muted">Keine Side Notes gefunden</li>';
  };
  $('#snov-search').oninput = render;
  render();
  $('#snov-dialog').showModal();
}

// ---------- Schlüssel (Ebenen) in der Werkzeugleiste und im Ebenen-Dialog ----------
// In der Leiste nur ein Knopf: aktueller Schlüssel ▾ – öffnet die Liste (auswählen, ein-/ausblenden, verwalten)
function renderSnBar(g) {
  const k = snKeyOf(snKey);
  const b = document.createElement('button');
  b.className = 'tool sn-current sn-layers-btn';
  b.style.setProperty('--c', k.color);
  b.title = 'Schlüssel und Ebenen';
  b.innerHTML = `<span class="dot"></span><span class="nm">${snQuiz ? 'Abfrage · ' : ''}${escXml(k.name)}</span><span>▾</span>`;
  b.addEventListener('click', openSnKeysDialog);
  const m = document.createElement('button');
  m.className = 'tool sn-mode' + (snMarkOnly ? ' active' : '');
  m.title = snMarkOnly ? 'Nur markieren (ohne Notiz) – antippen für: mit Notiz' : 'Mit Notiz – antippen für: nur markieren';
  m.innerHTML = snMarkOnly ? '<span>Nur</span><span>Strich</span>' : '<span>mit</span><span>Notiz</span>';
  m.addEventListener('click', () => {
    snMarkOnly = !snMarkOnly;
    store.set('snMarkOnly', snMarkOnly);
    renderColors();
    toast(snMarkOnly ? 'Nur markieren: Unterstreichen ohne Notiz' : 'Mit Notiz: nach dem Unterstreichen öffnet sich das Panel');
  });
  g.append(b, m);
}

function openSnKeysDialog() {
  renderSnKeysDialog();
  $('#snkeys-dialog').showModal();
}

function renderSnKeysDialog() {
  const list = $('#snkeys-list');
  list.innerHTML = '';
  snKeys().forEach((k) => {
    const row = document.createElement('div');
    row.className = 'snk-row' + (k.id === snKey ? ' current' : '');
    const hidden = snHidden.has(k.id);
    row.innerHTML = `<button type="button" class="snk-eye" aria-label="Ein-/ausblenden">${hidden ? '◌' : '●'}</button>` +
      `<button type="button" class="snk-color" style="--c:${k.color}" aria-label="Farbe ändern"></button>` +
      `<span class="snk-name">${escXml(k.name)}</span><span class="muted small-text">${k.global ? 'Global' : 'Diese Notiz'}</span>` +
      `<button type="button" class="btn link snk-style">${(SN_STYLES.find(([v]) => v === snStyleOf(k)) || SN_STYLES[0])[1]}</button><button type="button" class="btn link snk-tpl">Vorlagen</button><button type="button" class="btn link snk-ren">Umbenennen</button><button type="button" class="btn link danger-text snk-del">Löschen</button>`;
    row.style.opacity = hidden ? 0.5 : 1;
    const update = (fn) => {
      if (k.global) snGlobal = snGlobal.map((x) => (x.id === k.id ? fn({ ...x }) : x)).filter(Boolean);
      else { note.keys = (note.keys || []).map((x) => (x.id === k.id ? fn({ ...x }) : x)).filter(Boolean); saveNote(); }
      snSaveKeys();
      renderSnKeysDialog();
      refreshSn();
    };
    row.querySelector('.snk-name').addEventListener('click', () => {   // Name antippen = auswählen
      snKey = k.id;
      store.set('snKey', snKey);
      renderSnKeysDialog();
      renderColors();
    });
    row.querySelector('.snk-eye').addEventListener('click', () => {
      if (snHidden.has(k.id)) snHidden.delete(k.id); else snHidden.add(k.id);
      snSaveKeys();
      renderSnKeysDialog();
      refreshSn();
    });
    row.querySelector('.snk-color').addEventListener('click', () => update((x) => ({ ...x, color: SN_COLORS[(SN_COLORS.indexOf(x.color) + 1) % SN_COLORS.length] })));
    row.querySelector('.snk-style').addEventListener('click', () => {
      const j = SN_STYLES.findIndex(([v]) => v === snStyleOf(k));
      update((x) => ({ ...x, style: SN_STYLES[(j + 1) % SN_STYLES.length][0] }));
    });
    row.querySelector('.snk-tpl').addEventListener('click', () => {
      const v = prompt('Vorlagen für „' + k.name + '“ (mit Komma trennen):', snTemplatesOf(k).join(', '));
      if (v !== null) update((x) => ({ ...x, templates: v.split(',').map((t) => t.trim()).filter(Boolean) }));
    });
    row.querySelector('.snk-ren').addEventListener('click', () => {
      const name = (prompt('Neuer Name:', k.name) || '').trim().slice(0, 30);
      if (name) update((x) => ({ ...x, name }));
    });
    row.querySelector('.snk-del').addEventListener('click', () => {
      if (confirm(`Schlüssel „${k.name}“ löschen? Side Notes damit bleiben erhalten, werden aber grau.`)) update(() => null);
    });
    list.append(row);
  });
  $('#snk-all').checked = !snAllHidden;
  $('#snk-col').checked = snColumn;
  $('#snk-links').checked = snLinks;
  $('#snk-quiz').checked = snQuiz;
}

function snNewKey(global) {
  const name = (prompt(global ? 'Name des Schlüssels (für alle Notizen):' : 'Name des Schlüssels (nur diese Notiz):') || '').trim().slice(0, 30);
  if (!name) return;
  const used = snKeys().map((k) => k.color);
  const k = { id: (global ? 'g' : 'l') + Date.now().toString(36), name, color: SN_COLORS.find((c) => !used.includes(c)) || SN_COLORS[0] };
  if (global) snGlobal.push(k);
  else { note.keys = (note.keys || []).concat(k); saveNote(); }
  snKey = k.id;
  store.set('snKey', snKey);
  snSaveKeys();
  renderSnKeysDialog();
  refreshSn();
}
$('#snk-add-global').addEventListener('click', () => snNewKey(true));
$('#snk-add-local').addEventListener('click', () => snNewKey(false));
$('#snk-all').addEventListener('change', (e) => { snAllHidden = !e.target.checked; snSaveKeys(); refreshSn(); });
$('#snk-col').addEventListener('change', (e) => { snColumn = e.target.checked; store.set('snColumn2', snColumn); refreshSn(); });
$('#snk-links').addEventListener('change', (e) => { snLinks = e.target.checked; store.set('snLinks2', snLinks); refreshSn(); });
$('#snk-quiz').addEventListener('change', (e) => setSnQuiz(e.target.checked));
$('#snk-overview').addEventListener('click', () => { $('#snkeys-dialog').close(); openSnOverview(); });

function refreshSn() {
  if (!note) return;
  pageEls.forEach((_, i) => drawPage(i));
  renderColors();
  if (snOpen) snRenderPanel();
}

// ---------- Export: Markierungen als Striche, Notizen als eigene Seite ----------
function snLighten(hex, f) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return '#' + c.map((v) => Math.round(v + (255 - v) * f).toString(16).padStart(2, '0')).join('');
}
function snMarkItems(page, withNo) {
  const out = [];
  for (const { n, no } of snNumbered(page)) {
    const k = snKeyOf(n.key), col = k.color, style = snStyleOf(k);
    const line = (pts, size) => ({ tool: 'pen', style: 'ball', shape: true, color: col, size, pts: pts.flatMap(([x, y]) => [x, y, 0.5]) });
    const band = (pts) => ({ tool: 'marker', shape: true, color: snLighten(col, 0.55), size: 1.75, pts: pts.flatMap(([x, y]) => [x, y, 0.5]) });
    const anchors = snAnchors(n);
    if (snLinks) for (let j = 1; j < anchors.length; j++) out.push(line([snACenter(page, anchors[j - 1]), snACenter(page, anchors[j])], 0.6));
    for (const a of anchors) {
      if (a.type === 'line') {
        for (const p of snLinePolys(a, style)) {
          if (style === 'marker') out.push(band(p));
          else if (style === 'dotted') {
            const d = snLineDir(a);
            for (let t = 0; t <= d.L; t += 6.5) out.push(line([[d.x0 + d.ux * t, d.y0 + d.uy * t]], 2.4));
          } else out.push(line(p, style === 'line' ? 1.9 : 1.3));
        }
      } else {
        const b = snABounds(page, a);
        if (style === 'marker') out.push({ ...band([[b[0], (b[1] + b[3]) / 2], [b[2], (b[1] + b[3]) / 2]]), size: Math.max(1, (b[3] - b[1]) / 16) });
        else out.push(line([[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]], [b[0], b[1]]], 1.1));
      }
    }
    if (withNo && snHasContent(n)) {
      // kleine hochgestellte Zahl, damit die Liste zuzuordnen ist
      const a = anchors[anchors.length - 1], b = snABounds(page, a);
      const x = a.type === 'line' ? Math.max(a.x0, a.x1) + 3 : b[2] + 3, y = a.type === 'line' ? Math.min(a.y0, a.y1) - 34 : b[1] - 4;
      out.push({ tool: 'text', x, y, w: 30, size: 13, color: col, text: String(no), paras: [{ spans: [{ t: String(no), b: true }] }] });
    }
  }
  return out;
}

// Seiten für den Export: jede Seite mit Markierungen, danach eine Liste ihrer Side Notes
function snExportPages(pages, withList) {
  const out = [];
  pages.forEach((page) => {
    const notes = snNumbered(page).filter(({ n }) => snHasContent(n));
    if (!snNumbered(page).length) { out.push(page); return; }
    out.push({ ...page, strokes: page.strokes.concat(snMarkItems(page, withList)) });
    if (!withList || !notes.length) return;
    const pageNo = note.pages.indexOf(page) + 1;
    let list = { strokes: [], plain: true }, y = 70;
    const head = () => list.strokes.push({ tool: 'text', x: 70, y: 50, w: 860, size: 26, color: '#1c1c1e', text: '', paras: [{ h: true, spans: [{ t: `Side Notes – Seite ${pageNo}` }] }] });
    head();
    y = 110;
    for (const { n, no } of notes) {
      const k = snKeyOf(n.key);
      const paras = [{ spans: [{ t: `${no}  ${k.name}`, b: true, c: k.color }] }].concat((n.text || '').split('\n').map((l) => ({ spans: [{ t: l }] })));
      let t = { tool: 'text', x: 70, y, w: 860, size: 20, color: '#1c1c1e', text: '', paras };
      const h = layoutText(t).h;
      let inkH = 0, inkItems = [];
      if (n.ink && n.ink.length) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        n.ink.forEach((s) => { const b = itemBounds(s); x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]); });
        const kk = Math.min(1, 520 / Math.max(1, x1 - x0));
        inkH = (y1 - y0) * kk + 10;
        inkItems = n.ink.map((s) => transformItem(s, kk, x0, y0, 90, 0));
      }
      if (y + h + inkH > PAGE_H - 60 && list.strokes.length > 1) {
        out.push(list);
        list = { strokes: [], plain: true };
        head();
        y = 110;
        t = { ...t, y };
      }
      list.strokes.push(t);
      y += h + 4;
      inkItems.forEach((s) => list.strokes.push(transformItem(s, 1, 0, 0, 0, y)));
      y += inkH + 18;
    }
    out.push(list);
  });
  return out;
}

// ---------- Seitenübersicht ----------
// Alle Seiten als Vorschaubilder: antippen = hinspringen, ziehen = verschieben,
// Knöpfe: doppeln, leere Seite danach, löschen. Jede Aktion lässt sich rückgängig machen.
const THUMB_W = 170;
let ovDrag = null;

function openPageOverview() {
  commitEditor();
  if (snOpen) closeSnPanel();
  $('#page-overview').hidden = false;
  renderPageOverview();
}
function closePageOverview() { $('#page-overview').hidden = true; }

function renderPageOverview() {
  const grid = $('#po-grid');
  grid.innerHTML = '';
  const cur = viewCenter().page;
  note.pages.forEach((page, i) => {
    const item = document.createElement('div');
    item.className = 'po-item' + (i === cur ? ' current' : '');
    item.dataset.i = i;
    const c = document.createElement('canvas');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.round(THUMB_W * dpr);
    c.height = Math.round((THUMB_W * PAGE_H / PAGE_W) * dpr);
    const draw = () => renderPageTo(c.getContext('2d'), page, c.width / PAGE_W);
    draw();
    setTimeout(draw, 350);         // Bilder (PDF-Seiten) sind evtl. erst etwas später geladen
    const bar = document.createElement('div');
    bar.className = 'po-bar';
    bar.innerHTML = `<span class="po-no">${i + 1}</span>` +
      '<button type="button" data-a="dup" title="Doppeln">⧉</button>' +
      '<button type="button" data-a="add" title="Leere Seite danach">＋</button>' +
      `<button type="button" data-a="del" title="Löschen"${note.pages.length < 2 ? ' disabled' : ''}>🗑</button>`;
    item.append(c, bar);
    bar.addEventListener('pointerdown', (e) => e.stopPropagation());
    bar.querySelector('[data-a="dup"]').addEventListener('click', () => {
      if (note.pages.length >= MAX_PAGES) return toast('Maximale Seitenzahl erreicht');
      pagesChange(() => note.pages.splice(i + 1, 0, copyPages([page])[0]));
      renderPageOverview();
    });
    bar.querySelector('[data-a="add"]').addEventListener('click', () => {
      if (note.pages.length >= MAX_PAGES) return toast('Maximale Seitenzahl erreicht');
      pagesChange(() => note.pages.splice(i + 1, 0, { strokes: [] }));
      renderPageOverview();
    });
    bar.querySelector('[data-a="del"]').addEventListener('click', () => {
      if (note.pages.length < 2) return;
      pagesChange(() => note.pages.splice(i, 1));
      renderPageOverview();
      toast('Seite gelöscht – Rückgängig holt sie zurück');
    });
    item.addEventListener('pointerdown', (e) => ovDown(e, item, i));
    grid.append(item);
  });
  $('#po-count').textContent = `${note.pages.length} ${note.pages.length === 1 ? 'Seite' : 'Seiten'}`;
}

// Antippen springt zur Seite, Ziehen verschiebt sie
function ovDown(e, item, i) {
  if (e.button > 0) return;
  e.preventDefault();
  try { item.setPointerCapture(e.pointerId); } catch {}
  ovDrag = { id: e.pointerId, item, from: i, x: e.clientX, y: e.clientY, moving: false, to: i };
  const move = (ev) => {
    if (ev.pointerId !== ovDrag.id) return;
    const dx = ev.clientX - ovDrag.x, dy = ev.clientY - ovDrag.y;
    if (!ovDrag.moving && Math.hypot(dx, dy) < 10) return;
    ovDrag.moving = true;
    item.classList.add('dragging');
    item.style.transform = `translate(${dx}px, ${dy}px)`;
    item.style.pointerEvents = 'none';
    const under = document.elementFromPoint(ev.clientX, ev.clientY);
    const target = under && under.closest('.po-item');
    document.querySelectorAll('.po-item.drop').forEach((x) => x.classList.remove('drop'));
    if (target && target !== item) { target.classList.add('drop'); ovDrag.to = Number(target.dataset.i); }
  };
  const up = (ev) => {
    if (ev.pointerId !== ovDrag.id) return;
    item.removeEventListener('pointermove', move);
    item.removeEventListener('pointerup', up);
    item.removeEventListener('pointercancel', up);
    const d = ovDrag;
    ovDrag = null;
    if (!d.moving) {
      if (ev.type === 'pointercancel') return;
      closePageOverview();
      pageEls[i] && pageEls[i].wrap.scrollIntoView({ block: 'start' });
      return;
    }
    if (d.to !== d.from) {
      pagesChange(() => { const [p] = note.pages.splice(d.from, 1); note.pages.splice(d.to, 0, p); });
    }
    renderPageOverview();
  };
  item.addEventListener('pointermove', move);
  item.addEventListener('pointerup', up);
  item.addEventListener('pointercancel', up);
}

$('#page-overview-btn').addEventListener('click', openPageOverview);
$('#po-close').addEventListener('click', closePageOverview);
$('#po-add').addEventListener('click', () => {
  if (note.pages.length >= MAX_PAGES) return toast('Maximale Seitenzahl erreicht');
  pagesChange(() => note.pages.push({ strokes: [] }));
  renderPageOverview();
});

// ---------- Stift-Favoriten ----------
// Bis zu 4 gespeicherte Kombinationen aus Werkzeug, Farbe und Dicke. Antippen = umschalten,
// lange drücken (oder Rechtsklick) = entfernen, ＋ = aktuellen Stift merken.
const FAV_MAX = 4;
let penFavs = store.get('penFavs', []);

function favColor(f) { return (f.tool === 'marker' ? MARKER_COLORS : PEN_COLORS)[f.c] || '#1c1c1e'; }
function favActive(f) { return tool === f.tool && colorSel[f.tool === 'marker' ? 'marker' : 'pen'] === f.c && size === f.size; }

function renderFavs() {
  const g = $('#fav-group');
  if (!g) return;
  g.innerHTML = '';
  penFavs.forEach((f, j) => {
    const b = document.createElement('button');
    b.className = 'tool fav' + (favActive(f) ? ' active' : '');
    b.style.setProperty('--c', favColor(f));
    const icon = document.querySelector(`#toolbar [data-tool="${f.tool}"] svg`);
    b.innerHTML = (icon ? icon.outerHTML : '') + `<i style="width:${2 + f.size * 2}px;height:${2 + f.size * 2}px"></i>`;
    b.title = 'Favorit – lange drücken zum Entfernen';
    let timer = 0, long = false;
    b.addEventListener('pointerdown', () => { long = false; timer = setTimeout(() => { long = true; removeFav(j); }, 650); });
    const stop = () => clearTimeout(timer);
    b.addEventListener('pointerup', stop);
    b.addEventListener('pointerleave', stop);
    b.addEventListener('pointercancel', stop);
    b.addEventListener('contextmenu', (e) => { e.preventDefault(); stop(); long = true; removeFav(j); });
    b.addEventListener('click', () => { if (!long) applyFav(f); });
    g.append(b);
  });
  if (penFavs.length < FAV_MAX) {
    const add = document.createElement('button');
    add.className = 'tool fav-add';
    add.setAttribute('aria-label', 'Aktuellen Stift als Favorit merken');
    add.title = 'Aktuellen Stift als Favorit merken';
    add.textContent = '☆';
    add.addEventListener('click', () => {
      if (!['pen', 'ball', 'marker'].includes(tool)) return toast('Erst Füller, Kugelschreiber oder Textmarker wählen');
      const f = { tool, c: colorSel[tool === 'marker' ? 'marker' : 'pen'], size };
      if (penFavs.some((x) => x.tool === f.tool && x.c === f.c && x.size === f.size)) return toast('Diesen Stift gibt es schon als Favorit');
      penFavs = penFavs.concat(f);
      store.set('penFavs', penFavs);
      renderFavs();
      toast('Als Favorit gespeichert');
    });
    g.append(add);
  }
}

function applyFav(f) {
  const btn = document.querySelector(`#toolbar [data-tool="${f.tool}"]`);
  if (btn) btn.click();
  colorSel[f.tool === 'marker' ? 'marker' : 'pen'] = f.c;
  store.set('noteColors', colorSel);
  size = f.size;
  store.set('noteSize', size);
  renderSize();
  renderColors();
}

function removeFav(j) {
  if (!confirm('Diesen Favoriten entfernen?')) return;
  penFavs = penFavs.filter((_, k) => k !== j);
  store.set('penFavs', penFavs);
  renderFavs();
}

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

// Side Notes im PDF: Auswahl im Mehr-Menü
function renderSnPdf() {
  document.querySelectorAll('[data-snpdf]').forEach((b) => b.classList.toggle('active', b.dataset.snpdf === snPdf));
}
document.querySelectorAll('[data-snpdf]').forEach((b) => b.addEventListener('click', () => { snPdf = b.dataset.snpdf; store.set('snPdf', snPdf); renderSnPdf(); }));
renderSnPdf();
