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
