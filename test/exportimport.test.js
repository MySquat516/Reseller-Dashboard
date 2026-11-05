// CSV-Export (Auswahl, Format, Schutz vor Formeln) und CSV-Import über die API, dazu der Rundlauf Export -> Import.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, png, today } = require('../testlib/harness');

const HEADER = ['ID', 'Titel', 'Beschreibung', 'Größe', 'Kategorie', 'Marke', 'Zustand', 'Status', 'Einkaufspreis', 'Gekauft am', 'Einstellpreis',
  'Online seit', 'Verkaufspreis', 'Verkauft am', 'Plattform', 'Käufer', 'Zahlungsart', 'Zahlungsstatus', 'Gebühren', 'Versandkosten', 'Gewinn',
  'Versandanbieter', 'Sendungsnummer', 'Notizen', 'Bilder'];

// Zeilen einer Export-Datei in Zellen zerlegen (Semikolon, Anführungszeichen mit "" als Escape)
function parseExport(text) {
  assert.equal(text.charCodeAt(0), 0xFEFF, 'BOM');
  const body = text.slice(1);
  assert.ok(body.endsWith('\r\n'), 'endet mit Zeilenumbruch');
  return body.slice(0, -2).split('\r\n').map(line => {
    const cells = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
      else if (ch === '"') q = true;
      else if (ch === ';') { cells.push(cur); cur = ''; } else cur += ch;
    }
    cells.push(cur);
    return cells;
  });
}

let s;
const ids = {};
before(async () => {
  s = await startServer();
  const mk = async (k, d) => { ids[k] = await s.item(d); };
  await mk(1, { title: 'Shirt; "blau"', status: 'verkauft', purchase_price: 10, purchase_date: '2026-03-01', sold_price: 30.5, sold_date: '2026-03-10',
    fees: 2, shipping_cost: 3, platform: 'Vinted', notes: 'Zeile1\nZeile2' });
  await mk(2, { title: '=SUMME(A1)', status: 'lager', purchase_price: 4, purchase_date: '2026-03-15' });
  await mk(3, { title: '+49 Hose', status: 'online', purchase_price: 6, listing_price: 15, purchase_date: '2026-04-01', brand: '@Marke', notes: '-5 Grad' });
  await mk(4, { title: 'Jacke', status: 'zu_versenden', purchase_price: 20, purchase_date: '2026-02-01', sold_price: 50, sold_date: '2026-04-05', payment_status: 'bezahlt' });
  await mk(5, { title: 'Ohne Datum', status: 'verkauft', sold_price: 5 });
  await mk(6, { title: 'Reserviert', status: 'reserviert', purchase_price: 1 });
  await mk(7, { title: 'Verkauft ohne Preis', status: 'verkauft', purchase_price: 2, purchase_date: '2026-03-20' });
});
after(() => s.stop());

const exp = async (query) => s.get('/api/export.csv', { query });
const titles = async (query) => parseExport((await exp(query)).text).slice(1).map(r => r[1]);

describe('Export: Format', () => {
  test('Kopfzeile, BOM, Semikolon, Windows-Zeilenumbrüche, Dateiname', async () => {
    const r = await exp();
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'text/csv; charset=utf-8');
    assert.equal(r.headers.get('content-disposition'), `attachment; filename="reseller-export-${today()}.csv"`);
    const rows = parseExport(r.text);
    assert.deepEqual(rows[0], HEADER);
    assert.equal(rows.length, 8);
    assert.ok(rows.every(c => c.length === HEADER.length), 'jede Zeile hat 25 Spalten');
    assert.ok(!r.text.slice(1).replace(/\r\n/g, '').includes('\n'), 'keine losen Zeilenumbrüche in Zellen');
  });

  test('Zeile mit Zahlen im deutschen Format, Gewinn berechnet, Anführungszeichen verdoppelt', async () => {
    const r = await exp();
    const line = r.text.slice(1).split('\r\n')[1];
    assert.equal(line, `${ids[1]};"Shirt; ""blau""";;;;;;verkauft;10,00;2026-03-01;;;30,50;2026-03-10;Vinted;;;offen;2,00;3,00;15,50;;;Zeile1 Zeile2;0`);
  });

  test('Fehlende Zahlen bleiben leer, Gewinn nur bei Verkaufspreis', async () => {
    const rows = parseExport((await exp()).text);
    const col = n => HEADER.indexOf(n);
    const byTitle = t => rows.find(r => r[1] === t);
    assert.equal(byTitle('Reserviert')[col('Verkaufspreis')], '');
    assert.equal(byTitle('Reserviert')[col('Gewinn')], '');
    assert.equal(byTitle('Reserviert')[col('Einkaufspreis')], '1,00');
    assert.equal(byTitle('Ohne Datum')[col('Gewinn')], '5,00', 'ohne Einkaufspreis: Gewinn = Verkaufspreis');
    assert.equal(byTitle('Jacke')[col('Gewinn')], '30,00');
    assert.equal(byTitle('Jacke')[col('Zahlungsstatus')], 'bezahlt');
  });

  test('Schutz vor Formeln: Anfang mit = + - @ bekommt ein Hochkomma', async () => {
    const rows = parseExport((await exp()).text);
    assert.equal(rows.find(r => r[0] === String(ids[2]))[1], "'=SUMME(A1)");
    assert.equal(rows.find(r => r[0] === String(ids[3]))[1], "'+49 Hose");
    assert.equal(rows.find(r => r[0] === String(ids[3]))[HEADER.indexOf('Marke')], "'@Marke");
    assert.equal(rows.find(r => r[0] === String(ids[3]))[HEADER.indexOf('Notizen')], "'-5 Grad");
    // Ein Minuszeichen vorn ist bei Texten gefährlich, nicht aber bei Zahlen: negative Gewinne bleiben Zahlen
    const loss = await s.item({ title: 'Verlust', status: 'verkauft', purchase_price: 20, sold_price: 5 });
    try { assert.equal(parseExport((await exp()).text).find(r => r[0] === String(loss))[HEADER.indexOf('Gewinn')], '-15,00'); } finally { await s.del('/api/items/' + loss); }
  });

  test('Bilderanzahl steht in der letzten Spalte', async () => {
    const id = await s.item({ title: 'Mit Bildern' });
    try {
      await s.upload(`/api/items/${id}/images`, 'images', [{ name: 'a.png', data: png(1) }, { name: 'b.png', data: png(2) }]);
      const row = parseExport((await exp()).text).find(r => r[0] === String(id));
      assert.equal(row[HEADER.indexOf('Bilder')], '2');
    } finally { await s.del('/api/items/' + id); }
  });
});

describe('Export: Auswahl', () => {
  test('scope: alle, nur verkauft, nur unverkauft', async () => {
    assert.equal((await titles()).length, 7);
    assert.deepEqual((await titles({ scope: 'all' })).length, 7);
    assert.deepEqual(await titles({ scope: 'sold' }), ['Shirt; "blau"', 'Jacke', 'Ohne Datum'], 'Status ab "zu versenden" mit Verkaufspreis');
    assert.deepEqual(await titles({ scope: 'unsold' }), ["'=SUMME(A1)", "'+49 Hose", 'Reserviert'], 'Lager, Online, Reserviert');
  });

  test('Dateiname verrät die Auswahl', async () => {
    const name = async q => (await exp(q)).headers.get('content-disposition').match(/filename="(.+)"/)[1];
    assert.equal(await name({ scope: 'sold' }), `reseller-export-verkauft-${today()}.csv`);
    assert.equal(await name({ scope: 'unsold' }), `reseller-export-unverkauft-${today()}.csv`);
    assert.equal(await name({ from: '2026-03-01', to: '2026-03-31' }), 'reseller-export-2026-03-01_bis_2026-03-31.csv');
    assert.equal(await name({ from: '2026-03-01' }), `reseller-export-2026-03-01_bis_${today()}.csv`);
    assert.equal(await name({ to: '2026-03-31', scope: 'sold' }), 'reseller-export-verkauft-anfang_bis_2026-03-31.csv');
  });

  test('Zeitraum nach Verkaufsdatum (Standard): Artikel ohne Verkauf fallen heraus', async () => {
    assert.deepEqual(await titles({ from: '2026-03-01', to: '2026-03-31' }), ['Shirt; "blau"']);
    assert.deepEqual(await titles({ from: '2026-04-01', to: '2026-04-30' }), ['Jacke']);
    assert.deepEqual(await titles({ from: '2026-03-10', to: '2026-04-05' }), ['Shirt; "blau"', 'Jacke'], 'Grenzen gelten einschließlich');
    assert.deepEqual(await titles({ from: '2026-03-11', to: '2026-04-04' }), []);
    assert.deepEqual(await titles({ from: '2026-04-01' }), ['Jacke', 'Ohne Datum'], 'nur "von": offen nach oben; Verkauf ohne Datum zählt am Tag des Anlegens');
    assert.deepEqual(await titles({ to: '2026-03-31' }), ['Shirt; "blau"']);
  });

  test('Zeitraum nach Kaufdatum', async () => {
    assert.deepEqual(await titles({ by: 'purchase', from: '2026-03-01', to: '2026-03-31' }), ['Shirt; "blau"', "'=SUMME(A1)", 'Verkauft ohne Preis']);
    assert.deepEqual(await titles({ by: 'purchase', to: '2026-02-28' }), ['Jacke']);
    assert.deepEqual(await titles({ by: 'purchase', from: '2026-03-01', to: '2026-03-31', scope: 'unsold' }), ["'=SUMME(A1)"]);
    assert.deepEqual(await titles({ by: 'purchase', from: '2026-03-01', scope: 'sold' }), ['Shirt; "blau"']);
  });

  test('Leere Datumsparameter werden ignoriert', async () => {
    assert.equal((await titles({ from: '', to: '' })).length, 7);
  });

  test('Ungültige Parameter ergeben 400 mit Meldung', async () => {
    const bad = [
      [{ scope: 'alle' }, /Auswahl/], [{ by: 'x' }, /Datumsart/],
      [{ from: '2026-02-30' }, /Datum \(from\)/], [{ to: '31.03.2026' }, /Datum \(to\)/], [{ from: 'abc' }, /Datum/],
      [{ from: '2026-04-01', to: '2026-03-01' }, /liegt nach/]
    ];
    for (const [q, msg] of bad) {
      const r = await exp(q);
      assert.equal(r.status, 400, JSON.stringify(q));
      assert.match(r.json.error, msg, JSON.stringify(q));
    }
    const dup = await s.request('GET', '/api/export.csv?from=2026-01-01&from=2026-02-01');
    assert.equal(dup.status, 400, 'doppelter Parameter');
    assert.equal((await s.request('GET', '/api/export.csv?scope[]=sold')).status, 400);
  });

  test('Schaltjahr: 29.02. nur im Schaltjahr gültig', async () => {
    assert.equal((await exp({ from: '2028-02-29' })).status, 200);
    assert.equal((await exp({ from: '2027-02-29' })).status, 400);
  });
});

describe('Import: Vorschau und Anlegen', () => {
  const csv = (text) => ({ body: text, headers: { 'content-type': 'text/csv' } });
  const SAMPLE = [
    'Titel;Einkaufspreis;Verkaufspreis;Status;Gekauft am;Verkauft am;Plattform',
    'Pulli;5,00;20,00;Verkauft;01.03.2026;10.03.2026;Vinted',
    'Mütze;3,5;;;02.03.2026;;',
    ';1;;;;;',
    'Schal;abc;;;;;'
  ].join('\r\n');
  let t;
  before(async () => { t = await startServer(); });
  after(() => t.stop());
  const post = (q, text = SAMPLE) => t.request('POST', '/api/import.csv', { ...csv(text), query: q });

  test('Vorschau (dry=1) legt nichts an und meldet Fehlerzeilen wie in Excel nummeriert', async () => {
    const r = await post({ dry: 1 });
    assert.equal(r.status, 200);
    assert.equal(r.json.dry, true);
    assert.equal(r.json.delimiter, ';');
    assert.equal(r.json.total, 4);
    assert.equal(r.json.valid, 2);
    assert.equal(r.json.errorCount, 2);
    assert.equal(r.json.toImport, 2);
    assert.deepEqual(r.json.errors.map(e => e.row), [4, 5]);
    assert.match(r.json.errors[0].message, /Titel fehlt/);
    assert.match(r.json.errors[1].message, /Einkaufspreis/);
    assert.equal(r.json.imported, undefined);
    assert.deepEqual(r.json.sample.map(x => x.title), ['Pulli', 'Mütze']);
    assert.deepEqual((await t.get('/api/items')).json, []);
  });

  test('Import legt gültige Zeilen an, Fehlerzeilen werden übersprungen', async () => {
    const r = await post({});
    assert.equal(r.status, 200);
    assert.equal(r.json.imported, 2);
    assert.equal(r.json.skippedErrors, 2);
    assert.equal(r.json.skippedDuplicates, 0);
    const items = (await t.get('/api/items')).json.reverse();
    assert.equal(items.length, 2);
    const [pulli, muetze] = items;
    assert.equal(pulli.title, 'Pulli');
    assert.equal(pulli.status, 'verkauft');
    assert.equal(pulli.purchase_price, 5);
    assert.equal(pulli.sold_price, 20);
    assert.equal(pulli.purchase_date, '2026-03-01');
    assert.equal(pulli.sold_date, '2026-03-10');
    assert.equal(pulli.platform, 'Vinted');
    assert.equal(pulli.payment_status, 'offen');
    assert.equal(pulli.fees, 0);
    assert.equal(muetze.status, 'lager', 'ohne Verkaufspreis und ohne Status: Lager');
    assert.equal(muetze.purchase_price, 3.5);
    assert.equal(muetze.sold_price, null);
  });

  test('Gleiche Datei noch einmal: Duplikate werden übersprungen', async () => {
    const dry = await post({ dry: 1 });
    assert.equal(dry.json.duplicates, 2);
    assert.equal(dry.json.toImport, 0);
    const r = await post({});
    assert.equal(r.json.imported, 0);
    assert.equal(r.json.skippedDuplicates, 2);
    assert.equal((await t.get('/api/items')).json.length, 2);
  });

  test('skipDuplicates=0 legt trotzdem an', async () => {
    const r = await post({ skipDuplicates: 0 });
    assert.equal(r.json.imported, 2);
    assert.equal(r.json.skippedDuplicates, 0);
    assert.equal((await t.get('/api/items')).json.length, 4);
  });

  test('Dateien, die keine passende CSV sind, werden mit 4xx abgelehnt', async () => {
    const cases = {
      'ohne Spalte Titel': 'Name2;Preis\nA;1',
      'nur Leerzeichen': '   \n',
      'Excel-Datei (ZIP)': 'PK\u0003\u0004 rest',
      'Binärdaten': 'Titel\u0000;x\nA;1',
      'offenes Anführungszeichen': 'Titel;Notizen\nA;"offen'
    };
    for (const [name, text] of Object.entries(cases)) {
      const r = await post({ dry: 1 }, text);
      assert.ok(r.status >= 400 && r.status < 500, `${name}: ${r.status}`);
      assert.ok(r.json.error, name);
    }
    const empty = await t.request('POST', '/api/import.csv', { body: '', headers: { 'content-type': 'text/csv' } });
    assert.ok(empty.status >= 400 && empty.status < 500, `leer: ${empty.status}`);
    assert.equal((await t.get('/api/items')).json.length, 4, 'nichts angelegt');
  });

  test('Zu viele Zeilen und zu große Datei', async () => {
    const rows = ['Titel'];
    for (let i = 0; i < 5001; i++) rows.push('A' + i);
    const many = await post({ dry: 1 }, rows.join('\n'));
    assert.equal(many.status, 400);
    assert.match(many.json.error, /Zu viele Zeilen/);
    rows.pop();
    assert.equal((await post({ dry: 1 }, rows.join('\n'))).json.valid, 5000, 'genau 5000 Zeilen sind erlaubt');
    const huge = await t.request('POST', '/api/import.csv', { body: 'Titel\n' + 'x'.repeat(5.2 * 1024 * 1024), headers: { 'content-type': 'text/csv' }, query: { dry: 1 } });
    assert.equal(huge.status, 413);
    assert.equal((await t.get('/healthz')).status, 200);
  });

  test('Zeichensatz Windows-1252 (Excel) und UTF-16 werden erkannt', async () => {
    const win = Buffer.concat([Buffer.from('Titel;Notizen\nK', 'latin1'), Buffer.from([0xE4]), Buffer.from('ppi;', 'latin1'), Buffer.from([0x80]), Buffer.from('\n', 'latin1')]);
    const r1 = await t.request('POST', '/api/import.csv', { body: win, headers: { 'content-type': 'text/csv' } });
    assert.equal(r1.status, 200, r1.text);
    const utf16 = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('Titel\tNotizen\nSchäl\tGrün\n', 'utf16le')]);
    const r2 = await t.request('POST', '/api/import.csv', { body: utf16, headers: { 'content-type': 'text/csv' } });
    assert.equal(r2.status, 200, r2.text);
    assert.equal(r2.json.delimiter, 'tab');
    const all = (await t.get('/api/items')).json;
    const kaeppi = all.find(i => i.title === 'Käppi');
    assert.ok(kaeppi, 'Umlaut aus Windows-1252');
    assert.equal(kaeppi.notes, '€', 'Euro-Zeichen aus Windows-1252');
    const schal = all.find(i => i.title === 'Schäl');
    assert.equal(schal.notes, 'Grün');
  });

  test('Formeln und HTML bleiben Text', async () => {
    const r = await post({}, 'Titel;Notizen\n"<img src=x onerror=alert(1)>";"=HYPERLINK(""http://x"")"');
    assert.equal(r.json.imported, 1);
    const it = (await t.get('/api/items')).json.find(i => i.title.startsWith('<img'));
    assert.equal(it.notes, '=HYPERLINK("http://x")');
  });

  test('Anfrage ohne Text-Body (z. B. JSON) bricht nichts', async () => {
    const r = await t.post('/api/import.csv', { titel: 'x' });
    assert.ok(r.status < 500, String(r.status));
  });
});

describe('Rundlauf: Export -> Import in eine zweite Instanz', () => {
  test('Alle Felder kommen unverändert an (Zeilenumbruch in Notizen wird zum Leerzeichen)', async () => {
    const t = await startServer();
    try {
      const exported = (await exp()).buf;
      const dry = await t.request('POST', '/api/import.csv', { body: exported, headers: { 'content-type': 'text/csv' }, query: { dry: 1 } });
      assert.equal(dry.json.errorCount, 0, JSON.stringify(dry.json.errors));
      assert.equal(dry.json.valid, 7);
      const r = await t.request('POST', '/api/import.csv', { body: exported, headers: { 'content-type': 'text/csv' } });
      assert.equal(r.json.imported, 7);
      const strip = it => { const { id, created_at, images, ...rest } = it; return rest; };
      const src = (await s.get('/api/items')).json.map(strip);
      const dst = (await t.get('/api/items')).json.map(strip);
      assert.equal(dst.length, 7);
      const by = list => Object.fromEntries(list.map(i => [i.title, i]));
      const a = by(src), b = by(dst);
      assert.deepEqual(Object.keys(b).sort(), Object.keys(a).sort());
      for (const title of Object.keys(a)) {
        const want = { ...a[title] };
        if (want.notes) want.notes = want.notes.replace(/\n/g, ' ');
        // Der Import setzt für leere Zahlenfelder 0 bzw. null; hier zählt, dass nichts Vorhandenes verloren geht
        for (const [k, v] of Object.entries(want)) {
          if (v === null || v === '' || v === 0 || v === 'offen') continue;
          assert.deepEqual(b[title][k], v, `${title}.${k}`);
        }
      }
      // Auswertung ist auf beiden Seiten gleich
      const sa = (await s.get('/api/stats')).json.totals, sb = (await t.get('/api/stats')).json.totals;
      for (const k of ['sold', 'unsold', 'revenue', 'cost', 'fees', 'profit', 'stockValue']) assert.equal(sb[k], sa[k], k);
    } finally { await t.stop(); }
  });
});
