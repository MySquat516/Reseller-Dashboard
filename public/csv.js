// ---------- CSV-Export mit Auswahl ----------
const isoDay = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Von/Bis für die Voreinstellungen, in lokaler Zeit
function csvRange(kind) {
  const now = new Date(), y = now.getFullYear(), m = now.getMonth();
  switch (kind) {
    case 'month': return [isoDay(new Date(y, m, 1)), isoDay(new Date(y, m + 1, 0))];
    case 'lastmonth': return [isoDay(new Date(y, m - 1, 1)), isoDay(new Date(y, m, 0))];
    case 'year': return [`${y}-01-01`, `${y}-12-31`];
    case 'lastyear': return [`${y - 1}-01-01`, `${y - 1}-12-31`];
    case 'custom': return [$('#csv-from').value, $('#csv-to').value];
    default: return ['', ''];
  }
}

function csvSelection() {
  const [from, to] = csvRange($('#csv-period').value);
  return { scope: $('#csv-scope').value, by: $('#csv-by').value, from, to };
}

function updateCsvDialog() {
  const sel = csvSelection();
  const custom = $('#csv-period').value === 'custom';
  $('#csv-custom').hidden = !custom;
  $('#csv-by-wrap').hidden = $('#csv-period').value === 'all';
  const q = new URLSearchParams();
  if (sel.scope !== 'all') q.set('scope', sel.scope);
  if (sel.from || sel.to) { q.set('by', sel.by); if (sel.from) q.set('from', sel.from); if (sel.to) q.set('to', sel.to); }
  $('#csv-go').href = '/api/export.csv' + (q.size ? '?' + q : '');

  const what = { all: 'Alle Artikel', sold: 'Verkaufte Artikel', unsold: 'Unverkaufte Artikel (Lager, Online, Reserviert)' }[sel.scope];
  let when = '';
  if (sel.from || sel.to) {
    const dateType = sel.by === 'sold' ? 'Verkaufsdatum' : 'Kaufdatum';
    when = ` mit ${dateType} ${sel.from ? 'ab ' + dateDe(sel.from) : ''}${sel.from && sel.to ? ' ' : ''}${sel.to ? 'bis ' + dateDe(sel.to) : ''}`
      + (sel.by === 'sold' && sel.scope !== 'sold' ? ' (Artikel ohne Verkauf fallen dabei heraus)' : '');
  }
  const bad = sel.from && sel.to && sel.from > sel.to;
  $('#csv-summary').textContent = bad ? '„Von“ liegt nach „Bis“. Bitte korrigieren.' : `${what}${when}.`;
  if (bad) $('#csv-go').setAttribute('aria-disabled', 'true'); else $('#csv-go').removeAttribute('aria-disabled');
  $('#csv-go').classList.toggle('disabled', !!bad);
}

$('#btn-csv').addEventListener('click', () => { updateCsvDialog(); $('#dlg-csv').showModal(); });
$('#csv-close').addEventListener('click', () => $('#dlg-csv').close());
for (const id of ['csv-scope', 'csv-period', 'csv-by', 'csv-from', 'csv-to']) $('#' + id).addEventListener('input', updateCsvDialog);
$('#csv-go').addEventListener('click', e => {
  if (e.currentTarget.getAttribute('aria-disabled') === 'true') { e.preventDefault(); return; }
  setTimeout(() => $('#dlg-csv').close(), 300);   // Download startet über den Link, dann den Dialog schließen
});
