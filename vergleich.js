// ---------- Vergleich (eigene Notiz-Art) ----------
// Eine Notiz mit kind: 'cmp' zeigt eine Vergleichstabelle: Spalten = was verglichen wird
// (z. B. Soziale Marktwirtschaft, Planwirtschaft), Zeilen = Kriterien (Eigentum, Preisbildung …).
// Dazu Gemeinsamkeiten, Fazit, Bewertung je Zelle (+ / − / ○), eine Venn-Ansicht (bei zwei Spalten)
// und ein Abfrage-Modus (Zellen verdeckt, antippen zeigt sie). Gespeichert in note.cmp.

const CM_COLORS = ['#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed', '#0891b2'];
const CM_MARKS = { '': '', '+': '#16a34a', '−': '#dc2626', '○': '#8e8e93' };
let cm = null;                 // = note.cmp
let cmUndo = [], cmRedo = [], cmTyping = null;
let cmQuiz = false, cmShown = new Set();
const cmId = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const cmEl = (s) => document.querySelector(s);
const cmBlank = () => ({ view: 'table', cols: [{ id: 'c1', name: 'A', color: CM_COLORS[0] }, { id: 'c2', name: 'B', color: CM_COLORS[1] }], rows: [{ id: cmId('r'), name: 'Kriterium', cells: {}, marks: {} }], common: '', result: '' });

// ---- Vorlagen ----
const CM_TEMPLATES = [
  {
    id: 'wirtschaft', name: 'Soziale Marktwirtschaft vs. Planwirtschaft', desc: 'Wirtschaftsordnungen – fertig ausgefüllt zum Lernen und Ergänzen', title: 'Soziale Marktwirtschaft vs. Planwirtschaft',
    cols: [['Soziale Marktwirtschaft', '#2563eb'], ['Planwirtschaft (Zentralverwaltungswirtschaft)', '#dc2626']],
    rows: [
      ['Grundidee', 'Freiheit des Marktes, verbunden mit sozialem Ausgleich (Alfred Müller-Armack, Ludwig Erhard)', 'Der Staat plant und lenkt die gesamte Wirtschaft zentral'],
      ['Eigentum an Produktionsmitteln', 'Privateigentum – aber „Eigentum verpflichtet“ (Art. 14 GG)', 'Staats- bzw. Volkseigentum (z. B. VEB, LPG in der DDR)'],
      ['Wer entscheidet über die Produktion?', 'Unternehmen und Haushalte, dezentral über den Markt', 'Zentrale Planbehörde (Staatliche Plankommission), Fünfjahrespläne'],
      ['Preisbildung', 'Angebot und Nachfrage auf freien Märkten', 'Preise werden vom Staat festgesetzt'],
      ['Wettbewerb', 'Erwünscht – vom Staat geschützt (Bundeskartellamt)', 'Kaum vorhanden – Betriebe sollen das Plansoll erfüllen'],
      ['Rolle des Staates', 'Setzt den Rahmen, sichert Wettbewerb und sozialen Ausgleich (Steuern, Sozialversicherungen)', 'Lenkt alles: Produktion, Verteilung, Löhne und Preise'],
      ['Ziel der Betriebe', 'Gewinn', 'Erfüllung des Plans'],
      ['Freiheiten', 'Freie Berufswahl, Konsumfreiheit, Gewerbefreiheit', 'Eingeschränkt; Arbeitsplätze und Güter teils zugeteilt'],
      ['Soziale Sicherung', 'Sozialstaat: Renten-, Kranken-, Pflege-, Arbeitslosenversicherung, Grundsicherung', 'Recht auf Arbeit, staatlich verbilligte Grundgüter (Mieten, Brot), staatliche Versorgung'],
      ['Vorteile', 'Innovation, große Auswahl, hohe Leistungsfähigkeit, Wohlstand, Freiheit', 'Offiziell keine Arbeitslosigkeit, stabile Preise, geringe Einkommensunterschiede', '+', '+'],
      ['Nachteile / Probleme', 'Konjunkturschwankungen, Arbeitslosigkeit, Ungleichheit möglich, Umweltbelastung', 'Mangelwirtschaft, Warteschlangen, Fehlplanung, wenig Innovation, Unfreiheit', '−', '−'],
      ['Beispiele', 'Bundesrepublik Deutschland seit 1948/49', 'DDR (1949–1990), Sowjetunion; heute z. B. Nordkorea']
    ],
    common: 'Ziel: die Menschen mit Gütern und Dienstleistungen versorgen\nDer Staat spielt eine Rolle – nur unterschiedlich stark\nArbeitsteilung und Geld als Tauschmittel\nBeide sind Wirtschaftsordnungen; in der Realität gibt es Mischformen',
    result: ''
  },
  { id: 'two', name: 'Zwei Dinge vergleichen', desc: 'leere Tabelle mit 2 Spalten und 4 Kriterien', cols: [['A', '#2563eb'], ['B', '#dc2626']], rows: [['Kriterium 1'], ['Kriterium 2'], ['Kriterium 3'], ['Kriterium 4']] },
  { id: 'three', name: 'Drei Dinge vergleichen', desc: 'z. B. freie Marktwirtschaft, soziale Marktwirtschaft, Planwirtschaft', cols: [['A', '#2563eb'], ['B', '#16a34a'], ['C', '#dc2626']], rows: [['Kriterium 1'], ['Kriterium 2'], ['Kriterium 3'], ['Kriterium 4']] },
  { id: 'procon', name: 'Pro und Contra (Erörterung)', desc: 'Argumente sammeln, gewichten, Fazit ziehen', cols: [['Pro', '#16a34a'], ['Contra', '#dc2626']], rows: [['Argument 1'], ['Argument 2'], ['Argument 3']], common: '' }
];
function cmFromTemplate(t) {
  const cols = t.cols.map(([name, color], i) => ({ id: 'c' + (i + 1), name, color }));
  return {
    view: 'table', cols,
    rows: t.rows.map(([name, ...rest]) => {
      const r = { id: cmId('r'), name, cells: {}, marks: {} };
      cols.forEach((c, i) => { if (rest[i]) r.cells[c.id] = rest[i]; if (rest[cols.length + i]) r.marks[c.id] = rest[cols.length + i]; });
      return r;
    }),
    common: t.common || '', result: t.result || ''
  };
}

// ---- Notiz anlegen / öffnen ----
async function cmCreate(folder) {
  const t = await cmPickTemplate();
  if (!t) return;
  const n = newNote();
  n.kind = 'cmp';
  n.cmp = cmFromTemplate(t);
  if (t.title) n.title = t.title;
  if (folder) n.folder = folder;
  await noteDb.put(n).catch(() => {});
  showView('notes');
  await openNote(n);
}
function cmPickTemplate() {
  let dlg = cmEl('#cm-tpl');
  if (!dlg) { dlg = document.createElement('dialog'); dlg.id = 'cm-tpl'; document.body.append(dlg); }
  dlg.innerHTML = '<h3>Neuer Vergleich</h3><div class="menu-list">' +
    CM_TEMPLATES.map((t) => `<button type="button" class="menu-item km-tpl" data-t="${t.id}"><b>${kmEsc(t.name)}</b><span class="muted small-text">${kmEsc(t.desc)}</span></button>`).join('') +
    '</div><div class="dlg-actions"><button type="button" class="btn" data-close>Abbrechen</button></div>';
  return new Promise((resolve) => {
    dlg.querySelector('[data-close]').addEventListener('click', () => { dlg.close(); resolve(null); });
    dlg.querySelectorAll('[data-t]').forEach((b) => b.addEventListener('click', () => { dlg.close(); resolve(CM_TEMPLATES.find((t) => t.id === b.dataset.t)); }));
    dlg.showModal();
  });
}
function cmOpen(n) {
  if (!n.cmp) n.cmp = cmBlank();
  cm = n.cmp;
  ['cols', 'rows'].forEach((k) => { if (!Array.isArray(cm[k])) cm[k] = []; });
  cmUndo = []; cmRedo = []; cmTyping = null; cmQuiz = false; cmShown = new Set();
  cmBuild();
  cmRender();
}

// ---- Änderungen ----
const cmSnap = () => JSON.stringify(cm);
function cmChange(fn) {
  if ((typeof shRO === 'function' && shRO())) return toast('Nur zum Lesen freigegeben');
  cmUndo.push(cmSnap());
  if (cmUndo.length > 80) cmUndo.shift();
  cmRedo = [];
  fn();
  saveNote();
  cmRender();
}
function cmRestore(from, to) {
  if (!from.length) return;
  to.push(cmSnap());
  const s = JSON.parse(from.pop());
  Object.keys(cm).forEach((k) => delete cm[k]);
  Object.assign(cm, s);
  cmTyping = null;
  saveNote();
  cmRender();
}

// ---- Ansicht ----
function cmAutoGrow(t) { t.style.height = 'auto'; t.style.height = t.scrollHeight + 2 + 'px'; }
function cmRender() {
  const box = cmEl('#cm-body');
  if (!box || !cm) return;
  cmEl('#cm-undo').disabled = !cmUndo.length;
  cmEl('#cm-redo').disabled = !cmRedo.length;
  cmEl('#cm-quiz').classList.toggle('active', cmQuiz);
  cmEl('#cm-wrap').classList.toggle('quiz', cmQuiz);
  const venn = cm.view === 'venn' && cm.cols.length === 2;
  cmEl('#cm-wrap').querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('active', (b.dataset.view === 'venn') === venn));
  const hidden = (k) => cmQuiz && !cmShown.has(k);
  if (venn) {
    const [a, b] = cm.cols;
    const items = (c) => cm.rows.filter((r) => (r.cells[c.id] || '').trim()).map((r) => `<li><b>${kmEsc(r.name)}:</b> <span class="cm-q${hidden(r.id + c.id) ? ' hid' : ''}" data-reveal="${r.id + c.id}">${kmEsc(r.cells[c.id])}</span></li>`).join('');
    const common = (cm.common || '').split('\n').map((l) => l.trim()).filter(Boolean);
    box.innerHTML = '<div class="cm-venn">' +
      `<div class="cm-circle" style="--c:${a.color};left:0"></div><div class="cm-circle" style="--c:${b.color};right:0"></div>` +
      `<div class="cm-vcol"><h3 style="color:${a.color}">${kmEsc(a.name)}</h3><ul>${items(a)}</ul></div>` +
      `<div class="cm-vcol mid"><h3>Gemeinsam</h3><ul>${common.map((l, i) => `<li><span class="cm-q${hidden('common' + i) ? ' hid' : ''}" data-reveal="common${i}">${kmEsc(l)}</span></li>`).join('') || '<li class="muted">unten bei „Gemeinsamkeiten“ eintragen</li>'}</ul></div>` +
      `<div class="cm-vcol"><h3 style="color:${b.color}">${kmEsc(b.name)}</h3><ul>${items(b)}</ul></div></div>` +
      cmExtrasHtml();
  } else {
    box.innerHTML = '<div class="cm-table-wrap"><table class="cm-table"><thead><tr><th class="cm-crit">Kriterium</th>' +
      cm.cols.map((c, i) => `<th style="--c:${c.color}"><div class="cm-colhead"><input data-col="${c.id}" value="${kmEsc(c.name)}" maxlength="60" aria-label="Spaltenname"><span class="cm-colbtns">` +
        `<button type="button" class="cm-dot" data-colcolor="${c.id}" aria-label="Farbe"></button>${i > 0 ? `<button type="button" data-colleft="${c.id}" aria-label="nach links">◀</button>` : ''}${cm.cols.length > 1 ? `<button type="button" data-coldel="${c.id}" aria-label="Spalte löschen">×</button>` : ''}</span></div></th>`).join('') +
      '</tr></thead><tbody>' +
      cm.rows.map((r, ri) => `<tr><th class="cm-crit"><textarea data-row="${r.id}" rows="1" aria-label="Kriterium">${kmEsc(r.name)}</textarea><span class="cm-rowbtns">` +
        `${ri > 0 ? `<button type="button" data-rowup="${r.id}" aria-label="nach oben">▲</button>` : ''}${ri < cm.rows.length - 1 ? `<button type="button" data-rowdown="${r.id}" aria-label="nach unten">▼</button>` : ''}<button type="button" data-rowdel="${r.id}" aria-label="Kriterium löschen">×</button></span></th>` +
        cm.cols.map((c) => {
          const mk = (r.marks || {})[c.id] || '';
          return `<td style="--c:${c.color}" class="${hidden(r.id + c.id) ? 'hid' : ''}" data-reveal="${r.id + c.id}"><textarea data-cell="${r.id}|${c.id}" rows="1" placeholder="…">${kmEsc(r.cells[c.id] || '')}</textarea>` +
            `<button type="button" class="cm-mark${mk ? ' on' : ''}" data-mark="${r.id}|${c.id}" style="--m:${CM_MARKS[mk] || 'var(--muted)'}" aria-label="Bewertung">${mk || '±'}</button></td>`;
        }).join('') + '</tr>').join('') +
      '</tbody></table></div>' +
      '<div class="cm-add"><button type="button" class="btn small" data-x="addrow">＋ Kriterium</button><button type="button" class="btn small" data-x="addcol">＋ Spalte</button></div>' +
      cmExtrasHtml();
  }
  box.querySelectorAll('textarea').forEach(cmAutoGrow);
  if ((typeof shRO === 'function' && shRO())) shLock(box);
}
function cmExtrasHtml() {
  return `<div class="cm-extra"><label class="km-f"><span>Gemeinsamkeiten (eine pro Zeile)</span><textarea data-field="common" rows="3" placeholder="Was haben alle gemeinsam?">${kmEsc(cm.common || '')}</textarea></label>` +
    `<label class="km-f"><span>Fazit / eigene Bewertung</span><textarea data-field="result" rows="3" placeholder="Welches System überzeugt dich mehr – und warum?">${kmEsc(cm.result || '')}</textarea></label></div>`;
}

// ---- Eingaben ----
function cmInput(e) {
  if ((typeof shRO === 'function' && shRO())) return;
  const t = e.target, d = t.dataset;
  const key = d.cell || d.row || d.col || d.field;
  if (!key || !cm) return;
  if (t.tagName === 'TEXTAREA') cmAutoGrow(t);
  if (cmTyping !== key) { cmUndo.push(cmSnap()); cmRedo = []; cmTyping = key; cmEl('#cm-undo').disabled = false; }
  if (d.cell) { const [rid, cid] = d.cell.split('|'); cm.rows.find((r) => r.id === rid).cells[cid] = t.value; }
  else if (d.row) cm.rows.find((r) => r.id === d.row).name = t.value;
  else if (d.col) cm.cols.find((c) => c.id === d.col).name = t.value;
  else cm[d.field] = t.value;
  saveNote();
}
function cmClick(e) {
  if (cmQuiz) {
    const r = e.target.closest('[data-reveal]');
    if (r && (r.classList.contains('hid') || r.querySelector('.hid'))) { cmShown.add(r.dataset.reveal); e.preventDefault(); return cmRender(); }
  }
  const b = e.target.closest('button');
  if (!b || !cm) return;
  cmTyping = null;
  const d = b.dataset, row = (id) => cm.rows.findIndex((r) => r.id === id), col = (id) => cm.cols.findIndex((c) => c.id === id);
  if (d.view) { cm.view = d.view; if (d.view === 'venn' && cm.cols.length !== 2) toast('Die Venn-Ansicht gibt es für genau zwei Spalten'); saveNote(); return cmRender(); }
  if (d.x === 'addrow') { cmChange(() => cm.rows.push({ id: cmId('r'), name: '', cells: {}, marks: {} })); const t = cmEl('#cm-body').querySelectorAll('[data-row]'); return t[t.length - 1] && t[t.length - 1].focus(); }
  if (d.x === 'addcol') {
    if (cm.cols.length >= 5) return toast('Höchstens 5 Spalten');
    return cmChange(() => cm.cols.push({ id: cmId('c'), name: String.fromCharCode(65 + cm.cols.length), color: CM_COLORS.find((c) => !cm.cols.some((x) => x.color === c)) || CM_COLORS[0] }));
  }
  if (d.rowdel) { const r = cm.rows[row(d.rowdel)]; if (Object.values(r.cells).some((v) => (v || '').trim()) && !confirm(`Kriterium „${r.name}“ löschen?`)) return; return cmChange(() => cm.rows.splice(row(d.rowdel), 1)); }
  if (d.rowup || d.rowdown) { const i = row(d.rowup || d.rowdown), j = i + (d.rowup ? -1 : 1); return cmChange(() => { [cm.rows[i], cm.rows[j]] = [cm.rows[j], cm.rows[i]]; }); }
  if (d.coldel) { const c = cm.cols[col(d.coldel)]; if (!confirm(`Spalte „${c.name}“ mit allen Einträgen löschen?`)) return; return cmChange(() => { cm.cols.splice(col(d.coldel), 1); cm.rows.forEach((r) => { delete r.cells[c.id]; if (r.marks) delete r.marks[c.id]; }); }); }
  if (d.colleft) { const i = col(d.colleft); return cmChange(() => { [cm.cols[i - 1], cm.cols[i]] = [cm.cols[i], cm.cols[i - 1]]; }); }
  if (d.colcolor) { const c = cm.cols[col(d.colcolor)]; return cmChange(() => { c.color = CM_COLORS[(CM_COLORS.indexOf(c.color) + 1) % CM_COLORS.length]; }); }
  if (d.mark) {
    const [rid, cid] = d.mark.split('|'), r = cm.rows[row(rid)], order = Object.keys(CM_MARKS);
    return cmChange(() => { r.marks = r.marks || {}; const n = order[(order.indexOf(r.marks[cid] || '') + 1) % order.length]; if (n) r.marks[cid] = n; else delete r.marks[cid]; });
  }
}

// ---- Text / Bild ----
function cmText() {
  const out = [note.title || 'Vergleich', ''];
  for (const r of cm.rows) {
    out.push(r.name || 'Kriterium');
    cm.cols.forEach((c) => { const v = (r.cells[c.id] || '').trim(), m = (r.marks || {})[c.id]; if (v) out.push(`  ${c.name}: ${v}${m ? ` (${m})` : ''}`); });
  }
  if ((cm.common || '').trim()) out.push('', 'Gemeinsamkeiten:', ...cm.common.split('\n').filter((l) => l.trim()).map((l) => '  – ' + l.trim()));
  if ((cm.result || '').trim()) out.push('', 'Fazit: ' + cm.result.trim());
  return out.join('\n');
}
function cmImageFile() {
  const font = `15px ${KM_FONT}`, bold = `700 15px ${KM_FONT}`, pad = 32, critW = 210, colW = cm.cols.length > 3 ? 260 : 330, lh = 20;
  const W = pad * 2 + critW + colW * cm.cols.length;
  const rows = cm.rows.map((r) => {
    const name = kmWrap(r.name || '', critW - 24, bold, 20);
    const cells = cm.cols.map((c) => kmWrap((r.cells[c.id] || '').trim() || '–', colW - 48, font, 40));
    return { r, name, cells, h: Math.max(name.length, ...cells.map((x) => x.length)) * lh + 20 };
  });
  const common = (cm.common || '').split('\n').map((l) => l.trim()).filter(Boolean).flatMap((l) => kmWrap('• ' + l, W - pad * 2, font, 10));
  const result = (cm.result || '').trim() ? kmWrap(cm.result.trim(), W - pad * 2, font, 20) : [];
  const headH = 54, titleH = 50;
  const H = pad * 2 + titleH + headH + rows.reduce((s, r) => s + r.h, 0) + (common.length ? 40 + common.length * lh : 0) + (result.length ? 40 + result.length * lh : 0);
  const scale = Math.min(2, 4000 / Math.max(W, H));
  const cv = document.createElement('canvas');
  cv.width = Math.round(W * scale); cv.height = Math.round(H * scale);
  const ctx = cv.getContext('2d');
  ctx.scale(scale, scale);
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  ctx.textAlign = 'left'; ctx.fillStyle = '#1c1c1e'; ctx.font = `700 22px ${KM_FONT}`;
  ctx.fillText(note.title || 'Vergleich', pad, pad + 20);
  let y = pad + titleH;
  cm.cols.forEach((c, i) => {
    const x = pad + critW + i * colW;
    ctx.fillStyle = c.color; ctx.fillRect(x + 4, y, colW - 8, headH - 8);
    ctx.fillStyle = '#fff'; ctx.font = bold;
    kmWrap(c.name, colW - 28, bold, 2).forEach((l, j) => ctx.fillText(l, x + 16, y + 20 + j * 18));
  });
  y += headH;
  rows.forEach((row, ri) => {
    if (ri % 2 === 0) { ctx.fillStyle = '#f4f4f6'; ctx.fillRect(pad, y, W - pad * 2, row.h); }
    ctx.fillStyle = '#1c1c1e'; ctx.font = bold;
    row.name.forEach((l, j) => ctx.fillText(l, pad + 12, y + 24 + j * lh));
    cm.cols.forEach((c, i) => {
      const x = pad + critW + i * colW, m = (row.r.marks || {})[c.id];
      ctx.fillStyle = c.color; ctx.fillRect(x + 4, y + 8, 3, row.h - 16);
      ctx.fillStyle = '#1c1c1e'; ctx.font = font;
      row.cells[i].forEach((l, j) => ctx.fillText(l, x + 16, y + 24 + j * lh));
      if (m) { ctx.fillStyle = CM_MARKS[m]; ctx.font = `700 18px ${KM_FONT}`; ctx.fillText(m, x + colW - 26, y + 26); }
    });
    y += row.h;
  });
  if (common.length) {
    y += 30; ctx.fillStyle = '#1c1c1e'; ctx.font = bold; ctx.fillText('Gemeinsamkeiten', pad, y);
    ctx.font = font; common.forEach((l) => { y += lh; ctx.fillText(l, pad, y); });
  }
  if (result.length) {
    y += 30; ctx.fillStyle = '#1c1c1e'; ctx.font = bold; ctx.fillText('Fazit', pad, y);
    ctx.font = font; result.forEach((l) => { y += lh; ctx.fillText(l, pad, y); });
  }
  return dataUrlToFile(cv.toDataURL('image/png'), `${(note.title || 'Vergleich').replace(/[\\/:*?"<>|]/g, '_')}.png`);
}

// ---- Oberfläche ----
function cmBuild() {
  if (cmEl('#cm-wrap')) return;
  const wrap = document.createElement('div');
  wrap.id = 'cm-wrap';
  const ico = (d) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  wrap.innerHTML = '<div class="toolbar km-bar cm-bar">' +
    `<div class="tool-group"><button class="tool" id="cm-undo" aria-label="Rückgängig">${ico('<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 010 12h-3"/>')}</button><button class="tool" id="cm-redo" aria-label="Wiederholen">${ico('<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 000 12h3"/>')}</button></div>` +
    '<div class="tool-group"><span class="segmented small-seg"><button type="button" data-view="table">Tabelle</button><button type="button" data-view="venn">Venn</button></span></div>' +
    `<div class="tool-group"><button class="tool km-txt" id="cm-quiz" aria-label="Abfragen: Einträge verdecken">🙈 Abfragen</button></div>` +
    `<div class="tool-group"><button class="tool" id="cm-copy" aria-label="Als Text kopieren">${ico('<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 00-2-2H6a2 2 0 00-2 2v11a2 2 0 002 2h2"/>')}</button>` +
    `<button class="tool" id="cm-tonote" aria-label="Als Bild in eine Notiz einfügen">${ico('<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h5"/><path d="M15 15h5M17.5 12.5v5"/>')}</button>` +
    `<button class="tool" id="cm-export" aria-label="Als Bild teilen">${ico('<path d="M12 3v12M8 7l4-4 4 4"/><path d="M6 11H5v10h14V11h-1"/>')}</button></div></div>` +
    '<div class="cm-body" id="cm-body"></div>';
  cmEl('#view-notes').append(wrap);
  wrap.addEventListener('input', cmInput);
  wrap.addEventListener('click', cmClick);
  wrap.addEventListener('focusout', () => { cmTyping = null; });
  cmEl('#cm-undo').addEventListener('click', () => cmRestore(cmUndo, cmRedo));
  cmEl('#cm-redo').addEventListener('click', () => cmRestore(cmRedo, cmUndo));
  cmEl('#cm-quiz').addEventListener('click', () => { cmQuiz = !cmQuiz; cmShown = new Set(); cmRender(); if (cmQuiz) toast('Abfragen: Eintrag antippen = aufdecken'); });
  cmEl('#cm-copy').addEventListener('click', () => navigator.clipboard.writeText(cmText()).then(() => toast('Als Text kopiert'), () => toast('Kopieren nicht erlaubt')));
  cmEl('#cm-export').addEventListener('click', () => shareFiles([cmImageFile()], note.title || 'Vergleich'));
  cmEl('#cm-tonote').addEventListener('click', () => kmToNote(cmImageFile()));
  document.addEventListener('keydown', (e) => {
    if (!cm || !document.body.classList.contains('cmp-mode') || document.body.dataset.view !== 'notes') return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'z' && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); e.shiftKey ? cmRestore(cmRedo, cmUndo) : cmRestore(cmUndo, cmRedo); }
  });
}

// ---- Anbindung an die Notizen ----
window.addEventListener('noteopen', (e) => {
  const n = e.detail, on = n && n.kind === 'cmp';
  document.body.classList.toggle('cmp-mode', on);
  if (on) { $('#note-title').placeholder = 'Unbenannter Vergleich'; cmOpen(n); } else cm = null;
});
document.addEventListener('click', (e) => {
  if (!document.body.classList.contains('cmp-mode')) return;
  if (e.target.closest('#note-export')) { e.stopPropagation(); e.preventDefault(); $('#more-dialog').close(); shareFiles([cmImageFile()], note.title || 'Vergleich'); }
}, true);
$('#notes-dialog-cmp').addEventListener('click', () => { $('#notes-dialog').close(); cmCreate(folderFilter !== 'all' ? folderFilter : undefined); });
$('#note-new-cmp').addEventListener('click', () => { $('#more-dialog').close(); cmCreate(note && note.folder); });
if (typeof note !== 'undefined' && note && note.kind === 'cmp' && !cm) window.dispatchEvent(new CustomEvent('noteopen', { detail: note }));
