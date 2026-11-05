// Optionaler Passwortschutz (APP_PASSWORD): Zugriff, Anmeldung, Token, Bremse gegen Durchprobieren.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { startServer, png, sleep } = require('../testlib/harness');

const PASS = 'geheimes-passwort-123';
const USER = 'leon';
const AUTH_ENV = { APP_PASSWORD: PASS, APP_USER: USER };
const login = (srv, body = { username: USER, password: PASS }, headers) => srv.post('/api/login', body, { headers });
const cookieOf = res => /rd_session=([^;]*)/.exec(res.headers.get('set-cookie') || '')?.[1];
const withCookie = token => ({ headers: { cookie: `rd_session=${token}` } });
const bearer = token => ({ headers: { authorization: `Bearer ${token}` } });
const form = obj => ({ body: new URLSearchParams(obj).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });

// Anfrage mit unverändertem Pfad (fetch würde ".." vorher auflösen)
function rawGet(srv, rawPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: srv.port, path: rawPath }, res => {
      const parts = [];
      res.on('data', c => parts.push(c)).on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(parts).toString() }));
    }).on('error', reject);
  });
}

describe('Ohne APP_PASSWORD', () => {
  let s;
  before(async () => { s = await startServer(); });
  after(() => s.stop());

  test('Alles offen, Sitzungsabfrage meldet "kein Login"', async () => {
    assert.equal((await s.get('/api/items')).status, 200);
    assert.deepEqual((await s.get('/api/session')).json, { auth: false });
    assert.deepEqual((await s.post('/api/logout')).json, { ok: true });
    assert.match(s.log, /Kein APP_PASSWORD gesetzt/);
  });

  test('Es gibt keine Anmelde-Routen', async () => {
    assert.equal((await s.post('/api/login', { username: 'a', password: 'b' })).status, 404);
    assert.equal((await s.get('/login')).status, 404);
  });
});

describe('Mit Passwort: Zugriff', () => {
  let s, token;
  before(async () => {
    s = await startServer({ env: AUTH_ENV });
    token = (await login(s)).json.token;
  });
  after(() => s.stop());

  test('API ohne Sitzung: 401 als JSON, nie Daten', async () => {
    const calls = [
      ['GET', '/api/items'], ['POST', '/api/items'], ['GET', '/api/items/1'], ['PUT', '/api/items/1'], ['DELETE', '/api/items/1'],
      ['POST', '/api/items/1/duplicate'], ['POST', '/api/items/1/images'], ['DELETE', '/api/images/1'], ['PUT', '/api/items/1/images/order'],
      ['GET', '/api/stats'], ['GET', '/api/sales'], ['GET', '/api/export.csv'], ['POST', '/api/import.csv'],
      ['GET', '/api/settings'], ['PUT', '/api/settings'], ['GET', '/api/shipping-presets'], ['POST', '/api/shipping-presets'],
      ['GET', '/api/backup'], ['GET', '/api/backups'], ['GET', '/api/backups/auto-2026-01-01.db'], ['POST', '/api/restore'],
      ['GET', '/api/session'], ['GET', '/uploads/irgendwas.png']
    ];
    for (const [method, url] of calls) {
      const r = await s.request(method, url);
      assert.equal(r.status, 401, `${method} ${url}`);
      assert.deepEqual(r.json, { error: 'Nicht angemeldet' }, `${method} ${url}`);
      assert.equal(r.headers.get('cache-control'), 'no-store');
    }
  });

  test('Seiten ohne Sitzung: Weiterleitung zur Anmeldung mit Rückkehr-Adresse', async () => {
    for (const [url, next] of [['/', '/'], ['/index.html', '/index.html'], ['/app.js', '/app.js'], ['/?tab=artikel', '/?tab=artikel'], ['/login.html', '/login.html']]) {
      const r = await s.get(url);
      assert.equal(r.status, 302, url);
      assert.equal(r.headers.get('location'), '/login?next=' + encodeURIComponent(next), url);
    }
    assert.equal((await s.get('/vendor/chart.js/chart.umd.js')).status, 302, 'auch Skripte');
  });

  test('Öffentlich: Healthcheck, Logo, Manifest, Symbole, Anmeldeseite', async () => {
    for (const p of ['/healthz', '/logo.svg', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/apple-touch-icon.png', '/login']) {
      assert.equal((await s.get(p)).status, 200, p);
    }
    const page = await s.get('/login');
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.match(page.text, /<form[^>]+method="post"/i);
    assert.doesNotMatch(page.text, /\{\{/, 'alle Platzhalter ersetzt');
  });

  test('Öffentliche Pfade lassen sich nicht zum Umgehen nutzen', async () => {
    for (const p of ['/icons/../api/items', '/icons/../../server.js', '/healthz/../api/items']) {
      const r = await rawGet(s, p);
      assert.notEqual(r.status, 200, p);
      assert.doesNotMatch(r.body, /"title"|require\(/, p);
    }
    // Nur Lesezugriffe (GET/HEAD) auf diese Pfade sind offen; alles andere braucht eine Sitzung
    for (const [method, p] of [['POST', '/healthz'], ['POST', '/logo.svg'], ['PUT', '/manifest.webmanifest'], ['DELETE', '/icons/icon-192.png']]) {
      const r = await s.request(method, p);
      assert.ok(r.status === 302 || r.status === 401, `${method} ${p}: ${r.status}`);
    }
  });

  test('Mit gültigem Cookie oder Bearer-Token ist alles erreichbar', async () => {
    assert.equal((await s.get('/api/items', withCookie(token))).status, 200);
    assert.equal((await s.get('/api/items', bearer(token))).status, 200);
    assert.equal((await s.get('/', withCookie(token))).status, 200);
    assert.equal((await s.get('/api/export.csv', withCookie(token))).status, 200);
    assert.equal((await s.get('/api/backup', withCookie(token))).status, 200);
    assert.equal((await s.get('/api/items', { headers: { cookie: `a=b; rd_session=${token}; c=d` } })).status, 200, 'zwischen anderen Cookies');
    assert.equal((await s.get('/api/items', { headers: { authorization: `bearer ${token}` } })).status, 200, 'Schreibweise egal');
    assert.deepEqual((await s.get('/api/session', withCookie(token))).json, { auth: true, user: USER });
  });

  test('Ungültige Token: falsch, verändert, abgeschnitten, fremder Aufbau', async () => {
    const [v, exp, sig] = token.split('.');
    const flipped = sig.slice(0, -1) + (sig.at(-1) === 'A' ? 'B' : 'A');
    const bad = ['', 'abc', token + 'x', token.slice(0, -2), `${v}.${exp}.${flipped}`, `${v}.${Number(exp) + 100000}.${sig}`, `v2.${exp}.${sig}`,
      `${v}.${exp}`, `${v}.${exp}.${sig}.extra`, `${v}.-1.${sig}`];
    for (const t of bad) {
      assert.equal((await s.get('/api/items', withCookie(t))).status, 401, `Cookie ${t}`);
      assert.equal((await s.get('/api/items', bearer(t || 'x'))).status, 401, `Bearer ${t}`);
    }
    assert.equal((await s.get('/api/items', { headers: { authorization: `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}` } })).status, 401, 'Basic-Auth gibt es nicht');
  });

  test('Hochgeladene Fotos sind nur mit Sitzung abrufbar', async () => {
    const id = (await s.post('/api/items', { title: 'Mit Foto' }, bearer(token))).json.id;
    const up = await s.upload(`/api/items/${id}/images`, 'images', [{ name: 'a.png', data: png(1) }], { headers: bearer(token).headers });
    assert.equal(up.status, 201);
    const url = (await s.get('/api/items/' + id, bearer(token))).json.images[0].url;
    assert.equal((await s.get(url)).status, 401);
    assert.equal((await s.get(url, withCookie(token))).status, 200);
  });

  test('Import und Wiederherstellung nur mit Sitzung', async () => {
    const csv = 'Titel\nGeheim';
    assert.equal((await s.request('POST', '/api/import.csv', { body: csv, headers: { 'content-type': 'text/csv' } })).status, 401);
    assert.equal((await s.upload('/api/restore', 'backup', [{ name: 'x.zip', data: Buffer.from('PK') }])).status, 401);
    const ok = await s.request('POST', '/api/import.csv', { body: csv, headers: { 'content-type': 'text/csv', cookie: `rd_session=${token}` }, query: { dry: 1 } });
    assert.equal(ok.status, 200);
  });
});

describe('Mit Passwort: Anmelden', () => {
  let s;
  before(async () => { s = await startServer({ env: AUTH_ENV }); });
  after(() => s.stop());

  test('Erfolg: Token, Cookie mit HttpOnly und SameSite, ohne Secure über HTTP', async () => {
    const r = await login(s);
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.user, USER);
    assert.match(r.json.token, /^v1\.\d{10}\.[A-Za-z0-9_-]{43}$/);
    const exp = Number(r.json.token.split('.')[1]);
    assert.ok(Math.abs(exp - (Date.now() / 1000 + 90 * 86400)) < 60, 'Standard: 90 Tage');
    const cookie = r.headers.get('set-cookie');
    assert.equal(cookieOf(r), r.json.token);
    assert.match(cookie, /; Path=\//);
    assert.match(cookie, /; HttpOnly/);
    assert.match(cookie, /; SameSite=Lax/);
    assert.match(cookie, /; Max-Age=7776000/);
    assert.doesNotMatch(cookie, /Secure/);
  });

  test('Hinter einem HTTPS-Proxy bekommt das Cookie "Secure"', async () => {
    const r = await login(s, undefined, { 'x-forwarded-proto': 'https' });
    assert.match(r.headers.get('set-cookie'), /; Secure/);
  });

  test('Falsches Passwort oder falscher Benutzer: 401, kein Cookie, gleiche Meldung', async () => {
    for (const body of [{ username: USER, password: 'falsch' }, { username: 'jemand', password: PASS }, { username: USER }, { password: PASS }, {}, { username: [USER], password: [PASS] }]) {
      const r = await login(s, body);
      assert.equal(r.status, 401, JSON.stringify(body));
      assert.equal(r.json.error, 'Benutzername oder Passwort stimmt nicht.');
      assert.equal(r.headers.get('set-cookie'), null);
      assert.equal(r.json.token, undefined);
      assert.equal((await login(s)).status, 200, 'richtige Anmeldung zwischendurch setzt die Bremse zurück');
    }
  });

  test('Kaputte Anfragen: 400/401 statt 500', async () => {
    await login(s);
    const wrongType = await s.request('POST', '/api/login', { body: `username=${USER}&password=${PASS}`, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert.equal(wrongType.status, 401, 'Formulardaten an die JSON-Route');
    const broken = await s.request('POST', '/api/login', { body: '{"username": ', headers: { 'content-type': 'application/json' } });
    assert.equal(broken.status, 400);
    const big = await login(s, { username: USER, password: 'x'.repeat(10000) });
    assert.equal(big.status, 413);
    assert.equal((await s.get('/healthz')).status, 200);
  });

  test('Abmelden löscht das Cookie', async () => {
    const r = await s.post('/api/logout');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('set-cookie'), /^rd_session=; .*Max-Age=0/);
  });
});

describe('Mit Passwort: Anmeldeformular', () => {
  let s;
  before(async () => { s = await startServer({ env: AUTH_ENV }); });
  after(() => s.stop());

  test('Erfolg: 303 zur Zielseite mit Cookie, das auch für die Seite gilt', async () => {
    const r = await s.request('POST', '/login', form({ username: USER, password: PASS, next: '/?tab=artikel' }));
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), '/?tab=artikel');
    const token = cookieOf(r);
    assert.ok(token);
    assert.equal((await s.get('/', withCookie(token))).status, 200);
  });

  test('Nur Adressen auf derselben Seite sind als Ziel erlaubt', async () => {
    for (const [next, want] of [['//evil.example', '/'], ['/\\evil.example', '/'], ['https://evil.example', '/'], ['javascript:alert(1)', '/'], ['evil', '/'], ['', '/'],
      ['/api/items', '/api/items'], ['/?a=1&b=2', '/?a=1&b=2'], ['/' + 'x'.repeat(600), '/']]) {
      const r = await s.request('POST', '/login', form({ username: USER, password: PASS, next }));
      assert.equal(r.status, 303, next);
      assert.equal(r.headers.get('location'), want, next);
    }
  });

  test('Falsche Eingabe: Seite mit Fehlermeldung, Benutzername bleibt, alles HTML-sicher', async () => {
    const evil = '"><script>alert(1)</script>';
    const r = await s.request('POST', '/login', form({ username: evil, password: 'falsch', next: evil }));
    assert.equal(r.status, 401);
    assert.match(r.headers.get('content-type'), /text\/html/);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.match(r.text, /role="alert"/);
    assert.match(r.text, /Passwort stimmt nicht/);
    assert.doesNotMatch(r.text, /<script>alert\(1\)/, 'Eingaben werden maskiert');
    assert.match(r.text, /&quot;&gt;&lt;script&gt;/);
    assert.equal(cookieOf(r), undefined);
  });

  test('Anmeldeseite: Rückkehr-Adresse maskiert; mit Sitzung geht es direkt weiter', async () => {
    const page = await s.get('/login', { query: { next: '/"><script>x</script>' } });
    assert.doesNotMatch(page.text, /<script>x<\/script>/);
    const token = (await login(s)).json.token;
    const again = await s.get('/login', { query: { next: '/api/items' }, ...withCookie(token) });
    assert.equal(again.status, 302);
    assert.equal(again.headers.get('location'), '/api/items');
    const sneaky = await s.get('/login', { query: { next: '//evil.example' }, ...withCookie(token) });
    assert.equal(sneaky.headers.get('location'), '/');
  });
});

describe('Mit Passwort: Bremse gegen Durchprobieren', () => {
  test('Nach 5 Fehlversuchen gesperrt, auch mit richtigem Passwort; Sperre meldet Wartezeit', async () => {
    const s = await startServer({ env: AUTH_ENV });
    try {
      for (let i = 0; i < 5; i++) assert.equal((await login(s, { username: USER, password: 'falsch' + i })).status, 401, `Versuch ${i + 1}`);
      const blocked = await login(s);
      assert.equal(blocked.status, 429);
      assert.match(blocked.json.error, /Zu viele Versuche/);
      const wait = Number(blocked.headers.get('retry-after'));
      assert.ok(wait > 0 && wait <= 300, `Retry-After ${wait}`);
      assert.equal(blocked.headers.get('set-cookie'), null);
      const viaForm = await s.request('POST', '/login', form({ username: USER, password: PASS }));
      assert.equal(viaForm.status, 429, 'Formular teilt sich die Sperre');
      assert.match(viaForm.text, /Zu viele Versuche/);
      assert.equal((await s.get('/healthz')).status, 200, 'Healthcheck bleibt frei');
    } finally { await s.stop(); }
  });

  test('Erfolgreiche Anmeldung setzt den Zähler zurück', async () => {
    const s = await startServer({ env: AUTH_ENV });
    try {
      for (let round = 0; round < 3; round++) {
        for (let i = 0; i < 4; i++) assert.equal((await login(s, { username: USER, password: 'falsch' })).status, 401, `Runde ${round}`);
        assert.equal((await login(s)).status, 200, `Runde ${round}`);
      }
    } finally { await s.stop(); }
  });
});

describe('Mit Passwort: Lebensdauer und Schlüssel', () => {
  test('Token läuft ab (SESSION_DAYS)', async () => {
    const s = await startServer({ env: { ...AUTH_ENV, SESSION_DAYS: '0.00004' } });   // etwa 3 Sekunden
    try {
      const r = await login(s);
      assert.match(r.headers.get('set-cookie'), /Max-Age=3\b/);
      assert.equal((await s.get('/api/items', bearer(r.json.token))).status, 200);
      await sleep(3300);
      assert.equal((await s.get('/api/items', bearer(r.json.token))).status, 401);
    } finally { await s.stop(); }
  });

  test('Nach Neustart bleibt man angemeldet; neues Passwort oder anderer Benutzer meldet überall ab', async () => {
    const a = await startServer({ env: AUTH_ENV });
    let token;
    try {
      token = (await login(a)).json.token;
      const secret = path.join(a.dataDir, 'session-secret');
      assert.ok(fs.readFileSync(secret, 'utf8').trim().length >= 32, 'Geheimnis wird gespeichert');
      assert.equal(fs.statSync(secret).mode & 0o077, 0, 'nur der Besitzer darf lesen');
    } finally { await a.stop({ keepData: true }); }

    const same = await startServer({ dataDir: a.dataDir, env: AUTH_ENV });
    try { assert.equal((await same.get('/api/items', bearer(token))).status, 200, 'gleiches Passwort: weiter angemeldet'); }
    finally { await same.stop({ keepData: true }); }

    const newPass = await startServer({ dataDir: a.dataDir, env: { ...AUTH_ENV, APP_PASSWORD: PASS + '-neu' } });
    try {
      assert.equal((await newPass.get('/api/items', bearer(token))).status, 401, 'neues Passwort');
      assert.equal((await login(newPass)).status, 401, 'altes Passwort geht nicht mehr');
      assert.equal((await login(newPass, { username: USER, password: PASS + '-neu' })).status, 200);
    } finally { await newPass.stop({ keepData: true }); }

    const newUser = await startServer({ dataDir: a.dataDir, env: { ...AUTH_ENV, APP_USER: 'anna' } });
    try { assert.equal((await newUser.get('/api/items', bearer(token))).status, 401, 'anderer Benutzer'); }
    finally { await newUser.stop(); }
  });

  test('SESSION_SECRET aus der Umgebung ersetzt die Datei; anderes Geheimnis = andere Tokens', async () => {
    const secretA = 'a'.repeat(40), secretB = 'b'.repeat(40);
    const a = await startServer({ env: { ...AUTH_ENV, SESSION_SECRET: secretA } });
    let token;
    try {
      token = (await login(a)).json.token;
      assert.ok(!fs.existsSync(path.join(a.dataDir, 'session-secret')));
    } finally { await a.stop({ keepData: true }); }
    const b = await startServer({ dataDir: a.dataDir, env: { ...AUTH_ENV, SESSION_SECRET: secretB } });
    try { assert.equal((await b.get('/api/items', bearer(token))).status, 401); } finally { await b.stop({ keepData: true }); }
    const a2 = await startServer({ dataDir: a.dataDir, env: { ...AUTH_ENV, SESSION_SECRET: secretA } });
    try { assert.equal((await a2.get('/api/items', bearer(token))).status, 200); } finally { await a2.stop(); }
  });

  test('Zu kurzes Passwort startet trotzdem, warnt aber im Log', async () => {
    const s = await startServer({ env: { ...AUTH_ENV, APP_PASSWORD: 'kurz' } });
    try {
      assert.match(s.log, /WARNUNG: APP_PASSWORD ist kürzer als 8 Zeichen/);
      assert.equal((await login(s, { username: USER, password: 'kurz' })).status, 200);
    } finally { await s.stop(); }
  });

  test('Das Passwort taucht nirgends im Log auf', async () => {
    const s = await startServer({ env: AUTH_ENV });
    try {
      await login(s); await login(s, { username: USER, password: 'falsch-xyz' });
      assert.doesNotMatch(s.log, new RegExp(PASS));
      assert.doesNotMatch(s.log, /falsch-xyz/);
      assert.match(s.log, /Passwortschutz aktiv \(Benutzer: leon\)/);
    } finally { await s.stop(); }
  });
});
