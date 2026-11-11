// ---------- Personenkonstellation (eigene Notiz-Art) ----------
// Eine Notiz mit kind: 'kmap' zeigt statt der Seiten ein Diagramm: Personen (Karten), Beziehungen
// (Pfeile mit Bezeichnung) und Gruppen (Kästen um mehrere Personen, z. B. Familien oder Lager).
// Gespeichert wird alles in note.kmap; die Notiz selbst läuft über dieselbe Speicherung wie alle Notizen.
//
// Bedienung: Doppeltippen auf die Fläche = neue Person · Person antippen und am ⊕ ziehen = Beziehung
// (loslassen auf leerer Fläche = neue Person mit Beziehung) · Fläche ziehen = verschieben · zwei Finger
// oder Strg+Mausrad = zoomen. Alles Weitere im Seitenfeld der ausgewählten Person/Beziehung/Gruppe.

const KM_COLORS = ['#2563eb', '#16a34a', '#dc2626', '#d97706', '#7c3aed', '#db2777', '#0891b2', '#6b7280'];
// Beziehungsarten: Farbe, Linie und Vorschläge für die Bezeichnung
const KM_TYPES = [
  { id: 'love', name: 'Liebe', color: '#db2777', dash: 'solid', labels: ['liebt', 'verliebt in', 'verheiratet', 'verlobt', 'Affäre', 'Ex'] },
  { id: 'friend', name: 'Freundschaft', color: '#16a34a', dash: 'solid', labels: ['befreundet', 'beste Freunde', 'vertraut', 'hilft', 'bewundert'] },
  { id: 'family', name: 'Familie', color: '#2563eb', dash: 'solid', labels: ['Vater von', 'Mutter von', 'Kind von', 'Geschwister', 'verheiratet', 'Onkel/Tante von', 'verwandt'] },
  { id: 'conflict', name: 'Konflikt', color: '#dc2626', dash: 'dashed', labels: ['hasst', 'Feind', 'Rivale', 'streitet mit', 'misstraut', 'eifersüchtig auf'] },
  { id: 'power', name: 'Macht', color: '#d97706', dash: 'solid', labels: ['abhängig von', 'befiehlt', 'unterdrückt', 'erpresst', 'Vorgesetzter von'] },
  { id: 'work', name: 'Beruf', color: '#7c3aed', dash: 'dotted', labels: ['arbeitet für', 'Kollege', 'Lehrer von', 'Schüler von', 'Partner'] },
  { id: 'neutral', name: 'Sonstige', color: '#6b7280', dash: 'solid', labels: ['kennt', 'trifft', 'beeinflusst', 'beobachtet'] }
];
const KM_DASH = { solid: '', dashed: '9 6', dotted: '1.5 6' };
const KM_FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Arial, sans-serif';
const kmType = (id) => KM_TYPES.find((t) => t.id === id) || KM_TYPES[KM_TYPES.length - 1];
const kmId = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const kmEsc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Farbe mit Weiß mischen (helle Kartenfarbe)
function kmTint(hex, f) {
  const n = parseInt(hex.slice(1), 16), c = [n >> 16, (n >> 8) & 255, n & 255].map((v) => Math.round(v + (255 - v) * f));
  return `rgb(${c.join(',')})`;
}

let km = null;              // Daten der offenen Konstellation (= note.kmap)
let kmSel = null;           // { t: 'p'|'l'|'g', id }
let kmView = { x: 0, y: 0, z: 1 };   // Bildschirm = Welt * z + (x, y)
let kmUndo = [], kmRedo = [];
let kmFocus = false, kmLegend = store.get('kmLegend', true), kmLinkMode = false;
let kmAct = null;           // laufende Geste
const kmPtrs = new Map();   // aktive Finger/Stifte (für Zwei-Finger-Zoom)
let kmPinch = null;
let kmLastType = store.get('kmLastType', 'friend');
let kmRaf = 0;

const kmEl = (s) => document.querySelector(s);
const kmStage = () => kmEl('#km-stage');
const kmPerson = (id) => km.persons.find((p) => p.id === id);
const kmLink = (id) => km.links.find((l) => l.id === id);
const kmGroup = (id) => km.groups.find((g) => g.id === id);
const kmBlank = () => ({ persons: [], links: [], groups: [], view: null });

// ---- Notiz anlegen / öffnen ----
async function kmCreate(folder) {
  const n = newNote();
  n.kind = 'kmap';
  n.kmap = kmBlank();
  if (folder) n.folder = folder;
  await noteDb.put(n).catch(() => {});
  showView('notes');
  await openNote(n);
  toast('Neue Personenkonstellation – doppeltippe auf die Fläche für eine Person');
}

function kmOpen(n) {
  if (!n.kmap) n.kmap = kmBlank();
  km = n.kmap;
  ['persons', 'links', 'groups'].forEach((k) => { if (!Array.isArray(km[k])) km[k] = []; });
  kmSel = null; kmUndo = []; kmRedo = []; kmAct = null; kmPtrs.clear(); kmPinch = null;
  kmLinkMode = false; kmFocus = false;
  kmBuild();
  if (km.view) kmView = { ...km.view };
  else requestAnimationFrame(() => kmFit());
  kmRender();
  kmPanel();
  kmBarState();
}

// ---- Änderungen, Rückgängig ----
const kmSnap = () => JSON.stringify({ persons: km.persons, links: km.links, groups: km.groups });
function kmChange(fn) {
  kmUndo.push(kmSnap());
  if (kmUndo.length > 80) kmUndo.shift();
  kmRedo = [];
  fn();
  kmSaved();
}
function kmSaved() {
  km.view = { ...kmView };
  saveNote();
  kmRender();
  kmBarState();
}
function kmRestore(from, to) {
  if (!from.length) return;
  to.push(kmSnap());
  const s = JSON.parse(from.pop());
  km.persons = s.persons; km.links = s.links; km.groups = s.groups;
  if (kmSel && !kmSelObj()) kmSel = null;
  kmSaved();
  kmPanel();
}
const kmSelObj = () => kmSel && (kmSel.t === 'p' ? kmPerson(kmSel.id) : kmSel.t === 'l' ? kmLink(kmSel.id) : kmGroup(kmSel.id));

// ---- Geometrie ----
let kmCtx = null;
function kmMeasure(text, font) {
  if (!kmCtx) kmCtx = document.createElement('canvas').getContext('2d');
  kmCtx.font = font;
  return kmCtx.measureText(text).width;
}
function kmBox(p) {
  const big = !!p.big, fs = big ? 17 : 15;
  const nameW = kmMeasure((p.emoji ? p.emoji + ' ' : '') + (p.name || '?'), `${big ? 700 : 600} ${fs}px ${KM_FONT}`);
  const roleW = p.role ? kmMeasure(p.role, `12px ${KM_FONT}`) : 0;
  let w = Math.max(78, Math.max(nameW, roleW) + 28), h = (p.role ? 44 : 32) + (big ? 8 : 0);
  if (p.shape === 'ellipse') { w = w * 1.25 + 8; h += 14; }
  return { x: p.x - w / 2, y: p.y - h / 2, w, h, fs, big };
}
// Randpunkt der Karte in Richtung (dx, dy) ab der Mitte
function kmEdge(p, b, dx, dy) {
  const len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
  let t;
  if (p.shape === 'ellipse') t = 1 / Math.sqrt((ux / (b.w / 2)) ** 2 + (uy / (b.h / 2)) ** 2);
  else t = Math.min(Math.abs(ux) > 1e-6 ? b.w / 2 / Math.abs(ux) : Infinity, Math.abs(uy) > 1e-6 ? b.h / 2 / Math.abs(uy) : Infinity);
  return [p.x + ux * (t + 3), p.y + uy * (t + 3)];
}
// Szene: alles, was gezeichnet wird – einmal berechnet, für Bildschirm (SVG) und Export (Canvas)
function kmScene() {
  const boxes = new Map(km.persons.map((p) => [p.id, kmBox(p)]));
  const groups = km.groups.map((g) => {
    const ms = km.persons.filter((p) => p.group === g.id);
    if (!ms.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    ms.forEach((p) => { const b = boxes.get(p.id); x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); });
    return { g, x: x0 - 18, y: y0 - 34, w: x1 - x0 + 36, h: y1 - y0 + 52 };
  }).filter(Boolean);
  // mehrere Beziehungen zwischen denselben zwei Personen: nebeneinander gebogen
  const pairs = new Map();
  km.links.forEach((l) => { const k = [l.a, l.b].sort().join('|'); if (!pairs.has(k)) pairs.set(k, []); pairs.get(k).push(l); });
  const links = [];
  for (const l of km.links) {
    const A = kmPerson(l.a), B = kmPerson(l.b);
    if (!A || !B || A === B) continue;
    const same = pairs.get([l.a, l.b].sort().join('|'));
    const k = same.indexOf(l), n = same.length;
    // Richtung immer von der „kleineren“ Id aus, damit gegenläufige Beziehungen nicht übereinander liegen
    const flip = l.a > l.b ? -1 : 1;
    const off = (k - (n - 1) / 2) * 34 * flip + (l.bend || 0);
    const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2, dx = B.x - A.x, dy = B.y - A.y, d = Math.hypot(dx, dy) || 1;
    const cx = mx - (dy / d) * off * 2, cy = my + (dx / d) * off * 2;
    const a = kmEdge(A, boxes.get(A.id), cx - A.x, cy - A.y), b = kmEdge(B, boxes.get(B.id), cx - B.x, cy - B.y);
    const ty = kmType(l.type), w = 1.4 + (l.w || 2) * 0.8;
    const arrows = [];
    if (l.dir === 'ab' || l.dir === 'both') arrows.push({ x: b[0], y: b[1], ang: Math.atan2(b[1] - cy, b[0] - cx) });
    if (l.dir === 'ba' || l.dir === 'both') arrows.push({ x: a[0], y: a[1], ang: Math.atan2(a[1] - cy, a[0] - cx) });
    const lx = 0.25 * a[0] + 0.5 * cx + 0.25 * b[0], ly = 0.25 * a[1] + 0.5 * cy + 0.25 * b[1];
    links.push({ l, a, b, c: [cx, cy], color: l.color || ty.color, dash: l.dash || ty.dash, w, arrows, label: l.label ? { x: lx, y: ly, text: l.label } : null });
  }
  return { boxes, groups, links };
}
function kmBounds(sc) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x, y, w, h) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + w); y1 = Math.max(y1, y + h); };
  sc.boxes.forEach((b) => add(b.x, b.y, b.w, b.h));
  sc.groups.forEach((g) => add(g.x, g.y, g.w, g.h));
  sc.links.forEach((k) => { if (k.label) add(k.label.x - 50, k.label.y - 12, 100, 24); });
  return x0 === Infinity ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
// Nachbarn der ausgewählten Person (für den Fokus)
function kmNeighbors() {
  if (!kmFocus || !kmSel || kmSel.t !== 'p') return null;
  const s = new Set([kmSel.id]);
  km.links.forEach((l) => { if (l.a === kmSel.id) s.add(l.b); if (l.b === kmSel.id) s.add(l.a); });
  return s;
}

// ---- Zeichnen (Bildschirm) ----
function kmArrowPts(ar, w) {
  const s = 7 + w * 2.2, a = ar.ang;
  return [[ar.x, ar.y], [ar.x - s * Math.cos(a - 0.42), ar.y - s * Math.sin(a - 0.42)], [ar.x - s * Math.cos(a + 0.42), ar.y - s * Math.sin(a + 0.42)]];
}
function kmPersonPath(p, b) {
  if (p.shape === 'ellipse') return `<ellipse cx="${p.x}" cy="${p.y}" rx="${b.w / 2}" ry="${b.h / 2}"`;
  const r = p.shape === 'pill' ? b.h / 2 : 10;
  return `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="${r}"`;
}
function kmRender() {
  if (!km) return;
  cancelAnimationFrame(kmRaf);
  kmRaf = 0;
  const svg = kmEl('#km-svg');
  if (!svg) return;
  const sc = kmScene(), nb = kmNeighbors();
  const dim = (on) => (on ? ' opacity="0.18"' : '');
  let h = `<g transform="translate(${kmView.x} ${kmView.y}) scale(${kmView.z})">`;
  for (const G of sc.groups) {
    const sel = kmSel && kmSel.t === 'g' && kmSel.id === G.g.id, c = G.g.color || KM_COLORS[7];
    h += `<g data-g="${G.g.id}"${dim(nb && !km.persons.some((p) => p.group === G.g.id && nb.has(p.id)))}>` +
      `<rect x="${G.x}" y="${G.y}" width="${G.w}" height="${G.h}" rx="16" fill="${c}" fill-opacity="0.09" stroke="${c}" stroke-width="${sel ? 3 : 1.6}" stroke-dasharray="${sel ? '' : '7 5'}" class="km-gbox"/>` +
      `<text x="${G.x + 14}" y="${G.y + 21}" fill="${c}" font-weight="700" font-size="14" class="km-gtitle" data-gt="${G.g.id}">${kmEsc(G.g.name || 'Gruppe')} ⠿</text></g>`;
  }
  for (const k of sc.links) {
    const sel = kmSel && kmSel.t === 'l' && kmSel.id === k.l.id, off = nb && !(nb.has(k.l.a) && nb.has(k.l.b) && (k.l.a === kmSel.id || k.l.b === kmSel.id));
    const d = `M${k.a[0]} ${k.a[1]} Q${k.c[0]} ${k.c[1]} ${k.b[0]} ${k.b[1]}`;
    h += `<g data-l="${k.l.id}"${dim(off)}>` + (sel ? `<path d="${d}" stroke="${k.color}" stroke-opacity="0.25" stroke-width="${k.w + 9}" fill="none" stroke-linecap="round"/>` : '') +
      `<path d="${d}" stroke="transparent" stroke-width="22" fill="none"/>` +
      `<path d="${d}" stroke="${k.color}" stroke-width="${k.w}" fill="none" stroke-linecap="round" stroke-dasharray="${KM_DASH[k.dash] || ''}"/>` +
      k.arrows.map((ar) => `<polygon points="${kmArrowPts(ar, k.w).map((q) => q.join(',')).join(' ')}" fill="${k.color}"/>`).join('') + '</g>';
  }
  for (const p of km.persons) {
    const b = sc.boxes.get(p.id), c = p.color || KM_COLORS[0], sel = kmSel && kmSel.t === 'p' && kmSel.id === p.id;
    h += `<g data-p="${p.id}" class="km-person"${dim(nb && !nb.has(p.id))}>` +
      (sel ? `${kmPersonPath(p, { x: b.x - 5, y: b.y - 5, w: b.w + 10, h: b.h + 10 })} fill="none" stroke="var(--accent)" stroke-width="2" stroke-dasharray="5 4"/>` : '') +
      `${kmPersonPath(p, b)} fill="${kmTint(c, 0.86)}" stroke="${c}" stroke-width="${b.big ? 3.2 : 1.8}"/>` +
      `<text x="${p.x}" y="${p.role ? b.y + b.h / 2 - 3 : p.y + b.fs * 0.36}" text-anchor="middle" font-size="${b.fs}" font-weight="${b.big ? 700 : 600}" fill="#1c1c1e">${kmEsc((p.emoji ? p.emoji + ' ' : '') + (p.name || '?'))}</text>` +
      (p.role ? `<text x="${p.x}" y="${b.y + b.h / 2 + 14}" text-anchor="middle" font-size="12" fill="#55555c">${kmEsc(p.role)}</text>` : '') +
      (p.desc ? `<circle cx="${b.x + b.w - 2}" cy="${b.y + 2}" r="4.5" fill="${c}"/>` : '') + '</g>';
  }
  for (const k of sc.links) {
    if (!k.label) continue;
    const off = nb && !((k.l.a === kmSel.id || k.l.b === kmSel.id));
    const w = kmMeasure(k.label.text, `600 12px ${KM_FONT}`) + 14;
    h += `<g data-l="${k.l.id}"${dim(off)}><rect x="${k.label.x - w / 2}" y="${k.label.y - 11}" width="${w}" height="22" rx="11" fill="#fff" stroke="${k.color}" stroke-width="1.2"/>` +
      `<text x="${k.label.x}" y="${k.label.y + 4}" text-anchor="middle" font-size="12" font-weight="600" fill="${k.color}">${kmEsc(k.label.text)}</text></g>`;
  }
  // ⊕ zum Verbinden an der ausgewählten Person
  if (kmSel && kmSel.t === 'p') {
    const p = kmPerson(kmSel.id), b = sc.boxes.get(p.id);
    h += `<g class="km-knob" data-knob="${p.id}"><circle cx="${b.x + b.w + 16}" cy="${p.y}" r="13" fill="var(--accent)"/><path d="M${b.x + b.w + 10} ${p.y}h12M${b.x + b.w + 16} ${p.y - 6}v12" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/></g>`;
  }
  // Vorschau beim Ziehen einer Beziehung
  if (kmAct && kmAct.type === 'link' && kmAct.to) {
    const A = kmPerson(kmAct.from), T = kmAct.target && kmPerson(kmAct.target);
    const [tx, ty] = T ? [T.x, T.y] : kmAct.to;
    h += `<path d="M${A.x} ${A.y} L${tx} ${ty}" stroke="${kmType(kmLastType).color}" stroke-width="3" stroke-dasharray="8 6" fill="none"/>`;
    if (T) { const b = sc.boxes.get(T.id); h += `${kmPersonPath(T, { x: b.x - 6, y: b.y - 6, w: b.w + 12, h: b.h + 12 })} fill="none" stroke="${kmType(kmLastType).color}" stroke-width="3"/>`; }
  }
  h += '</g>';
  svg.innerHTML = h;
  kmEl('#km-empty').hidden = km.persons.length > 0;
  kmEl('#km-zoom').textContent = Math.round(kmView.z * 100) + '%';
  kmRenderLegend();
}
const kmRenderSoon = () => { if (!kmRaf) kmRaf = requestAnimationFrame(kmRender); };

function kmUsedTypes() {
  const used = new Map();
  km.links.forEach((l) => { const t = kmType(l.type); if (!used.has(t.id)) used.set(t.id, { t, labels: new Set() }); if (l.label) used.get(t.id).labels.add(l.label); });
  return [...used.values()];
}
function kmRenderLegend() {
  const box = kmEl('#km-legend');
  const used = kmUsedTypes();
  box.hidden = !kmLegend || !used.length;
  box.innerHTML = '<b>Legende</b>' + used.map(({ t }) => `<div><svg width="30" height="10"><path d="M2 5h26" stroke="${t.color}" stroke-width="3" stroke-dasharray="${KM_DASH[t.dash]}" stroke-linecap="round"/></svg>${kmEsc(t.name)}</div>`).join('');
}

// ---- Treffer ----
function kmWorld(e) {
  const r = kmStage().getBoundingClientRect();
  return [(e.clientX - r.left - kmView.x) / kmView.z, (e.clientY - r.top - kmView.y) / kmView.z];
}
function kmHit(e) {
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const g = el && el.closest && el.closest('[data-knob],[data-p],[data-l],[data-gt]');
  if (!g || !kmEl('#km-svg').contains(g)) return null;
  if (g.dataset.knob) return { t: 'knob', id: g.dataset.knob };
  if (g.dataset.p) return { t: 'p', id: g.dataset.p };
  if (g.dataset.l) return { t: 'l', id: g.dataset.l };
  return { t: 'g', id: g.dataset.gt };
}
function kmPersonAt(x, y, except) {
  for (let i = km.persons.length - 1; i >= 0; i--) {
    const p = km.persons[i];
    if (p.id === except) continue;
    const b = kmBox(p);
    if (x >= b.x - 6 && x <= b.x + b.w + 6 && y >= b.y - 6 && y <= b.y + b.h + 6) return p;
  }
  return null;
}

// ---- Gesten ----
function kmDown(e) {
  if (!km || e.button > 0) return;
  // Handballen: Finger zählen nicht, solange der Stift schreibt
  if (e.pointerType === 'touch' && kmAct && kmAct.pen) return;
  e.preventDefault();
  kmStage().setPointerCapture(e.pointerId);
  kmPtrs.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
  if (kmPtrs.size === 2 && [...kmPtrs.values()].every((p) => p.type === 'touch')) {
    // zwei Finger: zoomen & verschieben – angefangene Geste verwerfen
    if (kmAct && kmAct.moved && kmAct.before) { const s = JSON.parse(kmAct.before); km.persons = s.persons; }
    kmAct = null;
    const [a, b] = [...kmPtrs.values()];
    kmPinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, view: { ...kmView } };
    return;
  }
  if (kmPtrs.size > 1) return;
  const [wx, wy] = kmWorld(e);
  const hit = kmHit(e);
  const now = performance.now();
  const dbl = kmLastTap && now - kmLastTap.t < 380 && Math.hypot(e.clientX - kmLastTap.x, e.clientY - kmLastTap.y) < 24;
  kmLastTap = { t: now, x: e.clientX, y: e.clientY };
  const base = { id: e.pointerId, sx: e.clientX, sy: e.clientY, wx, wy, moved: false, pen: e.pointerType === 'pen' };
  if (hit && hit.t === 'knob') {
    kmAct = { ...base, type: 'link', from: hit.id, to: null, target: null };
  } else if (hit && hit.t === 'p') {
    const p = kmPerson(hit.id);
    if (dbl && kmSel && kmSel.id === p.id) { kmLastTap = null; kmPanel(true); return; }
    if (kmLinkMode) { kmAct = { ...base, type: 'link', from: p.id, to: null, target: null }; return; }
    kmSelect({ t: 'p', id: p.id });
    kmAct = { ...base, type: 'move', ids: [p.id], start: [[p.x, p.y]], before: kmSnap() };
  } else if (hit && hit.t === 'g') {
    kmSelect({ t: 'g', id: hit.id });
    const ms = km.persons.filter((p) => p.group === hit.id);
    kmAct = { ...base, type: 'move', ids: ms.map((p) => p.id), start: ms.map((p) => [p.x, p.y]), before: kmSnap() };
  } else if (hit && hit.t === 'l') {
    kmSelect({ t: 'l', id: hit.id });
    kmAct = { ...base, type: 'pan', view: { ...kmView } };
  } else {
    if (dbl) { kmLastTap = null; kmAddPerson(wx, wy); return; }
    kmAct = { ...base, type: 'pan', view: { ...kmView }, tap: true };
  }
}
let kmLastTap = null;

function kmMove(e) {
  if (!kmPtrs.has(e.pointerId)) return;
  kmPtrs.set(e.pointerId, { ...kmPtrs.get(e.pointerId), x: e.clientX, y: e.clientY });
  if (kmPinch && kmPtrs.size >= 2) {
    const [a, b] = [...kmPtrs.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const r = kmStage().getBoundingClientRect(), v = kmPinch.view;
    const z = Math.min(3, Math.max(0.25, v.z * d / kmPinch.d));
    // Punkt unter der Fingermitte bleibt unter der Fingermitte
    const wx = (kmPinch.mx - r.left - v.x) / v.z, wy = (kmPinch.my - r.top - v.y) / v.z;
    kmView = { z, x: mx - r.left - wx * z, y: my - r.top - wy * z };
    kmRenderSoon();
    return;
  }
  const A = kmAct;
  if (!A || A.id !== e.pointerId) return;
  const dx = e.clientX - A.sx, dy = e.clientY - A.sy;
  if (!A.moved && Math.hypot(dx, dy) < 5) return;
  A.moved = true;
  if (A.type === 'pan') { kmView = { ...A.view, x: A.view.x + dx, y: A.view.y + dy }; kmRenderSoon(); }
  else if (A.type === 'move') {
    A.ids.forEach((id, i) => { const p = kmPerson(id); p.x = Math.round(A.start[i][0] + dx / kmView.z); p.y = Math.round(A.start[i][1] + dy / kmView.z); });
    kmRenderSoon();
  } else if (A.type === 'link') {
    const [wx, wy] = kmWorld(e);
    A.to = [wx, wy];
    const t = kmPersonAt(wx, wy, A.from);
    A.target = t ? t.id : null;
    kmRenderSoon();
  }
}

function kmUp(e) {
  kmPtrs.delete(e.pointerId);
  if (kmPinch) { if (kmPtrs.size < 2) { kmPinch = null; km.view = { ...kmView }; saveNote(); } return; }
  const A = kmAct;
  if (!A || A.id !== e.pointerId) return;
  kmAct = null;
  if (A.type === 'pan') {
    if (A.moved) { km.view = { ...kmView }; saveNote(); }
    else if (A.tap) { kmSelect(null); kmLinkMode && kmSetLinkMode(false); }
  } else if (A.type === 'move') {
    if (A.moved) { kmUndo.push(A.before); kmRedo = []; kmSaved(); }
  } else if (A.type === 'link') {
    if (A.target) kmAddLink(A.from, A.target);
    else if (A.to && A.moved && Math.hypot(e.clientX - A.sx, e.clientY - A.sy) > 50) {
      // auf leerer Fläche losgelassen: neue Person, gleich verbunden
      let pid;
      kmChange(() => { pid = kmNewPerson(A.to[0], A.to[1]); });
      kmAddLink(A.from, pid, true);
    } else kmRender();
  }
}

function kmWheel(e) {
  if (!km) return;
  e.preventDefault();
  const r = kmStage().getBoundingClientRect();
  if (e.ctrlKey || e.metaKey) {
    const z = Math.min(3, Math.max(0.25, kmView.z * Math.exp(-e.deltaY * 0.01)));
    const cx = e.clientX - r.left, cy = e.clientY - r.top;
    kmView = { z, x: cx - (cx - kmView.x) * z / kmView.z, y: cy - (cy - kmView.y) * z / kmView.z };
  } else kmView = { ...kmView, x: kmView.x - e.deltaX, y: kmView.y - e.deltaY };
  kmRenderSoon();
  clearTimeout(kmWheel.t);
  kmWheel.t = setTimeout(() => { km.view = { ...kmView }; saveNote(); }, 400);
}

// ---- Bearbeiten ----
function kmNewPerson(x, y, props) {
  // nicht genau auf eine andere Person legen
  let n = 0;
  while (kmPersonAt(x, y) && n++ < 12) { x += 34; y += 26; }
  const used = new Set(km.persons.map((p) => p.color));
  const p = { id: kmId('p'), x: Math.round(x), y: Math.round(y), name: 'Person ' + (km.persons.length + 1), role: '', color: KM_COLORS.find((c) => !used.has(c)) || KM_COLORS[km.persons.length % 8], shape: 'rect', ...props };
  km.persons.push(p);
  return p.id;
}
function kmAddPerson(x, y) {
  if (x == null) {
    const r = kmStage().getBoundingClientRect();
    x = (r.width / 2 - kmView.x) / kmView.z; y = (r.height / 2 - kmView.y) / kmView.z;
  }
  let id;
  kmChange(() => { id = kmNewPerson(x, y); });
  kmSelect({ t: 'p', id }, true);
}
function kmAddLink(a, b, noUndo) {
  const exists = km.links.find((l) => (l.a === a && l.b === b) || (l.a === b && l.b === a));
  if (exists && !confirm('Zwischen den beiden gibt es schon eine Beziehung. Noch eine hinzufügen?')) { kmSelect({ t: 'l', id: exists.id }); return; }
  const l = { id: kmId('l'), a, b, type: kmLastType, label: '', dir: 'ab', w: 2 };
  const add = () => km.links.push(l);
  if (noUndo) { add(); kmSaved(); } else kmChange(add);
  kmSelect({ t: 'l', id: l.id });
  if (kmLinkMode) kmSetLinkMode(false);
}
function kmDelete() {
  if (!kmSel) return;
  const s = kmSel;
  kmChange(() => {
    if (s.t === 'p') { km.persons = km.persons.filter((p) => p.id !== s.id); km.links = km.links.filter((l) => l.a !== s.id && l.b !== s.id); }
    if (s.t === 'l') km.links = km.links.filter((l) => l.id !== s.id);
    if (s.t === 'g') { km.groups = km.groups.filter((g) => g.id !== s.id); km.persons.forEach((p) => { if (p.group === s.id) delete p.group; }); }
  });
  kmSelect(null);
}
function kmSelect(s, focusName) {
  kmSel = s;
  kmRender();
  kmPanel(focusName);
}
function kmSetLinkMode(on) {
  kmLinkMode = on;
  kmBarState();
  if (on) toast('Verbinden: von einer Person zur anderen ziehen');
}

// Gruppe aus der ausgewählten Person (oder leer, mit Auswahl im Feld)
function kmAddGroup() {
  const p = kmSel && kmSel.t === 'p' ? kmPerson(kmSel.id) : null;
  if (!p) return toast('Erst eine Person antippen – die Gruppe entsteht um sie herum');
  const name = (prompt('Name der Gruppe (z. B. Familie Müller, die Montagues):') || '').trim().slice(0, 40);
  if (!name) return;
  const used = new Set(km.groups.map((g) => g.color));
  const g = { id: kmId('g'), name, color: KM_COLORS.find((c) => !used.has(c) && c !== p.color) || KM_COLORS[km.groups.length % 8] };
  kmChange(() => { km.groups.push(g); p.group = g.id; });
  kmSelect({ t: 'g', id: g.id });
  toast('Weitere Personen über ihr Feld „Gruppe“ hinzufügen');
}

// Automatisch anordnen: Federmodell (Beziehungen ziehen, alle stoßen sich ab, Gruppen halten zusammen)
function kmLayout() {
  if (km.persons.length < 2) return;
  kmChange(() => {
    const P = km.persons, n = P.length, idx = new Map(P.map((p, i) => [p.id, i]));
    const pos = P.map((p) => [p.x, p.y]);
    const L = km.links.map((l) => [idx.get(l.a), idx.get(l.b)]).filter(([a, b]) => a != null && b != null);
    const ideal = 210;
    for (let it = 0; it < 450; it++) {
      const temp = 30 * (1 - it / 450) + 1, f = pos.map(() => [0, 0]);
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
        let dx = pos[i][0] - pos[j][0], dy = pos[i][1] - pos[j][1], d = Math.hypot(dx, dy);
        if (d < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d = 1; }
        if (d > ideal * 3) continue;          // weit Entferntes stößt nicht mehr ab (sonst fliegt alles auseinander)
        const rep = (ideal * ideal) / d * (P[i].group && P[i].group === P[j].group ? 0.5 : 1);
        f[i][0] += (dx / d) * rep; f[i][1] += (dy / d) * rep; f[j][0] -= (dx / d) * rep; f[j][1] -= (dy / d) * rep;
      }
      for (const [a, b] of L) {
        const dx = pos[a][0] - pos[b][0], dy = pos[a][1] - pos[b][1], d = Math.hypot(dx, dy) || 1, att = (d * d) / ideal;
        f[a][0] -= (dx / d) * att; f[a][1] -= (dy / d) * att; f[b][0] += (dx / d) * att; f[b][1] += (dy / d) * att;
      }
      // Gruppen: zum gemeinsamen Mittelpunkt ziehen
      for (const g of km.groups) {
        const ms = P.map((p, i) => (p.group === g.id ? i : -1)).filter((i) => i >= 0);
        if (ms.length < 2) continue;
        const cx = ms.reduce((s, i) => s + pos[i][0], 0) / ms.length, cy = ms.reduce((s, i) => s + pos[i][1], 0) / ms.length;
        ms.forEach((i) => { f[i][0] += (cx - pos[i][0]) * 1.2; f[i][1] += (cy - pos[i][1]) * 1.2; });
      }
      // leichte Schwerkraft zur Mitte: Personen ohne Beziehung bleiben in der Nähe
      const mx = pos.reduce((s, q) => s + q[0], 0) / n, my = pos.reduce((s, q) => s + q[1], 0) / n;
      for (let i = 0; i < n; i++) { f[i][0] += (mx - pos[i][0]) * 0.5; f[i][1] += (my - pos[i][1]) * 0.5; }
      for (let i = 0; i < n; i++) {
        const fl = Math.hypot(f[i][0], f[i][1]) || 1;
        pos[i][0] += (f[i][0] / fl) * Math.min(fl, temp);
        pos[i][1] += (f[i][1] / fl) * Math.min(fl, temp) * 0.8;   // etwas breiter als hoch (Bildschirm)
      }
    }
    P.forEach((p, i) => { p.x = Math.round(pos[i][0]); p.y = Math.round(pos[i][1]); });
  });
  kmFit();
}

// ---- Ansicht ----
function kmFit() {
  const st = kmStage();
  if (!km || !st) return;
  const r = st.getBoundingClientRect();
  const b = kmBounds(kmScene());
  if (!b || !r.width) { kmView = { x: r.width / 2, y: r.height / 2, z: 1 }; kmRender(); return; }
  const z = Math.min(1.4, Math.max(0.25, Math.min((r.width - 60) / b.w, (r.height - 60) / b.h)));
  kmView = { z, x: r.width / 2 - (b.x + b.w / 2) * z, y: r.height / 2 - (b.y + b.h / 2) * z };
  km.view = { ...kmView };
  kmRender();
}
function kmZoomBy(f) {
  const r = kmStage().getBoundingClientRect(), z = Math.min(3, Math.max(0.25, kmView.z * f)), cx = r.width / 2, cy = r.height / 2;
  kmView = { z, x: cx - (cx - kmView.x) * z / kmView.z, y: cy - (cy - kmView.y) * z / kmView.z };
  km.view = { ...kmView };
  kmRender();
}

// ---- Seitenfeld (Eigenschaften) ----
function kmPanel(focusName) {
  const box = kmEl('#km-panel');
  if (!box) return;
  const o = kmSelObj();
  box.hidden = !o;
  kmEl('#km-wrap').classList.toggle('panel-open', !!o);
  if (!o) return;
  const sw = (cur, attr) => KM_COLORS.map((c) => `<button type="button" class="km-sw${c === cur ? ' on' : ''}" style="--c:${c}" ${attr}="${c}" aria-label="Farbe"></button>`).join('');
  const seg = (name, cur, opts) => `<span class="segmented small-seg km-seg">${opts.map(([v, l]) => `<button type="button" data-${name}="${v}" class="${v === cur ? 'active' : ''}">${l}</button>`).join('')}</span>`;
  let h = '';
  if (kmSel.t === 'p') {
    const rel = km.links.filter((l) => l.a === o.id || l.b === o.id);
    h = '<div class="km-ph"><b>Person</b><button type="button" class="btn small link" data-x="close">Fertig</button></div>' +
      `<label class="km-f"><span>Name</span><input id="km-name" value="${kmEsc(o.name)}" maxlength="40" autocomplete="off"></label>` +
      `<label class="km-f"><span>Rolle / kurz</span><input id="km-role" value="${kmEsc(o.role)}" maxlength="50" placeholder="z. B. Hauptfigur, Vater, 17 J." autocomplete="off"></label>` +
      `<div class="km-f"><span>Farbe</span><div class="km-sws">${sw(o.color, 'data-pc')}</div></div>` +
      `<div class="km-f"><span>Form</span>${seg('shape', o.shape || 'rect', [['rect', 'Karte'], ['pill', 'Pille'], ['ellipse', 'Oval']])}</div>` +
      `<label class="km-f km-row"><span>Hauptfigur (groß)</span><label class="switch"><input type="checkbox" id="km-big"${o.big ? ' checked' : ''}><span></span></label></label>` +
      `<label class="km-f"><span>Symbol</span><input id="km-emoji" value="${kmEsc(o.emoji || '')}" maxlength="4" placeholder="z. B. 👑 🗡️ ❤️" autocomplete="off"></label>` +
      `<label class="km-f"><span>Gruppe</span><select id="km-group"><option value="">– keine –</option>${km.groups.map((g) => `<option value="${g.id}"${o.group === g.id ? ' selected' : ''}>${kmEsc(g.name)}</option>`).join('')}<option value="__new">＋ Neue Gruppe …</option></select></label>` +
      `<label class="km-f"><span>Notizen (Eigenschaften, Zitate, Entwicklung)</span><textarea id="km-desc" rows="4">${kmEsc(o.desc || '')}</textarea></label>` +
      `<div class="km-f"><span>Beziehungen (${rel.length})</span><div class="km-rels">${rel.map((l) => { const other = kmPerson(l.a === o.id ? l.b : l.a); return `<button type="button" class="km-rel" data-rel="${l.id}" style="--c:${l.color || kmType(l.type).color}">${kmEsc(l.label || kmType(l.type).name)} · ${kmEsc(other ? other.name : '?')}</button>`; }).join('') || '<span class="muted small-text">Am ⊕ neben der Person ziehen</span>'}</div></div>` +
      '<div class="km-actions"><button type="button" class="btn small" data-x="dup">Duplizieren</button><button type="button" class="btn small danger-text" data-x="del">Löschen</button></div>';
  } else if (kmSel.t === 'l') {
    const A = kmPerson(o.a), B = kmPerson(o.b), ty = kmType(o.type);
    h = '<div class="km-ph"><b>Beziehung</b><button type="button" class="btn small link" data-x="close">Fertig</button></div>' +
      `<div class="km-between"><b>${kmEsc(A ? A.name : '?')}</b><button type="button" class="btn small" data-x="swap" title="Richtung tauschen">⇄</button><b>${kmEsc(B ? B.name : '?')}</b></div>` +
      `<div class="km-f"><span>Art</span><div class="km-types">${KM_TYPES.map((t) => `<button type="button" class="km-type${t.id === ty.id ? ' on' : ''}" data-type="${t.id}" style="--c:${t.color}">${t.name}</button>`).join('')}</div></div>` +
      `<label class="km-f"><span>Bezeichnung</span><input id="km-label" value="${kmEsc(o.label)}" maxlength="40" placeholder="z. B. ${kmEsc(ty.labels[0])}" autocomplete="off"></label>` +
      `<div class="km-chips">${ty.labels.map((t) => `<button type="button" class="chip" data-lab="${kmEsc(t)}">${kmEsc(t)}</button>`).join('')}</div>` +
      `<div class="km-f"><span>Richtung</span>${seg('dir', o.dir || 'ab', [['ab', '→'], ['ba', '←'], ['both', '↔'], ['none', '—']])}</div>` +
      `<div class="km-f"><span>Linie</span>${seg('dash', o.dash || ty.dash, [['solid', '──'], ['dashed', '- - -'], ['dotted', '···']])}</div>` +
      `<div class="km-f"><span>Stärke</span>${seg('w', String(o.w || 2), [['1', 'schwach'], ['2', 'mittel'], ['3', 'stark']])}</div>` +
      `<div class="km-f"><span>Eigene Farbe</span><div class="km-sws">${sw(o.color, 'data-lc')}<button type="button" class="btn small link" data-lc="">Standard</button></div></div>` +
      `<div class="km-f"><span>Bogen</span>${seg('bend', String(Math.sign(o.bend || 0)), [['-1', '◜'], ['0', 'gerade'], ['1', '◝']])}</div>` +
      `<label class="km-f"><span>Notizen (Belegstelle, Entwicklung …)</span><textarea id="km-ldesc" rows="3">${kmEsc(o.desc || '')}</textarea></label>` +
      '<div class="km-actions"><button type="button" class="btn small danger-text" data-x="del">Beziehung löschen</button></div>';
  } else {
    const ms = km.persons.filter((p) => p.group === o.id);
    h = '<div class="km-ph"><b>Gruppe</b><button type="button" class="btn small link" data-x="close">Fertig</button></div>' +
      `<label class="km-f"><span>Name</span><input id="km-gname" value="${kmEsc(o.name)}" maxlength="40" autocomplete="off"></label>` +
      `<div class="km-f"><span>Farbe</span><div class="km-sws">${sw(o.color, 'data-gc')}</div></div>` +
      `<div class="km-f"><span>Mitglieder (${ms.length})</span><div class="km-rels">${km.persons.map((p) => `<label class="km-member"><input type="checkbox" data-mem="${p.id}"${p.group === o.id ? ' checked' : ''}> ${kmEsc(p.name)}</label>`).join('')}</div></div>` +
      '<p class="muted small-text">Am Namen der Gruppe ziehen = alle Mitglieder verschieben.</p>' +
      '<div class="km-actions"><button type="button" class="btn small danger-text" data-x="del">Gruppe auflösen</button></div>';
  }
  box.innerHTML = h;
  if (focusName) { const n = box.querySelector('#km-name'); if (n) { n.focus(); n.select(); } }
}

// Eingaben im Seitenfeld: Text sofort übernehmen, ein Rückgängig-Schritt pro Feld
let kmTyping = null;
function kmField(e) {
  const o = kmSelObj();
  if (!o) return;
  const id = e.target.id;
  const map = { 'km-name': 'name', 'km-role': 'role', 'km-emoji': 'emoji', 'km-desc': 'desc', 'km-label': 'label', 'km-ldesc': 'desc', 'km-gname': 'name' };
  if (!map[id]) return;
  if (kmTyping !== id + o.id) { kmUndo.push(kmSnap()); kmRedo = []; kmTyping = id + o.id; }
  o[map[id]] = id === 'km-name' || id === 'km-gname' || id === 'km-label' || id === 'km-role' ? e.target.value.trimStart() : e.target.value;
  kmSaved();
}
function kmPanelClick(e) {
  const b = e.target.closest('button, input[type=checkbox]');
  if (!b) return;
  const o = kmSelObj();
  if (!o) return;
  kmTyping = null;
  const d = b.dataset, set = (fn) => { kmChange(fn); kmPanel(); };
  if (d.x === 'close') return kmSelect(null);
  if (d.x === 'del') return kmDelete();
  if (d.x === 'dup') { const { id: _i, x: _x, y: _y, ...rest } = o; let id; kmChange(() => { id = kmNewPerson(o.x + 40, o.y + 40, { ...rest, name: o.name + ' (2)' }); }); return kmSelect({ t: 'p', id }); }
  if (d.x === 'swap') return set(() => { [o.a, o.b] = [o.b, o.a]; });
  if (d.rel) return kmSelect({ t: 'l', id: d.rel });
  if (d.pc) return set(() => { o.color = d.pc; });
  if (d.gc) return set(() => { o.color = d.gc; });
  if (d.lc != null) return set(() => { if (d.lc) o.color = d.lc; else delete o.color; });
  if (d.shape) return set(() => { o.shape = d.shape; });
  if (d.type) { kmLastType = d.type; store.set('kmLastType', d.type); return set(() => { o.type = d.type; delete o.dash; }); }
  if (d.lab != null) return set(() => { o.label = d.lab; });
  if (d.dir) return set(() => { o.dir = d.dir; });
  if (d.dash) return set(() => { o.dash = d.dash; });
  if (d.w) return set(() => { o.w = Number(d.w); });
  if (d.bend != null) return set(() => { o.bend = Number(d.bend) * 60; });
  if (d.mem) return set(() => { const p = kmPerson(d.mem); if (b.checked) p.group = o.id; else if (p.group === o.id) delete p.group; });
  if (b.id === 'km-big') return set(() => { o.big = b.checked; });
}
function kmPanelChange(e) {
  const o = kmSelObj();
  if (!o || e.target.id !== 'km-group') return;
  let v = e.target.value;
  if (v === '__new') {
    const name = (prompt('Name der neuen Gruppe:') || '').trim().slice(0, 40);
    if (!name) { kmPanel(); return; }
    const g = { id: kmId('g'), name, color: KM_COLORS.find((c) => !km.groups.some((x) => x.color === c) && c !== o.color) || KM_COLORS[7] };
    kmChange(() => { km.groups.push(g); o.group = g.id; });
  } else kmChange(() => { if (v) o.group = v; else delete o.group; });
  kmPanel();
}

// ---- Export als Bild (Canvas, ohne Umweg – damit das iPad das Teilen-Menü erlaubt) ----
function kmDrawScene(ctx, sc) {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const rr = (x, y, w, h, r) => { ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h); };
  for (const G of sc.groups) {
    const c = G.g.color || KM_COLORS[7];
    rr(G.x, G.y, G.w, G.h, 16);
    ctx.globalAlpha = 0.09; ctx.fillStyle = c; ctx.fill(); ctx.globalAlpha = 1;
    ctx.setLineDash([7, 5]); ctx.strokeStyle = c; ctx.lineWidth = 1.6; ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = c; ctx.font = `700 14px ${KM_FONT}`; ctx.textAlign = 'left';
    ctx.fillText(G.g.name || 'Gruppe', G.x + 14, G.y + 21);
  }
  for (const k of sc.links) {
    ctx.beginPath(); ctx.moveTo(k.a[0], k.a[1]); ctx.quadraticCurveTo(k.c[0], k.c[1], k.b[0], k.b[1]);
    ctx.setLineDash(KM_DASH[k.dash] ? KM_DASH[k.dash].split(' ').map(Number) : []);
    ctx.strokeStyle = k.color; ctx.lineWidth = k.w; ctx.stroke(); ctx.setLineDash([]);
    for (const ar of k.arrows) { const q = kmArrowPts(ar, k.w); ctx.beginPath(); ctx.moveTo(...q[0]); ctx.lineTo(...q[1]); ctx.lineTo(...q[2]); ctx.closePath(); ctx.fillStyle = k.color; ctx.fill(); }
  }
  for (const p of km.persons) {
    const b = sc.boxes.get(p.id), c = p.color || KM_COLORS[0];
    if (p.shape === 'ellipse') { ctx.beginPath(); ctx.ellipse(p.x, p.y, b.w / 2, b.h / 2, 0, 0, Math.PI * 2); } else rr(b.x, b.y, b.w, b.h, p.shape === 'pill' ? b.h / 2 : 10);
    ctx.fillStyle = kmTint(c, 0.86); ctx.fill(); ctx.strokeStyle = c; ctx.lineWidth = b.big ? 3.2 : 1.8; ctx.stroke();
    ctx.textAlign = 'center'; ctx.fillStyle = '#1c1c1e'; ctx.font = `${b.big ? 700 : 600} ${b.fs}px ${KM_FONT}`;
    ctx.fillText((p.emoji ? p.emoji + ' ' : '') + (p.name || '?'), p.x, p.role ? b.y + b.h / 2 - 3 : p.y + b.fs * 0.36);
    if (p.role) { ctx.fillStyle = '#55555c'; ctx.font = `12px ${KM_FONT}`; ctx.fillText(p.role, p.x, b.y + b.h / 2 + 14); }
  }
  for (const k of sc.links) {
    if (!k.label) continue;
    ctx.font = `600 12px ${KM_FONT}`;
    const w = ctx.measureText(k.label.text).width + 14;
    rr(k.label.x - w / 2, k.label.y - 11, w, 22, 11);
    ctx.fillStyle = '#fff'; ctx.fill(); ctx.strokeStyle = k.color; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.fillStyle = k.color; ctx.textAlign = 'center'; ctx.fillText(k.label.text, k.label.x, k.label.y + 4);
  }
}
function kmExport() {
  if (!km || !km.persons.length) return toast('Noch keine Personen');
  const sc = kmScene(), b = kmBounds(sc), used = kmLegend ? kmUsedTypes() : [];
  const pad = 40, title = note.title || '', top = title ? 44 : 0, legH = used.length ? used.length * 20 + 34 : 0;
  const W = Math.max(b.w + pad * 2, 360), H = b.h + pad * 2 + top + legH;
  const scale = Math.min(2, 4000 / Math.max(W, H));
  const cv = document.createElement('canvas');
  cv.width = Math.round(W * scale); cv.height = Math.round(H * scale);
  const ctx = cv.getContext('2d');
  ctx.scale(scale, scale);
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  if (title) { ctx.fillStyle = '#1c1c1e'; ctx.font = `700 22px ${KM_FONT}`; ctx.textAlign = 'left'; ctx.fillText(title, pad, pad + 8); }
  ctx.save();
  ctx.translate(pad - b.x + (W - pad * 2 - b.w) / 2, pad + top - b.y);
  kmDrawScene(ctx, sc);
  ctx.restore();
  if (used.length) {
    let y = H - legH + 12;
    ctx.fillStyle = '#1c1c1e'; ctx.font = `700 13px ${KM_FONT}`; ctx.textAlign = 'left'; ctx.fillText('Legende', pad, y + 8);
    used.forEach(({ t, labels }) => {
      y += 20;
      ctx.beginPath(); ctx.moveTo(pad, y + 4); ctx.lineTo(pad + 30, y + 4);
      ctx.setLineDash(KM_DASH[t.dash] ? KM_DASH[t.dash].split(' ').map(Number) : []); ctx.strokeStyle = t.color; ctx.lineWidth = 3; ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#1c1c1e'; ctx.font = `13px ${KM_FONT}`;
      ctx.fillText(t.name + (labels.size ? ` (${[...labels].slice(0, 6).join(', ')})` : ''), pad + 40, y + 8);
    });
  }
  const file = dataUrlToFile(cv.toDataURL('image/png'), `${(title || 'Personenkonstellation').replace(/[\\/:*?"<>|]/g, '_')}.png`);
  shareFiles([file], title || 'Personenkonstellation');
}

// ---- Oberfläche ----
function kmBarState() {
  const bar = kmEl('#km-bar');
  if (!bar) return;
  kmEl('#km-undo').disabled = !kmUndo.length;
  kmEl('#km-redo').disabled = !kmRedo.length;
  kmEl('#km-linkmode').classList.toggle('active', kmLinkMode);
  kmEl('#km-focus').classList.toggle('active', kmFocus);
  kmEl('#km-legend-btn').classList.toggle('active', kmLegend);
}
function kmBuild() {
  if (kmEl('#km-wrap')) return;
  const wrap = document.createElement('div');
  wrap.id = 'km-wrap';
  const ico = (d) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  wrap.innerHTML = '<div class="toolbar km-bar" id="km-bar">' +
    `<div class="tool-group"><button class="tool" id="km-undo" aria-label="Rückgängig">${ico('<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 010 12h-3"/>')}</button><button class="tool" id="km-redo" aria-label="Wiederholen">${ico('<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 000 12h3"/>')}</button></div>` +
    '<div class="tool-group"><button class="tool km-txt" id="km-add">＋ Person</button>' +
    `<button class="tool" id="km-linkmode" aria-label="Verbinden (von Person zu Person ziehen)">${ico('<circle cx="6" cy="12" r="3"/><circle cx="18" cy="12" r="3"/><path d="M9 12h6"/>')}</button>` +
    `<button class="tool" id="km-group-add" aria-label="Gruppe um die ausgewählte Person">${ico('<rect x="3" y="5" width="18" height="14" rx="3" stroke-dasharray="3 2.5"/><circle cx="9" cy="12" r="2"/><circle cx="15" cy="12" r="2"/>')}</button>` +
    `<button class="tool" id="km-layout" aria-label="Automatisch anordnen">${ico('<circle cx="12" cy="5" r="2"/><circle cx="5" cy="18" r="2"/><circle cx="19" cy="18" r="2"/><path d="M11 7l-5 9M13 7l5 9M7 18h10"/>')}</button>` +
    `<button class="tool" id="km-focus" aria-label="Fokus: nur Beziehungen der ausgewählten Person">${ico('<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8" stroke-dasharray="3 3"/>')}</button>` +
    `<button class="tool" id="km-legend-btn" aria-label="Legende ein/aus">${ico('<path d="M4 7h4M4 12h4M4 17h4M11 7h9M11 12h9M11 17h9"/>')}</button></div>` +
    '<div class="tool-group zoom-group"><button class="tool" id="km-zout" aria-label="Verkleinern">−</button><button class="tool zoom-label" id="km-zoom" aria-label="Alles zeigen">100%</button><button class="tool" id="km-zin" aria-label="Vergrößern">+</button>' +
    `<button class="tool" id="km-fit" aria-label="Alles zeigen">${ico('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>')}</button>` +
    `<button class="tool" id="km-export" aria-label="Als Bild teilen">${ico('<path d="M12 3v12M8 7l4-4 4 4"/><path d="M6 11H5v10h14V11h-1"/>')}</button></div></div>` +
    '<div class="km-main"><div class="km-stage" id="km-stage"><svg id="km-svg" xmlns="http://www.w3.org/2000/svg"></svg>' +
    '<div class="km-empty card" id="km-empty"><b>Personenkonstellation</b><p class="muted small-text">Doppeltippen auf die Fläche oder <b>＋ Person</b> = neue Person.<br>Person antippen und am <b>⊕</b> zu einer anderen ziehen = Beziehung.<br>Zwei Finger = zoomen und verschieben.</p></div>' +
    '<div class="km-legend" id="km-legend" hidden></div></div>' +
    '<aside class="km-panel" id="km-panel" hidden></aside></div>';
  kmEl('#view-notes').append(wrap);
  const st = kmEl('#km-stage');
  st.addEventListener('pointerdown', kmDown);
  st.addEventListener('pointermove', kmMove);
  st.addEventListener('pointerup', kmUp);
  st.addEventListener('pointercancel', kmUp);
  st.addEventListener('wheel', kmWheel, { passive: false });
  st.addEventListener('contextmenu', (e) => e.preventDefault());
  const panel = kmEl('#km-panel');
  panel.addEventListener('input', kmField);
  panel.addEventListener('click', kmPanelClick);
  panel.addEventListener('change', kmPanelChange);
  panel.addEventListener('focusout', () => { kmTyping = null; setTimeout(() => { if (kmSel && kmSel.t === 'p' && !panel.contains(document.activeElement)) kmPanel(); }, 0); });
  const on = (id, fn) => kmEl(id).addEventListener('click', fn);
  on('#km-undo', () => kmRestore(kmUndo, kmRedo));
  on('#km-redo', () => kmRestore(kmRedo, kmUndo));
  on('#km-add', () => kmAddPerson());
  on('#km-linkmode', () => kmSetLinkMode(!kmLinkMode));
  on('#km-group-add', kmAddGroup);
  on('#km-layout', () => { if (km.persons.length < 2) return toast('Erst ein paar Personen anlegen'); kmLayout(); toast('Angeordnet – Rückgängig geht'); });
  on('#km-focus', () => { kmFocus = !kmFocus; kmBarState(); kmRender(); if (kmFocus && (!kmSel || kmSel.t !== 'p')) toast('Fokus: eine Person antippen'); });
  on('#km-legend-btn', () => { kmLegend = !kmLegend; store.set('kmLegend', kmLegend); kmBarState(); kmRender(); });
  on('#km-zout', () => kmZoomBy(1 / 1.25));
  on('#km-zin', () => kmZoomBy(1.25));
  on('#km-zoom', kmFit);
  on('#km-fit', kmFit);
  on('#km-export', kmExport);
  // Tastatur (Surface): Entf, Strg+Z/Y
  document.addEventListener('keydown', (e) => {
    if (!km || !document.body.classList.contains('kmap-mode') || document.body.dataset.view !== 'notes') return;
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) || document.querySelector('dialog[open]')) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && kmSel) { e.preventDefault(); kmDelete(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? kmRestore(kmRedo, kmUndo) : kmRestore(kmUndo, kmRedo); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); kmRestore(kmRedo, kmUndo); }
  });
  window.addEventListener('resize', () => { if (km && document.body.classList.contains('kmap-mode')) kmRender(); });
}

// ---- Anbindung an die Notizen ----
window.addEventListener('noteopen', (e) => {
  const n = e.detail;
  const on = n && n.kind === 'kmap';
  document.body.classList.toggle('kmap-mode', on);
  $('#note-title').placeholder = on ? 'Unbenannte Konstellation' : 'Unbenannte Notiz';
  if (on) kmOpen(n);
  else { km = null; kmSel = null; }
});
// „Als Bild teilen“ im Mehr-Menü: für Konstellationen das Diagramm exportieren
document.addEventListener('click', (e) => {
  if (!document.body.classList.contains('kmap-mode')) return;
  if (e.target.closest('#note-export')) { e.stopPropagation(); e.preventDefault(); $('#more-dialog').close(); kmExport(); }
}, true);
$('#notes-dialog-kmap').addEventListener('click', () => {
  $('#notes-dialog').close();
  kmCreate(folderFilter !== 'all' ? folderFilter : undefined);
});
$('#note-new-kmap').addEventListener('click', () => { $('#more-dialog').close(); kmCreate(note && note.folder); });
// Notiz war beim Start schon offen (Skripte laufen nacheinander)
if (typeof note !== 'undefined' && note && note.kind === 'kmap' && !km) window.dispatchEvent(new CustomEvent('noteopen', { detail: note }));
