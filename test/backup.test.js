// Backup, Wiederherstellung und automatische Sicherung gegen echte Server.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { startServer, png, makeZip, readZip, MAGIC, sleep } = require('../testlib/harness');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-backup-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const SQLITE = Buffer.from('SQLite format 3\0');
const isSqlite = buf => buf.subarray(0, 16).equals(SQLITE);
const strip = ({ id, created_at, images, ...rest }) => rest;
const restore = (srv, data, name = 'backup.zip') => srv.upload('/api/restore', 'backup', [{ name, data }]);
const uploads = srv => fs.readdirSync(path.join(srv.dataDir, 'uploads')).sort();
async function waitFor(fn, ms = 3000) {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await fn()) return true; await sleep(30); }
  return fn();
}

// Quelle mit Artikeln, Fotos, Vorlagen und Einstellungen
let src, backupZip, files;
before(async () => {
  src = await startServer();
  const a = await src.item({ title: 'Jacke', status: 'verkauft', purchase_price: 10, sold_price: 40, sold_date: '2026-03-01', notes: 'ä ö ü 😀' });
  const b = await src.item({ title: 'Hose', status: 'lager', purchase_price: 5, listing_price: 15 });
  await src.upload(`/api/items/${a}/images`, 'images', [{ name: '1.png', data: png(1) }, { name: '2.png', data: png(2) }, { name: '3.jpg', data: MAGIC.jpg }]);
  await src.upload(`/api/items/${b}/images`, 'images', [{ name: '4.png', data: png(4) }]);
  await src.post('/api/shipping-presets', { name: 'DHL Paket', carrier: 'DHL', price: 4.99 });
  await src.put('/api/settings', { default_period: 'year', dead_days: 45, monthly_goal: 300 });
  const r = await src.get('/api/backup');
  assert.equal(r.status, 200);
  backupZip = r.buf;
  files = await readZip(backupZip);
});
after(() => src.stop());

describe('Backup herunterladen', () => {
  test('ZIP mit Datenbank, Fotos und Infodatei; passende Header', async () => {
    const r = await src.get('/api/backup');
    assert.equal(r.headers.get('content-type'), 'application/zip');
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.match(r.headers.get('content-disposition'), /^attachment; filename="reseller-backup-\d{4}-\d{2}-\d{2}_\d{4}\.zip"$/);
    assert.deepEqual(Object.keys(files).filter(n => !n.startsWith('uploads/')).sort(), ['backup-info.json', 'reseller.db']);
    assert.equal(Object.keys(files).filter(n => n.startsWith('uploads/')).length, 4);
    assert.ok(isSqlite(files['reseller.db']));
    const info = JSON.parse(files['backup-info.json']);
    assert.equal(info.app, 'reseller-dashboard');
    assert.equal(info.items, 2);
    assert.equal(info.photos, 4);
    assert.ok(!isNaN(new Date(info.created)));
  });

  test('Fotos stehen unverändert im Backup', async () => {
    const live = (await src.get('/api/items')).json.flatMap(i => i.images);
    assert.equal(live.length, 4);
    for (const img of live) {
      const inZip = files['uploads/' + img.url.split('/').pop()];
      assert.ok(inZip, img.url);
      assert.deepEqual(inZip, (await src.get(img.url)).buf);
    }
  });

  test('Der Datenbank-Schnappschuss ist lesbar und vollständig', async () => {
    const f = path.join(tmp, 'snapshot.db');
    fs.writeFileSync(f, files['reseller.db']);
    const d = new Database(f, { readonly: true });
    try {
      assert.equal(d.pragma('integrity_check', { simple: true }), 'ok');
      assert.equal(d.prepare('SELECT COUNT(*) c FROM items').get().c, 2);
      assert.equal(d.prepare('SELECT COUNT(*) c FROM images').get().c, 4);
    } finally { d.close(); }
  });

  test('Temporäre Dateien bleiben nicht liegen', async () => {
    await src.get('/api/backup');
    await waitFor(() => fs.readdirSync(path.join(src.dataDir, 'tmp')).length === 0);
    assert.deepEqual(fs.readdirSync(path.join(src.dataDir, 'tmp')), []);
  });
});

describe('Wiederherstellen', () => {
  test('Rundlauf: Artikel, Fotos, Vorlagen und Einstellungen kommen in eine andere Instanz', async () => {
    const dst = await startServer();
    try {
      const old = await dst.item({ title: 'Wird ersetzt' });
      await dst.upload(`/api/items/${old}/images`, 'images', [{ name: 'alt.png', data: png(99) }]);
      await dst.post('/api/shipping-presets', { name: 'Alte Vorlage' });
      const oldFile = uploads(dst)[0];

      const r = await restore(dst, backupZip);
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.ok, true);
      assert.equal(r.json.mode, 'zip');
      assert.equal(r.json.items, 2);
      assert.equal(r.json.images, 4);
      assert.equal(r.json.skippedImages, 0);
      assert.equal(r.json.skippedFiles, 0);
      assert.match(r.json.safety, /^pre-restore-\d{4}-\d{2}-\d{2}_\d{4}(-[0-9a-f]{12})?\.zip$/);

      assert.deepEqual((await dst.get('/api/items')).json.map(strip), (await src.get('/api/items')).json.map(strip));
      for (const img of (await dst.get('/api/items')).json.flatMap(i => i.images)) {
        assert.deepEqual((await dst.get(img.url)).buf, (await src.get(img.url)).buf, img.url);
      }
      assert.deepEqual((await dst.get('/api/shipping-presets')).json.map(p => [p.name, p.price]), [['DHL Paket', 4.99]]);
      assert.deepEqual((await dst.get('/api/settings')).json, { default_period: 'year', dead_days: 45, monthly_goal: 300 });
      assert.ok(!uploads(dst).includes(oldFile), 'Foto des alten Stands wurde entfernt');
      assert.equal(uploads(dst).length, 4);

      // Der alte Stand steckt in der Sicherheitskopie (mit Foto)
      const list = (await dst.get('/api/backups')).json;
      const safety = list.files.find(f => f.name === r.json.safety);
      assert.equal(safety.kind, 'pre-restore');
      const dl = await dst.get('/api/backups/' + safety.name);
      assert.equal(dl.status, 200);
      const old2 = await readZip(dl.buf);
      assert.ok(old2['uploads/' + oldFile], 'altes Foto in der Sicherheitskopie');
      assert.equal(JSON.parse(old2['backup-info.json']).items, 1);

      // Danach läuft alles normal weiter, neue IDs kollidieren nicht
      const maxId = Math.max(...(await dst.get('/api/items')).json.map(i => i.id));
      assert.ok(await dst.item({ title: 'Neu' }) > maxId);
      assert.equal((await dst.get('/healthz')).status, 200);
    } finally { await dst.stop(); }
  });

  test('Eine reine .db-Datei wird auch angenommen; Bilder ohne Datei werden gezählt und entfernt', async () => {
    const dst = await startServer();
    try {
      const r = await restore(dst, files['reseller.db'], 'reseller.db');
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.mode, 'db');
      assert.equal(r.json.items, 2);
      assert.equal(r.json.images, 0);
      assert.equal(r.json.skippedImages, 4);
      const items = (await dst.get('/api/items')).json;
      assert.deepEqual(items.map(i => i.title).sort(), ['Hose', 'Jacke']);
      assert.ok(items.every(i => i.images.length === 0));
    } finally { await dst.stop(); }
  });

  test('Backup aus einer älteren Version (weniger Spalten, ohne Einstellungen)', async () => {
    const f = path.join(tmp, 'alt.db');
    const d = new Database(f);
    d.exec(`CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'lager', purchase_price REAL DEFAULT 0, sold_price REAL, created_at TEXT DEFAULT (datetime('now')));
      INSERT INTO items (title, status, purchase_price) VALUES ('Alt', 'lager', 5), ('Alt verkauft', 'verkauft', 2);
      UPDATE items SET sold_price = 9 WHERE id = 2;`);
    d.close();
    const dst = await startServer();
    try {
      await dst.put('/api/settings', { dead_days: 99 });
      const r = await restore(dst, fs.readFileSync(f), 'alt.db');
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.items, 2);
      const items = (await dst.get('/api/items')).json;
      assert.equal(items.find(i => i.title === 'Alt verkauft').sold_price, 9);
      assert.equal(items[0].carrier, '', 'neue Spalten haben ihre Standardwerte');
      assert.equal((await dst.get('/api/settings')).json.dead_days, 99, 'Einstellungen bleiben, wenn das Backup keine hat');
      assert.equal((await dst.get('/api/stats')).json.totals.sold, 1);
    } finally { await dst.stop(); }
  });

  test('Ungültige Uploads werden abgelehnt und lassen die Daten unberührt', async () => {
    const dst = await startServer();
    try {
      await dst.item({ title: 'Bleibt' });
      const wrongSchema = path.join(tmp, 'fremd.db');
      const fd = new Database(wrongSchema); fd.exec('CREATE TABLE foo (a TEXT); INSERT INTO foo VALUES (\'x\')'); fd.close();
      const cases = {
        'kein Anhang': [null, /Keine Datei/],
        'Textdatei': [Buffer.from('hallo welt'), /weder ein ZIP-Backup noch/],
        'leere Datei': [Buffer.alloc(0), /weder ein ZIP|Keine Datei/],
        'abgeschnittenes ZIP': [backupZip.subarray(0, Math.floor(backupZip.length / 2)), /beschädigt|nicht lesbar/],
        'ZIP ohne reseller.db': [makeZip([{ name: 'readme.txt', data: 'hi' }]), /reseller\.db/],
        'ZIP mit Müll-Datenbank': [makeZip([{ name: 'reseller.db', data: Buffer.concat([SQLITE, Buffer.alloc(200, 7)]) }]), /Datenbank/],
        'fremde Datenbank': [fs.readFileSync(wrongSchema), /kein Backup dieser App/],
        'nur SQLite-Kopf': [Buffer.concat([SQLITE, Buffer.alloc(10)]), /Datenbank/]
      };
      for (const [name, [data, msg]] of Object.entries(cases)) {
        const r = data === null ? await dst.request('POST', '/api/restore', { body: new FormData() }) : await restore(dst, data);
        assert.equal(r.status, 400, `${name}: ${r.status} ${r.text}`);
        assert.match(r.json.error, msg, name);
      }
      assert.deepEqual((await dst.get('/api/items')).json.map(i => i.title), ['Bleibt']);
      assert.equal((await dst.get('/api/backups')).json.files.length, 0, 'ohne Erfolg keine Sicherheitskopie');
      assert.deepEqual(fs.readdirSync(path.join(dst.dataDir, 'tmp')), [], 'Aufräumen auch bei Fehlern');
      assert.equal((await dst.get('/healthz')).status, 200);
    } finally { await dst.stop(); }
  });

  test('Pfade im ZIP: ".." und absolute Pfade werden nicht eingespielt', async () => {
    const dst = await startServer();
    try {
      await dst.item({ title: 'Bleibt' });
      for (const evil of ['../evil.png', 'uploads/../../evil.png', '/abs/evil.png', 'uploads/../../../evil.db']) {
        const zip = makeZip([{ name: 'reseller.db', data: files['reseller.db'] }, { name: evil, data: png(5) }]);
        const r = await restore(dst, zip);
        assert.equal(r.status, 400, evil);
        assert.match(r.json.error, /ungültige Dateipfade/, evil);
      }
      for (const dir of [dst.dataDir, path.dirname(dst.dataDir), path.join(dst.dataDir, 'uploads')]) {
        assert.ok(!fs.existsSync(path.join(dir, 'evil.png')), dir);
        assert.ok(!fs.existsSync(path.join(dir, 'evil.db')), dir);
      }
      assert.deepEqual((await dst.get('/api/items')).json.map(i => i.title), ['Bleibt']);
    } finally { await dst.stop(); }
  });

  test('Fotos im ZIP: nur echte Bilder mit sicherem Namen werden übernommen', async () => {
    const dst = await startServer();
    try {
      const keep = Object.keys(files).find(n => n.startsWith('uploads/') && n.endsWith('.png'));
      const zip = makeZip([
        { name: 'reseller.db', data: files['reseller.db'] },
        { name: keep, data: files[keep] },
        { name: 'uploads/skript.svg', data: '<svg><script>alert(1)</script></svg>' },
        { name: 'uploads/falsch.png', data: 'ich bin kein PNG' },
        { name: 'uploads/programm.exe', data: png(1) },
        { name: 'uploads/.versteckt.png', data: png(3) },
        { name: 'uploads/ok-neu.png', data: png(8) },
        { name: 'uploads/' + 'x'.repeat(200) + '.png', data: png(9) },
        { name: '__MACOSX/uploads/._x.png', data: png(9) }
      ]);
      const r = await restore(dst, zip);
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.skippedFiles, 5, 'svg, falsch.png, exe, versteckt, zu langer Name');
      assert.equal(r.json.images, 1, 'nur das zur Datenbank passende Foto');
      assert.equal(r.json.skippedImages, 3);
      // ok-neu.png gehört zu keinem Artikel und wird aufgeräumt
      assert.deepEqual(uploads(dst), [keep.slice('uploads/'.length)]);
    } finally { await dst.stop(); }
  });

  test('Mehrfach wiederherstellen: nur die neuesten zwei Sicherheitskopien bleiben', async () => {
    const dst = await startServer();
    try {
      for (let i = 0; i < 4; i++) assert.equal((await restore(dst, backupZip)).status, 200, `Durchgang ${i}`);
      const kept = (await dst.get('/api/backups')).json.files.filter(f => f.kind === 'pre-restore');
      assert.equal(kept.length, 2);
    } finally { await dst.stop(); }
  });

  test('Zu große Dateien werden begrenzt (MAX_RESTORE_MB)', async () => {
    const dst = await startServer({ env: { MAX_RESTORE_MB: '1' } });
    try {
      const r = await restore(dst, Buffer.concat([Buffer.from('PK'), Buffer.alloc(1.5 * 1024 * 1024)]));
      assert.equal(r.status, 400);
      assert.match(r.json.error, /zu groß/);
      assert.equal((await dst.get('/healthz')).status, 200);
    } finally { await dst.stop(); }
  });
});

describe('Automatische Sicherung', () => {
  const day = d => d.toISOString().slice(0, 10);

  test('Tägliche Kopie der Datenbank, ältere werden nach BACKUP_KEEP aufgeräumt', async () => {
    const dataDir = fs.mkdtempSync(path.join(tmp, 'auto-'));
    const dir = path.join(dataDir, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    for (let n = 1; n <= 5; n++) {
      const f = path.join(dir, `auto-2020-01-0${n}.db`);
      fs.writeFileSync(f, 'alt');
      const t = new Date(2020, 0, n); fs.utimesSync(f, t, t);
    }
    fs.writeFileSync(path.join(dir, 'notizen.txt'), 'bleibt');
    const t = await startServer({ dataDir, env: { BACKUP_AUTO: '1', BACKUP_START_DELAY_MS: '50', BACKUP_KEEP: '3' } });
    try {
      await t.item({ title: 'Gesichert' });
      const todayName = `auto-${day(new Date())}.db`;
      assert.ok(await waitFor(async () => (await t.get('/api/backups')).json.files.some(f => f.name === todayName)), 'Backup von heute erscheint');
      const list = (await t.get('/api/backups')).json;
      assert.equal(list.auto, true);
      assert.equal(list.keep, 3);
      assert.deepEqual(list.files.map(f => f.name).sort(), ['auto-2020-01-04.db', 'auto-2020-01-05.db', todayName].sort(), 'die drei neuesten bleiben');
      assert.ok(list.files.every(f => f.kind === 'auto'));
      assert.ok(fs.existsSync(path.join(dir, 'notizen.txt')), 'fremde Dateien werden nie gelöscht');
      assert.ok(!list.files.some(f => f.name === 'notizen.txt'));

      const dl = await t.get('/api/backups/' + todayName);
      assert.equal(dl.status, 200);
      assert.ok(isSqlite(dl.buf));
      assert.ok(!fs.existsSync(path.join(dir, todayName + '.part')));
    } finally { await t.stop(); }
  });

  test('Ausgeschaltet (BACKUP_AUTO=0) entsteht keine Datei', async () => {
    const t = await startServer({ env: { BACKUP_START_DELAY_MS: '10' } });
    try {
      await sleep(300);
      const list = (await t.get('/api/backups')).json;
      assert.equal(list.auto, false);
      assert.deepEqual(list.files, []);
    } finally { await t.stop(); }
  });

  test('Download nur für echte Sicherungsnamen, kein Zugriff auf andere Dateien', async () => {
    const t = await startServer();
    try {
      for (const name of ['reseller.db', '..%2Freseller.db', '..%2F..%2Fserver.js', 'auto-2020-01-01.db', 'auto-2020-01-01.db.part', 'pre-restore-x.zip', 'auto-2020-1-1.db', '%2e%2e']) {
        const r = await t.get('/api/backups/' + name);
        assert.equal(r.status, 404, name);
      }
    } finally { await t.stop(); }
  });
});
