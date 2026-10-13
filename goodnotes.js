// ---------- Goodnotes-Import (.goodnotes) ----------
// Eine .goodnotes-Datei ist ein ZIP-Archiv:
//   index.events.pb   Dokument, Seiten (Größe, PDF-Hintergrund) und Ebenen
//   notes/<id>        Striche und Formen einer Ebene (Protobuf, Punktdaten LZ4-gepackt)
//   attachments/<id>  PDFs, die als Seitenhintergrund dienen
// Das Format ist nicht offen dokumentiert. Übernommen werden Seiten, Hintergründe, Striche
// (Farbe, Dicke, Druck) und Linien-Formen; Unbekanntes wird übersprungen.

// ZIP lesen (zentrales Verzeichnis, „deflate“ über DecompressionStream)
async function gnUnzip(buf) {
  const b = new Uint8Array(buf), dv = new DataView(buf);
  let e = b.length - 22;
  while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error('Kein ZIP-Archiv');
  const n = dv.getUint16(e + 10, true);
  let p = dv.getUint32(e + 16, true);
  const files = {}, dec = new TextDecoder();
  for (let i = 0; i < n; i++) {
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
    const off = dv.getUint32(p + 42, true), name = dec.decode(b.subarray(p + 46, p + 46 + nl));
    p += 46 + nl + xl + cl;
    const start = off + 30 + dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true);
    files[name] = { method, data: b.subarray(start, start + csize) };
  }
  return async (name) => {
    const f = files[name];
    if (!f) return null;
    if (f.method === 0) return f.data;
    const s = new Blob([f.data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(s).arrayBuffer());
  };
}

// Protobuf: Nachricht → { feld: [werte] } (Zahlen, Bytes; float/double als DataView-Lesen bei Bedarf)
function gnVarint(b, s) {
  let r = 0, m = 1, c;
  do { c = b[s.i++]; r += (c & 0x7f) * m; m *= 128; } while (c >= 0x80);
  return r;
}
function gnMsg(b) {
  const out = {}, s = { i: 0 };
  while (s.i < b.length) {
    const k = gnVarint(b, s), f = Math.floor(k / 8), w = k & 7;
    let v;
    if (w === 0) v = gnVarint(b, s);
    else if (w === 1) { v = b.subarray(s.i, s.i + 8); s.i += 8; }
    else if (w === 2) { const n = gnVarint(b, s); v = b.subarray(s.i, s.i + n); s.i += n; }
    else if (w === 5) { v = b.subarray(s.i, s.i + 4); s.i += 4; }
    else break;
    (out[f] || (out[f] = [])).push(v);
  }
  return out;
}
// Datei aus Nachrichten mit vorangestellter Länge
function gnRecords(b) {
  const out = [], s = { i: 0 };
  while (s.i < b.length) { const n = gnVarint(b, s); out.push(b.subarray(s.i, s.i + n)); s.i += n; }
  return out;
}
const gnStr = (v) => (v ? new TextDecoder().decode(v) : '');
const gnF32 = (v) => (v ? new DataView(v.buffer, v.byteOffset, 4).getFloat32(0, true) : 0);
const gnSub = (m, f) => (m[f] ? gnMsg(m[f][0]) : {});

// Apples LZ4-Container: Blöcke „bv41“ (gepackt), „bv4-“ (roh), Ende „bv4$“
function gnLz4(src, size) {
  const dst = new Uint8Array(size);
  let i = 0, o = 0;
  while (i < src.length && o < size) {
    const t = src[i++];
    let l = t >> 4;
    if (l === 15) { let c; do { c = src[i++]; l += c; } while (c === 255); }
    dst.set(src.subarray(i, i + l), o); i += l; o += l;
    if (i >= src.length || o >= size) break;
    const off = src[i] | (src[i + 1] << 8); i += 2;
    let m = t & 15;
    if (m === 15) { let c; do { c = src[i++]; m += c; } while (c === 255); }
    m += 4;
    for (let k = 0; k < m; k++, o++) dst[o] = dst[o - off];
  }
  return dst;
}
function gnBv4(b) {
  const parts = [], dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let i = 0;
  while (i + 4 <= b.length) {
    const tag = String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);
    if (tag === 'bv41') {
      const raw = dv.getUint32(i + 4, true), comp = dv.getUint32(i + 8, true);
      parts.push(gnLz4(b.subarray(i + 12, i + 12 + comp), raw)); i += 12 + comp;
    } else if (tag === 'bv4-') {
      const raw = dv.getUint32(i + 4, true);
      parts.push(b.subarray(i + 8, i + 8 + raw)); i += 8 + raw;
    } else break;
  }
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// Typisierte Punktdaten „tpl“: Signatur wie „vA(v)A(u)…“, v = uint16, u = float32, A(x) = Anzahl + Werte
function gnTpl(b) {
  if (b.length < 9 || b[0] !== 0x74 || b[1] !== 0x70 || b[2] !== 0x6c) return null;
  let j = 8;
  while (j < b.length && b[j]) j++;
  const sig = String.fromCharCode(...b.subarray(8, j));
  if (!/^[vuA()]*$/.test(sig)) return { sig, out: null };      // andere Elemente (z. B. Formen)
  const dv = new DataView(b.buffer, b.byteOffset + j + 1, b.length - j - 1), out = [];
  let i = 0;
  for (const t of sig.match(/A\(.\)|./g)) {
    if (t === 'v') { out.push(dv.getUint16(i, true)); i += 2; }
    else if (t === 'u') { out.push(dv.getFloat32(i, true)); i += 4; }
    else {
      const n = dv.getUint32(i, true), a = [], sz = t[2] === 'v' ? 2 : 4;
      i += 4;
      for (let k = 0; k < n; k++, i += sz) a.push(sz === 2 ? dv.getUint16(i, true) : dv.getFloat32(i, true));
      out.push(a);
    }
  }
  return { sig, out };
}

function gnColor(m) {
  // Felder 1–4 = Rot, Grün, Blau, Deckkraft (0 fehlt im Protobuf → Standard 0)
  const c = [1, 2, 3, 4].map((f) => gnF32(m[f] && m[f][0]));
  const hex = '#' + c.slice(0, 3).map((x) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, '0')).join('');
  return { hex, alpha: c[3] };
}

// Abstand Punkt → Strecke
function gnSegDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

// Ein Element (Strich oder Form) in Goodnotes-Koordinaten
function gnElement(q) {
  const col = gnColor(gnSub(q, 4));
  const raw = q[2] ? gnBv4(q[2][0]) : null, t = raw && gnTpl(raw);
  if (t && t.out && t.out.length >= 9) {
    // Mittellinie: Startpunkt (x, y, Druck) + weitere Punkte; Umriss als Punktpaare
    const pts = [];
    const first = t.out[2], rest = t.out[3], ol = t.out[8];
    if (Array.isArray(first) && first.length >= 3) pts.push([first[0], first[1], first[2]]);
    if (Array.isArray(rest)) for (let k = 0; k + 2 < rest.length; k += 3) pts.push([rest[k], rest[k + 1], rest[k + 2]]);
    if (!pts.length) return null;            // gelöscht
    // Dicke: typischer Abstand des Umrisses zur Mittellinie
    let width = 1.6;
    if (Array.isArray(ol) && ol.length >= 4) {
      const ds = [];
      for (let k = 0; k + 1 < ol.length; k += 2) {
        let d = Infinity;
        if (pts.length === 1) d = Math.hypot(ol[k] - pts[0][0], ol[k + 1] - pts[0][1]);
        for (let s = 0; s + 1 < pts.length; s++) d = Math.min(d, gnSegDist(ol[k], ol[k + 1], pts[s][0], pts[s][1], pts[s + 1][0], pts[s + 1][1]));
        ds.push(d);
      }
      ds.sort((a, b) => a - b);
      width = Math.max(0.3, 2 * ds[Math.floor(ds.length / 2)]);
    }
    return { kind: 'stroke', pts, width, color: col.hex, alpha: col.alpha };
  }
  // Form (Linie, Pfeil, Vieleck): Punkte in Feld 9, Dicke in 9.15
  const sh = gnSub(q, 9), list = gnSub(sh, 1)[1] || [];
  if (list.length >= 2) {
    const pts = list.map((v) => { const p = gnMsg(v); return [gnF32(p[1] && p[1][0]), gnF32(p[2] && p[2][0]), 0.5]; });
    const width = (sh[15] && gnF32(sh[15][0])) || 1.6;
    return { kind: 'shape', pts, width, color: col.hex, alpha: col.alpha };
  }
  return { kind: 'unknown' };
}

// Ebene einlesen: letzte Fassung je Element, gelöschte übersprungen
function gnLayer(b) {
  const els = new Map();
  for (const r of gnRecords(b)) {
    const m = gnMsg(r);
    if (!m[7]) continue;
    const q = gnMsg(m[7][0]), id = gnStr(q[1] && q[1][0]);
    try { els.set(id, gnElement(q)); } catch { els.set(id, { kind: 'unknown' }); }
  }
  return [...els.values()].filter(Boolean);
}

// PDF-Seite als Hintergrund (Seite `n`, ab 1)
async function gnPdfBg(lib, cache, data, n) {
  let pdf = cache.get(data);
  if (!pdf) { pdf = await lib.getDocument({ data: data.slice() }).promise; cache.set(data, pdf); }
  const page = await pdf.getPage(Math.max(1, Math.min(pdf.numPages, n || 1)));
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: IMPORT_WIDTH / base.width });
  const c = document.createElement('canvas');
  c.width = Math.round(viewport.width);
  c.height = Math.round(viewport.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvasToBg(c);
}

// letzte Hex-Stelle der ID als Zahl: die Strich-Datei einer Ebene hat meist die Ebenen-ID + 1
const gnIdNum = (id) => parseInt(id.replace(/-/g, '').slice(-12), 16);

async function readGoodnotes(file, maxPages) {
  if (typeof DecompressionStream === 'undefined') throw new Error('Dieser Browser kann keine ZIP-Dateien entpacken (iPadOS 16.4 oder neuer nötig)');
  toast('Goodnotes-Datei wird gelesen …');
  const get = await gnUnzip(await file.arrayBuffer());
  const ev = await get('index.events.pb');
  if (!ev) throw new Error('Keine Goodnotes-Datei');
  let title = '';
  const pages = new Map(), layers = new Map(), order = [];
  for (const r of gnRecords(ev)) {
    const m = gnMsg(r);
    if (m[30]) { const d = gnMsg(m[30][0]); title = gnStr(gnSub(d, 2)[1] && gnSub(d, 2)[1][0]) || title; }
    if (m[2]) {
      const p = gnMsg(m[2][0]), id = gnStr(p[2] && p[2][0]), sz = gnSub(p, 8);
      if (!pages.has(id)) order.push(id);
      pages.set(id, { id, att: gnStr(p[4] && p[4][0]), attPage: p[5] ? p[5][0] : 1, w: gnF32(sz[1] && sz[1][0]) || 595, h: gnF32(sz[2] && sz[2][0]) || 842 });
    }
    if (m[54]) {
      const l = gnMsg(m[54][0]), lid = gnStr(l[2] && l[2][0]), pg = gnStr(gnSub(l, 3)[1] && gnSub(l, 3)[1][0]);
      if (lid && pg) layers.set(lid, pg);
    }
  }
  // Strich-Dateien den Seiten zuordnen
  const noteFiles = gnRecords((await get('index.notes.pb')) || new Uint8Array()).map((r) => { const m = gnMsg(r); return { id: gnStr(m[1] && m[1][0]), path: gnStr(m[2] && m[2][0]) }; });
  const byPage = new Map();
  noteFiles.forEach((nf, k) => {
    let pg = layers.get(nf.id);
    if (!pg) for (const [lid, p] of layers) if (lid.slice(0, 24) === nf.id.slice(0, 24) && gnIdNum(nf.id) - gnIdNum(lid) === 1) pg = p;
    if (!pg) pg = order.length === 1 ? order[0] : order[k];
    if (pg) (byPage.get(pg) || byPage.set(pg, []).get(pg)).push(nf.path);
  });
  const ids = order.slice(0, maxPages);
  const out = [];
  let skipped = 0, lib = null;
  const pdfCache = new Map(), attData = new Map();
  for (let n = 0; n < ids.length; n++) {
    const pg = pages.get(ids[n]);
    toast(`Seite ${n + 1} von ${ids.length} …`);
    const fit = placeOnPage(pg.w, pg.h), k = fit.width / pg.w;
    const page = { strokes: [] };
    if (pg.att) {
      if (!attData.has(pg.att)) attData.set(pg.att, await get('attachments/' + pg.att));
      const data = attData.get(pg.att);
      if (data && String.fromCharCode(...data.subarray(0, 4)) === '%PDF') {
        if (!lib) {
          try { lib = await pdfLib(); } catch { throw new Error('Für den PDF-Hintergrund braucht der Import beim ersten Mal Internet'); }
        }
        page.bg = await gnPdfBg(lib, pdfCache, data, pg.attPage);
        Object.assign(page.bg, fit);
      }
    }
    for (const path of byPage.get(pg.id) || []) {
      const b = await get(path);
      if (!b) continue;
      for (const el of gnLayer(b)) {
        if (el.kind === 'unknown') { skipped++; continue; }
        const marker = el.alpha < 0.95;
        const w = el.width * k;
        const pts = [];
        for (const [x, y, p] of el.pts) pts.push(Math.round((fit.x + x * k) * 10) / 10, Math.round((fit.y + y * k) * 10) / 10, Math.round(Math.max(0, Math.min(1, p)) * 100) / 100);
        page.strokes.push(marker
          ? { tool: 'marker', color: el.color, size: Math.max(0.2, w / BASE_WIDTH.marker), pts }
          : { tool: 'pen', style: 'ball', color: el.color, size: Math.max(0.3, w / BASE_WIDTH.pen), pts, ...(el.kind === 'shape' ? { shape: true } : {}) });
      }
    }
    out.push(page);
  }
  return { pages: out, total: order.length, title, skipped };
}

async function importGoodnotes(file, asNote) {
  const room = asNote || isEmpty(note) ? MAX_PAGES : MAX_PAGES - note.pages.length;
  if (room <= 0) return toast('Diese Notiz hat schon die maximale Seitenzahl');
  const r = await readGoodnotes(file, room);
  if (!r.pages.length) return toast('Keine Seiten gefunden');
  const title = r.title || file.name.replace(/\.goodnotes$/i, '');
  if (asNote) {
    const n = newNote();
    n.title = title.slice(0, 40);
    n.paper = 'blank';
    n.folder = note && note.folder;
    n.pages = r.pages;
    await noteDb.put(n);
    await openNote(n);
  } else {
    if (isEmpty(note)) { note.paper = 'blank'; }
    insertPages(r.pages, title);
  }
  toast(pagesMsg(r.pages.length, r.total) + (r.skipped ? ` · ${r.skipped} Elemente (z. B. Text, Bilder) nicht übernommen` : ''));
}
