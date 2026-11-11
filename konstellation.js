// ---------- Personenkonstellation (eigene Notiz-Art) ----------
// Eine Notiz mit kind: 'kmap' zeigt statt der Seiten ein Diagramm: Personen (Karten), Beziehungen
// (Pfeile mit Bezeichnung) und Gruppen (Kästen um mehrere Personen, z. B. Familien oder Lager).
// Gespeichert wird alles in note.kmap; die Notiz selbst läuft über dieselbe Speicherung wie alle Notizen.
//
// Bedienung: Doppeltippen auf die Fläche = neue Person · Person antippen und am ⊕ ziehen = Beziehung
// (loslassen auf leerer Fläche = neue Person mit Beziehung) · Fläche ziehen = verschieben · zwei Finger
// oder Strg+Mausrad = zoomen. Alles Weitere im Seitenfeld der ausgewählten Person/Beziehung/Gruppe.
// Akt-Kästen (frames): frei platzierte Rahmen, z. B. „Akt 1“ – alles, was darin liegt, wandert mit;
// „als nächsten Akt kopieren“ legt daneben eine Kopie an, in der man die Veränderungen einträgt.
// Stift (ink): freie Striche wie in normalen Notizen (gleiche Glättung, notes.js).

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
let kmDraw = false, kmErase = false, kmInk = store.get('kmInk', 0);   // Stift-Modus, Radierer, Farbe
let kmRaf = 0;

const kmEl = (s) => document.querySelector(s);
const kmStage = () => kmEl('#km-stage');
const kmPerson = (id) => km.persons.find((p) => p.id === id);
const kmLink = (id) => km.links.find((l) => l.id === id);
const kmGroup = (id) => km.groups.find((g) => g.id === id);
const kmFrame = (id) => km.frames.find((f) => f.id === id);
const kmBlank = () => ({ persons: [], links: [], groups: [], frames: [], ink: [], view: null });
// Gruppen einer Person (früher nur eine: p.group)
const kmIn = (p, gid) => !!(p.groups && p.groups.includes(gid));
const kmJoin = (p, gid) => { if (!kmIn(p, gid)) p.groups = (p.groups || []).concat(gid); };
const kmLeave = (p, gid) => { if (p.groups) { p.groups = p.groups.filter((g) => g !== gid); if (!p.groups.length) delete p.groups; } };
const KM_DATA = ['persons', 'links', 'groups', 'frames', 'ink'];

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
  KM_DATA.forEach((k) => { if (!Array.isArray(km[k])) km[k] = []; });
  km.persons.forEach((p) => { if (p.group) { kmJoin(p, p.group); delete p.group; } });
  kmSel = null; kmUndo = []; kmRedo = []; kmAct = null; kmPtrs.clear(); kmPinch = null;
  kmLinkMode = false; kmFocus = false; kmDraw = false; kmErase = false;
  kmBuild();
  if (km.view) kmView = { ...km.view };
  else requestAnimationFrame(() => kmFit());
  kmRender();
  kmPanel();
  kmBarState();
}

// ---- Änderungen, Rückgängig ----
const kmSnap = () => JSON.stringify(Object.fromEntries(KM_DATA.map((k) => [k, km[k]])));
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
  KM_DATA.forEach((k) => { km[k] = s[k] || []; });
  if (kmSel && !kmSelObj()) kmSel = null;
  kmSaved();
  kmPanel();
}
const kmSelObj = () => kmSel && (kmSel.t === 'p' ? kmPerson(kmSel.id) : kmSel.t === 'l' ? kmLink(kmSel.id) : kmSel.t === 'f' ? kmFrame(kmSel.id) : kmGroup(kmSel.id));

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
  // Gruppen: eine Person kann in mehreren sein. Überlappen sich Gruppen, bekommt die größere mehr
  // Abstand – so umschließt sie die kleinere sichtbar.
  const mem = new Map(km.groups.map((g) => [g.id, km.persons.filter((p) => kmIn(p, g.id))]));
  const groups = km.groups.map((g) => {
    const ms = mem.get(g.id);
    if (!ms.length) return null;
    const inner = km.groups.filter((o) => o !== g && mem.get(o.id).length < ms.length && mem.get(o.id).some((p) => ms.includes(p))).length;
    const pad = 16 + inner * 12;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    ms.forEach((p) => { const b = boxes.get(p.id); x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); });
    return { g, n: ms.length, x: x0 - pad, y: y0 - pad - 18, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 + 18 };
  }).filter(Boolean).sort((a, b) => b.n - a.n);
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
  return { boxes, groups, links, frames: km.frames, ink: km.ink };
}
// Begrenzung eines Strichs
function kmInkBox(s) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < s.pts.length; i += 3) { x0 = Math.min(x0, s.pts[i]); y0 = Math.min(y0, s.pts[i + 1]); x1 = Math.max(x1, s.pts[i]); y1 = Math.max(y1, s.pts[i + 1]); }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
function kmBounds(sc) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x, y, w, h) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + w); y1 = Math.max(y1, y + h); };
  sc.boxes.forEach((b) => add(b.x, b.y, b.w, b.h));
  sc.groups.forEach((g) => add(g.x, g.y, g.w, g.h));
  sc.frames.forEach((f) => add(f.x, f.y, f.w, f.h));
  sc.ink.forEach((s) => { const b = kmInkBox(s); add(b.x - 4, b.y - 4, b.w + 8, b.h + 8); });
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
  for (const F of sc.frames) {
    const sel = kmSel && kmSel.t === 'f' && kmSel.id === F.id, c = F.color || '#6b7280';
    const tw = kmMeasure(F.name || 'Akt', `700 16px ${KM_FONT}`) + 40;
    h += `<g data-f="${F.id}"><rect x="${F.x}" y="${F.y}" width="${F.w}" height="${F.h}" rx="18" fill="${c}" fill-opacity="0.04" stroke="${c}" stroke-opacity="${sel ? 1 : 0.55}" stroke-width="${sel ? 3 : 2}" class="km-gbox"/>` +
      `<g data-ft="${F.id}" class="km-ftitle"><rect x="${F.x}" y="${F.y}" width="${tw}" height="34" rx="16" fill="${c}"/><rect x="${F.x}" y="${F.y + 17}" width="${tw}" height="17" fill="${c}"/>` +
      `<text x="${F.x + 14}" y="${F.y + 23}" fill="#fff" font-weight="700" font-size="16">${kmEsc(F.name || 'Akt')}  ⠿</text></g>` +
      (sel ? `<g data-fr="${F.id}" class="km-fresize"><circle cx="${F.x + F.w}" cy="${F.y + F.h}" r="14" fill="${c}"/><path d="M${F.x + F.w - 5} ${F.y + F.h + 5}l10 -10M${F.x + F.w + 1} ${F.y + F.h - 5}h4v4M${F.x + F.w - 5} ${F.y + F.h + 1}v4h4" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round"/></g>` : '') + '</g>';
  }
  for (const G of sc.groups) {
    const sel = kmSel && kmSel.t === 'g' && kmSel.id === G.g.id, c = G.g.color || KM_COLORS[7];
    h += `<g data-g="${G.g.id}"${dim(nb && !km.persons.some((p) => kmIn(p, G.g.id) && nb.has(p.id)))}>` +
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
  // freie Striche (Stift) – oben drauf, wie Notizen auf einem Blatt
  if (km.ink.length || (kmAct && kmAct.type === 'ink')) {
    h += `<g class="km-ink"${dim(!!nb)}>` + km.ink.map((s) => strokeSvg(s)).join('') + (kmAct && kmAct.type === 'ink' ? penSvg(kmAct.stroke) : '') + '</g>';
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
  const g = el && el.closest && el.closest('[data-knob],[data-p],[data-l],[data-gt],[data-ft],[data-fr]');
  if (!g || !kmEl('#km-svg').contains(g)) return null;
  if (g.dataset.knob) return { t: 'knob', id: g.dataset.knob };
  if (g.dataset.p) return { t: 'p', id: g.dataset.p };
  if (g.dataset.l) return { t: 'l', id: g.dataset.l };
  if (g.dataset.ft) return { t: 'f', id: g.dataset.ft };
  if (g.dataset.fr) return { t: 'fr', id: g.dataset.fr };
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
    if (kmAct && kmAct.moved && kmAct.before) { const s = JSON.parse(kmAct.before); KM_DATA.forEach((k) => { km[k] = s[k] || []; }); }
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
  // Stift-Modus: Stift/Maus (und Finger, wenn „Finger zeichnet“ an ist) schreiben bzw. radieren
  if (kmDraw && (e.pointerType !== 'touch' || fingerDraw)) {
    kmLastTap = null;
    if (kmErase) { kmAct = { ...base, type: 'erase', before: kmSnap(), hitAny: false }; kmEraseAt(wx, wy); return; }
    const st = { tool: 'pen', color: PEN_COLORS[kmInk] || PEN_COLORS[0], size: 2, pts: [Math.round(wx * 100) / 100, Math.round(wy * 100) / 100, Math.round((e.pressure || 0.5) * 100) / 100] };
    if (Math.abs(kmView.z - 1) > 0.05) st.z = Math.round(kmView.z * 100) / 100;
    kmAct = { ...base, type: 'ink', stroke: st };
    kmRenderSoon();
    return;
  }
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
    const ms = km.persons.filter((p) => kmIn(p, hit.id));
    kmAct = { ...base, type: 'move', ids: ms.map((p) => p.id), start: ms.map((p) => [p.x, p.y]), before: kmSnap() };
  } else if (hit && hit.t === 'f') {
    // Akt-Kasten am Titel ziehen: Kasten mit allem, was darin liegt
    const F = kmFrame(hit.id);
    kmSelect({ t: 'f', id: F.id });
    const c = kmFrameContent(F);
    kmAct = { ...base, type: 'move', frame: F.id, fstart: [F.x, F.y], ids: c.persons.map((p) => p.id), start: c.persons.map((p) => [p.x, p.y]), ink: c.ink.map((s) => [km.ink.indexOf(s), s.pts.slice()]), before: kmSnap() };
  } else if (hit && hit.t === 'fr') {
    const F = kmFrame(hit.id);
    kmAct = { ...base, type: 'resize', frame: F.id, start: [F.w, F.h], before: kmSnap() };
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
  else if (A.type === 'ink') {
    for (const ev of (e.getCoalescedEvents ? e.getCoalescedEvents() : null) || [e]) {
      const [x, y] = kmWorld(ev), p = A.stroke.pts, n = p.length;
      if (Math.hypot(x - p[n - 3], y - p[n - 2]) < 0.6 / kmView.z) continue;
      p.push(Math.round(x * 100) / 100, Math.round(y * 100) / 100, Math.round((ev.pressure || 0.5) * 100) / 100);
    }
    kmRenderSoon();
  } else if (A.type === 'erase') { const [x, y] = kmWorld(e); kmEraseAt(x, y); }
  else if (A.type === 'resize') {
    const F = kmFrame(A.frame);
    F.w = Math.max(220, Math.round(A.start[0] + dx / kmView.z)); F.h = Math.max(160, Math.round(A.start[1] + dy / kmView.z));
    kmRenderSoon();
  } else if (A.type === 'move') {
    const mx = dx / kmView.z, my = dy / kmView.z;
    A.ids.forEach((id, i) => { const p = kmPerson(id); p.x = Math.round(A.start[i][0] + mx); p.y = Math.round(A.start[i][1] + my); });
    if (A.frame) {
      const F = kmFrame(A.frame);
      F.x = Math.round(A.fstart[0] + mx); F.y = Math.round(A.fstart[1] + my);
      // Striche: neues Objekt, damit die gespeicherte Darstellung (Cache) nicht veraltet
      A.ink.forEach(([i, pts]) => { km.ink[i] = { ...km.ink[i], pts: pts.map((v, j) => (j % 3 === 0 ? v + mx : j % 3 === 1 ? v + my : v)) }; });
    }
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
  if (kmPinch) { if (kmPtrs.size < 2) { kmPinch = null; km.view = { ...kmView }; saveNote(); kmRender(); } return; }
  const A = kmAct;
  if (!A || A.id !== e.pointerId) return;
  kmAct = null;
  if (A.type === 'pan') {
    if (A.moved) { km.view = { ...kmView }; saveNote(); }
    else if (A.tap) { kmSelect(null); kmLinkMode && kmSetLinkMode(false); }
  } else if (A.type === 'move' || A.type === 'resize') {
    if (A.moved) { kmUndo.push(A.before); kmRedo = []; kmSaved(); }
  } else if (A.type === 'ink') {
    const st = A.stroke;
    if (st.pts.length >= 3) kmChange(() => km.ink.push(st));
    else kmRender();
  } else if (A.type === 'erase') {
    if (A.hitAny) { kmUndo.push(A.before); kmRedo = []; kmSaved(); }
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
    if (s.t === 'g') { km.groups = km.groups.filter((g) => g.id !== s.id); km.persons.forEach((p) => kmLeave(p, s.id)); }
    if (s.t === 'f') km.frames = km.frames.filter((f) => f.id !== s.id);
    if (s.t === 'fall') { const F = kmFrame(s.id), c = kmFrameContent(F), ids = new Set(c.persons.map((p) => p.id)); km.persons = km.persons.filter((p) => !ids.has(p.id)); km.links = km.links.filter((l) => !ids.has(l.a) && !ids.has(l.b)); km.ink = km.ink.filter((x) => !c.ink.includes(x)); km.frames = km.frames.filter((f) => f !== F); }
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
  kmChange(() => { km.groups.push(g); kmJoin(p, g.id); });
  kmSelect({ t: 'g', id: g.id });
  toast('Weitere Personen über ihr Feld „Gruppe“ hinzufügen');
}

// Automatisch anordnen: Federmodell (Beziehungen ziehen, alle stoßen sich ab, Gruppen halten zusammen).
// Jeder Akt-Kasten wird für sich angeordnet und wächst bei Bedarf mit; der Rest außerhalb gemeinsam.
function kmForce(P) {
  const n = P.length;
  if (n < 2) return;
  const idx = new Map(P.map((p, i) => [p.id, i]));
  const pos = P.map((p) => [p.x, p.y]);
  const cx0 = pos.reduce((s, q) => s + q[0], 0) / n, cy0 = pos.reduce((s, q) => s + q[1], 0) / n;
  const L = km.links.map((l) => [idx.get(l.a), idx.get(l.b)]).filter(([a, b]) => a != null && b != null);
  const ideal = 210;
  for (let it = 0; it < 450; it++) {
    const temp = 30 * (1 - it / 450) + 1, f = pos.map(() => [0, 0]);
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      let dx = pos[i][0] - pos[j][0], dy = pos[i][1] - pos[j][1], d = Math.hypot(dx, dy);
      if (d < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d = 1; }
      if (d > ideal * 3) continue;          // weit Entferntes stößt nicht mehr ab (sonst fliegt alles auseinander)
      const rep = (ideal * ideal) / d * ((P[i].groups || []).some((g) => kmIn(P[j], g)) ? 0.5 : 1);
      f[i][0] += (dx / d) * rep; f[i][1] += (dy / d) * rep; f[j][0] -= (dx / d) * rep; f[j][1] -= (dy / d) * rep;
    }
    for (const [a, b] of L) {
      const dx = pos[a][0] - pos[b][0], dy = pos[a][1] - pos[b][1], d = Math.hypot(dx, dy) || 1, att = (d * d) / ideal;
      f[a][0] -= (dx / d) * att; f[a][1] -= (dy / d) * att; f[b][0] += (dx / d) * att; f[b][1] += (dy / d) * att;
    }
    // Gruppen: zum gemeinsamen Mittelpunkt ziehen
    for (const g of km.groups) {
      const ms = P.map((p, i) => (kmIn(p, g.id) ? i : -1)).filter((i) => i >= 0);
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
  // Mittelpunkt bleibt, wo er war
  const cx1 = pos.reduce((s, q) => s + q[0], 0) / n, cy1 = pos.reduce((s, q) => s + q[1], 0) / n;
  P.forEach((p, i) => { p.x = Math.round(pos[i][0] - cx1 + cx0); p.y = Math.round(pos[i][1] - cy1 + cy0); });
}
function kmLayout() {
  if (km.persons.length < 2) return;
  kmChange(() => {
    const done = new Set();
    for (const F of km.frames) {
      const P = kmFrameContent(F).persons.filter((p) => !done.has(p.id));
      P.forEach((p) => done.add(p.id));
      if (!P.length) continue;
      // erst in die Mitte des Kastens, dann anordnen, dann den Kasten passend machen
      const cx = P.reduce((s, p) => s + p.x, 0) / P.length, cy = P.reduce((s, p) => s + p.y, 0) / P.length;
      P.forEach((p) => { p.x += F.x + F.w / 2 - cx; p.y += F.y + 17 + F.h / 2 - cy; });
      kmForce(P);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      P.forEach((p) => { const b = kmBox(p); x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); });
      const nx0 = Math.min(F.x, x0 - 50), ny0 = Math.min(F.y, y0 - 70), nx1 = Math.max(F.x + F.w, x1 + 50), ny1 = Math.max(F.y + F.h, y1 + 50);
      Object.assign(F, { x: Math.round(nx0), y: Math.round(ny0), w: Math.round(nx1 - nx0), h: Math.round(ny1 - ny0) });
    }
    kmForce(km.persons.filter((p) => !done.has(p.id)));
  });
  kmFit();
}

// ---- Akt-Kästen ----
// Inhalt: Personen, deren Mitte im Kasten liegt, und Striche, die überwiegend darin liegen
function kmFrameContent(F) {
  const inside = (x, y) => x >= F.x && x <= F.x + F.w && y >= F.y && y <= F.y + F.h;
  return {
    persons: km.persons.filter((p) => inside(p.x, p.y)),
    ink: km.ink.filter((s) => { const b = kmInkBox(s); return inside(b.x + b.w / 2, b.y + b.h / 2); })
  };
}
const kmNextName = (name) => (/\d+\s*$/.test(name) ? name.replace(/(\d+)\s*$/, (m) => String(Number(m) + 1)) : name + ' (2)');
function kmAddFrame() {
  const def = km.frames.length ? kmNextName(km.frames[km.frames.length - 1].name || 'Akt 1') : 'Akt 1';
  const name = prompt('Name des Kastens (z. B. Akt 1, Kapitel 3, Vorher):', def);
  if (name == null) return;
  let F;
  kmChange(() => {
    const color = KM_COLORS[[7, 0, 4, 6, 3, 1, 5, 2][km.frames.length % 8]];
    if (!km.frames.length && km.persons.length) {
      // erster Kasten: um alles, was schon da ist
      const b = kmBounds(kmScene());
      F = { id: kmId('f'), name: name.trim() || def, color, x: Math.round(b.x - 50), y: Math.round(b.y - 70), w: Math.round(b.w + 100), h: Math.round(b.h + 120) };
    } else {
      const last = km.frames[km.frames.length - 1];
      const r = kmStage().getBoundingClientRect();
      const w = last ? last.w : 640, h = last ? last.h : 440;
      const x = last ? Math.max(...km.frames.filter((o) => o.y < last.y + last.h && o.y + o.h > last.y).map((o) => o.x + o.w)) + 60 : (r.width / 2 - kmView.x) / kmView.z - w / 2;
      F = { id: kmId('f'), name: name.trim() || def, color, x: Math.round(x), y: Math.round(last ? last.y : (r.height / 2 - kmView.y) / kmView.z - h / 2), w, h };
    }
    km.frames.push(F);
  });
  kmSelect({ t: 'f', id: F.id });
  kmShow(F);
}
// Kasten mit Inhalt rechts daneben kopieren (z. B. Akt 1 → Akt 2) – dort die Veränderungen eintragen
function kmDupFrame(F) {
  const c = kmFrameContent(F), dx = F.w + 60;
  const others = km.frames.filter((o) => o !== F && o.y < F.y + F.h && o.y + o.h > F.y && o.x >= F.x + F.w);
  const shift = others.length ? Math.max(...others.map((o) => o.x + o.w)) + 60 - F.x : dx;
  let N;
  kmChange(() => {
    const map = new Map(), gmap = new Map();
    for (const p of c.persons) {
      const q = { ...p, id: kmId('p'), x: p.x + shift };
      if (p.groups) q.groups = p.groups.map((g) => { if (!gmap.has(g)) { const G = kmGroup(g); const ng = { ...G, id: kmId('g') }; km.groups.push(ng); gmap.set(g, ng.id); } return gmap.get(g); });
      map.set(p.id, q.id);
      km.persons.push(q);
    }
    for (const l of km.links.slice()) if (map.has(l.a) && map.has(l.b)) km.links.push({ ...l, id: kmId('l'), a: map.get(l.a), b: map.get(l.b) });
    for (const st of c.ink) km.ink.push({ ...st, pts: st.pts.map((v, j) => (j % 3 === 0 ? v + shift : v)) });
    N = { ...F, id: kmId('f'), name: kmNextName(F.name || 'Akt 1'), x: F.x + shift };
    km.frames.push(N);
  });
  kmSelect({ t: 'f', id: N.id });
  kmShow(N);
  toast(`„${N.name}“ angelegt – hier die Veränderungen eintragen`);
}
// Kasten ins Bild holen (ohne zu zoomen, wenn er schon passt)
function kmShow(F) {
  const r = kmStage().getBoundingClientRect();
  const z = Math.min(kmView.z, (r.width - 40) / F.w, (r.height - 40) / F.h);
  kmView = { z, x: r.width / 2 - (F.x + F.w / 2) * z, y: r.height / 2 - (F.y + F.h / 2) * z };
  km.view = { ...kmView };
  kmRender();
}

// ---- Stift ----
function kmEraseAt(x, y) {
  const r = 10 / kmView.z, keep = km.ink.filter((s) => !strokeHit(s, x, y, r));
  if (keep.length !== km.ink.length) { km.ink = keep; kmAct.hitAny = true; kmRenderSoon(); }
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
      `<div class="km-f"><span>Gruppen (mehrere möglich)</span><div class="km-types">${km.groups.map((g) => `<button type="button" class="km-type${kmIn(o, g.id) ? ' on' : ''}" data-pg="${g.id}" style="--c:${g.color}">${kmEsc(g.name)}</button>`).join('')}<button type="button" class="chip" data-pgnew="1">＋ Neue Gruppe</button></div></div>` +
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
  } else if (kmSel.t === 'f') {
    const c = kmFrameContent(o);
    h = '<div class="km-ph"><b>Kasten</b><button type="button" class="btn small link" data-x="close">Fertig</button></div>' +
      `<label class="km-f"><span>Name</span><input id="km-fname" value="${kmEsc(o.name)}" maxlength="40" autocomplete="off" placeholder="z. B. Akt 1"></label>` +
      `<div class="km-f"><span>Farbe</span><div class="km-sws">${sw(o.color, 'data-fc')}</div></div>` +
      `<p class="muted small-text">Darin: ${c.persons.length} Personen${c.ink.length ? `, ${c.ink.length} Striche` : ''}. Am Titel ziehen = Kasten mit Inhalt verschieben, am Kreis unten rechts = Größe. Personen einfach hinein- oder herausziehen.</p>` +
      '<button type="button" class="btn primary small" data-x="fdup">Als nächsten Akt kopieren →</button>' +
      '<p class="muted small-text">Legt daneben eine Kopie an (z. B. „Akt 2“). Dort einfach eintragen, was sich ändert – so sieht man die Entwicklung nebeneinander.</p>' +
      `<label class="km-f"><span>Notizen (Inhalt, Wendepunkte …)</span><textarea id="km-fdesc" rows="3">${kmEsc(o.desc || '')}</textarea></label>` +
      '<div class="km-actions"><button type="button" class="btn small" data-x="del">Nur Kasten entfernen</button><button type="button" class="btn small danger-text" data-x="fall">Mit Inhalt löschen</button></div>';
  } else {
    const ms = km.persons.filter((p) => kmIn(p, o.id));
    h = '<div class="km-ph"><b>Gruppe</b><button type="button" class="btn small link" data-x="close">Fertig</button></div>' +
      `<label class="km-f"><span>Name</span><input id="km-gname" value="${kmEsc(o.name)}" maxlength="40" autocomplete="off"></label>` +
      `<div class="km-f"><span>Farbe</span><div class="km-sws">${sw(o.color, 'data-gc')}</div></div>` +
      `<div class="km-f"><span>Mitglieder (${ms.length})</span><div class="km-rels">${km.persons.map((p) => `<label class="km-member"><input type="checkbox" data-mem="${p.id}"${kmIn(p, o.id) ? ' checked' : ''}> ${kmEsc(p.name)}</label>`).join('')}</div></div>` +
      '<p class="muted small-text">Am Namen der Gruppe ziehen = alle Mitglieder verschieben. Eine Person kann in mehreren Gruppen sein.</p>' +
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
  const map = { 'km-name': 'name', 'km-role': 'role', 'km-emoji': 'emoji', 'km-desc': 'desc', 'km-label': 'label', 'km-ldesc': 'desc', 'km-gname': 'name', 'km-fname': 'name', 'km-fdesc': 'desc' };
  if (!map[id]) return;
  if (kmTyping !== id + o.id) { kmUndo.push(kmSnap()); kmRedo = []; kmTyping = id + o.id; }
  o[map[id]] = /desc$/.test(id) ? e.target.value : e.target.value.trimStart();
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
  if (d.mem) return set(() => { const p = kmPerson(d.mem); if (b.checked) kmJoin(p, o.id); else kmLeave(p, o.id); });
  if (d.pg) return set(() => { if (kmIn(o, d.pg)) kmLeave(o, d.pg); else kmJoin(o, d.pg); });
  if (d.pgnew) {
    const name = (prompt('Name der neuen Gruppe (z. B. Familie, Adel, die Rebellen):') || '').trim().slice(0, 40);
    if (!name) return;
    const g = { id: kmId('g'), name, color: KM_COLORS.find((c) => !km.groups.some((x) => x.color === c) && c !== o.color) || KM_COLORS[km.groups.length % 8] };
    return set(() => { km.groups.push(g); kmJoin(o, g.id); });
  }
  if (d.fc) return set(() => { o.color = d.fc; });
  if (d.x === 'fdup') return kmDupFrame(o);
  if (d.x === 'fall') { if (!confirm(`„${o.name}“ mit allen Personen und Strichen darin löschen?`)) return; kmSel = { t: 'fall', id: o.id }; return kmDelete(); }
  if (b.id === 'km-big') return set(() => { o.big = b.checked; });
}
// ---- Export als Bild (Canvas, ohne Umweg – damit das iPad das Teilen-Menü erlaubt) ----
function kmDrawScene(ctx, sc) {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const rr = (x, y, w, h, r) => { ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h); };
  for (const F of sc.frames) {
    const c = F.color || '#6b7280';
    rr(F.x, F.y, F.w, F.h, 18);
    ctx.globalAlpha = 0.04; ctx.fillStyle = c; ctx.fill(); ctx.globalAlpha = 0.55; ctx.strokeStyle = c; ctx.lineWidth = 2; ctx.stroke(); ctx.globalAlpha = 1;
    ctx.font = `700 16px ${KM_FONT}`;
    const tw = ctx.measureText(F.name || 'Akt').width + 28;
    rr(F.x, F.y, tw, 34, 16); ctx.fillStyle = c; ctx.fill(); ctx.fillRect(F.x, F.y + 17, tw, 17);
    ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.fillText(F.name || 'Akt', F.x + 14, F.y + 23);
  }
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
  for (const st of sc.ink) drawStroke(ctx, st);
}
function kmImageFile() {
  if (!km || (!km.persons.length && !km.ink.length && !km.frames.length)) { toast('Noch nichts gezeichnet'); return null; }
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
  return dataUrlToFile(cv.toDataURL('image/png'), `${(title || 'Personenkonstellation').replace(/[\\/:*?"<>|]/g, '_')}.png`);
}
function kmExport() {
  const file = kmImageFile();
  if (file) shareFiles([file], note.title || 'Personenkonstellation');
}

// ---- In eine normale Notiz einfügen (als Bild, dort verschieben/skalieren/beschriften) ----
async function kmToNote() {
  const file = kmImageFile();
  if (!file) return;
  const from = note;
  let all = [];
  try { all = await noteDb.all(); } catch {}
  const list = all.filter((n) => n.kind !== 'kmap').sort((a, b) => b.updated - a.updated);
  let dlg = kmEl('#km-pick');
  if (!dlg) { dlg = document.createElement('dialog'); dlg.id = 'km-pick'; document.body.append(dlg); }
  dlg.innerHTML = '<h3>In welche Notiz einfügen?</h3><div class="menu-list km-pick-list">' +
    '<button type="button" class="menu-item" data-n="__new"><b>＋ Neue Notiz</b></button>' +
    list.map((n) => `<button type="button" class="menu-item" data-n="${kmEsc(n.id)}">${kmEsc(noteName(n))}<span class="muted small-text"> · ${new Date(n.updated).toLocaleDateString('de-DE', { day: 'numeric', month: 'short' })}${n.folder && folderName(n.folder) ? ' · ' + kmEsc(folderName(n.folder)) : ''}</span></button>`).join('') +
    '</div><div class="dlg-actions"><button type="button" class="btn" data-close>Abbrechen</button></div>';
  dlg.querySelector('[data-close]').addEventListener('click', () => dlg.close());
  dlg.querySelectorAll('[data-n]').forEach((b) => b.addEventListener('click', async () => {
    dlg.close();
    await flushNoteSave();
    if (b.dataset.n === '__new') {
      await createNote(from.folder);
      note.title = from.title || 'Personenkonstellation';
      $('#note-title').value = note.title;
      saveNote();
    } else await openNote(list.find((n) => n.id === b.dataset.n));
    await new Promise((r) => requestAnimationFrame(r));
    const known = new Set(note.pages.flatMap((pg) => pg.strokes));
    await insertImageElement(file);
    // fast seitenbreit statt der üblichen halben Breite – ein Diagramm braucht Platz
    // (neues Objekt statt ändern: die Darstellung ist pro Objekt zwischengespeichert)
    note.pages.forEach((pg, i) => pg.strokes.forEach((st, k) => {
      if (st.tool !== 'image' || known.has(st)) return;
      const w = Math.min(PAGE_W - 80, st.w * 1.8), h = Math.min((w * st.ph) / st.pw, PAGE_H - 80);
      const big = { ...st, w, h, x: (PAGE_W - w) / 2, y: clamp(st.y + st.h / 2 - h / 2, 40, PAGE_H - h - 40) };
      pg.strokes[k] = big;
      const last = undoStack[undoStack.length - 1];
      if (last) last.forEach((c) => { if (c.after) c.after = c.after.map((x) => (x === st ? big : x)); });
      deselectImage();
      drawPage(i);
      selectImage(i, big);
    }));
    saveNote();
    toast('Eingefügt – mit dem Pfeil verschieben oder an den Ecken größer ziehen');
  }));
  dlg.showModal();
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
  kmEl('#km-draw').classList.toggle('active', kmDraw);
  kmEl('#km-inkbar').hidden = !kmDraw;
  kmEl('#km-inkbar').querySelectorAll('[data-ink]').forEach((b) => b.classList.toggle('active', !kmErase && Number(b.dataset.ink) === kmInk));
  kmEl('#km-erase').classList.toggle('active', kmErase);
  kmEl('#km-stage').classList.toggle('drawing', kmDraw);
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
    `<button class="tool" id="km-frame-add" aria-label="Akt-Kasten (z. B. Akt 1, Kapitel)">${ico('<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M3 9h7V4"/>')}</button>` +
    `<button class="tool" id="km-draw" aria-label="Stift: frei schreiben und zeichnen">${ico('<path d="M5 19l2-6L17 3l4 4-10 10z"/><path d="M15 5l4 4"/>')}</button>` +
    `<button class="tool" id="km-legend-btn" aria-label="Legende ein/aus">${ico('<path d="M4 7h4M4 12h4M4 17h4M11 7h9M11 12h9M11 17h9"/>')}</button></div>` +
    '<div class="tool-group zoom-group"><button class="tool" id="km-zout" aria-label="Verkleinern">−</button><button class="tool zoom-label" id="km-zoom" aria-label="Alles zeigen">100%</button><button class="tool" id="km-zin" aria-label="Vergrößern">+</button>' +
    `<button class="tool" id="km-fit" aria-label="Alles zeigen">${ico('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>')}</button>` +
    `<button class="tool" id="km-tonote" aria-label="Als Bild in eine Notiz einfügen">${ico('<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h5"/><path d="M15 15h5M17.5 12.5v5"/>')}</button>` +
    `<button class="tool" id="km-export" aria-label="Als Bild teilen">${ico('<path d="M12 3v12M8 7l4-4 4 4"/><path d="M6 11H5v10h14V11h-1"/>')}</button></div>` +
    `<div class="tool-group km-inkbar" id="km-inkbar" hidden>${PEN_COLORS.map((c, i) => `<button class="tool swatch" data-ink="${i}" style="--c:${c}" aria-label="Stiftfarbe"></button>`).join('')}` +
    `<button class="tool" id="km-erase" aria-label="Radierer (Striche)">${ico('<path d="M4 15l9-9a2 2 0 012.8 0l3.2 3.2a2 2 0 010 2.8L13 18H7z"/><path d="M9 11l6 6"/><path d="M7 21h13"/>')}</button></div></div>` +
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
  on('#km-tonote', kmToNote);
  on('#km-frame-add', kmAddFrame);
  on('#km-draw', () => { kmDraw = !kmDraw; kmErase = false; if (kmDraw) { kmLinkMode = false; toast(fingerDraw ? 'Stift: schreiben mit Stift oder Finger · zwei Finger = verschieben' : 'Stift: mit dem Pencil schreiben · Finger verschiebt'); } kmBarState(); });
  on('#km-erase', () => { kmErase = !kmErase; kmBarState(); });
  kmEl('#km-inkbar').addEventListener('click', (e) => { const b = e.target.closest('[data-ink]'); if (!b) return; kmInk = Number(b.dataset.ink); kmErase = false; store.set('kmInk', kmInk); kmBarState(); });
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
