// ---------- Einladung & Installation ----------
// Einladungslink: …/?install&klasse=K7XM2Q
//  - im Browser: Anleitung bzw. „Installieren“-Knopf, danach tritt Orbit der Klasse bei
//  - in der installierten App: sofort beitreten
// Weg des Codes in die installierte App: Start-Adresse (iPad), gemeinsamer Speicher
// (Edge/Chrome) und als Rückfall die Zwischenablage (📋 unter „Klasse“).

const INVITE = (() => {
  const q = new URLSearchParams(location.search);
  return { install: q.has('install'), code: orbitCodeIn(q.get('klasse') || '') };
})();
const APPLE_TOUCH = /iP(ad|hone|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const appBase = () => location.origin + location.pathname.replace(/index\.html$/, '');
let installEvent = null;

if (INVITE.code) store.set('orbitPendingCode', INVITE.code);
if (INVITE.install || INVITE.code) history.replaceState(null, '', location.pathname);   // Adresse wieder sauber

// iPad/iPhone: die Home-Bildschirm-App startet mit dem Code in der Adresse
if (INVITE.code && APPLE_TOUCH && !isStandalone) {
  const base = appBase();
  const man = {
    name: 'Orbit', short_name: 'Orbit', start_url: `${base}?klasse=${INVITE.code}`, scope: base,
    display: 'standalone', background_color: '#f2f2f7', theme_color: '#1f3b6e',
    icons: [192, 512].map((s) => ({ src: `${base}icons/icon-${s}.png`, sizes: `${s}x${s}`, type: 'image/png' }))
  };
  const link = document.querySelector('link[rel="manifest"]');
  if (link) link.href = 'data:application/manifest+json,' + encodeURIComponent(JSON.stringify(man));
}

// Edge/Chrome: eigener Installieren-Knopf statt Browser-Menü
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; if (document.querySelector('#install-guide[open]')) renderInstallGuide(); });
window.addEventListener('appinstalled', () => {
  installEvent = null;
  const box = $('#ig-actions');
  if (box) box.innerHTML = '<p class="ig-done">✓ Orbit ist installiert. Es öffnet sich in einem eigenen Fenster – sonst im Startmenü bzw. auf dem Home-Bildschirm „Orbit“ öffnen.</p>';
});

// gemerkten Code einlösen
async function inviteJoin() {
  const code = store.get('orbitPendingCode', '');
  if (!code || !orbitReady()) return;
  if (orbitClasses.some((c) => c.code === code)) { store.set('orbitPendingCode', ''); return; }
  showView('orbit');
  const c = await orbitEnter('/join', { code });
  if (c) store.set('orbitPendingCode', '');      // bei Fehler bleibt er für den nächsten Versuch
}

const SHARE_ICON = '<svg viewBox="0 0 24 24" class="ig-share" aria-hidden="true"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M6 11H5v10h14V11h-1"/></svg>';

function renderInstallGuide() {
  let dlg = $('#install-guide');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'install-guide';
    document.body.append(dlg);
  }
  const code = store.get('orbitPendingCode', '');
  let steps;
  if (APPLE_TOUCH) {
    steps = '<ol class="ig-steps">' +
      `<li>Oben rechts auf ${SHARE_ICON} <b>Teilen</b> tippen <span class="muted">(iPhone: unten)</span></li>` +
      '<li><b>„Zum Home-Bildschirm“</b> wählen <span class="muted">(evtl. etwas nach unten wischen)</span></li>' +
      '<li>Oben rechts auf <b>„Hinzufügen“</b> tippen</li>' +
      `<li><b>Orbit</b> auf dem Home-Bildschirm öffnen${code ? ' – du kommst automatisch in die Klasse' : ''}</li></ol>` +
      (code ? '<p class="muted small-text">Falls die Klasse danach fehlt: in Orbit unter <b>Klasse</b> auf 📋 tippen – der Code ist schon kopiert.</p>' : '');
  } else if (installEvent) {
    steps = '<p>Orbit läuft dann wie eine richtige App in einem eigenen Fenster und ist im Startmenü zu finden.</p>';
  } else {
    steps = '<p>Im Browser-Menü <b>⋯</b> → <b>„Apps“ → „Orbit installieren“</b> (Edge) bzw. <b>„Orbit installieren“</b> (Chrome) wählen.</p>' +
      '<p class="muted small-text">Oder einfach hier im Browser weiterbenutzen.</p>';
  }
  dlg.innerHTML = '<div class="ig-head"><img src="icons/icon-192.png" alt="" class="ig-icon"><div><h2>Orbit installieren</h2><p class="muted">Die Schul-App fürs AKG</p></div></div>' +
    (code ? `<div class="ig-class">👥 Du bist in eine Klasse eingeladen · Code <b>${untisEsc(code)}</b></div>` : '') +
    steps +
    '<div class="ig-actions" id="ig-actions">' +
    (installEvent && !APPLE_TOUCH ? '<button type="button" class="btn primary" id="ig-install">Orbit installieren</button>' : '') +
    (code && APPLE_TOUCH ? '<button type="button" class="btn" id="ig-copy">Code kopieren</button>' : '') +
    `<button type="button" class="btn link" id="ig-browser">${code ? 'Ohne Installieren beitreten' : 'Im Browser weiter'}</button></div>`;
  const inst = $('#ig-install');
  if (inst) inst.addEventListener('click', async () => {
    if (!installEvent) return;
    installEvent.prompt();
    const r = await installEvent.userChoice.catch(() => null);
    if (r && r.outcome === 'accepted') toast('Orbit wird installiert …');
  });
  const copy = $('#ig-copy');
  if (copy) copy.addEventListener('click', () => navigator.clipboard.writeText(`Orbit-Klasse: Code ${code}`).then(() => toast('Code kopiert'), () => {}));
  $('#ig-browser').addEventListener('click', () => { dlg.close(); inviteJoin(); });
  // am iPad den Code gleich mitkopieren (falls die Home-Bildschirm-App ihn nicht mitbekommt)
  if (code && APPLE_TOUCH) navigator.clipboard.writeText(`Orbit-Klasse: Code ${code}`).catch(() => {});
  $('#install-banner').hidden = true;
  if (!dlg.open) dlg.showModal();
}

setTimeout(() => {
  if (isStandalone) inviteJoin();                                   // installierte App: Klasse beitreten
  else if (INVITE.install || INVITE.code) renderInstallGuide();     // Einladung im Browser
}, 300);
