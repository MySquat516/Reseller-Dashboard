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
  status TEXT NOT NULL DEFAULT 'lager',      -- lager | online | reserviert | zu_versenden | versendet | verkauft (abgeschlossen)
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
CREATE TABLE IF NOT EXISTS shipping_presets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  carrier TEXT DEFAULT '',
  price REAL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  position INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL                          -- JSON
);
`);

// Spalten, die erst später dazukamen: bei bestehenden Datenbanken nachrüsten
const have = db.prepare('PRAGMA table_info(items)').all().map(c => c.name);
for (const [col, def] of [['carrier', "TEXT DEFAULT ''"], ['tracking_number', "TEXT DEFAULT ''"]]) {
  if (!have.includes(col)) db.exec(`ALTER TABLE items ADD COLUMN ${col} ${def}`);
}

const FIELDS = [
  'title', 'description', 'size', 'category', 'brand', 'condition', 'status',
  'purchase_price', 'purchase_date', 'listing_price', 'listed_date',
  'sold_price', 'sold_date', 'platform', 'buyer', 'payment_method',
  'payment_status', 'fees', 'shipping_cost', 'carrier', 'tracking_number', 'notes'
];
const NUMERIC = ['purchase_price', 'listing_price', 'sold_price', 'fees', 'shipping_cost'];
const STATUSES = ['lager', 'online', 'reserviert', 'zu_versenden', 'versendet', 'verkauft'];
const SOLD_STATUSES = ['zu_versenden', 'versendet', 'verkauft']; // ab "gekauft" zählt der Artikel als Verkauf

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

// Dateityp wird an den ersten Bytes erkannt, nicht am Namen oder Content-Type des Clients.
// Erlaubt: JPEG, PNG, GIF, WebP, HEIC/HEIF, AVIF. SVG & Co. werden bewusst abgelehnt (können Scripts enthalten).
function sniffImageExt(file) {
  let buf;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      buf = Buffer.alloc(16);
      buf = buf.subarray(0, fs.readSync(fd, buf, 0, 16, 0));
    } finally { fs.closeSync(fd); }
  } catch { return null; }
  const ascii = (a, b) => buf.toString('latin1', a, b);
  if (buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return '.jpg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return '.png';
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return '.gif';
  if (buf.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return '.webp';
  if (buf.length >= 12 && ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1', 'heif'].includes(brand)) return '.heic';
    if (brand === 'avif' || brand === 'avis') return '.avif';
  }
  return null;
}

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  // Zufallsname ohne Endung; die richtige Endung kommt nach der Prüfung des Dateikopfs dazu.
  filename: (req, file, cb) => cb(null, crypto.randomBytes(12).toString('hex'))
});
const MAX_IMAGES_PER_ITEM = 60;
const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024, files: 40 }
  // Kein Mime-Filter: Der Content-Type kommt vom Client und ist nicht verlässlich (HEIC hat oft gar keinen).
  // Geprüft wird nach dem Upload am Dateikopf (sniffImageExt).
});

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
// Für Docker-Healthcheck: bewusst ohne Daten und (später) ohne Login erreichbar
app.get('/healthz', (req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});
// Optionaler Passwortschutz (nur mit APP_PASSWORD); muss vor allen anderen Routen stehen
require('./auth')({ app, DATA_DIR, publicDir: path.join(__dirname, 'public') });
app.use(express.json({ limit: '1mb' }));
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d', index: false }));
app.use('/vendor/chart.js', express.static(path.join(__dirname, 'node_modules/chart.js/dist')));
app.use(express.static(path.join(__dirname, 'public')));

// Versandvorlagen (Anbieter + Preis)
function cleanPreset(b) {
  const name = String(b.name ?? '').trim().slice(0, 80);
  const carrier = String(b.carrier ?? '').trim().slice(0, 40);
  const price = Number(b.price);
  return { name, carrier, price: Number.isFinite(price) && price >= 0 ? price : 0 };
}
app.get('/api/shipping-presets', (req, res) => {
  res.json(db.prepare('SELECT * FROM shipping_presets ORDER BY name COLLATE NOCASE').all());
});
app.post('/api/shipping-presets', (req, res) => {
  const p = cleanPreset(req.body || {});
  if (!p.name) return res.status(400).json({ error: 'Name fehlt' });
  const info = db.prepare('INSERT INTO shipping_presets (name, carrier, price) VALUES (@name, @carrier, @price)').run(p);
  res.status(201).json({ id: info.lastInsertRowid });
});
app.put('/api/shipping-presets/:id', (req, res) => {
  const p = cleanPreset(req.body || {});
  if (!p.name) return res.status(400).json({ error: 'Name fehlt' });
  const info = db.prepare('UPDATE shipping_presets SET name=@name, carrier=@carrier, price=@price WHERE id=@id').run({ ...p, id: req.params.id });
  if (!info.changes) return res.status(404).json({ error: 'Nicht gefunden' });
  res.json({ ok: true });
});
app.delete('/api/shipping-presets/:id', (req, res) => {
  db.prepare('DELETE FROM shipping_presets WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Einstellungen: Standardwerte für Oberfläche und Auswertung (serverseitig, gelten auf allen Geräten)
const SETTING_DEFAULTS = { default_period: 'all', dead_days: 60, monthly_goal: null };
function cleanSettings(b) {
  const out = {};
  if ('default_period' in b) {
    if (!PERIODS.includes(b.default_period)) return { error: 'Ungültiger Standard-Zeitraum' };
    out.default_period = b.default_period;
  }
  if ('dead_days' in b) {
    const n = Number(b.dead_days);
    if (b.dead_days === null || b.dead_days === '' || !Number.isInteger(n) || n < 7 || n > 365) {
      return { error: 'Ladenhüter-Grenze: ganze Zahl von 7 bis 365 Tagen' };
    }
    out.dead_days = n;
  }
  if ('monthly_goal' in b) {
    if (b.monthly_goal === null || b.monthly_goal === '') out.monthly_goal = null;
    else {
      const n = Number(b.monthly_goal);
      if (!Number.isFinite(n) || n <= 0 || n > 10000000) return { error: 'Monatsziel: Betrag über 0 € oder leer lassen' };
      out.monthly_goal = Math.round(n * 100) / 100;
    }
  }
  return { values: out };
}
function readSettings() {
  const out = { ...SETTING_DEFAULTS };
  for (const { key, value } of db.prepare('SELECT key, value FROM settings').all()) {
    if (!(key in SETTING_DEFAULTS)) continue;
    try {
      const c = cleanSettings({ [key]: JSON.parse(value) });
      if (c.values) Object.assign(out, c.values);   // ungültige Werte ignorieren, Standard bleibt
    } catch { /* kaputter Wert: Standard bleibt */ }
  }
  return out;
}
app.get('/api/settings', (req, res) => res.json(readSettings()));
app.put('/api/settings', (req, res) => {
  const { values, error } = cleanSettings(req.body || {});
  if (error) return res.status(400).json({ error });
  const up = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  db.transaction(() => { for (const [k, v] of Object.entries(values)) up.run(k, JSON.stringify(v)); })();
  res.json(readSettings());
});

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

// Kopie eines Artikels: Beschreibung, Einkaufsdaten, Einstellpreis, Notizen und Fotos werden übernommen.
// Status, Verkaufs- und Versanddaten bleiben leer (Status "lager"), damit die Kopie wie ein neuer Artikel startet.
app.post('/api/items/:id/duplicate', (req, res) => {
  const src = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  if (!src) return res.status(404).json({ error: 'Nicht gefunden' });
  const data = {
    title: src.title.replace(/ \(Kopie(?: \d+)?\)$/, '') + ' (Kopie)',
    description: src.description, size: src.size, category: src.category, brand: src.brand, condition: src.condition,
    status: 'lager', purchase_price: src.purchase_price, purchase_date: src.purchase_date, listing_price: src.listing_price, notes: src.notes
  };
  // Fotos zuerst kopieren; fehlt eine Datei, wird sie übersprungen und gemeldet
  const copied = [];
  let skipped = 0;
  for (const img of db.prepare('SELECT filename FROM images WHERE item_id = ? ORDER BY position, id').all(src.id)) {
    const name = crypto.randomBytes(12).toString('hex') + path.extname(img.filename);
    try {
      fs.copyFileSync(path.join(UPLOAD_DIR, img.filename), path.join(UPLOAD_DIR, name), fs.constants.COPYFILE_FICLONE);
      copied.push(name);
    } catch { skipped++; }
  }
  try {
    const id = db.transaction(() => {
      const cols = Object.keys(data);
      const newId = Number(db.prepare(`INSERT INTO items (${cols.join(',')}) VALUES (${cols.map(c => '@' + c).join(',')})`).run(data).lastInsertRowid);
      const ins = db.prepare('INSERT INTO images (item_id, filename, position) VALUES (?,?,?)');
      copied.forEach((name, i) => ins.run(newId, name, i + 1));
      return newId;
    })();
    res.status(201).json({ id, images: copied.length, skippedImages: skipped });
  } catch (err) {
    copied.forEach(name => fs.unlink(path.join(UPLOAD_DIR, name), () => {}));
    throw err;
  }
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
  // Alles-oder-nichts: Die Antwort-IDs müssen zur Reihenfolge der hochgeladenen Dateien passen.
  const exts = files.map(f => sniffImageExt(f.path));
  if (exts.some(e => !e)) {
    files.forEach(f => fs.unlink(f.path, () => {}));
    return res.status(400).json({ error: 'Mindestens eine Datei ist kein gültiges Bild (erlaubt: JPEG, PNG, GIF, WebP, HEIC, AVIF)' });
  }
  const have = db.prepare('SELECT COUNT(*) c FROM images WHERE item_id = ?').get(it.id).c;
  if (have + files.length > MAX_IMAGES_PER_ITEM) {
    files.forEach(f => fs.unlink(f.path, () => {}));
    return res.status(400).json({ error: `Maximal ${MAX_IMAGES_PER_ITEM} Bilder pro Artikel` });
  }
  files.forEach((f, i) => {
    const name = f.filename + exts[i];
    fs.renameSync(f.path, path.join(UPLOAD_DIR, name));
    f.filename = name;
  });
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
// CSV-Export für Excel (Deutschland): UTF-8 mit BOM, Semikolon, Dezimalkomma
const CSV_COLS = [
  ['ID', 'id'], ['Titel', 'title'], ['Beschreibung', 'description'], ['Größe', 'size'], ['Kategorie', 'category'],
  ['Marke', 'brand'], ['Zustand', 'condition'], ['Status', 'status'],
  ['Einkaufspreis', 'purchase_price', 'n'], ['Gekauft am', 'purchase_date'], ['Einstellpreis', 'listing_price', 'n'],
  ['Online seit', 'listed_date'], ['Verkaufspreis', 'sold_price', 'n'], ['Verkauft am', 'sold_date'],
  ['Plattform', 'platform'], ['Käufer', 'buyer'], ['Zahlungsart', 'payment_method'], ['Zahlungsstatus', 'payment_status'],
  ['Gebühren', 'fees', 'n'], ['Versandkosten', 'shipping_cost', 'n'], ['Gewinn', '_profit', 'n'],
  ['Versandanbieter', 'carrier'], ['Sendungsnummer', 'tracking_number'], ['Notizen', 'notes'], ['Bilder', '_images']
];
function csvCell(v, numeric) {
  if (v == null || v === '') return '';
  if (numeric) return Number(v).toFixed(2).replace('.', ',');
  let s = String(v).replace(/\r?\n/g, ' ');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;   // verhindert Formel-Ausführung in Excel
  return /[;"]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
// Auswahl für den Export: ?scope=all|sold|unsold  &by=sold|purchase  &from=JJJJ-MM-TT  &to=JJJJ-MM-TT
// (Zeitraum gilt für das Verkaufsdatum bzw. Kaufdatum; Artikel ohne dieses Datum fallen dann heraus)
const validDay = v => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === v;   // schließt z. B. 2026-02-30 aus
};
function exportFilter(q) {
  const f = { scope: 'all', by: 'sold', from: null, to: null };
  if (q.scope !== undefined) {
    if (!['all', 'sold', 'unsold'].includes(q.scope)) return { error: 'Ungültige Auswahl (scope)' };
    f.scope = q.scope;
  }
  if (q.by !== undefined) {
    if (!['sold', 'purchase'].includes(q.by)) return { error: 'Ungültige Datumsart (by)' };
    f.by = q.by;
  }
  for (const k of ['from', 'to']) {
    if (q[k] === undefined || q[k] === '') continue;
    if (typeof q[k] !== 'string' || !validDay(q[k])) return { error: `Ungültiges Datum (${k}), erwartet JJJJ-MM-TT` };
    f[k] = q[k];
  }
  if (f.from && f.to && f.from > f.to) return { error: '„Von“ liegt nach „Bis“' };
  return { filter: f };
}
app.get('/api/export.csv', (req, res) => {
  const { filter, error } = exportFilter(req.query);
  if (error) return res.status(400).json({ error });
  const isSold = it => SOLD_STATUSES.includes(it.status) && it.sold_price != null;
  let items = db.prepare('SELECT * FROM items ORDER BY id').all()
    .filter(it => filter.scope === 'all' || (filter.scope === 'sold' ? isSold(it) : ['lager', 'online', 'reserviert'].includes(it.status)));
  if (filter.from || filter.to) {
    items = items.filter(it => {
      const d = filter.by === 'sold' ? (isSold(it) ? soldDay(it) : null) : it.purchase_date;
      return d && (!filter.from || d >= filter.from) && (!filter.to || d <= filter.to);
    });
  }
  const counts = Object.fromEntries(db.prepare('SELECT item_id, COUNT(*) c FROM images GROUP BY item_id').all().map(r => [r.item_id, r.c]));
  const lines = [CSV_COLS.map(c => c[0]).join(';')];
  for (const it of items) {
    const row = { ...it, _images: counts[it.id] || 0, _profit: it.sold_price != null ? profitOf(it) : null };
    lines.push(CSV_COLS.map(([, k, t]) => csvCell(row[k], t === 'n')).join(';'));
  }
  const day = new Date();
  const today = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  const range = filter.from || filter.to ? `${filter.from || 'anfang'}_bis_${filter.to || today}` : today;
  const name = `reseller-export-${filter.scope === 'all' ? '' : filter.scope === 'sold' ? 'verkauft-' : 'unverkauft-'}${range}.csv`;
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"` });
  res.send('\uFEFF' + lines.join('\r\n') + '\r\n');
});

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

// Eine Zeile pro Verkauf, gemeinsam genutzt von /api/stats und /api/sales
function saleRow(it) {
  const profit = profitOf(it);
  const days = it.listed_date && it.sold_date ? dayDiff(it.listed_date, it.sold_date) : null;
  return {
    id: it.id, title: it.title, category: it.category || '', brand: it.brand || '', platform: it.platform || '',
    status: it.status, payment_status: it.payment_status,
    purchase_price: it.purchase_price || 0, sold_price: it.sold_price,
    fees: it.fees || 0, shipping_cost: it.shipping_cost || 0,
    profit, margin: it.sold_price ? profit / it.sold_price : null,
    sold_date: soldDay(it), listed_date: it.listed_date || null,
    standtime: days != null && days >= 0 ? days : null
  };
}

const mean = list => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : null);

app.get('/api/sales', (req, res) => {
  const period = PERIODS.includes(req.query.period) ? req.query.period : 'all';
  const from = periodStart(period, new Date());
  const rows = db.prepare('SELECT * FROM items').all()
    .filter(i => SOLD_STATUSES.includes(i.status) && i.sold_price != null && (!from || soldDay(i) >= from))
    .map(saleRow)
    .sort((a, b) => b.sold_date.localeCompare(a.sold_date) || b.id - a.id);
  res.json({
    period, from,
    totals: {
      count: rows.length,
      revenue: rows.reduce((s, r) => s + r.sold_price, 0),
      cost: rows.reduce((s, r) => s + r.purchase_price, 0),
      fees: rows.reduce((s, r) => s + r.fees + r.shipping_cost, 0),
      profit: rows.reduce((s, r) => s + r.profit, 0)
    },
    sales: rows
  });
});

app.get('/api/stats', (req, res) => {
  const period = PERIODS.includes(req.query.period) ? req.query.period : 'all';
  // ?dead=N (7-365) überschreibt die gespeicherte Ladenhüter-Grenze
  const dq = Number(req.query.dead);
  const deadDays = Number.isInteger(dq) && dq >= 7 && dq <= 365 ? dq : readSettings().dead_days;
  const now = new Date();
  const today = localDay(now);
  const from = periodStart(period, now);

  const items = db.prepare('SELECT * FROM items').all();
  const soldAll = items.filter(i => SOLD_STATUSES.includes(i.status) && i.sold_price != null);
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

  // Zusatzkennzahlen für den gewählten Zeitraum
  const rows = sold.map(saleRow);
  const wins = rows.filter(r => r.profit > 0);
  const losses = rows.filter(r => r.profit < 0);
  const timed = rows.filter(r => r.standtime != null);
  const timedDays = timed.reduce((s, r) => s + Math.max(r.standtime, 1), 0);
  const priced = unsold.filter(i => i.listing_price != null);

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
      avgPriceDiff: priceDiffs.length ? priceDiffs.reduce((a, b) => a + b, 0) / priceDiffs.length : null,
      winners: wins.length,
      losers: losses.length,
      hitRate: rows.length ? wins.length / rows.length : null,            // Anteil Verkäufe mit Gewinn > 0
      avgWin: mean(wins.map(r => r.profit)),
      avgLoss: mean(losses.map(r => r.profit)),                            // negativ
      profitPerStandDay: timedDays ? timed.reduce((s, r) => s + r.profit, 0) / timedDays : null,
      avgSalePrice: rows.length ? revenue / rows.length : null,
      // Offene Posten: Gewinn, wenn alles zum Einstellpreis verkauft wird (nur Artikel mit Einstellpreis)
      openExpectedProfit: priced.reduce((s, i) => s + i.listing_price - (i.purchase_price || 0), 0),
      openPricedCount: priced.length,
      openUnpricedCount: unsold.length - priced.length
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

require('./backup')({ app, db, DATA_DIR, UPLOAD_DIR, sniffImageExt });
require('./csvimport')({ app, db, FIELDS, STATUSES, SOLD_STATUSES, validDay });

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ error: 'Upload-Fehler: ' + err.message });
  // Fehler des Aufrufers (kaputtes JSON, zu großer Body) sind keine Serverfehler
  if (err.status >= 400 && err.status < 500) {
    return res.status(err.status).json({
      error: err.type === 'entity.parse.failed' ? 'Ungültiges JSON' : err.type === 'entity.too.large' ? 'Anfrage zu groß' : (err.message || 'Ungültige Anfrage')
    });
  }
  console.error(err);
  res.status(500).json({ error: err.message || 'Serverfehler' });
});

const server = app.listen(PORT, () => console.log(`Reseller-Dashboard läuft auf Port ${PORT}`));
// Große Backups über langsames WLAN dürfen länger als die Standard-5-Minuten brauchen
server.requestTimeout = 30 * 60 * 1000;
