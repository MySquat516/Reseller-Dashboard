// Artikel, Versandvorlagen, Einstellungen und Bilder gegen den echten Server.
const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, png, MAGIC, sleep } = require('../testlib/harness');

let s;
before(async () => { s = await startServer(); });
after(() => s.stop());

const uploads = () => fs.readdirSync(path.join(s.dataDir, 'uploads'));
async function waitFor(fn, ms = 2000) {
  const t = Date.now();
  while (Date.now() - t < ms) { if (fn()) return true; await sleep(20); }
  return fn();
}

describe('Grundlagen', () => {
  test('Healthcheck antwortet ohne Daten', async () => {
    const r = await s.get('/healthz');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true });
  });

  test('Sicherheits-Header gesetzt, kein X-Powered-By', async () => {
    for (const p of ['/healthz', '/api/items', '/']) {
      const r = await s.get(p);
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff', p);
      assert.equal(r.headers.get('referrer-policy'), 'same-origin', p);
      assert.equal(r.headers.get('x-powered-by'), null, p);
    }
  });

  test('Oberfläche und Chart.js werden ausgeliefert', async () => {
    const page = await s.get('/');
    assert.equal(page.status, 200);
    assert.match(page.text, /<html/i);
    const chart = await s.get('/vendor/chart.js/chart.umd.js');
    assert.equal(chart.status, 200);
    assert.ok(chart.buf.length > 50000);
  });

  test('Datenordner ist nicht über den Webserver erreichbar', async () => {
    for (const p of ['/reseller.db', '/data/reseller.db', '/uploads/%2e%2e%2freseller.db', '/uploads/..%2f..%2fserver.js']) {
      const r = await s.get(p);
      assert.notEqual(r.status, 200, p);
      assert.ok(!r.buf.subarray(0, 15).equals(Buffer.from('SQLite format 3')), p);
    }
    assert.equal((await s.get('/uploads/')).status, 404, 'kein Verzeichnislisting');
  });
});

describe('Artikel', () => {
  beforeEach(() => s.reset());

  test('Anlegen mit Standardwerten und Abrufen', async () => {
    const r = await s.post('/api/items', { title: 'Jacke' });
    assert.equal(r.status, 201);
    assert.equal(typeof r.json.id, 'number');
    const it = (await s.get('/api/items/' + r.json.id)).json;
    assert.equal(it.title, 'Jacke');
    assert.equal(it.status, 'lager');
    assert.equal(it.payment_status, 'offen');
    assert.equal(it.purchase_price, 0);
    assert.equal(it.sold_price, null);
    assert.deepEqual(it.images, []);
    assert.match(it.created_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  test('Titel ist Pflicht (auch nur Leerzeichen zählen nicht)', async () => {
    for (const body of [{}, { title: '' }, { title: '   ' }, { description: 'ohne Titel' }]) {
      const r = await s.post('/api/items', body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.json.error, 'Titel fehlt');
    }
    assert.deepEqual((await s.get('/api/items')).json, []);
  });

  test('Texte werden gekürzt, leere Datumsfelder werden null', async () => {
    const id = await s.item({ title: '  Mütze  ', brand: ' Nike ', purchase_date: '', sold_date: '   ' });
    const it = (await s.get('/api/items/' + id)).json;
    assert.equal(it.title, 'Mütze');
    assert.equal(it.brand, 'Nike');
    assert.equal(it.purchase_date, null);
    assert.equal(it.sold_date, null);
  });

  test('Zahlen: Strings werden gewandelt, Unbrauchbares wird null', async () => {
    const id = await s.item({ title: 'X', purchase_price: '12.5', listing_price: '', sold_price: 'abc', fees: null, shipping_cost: '3' });
    const it = (await s.get('/api/items/' + id)).json;
    assert.equal(it.purchase_price, 12.5);
    assert.equal(it.listing_price, null);
    assert.equal(it.sold_price, null);
    assert.equal(it.fees, null);
    assert.equal(it.shipping_cost, 3);
  });

  test('Ungültiger Status wird ignoriert', async () => {
    const id = await s.item({ title: 'X', status: 'quatsch' });
    assert.equal((await s.get('/api/items/' + id)).json.status, 'lager');
    await s.put('/api/items/' + id, { status: 'online' });
    await s.put('/api/items/' + id, { status: 'gibts-nicht', notes: 'n' });
    const it = (await s.get('/api/items/' + id)).json;
    assert.equal(it.status, 'online');
    assert.equal(it.notes, 'n');
  });

  test('Alle sechs Status sind erlaubt', async () => {
    for (const status of ['lager', 'online', 'reserviert', 'zu_versenden', 'versendet', 'verkauft']) {
      const id = await s.item({ title: status, status });
      assert.equal((await s.get('/api/items/' + id)).json.status, status);
    }
  });

  test('Unbekannte Felder und eine mitgeschickte ID werden ignoriert', async () => {
    const id = await s.item({ title: 'A', id: 9999, hack: 'x', created_at: '1999-01-01 00:00:00' });
    assert.notEqual(id, 9999);
    const it = (await s.get('/api/items/' + id)).json;
    assert.equal(it.hack, undefined);
    assert.notEqual(it.created_at, '1999-01-01 00:00:00');
    const upd = await s.put('/api/items/' + id, { id: 5, title: 'B' });
    assert.equal(upd.status, 200);
    assert.equal((await s.get('/api/items/' + id)).json.title, 'B');
    assert.equal((await s.get('/api/items/5')).status, 404);
  });

  test('Sonderzeichen und SQL-Schnipsel werden unverändert gespeichert', async () => {
    const title = `Robert'); DROP TABLE items;-- "ä" <b>x</b>`;
    const id = await s.item({ title, notes: '😀 Emoji\nZeile 2' });
    const it = (await s.get('/api/items/' + id)).json;
    assert.equal(it.title, title);
    assert.equal(it.notes, '😀 Emoji\nZeile 2');
    assert.equal((await s.get('/api/items')).json.length, 1);
  });

  test('Ändern: nur gesendete Felder, Rest bleibt', async () => {
    const id = await s.item({ title: 'A', brand: 'B', purchase_price: 5 });
    assert.equal((await s.put('/api/items/' + id, { sold_price: 20, status: 'verkauft' })).status, 200);
    const it = (await s.get('/api/items/' + id)).json;
    assert.equal(it.title, 'A');
    assert.equal(it.brand, 'B');
    assert.equal(it.purchase_price, 5);
    assert.equal(it.sold_price, 20);
    assert.equal(it.status, 'verkauft');
  });

  test('Ändern: leerer Body 400, unbekannte ID 404', async () => {
    const id = await s.item({ title: 'A' });
    assert.equal((await s.put('/api/items/' + id, {})).status, 400);
    assert.equal((await s.put('/api/items/' + id, { nonsense: 1 })).status, 400);
    assert.equal((await s.put('/api/items/99999', { title: 'x' })).status, 404);
  });

  test('Liste: neueste zuerst', async () => {
    const a = await s.item({ title: 'a' });
    const b = await s.item({ title: 'b' });
    const c = await s.item({ title: 'c' });
    assert.deepEqual((await s.get('/api/items')).json.map(i => i.id), [c, b, a]);
  });

  test('Unbekannte IDs: 404 bei Abruf, Löschen und Kopieren; Text als ID bricht nichts', async () => {
    assert.equal((await s.get('/api/items/99999')).status, 404);
    assert.equal((await s.del('/api/items/99999')).status, 404);
    assert.equal((await s.post('/api/items/99999/duplicate')).status, 404);
    assert.equal((await s.get('/api/items/abc')).status, 404);
    assert.equal((await s.put('/api/items/abc', { title: 'x' })).status, 404);
    assert.equal((await s.get('/healthz')).status, 200);
  });

  test('Löschen', async () => {
    const id = await s.item({ title: 'A' });
    assert.deepEqual((await s.del('/api/items/' + id)).json, { ok: true });
    assert.equal((await s.get('/api/items/' + id)).status, 404);
  });

  test('Kaputtes JSON ergibt 400, zu großer Body 413 (keine 500)', async () => {
    const bad = await s.request('POST', '/api/items', { body: '{"title": ', headers: { 'content-type': 'application/json' } });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, 'Ungültiges JSON');
    const big = await s.post('/api/items', { title: 'x', notes: 'a'.repeat(1.2 * 1024 * 1024) });
    assert.equal(big.status, 413);
    assert.equal(big.json.error, 'Anfrage zu groß');
    assert.equal((await s.get('/healthz')).status, 200);
  });

  test('Body ohne JSON-Header: kein Absturz', async () => {
    const r = await s.request('POST', '/api/items', { body: 'title=A', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert.ok(r.status >= 400 && r.status < 500, String(r.status));
    assert.equal((await s.get('/healthz')).status, 200);
  });
});

describe('Kopieren', () => {
  beforeEach(() => s.reset());

  test('Kopie startet als neuer Artikel im Lager', async () => {
    const id = await s.item({
      title: 'Hoodie', description: 'warm', size: 'M', category: 'Pullover', brand: 'Nike', condition: 'gut',
      purchase_price: 8, purchase_date: '2026-01-02', listing_price: 25, notes: 'Notiz',
      status: 'verkauft', sold_price: 30, sold_date: '2026-02-01', platform: 'Vinted', buyer: 'Anna', fees: 2, shipping_cost: 4,
      payment_status: 'bezahlt', carrier: 'DHL', tracking_number: '123', listed_date: '2026-01-05'
    });
    const r = await s.post(`/api/items/${id}/duplicate`);
    assert.equal(r.status, 201);
    assert.notEqual(r.json.id, id);
    assert.equal(r.json.images, 0);
    const c = (await s.get('/api/items/' + r.json.id)).json;
    assert.equal(c.title, 'Hoodie (Kopie)');
    for (const [k, v] of Object.entries({ description: 'warm', size: 'M', category: 'Pullover', brand: 'Nike', condition: 'gut',
      purchase_price: 8, purchase_date: '2026-01-02', listing_price: 25, notes: 'Notiz', status: 'lager' })) assert.equal(c[k], v, k);
    for (const k of ['sold_price', 'sold_date', 'listed_date', 'platform', 'buyer', 'carrier', 'tracking_number']) assert.ok(!c[k], `${k} bleibt leer`);
    assert.equal(c.payment_status, 'offen');
    assert.ok(!c.fees && !c.shipping_cost);
    assert.equal((await s.get('/api/items/' + id)).json.status, 'verkauft', 'Original bleibt unverändert');
  });

  test('Kopie einer Kopie hängt kein zweites "(Kopie)" an', async () => {
    const id = await s.item({ title: 'Tasche' });
    const c1 = (await s.post(`/api/items/${id}/duplicate`)).json.id;
    const c2 = (await s.post(`/api/items/${c1}/duplicate`)).json.id;
    assert.equal((await s.get('/api/items/' + c1)).json.title, 'Tasche (Kopie)');
    assert.equal((await s.get('/api/items/' + c2)).json.title, 'Tasche (Kopie)');
  });

  test('Fotos werden als eigene Dateien kopiert, Löschen des Originals lässt die Kopie heil', async () => {
    const id = await s.item({ title: 'Mit Fotos' });
    assert.equal((await s.upload(`/api/items/${id}/images`, 'images', [{ name: 'a.png', data: png(1) }, { name: 'b.png', data: png(2) }])).status, 201);
    const r = await s.post(`/api/items/${id}/duplicate`);
    assert.equal(r.json.images, 2);
    assert.equal(r.json.skippedImages, 0);
    assert.equal(uploads().length, 4);
    const orig = (await s.get('/api/items/' + id)).json.images.map(i => i.url);
    const copy = (await s.get('/api/items/' + r.json.id)).json.images.map(i => i.url);
    assert.equal(copy.length, 2);
    assert.ok(copy.every(u => !orig.includes(u)), 'andere Dateinamen');
    assert.deepEqual((await s.get(copy[0])).buf, png(1), 'Reihenfolge und Inhalt bleiben');
    await s.del('/api/items/' + id);
    await waitFor(() => uploads().length === 2);
    assert.equal((await s.get(copy[1])).status, 200);
  });

  test('Fehlt eine Fotodatei, wird sie übersprungen und gemeldet', async () => {
    const id = await s.item({ title: 'Lücke' });
    await s.upload(`/api/items/${id}/images`, 'images', [{ name: 'a.png', data: png(1) }, { name: 'b.png', data: png(2) }]);
    const first = (await s.get('/api/items/' + id)).json.images[0].url;
    fs.rmSync(path.join(s.dataDir, first.slice(1)));
    const r = await s.post(`/api/items/${id}/duplicate`);
    assert.equal(r.status, 201);
    assert.equal(r.json.images, 1);
    assert.equal(r.json.skippedImages, 1);
  });
});

describe('Versandvorlagen', () => {
  test('Anlegen, Auflisten (nach Name, ohne Groß/Klein), Ändern, Löschen', async () => {
    const b = (await s.post('/api/shipping-presets', { name: 'bbb', carrier: 'DHL', price: 4.99 })).json.id;
    const a = (await s.post('/api/shipping-presets', { name: 'Aaa', carrier: 'Hermes', price: '3.5' })).json.id;
    const list = (await s.get('/api/shipping-presets')).json;
    assert.deepEqual(list.map(p => p.name), ['Aaa', 'bbb']);
    assert.equal(list[0].price, 3.5);
    assert.equal((await s.put('/api/shipping-presets/' + a, { name: 'Zzz', carrier: 'DPD', price: 6 })).status, 200);
    assert.deepEqual((await s.get('/api/shipping-presets')).json.map(p => [p.name, p.carrier, p.price]), [['bbb', 'DHL', 4.99], ['Zzz', 'DPD', 6]]);
    assert.equal((await s.del('/api/shipping-presets/' + a)).status, 200);
    assert.equal((await s.del('/api/shipping-presets/' + b)).status, 200);
    assert.deepEqual((await s.get('/api/shipping-presets')).json, []);
  });

  test('Name Pflicht, negativer oder falscher Preis wird 0, lange Namen gekürzt, unbekannte ID 404', async () => {
    assert.equal((await s.post('/api/shipping-presets', { name: '  ', price: 1 })).status, 400);
    assert.equal((await s.post('/api/shipping-presets', {})).status, 400);
    const id = (await s.post('/api/shipping-presets', { name: 'x'.repeat(200), carrier: 'y'.repeat(100), price: -5 })).json.id;
    const p = (await s.get('/api/shipping-presets')).json.find(x => x.id === id);
    assert.equal(p.name.length, 80);
    assert.equal(p.carrier.length, 40);
    assert.equal(p.price, 0);
    assert.equal((await s.put('/api/shipping-presets/' + id, { name: 'ok', price: 'abc' })).status, 200);
    assert.equal((await s.get('/api/shipping-presets')).json.find(x => x.id === id).price, 0);
    assert.equal((await s.put('/api/shipping-presets/99999', { name: 'x' })).status, 404);
    assert.equal((await s.put('/api/shipping-presets/' + id, { name: '' })).status, 400);
    await s.del('/api/shipping-presets/' + id);
  });
});

describe('Einstellungen', () => {
  test('Standardwerte, Ändern, teilweises Ändern, Zurücksetzen des Monatsziels', async () => {
    assert.deepEqual((await s.get('/api/settings')).json, { default_period: 'all', dead_days: 60, monthly_goal: null });
    let r = await s.put('/api/settings', { default_period: 'month', dead_days: 30, monthly_goal: '250,5' });
    assert.equal(r.status, 400, 'Komma-Zahl wird nicht geraten');
    r = await s.put('/api/settings', { default_period: 'month', dead_days: 30, monthly_goal: 250.456 });
    assert.deepEqual(r.json, { default_period: 'month', dead_days: 30, monthly_goal: 250.46 });
    r = await s.put('/api/settings', { dead_days: 90 });
    assert.deepEqual(r.json, { default_period: 'month', dead_days: 90, monthly_goal: 250.46 });
    r = await s.put('/api/settings', { monthly_goal: null });
    assert.equal(r.json.monthly_goal, null);
    r = await s.put('/api/settings', { monthly_goal: 100 });
    r = await s.put('/api/settings', { monthly_goal: '' });
    assert.equal(r.json.monthly_goal, null);
    assert.deepEqual((await s.get('/api/settings')).json, { default_period: 'month', dead_days: 90, monthly_goal: null });
    await s.put('/api/settings', { default_period: 'all', dead_days: 60 });
  });

  test('Ungültige Werte werden mit Meldung abgelehnt und ändern nichts', async () => {
    const before = (await s.get('/api/settings')).json;
    const bad = [
      [{ default_period: 'woche' }, /Zeitraum/], [{ default_period: null }, /Zeitraum/],
      [{ dead_days: 6 }, /7 bis 365/], [{ dead_days: 366 }, /7 bis 365/], [{ dead_days: 30.5 }, /7 bis 365/],
      [{ dead_days: '' }, /7 bis 365/], [{ dead_days: null }, /7 bis 365/], [{ dead_days: 'abc' }, /7 bis 365/],
      [{ monthly_goal: 0 }, /Monatsziel/], [{ monthly_goal: -5 }, /Monatsziel/], [{ monthly_goal: 'x' }, /Monatsziel/], [{ monthly_goal: 1e9 }, /Monatsziel/]
    ];
    for (const [body, msg] of bad) {
      const r = await s.put('/api/settings', body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.match(r.json.error, msg, JSON.stringify(body));
    }
    // Ein ungültiger Wert darf auch gültige Felder derselben Anfrage nicht übernehmen
    assert.equal((await s.put('/api/settings', { default_period: 'year', dead_days: 1 })).status, 400);
    assert.deepEqual((await s.get('/api/settings')).json, before);
  });

  test('Unbekannte Schlüssel werden ignoriert', async () => {
    const r = await s.put('/api/settings', { dead_days: 45, geheim: 'x' });
    assert.deepEqual(Object.keys(r.json).sort(), ['dead_days', 'default_period', 'monthly_goal']);
    await s.put('/api/settings', { dead_days: 60 });
  });

  test('Werte bleiben nach Neustart erhalten', async () => {
    const t = await startServer();
    try {
      await t.put('/api/settings', { default_period: '3m', dead_days: 120, monthly_goal: 500 });
      await t.stop({ keepData: true });
      const t2 = await startServer({ dataDir: t.dataDir });
      try {
        assert.deepEqual((await t2.get('/api/settings')).json, { default_period: '3m', dead_days: 120, monthly_goal: 500 });
      } finally { await t2.stop({ keepData: true }); }
    } finally { await t.stop(); }
  });
});

describe('Bilder', () => {
  let id;
  beforeEach(async () => { await s.reset(); id = await s.item({ title: 'Foto-Artikel' }); });

  const up = (files, item = id) => s.upload(`/api/items/${item}/images`, 'images', files);

  test('PNG hochladen: IDs, Dateiendung, Auslieferung', async () => {
    const data = png(7);
    const r = await up([{ name: 'egal.txt', data, type: 'text/plain' }]);
    assert.equal(r.status, 201);
    assert.equal(r.json.uploaded, 1);
    assert.equal(r.json.ids.length, 1);
    const [img] = (await s.get('/api/items/' + id)).json.images;
    assert.equal(img.id, r.json.ids[0]);
    assert.match(img.url, /^\/uploads\/[0-9a-f]{24}\.png$/, 'Endung kommt vom Dateikopf, nicht vom Namen');
    const file = await s.get(img.url);
    assert.equal(file.status, 200);
    assert.deepEqual(file.buf, data);
    assert.equal(file.headers.get('content-type'), 'image/png');
    assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
  });

  test('Alle erlaubten Formate werden erkannt', async () => {
    const want = { jpg: '.jpg', gif: '.gif', webp: '.webp', heic: '.heic', avif: '.avif' };
    const r = await up(Object.entries(want).map(([k]) => ({ name: 'datei.bin', data: MAGIC[k] })));
    assert.equal(r.status, 201);
    const urls = (await s.get('/api/items/' + id)).json.images.map(i => path.extname(i.url));
    assert.deepEqual(urls, Object.values(want), 'Reihenfolge wie hochgeladen');
  });

  test('Dateien, die kein Bild sind, werden abgelehnt (SVG, Text, HTML, leere Datei, getarnt als JPG)', async () => {
    const bad = {
      svg: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      text: Buffer.from('hallo'), html: Buffer.from('<html><script>alert(1)</script></html>'), leer: Buffer.alloc(0),
      tarnung: Buffer.from('MZ\x90\x00 kein Bild', 'latin1')
    };
    for (const [name, data] of Object.entries(bad)) {
      const r = await up([{ name: name + '.jpg', data, type: 'image/jpeg' }]);
      assert.equal(r.status, 400, name);
      assert.match(r.json.error, /kein gültiges Bild/, name);
    }
    assert.deepEqual(uploads(), [], 'nichts bleibt liegen');
    assert.deepEqual((await s.get('/api/items/' + id)).json.images, []);
  });

  test('Alles oder nichts: ein ungültiges Bild verwirft die ganze Auswahl', async () => {
    const r = await up([{ name: 'a.png', data: png(1) }, { name: 'b.svg', data: Buffer.from('<svg/>') }, { name: 'c.png', data: png(2) }]);
    assert.equal(r.status, 400);
    assert.deepEqual(uploads(), []);
    assert.deepEqual((await s.get('/api/items/' + id)).json.images, []);
  });

  test('Unbekannter Artikel: 404 und keine Datei bleibt liegen', async () => {
    const r = await up([{ name: 'a.png', data: png(1) }], 99999);
    assert.equal(r.status, 404);
    assert.deepEqual(uploads(), []);
  });

  test('Falscher Feldname ergibt 400 statt 500', async () => {
    const r = await s.upload(`/api/items/${id}/images`, 'datei', [{ name: 'a.png', data: png(1) }]);
    assert.equal(r.status, 400);
    assert.match(r.json.error, /Upload-Fehler/);
    assert.deepEqual(uploads(), []);
  });

  test('Höchstens 60 Bilder je Artikel', async () => {
    for (let b = 0; b < 3; b++) {
      const r = await up(Array.from({ length: 20 }, (_, i) => ({ name: `${i}.png`, data: png(b * 20 + i) })));
      assert.equal(r.status, 201, `Block ${b}`);
    }
    const r = await up([{ name: 'zu-viel.png', data: png(999) }]);
    assert.equal(r.status, 400);
    assert.match(r.json.error, /Maximal 60/);
    assert.equal(uploads().length, 60, 'abgelehntes Bild wurde wieder entfernt');
  });

  test('Reihenfolge ändern: nur eigene Bilder zählen, Unbekanntes wird übersprungen', async () => {
    const ids = (await up([1, 2, 3].map(n => ({ name: `${n}.png`, data: png(n) })))).json.ids;
    const other = await s.item({ title: 'Anderer' });
    const foreign = (await s.upload(`/api/items/${other}/images`, 'images', [{ name: 'f.png', data: png(50) }])).json.ids[0];
    const [a, b, c] = ids;
    const r = await s.put(`/api/items/${id}/images/order`, { ids: [c, foreign, 'x', a, b, 424242] });
    assert.equal(r.status, 200);
    assert.deepEqual((await s.get('/api/items/' + id)).json.images.map(i => i.id), [c, a, b]);
    assert.equal((await s.get('/api/items/' + other)).json.images.length, 1, 'fremdes Bild unberührt');
    assert.equal((await s.put(`/api/items/${id}/images/order`, {})).status, 200, 'ohne Liste: nichts passiert');
    assert.deepEqual((await s.get('/api/items/' + id)).json.images.map(i => i.id), [c, a, b]);
  });

  test('Neue Bilder landen hinter den vorhandenen', async () => {
    const first = (await up([{ name: 'a.png', data: png(1) }])).json.ids[0];
    const [second, third] = (await up([{ name: 'b.png', data: png(2) }, { name: 'c.png', data: png(3) }])).json.ids;
    assert.deepEqual((await s.get('/api/items/' + id)).json.images.map(i => i.id), [first, second, third]);
  });

  test('Bild löschen entfernt Zeile und Datei', async () => {
    const [a, b] = (await up([{ name: 'a.png', data: png(1) }, { name: 'b.png', data: png(2) }])).json.ids;
    const url = (await s.get('/api/items/' + id)).json.images.find(i => i.id === a).url;
    assert.equal((await s.del('/api/images/' + a)).status, 200);
    assert.equal((await s.del('/api/images/' + a)).status, 404);
    assert.deepEqual((await s.get('/api/items/' + id)).json.images.map(i => i.id), [b]);
    await waitFor(() => uploads().length === 1);
    assert.equal((await s.get(url)).status, 404);
  });

  test('Artikel löschen entfernt auch alle Fotos', async () => {
    await up([{ name: 'a.png', data: png(1) }, { name: 'b.png', data: png(2) }]);
    assert.equal(uploads().length, 2);
    await s.del('/api/items/' + id);
    assert.ok(await waitFor(() => uploads().length === 0));
    const left = s.dataDir && fs.readdirSync(path.join(s.dataDir, 'uploads'));
    assert.deepEqual(left, []);
  });
});
