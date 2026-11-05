// Kennzahlen (/api/stats) und Verkaufsliste (/api/sales) mit einem festen Datensatz.
// Daten sind relativ zu heute gewählt (Server läuft in den Tests mit TZ=UTC), damit die Zeiträume stimmen.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, today, daysAgo } = require('../testlib/harness');

let s;
const ids = {};
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg || ''} ${a} ≠ ${b}`);

before(async () => {
  s = await startServer();
  const mk = async (key, data) => { ids[key] = await s.item(data); };
  // Verkäufe
  await mk('A', { title: 'A Shirt', status: 'verkauft', purchase_price: 10, sold_price: 30, fees: 2, shipping_cost: 3, sold_date: today(),
    listed_date: daysAgo(10), listing_price: 35, platform: 'Vinted', category: 'Shirts', brand: 'Nike', payment_method: 'PayPal', payment_status: 'bezahlt' });
  await mk('B', { title: 'B Hose', status: 'versendet', purchase_price: 20, sold_price: 15, fees: 1, shipping_cost: 4, sold_date: today(),
    platform: 'eBay', category: 'Hosen', brand: 'Adidas', payment_method: 'Überweisung' });
  await mk('C', { title: 'C Altes Shirt', status: 'zu_versenden', purchase_price: 5, sold_price: 25, sold_date: daysAgo(100),
    platform: 'Vinted', category: 'Shirts', payment_method: 'PayPal' });
  // "verkauft" ohne Preis: zählt nicht als Verkauf
  await mk('D', { title: 'D Ohne Preis', status: 'verkauft', purchase_price: 9 });
  // Bestand
  await mk('E', { title: 'E Ladenhüter', status: 'lager', purchase_price: 7, listing_price: 20, purchase_date: daysAgo(90) });
  await mk('F', { title: 'F Frisch', status: 'online', purchase_price: 3, listed_date: daysAgo(5) });
  await mk('G', { title: 'G Reserviert', status: 'reserviert', purchase_price: 4, purchase_date: daysAgo(200) });
  // Verkauft ohne Verkaufsdatum: es zählt der Tag des Anlegens
  await mk('H', { title: 'H Ohne Datum', status: 'verkauft', purchase_price: 2, sold_price: 12 });
});
after(() => s.stop());

const stats = async (q = {}) => (await s.get('/api/stats', { query: q })).json;

// Unabhängige Rechnung für den Beginn eines Zeitraums
function startOf(period) {
  const [y, m] = today().split('-').map(Number);
  if (period === 'month') return `${y}-${String(m).padStart(2, '0')}-01`;
  if (period === '3m') { const d = new Date(Date.UTC(y, m - 3, 1)); return d.toISOString().slice(0, 10); }
  if (period === 'year') return `${y}-01-01`;
  return null;
}

describe('Gesamtzeitraum', () => {
  test('Summen und Kennzahlen', async () => {
    const st = await stats();
    assert.equal(st.period, 'all');
    assert.equal(st.from, null);
    const t = st.totals;
    assert.equal(t.items, 8);
    assert.equal(t.sold, 4, 'A, B, C, H; D hat keinen Verkaufspreis');
    assert.equal(t.unsold, 3);
    assert.equal(t.revenue, 82);
    assert.equal(t.cost, 37);
    assert.equal(t.fees, 10, 'Gebühren und Versand zusammen');
    assert.equal(t.profit, 35);
    near(t.margin, 35 / 82, 'Marge');
    near(t.roi, 35 / 37, 'ROI');
    near(t.avgProfit, 8.75);
    assert.equal(t.stockValue, 14);
    assert.equal(t.openPayments, 52, 'B, C und H sind nicht bezahlt');
    assert.equal(t.avgStandtime, 10);
    assert.equal(t.avgPriceDiff, -5);
    assert.equal(t.winners, 3);
    assert.equal(t.losers, 1);
    assert.equal(t.hitRate, 0.75);
    assert.equal(t.avgWin, 15);
    assert.equal(t.avgLoss, -10);
    near(t.profitPerStandDay, 1.5);
    assert.equal(t.avgSalePrice, 20.5);
    assert.equal(t.openExpectedProfit, 13, 'nur Artikel mit Einstellpreis');
    assert.equal(t.openPricedCount, 1);
    assert.equal(t.openUnpricedCount, 2);
  });

  test('Status-Verteilung in fester Reihenfolge', async () => {
    const st = await stats();
    assert.deepEqual(st.byStatus.map(x => x.name), ['lager', 'online', 'reserviert', 'zu_versenden', 'versendet', 'verkauft']);
    assert.deepEqual(st.byStatus.map(x => x.count), [1, 1, 1, 1, 1, 3]);
  });

  test('Gruppen sind nach Gewinn sortiert, leere Werte heißen "—"', async () => {
    const st = await stats();
    assert.deepEqual(st.byPlatform.map(x => [x.name, x.count, x.revenue, x.profit]), [['Vinted', 2, 55, 35], ['—', 1, 12, 10], ['eBay', 1, 15, -10]]);
    near(st.byPlatform[0].margin, 35 / 55);
    assert.deepEqual(st.byCategory.map(x => x.name), ['Shirts', '—', 'Hosen']);
    assert.deepEqual(st.byBrand.map(x => [x.name, x.count, x.profit]), [['—', 2, 30], ['Nike', 1, 15], ['Adidas', 1, -10]]);
    assert.deepEqual(st.byPayment.map(x => [x.name, x.profit]), [['PayPal', 35], ['—', 10], ['Überweisung', -10]]);
  });

  test('Monatsliste füllt Monate ohne Verkäufe mit 0 auf', async () => {
    const st = await stats();
    const first = daysAgo(100).slice(0, 7), last = today().slice(0, 7);
    assert.equal(st.monthly[0].month, first);
    assert.equal(st.monthly.at(-1).month, last);
    assert.deepEqual(st.monthly.map(m => m.month), [...new Set(st.monthly.map(m => m.month))], 'jeder Monat nur einmal');
    for (let i = 1; i < st.monthly.length; i++) assert.ok(st.monthly[i].month > st.monthly[i - 1].month, 'aufsteigend');
    assert.equal(st.monthly[0].count, 1);
    assert.equal(st.monthly[0].profit, 20);
    assert.equal(st.monthly.at(-1).count, 3);
    assert.equal(st.monthly.at(-1).profit, 15);
    const between = st.monthly.slice(1, -1);
    assert.ok(between.every(m => m.count === 0 && m.profit === 0 && m.revenue === 0));
    assert.equal(st.monthly.reduce((x, m) => x + m.profit, 0), 35);
  });

  test('Dieser Monat: Verkauf ohne Datum zählt am Tag des Anlegens', async () => {
    const st = await stats();
    assert.equal(st.thisMonth.month, today().slice(0, 7));
    assert.equal(st.thisMonth.count, 3, 'A, B und H');
    assert.equal(st.thisMonth.revenue, 57);
    assert.equal(st.thisMonth.profit, 15);
    assert.equal(st.thisMonth.prev.full.count, 0);
    assert.ok(st.thisMonth.prev.cutoffDay >= 1 && st.thisMonth.prev.cutoffDay <= 31);
  });
});

describe('Zeiträume', () => {
  for (const period of ['month', '3m', 'year', 'all']) {
    test(`Zeitraum "${period}" enthält genau die Verkäufe ab Beginn`, async () => {
      const from = startOf(period);
      const rows = [['A', today()], ['B', today()], ['C', daysAgo(100)], ['H', today()]].filter(([, d]) => !from || d >= from);
      const st = await stats({ period });
      assert.equal(st.period, period);
      assert.equal(st.from, from);
      assert.equal(st.totals.sold, rows.length, period);
      const sales = (await s.get('/api/sales', { query: { period } })).json;
      assert.equal(sales.period, period);
      assert.deepEqual(sales.sales.map(r => r.id).sort(), rows.map(([k]) => ids[k]).sort());
      assert.equal(sales.totals.count, rows.length);
    });
  }

  test('Der Bestand hängt nicht vom Zeitraum ab', async () => {
    for (const period of ['month', 'year', 'all']) {
      const t = (await stats({ period })).totals;
      assert.equal(t.unsold, 3, period);
      assert.equal(t.stockValue, 14, period);
      assert.equal(t.items, 8, period);
    }
  });

  test('Unbekannter Zeitraum fällt auf "all" zurück', async () => {
    assert.equal((await stats({ period: 'bogus' })).period, 'all');
    assert.equal((await s.get('/api/sales', { query: { period: 'bogus' } })).json.period, 'all');
    assert.equal((await stats({ period: 'MONTH' })).period, 'all');
  });

  test('Zeitraum "month": Summen nur aus dem laufenden Monat', async () => {
    const st = await stats({ period: 'month' });
    assert.equal(st.totals.revenue, 57);
    assert.equal(st.totals.profit, 15);
    assert.equal(st.monthly.length, 1);
    assert.equal(st.monthly[0].month, today().slice(0, 7));
  });
});

describe('Ladenhüter', () => {
  test('Standard: ab 60 Tage, reservierte und frische Artikel nicht', async () => {
    const st = await stats();
    assert.equal(st.deadDays, 60);
    assert.equal(st.deadTotal, 1);
    assert.equal(st.deadCapital, 7);
    assert.deepEqual(st.deadStock.map(d => [d.id, d.days, d.status]), [[ids.E, 90, 'lager']]);
  });

  test('Parameter ?dead überschreibt die Grenze, ungültige Werte werden ignoriert', async () => {
    assert.equal((await stats({ dead: 90 })).deadTotal, 1, 'genau 90 Tage zählt');
    assert.equal((await stats({ dead: 91 })).deadTotal, 0);
    assert.equal((await stats({ dead: 91 })).deadDays, 91);
    assert.equal((await stats({ dead: 7 })).deadTotal, 1);
    for (const bad of ['3', '400', 'abc', '30.5', '']) assert.equal((await stats({ dead: bad })).deadDays, 60, `dead=${bad}`);
  });

  test('Gespeicherte Grenze gilt, wenn kein Parameter kommt', async () => {
    await s.put('/api/settings', { dead_days: 120 });
    try {
      const st = await stats();
      assert.equal(st.deadDays, 120);
      assert.equal(st.deadTotal, 0);
      assert.equal((await stats({ dead: 30 })).deadDays, 30);
    } finally { await s.put('/api/settings', { dead_days: 60 }); }
  });
});

describe('Verkaufsliste', () => {
  test('Sortierung: neueste zuerst, bei gleichem Tag höhere ID zuerst', async () => {
    const r = (await s.get('/api/sales')).json;
    assert.deepEqual(r.sales.map(x => x.id), [ids.H, ids.B, ids.A, ids.C]);
  });

  test('Zeilen enthalten Gewinn, Marge, Standzeit und das Ersatz-Verkaufsdatum', async () => {
    const r = (await s.get('/api/sales')).json;
    const row = id => r.sales.find(x => x.id === id);
    assert.equal(row(ids.A).profit, 15);
    near(row(ids.A).margin, 0.5);
    assert.equal(row(ids.A).standtime, 10);
    assert.equal(row(ids.B).profit, -10);
    near(row(ids.B).margin, -10 / 15);
    assert.equal(row(ids.B).standtime, null);
    assert.equal(row(ids.H).sold_date, today(), 'Datum des Anlegens');
    assert.equal(row(ids.H).platform, '');
    assert.deepEqual(r.totals, { count: 4, revenue: 82, cost: 37, fees: 10, profit: 35 });
  });

  test('"verkauft" ohne Preis taucht nicht auf', async () => {
    const r = (await s.get('/api/sales')).json;
    assert.ok(!r.sales.some(x => x.id === ids.D));
  });

  test('Verkaufspreis 0 ist ein Verkauf (Geschenk/Tausch), kein fehlender Preis', async () => {
    const id = await s.item({ title: 'Tausch', status: 'verkauft', purchase_price: 3, sold_price: 0, sold_date: today() });
    try {
      const r = (await s.get('/api/sales')).json;
      const row = r.sales.find(x => x.id === id);
      assert.ok(row, 'zählt als Verkauf');
      assert.equal(row.profit, -3);
      assert.equal(row.margin, null, 'keine Marge bei 0 € Umsatz');
      assert.equal((await stats()).totals.sold, 5);
    } finally { await s.del('/api/items/' + id); }
  });

  test('Status ändern: zurück ins Lager nimmt den Verkauf aus der Auswertung', async () => {
    const id = await s.item({ title: 'Zurück', status: 'verkauft', purchase_price: 1, sold_price: 9, sold_date: today() });
    assert.equal((await stats()).totals.sold, 5);
    await s.put('/api/items/' + id, { status: 'online' });
    const st = await stats();
    assert.equal(st.totals.sold, 4);
    assert.equal(st.totals.unsold, 4);
    await s.del('/api/items/' + id);
  });
});

describe('Leere Datenbank', () => {
  test('Alle Werte sind 0 oder null, nichts bricht', async () => {
    const e = await startServer();
    try {
      const st = (await e.get('/api/stats')).json;
      assert.equal(st.totals.items, 0);
      assert.equal(st.totals.profit, 0);
      assert.equal(st.totals.margin, 0);
      assert.equal(st.totals.roi, 0);
      assert.equal(st.totals.hitRate, null);
      assert.equal(st.totals.avgStandtime, null);
      assert.deepEqual(st.byPlatform, []);
      assert.deepEqual(st.deadStock, []);
      assert.equal(st.monthly.length, 1, 'wenigstens der laufende Monat');
      const sales = (await e.get('/api/sales')).json;
      assert.deepEqual(sales.sales, []);
      assert.equal(sales.totals.count, 0);
    } finally { await e.stop(); }
  });
});
