// Hilfen für die Server-Tests. Liegt bewusst NICHT in test/, denn `node --test` führt jede .js-Datei in test/ als Test aus.
//
// startServer() startet den echten Server (node server.js) auf einem freien Port mit eigenem, leerem Datenordner.
// So laufen die Tests gegen genau das, was auch im Container läuft: Express, SQLite, Uploads, Backup, Login.
const { spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const yauzl = require('yauzl');

const ROOT = path.join(__dirname, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function parse(res) {
  const buf = Buffer.from(await res.arrayBuffer());
  const type = res.headers.get('content-type') || '';
  const text = /^(text\/|application\/(json|javascript))|charset=/.test(type) ? buf.toString('utf8') : '';
  let json;
  if (type.includes('json')) { try { json = JSON.parse(text); } catch { /* bleibt undefined */ } }
  return { status: res.status, headers: res.headers, buf, text, json };
}

// env: zusätzliche Umgebungsvariablen (z. B. APP_PASSWORD); dataDir: vorhandenen Ordner weiterverwenden (Neustart-Tests)
async function startServer({ env = {}, dataDir } = {}) {
  const ownDir = !dataDir;
  dataDir ||= fs.mkdtempSync(path.join(os.tmpdir(), 'rd-test-'));
  // Nichts aus der Umgebung des Entwicklers durchlassen, das den Test verändern könnte
  const clean = { ...process.env };
  for (const k of ['APP_PASSWORD', 'APP_USER', 'SESSION_DAYS', 'SESSION_SECRET', 'BACKUP_DIR', 'BACKUP_KEEP', 'MAX_RESTORE_MB']) delete clean[k];

  // Zwischen "Port ist frei" und "Server belegt ihn" kann ein parallel laufender Test denselben Port erwischen: dann neu versuchen
  let child, port, base, log, exited;
  for (let attempt = 1; ; attempt++) {
    port = await freePort();
    base = `http://127.0.0.1:${port}`;
    log = '';
    exited = null;
    child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...clean, TZ: 'UTC', PORT: String(port), DATA_DIR: dataDir, BACKUP_AUTO: '0', ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', d => { log += d; });
    child.stderr.on('data', d => { log += d; });
    child.once('exit', (code, signal) => { exited = { code, signal }; });

    const started = Date.now();
    let ready = false;
    while (!ready) {
      if (exited) break;
      // Erst wenn der Server selbst meldet, dass er auf seinem Port lauscht (sonst könnte ein fremder Server auf dem Port antworten)
      if (log.includes(`läuft auf Port ${port}`)) {
        try { ready = (await fetch(base + '/healthz')).ok; } catch { /* noch nicht bereit */ }
      }
      if (ready) break;
      if (Date.now() - started > 15000) { child.kill('SIGKILL'); throw new Error('Server startet nicht innerhalb von 15 s:\n' + log); }
      await sleep(40);
    }
    if (ready) break;
    if (attempt < 3 && /EADDRINUSE/.test(log)) continue;
    throw new Error(`Server beendet (${exited.code ?? exited.signal}) vor dem Start:\n${log}`);
  }

  const request = async (method, url, { json, body, headers = {}, query } = {}) => {
    const h = { ...headers };
    let payload = body;
    if (json !== undefined) { payload = JSON.stringify(json); h['content-type'] ??= 'application/json'; }
    const qs = query ? '?' + new URLSearchParams(query) : '';
    return parse(await fetch(base + url + qs, { method, headers: h, body: payload, redirect: 'manual' }));
  };

  const server = {
    url: base, port, dataDir, child,
    get log() { return log; },
    request,
    get: (u, o) => request('GET', u, o),
    post: (u, json, o) => request('POST', u, { ...o, json }),
    put: (u, json, o) => request('PUT', u, { ...o, json }),
    del: (u, o) => request('DELETE', u, o),
    // Mehrteiliger Upload, files: [{ name, data(Buffer), type? }]
    upload: (u, field, files, { method = 'POST', headers } = {}) => {
      const fd = new FormData();
      for (const f of files) fd.append(field, new Blob([f.data], { type: f.type || 'application/octet-stream' }), f.name);
      return request(method, u, { body: fd, headers });
    },
    // Artikel anlegen und die ID zurückgeben
    async item(data, o) {
      const r = await request('POST', '/api/items', { json: data, ...o });
      if (r.status !== 201) throw new Error(`Artikel anlegen: ${r.status} ${r.text}`);
      return r.json.id;
    },
    // Alle Artikel löschen (zwischen Tests)
    async reset() {
      for (const it of (await request('GET', '/api/items')).json) await request('DELETE', '/api/items/' + it.id);
    },
    async stop({ keepData = false } = {}) {
      if (!exited) {
        child.kill('SIGTERM');
        await new Promise(r => { const t = setTimeout(() => { child.kill('SIGKILL'); }, 3000); child.once('exit', () => { clearTimeout(t); r(); }); });
      }
      if (ownDir && !keepData) fs.rmSync(dataDir, { recursive: true, force: true });
    }
  };
  return server;
}

// ---------- Testdateien ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = buf => { let c = 0xFFFFFFFF; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };

// Gültiges 1×1-PNG; seed macht den Inhalt eindeutig
function png(seed = 0) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
  const pixel = zlib.deflateSync(Buffer.from([0, seed & 255, (seed >> 8) & 255, 128]));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk('IHDR', ihdr), chunk('IDAT', pixel), chunk('IEND', Buffer.alloc(0))]);
}

// Dateien mit dem richtigen Anfang, aber ohne echtes Bild: Der Server prüft nur die ersten Bytes
const MAGIC = {
  jpg: Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10, 0x4A, 0x46, 0x49, 0x46, 0, 1]),
  gif: Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1'),
  webp: Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBPVP8 ')]),
  heic: Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(8)]),
  avif: Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypavif'), Buffer.alloc(8)])
};

// ---------- ZIP ----------
// Minimaler ZIP-Schreiber ohne Kompression, der beliebige Dateinamen erlaubt (auch "../x"), die gängige Bibliotheken ablehnen.
function makeZip(entries) {
  const locals = [], central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const n = Buffer.from(name, 'utf8');
    const d = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const crc = crc32(d);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(d.length, 18); lh.writeUInt32LE(d.length, 22); lh.writeUInt16LE(n.length, 26);
    locals.push(lh, n, d);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(d.length, 20); ch.writeUInt32LE(d.length, 24); ch.writeUInt16LE(n.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, n);
    offset += 30 + n.length + d.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// ZIP lesen: { 'name': Buffer }
function readZip(buf) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zf) => {
      if (err) return reject(err);
      const out = {};
      zf.on('error', reject);
      zf.on('end', () => resolve(out));
      zf.on('entry', entry => {
        if (entry.fileName.endsWith('/')) return zf.readEntry();
        zf.openReadStream(entry, (e, rs) => {
          if (e) return reject(e);
          const parts = [];
          rs.on('data', c => parts.push(c)).on('end', () => { out[entry.fileName] = Buffer.concat(parts); zf.readEntry(); }).on('error', reject);
        });
      });
      zf.readEntry();
    });
  });
}

const today = () => new Date().toISOString().slice(0, 10);
// Tag relativ zu heute (UTC, wie der Server in den Tests läuft), n Tage zurück
const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

module.exports = { ROOT, startServer, png, crc32, MAGIC, makeZip, readZip, today, daysAgo, sleep };
