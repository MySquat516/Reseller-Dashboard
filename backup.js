// Backup, Wiederherstellung und automatische Datenbank-Sicherung.
//
//   GET  /api/backup            ZIP mit Datenbank-Schnappschuss + allen Fotos zum Herunterladen
//   POST /api/restore           ZIP-Backup (oder eine .db-Datei) einspielen, ersetzt alle Daten
//   GET  /api/backups           Liste der Sicherungen im Ordner backups (automatisch + vor Wiederherstellung)
//   GET  /api/backups/:name     eine dieser Sicherungen herunterladen
//
// Umgebungsvariablen: BACKUP_AUTO=0 (aus), BACKUP_KEEP=14 (Anzahl Tage), BACKUP_DIR (Standard: DATA_DIR/backups),
// MAX_RESTORE_MB=4096 (größte erlaubte Backup-Datei)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const yazl = require('yazl');
const yauzl = require('yauzl');
const Database = require('better-sqlite3');

const pad = n => String(n).padStart(2, '0');
const dayOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const stampOf = d => `${dayOf(d)}_${pad(d.getHours())}${pad(d.getMinutes())}`;
const rand = () => crypto.randomBytes(6).toString('hex');
const userError = msg => Object.assign(new Error(msg), { user: true });

// Nur diese Bildendungen werden aus einem Backup übernommen, und der Dateikopf muss zur Endung passen.
const IMAGE_EXTS = { '.jpg': '.jpg', '.jpeg': '.jpg', '.png': '.png', '.gif': '.gif', '.webp': '.webp', '.heic': '.heic', '.heif': '.heic', '.avif': '.avif' };
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_DB_BYTES = 2 * 1024 ** 3;
const MAX_IMAGE_BYTES = 64 * 1024 ** 2;
const MAX_TOTAL_BYTES = 16 * 1024 ** 3;
const MAX_ENTRIES = 50000;
const AUTO_RE = /^auto-\d{4}-\d{2}-\d{2}\.db$/;
const SAFETY_RE = /^pre-restore-\d{4}-\d{2}-\d{2}_\d{4}(?:-[0-9a-f]{12})?\.zip$/;
const SAFETY_KEEP = 2;

module.exports = function setupBackup({ app, db, DATA_DIR, UPLOAD_DIR, sniffImageExt }) {
  const BACKUP_DIR = process.env.BACKUP_DIR || path.join(DATA_DIR, 'backups');
  const TMP_DIR = path.join(DATA_DIR, 'tmp');
  const AUTO = process.env.BACKUP_AUTO !== '0';
  const KEEP = Math.max(1, Math.floor(Number(process.env.BACKUP_KEEP)) || 14);
  const MAX_RESTORE_BYTES = (Number(process.env.MAX_RESTORE_MB) || 4096) * 1024 * 1024;

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  fs.rmSync(TMP_DIR, { recursive: true, force: true });   // Reste eines abgebrochenen Vorgangs
  fs.mkdirSync(TMP_DIR, { recursive: true });

  // ---------- Backup erzeugen ----------
  // Der Schnappschuss kommt über die SQLite-Backup-Funktion und ist auch bei laufendem Betrieb konsistent.
  async function buildZip() {
    const snap = path.join(TMP_DIR, `snapshot-${rand()}.db`);
    const cleanup = () => { for (const f of [snap, snap + '-wal', snap + '-shm']) fs.rm(f, { force: true }, () => {}); };
    try {
      await db.backup(snap);
      const s = new Database(snap, { readonly: true });
      let names, items;
      try {
        names = s.prepare('SELECT DISTINCT filename FROM images').all().map(r => r.filename);
        items = s.prepare('SELECT COUNT(*) c FROM items').get().c;
      } finally { s.close(); }
      const zip = new yazl.ZipFile();
      zip.addFile(snap, 'reseller.db');
      let photos = 0;
      for (const n of names) {
        const p = path.join(UPLOAD_DIR, n);
        if (path.basename(n) !== n || !fs.existsSync(p)) continue;
        zip.addFile(p, 'uploads/' + n, { compress: false });   // Fotos sind schon komprimiert
        photos++;
      }
      zip.addBuffer(Buffer.from(JSON.stringify({ app: 'reseller-dashboard', created: new Date().toISOString(), items, photos }, null, 2)), 'backup-info.json');
      zip.end();
      return { zip, cleanup };
    } catch (e) { cleanup(); throw e; }
  }

  function writeZip(zip, dest) {
    return new Promise((resolve, reject) => {
      const out = fs.createWriteStream(dest + '.part');
      const fail = e => { out.destroy(); fs.rmSync(dest + '.part', { force: true }); reject(e); };
      zip.outputStream.on('error', fail).pipe(out);
      out.on('error', fail).on('close', () => {
        try { fs.renameSync(dest + '.part', dest); resolve(); } catch (e) { fail(e); }
      });
    });
  }

  app.get('/api/backup', async (req, res) => {
    let b;
    try { b = await buildZip(); } catch (e) { return res.status(500).json({ error: 'Backup fehlgeschlagen: ' + e.message }); }
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="reseller-backup-${stampOf(new Date())}.zip"`,
      'Cache-Control': 'no-store'
    });
    b.zip.outputStream.on('error', () => res.destroy()).pipe(res);
    res.on('close', b.cleanup);
  });

  // ---------- Sicherungen im Ordner backups ----------
  function prune(re, keep) {
    const newestFirst = fs.readdirSync(BACKUP_DIR).filter(n => re.test(n))
      .map(n => ({ n, t: fs.statSync(path.join(BACKUP_DIR, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t || b.n.localeCompare(a.n));
    for (const { n } of newestFirst.slice(keep)) fs.rmSync(path.join(BACKUP_DIR, n), { force: true });
  }

  // Einmal pro Tag nur die Datenbank (klein, ohne Fotos); die letzten KEEP Tage bleiben
  async function autoBackup() {
    if (!AUTO) return;
    const dest = path.join(BACKUP_DIR, `auto-${dayOf(new Date())}.db`);
    if (fs.existsSync(dest)) return;
    try {
      await db.backup(dest + '.part');
      fs.renameSync(dest + '.part', dest);
      prune(AUTO_RE, KEEP);
      console.log(`Automatisches Backup: ${path.basename(dest)}`);
    } catch (e) {
      console.error('Automatisches Backup fehlgeschlagen:', e.message);
      fs.rmSync(dest + '.part', { force: true });
    }
  }
  if (AUTO) {
    setTimeout(autoBackup, Number(process.env.BACKUP_START_DELAY_MS ?? 10000)).unref();
    setInterval(autoBackup, 60 * 60 * 1000).unref();
  }

  app.get('/api/backups', (req, res) => {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(n => AUTO_RE.test(n) || SAFETY_RE.test(n))
      .map(name => {
        const st = fs.statSync(path.join(BACKUP_DIR, name));
        return { name, size: st.size, modified: st.mtime.toISOString(), kind: AUTO_RE.test(name) ? 'auto' : 'pre-restore' };
      })
      .sort((a, b) => b.modified.localeCompare(a.modified) || b.name.localeCompare(a.name));
    res.json({ auto: AUTO, keep: KEEP, files });
  });

  app.get('/api/backups/:name', (req, res) => {
    const n = req.params.name;
    if (!AUTO_RE.test(n) && !SAFETY_RE.test(n)) return res.status(404).json({ error: 'Nicht gefunden' });
    const p = path.join(BACKUP_DIR, n);
    if (!fs.existsSync(p)) return res.status(404).json({ error: 'Nicht gefunden' });
    res.download(p, n);
  });

  // ---------- Wiederherstellen ----------
  // Liest das ZIP, ohne jemals Pfade aus dem Archiv zu verwenden: Datenbank und Fotos landen immer an selbst
  // berechneten Stellen. Fotos werden nur übernommen, wenn Name, Endung und Dateikopf passen.
  function extractZip(zipPath, workDir) {
    return new Promise((resolve, reject) => {
      yauzl.open(zipPath, { lazyEntries: true }, (err, zf) => {
        if (err) return reject(userError('Die ZIP-Datei ist beschädigt oder nicht lesbar'));
        fs.mkdirSync(path.join(workDir, 'uploads'), { recursive: true });
        let failed = false, dbPath = null, skipped = 0, total = 0;
        const files = new Set();
        const fail = e => { if (failed) return; failed = true; zf.close(); reject(e); };
        if (zf.entryCount > MAX_ENTRIES) return fail(userError('Zu viele Einträge im Backup'));
        // yauzl lehnt Einträge mit „..“ oder absoluten Pfaden schon beim Lesen ab
        zf.on('error', e => fail(userError(/relative path|absolute path/.test(e.message)
          ? 'Das ZIP enthält ungültige Dateipfade und wird nicht eingespielt'
          : 'Die ZIP-Datei ist beschädigt: ' + e.message)));
        zf.on('end', () => (dbPath ? resolve({ dbPath, files: [...files], skipped }) : fail(userError('Im Backup fehlt die Datei reseller.db'))));
        zf.on('entry', entry => {
          const name = entry.fileName;
          const isDb = /(^|\/)reseller\.db$/.test(name);
          const m = /(^|\/)uploads\/([^/]+)$/.exec(name);
          if (name.endsWith('/') || name.startsWith('__MACOSX/') || (!isDb && !m) || (isDb && dbPath)) return zf.readEntry();
          if (isDb && entry.uncompressedSize > MAX_DB_BYTES) return fail(userError('Die Datenbank im Backup ist zu groß'));
          let target, imgName;
          if (isDb) target = path.join(workDir, 'reseller.db');
          else {
            imgName = m[2];
            if (!SAFE_NAME.test(imgName) || !IMAGE_EXTS[path.extname(imgName).toLowerCase()] || entry.uncompressedSize > MAX_IMAGE_BYTES) {
              skipped++;
              return zf.readEntry();
            }
            target = path.join(workDir, 'uploads', imgName);
          }
          total += entry.uncompressedSize;
          if (total > MAX_TOTAL_BYTES) return fail(userError('Das Backup ist zu groß'));
          zf.openReadStream(entry, (e, rs) => {
            if (e) return fail(userError('Eintrag nicht lesbar: ' + path.basename(name)));
            const ws = fs.createWriteStream(target);
            rs.on('error', er => { ws.destroy(); fail(userError('Das Backup ist beschädigt: ' + er.message)); });
            ws.on('error', fail);
            ws.on('close', () => {
              if (failed) return;
              if (isDb) dbPath = target;
              else if (sniffImageExt(target) === IMAGE_EXTS[path.extname(imgName).toLowerCase()]) files.add(imgName);
              else { fs.rmSync(target, { force: true }); skipped++; }
              zf.readEntry();
            });
            rs.pipe(ws);
          });
        });
        zf.readEntry();
      });
    });
  }

  function checkDb(dbPath) {
    let chk;
    try { chk = new Database(dbPath, { readonly: true, fileMustExist: true }); }
    catch { throw userError('Die Datenbank im Backup lässt sich nicht öffnen'); }
    try {
      if (chk.pragma('integrity_check', { simple: true }) !== 'ok') throw userError('Die Datenbank im Backup ist beschädigt');
      const cols = chk.prepare('PRAGMA table_info(items)').all().map(c => c.name);
      if (!['id', 'title', 'status'].every(c => cols.includes(c))) throw userError('Das ist kein Backup dieser App (Tabelle „items“ fehlt)');
    } catch (e) {
      if (e.user) throw e;
      throw userError('Die Datenbank im Backup ist unlesbar');
    } finally { chk.close(); }
  }

  // Ersetzt Artikel, Bilder, Vorlagen und Einstellungen in einer Transaktion (alles oder nichts).
  // Spalten werden nach Namen kopiert, damit auch Backups aus älteren Versionen passen.
  function swapIn(dbPath, available) {
    db.exec(`ATTACH DATABASE '${dbPath.replace(/'/g, "''")}' AS r`);
    try {
      const hasTable = t => !!db.prepare("SELECT 1 FROM r.sqlite_master WHERE type = 'table' AND name = ?").get(t);
      const copy = t => {
        const theirs = new Set(db.prepare(`PRAGMA r.table_info(${t})`).all().map(c => c.name));
        const cols = db.prepare(`PRAGMA main.table_info(${t})`).all().map(c => c.name).filter(c => theirs.has(c))
          .map(c => `"${c}"`).join(', ');
        return `INSERT INTO main.${t} (${cols}) SELECT ${cols} FROM r.${t}`;
      };
      db.exec('CREATE TEMP TABLE IF NOT EXISTS avail (name TEXT PRIMARY KEY)');
      return db.transaction(() => {
        db.exec('DELETE FROM temp.avail');
        const ins = db.prepare('INSERT OR IGNORE INTO temp.avail (name) VALUES (?)');
        for (const n of available) ins.run(n);
        db.exec('DELETE FROM main.images; DELETE FROM main.items');
        db.exec(copy('items'));
        if (hasTable('shipping_presets')) { db.exec('DELETE FROM main.shipping_presets'); db.exec(copy('shipping_presets')); }
        if (hasTable('settings')) { db.exec('DELETE FROM main.settings'); db.exec(copy('settings')); }
        let theirImages = 0;
        if (hasTable('images')) {
          theirImages = db.prepare('SELECT COUNT(*) c FROM r.images').get().c;
          // Bildzeilen nur, wenn die Datei vorhanden ist und der Artikel existiert
          db.exec(copy('images') + ' WHERE filename IN (SELECT name FROM temp.avail) AND item_id IN (SELECT id FROM main.items)');
        }
        const items = db.prepare('SELECT COUNT(*) c FROM main.items').get().c;
        const images = db.prepare('SELECT COUNT(*) c FROM main.images').get().c;
        return { items, images, skippedImages: theirImages - images };
      })();
    } finally {
      try { db.exec('DETACH DATABASE r'); } catch { /* wird beim Schließen der Verbindung gelöst */ }
    }
  }

  const moveInto = (from, to) => {
    try { fs.renameSync(from, to); } catch { fs.copyFileSync(from, to); fs.rmSync(from, { force: true }); }
  };

  async function restoreFrom(uploadPath) {
    const head = Buffer.alloc(16);
    const fd = fs.openSync(uploadPath, 'r');
    try { fs.readSync(fd, head, 0, 16, 0); } finally { fs.closeSync(fd); }
    const mode = head.toString('latin1', 0, 15) === 'SQLite format 3' ? 'db' : head.toString('latin1', 0, 2) === 'PK' ? 'zip' : null;
    if (!mode) throw userError('Das ist weder ein ZIP-Backup noch eine Datenbank-Datei');

    const work = path.join(TMP_DIR, `restore-${rand()}`);
    fs.mkdirSync(work, { recursive: true });
    try {
      let dbPath, files = [], skippedFiles = 0;
      if (mode === 'zip') ({ dbPath, files, skipped: skippedFiles } = await extractZip(uploadPath, work));
      else { dbPath = path.join(work, 'reseller.db'); fs.copyFileSync(uploadPath, dbPath); }
      checkDb(dbPath);

      // Sicherheitskopie des aktuellen Stands (mit Fotos), bevor irgendetwas überschrieben wird
      let safety = `pre-restore-${stampOf(new Date())}.zip`;
      if (fs.existsSync(path.join(BACKUP_DIR, safety))) safety = safety.replace('.zip', `-${rand()}.zip`);
      const b = await buildZip();
      try { await writeZip(b.zip, path.join(BACKUP_DIR, safety)); } finally { b.cleanup(); }
      prune(SAFETY_RE, SAFETY_KEEP);

      for (const n of files) moveInto(path.join(work, 'uploads', n), path.join(UPLOAD_DIR, n));
      const present = fs.readdirSync(UPLOAD_DIR);   // übernommene Fotos + schon vorhandene mit gleichem Namen
      const result = swapIn(dbPath, present);

      // Fotos, die zu keinem Artikel mehr gehören, entfernen (der alte Stand steckt in der Sicherheitskopie)
      const used = new Set(db.prepare('SELECT filename FROM images').all().map(r => r.filename));
      for (const n of present) {
        const p = path.join(UPLOAD_DIR, n);
        if (!used.has(n) && fs.statSync(p).isFile()) fs.rmSync(p, { force: true });
      }
      return { mode, ...result, skippedFiles, safety };
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }

  const receive = multer({ dest: TMP_DIR, limits: { fileSize: MAX_RESTORE_BYTES, files: 1 } }).single('backup');
  let restoring = false;
  app.post('/api/restore', (req, res) => {
    if (restoring) return res.status(409).json({ error: 'Es läuft schon eine Wiederherstellung' });
    restoring = true;
    receive(req, res, async err => {
      try {
        if (err) throw userError(err.code === 'LIMIT_FILE_SIZE' ? 'Die Datei ist zu groß' : 'Upload fehlgeschlagen: ' + err.message);
        if (!req.file) throw userError('Keine Datei hochgeladen');
        res.json({ ok: true, ...(await restoreFrom(req.file.path)) });
      } catch (e) {
        if (!e.user) console.error('Wiederherstellung fehlgeschlagen:', e);
        res.status(e.user ? 400 : 500).json({ error: e.user ? e.message : 'Wiederherstellung fehlgeschlagen: ' + e.message });
      } finally {
        if (req.file) fs.rmSync(req.file.path, { force: true });
        restoring = false;
      }
    });
  });
};
