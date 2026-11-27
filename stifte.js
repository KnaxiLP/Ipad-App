// ---------- Farbe & Stärke frei wählen ----------
// Ausfahrbares, verschiebbares Panel: Farbdreieck oder Farbviereck mit Farbton-Leiste,
// Voreinstellungen, zuletzt benutzte Farben und eine frei einstellbare Stiftstärke.
// Die gewählte Farbe ersetzt das aktive Farbfeld der Leiste, die Stärke den aktiven Stärke-Platz.

const PP_PEN_PRESETS = [
  '#1c1c1e', '#48484a', '#8e8e93', '#c7c7cc', '#ffffff', '#7c2d12',
  '#1e3a8a', '#2563eb', '#0ea5e9', '#0d9488', '#16a34a', '#65a30d',
  '#dc2626', '#e11d48', '#db2777', '#9333ea', '#6d28d9', '#4338ca',
  '#ea580c', '#f59e0b', '#ca8a04', '#a16207', '#be185d', '#0f766e'
];
const PP_MARKER_PRESETS = [
  '#fde047', '#fef08a', '#fdba74', '#fca5a5', '#f9a8d4', '#f0abfc',
  '#c4b5fd', '#a5b4fc', '#93c5fd', '#7dd3fc', '#5eead4', '#86efac',
  '#bef264', '#d9f99d', '#fcd34d', '#e5e7eb'
];
const PP_SIZES = [0.3, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8];
const PP_SMIN = 0.2, PP_SMAX = 10;

let ppMode = store.get('ppMode', 'tri');          // 'tri' = Dreieck, 'sq' = Viereck
let ppRecent = store.get('ppRecent', []);
let ppHsv = { h: 220, s: 0.8, v: 0.9 };
let ppDrag = false;      // gerade im Farbfeld am Ziehen → Farbton nicht aus dem Hex neu berechnen

const ppKey = () => (tool === 'marker' ? 'marker' : 'pen');
const ppPal = () => (ppKey() === 'marker' ? MARKER_COLORS : PEN_COLORS);
const ppCur = () => ppPal()[colorSel[ppKey()]] || '#1c1c1e';

// ---------- Farbumrechnung ----------
function ppHex2rgb(h) {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(String(h).trim());
  if (!m) return null;
  let x = m[1];
  if (x.length === 3) x = x.split('').map((c) => c + c).join('');
  return [parseInt(x.slice(0, 2), 16), parseInt(x.slice(2, 4), 16), parseInt(x.slice(4, 6), 16)];
}
const ppRgb2hex = (r, g, b) => '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
function ppHsv2rgb(h, s, v) {
  const f = (n) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return [f(5) * 255, f(3) * 255, f(1) * 255];
}
function ppRgb2hsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  return { h, s: mx ? d / mx : 0, v: mx };
}
const ppHex = () => ppRgb2hex(...ppHsv2rgb(ppHsv.h, ppHsv.s, ppHsv.v));
const ppMm = (sz) => (sz * BASE_WIDTH[tool === 'marker' ? 'marker' : 'pen'] * 210 / PAGE_W).toFixed(sz < 1 ? 2 : 1).replace('.', ',');
const ppT2s = (t) => Math.round(PP_SMIN * Math.pow(PP_SMAX / PP_SMIN, t / 100) * 100) / 100;
const ppS2t = (s) => Math.round(100 * Math.log(s / PP_SMIN) / Math.log(PP_SMAX / PP_SMIN));

// ---------- Aufbau ----------
const pp = document.createElement('div');
pp.className = 'pen-panel';
pp.id = 'pen-panel';
pp.hidden = true;
pp.innerHTML = `
  <div class="pp-head" title="Zum Verschieben ziehen">
    <span class="pp-grip" aria-hidden="true">⠿</span>
    <b>Farbe &amp; Stärke</b>
    <span class="pp-seg" role="group" aria-label="Farbfeld">
      <button type="button" data-pm="tri" aria-label="Farbdreieck">◭</button>
      <button type="button" data-pm="sq" aria-label="Farbviereck">▦</button>
    </span>
    <button type="button" class="pp-btn" id="pp-fold" aria-label="Einklappen">▾</button>
    <button type="button" class="pp-btn" id="pp-close" aria-label="Schließen">✕</button>
  </div>
  <div class="pp-body">
    <div class="pp-field"><canvas id="pp-cv"></canvas><span class="pp-knob" id="pp-knob"></span></div>
    <div class="pp-hue"><canvas id="pp-hue"></canvas><span class="pp-knob" id="pp-hknob"></span></div>
    <div class="pp-row">
      <span class="pp-now" id="pp-now"></span>
      <input class="text-input pp-hexin" id="pp-hexin" maxlength="7" spellcheck="false" autocomplete="off" aria-label="Farbe als Hex-Wert">
      <span class="muted pp-slot" id="pp-slot"></span>
    </div>
    <div class="pp-label">Voreinstellungen</div>
    <div class="pp-swatches" id="pp-presets"></div>
    <div class="pp-label" id="pp-recent-l">Zuletzt</div>
    <div class="pp-swatches" id="pp-recent"></div>
    <div class="pp-label">Stärke <span class="muted" id="pp-mm"></span></div>
    <div class="pp-size-row">
      <input type="range" id="pp-size" min="0" max="100" step="1" aria-label="Stärke">
      <svg class="pp-sample" id="pp-sample" viewBox="0 0 120 40" aria-hidden="true"><path d="M8 28 C 30 6, 52 6, 64 20 S 100 34, 112 12" fill="none" stroke-linecap="round"/></svg>
    </div>
    <div class="pp-sizes" id="pp-sizes"></div>
  </div>`;
document.body.append(pp);
const ppCv = pp.querySelector('#pp-cv'), ppHueCv = pp.querySelector('#pp-hue');
const ppW = 236, ppH = 176, ppHueH = 22;

function ppSetupCanvas(cv, w, h) {
  const d = Math.min(2, window.devicePixelRatio || 1);
  cv.width = Math.round(w * d);
  cv.height = Math.round(h * d);
  cv.style.width = w + 'px';
  cv.style.height = h + 'px';
  return d;
}

// Dreieck: oben reiner Farbton, unten links Weiß, unten rechts Schwarz
const ppTri = () => {
  const pad = 10, side = Math.min(ppW - 2 * pad, (ppH - 2 * pad) * 2 / Math.sqrt(3));
  const hgt = side * Math.sqrt(3) / 2, cx = ppW / 2, top = (ppH - hgt) / 2;
  return { H: [cx, top], Wt: [cx - side / 2, top + hgt], B: [cx + side / 2, top + hgt] };
};
function ppBary(x, y) {
  const { H, Wt, B } = ppTri();
  const det = (Wt[1] - B[1]) * (H[0] - B[0]) + (B[0] - Wt[0]) * (H[1] - B[1]);
  let a = ((Wt[1] - B[1]) * (x - B[0]) + (B[0] - Wt[0]) * (y - B[1])) / det;   // Farbton
  let b = ((B[1] - H[1]) * (x - B[0]) + (H[0] - B[0]) * (y - B[1])) / det;     // Weiß
  let c = 1 - a - b;                                                          // Schwarz
  return [a, b, c];
}

function ppDrawField() {
  const d = ppSetupCanvas(ppCv, ppW, ppH), ctx = ppCv.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ppCv.width, ppCv.height);
  const [hr, hg, hb] = ppHsv2rgb(ppHsv.h, 1, 1);
  if (ppMode === 'sq') {
    ctx.scale(d, d);
    ctx.fillStyle = ppRgb2hex(hr, hg, hb);
    ctx.fillRect(0, 0, ppW, ppH);
    let g = ctx.createLinearGradient(0, 0, ppW, 0);
    g.addColorStop(0, '#fff'); g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, ppW, ppH);
    g = ctx.createLinearGradient(0, 0, 0, ppH);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, '#000');
    ctx.fillStyle = g; ctx.fillRect(0, 0, ppW, ppH);
    return;
  }
  const img = ctx.createImageData(ppCv.width, ppCv.height), px = img.data;
  for (let j = 0; j < ppCv.height; j++) {
    for (let i = 0; i < ppCv.width; i++) {
      const [a, b, c] = ppBary(i / d, j / d);
      if (a < -0.01 || b < -0.01 || c < -0.01) continue;
      const k = (j * ppCv.width + i) * 4;
      px[k] = a * hr + b * 255;
      px[k + 1] = a * hg + b * 255;
      px[k + 2] = a * hb + b * 255;
      px[k + 3] = Math.min(a, b, c) < 0 ? 128 : 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

function ppDrawHue() {
  const d = ppSetupCanvas(ppHueCv, ppW, ppHueH), ctx = ppHueCv.getContext('2d');
  ctx.scale(d, d);
  const g = ctx.createLinearGradient(0, 0, ppW, 0);
  for (let i = 0; i <= 6; i++) g.addColorStop(i / 6, `hsl(${i * 60},100%,50%)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, ppW, ppHueH);
}

function ppPlaceKnobs() {
  const k = pp.querySelector('#pp-knob');
  let x, y;
  if (ppMode === 'sq') { x = ppHsv.s * ppW; y = (1 - ppHsv.v) * ppH; }
  else {
    const { H, Wt, B } = ppTri(), a = ppHsv.s * ppHsv.v, b = (1 - ppHsv.s) * ppHsv.v, c = 1 - ppHsv.v;
    x = a * H[0] + b * Wt[0] + c * B[0];
    y = a * H[1] + b * Wt[1] + c * B[1];
  }
  k.style.left = x + 'px';
  k.style.top = y + 'px';
  k.style.background = ppHex();
  const hk = pp.querySelector('#pp-hknob');
  hk.style.left = (ppHsv.h / 360) * ppW + 'px';
  hk.style.top = ppHueH / 2 + 'px';
  hk.style.background = `hsl(${ppHsv.h},100%,50%)`;
}

function ppSwatch(c, on, label) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'pp-sw' + (on ? ' active' : '');
  b.style.setProperty('--c', c);
  b.setAttribute('aria-label', label || c);
  b.addEventListener('click', () => { ppApply(c, true); ppFromHex(c); });
  return b;
}

// Panel an den aktuellen Zustand anpassen (Werkzeug, Farbe, Stärke)
function ppSync() {
  if (pp.hidden) return;
  const cur = ppCur();
  if (!ppDrag) ppFromHex(cur, true);
  pp.querySelector('#pp-now').style.background = cur;
  const hin = pp.querySelector('#pp-hexin');
  if (document.activeElement !== hin) hin.value = cur.toUpperCase();
  pp.querySelector('#pp-slot').textContent = (tool === 'marker' ? 'Textmarker' : 'Stift') + ' · Feld ' + (colorSel[ppKey()] + 1);
  const pre = pp.querySelector('#pp-presets');
  pre.innerHTML = '';
  (tool === 'marker' ? PP_MARKER_PRESETS : PP_PEN_PRESETS).forEach((c) => pre.append(ppSwatch(c, c.toLowerCase() === cur.toLowerCase())));
  const rec = pp.querySelector('#pp-recent');
  rec.innerHTML = '';
  ppRecent.forEach((c) => rec.append(ppSwatch(c, c.toLowerCase() === cur.toLowerCase())));
  rec.hidden = pp.querySelector('#pp-recent-l').hidden = !ppRecent.length;
  // Stärke
  const sl = pp.querySelector('#pp-size');
  if (document.activeElement !== sl) sl.value = ppS2t(size);
  pp.querySelector('#pp-mm').textContent = `${String(size).replace('.', ',')} · ≈ ${ppMm(size)} mm`;
  const path = pp.querySelector('#pp-sample path');
  path.setAttribute('stroke', cur);
  path.setAttribute('stroke-width', Math.max(0.6, Math.min(30, size * BASE_WIDTH[tool === 'marker' ? 'marker' : 'pen'] * 0.9)));
  path.setAttribute('stroke-opacity', tool === 'marker' ? 0.6 : 1);
  const sz = pp.querySelector('#pp-sizes');
  sz.innerHTML = '';
  PP_SIZES.forEach((v) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pp-sz' + (v === size ? ' active' : '');
    b.setAttribute('aria-label', 'Stärke ' + String(v).replace('.', ','));
    const dd = sizeDot(v);
    b.innerHTML = `<i style="width:${dd}px;height:${dd}px"></i>`;
    b.addEventListener('click', () => ppSize(v));
    sz.append(b);
  });
  pp.querySelectorAll('[data-pm]').forEach((b) => b.classList.toggle('active', b.dataset.pm === ppMode));
}

function ppFromHex(hex, quiet) {
  const rgb = ppHex2rgb(hex);
  if (!rgb) return;
  const n = ppRgb2hsv(...rgb);
  // Bei Grau/Schwarz bleibt der bisherige Farbton stehen (sonst springt die Leiste auf Rot)
  if (n.s < 0.01 || n.v < 0.01) n.h = ppHsv.h;
  const hueChanged = Math.abs(n.h - ppHsv.h) > 0.5;
  ppHsv = n;
  if (hueChanged || !quiet) ppDrawField();
  ppPlaceKnobs();
}

// Farbe in das aktive Farbfeld der Leiste übernehmen
function ppApply(hex, commit) {
  const pal = ppPal(), i = colorSel[ppKey()];
  if (pal[i] !== hex) {
    pal[i] = hex;
    store.set(ppKey() === 'marker' ? 'markerPalette' : 'penPalette', pal.slice());
    renderColors();
  }
  if (commit) ppRemember(hex);
}
function ppRemember(hex) {
  const presets = tool === 'marker' ? PP_MARKER_PRESETS : PP_PEN_PRESETS;
  if (presets.includes(hex)) return;
  ppRecent = [hex].concat(ppRecent.filter((c) => c !== hex)).slice(0, 12);
  store.set('ppRecent', ppRecent);
  ppSync();
}

function ppSize(v) {
  v = Math.max(PP_SMIN, Math.min(PP_SMAX, v));
  sizeSlots[sizeSel] = Math.round(v * 100) / 100;
  store.set('sizeSlots', sizeSlots);
  setSize(v, true);
}

// ---------- Bedienung ----------
function ppPick(e) {
  const r = ppCv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  if (ppMode === 'sq') {
    ppHsv.s = Math.max(0, Math.min(1, x / ppW));
    ppHsv.v = Math.max(0, Math.min(1, 1 - y / ppH));
  } else {
    let [a, b, c] = ppBary(x, y);
    a = Math.max(0, a); b = Math.max(0, b); c = Math.max(0, c);
    const t = a + b + c || 1;
    a /= t; b /= t;
    const v = a + b;
    ppHsv.v = v;
    ppHsv.s = v > 0.001 ? a / v : ppHsv.s;
  }
  ppPlaceKnobs();
  ppApply(ppHex(), false);
}
function ppHuePick(e) {
  const r = ppHueCv.getBoundingClientRect();
  ppHsv.h = Math.max(0, Math.min(359.9, ((e.clientX - r.left) / ppW) * 360));
  if (ppHsv.s < 0.05) ppHsv.s = 1;          // aus Grau heraus: gleich eine sichtbare Farbe
  if (ppHsv.v < 0.05) ppHsv.v = 1;
  ppDrawField();
  ppPlaceKnobs();
  ppApply(ppHex(), false);
}
function ppDragOn(el, fn) {
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    ppDrag = true;
    try { el.setPointerCapture(e.pointerId); } catch {}
    fn(e);
    const mv = (ev) => { if (ev.pointerId === e.pointerId) fn(ev); };
    const up = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      el.removeEventListener('pointermove', mv);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      ppDrag = false;
      ppRemember(ppHex());
    };
    el.addEventListener('pointermove', mv);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  });
}
ppDragOn(pp.querySelector('.pp-field'), ppPick);
ppDragOn(pp.querySelector('.pp-hue'), ppHuePick);

pp.querySelector('#pp-hexin').addEventListener('change', (e) => {
  let v = e.target.value.trim();
  if (!v.startsWith('#')) v = '#' + v;
  const rgb = ppHex2rgb(v);
  if (!rgb) { e.target.value = ppCur().toUpperCase(); return toast('Bitte z. B. #2563EB eingeben'); }
  const hex = ppRgb2hex(...rgb);
  ppApply(hex, true);
  ppFromHex(hex);
  e.target.blur();
});
pp.querySelector('#pp-size').addEventListener('input', (e) => ppSize(ppT2s(Number(e.target.value))));
pp.querySelectorAll('[data-pm]').forEach((b) => b.addEventListener('click', () => {
  ppMode = b.dataset.pm;
  store.set('ppMode', ppMode);
  ppDrawField();
  ppPlaceKnobs();
  ppSync();
}));
pp.querySelector('#pp-close').addEventListener('click', () => ppClose());
pp.querySelector('#pp-fold').addEventListener('click', () => {
  const f = !pp.classList.contains('folded');
  pp.classList.toggle('folded', f);
  pp.querySelector('#pp-fold').textContent = f ? '▴' : '▾';
  pp.querySelector('#pp-fold').setAttribute('aria-label', f ? 'Ausklappen' : 'Einklappen');
  ppClamp();
});

// ---------- Verschieben ----------
let ppPos = store.get('ppPos', null);
function ppClamp() {
  const w = pp.offsetWidth, h = pp.offsetHeight;
  let x = parseFloat(pp.style.left) || 0, y = parseFloat(pp.style.top) || 0;
  x = Math.max(4, Math.min(innerWidth - w - 4, x));
  y = Math.max(4, Math.min(innerHeight - Math.min(h, 60) - 4, y));
  pp.style.left = x + 'px';
  pp.style.top = y + 'px';
}
pp.querySelector('.pp-head').addEventListener('pointerdown', (e) => {
  if (e.target.closest('button')) return;
  e.preventDefault();
  const head = e.currentTarget;
  try { head.setPointerCapture(e.pointerId); } catch {}
  const sx = e.clientX - pp.offsetLeft, sy = e.clientY - pp.offsetTop;
  pp.classList.add('moving');
  const mv = (ev) => {
    if (ev.pointerId !== e.pointerId) return;
    pp.style.left = ev.clientX - sx + 'px';
    pp.style.top = ev.clientY - sy + 'px';
    ppClamp();
  };
  const up = (ev) => {
    if (ev.pointerId !== e.pointerId) return;
    head.removeEventListener('pointermove', mv);
    head.removeEventListener('pointerup', up);
    head.removeEventListener('pointercancel', up);
    pp.classList.remove('moving');
    ppPos = { x: pp.offsetLeft, y: pp.offsetTop };
    store.set('ppPos', ppPos);
  };
  head.addEventListener('pointermove', mv);
  head.addEventListener('pointerup', up);
  head.addEventListener('pointercancel', up);
});
window.addEventListener('resize', () => { if (!pp.hidden) ppClamp(); });

// ---------- Öffnen / Schließen ----------
function ppOpen(anchor) {
  pp.hidden = false;
  ppDrawHue();
  ppFromHex(ppCur());
  ppDrawField();
  ppSync();
  if (ppPos) {
    pp.style.left = ppPos.x + 'px';
    pp.style.top = ppPos.y + 'px';
  } else {
    const r = (anchor || $('#color-group')).getBoundingClientRect();
    pp.style.left = r.left + r.width / 2 - pp.offsetWidth / 2 + 'px';
    pp.style.top = r.bottom + 8 + 'px';
  }
  ppClamp();
  // „ausfahren“: aus dem Knopf heraus aufklappen
  const r = (anchor || pp).getBoundingClientRect();
  pp.style.transformOrigin = `${r.left + r.width / 2 - pp.offsetLeft}px ${r.top + r.height / 2 - pp.offsetTop}px`;
  pp.classList.remove('opening');
  void pp.offsetWidth;
  pp.classList.add('opening');
  document.querySelectorAll('.pp-open').forEach((b) => b.classList.add('active'));
}
function ppClose() {
  pp.hidden = true;
  document.querySelectorAll('.pp-open').forEach((b) => b.classList.remove('active'));
}
function ppToggle(anchor) {
  if (pp.hidden) ppOpen(anchor);
  else ppClose();
}
window.addEventListener('viewchange', () => { if (document.body.dataset.view !== 'notes') ppClose(); });
window.addEventListener('noteopen', () => { if (note && note.kind) ppClose(); });

renderColors();
renderSize();
