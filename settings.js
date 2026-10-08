// ---------- Einstellungen ----------
// Alles an einer Stelle. Wird nach notes.js geladen und greift direkt auf deren Werte zu.
const TOOLBAR_OPTIONAL = [
  ['[data-tool="ball"]', 'ball', 'Kugelschreiber'], ['[data-tool="marker"]', 'marker', 'Textmarker'],
  ['[data-tool="text"]', 'text', 'Text'], ['[data-tool="lasso"]', 'lasso', 'Lasso'], ['[data-tool="select"]', 'select', 'Auswahl-Pfeil'],
  ['#image-insert', 'image', 'Bild einfügen'], ['[data-tool="snote"]', 'snote', 'Side Notes'], ['[data-tool="math"]', 'math', 'Formel'],
  ['[data-tool="coord"]', 'coord', 'Koordinatensystem'], ['#ruler-toggle', 'ruler', 'Lineal'], ['#shape-toggle', 'shape', 'Formerkennung-Knopf'],
  ['.zoom-group', 'zoom', 'Zoom-Knöpfe'], ['#finger-toggle', 'finger', 'Finger-Knopf']
];
let hiddenTools = new Set(store.get('hiddenTools', []));

function applyTools() {
  for (const [selector, id] of TOOLBAR_OPTIONAL) {
    document.querySelectorAll('#toolbar ' + selector).forEach((el) => { el.hidden = hiddenTools.has(id); });
  }
  // ausgeblendetes Werkzeug war aktiv → zurück zum Füller
  const cur = document.querySelector(`#toolbar [data-tool="${tool}"]`);
  if (cur && cur.hidden) document.querySelector('#toolbar [data-tool="pen"]').click();
}

function applyTheme(v) {
  if (v === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = v;
}

const SETTINGS = [
  { title: 'Allgemein', items: [
    { label: 'Design', key: 'theme', def: 'auto', opts: [['auto', 'Automatisch'], ['light', 'Hell'], ['dark', 'Dunkel']], apply: applyTheme },
    { label: 'Beim Öffnen', key: 'startView', def: 'last', opts: [['last', 'Zuletzt'], ['home', 'Start'], ['notes', 'Notizen']] }
  ] },
  { title: 'Stift & Schreiben', items: [
    { label: 'Druckempfindlichkeit', hint: 'Wie stark der Füller auf Druck reagiert', key: 'penPressure', def: 2, opts: [[0, 'Aus'], [1, 'Leicht'], [2, 'Normal'], [3, 'Stark']], apply: (v) => { penPressure = v; resetInkCache(); } },
    { label: 'Glättung', hint: 'Aus = genau wie geschrieben, stark = sehr ruhige Linien', key: 'penSmooth', def: 2, opts: [[0, 'Aus'], [1, 'Wenig'], [2, 'Normal'], [4, 'Stark']], apply: (v) => { penSmooth = v; resetInkCache(); } },
    { label: 'Mit dem Finger zeichnen', hint: 'Aus: nur der Stift schreibt, der Finger scrollt', get: () => fingerDraw, set: (v) => setFingerDraw(v) },
    { label: 'Handballen-Erkennung', hint: 'Stark: Hand wird länger und früher ignoriert', key: 'palm', def: 'normal', opts: [['off', 'Aus'], ['normal', 'Normal'], ['strong', 'Stark']], apply: (v) => { [PALM_MS, PALM_SIZE] = PALM_LEVELS[v]; } },
    { label: 'Formerkennung', hint: 'Am Ende des Strichs kurz halten → saubere Form', get: () => shapeRecog, set: (v) => { shapeRecog = v; store.set('shapeRecog', v); renderShapeToggle(); } },
    { label: 'Haltedauer für Formen', key: 'holdMs', def: 550, opts: [[400, 'Kurz'], [550, 'Normal'], [800, 'Lang']], apply: (v) => { HOLD_MS = v; } },
    { label: 'Radierer', get: () => eraserMode, set: (v) => { eraserMode = v; store.set('eraserMode', v); renderColors(); }, opts: [['stroke', 'Ganzer Strich'], ['part', 'Teil']] }
  ] },
  { title: 'Papier & Lineal', items: [
    { label: 'Papier für neue Notizen', key: 'notePaper', def: 'lines', opts: [['blank', 'Blanko'], ['lines', 'Liniert'], ['grid', 'Kariert'], ['dots', 'Punkte']] },
    { label: 'Lineal rastet bei 45° ein', get: () => rulerSnap, set: (v) => { rulerSnap = v; store.set('rulerSnap', v); } }
  ] },
  { title: 'Text', items: [
    { label: 'Rechtschreibprüfung', get: () => textSpell, set: (v) => { textSpell = v; store.set('textSpell', v); } },
    { label: 'Schnell-Ersetzen beim Tippen', hint: '-> wird →, ^2 wird ², \\pi wird π …', get: () => textReplace, set: (v) => { textReplace = v; store.set('textReplace', v); } }
  ] },
  { title: 'Side Notes', items: [
    { label: 'Side Notes anzeigen', get: () => !snAllHidden, set: (v) => { snAllHidden = !v; snSaveKeys(); refreshSn(); } },
    { label: 'Spalte neben der Seite', get: () => snColumn, set: (v) => { snColumn = v; store.set('snColumn', v); refreshSn(); } },
    { label: 'Verbindungslinien', get: () => snLinks, set: (v) => { snLinks = v; store.set('snLinks', v); refreshSn(); } },
    { label: 'Im Export', get: () => snPdf, set: (v) => { snPdf = v; store.set('snPdf', v); renderSnPdf(); }, opts: [['off', 'Aus'], ['marks', 'Markiert'], ['list', 'Mit Liste']] }
  ] }
];

function settingsValue(it) { return it.get ? it.get() : store.get(it.key, it.def); }
function settingsSet(it, v) {
  if (it.set) it.set(v);
  else { store.set(it.key, v); if (it.apply) it.apply(v); }
  renderSettings();
}

function renderSettings() {
  const box = $('#settings-list');
  box.innerHTML = '';
  for (const sec of SETTINGS) {
    const h = document.createElement('h3');
    h.className = 'set-title';
    h.textContent = sec.title;
    const group = document.createElement('div');
    group.className = 'list-group';
    for (const it of sec.items) {
      const row = document.createElement('div');
      row.className = 'row set-row' + (it.opts && it.opts.length > 3 ? ' wide' : '');
      const label = document.createElement('div');
      label.className = 'set-label';
      label.innerHTML = `<span>${it.label}</span>` + (it.hint ? `<span class="muted small-text">${it.hint}</span>` : '');
      row.append(label);
      const v = settingsValue(it);
      if (it.opts) {
        const seg = document.createElement('div');
        seg.className = 'segmented small-seg';
        for (const [val, text] of it.opts) {
          const b = document.createElement('button');
          b.type = 'button';
          b.textContent = text;
          b.className = val === v ? 'active' : '';
          b.addEventListener('click', () => settingsSet(it, val));
          seg.append(b);
        }
        row.append(seg);
      } else {
        const sw = document.createElement('label');
        sw.className = 'switch';
        sw.innerHTML = `<input type="checkbox"${v ? ' checked' : ''}><span></span>`;
        sw.querySelector('input').addEventListener('change', (e) => settingsSet(it, e.target.checked));
        row.append(sw);
      }
      group.append(row);
    }
    box.append(h, group);
  }
  // Werkzeugleiste: welche Knöpfe erscheinen
  const h = document.createElement('h3');
  h.className = 'set-title';
  h.textContent = 'Werkzeugleiste';
  const p = document.createElement('p');
  p.className = 'muted small-text set-note';
  p.textContent = 'Was du nicht brauchst, kannst du ausblenden – die Leiste wird kürzer. Füller und Radierer bleiben immer.';
  const chips = document.createElement('div');
  chips.className = 'set-tools';
  for (const [, id, name] of TOOLBAR_OPTIONAL) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'set-tool' + (hiddenTools.has(id) ? '' : ' on');
    b.textContent = (hiddenTools.has(id) ? '○ ' : '● ') + name;
    b.addEventListener('click', () => {
      if (hiddenTools.has(id)) hiddenTools.delete(id); else hiddenTools.add(id);
      store.set('hiddenTools', [...hiddenTools]);
      applyTools();
      renderSettings();
    });
    chips.append(b);
  }
  box.append(h, p, chips);
}

$('#settings-to-info').addEventListener('click', () => showView('info'));
$('#note-settings').addEventListener('click', () => { $('#more-dialog').close(); showView('settings'); });
window.addEventListener('viewchange', (e) => { if (e.detail === 'settings') renderSettings(); });
applyTools();
renderSettings();
