// ---------- Einstellungen (Ansicht) ----------
// Die Werte selbst (settings, loadSettings) stehen in app.js, weil das Dashboard sie schon beim Start braucht.
let setStatusTimer;
function setStatus(text, ok = false) {
  const el = $('#set-status');
  el.textContent = text;
  el.classList.toggle('pos', ok);
  clearTimeout(setStatusTimer);
  if (ok) setStatusTimer = setTimeout(() => setStatus('Änderungen werden gespeichert, sobald du ein Feld verlässt.'), 2500);
}

function renderSettingsView() {
  $('#set-period').value = settings.default_period;
  $('#set-dead').value = settings.dead_days;
  $('#set-goal').value = settings.monthly_goal ?? '';
}

async function saveSetting(patch) {
  hideMsg('set-error');
  try {
    settings = await api('/api/settings', { method: 'PUT', headers: jsonHeaders, body: JSON.stringify(patch) });
    // Standardwerte gelten sofort auch für die aktuelle Sitzung
    if ('default_period' in patch) period = settings.default_period;
    if ('dead_days' in patch) deadDays = settings.dead_days;
    setStatus('Gespeichert ✓', true);
  } catch (err) {
    showMsg('set-error', err.message);
    setStatus('Nicht gespeichert.');
  }
  renderSettingsView();   // zeigt den gespeicherten Stand, auch nach einem Fehler
}

$('#set-period').addEventListener('change', e => saveSetting({ default_period: e.target.value }));
$('#set-dead').addEventListener('change', e => saveSetting({ dead_days: e.target.value }));
$('#set-goal').addEventListener('change', e => saveSetting({ monthly_goal: e.target.value === '' ? null : e.target.value }));

// ---------- Daten & Backup ----------
const fmtSize = n => (n < 1024 ** 2 ? Math.max(1, Math.round(n / 1024)) + ' KB'
  : n < 1024 ** 3 ? (n / 1024 ** 2).toLocaleString('de-DE', { maximumFractionDigits: 1 }) + ' MB'
  : (n / 1024 ** 3).toLocaleString('de-DE', { maximumFractionDigits: 2 }) + ' GB');

async function loadBackups() {
  try {
    const b = await api('/api/backups');
    $('#bk-auto-hint').textContent = b.auto
      ? `Täglich wird die Datenbank gesichert (ohne Fotos), die letzten ${b.keep} Tage bleiben im Ordner „backups“ im Datenverzeichnis. `
        + 'Das schützt vor Bedienfehlern, aber nicht vor einem Festplattenausfall. Lade deshalb ab und zu ein vollständiges Backup herunter.'
      : 'Die automatische Sicherung ist ausgeschaltet (BACKUP_AUTO=0).';
    $('#bk-list').innerHTML = b.files.length ? b.files.map(f => {
      const d = new Date(f.modified);
      const label = f.kind === 'auto'
        ? `Automatisch · ${d.toLocaleDateString('de-DE', { dateStyle: 'medium' })}`
        : `Vor Wiederherstellung · ${d.toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' })}`;
      return `<div class="bk-row"><span class="grow">${esc(label)} <span class="muted">· ${fmtSize(f.size)}${f.kind === 'auto' ? ' · nur Datenbank' : ''}</span></span>
        <a class="btn" href="/api/backups/${encodeURIComponent(f.name)}" download>⬇ Laden</a></div>`;
    }).join('') : '<p class="empty">Noch keine Sicherungen vorhanden.</p>';
  } catch (err) {
    $('#bk-list').innerHTML = '';
    $('#bk-auto-hint').textContent = 'Sicherungen konnten nicht geladen werden: ' + err.message;
  }
}

function uploadRestore(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/restore');
    xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let body = {};
      try { body = JSON.parse(xhr.responseText); } catch { /* keine JSON-Antwort */ }
      if (xhr.status === 200) resolve(body); else reject(new Error(body.error || `Fehler ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('Keine Verbindung zum Server'));
    const fd = new FormData();
    fd.append('backup', file);
    xhr.send(fd);
  });
}

$('#btn-restore').addEventListener('click', () => $('#restore-file').click());
$('#restore-file').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  hideMsg('bk-error');
  const go = await confirmDialog({
    title: 'Backup einspielen?',
    text: `„${file.name}“ ersetzt alle aktuellen Artikel, Fotos, Versandvorlagen und Einstellungen. `
      + 'Vorher legt der Server automatisch eine Sicherheitskopie des jetzigen Stands an (Ordner „backups“).',
    ok: 'Einspielen'
  });
  if (!go) return;
  const bar = $('#bk-progress'), status = $('#bk-status');
  const buttons = [$('#btn-restore'), $('#btn-backup')];
  buttons.forEach(b => b.setAttribute('disabled', ''));
  bar.hidden = false; bar.value = 0;
  status.className = 'hint'; status.textContent = 'Lade hoch …';
  try {
    const r = await uploadRestore(file, f => {
      bar.value = Math.round(f * 100);
      status.textContent = f < 1 ? `Lade hoch … ${Math.round(f * 100)} %` : 'Wird eingespielt … (kann bei vielen Fotos dauern)';
    });
    await Promise.all([loadSettings(), loadPresets(), loadItems()]);
    renderSettingsView();
    loadBackups();
    const skipped = r.skippedImages ? `, ${r.skippedImages} Fotos fehlten und wurden übersprungen` : '';
    status.className = 'hint pos';
    status.textContent = `Wiederhergestellt: ${r.items} Artikel, ${r.images} Fotos${skipped}. Der vorherige Stand liegt als Sicherheitskopie auf dem Server.`;
  } catch (err) {
    status.textContent = '';
    showMsg('bk-error', 'Einspielen fehlgeschlagen: ' + err.message + ' Es wurde nichts verändert.');
  } finally {
    bar.hidden = true;
    buttons.forEach(b => b.removeAttribute('disabled'));
  }
});

// ---------- Sicherheit (Passwortschutz) ----------
async function loadSession() {
  try {
    const s = await api('/api/session');
    $('#sec-on').hidden = !s.auth;
    $('#sec-off').hidden = s.auth;
    if (s.auth) $('#sec-user').textContent = s.user;
  } catch { /* nicht kritisch: Karte bleibt leer */ }
}
$('#btn-logout').addEventListener('click', async () => {
  try { await fetch('/api/logout', { method: 'POST' }); } finally { location.href = '/login'; }
});
