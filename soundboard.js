// ================= Soundboard =================
const CFG = window.APP_CONFIG || {};
const COMMUNITY = Boolean(CFG.supabaseUrl && CFG.supabaseKey);
const MAX_BYTES = 1024 * 1024; // 1 MB
const MAX_SECONDS = 15;
const REC_SECONDS = 10;

// iOS: Töne auch abspielen, wenn der Stummschalter an ist (iOS 17+).
// Achtung: Im Modus "playback" blockiert iOS das Mikrofon – vor dem Aufnehmen umschalten.
function setAudioSession(type) {
  try { if (navigator.audioSession) navigator.audioSession.type = type; } catch {}
}
setAudioSession('playback');

// ---------- Web-Audio-Synthesizer für die Klassiker ----------
let ctx, master, noiseBuf;

function ac() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function out() {
  if (!master) {
    master = ac().createGain();
    master.gain.value = 0.8;
    master.connect(ctx.destination);
  }
  return master;
}

function envelope(g, t, { vol, attack, dur, sustain }) {
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vol, t + attack);
  if (sustain) {
    g.gain.setValueAtTime(vol, t + dur - 0.05);
    g.gain.linearRampToValueAtTime(0, t + dur);
  } else {
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  }
}

function tone({ type = 'sine', freq, endFreq, start = 0, dur, vol = 0.3, attack = 0.01, sustain = false, vibrato }) {
  const c = ac(), t = c.currentTime + start;
  const o = c.createOscillator(), g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (endFreq) o.frequency.exponentialRampToValueAtTime(endFreq, t + dur);
  if (vibrato) {
    const lfo = c.createOscillator(), depth = c.createGain();
    lfo.frequency.value = vibrato.rate;
    depth.gain.value = vibrato.depth;
    lfo.connect(depth).connect(o.frequency);
    lfo.start(t);
    lfo.stop(t + dur);
  }
  envelope(g, t, { vol, attack, dur, sustain });
  o.connect(g).connect(out());
  o.start(t);
  o.stop(t + dur + 0.05);
}

function noise({ start = 0, dur, vol = 0.3, attack = 0.002, filter, freq = 1000, q = 1 }) {
  const c = ac(), t = c.currentTime + start;
  if (!noiseBuf) {
    noiseBuf = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const s = c.createBufferSource(), g = c.createGain();
  s.buffer = noiseBuf;
  s.loop = true;
  let node = s;
  if (filter) {
    const f = c.createBiquadFilter();
    f.type = filter;
    f.frequency.value = freq;
    f.Q.value = q;
    s.connect(f);
    node = f;
  }
  envelope(g, t, { vol, attack, dur });
  node.connect(g).connect(out());
  s.start(t, Math.random());
  s.stop(t + dur + 0.05);
}

const BUILTIN = [
  { emoji: '🥁', name: 'Trommelwirbel', dur: 3.3, play() {
    for (let i = 0; i < 42; i++) noise({ start: i * 0.045, dur: 0.06, vol: 0.12 + i * 0.005, filter: 'bandpass', freq: 1800, q: 0.8 });
    tone({ freq: 120, endFreq: 45, start: 1.9, dur: 0.35, vol: 0.9 });
    noise({ start: 1.9, dur: 1.4, vol: 0.45, filter: 'highpass', freq: 5000 });
  } },
  { emoji: '📯', name: 'Fail', dur: 3, play() {
    [293.66, 277.18, 261.63].forEach((f, i) => tone({ type: 'sawtooth', freq: f, start: i * 0.5, dur: 0.45, vol: 0.15, attack: 0.03, sustain: true }));
    tone({ type: 'sawtooth', freq: 246.94, start: 1.5, dur: 1.4, vol: 0.15, attack: 0.03, sustain: true, vibrato: { rate: 6, depth: 7 } });
  } },
  { emoji: '📢', name: 'Airhorn', dur: 1.7, play() {
    [[0, 0.25], [0.3, 0.25], [0.6, 1.0]].forEach(([start, dur]) =>
      [415, 419, 830].forEach((f, i) => tone({ type: 'sawtooth', freq: f, start, dur, vol: i === 2 ? 0.06 : 0.12, attack: 0.02, sustain: true })));
  } },
  { emoji: '👏', name: 'Applaus', dur: 3, play() {
    for (let i = 0; i < 260; i++) {
      const start = Math.random() * 2.6;
      noise({ start, dur: 0.04, vol: (0.08 + Math.random() * 0.2) * (1 - start / 3), filter: 'bandpass', freq: 1000 + Math.random() * 1500, q: 1.5 });
    }
  } },
  { emoji: '✅', name: 'Richtig', dur: 1.1, play() {
    tone({ freq: 1318.5, dur: 0.6, vol: 0.3 });
    tone({ freq: 1760, start: 0.15, dur: 0.9, vol: 0.3 });
  } },
  { emoji: '❌', name: 'Falsch', dur: 0.8, play() {
    tone({ type: 'square', freq: 110, dur: 0.7, vol: 0.12, sustain: true });
    tone({ type: 'square', freq: 116, dur: 0.7, vol: 0.12, sustain: true });
  } },
  { emoji: '🦗', name: 'Stille…', dur: 3.2, play() {
    for (let g = 0; g < 4; g++)
      for (let p = 0; p < 4; p++) tone({ freq: 4400, start: g * 0.8 + p * 0.06, dur: 0.035, vol: 0.08 });
  } },
  { emoji: '🔫', name: 'Pew Pew', dur: 1, play() {
    [0, 0.3, 0.6].forEach((start) => tone({ type: 'square', freq: 1500, endFreq: 180, start, dur: 0.25, vol: 0.1 }));
  } },
  { emoji: '🎉', name: 'Tada', dur: 2, play() {
    [523.25, 659.25, 783.99].forEach((f, i) => tone({ type: 'triangle', freq: f, start: i * 0.08, dur: 0.15, vol: 0.25 }));
    [523.25, 659.25, 783.99, 1046.5].forEach((f) => {
      tone({ type: 'triangle', freq: f, start: 0.3, dur: 1.6, vol: 0.2 });
      tone({ type: 'sawtooth', freq: f, start: 0.3, dur: 1.6, vol: 0.03 });
    });
  } },
  { emoji: '🔔', name: 'Schulgong', dur: 3.3, play() {
    [[659.25, 0], [523.25, 0.7]].forEach(([f, start]) => {
      tone({ freq: f, start, dur: 2.5, vol: 0.35, attack: 0.005 });
      tone({ freq: f * 2.01, start, dur: 1.2, vol: 0.08, attack: 0.005 });
    });
  } },
  { emoji: '😱', name: 'Dramatisch', dur: 2.7, play() {
    [[220, 0, 0.25], [207.65, 0.35, 0.25], [174.61, 0.75, 1.8]].forEach(([f, start, dur], i) => {
      const vibrato = i === 2 ? { rate: 5, depth: 4 } : undefined;
      tone({ type: 'sawtooth', freq: f, start, dur, vol: 0.12, attack: 0.02, sustain: true, vibrato });
      tone({ type: 'sawtooth', freq: f / 2, start, dur, vol: 0.12, attack: 0.02, sustain: true, vibrato });
    });
  } },
  { emoji: '🤪', name: 'Boing', dur: 0.6, play() {
    tone({ freq: 150, endFreq: 600, dur: 0.5, vol: 0.4, vibrato: { rate: 25, depth: 40 } });
  } }
];

// ---------- Abspielen ----------
const playingAudio = new Set();

function flash(el, seconds) {
  if (!el) return;
  el.classList.add('playing');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('playing'), seconds * 1000);
}

function playUrl(url, el) {
  const a = new Audio(url);
  playingAudio.add(a);
  a.onended = a.onerror = () => { playingAudio.delete(a); el && el.classList.remove('playing'); };
  a.onloadedmetadata = () => isFinite(a.duration) && flash(el, a.duration);
  flash(el, 1);
  a.play().catch(() => toast('Sound konnte nicht abgespielt werden 😕'));
}

function stopAll() {
  if (master) { master.disconnect(); master = null; }
  playingAudio.forEach((a) => a.pause());
  playingAudio.clear();
  document.querySelectorAll('.sound-btn.playing').forEach((b) => b.classList.remove('playing'));
}

// ---------- Kacheln ----------
function hue(str) {
  let h = 0;
  for (const ch of str) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}

function tile({ emoji, name, onPlay, onDelete }) {
  const wrap = document.createElement('div');
  wrap.className = 'sound-tile';
  const btn = document.createElement('button');
  btn.className = 'sound-btn';
  btn.style.setProperty('--h', hue(name));
  const e = document.createElement('span');
  e.className = 'emoji';
  e.textContent = emoji || '🔊';
  const l = document.createElement('span');
  l.className = 'label';
  l.textContent = name;
  btn.append(e, l);
  btn.addEventListener('click', () => onPlay(btn));
  wrap.append(btn);
  if (onDelete) {
    const del = document.createElement('button');
    del.className = 'del-badge';
    del.textContent = '✕';
    del.setAttribute('aria-label', name + ' löschen');
    del.addEventListener('click', onDelete);
    wrap.append(del);
  }
  return wrap;
}

function renderBuiltin() {
  const grid = $('#grid-builtin');
  BUILTIN.forEach((s) => grid.append(tile({
    ...s,
    onPlay: (btn) => { s.play(); flash(btn, s.dur); }
  })));
}

// ---------- Eigene Sounds (IndexedDB, bleibt auf dem Gerät) ----------
const idb = {
  open() {
    return this._p || (this._p = new Promise((resolve, reject) => {
      const r = indexedDB.open('test-app', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('sounds', { keyPath: 'id' });
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    }));
  },
  async tx(mode, fn) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const t = db.transaction('sounds', mode);
      const req = fn(t.objectStore('sounds'));
      t.oncomplete = () => resolve(req && req.result);
      t.onerror = () => reject(t.error);
    });
  },
  all() { return this.tx('readonly', (s) => s.getAll()); },
  put(item) { return this.tx('readwrite', (s) => s.put(item)); },
  del(id) { return this.tx('readwrite', (s) => s.delete(id)); }
};

const blobUrls = new Map();

async function renderMine() {
  const grid = $('#grid-mine');
  let items = [];
  try { items = await idb.all(); } catch {}
  items.sort((a, b) => a.created - b.created);
  grid.innerHTML = '';
  items.forEach((s) => {
    if (!blobUrls.has(s.id)) blobUrls.set(s.id, URL.createObjectURL(s.blob));
    grid.append(tile({
      ...s,
      onPlay: (btn) => playUrl(blobUrls.get(s.id), btn),
      onDelete: async () => {
        if (!confirm(`„${s.name}“ löschen?`)) return;
        await idb.del(s.id);
        URL.revokeObjectURL(blobUrls.get(s.id));
        blobUrls.delete(s.id);
        renderMine();
      }
    }));
  });
  $('#mine-empty').hidden = items.length > 0;
  $('#mine-edit').hidden = items.length === 0;
  if (!items.length) grid.classList.remove('editing');
}

$('#mine-edit').addEventListener('click', () => {
  const editing = $('#grid-mine').classList.toggle('editing');
  $('#mine-edit').textContent = editing ? 'Fertig' : 'Bearbeiten';
});

// ---------- Community-Sounds (Supabase) ----------
function sbHeaders(extra = {}) {
  const h = { apikey: CFG.supabaseKey, ...extra };
  // Alte "anon"-Keys sind JWTs und gehören zusätzlich in den Authorization-Header
  if (!CFG.supabaseKey.startsWith('sb_')) h.Authorization = 'Bearer ' + CFG.supabaseKey;
  return h;
}

const sbBase = () => CFG.supabaseUrl.replace(/\/+$/, '');
const publicUrl = (path) => `${sbBase()}/storage/v1/object/public/sounds/${path}`;

function renderCommunity(items) {
  const grid = $('#grid-community');
  grid.innerHTML = '';
  items.forEach((s) => grid.append(tile({ ...s, onPlay: (btn) => playUrl(publicUrl(s.path), btn) })));
  $('#community-empty').hidden = items.length > 0;
}

async function loadCommunity() {
  if (!COMMUNITY) return;
  $('#community-status').textContent = 'lädt…';
  try {
    const r = await fetch(`${sbBase()}/rest/v1/sounds?select=name,emoji,path&order=created_at.desc&limit=200`, { headers: sbHeaders() });
    if (!r.ok) throw new Error(r.status);
    const items = await r.json();
    store.set('communityCache', items);
    renderCommunity(items);
    $('#community-status').textContent = '';
  } catch {
    $('#community-status').textContent = 'offline';
  }
}

const EXT = { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac',
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/ogg': 'ogg', 'audio/webm': 'webm' };

async function uploadCommunity(blob, name, emoji) {
  const type = blob.type.split(';')[0];
  const ext = EXT[type];
  if (!ext) throw new Error('Dateiformat wird nicht unterstützt');
  const id = crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2);
  const path = `${id}.${ext}`;

  const up = await fetch(`${sbBase()}/storage/v1/object/sounds/${path}`, {
    method: 'POST',
    headers: sbHeaders({ 'Content-Type': type }),
    body: blob
  });
  if (!up.ok) throw new Error('Upload fehlgeschlagen (' + up.status + ')');

  const ins = await fetch(`${sbBase()}/rest/v1/sounds`, {
    method: 'POST',
    headers: sbHeaders({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
    body: JSON.stringify({ name, emoji, path })
  });
  if (!ins.ok) throw new Error('Speichern fehlgeschlagen (' + ins.status + ')');
}

// ---------- Neuen Sound hinzufügen ----------
let pending = null; // { blob, url }

function getDuration(blob) {
  return new Promise((resolve) => {
    const a = new Audio();
    const url = URL.createObjectURL(blob);
    const done = (d) => { URL.revokeObjectURL(url); resolve(d); };
    a.preload = 'metadata';
    a.onloadedmetadata = () => done(a.duration);
    a.onerror = () => done(NaN);
    a.src = url;
  });
}

function openDialog(blob) {
  if (pending) URL.revokeObjectURL(pending.url);
  pending = { blob, url: URL.createObjectURL(blob) };
  $('#dlg-name').value = '';
  $('#dlg-emoji').value = '🔊';
  $('#dlg-error').textContent = '';
  $('#dlg-share-row').hidden = !COMMUNITY;
  $('#dlg-share-hint').hidden = !COMMUNITY;
  $('#dlg-save').disabled = false;
  $('#sound-dialog').showModal();
}

function closeDialog() {
  $('#sound-dialog').close();
  if (pending) URL.revokeObjectURL(pending.url);
  pending = null;
}

$('#dlg-preview').addEventListener('click', () => pending && playUrl(pending.url));
$('#dlg-cancel').addEventListener('click', closeDialog);

$('#sound-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!pending) return;
  const name = $('#dlg-name').value.trim().slice(0, 30);
  const emoji = [...$('#dlg-emoji').value.trim()].slice(0, 2).join('') || '🔊';
  if (!name) return;
  const share = COMMUNITY && $('#dlg-share').checked;
  $('#dlg-save').disabled = true;
  $('#dlg-error').textContent = '';

  if (share) {
    try {
      $('#dlg-save').textContent = 'Lädt hoch…';
      await uploadCommunity(pending.blob, name, emoji);
      closeDialog();
      toast('Geteilt! Jetzt können alle ihn hören 🌍');
      loadCommunity();
      return;
    } catch (err) {
      $('#dlg-error').textContent = `${err.message}. Du kannst ihn ohne Häkchen nur für dich speichern.`;
      $('#dlg-save').disabled = false;
      return;
    } finally {
      $('#dlg-save').textContent = 'Speichern';
    }
  }

  try {
    await idb.put({ id: Date.now().toString(36), name, emoji, blob: pending.blob, created: Date.now() });
    closeDialog();
    toast('Gespeichert 🎉');
    renderMine();
  } catch {
    $('#dlg-error').textContent = 'Speichern hat nicht geklappt.';
    $('#dlg-save').disabled = false;
  }
});

// Datei auswählen
$('#sound-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (file.size > MAX_BYTES) return toast('Die Datei ist zu groß (max. 1 MB)');
  const d = await getDuration(file);
  if (Number.isNaN(d)) return toast('Das Dateiformat wird nicht unterstützt');
  if (isFinite(d) && d > MAX_SECONDS) return toast(`Zu lang – max. ${MAX_SECONDS} Sekunden`);
  openDialog(file);
});

// Mikrofon-Aufnahme
let recorder = null, recTimer = null;

function recLabel(text) { $('#rec-btn').textContent = text; }

async function startRecording() {
  if (!window.isSecureContext) return showMicHelp('insecure');
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) return showMicHelp('unsupported');
  let stream;
  setAudioSession('play-and-record');
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    setAudioSession('playback');
    return showMicHelp(err && err.name, err && err.message);
  }
  const mimeType = ['audio/mp4', 'audio/webm', 'audio/ogg'].find((t) => MediaRecorder.isTypeSupported(t));
  recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = () => {
    stream.getTracks().forEach((t) => t.stop());
    setAudioSession('playback');
    clearInterval(recTimer);
    $('#rec-btn').classList.remove('recording');
    recLabel('🎙️ Aufnehmen');
    const blob = new Blob(chunks, { type: (recorder.mimeType || mimeType || 'audio/mp4').split(';')[0] });
    recorder = null;
    if (blob.size > MAX_BYTES) return toast('Aufnahme zu groß');
    if (blob.size) openDialog(blob);
  };
  recorder.start();
  let left = REC_SECONDS;
  $('#rec-btn').classList.add('recording');
  recLabel(`⏹ Stopp (${left})`);
  recTimer = setInterval(() => {
    left--;
    if (left <= 0) recorder && recorder.stop();
    else recLabel(`⏹ Stopp (${left})`);
  }, 1000);
}

// Hilfe, wenn das Mikrofon nicht geht – mit dem genauen Grund
const MIC_HELP = {
  NotAllowedError: {
    title: 'Mikrofon ist blockiert 🚫',
    text: 'Das iPad hat den Zugriff abgelehnt, ohne zu fragen. Meistens ist er in den Einstellungen gesperrt:',
    steps: [
      '<b>Einstellungen → Apps → Safari → Mikrofon</b> auf <b>„Fragen“</b> oder <b>„Erlauben“</b> stellen (bei älterem iOS: <b>Einstellungen → Safari → Mikrofon</b>)',
      '<b>Einstellungen → Bildschirmzeit → Beschränkungen → Mikrofon</b> muss erlaubt sein',
      'Dann die App <b>ganz schließen</b> (vom App-Umschalter wegwischen) und neu öffnen',
      'Ist es ein <b>Schul-iPad</b>? Dann kann die Schule das Mikrofon gesperrt haben. Das lässt sich nicht selbst ändern. Nimm stattdessen eine Sprachmemo auf und lade sie über <b>📁 Datei</b> hoch.'
    ]
  },
  NotFoundError: {
    title: 'Kein Mikrofon gefunden 🎙️',
    text: 'Das Gerät meldet kein Mikrofon.',
    steps: ['Prüfe, ob ein Headset angeschlossen ist, und versuch es ohne', 'Alternativ: Sprachmemo aufnehmen und über <b>📁 Datei</b> hochladen']
  },
  NotReadableError: {
    title: 'Mikrofon ist belegt',
    text: 'Eine andere App benutzt gerade das Mikrofon (z. B. ein Anruf oder FaceTime).',
    steps: ['Die andere App schließen und nochmal versuchen']
  },
  insecure: {
    title: 'Nur über https',
    text: 'Das Mikrofon funktioniert nur, wenn die Seite über <b>https://</b> geöffnet wird.',
    steps: ['Die App über den GitHub-Pages-Link (https://…github.io/…) öffnen']
  },
  unsupported: {
    title: 'Aufnehmen nicht unterstützt',
    text: 'Dieser Browser bzw. diese iOS-Version kann nicht aufnehmen.',
    steps: ['iPadOS aktualisieren', 'Alternativ: Sprachmemo aufnehmen und über <b>📁 Datei</b> hochladen']
  }
};

function showMicHelp(code, detail) {
  const h = MIC_HELP[code] || MIC_HELP.NotAllowedError;
  $('#mic-title').textContent = h.title;
  $('#mic-text').innerHTML = h.text;
  $('#mic-steps').innerHTML = h.steps.map((s) => `<li>${s}</li>`).join('');
  $('#mic-code').textContent = `Fehlercode: ${code || 'unbekannt'}${detail ? ' – ' + detail : ''}`;
  $('#mic-help').showModal();
}

$('#mic-close').addEventListener('click', () => $('#mic-help').close());

$('#rec-btn').addEventListener('click', () => (recorder ? recorder.stop() : startRecording()));

// ---------- Kleine Meldung unten ----------
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('show'), 2500);
}

// ---------- Start ----------
$('#sound-stop').addEventListener('click', stopAll);
$('#community-refresh').addEventListener('click', loadCommunity);
document.querySelector('[data-view="sounds"]').addEventListener('click', loadCommunity);

$('#community-section').hidden = !COMMUNITY;
if (COMMUNITY) {
  renderCommunity(store.get('communityCache', []));
  loadCommunity();
}
renderBuiltin();
renderMine();
