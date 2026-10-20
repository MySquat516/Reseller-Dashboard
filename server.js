const express = require('express');
const multer = require('multer');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'reseller.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  size TEXT DEFAULT '',
  category TEXT DEFAULT '',
  brand TEXT DEFAULT '',
  condition TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'lager',      -- lager | online | reserviert | verkauft | versendet
  purchase_price REAL DEFAULT 0,
  purchase_date TEXT,
  listing_price REAL,
  listed_date TEXT,
  sold_price REAL,
  sold_date TEXT,
  platform TEXT DEFAULT '',
  buyer TEXT DEFAULT '',
  payment_method TEXT DEFAULT '',
  payment_status TEXT DEFAULT 'offen',       -- offen | bezahlt
  fees REAL DEFAULT 0,
  shipping_cost REAL DEFAULT 0,
  notes TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  position INTEGER DEFAULT 0
);
`);

const FIELDS = [
  'title', 'description', 'size', 'category', 'brand', 'condition', 'status',
  'purchase_price', 'purchase_date', 'listing_price', 'listed_date',
  'sold_price', 'sold_date', 'platform', 'buyer', 'payment_method',
  'payment_status', 'fees', 'shipping_cost', 'notes'
];
const NUMERIC = ['purchase_price', 'listing_price', 'sold_price', 'fees', 'shipping_cost'];
const STATUSES = ['lager', 'online', 'verkauft', 'versendet', 'reserviert'];

function clean(body) {
  const out = {};
  for (const f of FIELDS) {
    if (body[f] === undefined) continue;
    let v = body[f];
    if (NUMERIC.includes(f)) {
      v = v === '' || v === null ? null : Number(v);
      if (v !== null && !Number.isFinite(v)) v = null;
    } else if (typeof v === 'string') {
      v = v.trim();
      if (v === '' && f.endsWith('_date')) v = null;
    }
    out[f] = v;
  }
  if (out.status && !STATUSES.includes(out.status)) delete out.status;
  return out;
}

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '');
    cb(null, crypto.randomBytes(12).toString('hex') + ext);
  }
});
const MAX_IMAGES_PER_ITEM = 60;
const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024, files: 40 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype))
});

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d' }));
app.use('/vendor/chart.js', express.static(path.join(__dirname, 'node_modules/chart.js/dist')));
app.use(express.static(path.join(__dirname, 'public')));

function withImages(items) {
  const imgs = db.prepare('SELECT * FROM images ORDER BY position, id').all();
  const map = {};
  for (const i of imgs) (map[i.item_id] ||= []).push({ id: i.id, url: '/uploads/' + i.filename });
  return items.map(it => ({ ...it, images: map[it.id] || [] }));
}

app.get('/api/items', (req, res) => {
  res.json(withImages(db.prepare('SELECT * FROM items ORDER BY id DESC').all()));
});

app.get('/api/items/:id', (req, res) => {
  const it = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  if (!it) return res.status(404).json({ error: 'Nicht gefunden' });
  res.json(withImages([it])[0]);
});

app.post('/api/items', (req, res) => {
  const data = clean(req.body);
  if (!data.title) return res.status(400).json({ error: 'Titel fehlt' });
  const cols = Object.keys(data);
  const info = db.prepare(
    `INSERT INTO items (${cols.join(',')}) VALUES (${cols.map(c => '@' + c).join(',')})`
  ).run(data);
  res.status(201).json({ id: info.lastInsertRowid });
});

app.put('/api/items/:id', (req, res) => {
  const data = clean(req.body);
  const cols = Object.keys(data);
  if (!cols.length) return res.status(400).json({ error: 'Keine Daten' });
  const info = db.prepare(
    `UPDATE items SET ${cols.map(c => `${c} = @${c}`).join(',')} WHERE id = @id`
  ).run({ ...data, id: req.params.id });
  if (!info.changes) return res.status(404).json({ error: 'Nicht gefunden' });
  res.json({ ok: true });
});

app.delete('/api/items/:id', (req, res) => {
  const files = db.prepare('SELECT filename FROM images WHERE item_id = ?').all(req.params.id);
  const info = db.prepare('DELETE FROM items WHERE id = ?').run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Nicht gefunden' });
  files.forEach(f => fs.unlink(path.join(UPLOAD_DIR, f.filename), () => {}));
  res.json({ ok: true });
});

app.post('/api/items/:id/images', upload.array('images', 40), (req, res) => {
  const it = db.prepare('SELECT id FROM items WHERE id = ?').get(req.params.id);
  if (!it) {
    (req.files || []).forEach(f => fs.unlink(f.path, () => {}));
    return res.status(404).json({ error: 'Nicht gefunden' });
  }
  const files = req.files || [];
  const have = db.prepare('SELECT COUNT(*) c FROM images WHERE item_id = ?').get(it.id).c;
  if (have + files.length > MAX_IMAGES_PER_ITEM) {
    files.forEach(f => fs.unlink(f.path, () => {}));
    return res.status(400).json({ error: `Maximal ${MAX_IMAGES_PER_ITEM} Bilder pro Artikel` });
  }
  const pos = db.prepare('SELECT COALESCE(MAX(position),0) p FROM images WHERE item_id = ?').get(it.id).p;
  const ins = db.prepare('INSERT INTO images (item_id, filename, position) VALUES (?,?,?)');
  const ids = files.map((f, i) => Number(ins.run(it.id, f.filename, pos + i + 1).lastInsertRowid));
  res.status(201).json({ uploaded: files.length, ids });
});

app.delete('/api/images/:id', (req, res) => {
  const img = db.prepare('SELECT * FROM images WHERE id = ?').get(req.params.id);
  if (!img) return res.status(404).json({ error: 'Nicht gefunden' });
  db.prepare('DELETE FROM images WHERE id = ?').run(img.id);
  fs.unlink(path.join(UPLOAD_DIR, img.filename), () => {});
  res.json({ ok: true });
});

app.put('/api/items/:id/images/order', (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number) : [];
  const own = new Set(db.prepare('SELECT id FROM images WHERE item_id = ?').all(req.params.id).map(r => r.id));
  const upd = db.prepare('UPDATE images SET position = ? WHERE id = ?');
  db.transaction(() => ids.filter(id => own.has(id)).forEach((id, i) => upd.run(i + 1, id)))();
  res.json({ ok: true });
});

// ---------- Statistik ----------
const profitOf = it =>
  (it.sold_price || 0) - (it.purchase_price || 0) - (it.fees || 0) - (it.shipping_cost || 0);

function groupStats(sold, key) {
  const m = {};
  for (const it of sold) {
    const k = it[key] || '—';
    const g = (m[k] ||= { name: k, count: 0, revenue: 0, profit: 0 });
    g.count++;
    g.revenue += it.sold_price || 0;
    g.profit += profitOf(it);
  }
  return Object.values(m)
    .map(g => ({ ...g, margin: g.revenue ? g.profit / g.revenue : 0 }))
    .sort((a, b) => b.profit - a.profit);
}

const dayDiff = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);

// Datumshilfen: arbeiten in der Zeitzone des Servers (Umgebungsvariable TZ), nicht in UTC
const pad = n => String(n).padStart(2, '0');
const localDay = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const monthKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const soldDay = it => it.sold_date || (it.created_at || '').slice(0, 10);

const PERIODS = ['month', '3m', 'year', 'all'];
const DEAD_DAYS = [30, 60, 90];

function periodStart(period, now) {
  if (period === 'month') return `${monthKey(now)}-01`;
  if (period === '3m') return `${monthKey(new Date(now.getFullYear(), now.getMonth() - 2, 1))}-01`;
  if (period === 'year') return `${now.getFullYear()}-01-01`;
  return null;
}

const monthSpan = (a, b) =>
  (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7));

function monthRange(fromKey, toKey) {
  const out = [];
  let y = Number(fromKey.slice(0, 4));
  let m = Number(fromKey.slice(5, 7));
  const ty = Number(toKey.slice(0, 4));
  const tm = Number(toKey.slice(5, 7));
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${pad(m)}`);
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}

const sumUp = list => ({
  count: list.length,
  revenue: list.reduce((s, i) => s + i.sold_price, 0),
  profit: list.reduce((s, i) => s + profitOf(i), 0)
});

app.get('/api/stats', (req, res) => {
  const period = PERIODS.includes(req.query.period) ? req.query.period : 'all';
  const deadDays = DEAD_DAYS.includes(Number(req.query.dead)) ? Number(req.query.dead) : 60;
  const now = new Date();
  const today = localDay(now);
  const from = periodStart(period, now);

  const items = db.prepare('SELECT * FROM items').all();
  const soldAll = items.filter(i => ['verkauft', 'versendet'].includes(i.status) && i.sold_price != null);
  const sold = from ? soldAll.filter(i => soldDay(i) >= from) : soldAll;
  const unsold = items.filter(i => ['lager', 'online', 'reserviert'].includes(i.status));

  const revenue = sold.reduce((s, i) => s + i.sold_price, 0);
  const cost = sold.reduce((s, i) => s + (i.purchase_price || 0), 0);
  const fees = sold.reduce((s, i) => s + (i.fees || 0) + (i.shipping_cost || 0), 0);
  const profit = revenue - cost - fees;

  // Monatsliste im gewählten Zeitraum, Monate ohne Verkäufe werden mit 0 aufgefüllt
  const monthly = {};
  for (const it of sold) {
    const k = soldDay(it).slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(k)) continue;
    const g = (monthly[k] ||= { month: k, count: 0, revenue: 0, cost: 0, fees: 0, profit: 0 });
    g.count++;
    g.revenue += it.sold_price;
    g.cost += it.purchase_price || 0;
    g.fees += (it.fees || 0) + (it.shipping_cost || 0);
    g.profit += profitOf(it);
  }
  const keys = Object.keys(monthly).sort();
  const curKey = monthKey(now);
  const startKey = from ? from.slice(0, 7) : (keys[0] || curKey);
  const endKey = keys.length && keys[keys.length - 1] > curKey ? keys[keys.length - 1] : curKey;
  const monthlyList = monthSpan(startKey, endKey) <= 240
    ? monthRange(startKey, endKey).map(k => monthly[k] || { month: k, count: 0, revenue: 0, cost: 0, fees: 0, profit: 0 })
    : keys.map(k => monthly[k]);

  // Dieser Monat gegen den Vormonat, fair verglichen bis zum gleichen Tag des Monats
  const prevKey = monthKey(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  const prevMonthDays = new Date(now.getFullYear(), now.getMonth(), 0).getDate();
  const cutoffDay = Math.min(now.getDate(), prevMonthDays);
  const inMonth = key => soldAll.filter(i => soldDay(i).startsWith(key));
  const prevAll = inMonth(prevKey);
  const thisMonth = {
    month: curKey,
    ...sumUp(inMonth(curKey)),
    prev: {
      month: prevKey,
      cutoffDay,
      full: sumUp(prevAll),
      toDate: sumUp(prevAll.filter(i => Number(soldDay(i).slice(8, 10)) <= cutoffDay))
    }
  };

  const standtimes = sold
    .filter(i => i.listed_date && i.sold_date)
    .map(i => dayDiff(i.listed_date, i.sold_date))
    .filter(d => d >= 0);

  const priceDiffs = sold.filter(i => i.listing_price).map(i => i.sold_price - i.listing_price);

  const deadAll = unsold
    .filter(i => i.status !== 'reserviert') // reservierte Artikel sind so gut wie verkauft
    .map(i => ({
      id: i.id, title: i.title, status: i.status, purchase_price: i.purchase_price || 0,
      days: dayDiff(i.listed_date || i.purchase_date || i.created_at.slice(0, 10), today)
    }))
    .filter(i => i.days >= deadDays)
    .sort((a, b) => b.days - a.days);

  res.json({
    period, from, deadDays,
    totals: {
      items: items.length,
      sold: sold.length,
      unsold: unsold.length,
      revenue, cost, fees, profit,
      margin: revenue ? profit / revenue : 0,
      roi: cost ? profit / cost : 0,
      avgProfit: sold.length ? profit / sold.length : 0,
      stockValue: unsold.reduce((s, i) => s + (i.purchase_price || 0), 0),
      openPayments: soldAll.filter(i => i.payment_status !== 'bezahlt').reduce((s, i) => s + i.sold_price, 0),
      avgStandtime: standtimes.length ? standtimes.reduce((a, b) => a + b, 0) / standtimes.length : null,
      avgPriceDiff: priceDiffs.length ? priceDiffs.reduce((a, b) => a + b, 0) / priceDiffs.length : null
    },
    thisMonth,
    monthly: monthlyList,
    byCategory: groupStats(sold, 'category'),
    byBrand: groupStats(sold, 'brand'),
    byPlatform: groupStats(sold, 'platform'),
    byPayment: groupStats(sold, 'payment_method'),
    byStatus: STATUSES.map(s => ({ name: s, count: items.filter(i => i.status === s).length })),
    deadStock: deadAll.slice(0, 10),
    deadTotal: deadAll.length,
    deadCapital: deadAll.reduce((s, i) => s + i.purchase_price, 0)
  });
});

app.use((err, req, res, next) => {
  console.error(err);
  if (err instanceof multer.MulterError) return res.status(400).json({ error: 'Upload-Fehler: ' + err.message });
  res.status(500).json({ error: err.message || 'Serverfehler' });
});

app.listen(PORT, () => console.log(`Reseller-Dashboard läuft auf Port ${PORT}`));
