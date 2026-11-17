// ---------- Personenkonstellation (eigene Notiz-Art) ----------
// Eine Notiz mit kind: 'kmap' zeigt statt der Seiten ein Diagramm: Personen (Karten), Beziehungen
// (Pfeile mit Bezeichnung) und Gruppen (Kästen um mehrere Personen, z. B. Familien oder Lager).
// Gespeichert wird alles in note.kmap; die Notiz selbst läuft über dieselbe Speicherung wie alle Notizen.
//
// Bedienung: Doppeltippen auf die Fläche = neue Person · Person antippen und am ⊕ ziehen = Beziehung
// (loslassen auf leerer Fläche = neue Person mit Beziehung) · Finger auf der Fläche = verschieben ·
// Stift/Maus auf der Fläche = Auswahlrahmen · zwei Finger oder Strg+Mausrad = zoomen.
// Akt-Kästen (frames): frei platzierte Rahmen, z. B. „Akt 1“ – alles, was darin liegt, wandert mit;
// „als nächsten Akt kopieren“ legt daneben eine Kopie an (Herkunft in src/from → Änderungen markieren).
// Stapel (stacks): mehrere Kästen übereinander mit Reitern („zusammengelegt“) oder nebeneinander
// („ausgefächert“). Zusammengelegt gehört der Inhalt fest zu seinem Kasten (p.frame / ink.frame).
// Stift (ink): freie Striche wie in normalen Notizen (gleiche Glättung, notes.js).
// Verknüpfte Stellen (refs): Person/Beziehung → Stelle in einer normalen Notiz (antippen = hinspringen).

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
const KM_NEW = '#16a34a', KM_CHG = '#d97706', KM_GONE = '#9ca3af';   // Markierungen: neu, geändert, weggefallen
const kmType = (id) => KM_TYPES.find((t) => t.id === id) || KM_TYPES[KM_TYPES.length - 1];
const kmId = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const kmEsc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Farbe mit Weiß mischen (helle Kartenfarbe)
function kmTint(hex, f) {
  const n = parseInt(hex.slice(1), 16), c = [n >> 16, (n >> 8) & 255, n & 255].map((v) => Math.round(v + (255 - v) * f));
  return `rgb(${c.join(',')})`;
}

let km = null;              // Daten der offenen Konstellation (= note.kmap)
let kmSel = null;           // { t: 'p'|'l'|'g'|'f', id } oder { t: 'm', ids: [...], ink: [...] } (Mehrfachauswahl)
let kmView = { x: 0, y: 0, z: 1 };   // Bildschirm = Welt * z + (x, y)
let kmUndo = [], kmRedo = [];
let kmFocus = false, kmLegend = store.get('kmLegend', true), kmLinkMode = false;
let kmDiff = store.get('kmDiff', true);   // Änderungen zum vorigen Akt markieren
let kmGrid = store.get('kmGrid', false);  // am Raster ausrichten
const KM_GRID = 20;
const kmGridV = (v) => (kmGrid ? Math.round(v / KM_GRID) * KM_GRID : Math.round(v));
let kmSelMode = false;      // Auswahlrahmen auch mit dem Finger
let kmAct = null;           // laufende Geste
const kmPtrs = new Map();   // aktive Finger/Stifte (für Zwei-Finger-Zoom)
let kmPinch = null;
let kmLastType = store.get('kmLastType', 'friend');
let kmDraw = false, kmErase = false, kmInk = store.get('kmInk', 0);   // Stift-Modus, Radierer, Farbe
let kmRaf = 0;
let kmPick = null;          // Stelle in einer Notiz verknüpfen: { kmNote, kind, id }
let kmBackTo = null;        // nach dem Springen zu einer Stelle: zurück zu dieser Konstellation

const kmEl = (s) => document.querySelector(s);
const kmStage = () => kmEl('#km-stage');
const kmPerson = (id) => km.persons.find((p) => p.id === id);
const kmLink = (id) => km.links.find((l) => l.id === id);
const kmGroup = (id) => km.groups.find((g) => g.id === id);
const kmFrame = (id) => km.frames.find((f) => f.id === id);
const kmStackOf = (fid) => km.stacks.find((s) => s.frames.includes(fid));
const kmBlank = () => ({ persons: [], links: [], groups: [], frames: [], ink: [], stacks: [], view: null });
// Gruppen einer Person (früher nur eine: p.group)
const kmIn = (p, gid) => !!(p.groups && p.groups.includes(gid));
const kmJoin = (p, gid) => { if (!kmIn(p, gid)) p.groups = (p.groups || []).concat(gid); };
const kmLeave = (p, gid) => { if (p.groups) { p.groups = p.groups.filter((g) => g !== gid); if (!p.groups.length) delete p.groups; } };
const KM_DATA = ['persons', 'links', 'groups', 'frames', 'ink', 'stacks'];
const kmMoveInk = (st, dx, dy, extra) => ({ ...st, ...extra, pts: st.pts.map((v, j) => (j % 3 === 0 ? v + dx : j % 3 === 1 ? v + dy : v)) });

// ---- Notiz anlegen / öffnen ----
async function kmCreate(folder) {
  const n = newNote();
  n.kind = 'kmap';
  n.kmap = kmBlank();
  if (folder) n.folder = folder;
  await noteDb.put(n).catch(() => {});
  showView('notes');
  await openNote(n);
  toast('Neue Personenkonstellation – doppeltippe auf die Fläche oder wähle eine Vorlage');
}

function kmOpen(n) {
  if (!n.kmap) n.kmap = kmBlank();
  km = n.kmap;
  KM_DATA.forEach((k) => { if (!Array.isArray(km[k])) km[k] = []; });
  km.persons.forEach((p) => { if (p.group) { kmJoin(p, p.group); delete p.group; } });
  kmSel = null; kmUndo = []; kmRedo = []; kmAct = null; kmPtrs.clear(); kmPinch = null;
  kmLinkMode = false; kmFocus = false; kmDraw = false; kmErase = false; kmSelMode = false;
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
  kmFixStacks();
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
function kmSelObj() {
  if (!kmSel) return null;
  if (kmSel.t === 'm') return kmSel.ids.some((id) => kmPerson(id)) || kmSel.ink.some((s) => km.ink.includes(s)) ? kmSel : null;
  return kmSel.t === 'p' ? kmPerson(kmSel.id) : kmSel.t === 'l' ? kmLink(kmSel.id) : kmSel.t === 'f' ? kmFrame(kmSel.id) : kmGroup(kmSel.id);
}

// ---- Stapel: Kästen zusammenlegen / ausfächern ----
// Aufräumen: fehlende Kästen raus, Stapel mit < 2 Kästen auflösen, Markierungen nur in zusammengelegten
function kmFixStacks() {
  for (const s of km.stacks) {
    s.frames = s.frames.filter((id) => kmFrame(id));
    if (!s.frames.includes(s.active)) s.active = s.frames[0];
  }
  km.stacks = km.stacks.filter((s) => s.frames.length >= 2);
  const tagged = new Set(km.stacks.filter((s) => !s.open).flatMap((s) => s.frames));
  km.persons.forEach((p) => { if (p.frame && !tagged.has(p.frame)) delete p.frame; });
  km.ink = km.ink.map((st) => (st.frame && !tagged.has(st.frame) ? (({ frame: _f, ...r }) => r)(st) : st));
}
// Was ist gerade unsichtbar? (Kästen eines zusammengelegten Stapels, die nicht vorne liegen)
function kmVis() {
  const hidF = new Set();
  for (const s of km.stacks) if (!s.open) s.frames.forEach((id) => { if (id !== s.active) hidF.add(id); });
  return {
    hidF,
    hidP: new Set(km.persons.filter((p) => p.frame && hidF.has(p.frame)).map((p) => p.id)),
    inkOk: (st) => !(st.frame && hidF.has(st.frame))
  };
}
function kmCollapse(s) {
  const frames = s.frames.map(kmFrame);
  const contents = frames.map((F) => kmFrameContent(F));
  const x0 = frames[0].x, y0 = frames[0].y;
  frames.forEach((F, i) => {
    const dx = x0 - F.x, dy = y0 - F.y, c = contents[i];
    F.x = x0; F.y = y0;
    c.persons.forEach((p) => { p.x += dx; p.y += dy; p.frame = F.id; });
    km.ink = km.ink.map((st) => (c.ink.includes(st) ? kmMoveInk(st, dx, dy, { frame: F.id }) : st));
  });
  if (!s.frames.includes(s.active)) s.active = s.frames[0];
  s.open = false;
}
function kmFan(s) {
  const frames = s.frames.map(kmFrame);
  let x = frames[0].x;
  const y0 = frames[0].y;
  frames.forEach((F) => {
    const dx = x - F.x, dy = y0 - F.y;
    km.persons.forEach((p) => { if (p.frame === F.id) { p.x += dx; p.y += dy; delete p.frame; } });
    km.ink = km.ink.map((st) => (st.frame === F.id ? (({ frame: _f, ...r }) => r)(kmMoveInk(st, dx, dy)) : st));
    F.x = x; F.y = y0;
    x += F.w + 60;
  });
  s.open = true;
}
// Neue/verschobene Personen und Striche: liegen sie im vorderen Kasten eines zusammengelegten Stapels,
// gehören sie zu ihm (sonst würden sie beim Umblättern auf allen Reitern stehen)
function kmTagAt(x, y) {
  for (const s of km.stacks) {
    if (s.open) continue;
    const F = kmFrame(s.active);
    if (F && x >= F.x && x <= F.x + F.w && y >= F.y && y <= F.y + F.h) return F.id;
  }
  return null;
}
function kmRetag(p) {
  const t = kmTagAt(p.x, p.y);
  if (t) p.frame = t; else delete p.frame;
}

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
// Bogen zwischen zwei Personen (off = seitlicher Versatz) → Endpunkte, Kontrollpunkt, Pfeile, Label-Ort
function kmCurve(A, B, bA, bB, off) {
  const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2, dx = B.x - A.x, dy = B.y - A.y, d = Math.hypot(dx, dy) || 1;
  const cx = mx - (dy / d) * off * 2, cy = my + (dx / d) * off * 2;
  const a = kmEdge(A, bA, cx - A.x, cy - A.y), b = kmEdge(B, bB, cx - B.x, cy - B.y);
  return { a, b, c: [cx, cy], lx: 0.25 * a[0] + 0.5 * cx + 0.25 * b[0], ly: 0.25 * a[1] + 0.5 * cy + 0.25 * b[1] };
}
const kmLinkText = (l) => l.label || kmType(l.type).name;

// Vergleich mit dem vorigen Akt (Kasten mit „from“): neu, geändert, weggefallen
function kmDiffs(vis) {
  const out = { newP: new Set(), chgP: new Map(), newL: new Set(), chgL: new Map(), ghosts: [], gone: [] };
  if (!kmDiff) return out;
  for (const N of km.frames) {
    const S = N.from && kmFrame(N.from);
    if (!S || vis.hidF.has(N.id)) continue;
    const cN = kmFrameContent(N), cS = kmFrameContent(S);
    const sP = new Map(cS.persons.map((p) => [p.id, p])), copy = new Map();
    for (const p of cN.persons) {
      const o = p.src && sP.get(p.src);
      if (!o) { out.newP.add(p.id); continue; }
      copy.set(o.id, p);
      const what = [o.name !== p.name && `Name: ${o.name}`, (o.role || '') !== (p.role || '') && `vorher: ${o.role || '–'}`].filter(Boolean);
      if (what.length) out.chgP.set(p.id, what.join(' · '));
    }
    const nIds = new Set(cN.persons.map((p) => p.id)), sIds = new Set(cS.persons.map((p) => p.id));
    const sL = new Map(km.links.filter((l) => sIds.has(l.a) && sIds.has(l.b)).map((l) => [l.id, l]));
    const nL = km.links.filter((l) => nIds.has(l.a) && nIds.has(l.b));
    const kept = new Set();
    for (const l of nL) {
      const o = l.src && sL.get(l.src);
      if (!o) { out.newL.add(l.id); continue; }
      kept.add(o.id);
      if (o.type !== l.type || (o.label || '') !== (l.label || '') || (o.dir || 'ab') !== (l.dir || 'ab')) out.chgL.set(l.id, kmLinkText(o));
    }
    // weggefallene Beziehungen zwischen Personen, die es im neuen Akt noch gibt
    for (const o of sL.values()) {
      if (kept.has(o.id)) continue;
      const A = copy.get(o.a), B = copy.get(o.b);
      if (A && B) out.ghosts.push({ A, B, text: kmLinkText(o) });
    }
    const gone = cS.persons.filter((p) => !copy.has(p.id)).map((p) => p.name);
    if (gone.length) out.gone.push({ F: N, names: gone });
  }
  return out;
}

// Szene: alles, was gezeichnet wird – einmal berechnet, für Bildschirm (SVG) und Export (Canvas)
function kmScene() {
  const vis = kmVis();
  const persons = km.persons.filter((p) => !vis.hidP.has(p.id));
  const boxes = new Map(persons.map((p) => [p.id, kmBox(p)]));
  // Gruppen: eine Person kann in mehreren sein. Überlappen sich Gruppen, bekommt die größere mehr
  // Abstand – so umschließt sie die kleinere sichtbar.
  const mem = new Map(km.groups.map((g) => [g.id, persons.filter((p) => kmIn(p, g.id))]));
  const groups = km.groups.map((g) => {
    const ms = mem.get(g.id);
    if (!ms.length) return null;
    const inner = km.groups.filter((o) => o !== g && mem.get(o.id).length < ms.length && mem.get(o.id).some((p) => ms.includes(p))).length;
    const pad = 16 + inner * 12;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    ms.forEach((p) => { const b = boxes.get(p.id); x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); });
    return { g, n: ms.length, x: x0 - pad, y: y0 - pad - 18, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 + 18 };
  }).filter(Boolean).sort((a, b) => b.n - a.n);
  const diff = kmDiffs(vis);
  // mehrere Beziehungen zwischen denselben zwei Personen: nebeneinander gebogen
  const shown = km.links.filter((l) => boxes.has(l.a) && boxes.has(l.b) && l.a !== l.b);
  const pairs = new Map();
  shown.forEach((l) => { const k = [l.a, l.b].sort().join('|'); if (!pairs.has(k)) pairs.set(k, []); pairs.get(k).push(l); });
  const links = [];
  for (const l of shown) {
    const A = kmPerson(l.a), B = kmPerson(l.b);
    const same = pairs.get([l.a, l.b].sort().join('|'));
    const k = same.indexOf(l), n = same.length;
    // Richtung immer von der „kleineren“ Id aus, damit gegenläufige Beziehungen nicht übereinander liegen
    const flip = l.a > l.b ? -1 : 1;
    const g = kmCurve(A, B, boxes.get(A.id), boxes.get(B.id), (k - (n - 1) / 2) * 34 * flip + (l.bend || 0));
    const ty = kmType(l.type), w = 1.4 + (l.w || 2) * 0.8;
    const arrows = [];
    if (l.dir === 'ab' || l.dir === 'both') arrows.push({ x: g.b[0], y: g.b[1], ang: Math.atan2(g.b[1] - g.c[1], g.b[0] - g.c[0]) });
    if (l.dir === 'ba' || l.dir === 'both') arrows.push({ x: g.a[0], y: g.a[1], ang: Math.atan2(g.a[1] - g.c[1], g.a[0] - g.c[0]) });
    const old = diff.chgL.get(l.id), mark = diff.newL.has(l.id) ? 'new' : old != null ? 'chg' : '';
    const text = old != null && old !== kmLinkText(l) ? `${old} → ${kmLinkText(l)}` : l.label || (mark === 'new' ? kmType(l.type).name : '');
    links.push({ l, a: g.a, b: g.b, c: g.c, color: l.color || ty.color, dash: l.dash || ty.dash, w, arrows, mark, label: text ? { x: g.lx, y: g.ly, text: (mark === 'new' ? '★ ' : '') + text } : null });
  }
  const ghosts = diff.ghosts.filter((x) => boxes.has(x.A.id) && boxes.has(x.B.id)).map((x) => ({ ...kmCurve(x.A, x.B, boxes.get(x.A.id), boxes.get(x.B.id), 0), text: '✕ ' + x.text }));
  const frames = km.frames.filter((F) => !vis.hidF.has(F.id));
  // Stapel: Reiter (zusammengelegt) bzw. Klammer über allen Kästen (ausgefächert)
  const stacks = km.stacks.map((s) => {
    const fs = s.frames.map(kmFrame);
    if (!s.open) { const F = kmFrame(s.active); return { s, x: F.x, y: F.y - 44, w: F.w, fs }; }
    const x0 = Math.min(...fs.map((F) => F.x)), x1 = Math.max(...fs.map((F) => F.x + F.w)), y0 = Math.min(...fs.map((F) => F.y));
    return { s, x: x0, y: y0 - 44, w: x1 - x0, fs };
  });
  return { boxes, persons, groups, links, ghosts, diff, frames, stacks, ink: km.ink.filter(vis.inkOk) };
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
  sc.stacks.forEach((t) => add(t.x, t.y, t.w, 40));
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
const kmIsSel = (t, id) => kmSel && ((kmSel.t === t && kmSel.id === id) || (t === 'p' && kmSel.t === 'm' && kmSel.ids.includes(id)));

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
const kmPill = (x, y, text, fill, color, attrs = '', fs = 12) => {
  const w = kmMeasure(text, `600 ${fs}px ${KM_FONT}`) + 18;
  return { w, svg: `<g ${attrs}><rect x="${x}" y="${y}" width="${w}" height="${fs + 14}" rx="${(fs + 14) / 2}" fill="${fill}" stroke="${color}" stroke-width="1.3"/><text x="${x + w / 2}" y="${y + fs + 3}" text-anchor="middle" font-size="${fs}" font-weight="600" fill="${color}">${kmEsc(text)}</text></g>` };
};
function kmRender() {
  if (!km) return;
  cancelAnimationFrame(kmRaf);
  kmRaf = 0;
  const svg = kmEl('#km-svg');
  if (!svg) return;
  const sc = kmScene(), nb = kmNeighbors();
  const dim = (on) => (on ? ' opacity="0.18"' : '');
  let h = `<g transform="translate(${kmView.x} ${kmView.y}) scale(${kmView.z})">`;
  // Stapel: Reiter bzw. Klammer
  for (const T of sc.stacks) {
    const s = T.s;
    if (!s.open) {
      let x = T.x;
      for (const F of T.fs) {
        const on = F.id === s.active, c = F.color || '#6b7280';
        const p = kmPill(x, T.y + 6, F.name || 'Akt', on ? c : 'var(--card)', on ? '#fff' : c, `data-tab="${F.id}" class="km-tab"`, 13);
        h += p.svg; x += p.w + 6;
      }
      h += kmPill(x + 6, T.y + 6, '⇆ ausfächern', 'var(--card)', 'var(--accent)', `data-fan="${s.id}" class="km-tab"`, 13).svg;
    } else {
      h += `<path d="M${T.x} ${T.y + 30}v-8h${T.w}v8" stroke="var(--muted)" stroke-width="1.5" fill="none"/>`;
      const t = kmPill(T.x + 10, T.y + 6, `${s.name || 'Stapel'} · ⇲ zusammenlegen`, 'var(--card)', 'var(--accent)', `data-col="${s.id}" class="km-tab"`, 13);
      h += t.svg;
    }
  }
  for (const F of sc.frames) {
    const sel = kmIsSel('f', F.id), c = F.color || '#6b7280';
    const tw = kmMeasure(F.name || 'Akt', `700 16px ${KM_FONT}`) + 40;
    h += `<g data-f="${F.id}"><rect x="${F.x}" y="${F.y}" width="${F.w}" height="${F.h}" rx="18" fill="${c}" fill-opacity="0.04" stroke="${c}" stroke-opacity="${sel ? 1 : 0.55}" stroke-width="${sel ? 3 : 2}" class="km-gbox"/>` +
      `<g data-ft="${F.id}" class="km-ftitle"><rect x="${F.x}" y="${F.y}" width="${tw}" height="34" rx="16" fill="${c}"/><rect x="${F.x}" y="${F.y + 17}" width="${tw}" height="17" fill="${c}"/>` +
      `<text x="${F.x + 14}" y="${F.y + 23}" fill="#fff" font-weight="700" font-size="16">${kmEsc(F.name || 'Akt')}  ⠿</text></g>` +
      (sel ? `<g data-fr="${F.id}" class="km-fresize"><circle cx="${F.x + F.w}" cy="${F.y + F.h}" r="14" fill="${c}"/><path d="M${F.x + F.w - 5} ${F.y + F.h + 5}l10 -10M${F.x + F.w + 1} ${F.y + F.h - 5}h4v4M${F.x + F.w - 5} ${F.y + F.h + 1}v4h4" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round"/></g>` : '') + '</g>';
  }
  for (const G of sc.groups) {
    const sel = kmIsSel('g', G.g.id), c = G.g.color || KM_COLORS[7];
    h += `<g data-g="${G.g.id}"${dim(nb && !km.persons.some((p) => kmIn(p, G.g.id) && nb.has(p.id)))}>` +
      `<rect x="${G.x}" y="${G.y}" width="${G.w}" height="${G.h}" rx="16" fill="${c}" fill-opacity="0.09" stroke="${c}" stroke-width="${sel ? 3 : 1.6}" stroke-dasharray="${sel ? '' : '7 5'}" class="km-gbox"/>` +
      `<text x="${G.x + 14}" y="${G.y + 21}" fill="${c}" font-weight="700" font-size="14" class="km-gtitle" data-gt="${G.g.id}">${kmEsc(G.g.name || 'Gruppe')} ⠿</text></g>`;
  }
  // weggefallene Beziehungen (Vergleich mit dem vorigen Akt)
  for (const g of sc.ghosts) {
    h += `<g class="km-ghost"${dim(!!nb)}><path d="M${g.a[0]} ${g.a[1]} Q${g.c[0]} ${g.c[1]} ${g.b[0]} ${g.b[1]}" stroke="${KM_GONE}" stroke-width="2" stroke-dasharray="4 5" fill="none"/>` +
      kmPill(g.lx - kmMeasure(g.text, `600 12px ${KM_FONT}`) / 2 - 9, g.ly - 13, g.text, '#f3f4f6', KM_GONE).svg.replace('<text', '<text text-decoration="line-through"') + '</g>';
  }
  for (const k of sc.links) {
    const sel = kmIsSel('l', k.l.id), off = nb && !(nb.has(k.l.a) && nb.has(k.l.b) && (k.l.a === kmSel.id || k.l.b === kmSel.id));
    const d = `M${k.a[0]} ${k.a[1]} Q${k.c[0]} ${k.c[1]} ${k.b[0]} ${k.b[1]}`;
    const halo = sel ? k.color : k.mark === 'new' ? KM_NEW : k.mark === 'chg' ? KM_CHG : '';
    h += `<g data-l="${k.l.id}"${dim(off)}>` + (halo ? `<path d="${d}" stroke="${halo}" stroke-opacity="${sel ? 0.25 : 0.3}" stroke-width="${k.w + 9}" fill="none" stroke-linecap="round"/>` : '') +
      `<path d="${d}" stroke="transparent" stroke-width="22" fill="none"/>` +
      `<path d="${d}" stroke="${k.color}" stroke-width="${k.w}" fill="none" stroke-linecap="round" stroke-dasharray="${KM_DASH[k.dash] || ''}"/>` +
      k.arrows.map((ar) => `<polygon points="${kmArrowPts(ar, k.w).map((q) => q.join(',')).join(' ')}" fill="${k.color}"/>`).join('') + '</g>';
  }
  for (const p of sc.persons) {
    const b = sc.boxes.get(p.id), c = p.color || KM_COLORS[0], sel = kmIsSel('p', p.id);
    const isNew = sc.diff.newP.has(p.id), chg = sc.diff.chgP.get(p.id);
    h += `<g data-p="${p.id}" class="km-person"${dim(nb && !nb.has(p.id))}>` +
      (sel ? `${kmPersonPath(p, { x: b.x - 5, y: b.y - 5, w: b.w + 10, h: b.h + 10 })} fill="none" stroke="var(--accent)" stroke-width="2" stroke-dasharray="5 4"/>` : '') +
      `${kmPersonPath(p, b)} fill="${kmTint(c, 0.86)}" stroke="${c}" stroke-width="${b.big ? 3.2 : 1.8}"/>` +
      `<text x="${p.x}" y="${p.role ? b.y + b.h / 2 - 3 : p.y + b.fs * 0.36}" text-anchor="middle" font-size="${b.fs}" font-weight="${b.big ? 700 : 600}" fill="#1c1c1e">${kmEsc((p.emoji ? p.emoji + ' ' : '') + (p.name || '?'))}</text>` +
      (p.role ? `<text x="${p.x}" y="${b.y + b.h / 2 + 14}" text-anchor="middle" font-size="12" fill="#55555c">${kmEsc(p.role)}</text>` : '') +
      (p.desc || (p.refs && p.refs.length) || p.cite || kmSbFilled(p).length ? `<circle cx="${b.x + b.w - 2}" cy="${b.y + 2}" r="4.5" fill="${c}"/>` : '') +
      (isNew ? kmPill(b.x - 8, b.y - 16, 'neu', KM_NEW, '#fff', '', 11).svg : chg ? kmPill(b.x - 8, b.y - 16, 'geändert', KM_CHG, '#fff', '', 11).svg : '') + '</g>';
  }
  for (const k of sc.links) {
    if (!k.label) continue;
    const off = nb && !((k.l.a === kmSel.id || k.l.b === kmSel.id));
    const col = k.mark === 'new' ? KM_NEW : k.mark === 'chg' ? KM_CHG : k.color;
    const w = kmMeasure(k.label.text, `600 12px ${KM_FONT}`) + 14;
    h += `<g data-l="${k.l.id}"${dim(off)}><rect x="${k.label.x - w / 2}" y="${k.label.y - 11}" width="${w}" height="22" rx="11" fill="#fff" stroke="${col}" stroke-width="${k.mark ? 2 : 1.2}"/>` +
      `<text x="${k.label.x}" y="${k.label.y + 4}" text-anchor="middle" font-size="12" font-weight="600" fill="${k.color}">${kmEsc(k.label.text)}</text></g>`;
  }
  // weggefallene Personen: Hinweis unten im Kasten
  for (const g of sc.diff.gone) {
    if (!sc.frames.includes(g.F)) continue;
    h += kmPill(g.F.x + 12, g.F.y + g.F.h - 34, '✕ nicht mehr dabei: ' + g.names.join(', '), '#f3f4f6', '#6b7280').svg;
  }
  // freie Striche (Stift) – oben drauf, wie Notizen auf einem Blatt
  if (sc.ink.length || (kmAct && kmAct.type === 'ink')) {
    const selInk = kmSel && kmSel.t === 'm' ? new Set(kmSel.ink) : null;
    h += `<g class="km-ink"${dim(!!nb)}>` + sc.ink.map((s) => (selInk && selInk.has(s) ? `<g opacity="0.55">${strokeSvg(s)}</g>` : strokeSvg(s))).join('') + (kmAct && kmAct.type === 'ink' ? penSvg(kmAct.stroke) : '') + '</g>';
  }
  // ⊕ zum Verbinden an der ausgewählten Person
  if (kmSel && kmSel.t === 'p' && sc.boxes.has(kmSel.id)) {
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
  // Auswahlrahmen
  if (kmAct && kmAct.type === 'band' && kmAct.to) {
    const [x0, y0] = [Math.min(kmAct.wx, kmAct.to[0]), Math.min(kmAct.wy, kmAct.to[1])];
    h += `<rect x="${x0}" y="${y0}" width="${Math.abs(kmAct.to[0] - kmAct.wx)}" height="${Math.abs(kmAct.to[1] - kmAct.wy)}" fill="var(--accent)" fill-opacity="0.08" stroke="var(--accent)" stroke-width="${1.5 / kmView.z}" stroke-dasharray="${6 / kmView.z} ${4 / kmView.z}"/>`;
  }
  h += '</g>';
  svg.innerHTML = h;
  const st = kmStage();
  st.classList.toggle('grid', kmGrid);
  if (kmGrid) {
    let g = KM_GRID * kmView.z;
    while (g < 12) g *= 2;
    st.style.backgroundSize = `${g}px ${g}px`;
    st.style.backgroundPosition = `${kmView.x - g / 2}px ${kmView.y - g / 2}px`;
  }
  kmEl('#km-empty').hidden = km.persons.length > 0 || km.frames.length > 0;
  kmEl('#km-zoom').textContent = Math.round(kmView.z * 100) + '%';
  kmRenderLegend(sc);
}
const kmRenderSoon = () => { if (!kmRaf) kmRaf = requestAnimationFrame(kmRender); };

function kmUsedTypes() {
  const used = new Map();
  km.links.forEach((l) => { const t = kmType(l.type); if (!used.has(t.id)) used.set(t.id, { t, labels: new Set() }); if (l.label) used.get(t.id).labels.add(l.label); });
  return [...used.values()];
}
function kmRenderLegend(sc) {
  const box = kmEl('#km-legend');
  const used = kmUsedTypes();
  const marks = sc && (sc.diff.newP.size || sc.diff.newL.size || sc.diff.chgL.size || sc.diff.chgP.size || sc.ghosts.length);
  box.hidden = !kmLegend || (!used.length && !marks);
  box.innerHTML = '<b>Legende</b>' + used.map(({ t }) => `<div><svg width="30" height="10"><path d="M2 5h26" stroke="${t.color}" stroke-width="3" stroke-dasharray="${KM_DASH[t.dash]}" stroke-linecap="round"/></svg>${kmEsc(t.name)}</div>`).join('') +
    (marks ? `<div><i class="km-dot" style="--c:${KM_NEW}"></i>neu im Akt</div><div><i class="km-dot" style="--c:${KM_CHG}"></i>geändert</div><div><i class="km-dot" style="--c:${KM_GONE}"></i>✕ weggefallen</div>` : '');
}

// ---- Treffer ----
function kmWorld(e) {
  const r = kmStage().getBoundingClientRect();
  return [(e.clientX - r.left - kmView.x) / kmView.z, (e.clientY - r.top - kmView.y) / kmView.z];
}
function kmHit(e) {
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const g = el && el.closest && el.closest('[data-knob],[data-p],[data-l],[data-gt],[data-ft],[data-fr],[data-tab],[data-fan],[data-col]');
  if (!g || !kmEl('#km-svg').contains(g)) return null;
  const d = g.dataset;
  if (d.knob) return { t: 'knob', id: d.knob };
  if (d.p) return { t: 'p', id: d.p };
  if (d.l) return { t: 'l', id: d.l };
  if (d.ft) return { t: 'f', id: d.ft };
  if (d.fr) return { t: 'fr', id: d.fr };
  if (d.tab) return { t: 'tab', id: d.tab };
  if (d.fan) return { t: 'fan', id: d.fan };
  if (d.col) return { t: 'col', id: d.col };
  return { t: 'g', id: d.gt };
}
function kmPersonAt(x, y, except) {
  const hid = kmVis().hidP;
  for (let i = km.persons.length - 1; i >= 0; i--) {
    const p = km.persons[i];
    if (p.id === except || hid.has(p.id)) continue;
    const b = kmBox(p);
    if (x >= b.x - 6 && x <= b.x + b.w + 6 && y >= b.y - 6 && y <= b.y + b.h + 6) return p;
  }
  return null;
}

// ---- Gesten ----
function kmDown(e) {
  if (!km || e.button > 0) return;
  if (e.target.closest && e.target.closest('button')) return;   // Knopf auf der Fläche (z. B. Vorlage)
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
  if (hit && hit.t === 'tab') {
    // Reiter wechseln: ohne das Seitenfeld zu öffnen; eine Auswahl auf dem alten Reiter fällt weg
    const s = kmStackOf(hit.id);
    s.active = hit.id;
    if (kmSel && kmSel.t === 'f' && s.frames.includes(kmSel.id)) kmSel = { t: 'f', id: hit.id };
    else if (kmSel && kmSel.t !== 'f' && kmSel.t !== 'g') kmSel = null;
    kmSaved(); kmPanel(); return;
  }
  if (hit && hit.t === 'fan') { kmChange(() => kmFan(km.stacks.find((s) => s.id === hit.id))); kmFit(); return; }
  if (hit && hit.t === 'col') { kmChange(() => kmCollapse(km.stacks.find((s) => s.id === hit.id))); kmFit(); return; }
  if (hit && hit.t === 'knob') {
    kmAct = { ...base, type: 'link', from: hit.id, to: null, target: null };
  } else if (hit && hit.t === 'p') {
    const p = kmPerson(hit.id);
    if (e.shiftKey) { kmToggleMulti(p.id); return; }
    if (dbl && kmSel && kmSel.id === p.id) { kmLastTap = null; kmPanel(true); return; }
    if (kmLinkMode) { kmAct = { ...base, type: 'link', from: p.id, to: null, target: null }; return; }
    if (kmSel && kmSel.t === 'm' && kmSel.ids.includes(p.id)) {
      // Mehrfachauswahl: alle zusammen verschieben
      const ps = kmSel.ids.map(kmPerson).filter(Boolean);
      kmAct = { ...base, type: 'move', ids: ps.map((q) => q.id), start: ps.map((q) => [q.x, q.y]), ink: kmSel.ink.map((s) => [s, s.pts.slice()]), retag: true, before: kmSnap() };
      return;
    }
    kmSelect({ t: 'p', id: p.id });
    kmAct = { ...base, type: 'move', ids: [p.id], start: [[p.x, p.y]], retag: true, before: kmSnap() };
  } else if (hit && hit.t === 'g') {
    kmSelect({ t: 'g', id: hit.id });
    const ms = kmScene().persons.filter((p) => kmIn(p, hit.id));
    kmAct = { ...base, type: 'move', ids: ms.map((p) => p.id), start: ms.map((p) => [p.x, p.y]), retag: true, before: kmSnap() };
  } else if (hit && hit.t === 'f') {
    // Akt-Kasten am Titel ziehen: Kasten mit allem, was darin liegt (zusammengelegt: der ganze Stapel)
    const F = kmFrame(hit.id), s = kmStackOf(F.id);
    kmSelect({ t: 'f', id: F.id });
    const fs = s && !s.open ? s.frames.map(kmFrame) : [F];
    const ps = [], inks = [];
    fs.forEach((x) => { const c = kmFrameContent(x); ps.push(...c.persons); inks.push(...c.ink); });
    kmAct = { ...base, type: 'move', frames: fs.map((x) => [x.id, x.x, x.y]), ids: ps.map((p) => p.id), start: ps.map((p) => [p.x, p.y]), ink: inks.map((st) => [st, st.pts.slice()]), before: kmSnap() };
  } else if (hit && hit.t === 'fr') {
    const F = kmFrame(hit.id);
    kmAct = { ...base, type: 'resize', frame: F.id, start: [F.w, F.h], before: kmSnap() };
  } else if (hit && hit.t === 'l') {
    kmSelect({ t: 'l', id: hit.id });
    kmAct = { ...base, type: 'pan', view: { ...kmView } };
  } else {
    if (dbl) { kmLastTap = null; kmAddPerson(wx, wy); return; }
    // Stift/Maus (oder Auswahl-Modus): Rahmen aufziehen · Finger: verschieben
    if (e.pointerType !== 'touch' || kmSelMode) kmAct = { ...base, type: 'band', to: null, tap: true, add: e.shiftKey };
    else kmAct = { ...base, type: 'pan', view: { ...kmView }, tap: true };
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
  else if (A.type === 'band') { A.to = kmWorld(e); kmRenderSoon(); }
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
    F.w = Math.max(220, kmGridV(A.start[0] + dx / kmView.z)); F.h = Math.max(160, kmGridV(A.start[1] + dy / kmView.z));
    kmRenderSoon();
  } else if (A.type === 'move') {
    let mx = dx / kmView.z, my = dy / kmView.z;
    if (kmGrid) {
      // am Raster: der Kasten (bzw. die erste Person) rastet ein, alles andere geht um denselben Betrag mit
      const [bx, by] = A.frames && A.frames.length ? [A.frames[0][1], A.frames[0][2]] : A.start[0] || [0, 0];
      mx = kmGridV(bx + mx) - bx; my = kmGridV(by + my) - by;
    }
    A.ids.forEach((id, i) => { const p = kmPerson(id); if (p) { p.x = Math.round(A.start[i][0] + mx); p.y = Math.round(A.start[i][1] + my); } });
    (A.frames || []).forEach(([id, x, y]) => { const F = kmFrame(id); F.x = Math.round(x + mx); F.y = Math.round(y + my); });
    // Striche: neues Objekt, damit die gespeicherte Darstellung (Cache) nicht veraltet
    (A.ink || []).forEach((it) => {
      const i = km.ink.indexOf(it[2] || it[0]);
      if (i < 0) return;
      const moved = { ...km.ink[i], pts: it[1].map((v, j) => (j % 3 === 0 ? v + mx : j % 3 === 1 ? v + my : v)) };
      km.ink[i] = moved;
      if (kmSel && kmSel.t === 'm') kmSel.ink = kmSel.ink.map((s) => (s === (it[2] || it[0]) ? moved : s));
      it[2] = moved;
    });
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
  } else if (A.type === 'band') {
    if (!A.moved || !A.to) { kmSelect(null); kmLinkMode && kmSetLinkMode(false); return; }
    kmBandSelect(A);
  } else if (A.type === 'move' || A.type === 'resize') {
    if (A.moved) {
      if (A.retag) A.ids.forEach((id) => { const p = kmPerson(id); if (p) kmRetag(p); });
      kmUndo.push(A.before); kmRedo = []; kmSaved();
      if (kmSel && kmSel.t === 'f') kmPanel();
    }
  } else if (A.type === 'ink') {
    const st = A.stroke;
    if (st.pts.length >= 3) {
      const b = kmInkBox(st), t = kmTagAt(b.x + b.w / 2, b.y + b.h / 2);
      if (t) st.frame = t;
      kmChange(() => km.ink.push(st));
    } else kmRender();
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

// ---- Mehrfachauswahl ----
function kmBandSelect(A) {
  const x0 = Math.min(A.wx, A.to[0]), x1 = Math.max(A.wx, A.to[0]), y0 = Math.min(A.wy, A.to[1]), y1 = Math.max(A.wy, A.to[1]);
  const inR = (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
  const sc = kmScene();
  let ids = sc.persons.filter((p) => inR(p.x, p.y)).map((p) => p.id);
  let ink = sc.ink.filter((s) => { const b = kmInkBox(s); return inR(b.x + b.w / 2, b.y + b.h / 2); });
  if (A.add && kmSel && kmSel.t === 'm') { ids = [...new Set(kmSel.ids.concat(ids))]; ink = [...new Set(kmSel.ink.concat(ink))]; }
  if (!ids.length && !ink.length) return kmSelect(null);
  if (ids.length === 1 && !ink.length) return kmSelect({ t: 'p', id: ids[0] });
  kmSelect({ t: 'm', ids, ink });
}
function kmToggleMulti(id) {
  const cur = kmSel && kmSel.t === 'm' ? kmSel : kmSel && kmSel.t === 'p' ? { t: 'm', ids: [kmSel.id], ink: [] } : { t: 'm', ids: [], ink: [] };
  const ids = cur.ids.includes(id) ? cur.ids.filter((x) => x !== id) : cur.ids.concat(id);
  if (!ids.length && !cur.ink.length) return kmSelect(null);
  if (ids.length === 1 && !cur.ink.length) return kmSelect({ t: 'p', id: ids[0] });
  kmSelect({ t: 'm', ids, ink: cur.ink });
}
function kmSelectAll() {
  const sc = kmScene();
  kmSelect({ t: 'm', ids: sc.persons.map((p) => p.id), ink: sc.ink.slice() });
}

// ---- Kopieren / Einfügen (auch zwischen Konstellationen) ----
function kmCopy() {
  if (!kmSel) return;
  const ids = kmSel.t === 'm' ? kmSel.ids : kmSel.t === 'p' ? [kmSel.id] : [];
  const ink = kmSel.t === 'm' ? kmSel.ink : [];
  if (!ids.length && !ink.length) return toast('Personen auswählen zum Kopieren');
  const set = new Set(ids), persons = ids.map(kmPerson).filter(Boolean);
  const gids = new Set(persons.flatMap((p) => p.groups || []));
  const clip = {
    persons: persons.map(({ frame: _f, src: _s, ...p }) => p),
    links: km.links.filter((l) => set.has(l.a) && set.has(l.b)).map(({ src: _s, ...l }) => l),
    groups: km.groups.filter((g) => gids.has(g.id)),
    ink: ink.map(({ frame: _f, ...s }) => s)
  };
  store.set('kmClip', clip);
  kmBarState();
  toast(`Kopiert: ${persons.length} ${persons.length === 1 ? 'Person' : 'Personen'}${clip.links.length ? `, ${clip.links.length} Beziehungen` : ''}`);
}
function kmPaste(at) {
  const clip = store.get('kmClip', null);
  if (!clip || (!clip.persons.length && !clip.ink.length)) return toast('Nichts zum Einfügen');
  const r = kmStage().getBoundingClientRect();
  const pts = clip.persons.map((p) => [p.x, p.y]).concat(clip.ink.flatMap((s) => { const b = kmInkBox(s); return [[b.x + b.w / 2, b.y + b.h / 2]]; }));
  const cx = pts.reduce((s, q) => s + q[0], 0) / pts.length, cy = pts.reduce((s, q) => s + q[1], 0) / pts.length;
  const [tx, ty] = at || [(r.width / 2 - kmView.x) / kmView.z + 30, (r.height / 2 - kmView.y) / kmView.z + 30];
  const dx = tx - cx, dy = ty - cy;
  const map = new Map(), gmap = new Map();
  let ids = [], ink = [];
  kmChange(() => {
    for (const g of clip.groups) {
      if (kmGroup(g.id)) gmap.set(g.id, g.id);      // gleiche Konstellation: Gruppe gibt es schon
      else { const ng = { ...g, id: kmId('g') }; km.groups.push(ng); gmap.set(g.id, ng.id); }
    }
    for (const p of clip.persons) {
      const q = { ...p, id: kmId('p'), x: Math.round(p.x + dx), y: Math.round(p.y + dy) };
      if (p.groups) q.groups = p.groups.map((g) => gmap.get(g) || g).filter((g) => kmGroup(g));
      kmRetag(q);
      map.set(p.id, q.id);
      km.persons.push(q);
      ids.push(q.id);
    }
    for (const l of clip.links) km.links.push({ ...l, id: kmId('l'), a: map.get(l.a), b: map.get(l.b) });
    for (const s of clip.ink) {
      const n = kmMoveInk(s, dx, dy), b = kmInkBox(n), t = kmTagAt(b.x + b.w / 2, b.y + b.h / 2);
      if (t) n.frame = t;
      km.ink.push(n);
      ink.push(n);
    }
  });
  if (ids.length === 1 && !ink.length) kmSelect({ t: 'p', id: ids[0] });
  else kmSelect({ t: 'm', ids, ink });
}
function kmDuplicateSel() { kmCopy(); kmPaste(); }

// ---- Bearbeiten ----
function kmNewPerson(x, y, props) {
  // nicht genau auf eine andere Person legen
  let n = 0;
  while (kmPersonAt(x, y) && n++ < 12) { x += 34; y += 26; }
  const used = new Set(km.persons.map((p) => p.color));
  const p = { id: kmId('p'), x: kmGridV(x), y: kmGridV(y), name: 'Person ' + (km.persons.length + 1), role: '', color: KM_COLORS.find((c) => !used.has(c)) || KM_COLORS[km.persons.length % 8], shape: 'rect', ...props };
  kmRetag(p);
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
  // Kasten in einem zusammengelegten Stapel: erst ausfächern, sonst blieben Inhalte unsichtbar zurück
  if ((s.t === 'f' || s.t === 'fall') && kmStackOf(s.id) && !kmStackOf(s.id).open) kmFan(kmStackOf(s.id));
  kmChange(() => {
    const dropP = (ids) => { km.persons = km.persons.filter((p) => !ids.has(p.id)); km.links = km.links.filter((l) => !ids.has(l.a) && !ids.has(l.b)); };
    if (s.t === 'p') dropP(new Set([s.id]));
    if (s.t === 'm') { dropP(new Set(s.ids)); km.ink = km.ink.filter((x) => !s.ink.includes(x)); }
    if (s.t === 'l') km.links = km.links.filter((l) => l.id !== s.id);
    if (s.t === 'g') { km.groups = km.groups.filter((g) => g.id !== s.id); km.persons.forEach((p) => kmLeave(p, s.id)); }
    if (s.t === 'f') km.frames = km.frames.filter((f) => f.id !== s.id);
    if (s.t === 'fall') { const F = kmFrame(s.id), c = kmFrameContent(F); dropP(new Set(c.persons.map((p) => p.id))); km.ink = km.ink.filter((x) => !c.ink.includes(x)); km.frames = km.frames.filter((f) => f !== F); }
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

// Gruppe aus der ausgewählten Person bzw. den ausgewählten Personen
function kmAddGroup() {
  const ps = kmSel && kmSel.t === 'p' ? [kmPerson(kmSel.id)] : kmSel && kmSel.t === 'm' ? kmSel.ids.map(kmPerson).filter(Boolean) : [];
  if (!ps.length) return toast('Erst eine oder mehrere Personen auswählen – die Gruppe entsteht um sie herum');
  const name = (prompt('Name der Gruppe (z. B. Familie Müller, die Montagues):') || '').trim().slice(0, 40);
  if (!name) return;
  const used = new Set(km.groups.map((g) => g.color));
  const g = { id: kmId('g'), name, color: KM_COLORS.find((c) => !used.has(c) && c !== ps[0].color) || KM_COLORS[km.groups.length % 8] };
  kmChange(() => { km.groups.push(g); ps.forEach((p) => kmJoin(p, g.id)); });
  kmSelect({ t: 'g', id: g.id });
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
function kmLayout(only) {
  if (km.persons.length < 2) return;
  kmChange(() => {
    if (only) { kmForce(only.map(kmPerson).filter(Boolean)); return; }
    const hid = kmVis(), done = new Set();
    for (const F of km.frames) {
      if (hid.hidF.has(F.id)) continue;
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
    kmForce(km.persons.filter((p) => !done.has(p.id) && !hid.hidP.has(p.id)));
  });
  if (!only) kmFit();
}

// ---- Akt-Kästen ----
// Inhalt: zusammengelegt = was fest dazugehört; sonst Personen, deren Mitte im Kasten liegt,
// und Striche, die überwiegend darin liegen (ohne Inhalte anderer zusammengelegter Kästen)
function kmFrameContent(F) {
  const s = kmStackOf(F.id);
  if (s && !s.open) return { persons: km.persons.filter((p) => p.frame === F.id), ink: km.ink.filter((st) => st.frame === F.id) };
  const inside = (x, y) => x >= F.x && x <= F.x + F.w && y >= F.y && y <= F.y + F.h;
  return {
    persons: km.persons.filter((p) => !p.frame && inside(p.x, p.y)),
    ink: km.ink.filter((st) => { if (st.frame) return false; const b = kmInkBox(st); return inside(b.x + b.w / 2, b.y + b.h / 2); })
  };
}
const kmNextName = (name) => (/\d+/.test(name) ? name.replace(/\d+/, (m) => String(Number(m) + 1)) : name + ' (2)');
function kmNewFrame(props) {
  const F = { id: kmId('f'), color: KM_COLORS[[7, 0, 4, 6, 3, 1, 5, 2][km.frames.length % 8]], w: 640, h: 440, ...props };
  km.frames.push(F);
  return F;
}
function kmAddFrame() {
  // mehrere Personen ausgewählt: Kasten genau um sie herum
  if (kmSel && kmSel.t === 'm') return kmFrameAroundSel();
  const def = km.frames.length ? kmNextName(km.frames[km.frames.length - 1].name || 'Akt 1') : 'Akt 1';
  const name = prompt('Name des Kastens (z. B. Akt 1, Kapitel 3, Vorher):', def);
  if (name == null) return;
  let F;
  kmChange(() => {
    if (!km.frames.length && km.persons.length) {
      // erster Kasten: um alles, was schon da ist
      const b = kmBounds(kmScene());
      F = kmNewFrame({ name: name.trim() || def, x: Math.round(b.x - 50), y: Math.round(b.y - 70), w: Math.round(b.w + 100), h: Math.round(b.h + 120) });
    } else {
      const vis = kmVis(), shown = km.frames.filter((o) => !vis.hidF.has(o.id)), last = shown[shown.length - 1];
      const r = kmStage().getBoundingClientRect();
      const w = last ? last.w : 640, h = last ? last.h : 440;
      const x = last ? Math.max(...shown.filter((o) => o.y < last.y + last.h && o.y + o.h > last.y).map((o) => o.x + o.w)) + 60 : (r.width / 2 - kmView.x) / kmView.z - w / 2;
      F = kmNewFrame({ name: name.trim() || def, x: Math.round(x), y: Math.round(last ? last.y : (r.height / 2 - kmView.y) / kmView.z - h / 2), w, h });
    }
  });
  kmSelect({ t: 'f', id: F.id });
  kmShow(F);
}
function kmFrameAroundSel() {
  const ps = kmSel.ids.map(kmPerson).filter(Boolean);
  if (!ps.length) return;
  const name = prompt('Name des Kastens:', km.frames.length ? kmNextName(km.frames[km.frames.length - 1].name || 'Akt 1') : 'Akt 1');
  if (name == null) return;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  ps.forEach((p) => { const b = kmBox(p); x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); });
  kmSel.ink.forEach((s) => { const b = kmInkBox(s); x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); });
  let F;
  kmChange(() => { F = kmNewFrame({ name: name.trim() || 'Kasten', x: Math.round(x0 - 50), y: Math.round(y0 - 70), w: Math.round(x1 - x0 + 100), h: Math.round(y1 - y0 + 120) }); });
  kmSelect({ t: 'f', id: F.id });
}
// Kasten mit Inhalt kopieren (z. B. Akt 1 → Akt 2) – dort die Veränderungen eintragen.
// Jede Kopie merkt sich ihr Vorbild (src/from): daraus entstehen die Markierungen „neu/geändert/weg“.
function kmDupFrame(F) {
  const s = kmStackOf(F.id), stacked = s && !s.open;
  const c = kmFrameContent(F);
  // gibt es im Stapel schon einen leeren nächsten Kasten (z. B. aus einer Vorlage)? Dann dort hinein
  const nextId = s && s.frames[s.frames.indexOf(F.id) + 1], next = nextId && kmFrame(nextId);
  const intoNext = next && !kmFrameContent(next).persons.length && !kmFrameContent(next).ink.length;
  let dx = 0, dy = 0;
  if (intoNext) { dx = next.x - F.x; dy = next.y - F.y; }
  else if (!stacked) {
    const others = km.frames.filter((o) => o !== F && o.y < F.y + F.h && o.y + o.h > F.y && o.x >= F.x + F.w);
    dx = others.length ? Math.max(...others.map((o) => o.x + o.w)) + 60 - F.x : F.w + 60;
  }
  let N;
  kmChange(() => {
    if (intoNext) { N = next; N.from = F.id; N.w = Math.max(N.w, F.w); N.h = Math.max(N.h, F.h); }
    else N = kmNewFrame({ ...F, id: kmId('f'), name: kmNextName(F.name || 'Akt 1'), x: F.x + dx, from: F.id, desc: '' });
    const tag = stacked ? { frame: N.id } : {};
    const map = new Map(), gmap = new Map();
    for (const p of c.persons) {
      const q = { ...p, ...tag, id: kmId('p'), x: p.x + dx, y: p.y + dy, src: p.id };
      if (!stacked) delete q.frame;
      // Gruppen je Akt eigen, sonst spannt ein Gruppenkasten über beide Akte
      if (p.groups) q.groups = p.groups.map((g) => { if (!gmap.has(g)) { const ng = { ...kmGroup(g), id: kmId('g') }; km.groups.push(ng); gmap.set(g, ng.id); } return gmap.get(g); });
      map.set(p.id, q.id);
      km.persons.push(q);
    }
    for (const l of km.links.slice()) if (map.has(l.a) && map.has(l.b)) km.links.push({ ...l, id: kmId('l'), a: map.get(l.a), b: map.get(l.b), src: l.id });
    for (const st of c.ink) km.ink.push(kmMoveInk(st, dx, dy, tag));
    if (s && !intoNext) s.frames.splice(s.frames.indexOf(F.id) + 1, 0, N.id);
    if (stacked) s.active = N.id;
  });
  kmSelect({ t: 'f', id: N.id });
  kmShow(N);
  toast(`„${N.name}“ angelegt – Änderungen gegenüber „${F.name}“ werden markiert`);
}
function kmStackFrames(F, ids) {
  const sel = [F.id, ...ids.filter((id) => id !== F.id)];
  const frames = km.frames.filter((x) => sel.includes(x.id)).sort((a, b) => a.x - b.x || a.y - b.y);
  if (frames.length < 2) return toast('Mindestens zwei Kästen auswählen');
  kmChange(() => {
    const s = { id: kmId('s'), name: 'Stapel', frames: frames.map((x) => x.id), active: frames[0].id, open: true };
    km.stacks.push(s);
    kmCollapse(s);
  });
  kmFit();
}
// Kasten ins Bild holen (ohne zu zoomen, wenn er schon passt)
function kmShow(F) {
  const r = kmStage().getBoundingClientRect();
  const z = Math.min(kmView.z, (r.width - 40) / F.w, (r.height - 90) / F.h);
  kmView = { z, x: r.width / 2 - (F.x + F.w / 2) * z, y: r.height / 2 - (F.y + F.h / 2) * z + 20 };
  km.view = { ...kmView };
  kmRender();
}

// ---- Vorlagen ----
const KM_TEMPLATES = [
  { id: 'drama5', name: 'Drama: 5 Akte (Freytag)', desc: 'Exposition bis Katastrophe – als Stapel', frames: ['1. Akt – Exposition', '2. Akt – Steigende Handlung', '3. Akt – Höhepunkt', '4. Akt – Retardierendes Moment', '5. Akt – Katastrophe'] },
  { id: 'drama3', name: 'Drama: 3 Akte', desc: 'Exposition, Konfrontation, Auflösung', frames: ['1. Akt – Exposition', '2. Akt – Konfrontation', '3. Akt – Auflösung'] },
  { id: 'novel', name: 'Roman: Kapitel', desc: 'vier Kapitel als Stapel', frames: ['Kapitel 1', 'Kapitel 2', 'Kapitel 3', 'Kapitel 4'] },
  { id: 'before', name: 'Vorher / Nachher', desc: 'zwei Kästen zum Vergleichen', frames: ['Vorher', 'Nachher'] },
  { id: 'family', name: 'Familienstammbaum', desc: 'drei Generationen mit Beziehungen' },
  { id: 'camps', name: 'Zwei Lager', desc: 'zwei Gruppen im Konflikt, mit Vermittler' }
];
function kmApplyTemplate(t) {
  const sc = kmScene(), b = kmBounds(sc), r = kmStage().getBoundingClientRect();
  const ox = b ? b.x + b.w + 120 : (r.width / 2 - kmView.x) / kmView.z - 320, oy = b ? b.y : (r.height / 2 - kmView.y) / kmView.z - 220;
  kmChange(() => {
    if (t.frames) {
      const fs = t.frames.map((name, i) => kmNewFrame({ name, x: Math.round(ox + i * 700), y: Math.round(oy), w: 640, h: 440, color: KM_COLORS[[7, 0, 4, 6, 3, 1, 5, 2][i % 8]] }));
      if (fs.length > 2) km.stacks.push({ id: kmId('s'), name: t.name.replace(/:.*/, ''), frames: fs.map((F) => F.id), active: fs[0].id, open: true });
      return;
    }
    const P = (name, x, y, props) => kmNewPerson(ox + x, oy + y, { name, ...props });
    const L = (a, bb, type, label, dir = 'ab') => km.links.push({ id: kmId('l'), a, b: bb, type, label, dir, w: 2 });
    if (t.id === 'family') {
      const g = { id: kmId('g'), name: 'Familie', color: '#2563eb' }; km.groups.push(g);
      const gv = P('Großvater', 0, 0), gm = P('Großmutter', 260, 0), v = P('Vater', 0, 190), m = P('Mutter', 260, 190), k1 = P('Kind 1', -40, 380), k2 = P('Kind 2', 300, 380);
      [gv, gm, v, m, k1, k2].forEach((id) => kmJoin(kmPerson(id), g.id));
      L(gv, gm, 'love', 'verheiratet', 'none'); L(v, m, 'love', 'verheiratet', 'none');
      L(gv, v, 'family', 'Vater von'); L(gm, v, 'family', 'Mutter von'); L(v, k1, 'family', 'Vater von'); L(m, k2, 'family', 'Mutter von'); L(k1, k2, 'family', 'Geschwister', 'none');
    } else if (t.id === 'camps') {
      const ga = { id: kmId('g'), name: 'Lager A', color: '#2563eb' }, gb = { id: kmId('g'), name: 'Lager B', color: '#dc2626' };
      km.groups.push(ga, gb);
      const a1 = P('Anführer A', 0, 0, { big: true }), a2 = P('Anhänger A', 0, 200), b1 = P('Anführer B', 520, 0, { big: true }), b2 = P('Anhänger B', 520, 200), mid = P('Vermittler', 260, 100, { shape: 'pill' });
      [a1, a2].forEach((id) => kmJoin(kmPerson(id), ga.id)); [b1, b2].forEach((id) => kmJoin(kmPerson(id), gb.id));
      L(a1, b1, 'conflict', 'Rivalen', 'both'); L(a1, a2, 'power', 'führt'); L(b1, b2, 'power', 'führt'); L(mid, a1, 'neutral', 'vermittelt'); L(mid, b1, 'neutral', 'vermittelt');
    }
  });
  kmFit();
  toast(t.frames ? 'Kästen angelegt – Personen hineinziehen, dann „als nächsten Akt kopieren“' : 'Vorlage eingefügt – Namen antippen und ändern');
}
function kmTemplateDialog() {
  let dlg = kmEl('#km-tpl-dlg');
  if (!dlg) { dlg = document.createElement('dialog'); dlg.id = 'km-tpl-dlg'; document.body.append(dlg); }
  dlg.innerHTML = '<h3>Vorlage einfügen</h3><div class="menu-list">' +
    KM_TEMPLATES.map((t) => `<button type="button" class="menu-item km-tpl" data-tpl="${t.id}"><b>${kmEsc(t.name)}</b><span class="muted small-text">${kmEsc(t.desc)}</span></button>`).join('') +
    '</div><p class="muted small-text">Wird neben das Vorhandene gelegt – nichts geht verloren.</p><div class="dlg-actions"><button type="button" class="btn" data-close>Abbrechen</button></div>';
  dlg.querySelector('[data-close]').addEventListener('click', () => dlg.close());
  dlg.querySelectorAll('[data-tpl]').forEach((b) => b.addEventListener('click', () => { dlg.close(); kmApplyTemplate(KM_TEMPLATES.find((t) => t.id === b.dataset.tpl)); }));
  dlg.showModal();
}

// ---- Stift ----
function kmEraseAt(x, y) {
  const r = 10 / kmView.z, ok = kmVis().inkOk, keep = km.ink.filter((s) => !ok(s) || !strokeHit(s, x, y, r));
  if (keep.length !== km.ink.length) { km.ink = keep; kmAct.hitAny = true; kmRenderSoon(); }
}

// ---- Verknüpfte Stellen in Notizen ----
async function kmNotePicker(title, extra) {
  let all = [];
  try { all = await noteDb.all(); } catch {}
  const list = all.filter((n) => n.kind !== 'kmap').sort((a, b) => b.updated - a.updated);
  let dlg = kmEl('#km-pick');
  if (!dlg) { dlg = document.createElement('dialog'); dlg.id = 'km-pick'; document.body.append(dlg); }
  dlg.innerHTML = `<h3>${kmEsc(title)}</h3><div class="menu-list km-pick-list">` + (extra ? `<button type="button" class="menu-item" data-n="__new"><b>${kmEsc(extra)}</b></button>` : '') +
    list.map((n) => `<button type="button" class="menu-item" data-n="${kmEsc(n.id)}">${kmEsc(noteName(n))}<span class="muted small-text"> · ${new Date(n.updated).toLocaleDateString('de-DE', { day: 'numeric', month: 'short' })}${n.folder && folderName(n.folder) ? ' · ' + kmEsc(folderName(n.folder)) : ''}</span></button>`).join('') +
    (list.length ? '' : '<p class="muted">Noch keine normalen Notizen</p>') +
    '</div><div class="dlg-actions"><button type="button" class="btn" data-close>Abbrechen</button></div>';
  return new Promise((resolve) => {
    dlg.querySelector('[data-close]').addEventListener('click', () => { dlg.close(); resolve(null); });
    dlg.querySelectorAll('[data-n]').forEach((b) => b.addEventListener('click', () => { dlg.close(); resolve(b.dataset.n === '__new' ? '__new' : list.find((n) => n.id === b.dataset.n)); }));
    dlg.showModal();
  });
}
async function kmRefStart(kind, id) {
  const target = await kmNotePicker('In welcher Notiz ist die Stelle?');
  if (!target) return;
  kmPick = { kmNote: note.id, kind, id };
  await flushNoteSave();
  await openNote(target);
  kmEl('#km-pickbar').hidden = false;
}
function kmPickCancel() {
  const P = kmPick;
  kmPick = null;
  kmEl('#km-pickbar').hidden = true;
  if (P) kmOpenById(P.kmNote);
}
async function kmPickDone(page, x, y) {
  const P = kmPick, from = note;
  kmPick = null;
  kmEl('#km-pickbar').hidden = true;
  await flushNoteSave();
  const all = await noteDb.all().catch(() => []);
  const kn = all.find((n) => n.id === P.kmNote);
  if (!kn) return;
  const it = (P.kind === 'p' ? kn.kmap.persons : kn.kmap.links).find((i) => i.id === P.id);
  if (it) {
    it.refs = (it.refs || []).concat({ n: from.id, page, x: Math.round(x), y: Math.round(y), t: `${noteName(from)} · S. ${page + 1}` });
    kn.updated = Date.now();
    await noteDb.put(kn).catch(() => {});
  }
  await openNote(kn);
  kmSelect({ t: P.kind, id: P.id });
  toast('Stelle verknüpft – antippen springt dorthin');
}
async function kmOpenById(id) {
  await flushNoteSave();
  const n = (await noteDb.all().catch(() => [])).find((x) => x.id === id);
  if (n) await openNote(n);
}
async function kmJump(ref) {
  const back = note.id;
  await flushNoteSave();
  const n = (await noteDb.all().catch(() => [])).find((x) => x.id === ref.n);
  if (!n) return toast('Diese Notiz gibt es nicht mehr');
  await openNote(n);
  await new Promise((r) => requestAnimationFrame(r));
  const pe = pageEls[Math.min(ref.page, pageEls.length - 1)];
  if (!pe) return;
  const box = pagesBox.getBoundingClientRect(), rr = pe.svg.getBoundingClientRect();
  pagesBox.scrollTop += rr.top - box.top + (ref.y / PAGE_H) * rr.height - box.height / 3;
  // kurz markieren, wo die Stelle ist
  const m = document.createElement('div');
  m.className = 'km-spot';
  m.style.left = (ref.x / PAGE_W) * 100 + '%';
  m.style.top = (ref.y / PAGE_H) * 100 + '%';
  pe.wrap.append(m);
  setTimeout(() => m.remove(), 2600);
  kmBackTo = back;
  kmEl('#km-backpill').hidden = false;
}
// Antippen auf einer Seite, solange eine Stelle gesucht wird (vor dem Schreiben abfangen)
function kmPickDown(e) {
  if (!kmPick) return;
  const svg = e.target.closest && e.target.closest('.page-live');
  if (!svg) return;
  // Finger scrollt (wenn „Finger zeichnet“ aus ist): erst beim Loslassen ohne Bewegung zählt es
  if (e.pointerType === 'touch' && !fingerDraw) { kmPickDown.touch = { id: e.pointerId, x: e.clientX, y: e.clientY, svg }; return; }
  e.preventDefault(); e.stopPropagation();
  kmPickAt(svg, e.clientX, e.clientY);
}
function kmPickUp(e) {
  const t = kmPickDown.touch;
  if (!kmPick || !t || t.id !== e.pointerId) return;
  kmPickDown.touch = null;
  if (Math.hypot(e.clientX - t.x, e.clientY - t.y) < 10) { e.stopPropagation(); kmPickAt(t.svg, e.clientX, e.clientY); }
}
function kmPickAt(svg, cx, cy) {
  const r = svg.getBoundingClientRect();
  kmPickDone(Number(svg.dataset.page), ((cx - r.left) / r.width) * PAGE_W, ((cy - r.top) / r.height) * PAGE_H);
}

// ---- Steckbrief (ausführliche Angaben zu einer Figur) ----
const KM_SB = [
  ['age', 'Alter', 'z. B. 14, Mitte 50'],
  ['origin', 'Herkunft / Stand', 'z. B. Bürgertum, Adel, Dorf'],
  ['job', 'Beruf / Stellung', 'z. B. Gelehrter, Dienstmädchen'],
  ['looks', 'Aussehen', '', 2],
  ['traits', 'Charakter / Eigenschaften', 'mit Komma trennen: naiv, gläubig, mutig'],
  ['motives', 'Ziele & Motive', 'Was will die Figur? Warum?', 3],
  ['conflicts', 'Konflikte', 'innere und äußere Konflikte', 3],
  ['development', 'Entwicklung im Verlauf', 'Wie verändert sich die Figur?', 3],
  ['scenes', 'Schlüsselszenen', 'z. B. Gartenszene, Kerker', 2],
  ['meaning', 'Bedeutung / Funktion', 'z. B. Gegenspieler, Spiegelfigur', 2]
];
const kmSbFilled = (p) => {
  const i = p.info || {};
  return KM_SB.filter(([k]) => (i[k] || '').trim()).map(([, l]) => l)
    .concat((i.quotes || []).some((q) => (q.t || '').trim()) ? ['Zitate'] : [])
    .concat((i.custom || []).some((c) => (c.k || '').trim() || (c.v || '').trim()) ? ['eigene Felder'] : []);
};
function kmSbSummary(p) {
  const i = p.info || {}, traits = (i.traits || '').split(',').map((t) => t.trim()).filter(Boolean);
  const filled = kmSbFilled(p);
  return (traits.length ? `<div class="km-traits">${traits.map((t) => `<span>${kmEsc(t)}</span>`).join('')}</div>` : '') +
    `<p class="muted small-text">${filled.length ? kmEsc(filled.join(' · ')) : 'Alter, Herkunft, Charakter, Motive, Entwicklung, Zitate …'}</p>`;
}
function kmSbText(p) {
  const i = p.info || {}, out = [`${p.emoji ? p.emoji + ' ' : ''}${p.name}${p.role ? ` (${p.role})` : ''}`];
  KM_SB.forEach(([k, l]) => { if ((i[k] || '').trim()) out.push(`${l}: ${i[k].trim()}`); });
  (i.custom || []).forEach((c) => { if ((c.k || c.v || '').trim()) out.push(`${(c.k || 'Feld').trim()}: ${(c.v || '').trim()}`); });
  const qs = (i.quotes || []).filter((q) => (q.t || '').trim());
  if (qs.length) { out.push('Zitate:'); qs.forEach((q) => out.push(`  „${q.t.trim()}“${q.c ? ` (${q.c.trim()})` : ''}`)); }
  if ((p.desc || '').trim()) out.push(`Notizen: ${p.desc.trim()}`);
  if (p.cite) out.push(`Belegstelle: ${p.cite}`);
  const rel = km.links.filter((l) => l.a === p.id || l.b === p.id).map((l) => { const o = kmPerson(l.a === p.id ? l.b : l.a); return `${kmLinkText(l)} – ${o ? o.name : '?'}`; });
  if (rel.length) out.push('Beziehungen: ' + rel.join('; '));
  return out.join('\n');
}
let kmSbP = null;
function kmSbOpen(p) {
  kmSbP = p.id;
  let dlg = kmEl('#km-sb');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'km-sb';
    document.body.append(dlg);
    dlg.addEventListener('input', kmSbInput);
    dlg.addEventListener('click', kmSbClick);
    dlg.addEventListener('close', () => { kmTyping = null; kmSbP = null; kmPanel(); });
  }
  kmSbRender();
  if (!dlg.open) dlg.showModal();
}
function kmSbRender() {
  const p = kmPerson(kmSbP), dlg = kmEl('#km-sb');
  if (!p) return dlg && dlg.open && dlg.close();
  const i = p.info || {};
  const field = ([k, l, ph, rows]) => `<label class="km-f"><span>${l}</span>` + (rows
    ? `<textarea data-k="${k}" rows="${rows}" placeholder="${kmEsc(ph)}">${kmEsc(i[k] || '')}</textarea>`
    : `<input data-k="${k}" value="${kmEsc(i[k] || '')}" placeholder="${kmEsc(ph)}" autocomplete="off">`) + '</label>';
  const traits = (i.traits || '').split(',').map((t) => t.trim()).filter(Boolean);
  dlg.innerHTML = `<div class="km-sb-head" style="--c:${p.color || KM_COLORS[0]}"><input class="km-sb-name" data-top="name" value="${kmEsc(p.name)}" maxlength="40" autocomplete="off" aria-label="Name">` +
    `<input class="km-sb-role" data-top="role" value="${kmEsc(p.role || '')}" maxlength="50" placeholder="Rolle, z. B. Hauptfigur" autocomplete="off" aria-label="Rolle"></div>` +
    '<div class="km-sb-grid">' + KM_SB.slice(0, 3).map(field).join('') + '</div>' +
    field(KM_SB[3]) + field(KM_SB[4]) +
    `<div class="km-traits" id="km-sb-traits">${traits.map((t) => `<span>${kmEsc(t)}</span>`).join('')}</div>` +
    KM_SB.slice(5).map(field).join('') +
    '<div class="km-f"><span>Wichtige Zitate</span><div class="km-sb-list">' +
    (i.quotes || []).map((q, j) => `<div class="km-sb-quote"><textarea data-q="${j}" data-qf="t" rows="2" placeholder="„Zitat …“">${kmEsc(q.t || '')}</textarea><input data-q="${j}" data-qf="c" value="${kmEsc(q.c || '')}" placeholder="V. / S. / Szene" autocomplete="off"><button type="button" class="km-ref-x" data-qx="${j}" aria-label="Zitat löschen">×</button></div>`).join('') +
    '</div><button type="button" class="chip" data-x="qadd">＋ Zitat</button></div>' +
    '<div class="km-f"><span>Eigene Felder (z. B. Lieblingsort, Symbol, Familie)</span><div class="km-sb-list">' +
    (i.custom || []).map((c, j) => `<div class="km-sb-custom"><input data-c="${j}" data-cf="k" value="${kmEsc(c.k || '')}" placeholder="Feld" autocomplete="off"><input data-c="${j}" data-cf="v" value="${kmEsc(c.v || '')}" placeholder="Inhalt" autocomplete="off"><button type="button" class="km-ref-x" data-cx="${j}" aria-label="Feld löschen">×</button></div>`).join('') +
    '</div><button type="button" class="chip" data-x="cadd">＋ eigenes Feld</button></div>' +
    `<label class="km-f"><span>Notizen</span><textarea data-top="desc" rows="3">${kmEsc(p.desc || '')}</textarea></label>` +
    `<label class="km-f"><span>Belegstelle (Buch)</span><input data-top="cite" value="${kmEsc(p.cite || '')}" maxlength="80" autocomplete="off"></label>` +
    '<div class="dlg-actions"><button type="button" class="btn" data-x="sbcopy">Als Text kopieren</button><span class="spacer"></span><button type="button" class="btn primary" data-x="sbclose">Fertig</button></div>';
}
function kmSbInput(e) {
  const p = kmPerson(kmSbP), t = e.target, d = t.dataset;
  if (!p) return;
  const key = (d.top || d.k || '') + (d.q != null ? 'q' + d.q + d.qf : '') + (d.c != null ? 'c' + d.c + d.cf : '');
  if (!key) return;
  if (kmTyping !== 'sb' + key + p.id) { kmUndo.push(kmSnap()); kmRedo = []; kmTyping = 'sb' + key + p.id; }
  p.info = p.info || {};
  if (d.top) p[d.top] = t.value;
  else if (d.k) {
    p.info[d.k] = t.value;
    if (d.k === 'traits') kmEl('#km-sb-traits').innerHTML = t.value.split(',').map((x) => x.trim()).filter(Boolean).map((x) => `<span>${kmEsc(x)}</span>`).join('');
  } else if (d.q != null) p.info.quotes[Number(d.q)][d.qf] = t.value;
  else if (d.c != null) p.info.custom[Number(d.c)][d.cf] = t.value;
  kmSaved();
}
function kmSbClick(e) {
  const b = e.target.closest('button');
  const p = kmPerson(kmSbP);
  if (!b || !p) return;
  kmTyping = null;
  const d = b.dataset, edit = (fn) => { kmChange(() => { p.info = p.info || {}; fn(p.info); }); kmSbRender(); };
  if (d.x === 'sbclose') return kmEl('#km-sb').close();
  if (d.x === 'sbcopy') return navigator.clipboard.writeText(kmSbText(p)).then(() => toast('Steckbrief kopiert'), () => toast('Kopieren nicht erlaubt'));
  if (d.x === 'qadd') { edit((i) => { i.quotes = (i.quotes || []).concat({ t: '', c: '' }); }); const q = kmEl('#km-sb').querySelectorAll('[data-qf="t"]'); return q[q.length - 1].focus(); }
  if (d.x === 'cadd') { edit((i) => { i.custom = (i.custom || []).concat({ k: '', v: '' }); }); const c = kmEl('#km-sb').querySelectorAll('[data-cf="k"]'); return c[c.length - 1].focus(); }
  if (d.qx != null) return edit((i) => i.quotes.splice(Number(d.qx), 1));
  if (d.cx != null) return edit((i) => i.custom.splice(Number(d.cx), 1));
}

// ---- Ansicht ----
function kmFit() {
  const st = kmStage();
  if (!km || !st) return;
  const r = st.getBoundingClientRect();
  const b = kmBounds(kmScene());
  if (!b || !r.width) { kmView = { x: r.width / 2, y: r.height / 2, z: 1 }; kmRender(); return; }
  const z = Math.min(1.4, Math.max(0.2, Math.min((r.width - 60) / b.w, (r.height - 60) / b.h)));
  kmView = { z, x: r.width / 2 - (b.x + b.w / 2) * z, y: r.height / 2 - (b.y + b.h / 2) * z };
  km.view = { ...kmView };
  kmRender();
}
function kmZoomBy(f) {
  const r = kmStage().getBoundingClientRect(), z = Math.min(3, Math.max(0.2, kmView.z * f)), cx = r.width / 2, cy = r.height / 2;
  kmView = { z, x: cx - (cx - kmView.x) * z / kmView.z, y: cy - (cy - kmView.y) * z / kmView.z };
  km.view = { ...kmView };
  kmRender();
}

// ---- Seitenfeld (Eigenschaften) ----
function kmRefsHtml(o) {
  return `<label class="km-f"><span>Belegstelle (Buch, z. B. S. 34, Z. 12)</span><input id="km-cite" value="${kmEsc(o.cite || '')}" maxlength="80" autocomplete="off"></label>` +
    `<div class="km-f"><span>Verknüpfte Stellen in Notizen</span><div class="km-rels">${(o.refs || []).map((r, i) => `<span class="km-ref"><button type="button" class="km-rel" data-ref="${i}" style="--c:var(--accent)">📎 ${kmEsc(r.t)}</button><button type="button" class="km-ref-x" data-refx="${i}" aria-label="Verknüpfung entfernen">×</button></span>`).join('')}` +
    '<button type="button" class="chip" data-x="ref">＋ Stelle verknüpfen</button></div></div>';
}
function kmPanel(focusName) {
  const box = kmEl('#km-panel');
  if (!box) return;
  const o = kmSelObj();
  box.hidden = !o;
  kmEl('#km-wrap').classList.toggle('panel-open', !!o);
  if (!o) return;
  const sw = (cur, attr) => KM_COLORS.map((c) => `<button type="button" class="km-sw${c === cur ? ' on' : ''}" style="--c:${c}" ${attr}="${c}" aria-label="Farbe"></button>`).join('');
  const seg = (name, cur, opts) => `<span class="segmented small-seg km-seg">${opts.map(([v, l]) => `<button type="button" data-${name}="${v}" class="${v === cur ? 'active' : ''}">${l}</button>`).join('')}</span>`;
  const head = (t) => `<div class="km-ph"><b>${t}</b><button type="button" class="btn small link" data-x="close">Fertig</button></div>`;
  let h = '';
  if (kmSel.t === 'm') {
    const ps = o.ids.map(kmPerson).filter(Boolean);
    const allIn = (g) => ps.length && ps.every((p) => kmIn(p, g.id));
    h = head(`${ps.length} Personen${o.ink.length ? ` · ${o.ink.length} Striche` : ''} ausgewählt`) +
      '<p class="muted small-text">Eine davon ziehen = alle verschieben. Shift+Klick bzw. Rahmen mit Shift = dazunehmen.</p>' +
      `<div class="km-f"><span>Farbe für alle</span><div class="km-sws">${sw('', 'data-mc')}</div></div>` +
      `<div class="km-f"><span>Gruppen</span><div class="km-types">${km.groups.map((g) => `<button type="button" class="km-type${allIn(g) ? ' on' : ''}" data-mg="${g.id}" style="--c:${g.color}">${kmEsc(g.name)}</button>`).join('')}<button type="button" class="chip" data-x="mgroup">＋ Neue Gruppe</button></div></div>` +
      '<div class="km-btns"><button type="button" class="btn small" data-x="mframe">In neuen Kasten</button><button type="button" class="btn small" data-x="mlayout">Nur diese anordnen</button>' +
      '<button type="button" class="btn small" data-x="copy">Kopieren</button><button type="button" class="btn small" data-x="mdup">Duplizieren</button></div>' +
      '<div class="km-actions"><span></span><button type="button" class="btn small danger-text" data-x="del">Alle löschen</button></div>';
  } else if (kmSel.t === 'p') {
    const rel = km.links.filter((l) => l.a === o.id || l.b === o.id);
    h = head('Person') +
      `<label class="km-f"><span>Name</span><input id="km-name" value="${kmEsc(o.name)}" maxlength="40" autocomplete="off"></label>` +
      `<label class="km-f"><span>Rolle / kurz</span><input id="km-role" value="${kmEsc(o.role)}" maxlength="50" placeholder="z. B. Hauptfigur, Vater, 17 J." autocomplete="off"></label>` +
      `<div class="km-f"><span>Farbe</span><div class="km-sws">${sw(o.color, 'data-pc')}</div></div>` +
      `<div class="km-f"><span>Form</span>${seg('shape', o.shape || 'rect', [['rect', 'Karte'], ['pill', 'Pille'], ['ellipse', 'Oval']])}</div>` +
      `<label class="km-f km-row"><span>Hauptfigur (groß)</span><label class="switch"><input type="checkbox" id="km-big"${o.big ? ' checked' : ''}><span></span></label></label>` +
      `<label class="km-f"><span>Symbol</span><input id="km-emoji" value="${kmEsc(o.emoji || '')}" maxlength="4" placeholder="z. B. 👑 🗡️ ❤️" autocomplete="off"></label>` +
      `<div class="km-f"><span>Gruppen (mehrere möglich)</span><div class="km-types">${km.groups.map((g) => `<button type="button" class="km-type${kmIn(o, g.id) ? ' on' : ''}" data-pg="${g.id}" style="--c:${g.color}">${kmEsc(g.name)}</button>`).join('')}<button type="button" class="chip" data-pgnew="1">＋ Neue Gruppe</button></div></div>` +
      `<div class="km-f km-sbbox"><span>Steckbrief</span>${kmSbSummary(o)}<button type="button" class="btn primary small" data-x="sb">📋 Steckbrief öffnen</button></div>` +
      `<label class="km-f"><span>Notizen</span><textarea id="km-desc" rows="3">${kmEsc(o.desc || '')}</textarea></label>` +
      kmRefsHtml(o) +
      `<div class="km-f"><span>Beziehungen (${rel.length})</span><div class="km-rels">${rel.map((l) => { const other = kmPerson(l.a === o.id ? l.b : l.a); return `<button type="button" class="km-rel" data-rel="${l.id}" style="--c:${l.color || kmType(l.type).color}">${kmEsc(l.label || kmType(l.type).name)} · ${kmEsc(other ? other.name : '?')}</button>`; }).join('') || '<span class="muted small-text">Am ⊕ neben der Person ziehen</span>'}</div></div>` +
      '<div class="km-actions"><span><button type="button" class="btn small" data-x="copy">Kopieren</button> <button type="button" class="btn small" data-x="dup">Duplizieren</button></span><button type="button" class="btn small danger-text" data-x="del">Löschen</button></div>';
  } else if (kmSel.t === 'l') {
    const A = kmPerson(o.a), B = kmPerson(o.b), ty = kmType(o.type);
    h = head('Beziehung') +
      `<div class="km-between"><b>${kmEsc(A ? A.name : '?')}</b><button type="button" class="btn small" data-x="swap" title="Richtung tauschen">⇄</button><b>${kmEsc(B ? B.name : '?')}</b></div>` +
      `<div class="km-f"><span>Art</span><div class="km-types">${KM_TYPES.map((t) => `<button type="button" class="km-type${t.id === ty.id ? ' on' : ''}" data-type="${t.id}" style="--c:${t.color}">${t.name}</button>`).join('')}</div></div>` +
      `<label class="km-f"><span>Bezeichnung</span><input id="km-label" value="${kmEsc(o.label)}" maxlength="40" placeholder="z. B. ${kmEsc(ty.labels[0])}" autocomplete="off"></label>` +
      `<div class="km-chips">${ty.labels.map((t) => `<button type="button" class="chip" data-lab="${kmEsc(t)}">${kmEsc(t)}</button>`).join('')}</div>` +
      `<div class="km-f"><span>Richtung</span>${seg('dir', o.dir || 'ab', [['ab', '→'], ['ba', '←'], ['both', '↔'], ['none', '—']])}</div>` +
      `<div class="km-f"><span>Linie</span>${seg('dash', o.dash || ty.dash, [['solid', '──'], ['dashed', '- - -'], ['dotted', '···']])}</div>` +
      `<div class="km-f"><span>Stärke</span>${seg('w', String(o.w || 2), [['1', 'schwach'], ['2', 'mittel'], ['3', 'stark']])}</div>` +
      `<div class="km-f"><span>Eigene Farbe</span><div class="km-sws">${sw(o.color, 'data-lc')}<button type="button" class="btn small link" data-lc="">Standard</button></div></div>` +
      `<div class="km-f"><span>Bogen</span>${seg('bend', String(Math.sign(o.bend || 0)), [['-1', '◜'], ['0', 'gerade'], ['1', '◝']])}</div>` +
      `<label class="km-f"><span>Notizen (Entwicklung, Deutung …)</span><textarea id="km-ldesc" rows="3">${kmEsc(o.desc || '')}</textarea></label>` +
      kmRefsHtml(o) +
      '<div class="km-actions"><span></span><button type="button" class="btn small danger-text" data-x="del">Beziehung löschen</button></div>';
  } else if (kmSel.t === 'f') {
    const c = kmFrameContent(o), s = kmStackOf(o.id), src = o.from && kmFrame(o.from);
    const free = km.frames.filter((x) => x.id !== o.id && !kmStackOf(x.id));
    h = head('Kasten') +
      `<label class="km-f"><span>Name</span><input id="km-fname" value="${kmEsc(o.name)}" maxlength="40" autocomplete="off" placeholder="z. B. Akt 1"></label>` +
      `<div class="km-f"><span>Farbe</span><div class="km-sws">${sw(o.color, 'data-fc')}</div></div>` +
      `<p class="muted small-text">Darin: ${c.persons.length} Personen${c.ink.length ? `, ${c.ink.length} Striche` : ''}.${src ? ` Kopie von „${kmEsc(src.name)}“ – Änderungen werden markiert.` : ''} Am Titel ziehen = verschieben, Kreis unten rechts = Größe.</p>` +
      '<button type="button" class="btn primary small" data-x="fdup">Als nächsten Akt kopieren →</button>' +
      (s ? `<div class="km-f km-stackbox"><span>Stapel</span><label class="km-f"><input id="km-sname" value="${kmEsc(s.name || '')}" maxlength="40" placeholder="Name des Stapels" autocomplete="off"></label>` +
        `<div class="km-btns">${s.open ? '<button type="button" class="btn small" data-x="scol">⇲ Zusammenlegen</button>' : '<button type="button" class="btn small" data-x="sfan">⇆ Ausfächern</button>'}` +
        '<button type="button" class="btn small" data-x="sleft">◀ früher</button><button type="button" class="btn small" data-x="sright">später ▶</button>' +
        '<button type="button" class="btn small link" data-x="sout">Aus Stapel nehmen</button></div></div>'
        : free.length ? `<div class="km-f km-stackbox"><span>Zu einem Stapel zusammenlegen (Reiter wie 1. Akt, 2. Akt …)</span><div class="km-rels">${free.map((x) => `<label class="km-member"><input type="checkbox" data-sf="${x.id}" checked> ${kmEsc(x.name)}</label>`).join('')}</div><button type="button" class="btn small" data-x="stack">⇲ Zusammenlegen</button></div>` : '') +
      `<label class="km-f"><span>Notizen (Inhalt, Wendepunkte …)</span><textarea id="km-fdesc" rows="3">${kmEsc(o.desc || '')}</textarea></label>` +
      '<div class="km-actions"><button type="button" class="btn small" data-x="del">Nur Kasten entfernen</button><button type="button" class="btn small danger-text" data-x="fall">Mit Inhalt löschen</button></div>';
  } else {
    const ms = km.persons.filter((p) => kmIn(p, o.id));
    h = head('Gruppe') +
      `<label class="km-f"><span>Name</span><input id="km-gname" value="${kmEsc(o.name)}" maxlength="40" autocomplete="off"></label>` +
      `<div class="km-f"><span>Farbe</span><div class="km-sws">${sw(o.color, 'data-gc')}</div></div>` +
      `<div class="km-f"><span>Mitglieder (${ms.length})</span><div class="km-rels">${km.persons.map((p) => `<label class="km-member"><input type="checkbox" data-mem="${p.id}"${kmIn(p, o.id) ? ' checked' : ''}> ${kmEsc(p.name)}</label>`).join('')}</div></div>` +
      '<p class="muted small-text">Am Namen der Gruppe ziehen = alle Mitglieder verschieben. Eine Person kann in mehreren Gruppen sein.</p>' +
      '<div class="km-actions"><span></span><button type="button" class="btn small danger-text" data-x="del">Gruppe auflösen</button></div>';
  }
  box.innerHTML = h;
  if (focusName) { const n = box.querySelector('#km-name'); if (n) { n.focus(); n.select(); } }
}

// Eingaben im Seitenfeld: Text sofort übernehmen, ein Rückgängig-Schritt pro Feld
let kmTyping = null;
function kmField(e) {
  const o = kmSelObj();
  if (!o || kmSel.t === 'm') return;
  const id = e.target.id;
  if (id === 'km-sname') { const s = kmStackOf(o.id); if (s) { s.name = e.target.value.trimStart(); kmSaved(); } return; }
  const map = { 'km-name': 'name', 'km-role': 'role', 'km-emoji': 'emoji', 'km-desc': 'desc', 'km-label': 'label', 'km-ldesc': 'desc', 'km-gname': 'name', 'km-fname': 'name', 'km-fdesc': 'desc', 'km-cite': 'cite' };
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
  if (d.x === 'copy') return kmCopy();
  if (d.x === 'dup' || d.x === 'mdup') return kmDuplicateSel();
  if (d.x === 'ref') return kmRefStart(kmSel.t, o.id);
  if (d.x === 'sb') return kmSbOpen(o);
  if (d.ref != null) return kmJump(o.refs[Number(d.ref)]);
  if (d.refx != null) return set(() => { o.refs.splice(Number(d.refx), 1); if (!o.refs.length) delete o.refs; });
  // Mehrfachauswahl
  if (kmSel.t === 'm') {
    const ps = o.ids.map(kmPerson).filter(Boolean);
    if (d.mc) return set(() => ps.forEach((p) => { p.color = d.mc; }));
    if (d.mg) return set(() => { const all = ps.every((p) => kmIn(p, d.mg)); ps.forEach((p) => (all ? kmLeave(p, d.mg) : kmJoin(p, d.mg))); });
    if (d.x === 'mgroup') return kmAddGroup();
    if (d.x === 'mframe') return kmFrameAroundSel();
    if (d.x === 'mlayout') return kmLayout(o.ids);
    return;
  }
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
  if (d.x === 'stack') return kmStackFrames(o, [...kmEl('#km-panel').querySelectorAll('[data-sf]:checked')].map((x) => x.dataset.sf));
  const s = kmStackOf(o.id);
  if (s && d.x === 'scol') { kmChange(() => { s.active = o.id; kmCollapse(s); }); kmFit(); return kmPanel(); }
  if (s && d.x === 'sfan') { kmChange(() => kmFan(s)); kmFit(); return kmPanel(); }
  if (s && (d.x === 'sleft' || d.x === 'sright')) {
    const i = s.frames.indexOf(o.id), j = i + (d.x === 'sleft' ? -1 : 1);
    if (j < 0 || j >= s.frames.length) return;
    return set(() => {
      [s.frames[i], s.frames[j]] = [s.frames[j], s.frames[i]];
      if (s.open) { kmCollapse(s); s.active = o.id; kmFan(s); }   // ausgefächert: neu nebeneinander legen
    });
  }
  if (s && d.x === 'sout') {
    return set(() => {
      if (!s.open) kmFan(s);
      // aus der Reihe darunter legen – mit Inhalt
      const c = kmFrameContent(o), dy = o.h + 80;
      s.frames = s.frames.filter((id) => id !== o.id);
      o.y += dy;
      c.persons.forEach((p) => { p.y += dy; });
      km.ink = km.ink.map((st) => (c.ink.includes(st) ? kmMoveInk(st, 0, dy) : st));
    });
  }
  if (b.id === 'km-big') return set(() => { o.big = b.checked; });
}

// ---- Export als Bild (Canvas, ohne Umweg – damit das iPad das Teilen-Menü erlaubt) ----
function kmPillCanvas(ctx, x, y, text, fill, color, fs = 12, strike = false) {
  ctx.font = `600 ${fs}px ${KM_FONT}`;
  const w = ctx.measureText(text).width + 18, h = fs + 14;
  ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, h, h / 2) : ctx.rect(x, y, w, h);
  ctx.fillStyle = fill; ctx.fill(); ctx.strokeStyle = color; ctx.lineWidth = 1.3; ctx.stroke();
  ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.fillText(text, x + w / 2, y + fs + 3);
  if (strike) { ctx.beginPath(); ctx.moveTo(x + 9, y + h / 2); ctx.lineTo(x + w - 9, y + h / 2); ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.stroke(); }
  return w;
}
function kmDrawScene(ctx, sc) {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const rr = (x, y, w, h, r) => { ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h); };
  for (const T of sc.stacks) {
    if (T.s.open) {
      ctx.beginPath(); ctx.moveTo(T.x, T.y + 30); ctx.lineTo(T.x, T.y + 22); ctx.lineTo(T.x + T.w, T.y + 22); ctx.lineTo(T.x + T.w, T.y + 30);
      ctx.strokeStyle = '#8e8e93'; ctx.lineWidth = 1.5; ctx.stroke();
      kmPillCanvas(ctx, T.x + 10, T.y + 6, T.s.name || 'Stapel', '#fff', '#1f4e9e', 13);
    } else {
      let x = T.x;
      for (const F of T.fs) { const on = F.id === T.s.active, c = F.color || '#6b7280'; x += kmPillCanvas(ctx, x, T.y + 6, F.name || 'Akt', on ? c : '#fff', on ? '#fff' : c, 13) + 6; }
    }
  }
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
  for (const g of sc.ghosts) {
    ctx.beginPath(); ctx.moveTo(g.a[0], g.a[1]); ctx.quadraticCurveTo(g.c[0], g.c[1], g.b[0], g.b[1]);
    ctx.setLineDash([4, 5]); ctx.strokeStyle = KM_GONE; ctx.lineWidth = 2; ctx.stroke(); ctx.setLineDash([]);
    ctx.font = `600 12px ${KM_FONT}`;
    kmPillCanvas(ctx, g.lx - ctx.measureText(g.text).width / 2 - 9, g.ly - 13, g.text, '#f3f4f6', KM_GONE, 12, true);
  }
  for (const k of sc.links) {
    const d = () => { ctx.beginPath(); ctx.moveTo(k.a[0], k.a[1]); ctx.quadraticCurveTo(k.c[0], k.c[1], k.b[0], k.b[1]); };
    if (k.mark) { d(); ctx.globalAlpha = 0.3; ctx.strokeStyle = k.mark === 'new' ? KM_NEW : KM_CHG; ctx.lineWidth = k.w + 9; ctx.stroke(); ctx.globalAlpha = 1; }
    d();
    ctx.setLineDash(KM_DASH[k.dash] ? KM_DASH[k.dash].split(' ').map(Number) : []);
    ctx.strokeStyle = k.color; ctx.lineWidth = k.w; ctx.stroke(); ctx.setLineDash([]);
    for (const ar of k.arrows) { const q = kmArrowPts(ar, k.w); ctx.beginPath(); ctx.moveTo(...q[0]); ctx.lineTo(...q[1]); ctx.lineTo(...q[2]); ctx.closePath(); ctx.fillStyle = k.color; ctx.fill(); }
  }
  for (const p of sc.persons) {
    const b = sc.boxes.get(p.id), c = p.color || KM_COLORS[0];
    if (p.shape === 'ellipse') { ctx.beginPath(); ctx.ellipse(p.x, p.y, b.w / 2, b.h / 2, 0, 0, Math.PI * 2); } else rr(b.x, b.y, b.w, b.h, p.shape === 'pill' ? b.h / 2 : 10);
    ctx.fillStyle = kmTint(c, 0.86); ctx.fill(); ctx.strokeStyle = c; ctx.lineWidth = b.big ? 3.2 : 1.8; ctx.stroke();
    ctx.textAlign = 'center'; ctx.fillStyle = '#1c1c1e'; ctx.font = `${b.big ? 700 : 600} ${b.fs}px ${KM_FONT}`;
    ctx.fillText((p.emoji ? p.emoji + ' ' : '') + (p.name || '?'), p.x, p.role ? b.y + b.h / 2 - 3 : p.y + b.fs * 0.36);
    if (p.role) { ctx.fillStyle = '#55555c'; ctx.font = `12px ${KM_FONT}`; ctx.fillText(p.role, p.x, b.y + b.h / 2 + 14); }
    if (sc.diff.newP.has(p.id)) kmPillCanvas(ctx, b.x - 8, b.y - 16, 'neu', KM_NEW, '#fff', 11);
    else if (sc.diff.chgP.has(p.id)) kmPillCanvas(ctx, b.x - 8, b.y - 16, 'geändert', KM_CHG, '#fff', 11);
  }
  for (const k of sc.links) {
    if (!k.label) continue;
    const col = k.mark === 'new' ? KM_NEW : k.mark === 'chg' ? KM_CHG : k.color;
    ctx.font = `600 12px ${KM_FONT}`;
    const w = ctx.measureText(k.label.text).width + 14;
    rr(k.label.x - w / 2, k.label.y - 11, w, 22, 11);
    ctx.fillStyle = '#fff'; ctx.fill(); ctx.strokeStyle = col; ctx.lineWidth = k.mark ? 2 : 1.2; ctx.stroke();
    ctx.fillStyle = k.color; ctx.textAlign = 'center'; ctx.fillText(k.label.text, k.label.x, k.label.y + 4);
  }
  for (const g of sc.diff.gone) if (sc.frames.includes(g.F)) kmPillCanvas(ctx, g.F.x + 12, g.F.y + g.F.h - 34, '✕ nicht mehr dabei: ' + g.names.join(', '), '#f3f4f6', '#6b7280');
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
  const target = await kmNotePicker('In welche Notiz einfügen?', '＋ Neue Notiz');
  if (!target) return;
  await flushNoteSave();
  if (target === '__new') {
    await createNote(from.folder);
    note.title = from.title || 'Personenkonstellation';
    $('#note-title').value = note.title;
    saveNote();
  } else await openNote(target);
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
  kmEl('#km-diff').classList.toggle('active', kmDiff);
  kmEl('#km-grid').classList.toggle('active', kmGrid);
  kmEl('#km-selmode').classList.toggle('active', kmSelMode);
  kmEl('#km-paste').disabled = !store.get('kmClip', null);
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
    `<button class="tool" id="km-selmode" aria-label="Auswahlrahmen (auch mit dem Finger)">${ico('<rect x="4" y="4" width="16" height="16" rx="2" stroke-dasharray="3 3"/><path d="M13 13l6 6M13 13v5M13 13h5"/>')}</button>` +
    `<button class="tool" id="km-group-add" aria-label="Gruppe um die Auswahl">${ico('<rect x="3" y="5" width="18" height="14" rx="3" stroke-dasharray="3 2.5"/><circle cx="9" cy="12" r="2"/><circle cx="15" cy="12" r="2"/>')}</button>` +
    `<button class="tool" id="km-frame-add" aria-label="Akt-Kasten (z. B. Akt 1, Kapitel)">${ico('<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M3 9h7V4"/>')}</button>` +
    `<button class="tool" id="km-draw" aria-label="Stift: frei schreiben und zeichnen">${ico('<path d="M5 19l2-6L17 3l4 4-10 10z"/><path d="M15 5l4 4"/>')}</button>` +
    `<button class="tool" id="km-paste" aria-label="Einfügen">${ico('<rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4V3h6v1"/><path d="M9 11h6M9 15h4"/>')}</button>` +
    `<button class="tool" id="km-tpl" aria-label="Vorlage einfügen">${ico('<rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="8" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/><path d="M17 14v6M14 17h6"/>')}</button></div>` +
    '<div class="tool-group">' +
    `<button class="tool" id="km-layout" aria-label="Automatisch anordnen">${ico('<circle cx="12" cy="5" r="2"/><circle cx="5" cy="18" r="2"/><circle cx="19" cy="18" r="2"/><path d="M11 7l-5 9M13 7l5 9M7 18h10"/>')}</button>` +
    `<button class="tool" id="km-focus" aria-label="Fokus: nur Beziehungen der ausgewählten Person">${ico('<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8" stroke-dasharray="3 3"/>')}</button>` +
    `<button class="tool" id="km-grid" aria-label="Am Raster ausrichten">${ico('<path d="M4 4v16M10 4v16M16 4v16M4 4h16M4 10h16M4 16h16" stroke-width="1.4"/><circle cx="16" cy="16" r="2.5" fill="currentColor"/>')}</button>` +
    `<button class="tool" id="km-diff" aria-label="Änderungen zum vorigen Akt markieren">${ico('<path d="M5 12h5M7.5 9.5v5"/><path d="M14 12h5"/><rect x="2.5" y="5" width="19" height="14" rx="3"/>')}</button>` +
    `<button class="tool" id="km-legend-btn" aria-label="Legende ein/aus">${ico('<path d="M4 7h4M4 12h4M4 17h4M11 7h9M11 12h9M11 17h9"/>')}</button></div>` +
    '<div class="tool-group zoom-group"><button class="tool" id="km-zout" aria-label="Verkleinern">−</button><button class="tool zoom-label" id="km-zoom" aria-label="Alles zeigen">100%</button><button class="tool" id="km-zin" aria-label="Vergrößern">+</button>' +
    `<button class="tool" id="km-fit" aria-label="Alles zeigen">${ico('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>')}</button>` +
    `<button class="tool" id="km-tonote" aria-label="Als Bild in eine Notiz einfügen">${ico('<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h5"/><path d="M15 15h5M17.5 12.5v5"/>')}</button>` +
    `<button class="tool" id="km-export" aria-label="Als Bild teilen">${ico('<path d="M12 3v12M8 7l4-4 4 4"/><path d="M6 11H5v10h14V11h-1"/>')}</button></div>` +
    `<div class="tool-group km-inkbar" id="km-inkbar" hidden>${PEN_COLORS.map((c, i) => `<button class="tool swatch" data-ink="${i}" style="--c:${c}" aria-label="Stiftfarbe"></button>`).join('')}` +
    `<button class="tool" id="km-erase" aria-label="Radierer (Striche)">${ico('<path d="M4 15l9-9a2 2 0 012.8 0l3.2 3.2a2 2 0 010 2.8L13 18H7z"/><path d="M9 11l6 6"/><path d="M7 21h13"/>')}</button></div></div>` +
    '<div class="km-main"><div class="km-stage" id="km-stage"><svg id="km-svg" xmlns="http://www.w3.org/2000/svg"></svg>' +
    '<div class="km-empty card" id="km-empty"><b>Personenkonstellation</b><p class="muted small-text">Doppeltippen auf die Fläche oder <b>＋ Person</b> = neue Person.<br>Person antippen und am <b>⊕</b> zu einer anderen ziehen = Beziehung.<br>Mit dem Stift einen Rahmen ziehen = mehrere auswählen.</p><button type="button" class="btn small" id="km-empty-tpl">Mit einer Vorlage starten</button></div>' +
    '<div class="km-legend" id="km-legend" hidden></div></div>' +
    '<aside class="km-panel" id="km-panel" hidden></aside></div>';
  kmEl('#view-notes').append(wrap);
  // Leisten außerhalb: Stelle wählen / zurück zur Konstellation
  const pick = document.createElement('div');
  pick.id = 'km-pickbar';
  pick.className = 'km-floatbar';
  pick.hidden = true;
  pick.innerHTML = '<span>📎 Tippe auf die Stelle, die du verknüpfen willst</span><button type="button" class="btn small" id="km-pick-cancel">Abbrechen</button>';
  const back = document.createElement('button');
  back.id = 'km-backpill';
  back.type = 'button';
  back.className = 'km-floatbar km-backpill';
  back.hidden = true;
  back.textContent = '← Zurück zur Konstellation';
  document.body.append(pick, back);
  kmEl('#km-pick-cancel').addEventListener('click', kmPickCancel);
  back.addEventListener('click', () => { back.hidden = true; if (kmBackTo) kmOpenById(kmBackTo); });
  pagesBox.addEventListener('pointerdown', kmPickDown, true);
  pagesBox.addEventListener('pointerup', kmPickUp, true);

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
  on('#km-selmode', () => { kmSelMode = !kmSelMode; kmBarState(); if (kmSelMode) toast('Auswahl: mit dem Finger einen Rahmen ziehen · zwei Finger = verschieben'); });
  on('#km-group-add', kmAddGroup);
  on('#km-paste', () => kmPaste());
  on('#km-tpl', kmTemplateDialog);
  on('#km-empty-tpl', kmTemplateDialog);
  on('#km-layout', () => { if (km.persons.length < 2) return toast('Erst ein paar Personen anlegen'); kmLayout(); toast('Angeordnet – Rückgängig geht'); });
  on('#km-focus', () => { kmFocus = !kmFocus; kmBarState(); kmRender(); if (kmFocus && (!kmSel || kmSel.t !== 'p')) toast('Fokus: eine Person antippen'); });
  on('#km-grid', () => {
    kmGrid = !kmGrid;
    store.set('kmGrid', kmGrid);
    kmBarState();
    if (kmGrid) {
      // gleich alles ausrichten (ein Rückgängig-Schritt)
      kmChange(() => {
        km.persons.forEach((p) => { p.x = kmGridV(p.x); p.y = kmGridV(p.y); });
        km.frames.forEach((F) => { const dx = kmGridV(F.x) - F.x, dy = kmGridV(F.y) - F.y; F.x += dx; F.y += dy; F.w = kmGridV(F.w); F.h = kmGridV(F.h); });
      });
      toast('Raster an – Personen und Kästen rasten beim Verschieben ein');
    } else { kmRender(); toast('Raster aus'); }
  });
  on('#km-diff', () => { kmDiff = !kmDiff; store.set('kmDiff', kmDiff); kmBarState(); kmRender(); toast(kmDiff ? 'Änderungen zum vorigen Akt: grün = neu, orange = geändert, grau = weg' : 'Änderungen ausgeblendet'); });
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
  // Tastatur (Surface): Entf, Strg+Z/Y/C/V/D/A, Esc
  document.addEventListener('keydown', (e) => {
    if (!km || !document.body.classList.contains('kmap-mode') || document.body.dataset.view !== 'notes') return;
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) || document.querySelector('dialog[open]')) return;
    const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
    if ((e.key === 'Delete' || e.key === 'Backspace') && kmSel) { e.preventDefault(); kmDelete(); }
    else if (e.key === 'Escape') kmSelect(null);
    else if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? kmRestore(kmRedo, kmUndo) : kmRestore(kmUndo, kmRedo); }
    else if (mod && k === 'y') { e.preventDefault(); kmRestore(kmRedo, kmUndo); }
    else if (mod && k === 'c') { e.preventDefault(); kmCopy(); }
    else if (mod && k === 'v') { e.preventDefault(); kmPaste(); }
    else if (mod && k === 'd') { e.preventDefault(); kmDuplicateSel(); }
    else if (mod && k === 'a') { e.preventDefault(); kmSelectAll(); }
  });
  window.addEventListener('resize', () => { if (km && document.body.classList.contains('kmap-mode')) kmRender(); });
}

// ---- Anbindung an die Notizen ----
window.addEventListener('noteopen', (e) => {
  const n = e.detail;
  const on = n && n.kind === 'kmap';
  document.body.classList.toggle('kmap-mode', on);
  $('#note-title').placeholder = on ? 'Unbenannte Konstellation' : 'Unbenannte Notiz';
  if (on) { kmOpen(n); const b = kmEl('#km-backpill'); if (b) b.hidden = true; }
  else { km = null; kmSel = null; }
});
window.addEventListener('viewchange', (e) => {
  if (e.detail === 'notes') return;
  const b = kmEl('#km-backpill'), p = kmEl('#km-pickbar');
  if (b) b.hidden = true;
  if (p && kmPick) { kmPick = null; p.hidden = true; }
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
