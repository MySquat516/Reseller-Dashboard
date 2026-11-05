const test = require('node:test');
const assert = require('node:assert/strict');
const { analyze, parseCsv, parseMoney, parseDate, detectDelimiter, decode, dupKey } = require('../csvimport');

const STATUSES = ['lager', 'online', 'reserviert', 'zu_versenden', 'versendet', 'verkauft'];
const SOLD_STATUSES = ['zu_versenden', 'versendet', 'verkauft'];
const validDay = v => { if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false; const d = new Date(v + 'T00:00:00Z'); return !isNaN(d) && d.toISOString().slice(0, 10) === v; };
const run = (text, existing) => analyze(Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8'), { existing, STATUSES, SOLD_STATUSES, validDay });
const throwsMsg = (fn, re) => assert.throws(fn, e => re.test(e.message));

test('Zahlen: deutsche und englische Schreibweisen', () => {
  const ok = { '12': 12, '12,5': 12.5, '12,50': 12.5, '12.5': 12.5, '12.50': 12.5, '1.234,56': 1234.56, '1,234.56': 1234.56,
    '1.234': 1234, '12,500': 12500, '1.234.567': 1234567, '12 €': 12, '€ 12,00': 12, '12 EUR': 12, '12,00 Euro': 12, '0,5': 0.5, '0.5': 0.5,
    '  7  ': 7, '+5': 5, '-0': 0, '3,99': 3.99, '1 234,50': 1234.5, "1'234.50": 1234.5 };
  for (const [raw, want] of Object.entries(ok)) assert.equal(parseMoney(raw).value, want, raw);
  assert.equal(parseMoney('').value, null);
  assert.equal(parseMoney('  ').value, null);
});

test('Zahlen: ungültige Eingaben', () => {
  for (const raw of ['abc', '12abc', '-5', '-5,00', '1,2,3', '1.2.3', '12,345.6,7', '0,125', '0.125', '1.5.0', ',', '.', '99999999', '1.234,5,6', '1234.567,89'])
    assert.ok(parseMoney(raw).error, raw);
});

test('Datum: Formate', () => {
  const ok = { '2026-03-05': '2026-03-05', '2026-3-5': '2026-03-05', '05.03.2026': '2026-03-05', '5.3.2026': '2026-03-05', '5.3.26': '2026-03-05',
    '05/03/2026': '2026-03-05', '2026-03-05 14:30': '2026-03-05', '2026-03-05T14:30:00Z': '2026-03-05', '05.03.2026 14:30': '2026-03-05',
    '29.02.2028': '2028-02-29', '2026-03-05T14:30:00.123+01:00': '2026-03-05' };
  for (const [raw, want] of Object.entries(ok)) assert.equal(parseDate(raw, validDay).value, want, raw);
  assert.equal(parseDate('', validDay).value, null);
  for (const raw of ['30.02.2026', '2026-02-30', '31.04.2026', '13.13.2026', 'gestern', '2026', '1.1.', '01.01.1850', '01.01.2500', '45678', '2026-03-05 25:99x'])
    assert.ok(parseDate(raw, validDay).error, raw);
});

test('Parser: Anführungszeichen, Zeilenumbrüche, leere Zeilen, Zeilennummern', () => {
  const rows = parseCsv('a;b;c\r\n"x;y";"he said ""hi""";"line1\nline2"\n\n1;2;3', ';');
  assert.deepEqual(rows.map(r => r.no), [1, 2, 4]);      // Leerzeile zählt mit
  assert.deepEqual(rows[1].cells, ['x;y', 'he said "hi"', 'line1\nline2']);
  assert.deepEqual(rows[2].cells, ['1', '2', '3']);
  assert.deepEqual(parseCsv('a;b\n1;2\n', ';').length, 2);               // abschließender Zeilenumbruch erzeugt keine Zeile
  assert.deepEqual(parseCsv('a;b\r1;2\r', ';').length, 2);               // alte Mac-Zeilenenden
  assert.deepEqual(parseCsv(';;\n \n;a;', ';').map(r => r.no), [3]);     // komplett leere Zeilen fehlen
  throwsMsg(() => parseCsv('a;b\n"offen;1', ';'), /Anführungszeichen/);
});

test('Trennzeichen-Erkennung', () => {
  assert.equal(detectDelimiter('Titel;Marke;EK\n1;2;3'), ';');
  assert.equal(detectDelimiter('Titel,Marke,EK\n1,2,3'), ',');
  assert.equal(detectDelimiter('Titel\tMarke\tEK\n1\t2\t3'), '\t');
  assert.equal(detectDelimiter('Titel\n"a,b"'), ';');
  assert.equal(detectDelimiter('"Titel; mit Semikolon",Marke,EK\n'), ',');
});

test('Zeichensatz: UTF-8, BOM, Windows-1252, UTF-16', () => {
  assert.equal(decode(Buffer.from('Größe;Käufer')).encoding, 'UTF-8');
  assert.equal(decode(Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('Größe')])).text, 'Größe');
  const w = decode(Buffer.from([0x47, 0x72, 0xF6, 0xDF, 0x65, 0x3B, 0x4B, 0xE4, 0x75, 0x66, 0x65, 0x72]));   // "Größe;Käufer" in cp1252
  assert.equal(w.encoding, 'Windows-1252'); assert.equal(w.text, 'Größe;Käufer');
  const euro = decode(Buffer.from([0x31, 0x32, 0x80, 0x20, 0x84, 0x93, 0x94, 0x96, 0x85, 0x99]));   // 12€ „“”–…™
  assert.equal(euro.encoding, 'Windows-1252'); assert.equal(euro.text, '12€ „“”–…™');
  assert.equal(decode(Buffer.alloc(40000, 0xE4)).text, 'ä'.repeat(40000));   // große Dateien
  const le = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('Größe;€', 'utf16le')]);
  assert.equal(decode(le).text, 'Größe;€');
  const be = Buffer.from(Buffer.from('Größe;€', 'utf16le')).swap16();
  assert.equal(decode(Buffer.concat([Buffer.from([0xFE, 0xFF]), be])).text, 'Größe;€');
  throwsMsg(() => decode(Buffer.from([0x50, 0x4B, 3, 4, 0])), /xlsx/);
  throwsMsg(() => decode(Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0])), /\.xls/);
  throwsMsg(() => decode(Buffer.from([0x41, 0, 0x42, 0])), /keine Textdatei/);
});

test('Spalten: Aliase, Umlaute, unbekannte und berechnete Spalten', () => {
  const a = run('ARTIKEL;Größe;EK;VK-Preis;Käufer;Foo;ID;Gewinn;Bilder;Titel\nJacke;M;10;;Max;x;5;1;2;Doppelt');
  const fields = Object.fromEntries(a.mapped.map(m => [m.field, m.header]));
  assert.equal(fields.title, 'ARTIKEL'); assert.equal(fields.size, 'Größe'); assert.equal(fields.purchase_price, 'EK'); assert.equal(fields.buyer, 'Käufer');
  assert.equal(fields.sold_price, 'VK-Preis');        // Bindestrich und Groß-/Kleinschreibung spielen keine Rolle
  assert.deepEqual(a.ignored.sort(), ['Foo', 'Titel']);  // unbekannt + doppelte Titel-Spalte; ID/Gewinn/Bilder stillschweigend
  assert.equal(a.rows[0].item.title, 'Jacke');
});

test('Spalten: VK-Preis wird erkannt', () => {
  const a = run('Titel;VK-Preis\nJacke;20');
  assert.equal(a.rows[0].item.sold_price, 20);
});

test('Ohne Titel-Spalte: Fehler mit Liste der gefundenen Überschriften', () => {
  assert.throws(() => run('Marke;EK\nNike;5'), e => /Titel/.test(e.message) && e.headers.join() === 'Marke,EK');
  throwsMsg(() => run(''), /leer/);
  throwsMsg(() => run('\n\n'), /keine Zeilen/);
});

test('Zeilen: Fehler je Zeile, gültige bleiben', () => {
  const a = run('Titel;EK;Gekauft am;Status\nOK;5;01.02.2026;Lager\n;5;;\nFalsch;abc;;\nDatum;5;31.02.2026;\nStatus;5;;Kaputt\nAuchOK;7,50;;online');
  assert.equal(a.valid, 2); assert.equal(a.errorCount, 4); assert.equal(a.total, 6);
  assert.deepEqual(a.errors.map(e => e.row), [3, 4, 5, 6]);
  assert.match(a.errors[0].message, /Titel fehlt/);
  assert.match(a.errors[1].message, /Einkaufspreis.*keine Zahl/);
  assert.match(a.errors[2].message, /Gekauft am.*Kalender/);
  assert.match(a.errors[3].message, /Status.*unbekannt/);
  assert.equal(a.rows[1].item.purchase_price, 7.5); assert.equal(a.rows[1].item.status, 'online');
});

test('Zeilen: mehrere Fehler in einer Zeile werden zusammen gemeldet', () => {
  const a = run('Titel;EK;VK\nX;a;b');
  assert.equal(a.errorCount, 1); assert.match(a.errors[0].message, /Einkaufspreis.*Verkaufspreis/);
});

test('Zeilen mit zu vielen Werten', () => {
  const a = run('Titel;Marke\nJacke;Nike;Zusatz\nHose;Adidas;;\nMütze');
  assert.equal(a.errorCount, 1); assert.equal(a.errors[0].row, 2); assert.match(a.errors[0].message, /Anführungszeichen/);
  assert.equal(a.valid, 2);                            // leere Zusatzspalten und fehlende Werte sind erlaubt
});

test('Status: Schreibweisen und Ableitung', () => {
  const a = run('Titel;Status;VK\nA;Noch nicht versendet;1\nB;zu versenden;1\nC;GEKAUFT;1\nD;Verkauft;1\nE;;5\nF;;\nG;Online;\nH;zu_versenden;3\nI;Abgeschlossen;3\nJ;unterwegs;3');
  assert.deepEqual(a.rows.map(r => r.item.status), ['zu_versenden', 'zu_versenden', 'zu_versenden', 'verkauft', 'verkauft', 'lager', 'online', 'zu_versenden', 'verkauft', 'versendet']);
});

test('Warnungen: Verkauf ohne Preis/Datum, Preis ohne Verkaufsstatus, Datum davor', () => {
  const a = run('Titel;Status;VK;Verkauft am;Gekauft am\nA;Verkauft;;;\nB;Lager;9;;\nC;Verkauft;9;;\nD;Verkauft;9;01.01.2026;01.02.2026\nE;Verkauft;9;02.02.2026;01.02.2026');
  const byRow = Object.fromEntries(a.warnings.map(w => [w.row, w.message]));
  assert.match(byRow[2], /ohne Verkaufspreis/); assert.match(byRow[3], /ohne Verkaufsstatus/); assert.match(byRow[4], /Verkaufsdatum fehlt/);
  assert.match(byRow[5], /vor dem Kaufdatum/); assert.equal(byRow[6], undefined);
  assert.equal(a.errorCount, 0); assert.equal(a.valid, 5);     // Warnungen verhindern den Import nicht
});

test('Zahlungsstatus', () => {
  const a = run('Titel;Zahlungsstatus\nA;bezahlt\nB;Offen\nC;vielleicht\nD;');
  assert.deepEqual(a.rows.map(r => r.item.payment_status), ['bezahlt', 'offen', undefined, undefined]);
  assert.equal(a.warningCount, 1);
});

test('Text: Formel-Schutzzeichen weg, Zeilenumbrüche bleiben, Länge begrenzt', () => {
  const a = run(`Titel;Notizen;Marke\n"'=Summe";"a\r\nb";'Nike\n${'x'.repeat(301)};;\nok;${'n'.repeat(5001)};`);
  assert.equal(a.rows[0].item.title, '=Summe'); assert.equal(a.rows[0].item.notes, 'a\nb'); assert.equal(a.rows[0].item.brand, "'Nike");
  assert.equal(a.errorCount, 2); assert.match(a.errors[0].message, /Titel ist zu lang/); assert.match(a.errors[1].message, /Notizen ist zu lang/);
});

test('Duplikate: gegen Bestand abgezählt, gleiche Zeilen in der Datei sind erlaubt', () => {
  const key = dupKey('Socken', 2, '2026-05-01');
  const csv = 'Titel;EK;Gekauft am\nSocken;2;01.05.2026\nsocken ;2,00;2026-05-01\nSocken;2;01.05.2026\nSocken;3;01.05.2026\nAnders;2;01.05.2026';
  const none = run(csv);
  assert.equal(none.duplicates, 0);
  const one = run(csv, new Map([[key, 1]]));
  assert.deepEqual(one.rows.map(r => r.duplicate), [true, false, false, false, false]);
  const three = run(csv, new Map([[key, 3]]));
  assert.deepEqual(three.rows.map(r => r.duplicate), [true, true, true, false, false]); assert.equal(three.duplicates, 3);
  assert.equal(dupKey('A  B', null, null), dupKey('a b', 0, ''));
});

test('Eigener Export wird wieder eingelesen', () => {
  const head = 'ID;Titel;Beschreibung;Größe;Kategorie;Marke;Zustand;Status;Einkaufspreis;Gekauft am;Einstellpreis;Online seit;Verkaufspreis;Verkauft am;Plattform;Käufer;Zahlungsart;Zahlungsstatus;Gebühren;Versandkosten;Gewinn;Versandanbieter;Sendungsnummer;Notizen;Bilder';
  const row = '7;"Jacke ""Alpha""";Warm;M;Jacken;Nike;Gut;verkauft;10,00;2026-01-05;40,00;2026-01-10;35,50;2026-02-01;Vinted;Max;PayPal;bezahlt;1,50;4,99;19,01;DHL;JVGL123;Neu;3';
  const a = run('﻿' + head + '\r\n' + row + '\r\n');
  assert.equal(a.errorCount, 0, JSON.stringify(a.errors));
  const it = a.rows[0].item;
  assert.deepEqual(it, { title: 'Jacke "Alpha"', description: 'Warm', size: 'M', category: 'Jacken', brand: 'Nike', condition: 'Gut', status: 'verkauft',
    purchase_price: 10, purchase_date: '2026-01-05', listing_price: 40, listed_date: '2026-01-10', sold_price: 35.5, sold_date: '2026-02-01', platform: 'Vinted',
    buyer: 'Max', payment_method: 'PayPal', payment_status: 'bezahlt', fees: 1.5, shipping_cost: 4.99, carrier: 'DHL', tracking_number: 'JVGL123', notes: 'Neu' });
  assert.deepEqual(a.ignored, []);                    // ID, Gewinn, Bilder sind bekannt und werden still übergangen
});

test('Limit: höchstens 5000 Artikel', () => {
  const ok = 'Titel\n' + Array.from({ length: 5000 }, (_, i) => 'A' + i).join('\n');
  assert.equal(run(ok).valid, 5000);
  throwsMsg(() => run(ok + '\nZuviel'), /Zu viele Zeilen/);
});

test('Fehlerliste wird begrenzt, Zählung bleibt exakt', () => {
  const a = run('Titel;EK\n' + Array.from({ length: 500 }, (_, i) => `A${i};x`).join('\n'));
  assert.equal(a.errorCount, 500); assert.equal(a.errors.length, 200);
});

test('sep=-Hinweiszeile von Excel', () => {
  const a = run('sep=,\r\nTitel,EK\r\nJacke,5');
  assert.equal(a.delimiter, ','); assert.equal(a.rows[0].item.purchase_price, 5); assert.equal(a.rows[0].no, 2);
});

test('Nur Titel-Spalte, Kopfzeile ohne Trennzeichen', () => {
  const a = run('Titel\nJacke, blau\nHose');
  assert.deepEqual(a.rows.map(r => r.item.title), ['Jacke, blau', 'Hose']);
});

test('Tab-getrennt aus Google Sheets', () => {
  const a = run('Titel\tEK\tGekauft am\nJacke\t12,5\t3.4.2026');
  assert.equal(a.delimiter, '\t'); assert.deepEqual([a.rows[0].item.purchase_price, a.rows[0].item.purchase_date], [12.5, '2026-04-03']);
});
