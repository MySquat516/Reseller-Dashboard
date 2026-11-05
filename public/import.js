// ---------- CSV-Import (Einstellungen) ----------
let importFile = null;
let importInfo = null;       // letzte Vorschau vom Server

async function postImport(file, dry, skipDuplicates) {
  let res;
  try {
    res = await fetch(`/api/import.csv?${dry ? 'dry=1&' : ''}skipDuplicates=${skipDuplicates ? 1 : 0}`,
      { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: file });
  } catch { throw new Error('Keine Verbindung zum Server'); }
  if (res.status === 401) { location.replace('/login?next=' + encodeURIComponent(location.pathname)); throw new Error('Nicht angemeldet'); }
  let body = {};
  try { body = await res.json(); } catch { /* keine JSON-Antwort */ }
  if (!res.ok) {
    const err = new Error(body.error || (res.status === 413 ? 'Die Datei ist größer als 5 MB.' : `Fehler ${res.status}`));
    err.headers = body.headers;
    throw err;
  }
  return body;
}

const plural = (n, one, many) => `${n.toLocaleString('de-DE')} ${n === 1 ? one : many}`;

function importCount() {
  const skip = !$('#im-skip-wrap').hidden && $('#im-skip').checked;
  return importInfo.valid - (skip ? importInfo.duplicates : 0);
}
function updateImportButton() {
  const n = importCount();
  $('#im-go').textContent = n ? `${plural(n, 'Artikel', 'Artikel')} importieren` : 'Nichts zu importieren';
  $('#im-go').disabled = n === 0;
}

function renderImportPreview(r, file) {
  importInfo = r;
  const delim = { ';': 'Semikolon', ',': 'Komma', tab: 'Tabulator' }[r.delimiter] || r.delimiter;
  $('#im-file').textContent = `„${file.name}“ · ${plural(r.total, 'Zeile', 'Zeilen')} gelesen · Trennzeichen: ${delim} · Zeichensatz: ${r.encoding}`;
  const chips = [`<li class="pos">${plural(r.valid, 'Zeile', 'Zeilen')} gültig</li>`];
  if (r.duplicates) chips.push(`<li class="warn">${plural(r.duplicates, 'mögliches Duplikat', 'mögliche Duplikate')}</li>`);
  if (r.warningCount) chips.push(`<li class="warn">${plural(r.warningCount, 'Hinweis', 'Hinweise')}</li>`);
  if (r.errorCount) chips.push(`<li class="neg">${plural(r.errorCount, 'Zeile', 'Zeilen')} mit Fehlern (werden übersprungen)</li>`);
  $('#im-stats').innerHTML = chips.join('');

  $('#im-skip-wrap').hidden = !r.duplicates;
  $('#im-skip').checked = true;

  const list = (id, items, total, title) => {
    const d = $('#' + id), ul = $('#' + id + '-list');
    d.hidden = !total;
    d.querySelector('summary').textContent = title;
    ul.innerHTML = items.map(x => `<li>Zeile ${x.row}: ${esc(x.message)}</li>`).join('')
      + (total > items.length ? `<li>… und ${(total - items.length).toLocaleString('de-DE')} weitere</li>` : '');
  };
  list('im-errors', r.errors, r.errorCount, `${plural(r.errorCount, 'Fehler', 'Fehler')}: diese Zeilen werden nicht importiert`);
  list('im-warnings', r.warnings, r.warningCount, `${plural(r.warningCount, 'Hinweis', 'Hinweise')}: werden trotzdem importiert`);
  $('#im-errors').open = r.errorCount > 0 && r.errorCount <= 10;
  $('#im-warnings').open = false;

  $('#im-sample-body').innerHTML = r.sample.map(x => `<tr>
      <td>${x.row}</td><td>${esc(x.title)}${x.duplicate ? ' <span class="badge">Duplikat</span>' : ''}</td>
      <td>${esc(STATUS_LABEL[x.status] || x.status)}</td><td class="num">${eur(x.purchase_price)}</td><td class="num">${eur(x.sold_price)}</td></tr>`).join('');
  $('#im-sample').hidden = !r.sample.length;

  const used = r.columns.mapped.map(m => m.header === m.label ? esc(m.label) : `${esc(m.header)} → ${esc(m.label)}`).join(', ');
  $('#im-cols-body').innerHTML = `<strong>Verwendet:</strong> ${used}.`
    + (r.columns.ignored.length ? `<br><strong>Nicht verwendet:</strong> ${r.columns.ignored.map(esc).join(', ')}.` : '');
  updateImportButton();
}

$('#btn-import').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  hideMsg('im-error');
  $('#im-status').textContent = '';
  if (file.size > 5 * 1024 * 1024) return showMsg('im-error', 'Die Datei ist größer als 5 MB. Bitte in kleinere Dateien aufteilen.');
  const btn = $('#btn-import');
  btn.setAttribute('disabled', '');
  $('#im-status').className = 'hint';
  $('#im-status').textContent = 'Datei wird geprüft …';
  try {
    const r = await postImport(file, true, true);
    importFile = file;
    renderImportPreview(r, file);
    $('#im-status').textContent = '';
    $('#dlg-import').showModal();
  } catch (err) {
    $('#im-status').textContent = '';
    showMsg('im-error', err.message + (err.headers ? ` Gefundene Spalten: ${err.headers.join(', ')}.` : ''));
  } finally {
    btn.removeAttribute('disabled');
  }
});

$('#im-skip').addEventListener('change', updateImportButton);
$('#im-cancel').addEventListener('click', () => $('#dlg-import').close());
$('#im-go').addEventListener('click', async () => {
  const buttons = [$('#im-go'), $('#im-cancel')];
  buttons.forEach(b => b.setAttribute('disabled', ''));
  $('#im-go').textContent = 'Wird importiert …';
  try {
    const skip = !$('#im-skip-wrap').hidden && $('#im-skip').checked;
    const r = await postImport(importFile, false, skip);
    $('#dlg-import').close();
    await loadItems();
    const parts = [];
    if (r.skippedDuplicates) parts.push(plural(r.skippedDuplicates, 'Duplikat', 'Duplikate'));
    if (r.skippedErrors) parts.push(plural(r.skippedErrors, 'fehlerhafte Zeile', 'fehlerhafte Zeilen'));
    $('#im-status').className = 'hint pos';
    $('#im-status').textContent = `„${importFile.name}“: ${plural(r.imported, 'Artikel', 'Artikel')} importiert`
      + (parts.length ? `, ${parts.join(' und ')} übersprungen.` : '.');
    importFile = importInfo = null;
  } catch (err) {
    $('#dlg-import').close();
    showMsg('im-error', 'Import fehlgeschlagen: ' + err.message + ' Es wurde nichts importiert.');
  } finally {
    buttons.forEach(b => b.removeAttribute('disabled'));
  }
});

// Vorlage zum Ausfüllen in Excel
$('#btn-template').addEventListener('click', () => {
  const csv = '﻿' + [
    'Titel;Marke;Größe;Kategorie;Zustand;Status;Einkaufspreis;Gekauft am;Verkaufspreis;Verkauft am;Plattform;Notizen',
    'Beispiel-Jacke;Nike;M;Jacken;Gut;Lager;12,50;05.03.2026;;;;Diese Zeile ersetzen oder löschen'
  ].join('\r\n') + '\r\n';
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: 'artikel-vorlage.csv' });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
});
