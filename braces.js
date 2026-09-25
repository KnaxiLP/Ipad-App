// ================= Klammern zum Kopieren (z. B. für Goodnotes) =================
// Erzeugt geschweifte Klammern als PNG mit durchsichtigem Hintergrund.
// Die Länge wird direkt beim Zeichnen gesetzt – so bleibt die Strichdicke gleich
// und die Klammer wird beim Einfügen nicht verzerrt.

const BRACE_COLORS = ['#1c1c1e', '#2563eb', '#dc2626', '#16a34a', '#9333ea', '#ea580c'];
const BRACE_WIDTHS = { 1: 4, 2: 7, 3: 11 };
const BRACE_SCALE = 2; // doppelte Auflösung, damit es auch vergrößert scharf bleibt

const braceState = Object.assign(
  { dir: 'down', length: 500, width: 2, color: 0 },
  store.get('brace', {})
);

// Klammer in lokalen Koordinaten: x entlang der Klammer (0…L), y Richtung Spitze (0…h)
function braceShape(L, w) {
  const r = Math.max(10, Math.min(L * 0.07, 22 + w)); // Rundung der Bögen
  const q = Math.min(r, L / 4);
  const pts = [];
  const quad = (x0, y0, cx, cy, x1, y1) => {
    for (let i = 1; i <= 16; i++) {
      const t = i / 16, m = 1 - t;
      pts.push([m * m * x0 + 2 * m * t * cx + t * t * x1, m * m * y0 + 2 * m * t * cy + t * t * y1]);
    }
  };
  pts.push([0, 0]);
  quad(0, 0, 0, r, q, r);
  pts.push([L / 2 - q, r]);
  quad(L / 2 - q, r, L / 2, r, L / 2, 2 * r);
  quad(L / 2, 2 * r, L / 2, r, L / 2 + q, r);
  pts.push([L - q, r]);
  quad(L - q, r, L, r, L, 0);
  return { pts, h: 2 * r };
}

function renderBrace({ dir, length, width, color, colorValue }) {
  const w = BRACE_WIDTHS[width];
  const { pts, h } = braceShape(length, w);
  const pad = w;
  const vertical = dir === 'left' || dir === 'right';
  const cw = (vertical ? h : length) + pad * 2;
  const ch = (vertical ? length : h) + pad * 2;

  // lokale Koordinaten je nach Richtung auf das Bild abbilden
  const map = {
    down: ([x, y]) => [x, y],          // ︸ öffnet nach oben
    up: ([x, y]) => [x, h - y],        // ︷ öffnet nach unten
    left: ([x, y]) => [h - y, x],      // {
    right: ([x, y]) => [y, x]          // }
  }[dir];

  const c = document.createElement('canvas');
  c.width = Math.ceil(cw * BRACE_SCALE);
  c.height = Math.ceil(ch * BRACE_SCALE);
  const ctx = c.getContext('2d');
  ctx.scale(BRACE_SCALE, BRACE_SCALE);
  ctx.translate(pad, pad);
  ctx.strokeStyle = colorValue || BRACE_COLORS[color];
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Wie mit dem Stift gezogen: an den Enden dünner, zur Spitze hin kräftiger
  const n = pts.length;
  for (let i = 1; i < n; i++) {
    const t = i / (n - 1);
    ctx.lineWidth = w * (0.55 + 0.45 * Math.sin(Math.PI * t));
    const [x0, y0] = map(pts[i - 1]);
    const [x1, y1] = map(pts[i]);
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }
  return c;
}

// ---------- Oberfläche ----------
let braceCanvas = null;

function updateBrace() {
  store.set('brace', braceState);
  document.querySelectorAll('#brace-dir button').forEach((b) => b.classList.toggle('active', b.dataset.dir === braceState.dir));
  document.querySelectorAll('#brace-width button').forEach((b) => b.classList.toggle('active', Number(b.dataset.width) === braceState.width));
  document.querySelectorAll('#brace-colors button').forEach((b, i) => b.classList.toggle('active', i === braceState.color));
  $('#brace-length').value = braceState.length;
  $('#brace-length-text').textContent = braceState.length < 300 ? 'kurz' : braceState.length < 700 ? 'mittel' : braceState.length < 1100 ? 'lang' : 'sehr lang';

  braceCanvas = renderBrace(braceState);
  const img = $('#brace-preview');
  img.src = braceCanvas.toDataURL('image/png');
  const vertical = braceState.dir === 'left' || braceState.dir === 'right';
  $('#brace-stage').classList.toggle('vertical', vertical);
}

document.querySelectorAll('#brace-dir button').forEach((b) => {
  // kleine gezeichnete Klammer als Symbol auf dem Knopf
  const icon = document.createElement('img');
  icon.className = 'brace-icon';
  icon.alt = '';
  icon.src = renderBrace({ dir: b.dataset.dir, length: 90, width: 3, colorValue: getComputedStyle(b).color }).toDataURL();
  b.prepend(icon);
  b.addEventListener('click', () => { braceState.dir = b.dataset.dir; updateBrace(); });
});
document.querySelectorAll('#brace-width button').forEach((b) =>
  b.addEventListener('click', () => { braceState.width = Number(b.dataset.width); updateBrace(); })
);
BRACE_COLORS.forEach((c, i) => {
  const b = document.createElement('button');
  b.className = 'tool swatch';
  b.style.setProperty('--c', c);
  b.setAttribute('aria-label', 'Farbe ' + (i + 1));
  b.addEventListener('click', () => { braceState.color = i; updateBrace(); });
  $('#brace-colors').append(b);
});
$('#brace-length').addEventListener('input', (e) => { braceState.length = Number(e.target.value); updateBrace(); });

async function copyBrace() {
  if (!braceCanvas) return;
  try {
    if (!navigator.clipboard || !window.ClipboardItem) throw new Error('no clipboard');
    // Safari möchte das Bild als Promise – so zählt es noch als Tipp des Nutzers
    const blob = new Promise((resolve) => braceCanvas.toBlob(resolve, 'image/png'));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    toast('📋 Kopiert! In Goodnotes tippen → Einfügen');
    const btn = $('#brace-copy');
    btn.textContent = '✅ Kopiert';
    clearTimeout(btn._t);
    btn._t = setTimeout(() => { btn.textContent = '📋 Kopieren'; }, 1500);
  } catch {
    toast('Lange auf die Klammer drücken → „Kopieren“');
  }
}

$('#brace-copy').addEventListener('click', copyBrace);

updateBrace();
