// ---------- Video-Player (WebM & Co.) ----------
// Das iPad zeigt .webm-Dateien in der Dateien-App nicht an. Orbit spielt sie ab:
// zuerst mit dem eingebauten Player des Browsers; kann der das Format nicht, lädt Orbit einmalig
// den Decoder ogv.js (VP8/VP9, Opus/Vorbis) aus dem Netz – danach geht es auch offline (sw.js).
// Extras: Tempo, ±10 s, Schleife, Vollbild, Standbild in eine Notiz, Weiterschauen ab der letzten Stelle.

const VP_OGV = 'https://cdn.jsdelivr.net/npm/ogv@1.8.9/dist/';
const VP_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
let vp = null;          // { el, file, url, kind: 'native'|'ogv', key }
let vpLoop = false;

const vpEl = (s) => document.querySelector(s);
const vpTime = (t) => { if (!isFinite(t)) return '–:––'; t = Math.max(0, Math.floor(t)); const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0'); };
const vpKey = (f) => `vpPos:${f.name}:${f.size}`;

// ---- Datei öffnen ----
async function vpOpen(file) {
  if (!file) return;
  vpClose();
  const url = URL.createObjectURL(file);
  vp = { file, url, key: vpKey(file), kind: 'native' };
  vpEl('#vp-name').textContent = file.name;
  vpEl('#vp-empty').hidden = true;
  vpEl('#vp-player').hidden = false;
  vpStatus('Wird geladen …');
  const v = document.createElement('video');
  v.playsInline = true;
  v.preload = 'metadata';
  v.className = 'vp-video';
  const native = !/\.webm$/i.test(file.name) || v.canPlayType('video/webm; codecs="vp9, opus"') || v.canPlayType('video/webm; codecs="vp8, vorbis"') || v.canPlayType('video/webm');
  if (!native) return vpOgv();
  let settled = false;
  v.addEventListener('loadedmetadata', () => {
    settled = true;
    // nur Ton, kein Bild bei einer WebM-Datei mit Video? → Decoder fehlt, ogv versuchen
    if (/\.webm$/i.test(file.name) && !v.videoWidth && file.type.startsWith('video')) { vpStatus('Bild wird nicht unterstützt – lade Decoder …'); return vpOgv(); }
    // Aufgenommene WebM-Dateien (Bildschirm, Kamera) kennen oft ihre Länge nicht (Infinity) –
    // kurz ganz ans Ende springen, dann rechnet der Browser sie aus
    if (!isFinite(v.duration)) {
      vpStatus('Länge wird ermittelt …');
      v.addEventListener('timeupdate', () => { v.currentTime = 0; vpReady(); }, { once: true });
      v.currentTime = 1e101;
      return;
    }
    vpReady();
  }, { once: true });
  v.addEventListener('error', () => { if (!settled && vp && vp.el === v) vpOgv(); }, { once: true });
  vp.el = v;
  vpEl('#vp-stage').replaceChildren(v);
  vpBind(v);
  v.src = url;
}

// ---- Rückfall: ogv.js ----
function vpLoadScript(src) {
  return new Promise((ok, fail) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => fail(new Error('Laden fehlgeschlagen')); document.head.append(s); });
}
async function vpOgv() {
  if (!vp) return;
  vpStatus('WebM-Decoder wird geladen … (beim ersten Mal Internet nötig)');
  try {
    if (typeof OGVPlayer === 'undefined') await vpLoadScript(VP_OGV + 'ogv.js');
    OGVLoader.base = VP_OGV.replace(/\/$/, '');
    const p = new OGVPlayer({ worker: false });      // ohne Worker: klappt auch mit dem Decoder aus dem Netz
    p.className = 'vp-video vp-ogv';
    vp.kind = 'ogv';
    vp.el = p;
    vpEl('#vp-stage').replaceChildren(p);
    vpBind(p);
    p.addEventListener('loadedmetadata', vpReady, { once: true });
    p.addEventListener('error', () => vpStatus('Diese Datei kann nicht abgespielt werden.'), { once: true });
    p.src = vp.url;
    p.load && p.load();
  } catch {
    vpStatus('Dieses Gerät kann WebM nicht selbst abspielen, und der Decoder konnte nicht geladen werden. Einmal mit Internet öffnen.');
  }
}

function vpReady() {
  if (!vp) return;
  const v = vp.el;
  vpStatus('');
  v.playbackRate = Number(store.get('vpSpeed', 1)) || 1;
  v.loop = vpLoop;
  // weiterschauen, wo man aufgehört hat
  const pos = store.get(vp.key, 0);
  if (pos > 5 && isFinite(v.duration) && pos < v.duration - 5) {
    v.currentTime = pos;
    toast(`Weiter bei ${vpTime(pos)} – ⏮ springt an den Anfang`);
  }
  vpEl('#vp-info').textContent = [v.videoWidth ? `${v.videoWidth}×${v.videoHeight}` : 'nur Ton', vpTime(v.duration), vp.kind === 'ogv' ? 'Decoder: ogv.js' : '', `${(vp.file.size / 1048576).toFixed(1)} MB`].filter(Boolean).join(' · ');
  vpUi();
}

function vpBind(v) {
  ['timeupdate', 'play', 'pause', 'ended', 'durationchange', 'ratechange', 'volumechange'].forEach((t) => v.addEventListener(t, vpUi));
  v.addEventListener('timeupdate', () => { if (vp && v.currentTime > 0) store.set(vp.key, Math.floor(v.currentTime)); });
  v.addEventListener('ended', () => { if (vp) store.set(vp.key, 0); });
  v.addEventListener('click', vpToggle);
}

function vpClose() {
  if (!vp) return;
  try { vp.el && vp.el.pause && vp.el.pause(); } catch {}
  if (vp.el && vp.kind === 'ogv' && vp.el.stop) try { vp.el.stop(); } catch {}
  URL.revokeObjectURL(vp.url);
  vpEl('#vp-stage').replaceChildren();
  vp = null;
}

// ---- Bedienung ----
function vpStatus(t) { const s = vpEl('#vp-status'); s.textContent = t; s.hidden = !t; }
function vpToggle() { const v = vp && vp.el; if (!v) return; if (v.paused) v.play().catch(() => {}); else v.pause(); }
function vpSeek(d) { const v = vp && vp.el; if (!v) return; v.currentTime = Math.max(0, Math.min((v.duration || 0) - 0.1, v.currentTime + d)); vpUi(); }
function vpUi() {
  const v = vp && vp.el;
  if (!v) return;
  vpEl('#vp-play').textContent = v.paused ? '▶' : '❚❚';
  vpEl('#vp-play').setAttribute('aria-label', v.paused ? 'Abspielen' : 'Pause');
  vpEl('#vp-cur').textContent = vpTime(v.currentTime);
  vpEl('#vp-dur').textContent = vpTime(v.duration);
  const bar = vpEl('#vp-bar');
  if (!bar.dragging) bar.value = isFinite(v.duration) && v.duration ? Math.round((v.currentTime / v.duration) * 1000) : 0;
  vpEl('#vp-speed').textContent = (v.playbackRate || 1).toString().replace('.', ',') + '×';
  vpEl('#vp-loop').classList.toggle('active', vpLoop);
  vpEl('#vp-mute').textContent = v.muted || v.volume === 0 ? '🔇' : '🔊';
}
// Standbild (aktuelles Bild) → Bilddatei
function vpFrame() {
  const v = vp && vp.el;
  if (!v) return null;
  const src = vp.kind === 'ogv' ? v.querySelector('canvas') : v;
  const w = vp.kind === 'ogv' ? src && src.width : v.videoWidth, h = vp.kind === 'ogv' ? src && src.height : v.videoHeight;
  if (!src || !w || !h) { toast('Kein Bild zum Festhalten'); return null; }
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(src, 0, 0, w, h);
  const name = vp.file.name.replace(/\.[^.]+$/, '') + ` ${vpTime(v.currentTime).replace(/:/g, '-')}.png`;
  return dataUrlToFile(c.toDataURL('image/png'), name);
}

// ---- Oberfläche ----
(function vpInit() {
  const box = vpEl('#view-video');
  if (!box) return;
  const input = vpEl('#vp-file');
  const pick = () => input.click();
  vpEl('#vp-open').addEventListener('click', pick);
  vpEl('#vp-open2').addEventListener('click', pick);
  input.addEventListener('change', () => { const f = input.files[0]; input.value = ''; if (f) vpOpen(f); });
  // Surface: Datei aufs Fenster ziehen
  box.addEventListener('dragover', (e) => { e.preventDefault(); box.classList.add('drop'); });
  box.addEventListener('dragleave', () => box.classList.remove('drop'));
  box.addEventListener('drop', (e) => { e.preventDefault(); box.classList.remove('drop'); const f = [...e.dataTransfer.files].find((x) => /^video\/|^audio\/|\.(webm|mkv|mp4|m4v|mov|ogv|ogg)$/i.test(x.type + ' ' + x.name)); if (f) vpOpen(f); });
  vpEl('#vp-play').addEventListener('click', vpToggle);
  vpEl('#vp-back').addEventListener('click', () => vpSeek(-10));
  vpEl('#vp-fwd').addEventListener('click', () => vpSeek(10));
  vpEl('#vp-start').addEventListener('click', () => { if (vp && vp.el) { vp.el.currentTime = 0; vpUi(); } });
  const bar = vpEl('#vp-bar');
  bar.addEventListener('input', () => { bar.dragging = true; const v = vp && vp.el; if (v && isFinite(v.duration)) { v.currentTime = (bar.value / 1000) * v.duration; vpEl('#vp-cur').textContent = vpTime(v.currentTime); } });
  bar.addEventListener('change', () => { bar.dragging = false; });
  vpEl('#vp-speed').addEventListener('click', () => {
    const v = vp && vp.el;
    if (!v) return;
    const i = VP_SPEEDS.indexOf(v.playbackRate), next = VP_SPEEDS[(i + 1) % VP_SPEEDS.length] || 1;
    v.playbackRate = next;
    store.set('vpSpeed', next);
    vpUi();
  });
  vpEl('#vp-loop').addEventListener('click', () => { vpLoop = !vpLoop; if (vp && vp.el) vp.el.loop = vpLoop; vpUi(); });
  vpEl('#vp-mute').addEventListener('click', () => { const v = vp && vp.el; if (v) { v.muted = !v.muted; vpUi(); } });
  vpEl('#vp-full').addEventListener('click', () => {
    const v = vp && vp.el, st = vpEl('#vp-stage');
    if (!v) return;
    if (v.webkitEnterFullscreen && vp.kind === 'native' && !document.fullscreenEnabled) return v.webkitEnterFullscreen();   // iPhone
    const el = st.requestFullscreen ? st : v;
    (el.requestFullscreen || el.webkitRequestFullscreen || (() => {})).call(el);
  });
  vpEl('#vp-snap').addEventListener('click', () => { const f = vpFrame(); if (f) { if (vp.el.pause) vp.el.pause(); kmToNote(f); } });
  vpEl('#vp-snapsave').addEventListener('click', () => { const f = vpFrame(); if (f) shareFiles([f], f.name); });
  vpEl('#vp-close').addEventListener('click', () => { vpClose(); vpEl('#vp-player').hidden = true; vpEl('#vp-empty').hidden = false; vpEl('#vp-name').textContent = ''; });
  // Tastatur (Surface): Leertaste, ←/→, F
  document.addEventListener('keydown', (e) => {
    if (document.body.dataset.view !== 'video' || !vp || /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) && document.activeElement.type !== 'range') return;
    if (e.key === ' ' || e.key === 'k') { e.preventDefault(); vpToggle(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); vpSeek(-5); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); vpSeek(5); }
    else if (e.key === 'f') vpEl('#vp-full').click();
  });
  // Ansicht verlassen: anhalten
  window.addEventListener('viewchange', (e) => { if (e.detail !== 'video' && vp && vp.el && !vp.el.paused) vp.el.pause(); });
})();
