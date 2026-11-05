// Optionaler Passwortschutz. Aktiv nur, wenn die Umgebungsvariable APP_PASSWORD gesetzt ist;
// ohne sie verhält sich die App wie bisher (gedacht für Heimnetz/VPN).
//
// Umgebungsvariablen: APP_PASSWORD (schaltet den Schutz ein), APP_USER (Standard "admin"),
// SESSION_DAYS (Standard 90), SESSION_SECRET (Standard: zufälliger Wert in DATA_DIR/session-secret)
//
//   GET/POST /login     Anmeldeseite (Formular, funktioniert mit Passwortmanager und Face ID über den iOS-Schlüsselbund)
//   POST /api/login     JSON {username, password} -> Cookie + {ok, token}  (für die iOS-App)
//   POST /api/logout    Cookie löschen
//   GET  /api/session   {auth: bool, user}  (für die Oberfläche)
//
// Angemeldet ist, wer ein gültiges Cookie "rd_session" oder einen Header "Authorization: Bearer <token>" schickt.
// Das Token ist eine signierte Ablaufzeit (HMAC); der Schlüssel hängt am Passwort, ein neues Passwort
// meldet also automatisch überall ab.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const COOKIE = 'rd_session';
const MAX_FAILS = 5;                 // Fehlversuche je IP ...
const FAIL_WINDOW_MS = 5 * 60 * 1000; // ... innerhalb dieser Zeit, danach gesperrt bis das Fenster abläuft

const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const b64url = buf => Buffer.from(buf).toString('base64url');

module.exports = function setupAuth({ app, DATA_DIR, publicDir }) {
  const PASSWORD = process.env.APP_PASSWORD || '';
  const USER = process.env.APP_USER || 'admin';
  const enabled = PASSWORD !== '';

  if (!enabled) {
    console.log('Kein APP_PASSWORD gesetzt: Die App ist ohne Anmeldung erreichbar (nur im Heimnetz/VPN betreiben).');
    app.get('/api/session', (req, res) => res.json({ auth: false }));
    app.post('/api/logout', (req, res) => res.json({ ok: true }));
    return;
  }
  if (PASSWORD.length < 8) console.warn('WARNUNG: APP_PASSWORD ist kürzer als 8 Zeichen.');
  console.log(`Passwortschutz aktiv (Benutzer: ${USER}).`);

  // Geheimnis für die Signatur: bleibt über Neustarts gleich, damit man angemeldet bleibt
  let secret = process.env.SESSION_SECRET;
  if (!secret) {
    const file = path.join(DATA_DIR, 'session-secret');
    try { secret = fs.readFileSync(file, 'utf8').trim(); } catch { /* noch keins */ }
    if (!secret || secret.length < 32) {
      secret = crypto.randomBytes(32).toString('hex');
      fs.writeFileSync(file, secret, { mode: 0o600 });
    }
  }
  const key = crypto.createHmac('sha256', secret).update(`key\0${USER}\0${PASSWORD}`).digest();
  const sign = payload => b64url(crypto.createHmac('sha256', key).update(payload).digest());
  const TTL = Math.max(1, Math.round((Number(process.env.SESSION_DAYS) || 90) * 86400));

  const makeToken = () => {
    const payload = `v1.${Math.floor(Date.now() / 1000) + TTL}`;
    return `${payload}.${sign(payload)}`;
  };
  function validToken(t) {
    const m = /^(v1\.(\d{1,12}))\.([A-Za-z0-9_-]{43})$/.exec(t || '');
    if (!m) return false;
    const want = Buffer.from(sign(m[1])), got = Buffer.from(m[3]);
    return want.length === got.length && crypto.timingSafeEqual(want, got) && Number(m[2]) > Date.now() / 1000;
  }
  function tokenFrom(req) {
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '');
    if (bearer) return bearer[1];
    for (const part of (req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
    }
    return null;
  }
  const isHttps = req => req.secure || req.get('x-forwarded-proto') === 'https';
  const setCookie = (req, res, token) => res.append('Set-Cookie',
    `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TTL}${isHttps(req) ? '; Secure' : ''}`);
  const clearCookie = (req, res) => res.append('Set-Cookie',
    `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isHttps(req) ? '; Secure' : ''}`);

  // Bremse gegen Durchprobieren
  const fails = new Map();   // ip -> { n, since }
  function blockedFor(ip) {
    const f = fails.get(ip);
    if (!f) return 0;
    if (Date.now() - f.since > FAIL_WINDOW_MS) { fails.delete(ip); return 0; }
    return f.n >= MAX_FAILS ? Math.ceil((f.since + FAIL_WINDOW_MS - Date.now()) / 1000) : 0;
  }
  function noteFail(ip) {
    const f = fails.get(ip);
    if (!f || Date.now() - f.since > FAIL_WINDOW_MS) fails.set(ip, { n: 1, since: Date.now() });
    else f.n++;
  }
  setInterval(() => { for (const ip of fails.keys()) blockedFor(ip); }, 10 * 60 * 1000).unref();

  // gibt { token } oder { error, status, retry }
  function attempt(req) {
    const ip = req.ip || 'unbekannt';
    const wait = blockedFor(ip);
    if (wait) return { status: 429, retry: wait, error: `Zu viele Versuche. Bitte in ${Math.ceil(wait / 60)} Min. erneut probieren.` };
    const b = req.body || {};
    // Nur Texte vergleichen: sonst würde z. B. {"password": ["geheim"]} (Liste) zu "geheim" umgewandelt und passen
    const str = v => (typeof v === 'string' ? v : '');
    const okUser = safeEqual(str(b.username), USER);
    const okPass = safeEqual(str(b.password), PASSWORD);
    if (okUser && okPass) { fails.delete(ip); return { token: makeToken() }; }
    noteFail(ip);
    return { status: 401, error: 'Benutzername oder Passwort stimmt nicht.' };
  }

  const safeNext = n => (typeof n === 'string' && /^\/(?![/\\])/.test(n) && n.length < 500 ? n : '/');
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const loginTemplate = fs.readFileSync(path.join(publicDir, 'login.html'), 'utf8');
  const page = (req, error = '') => {
    const vals = {
      ERROR: error ? `<p class="err" role="alert">${esc(error)}</p>` : '',
      NEXT: esc(safeNext(req.query.next ?? req.body?.next)),
      USER: esc(typeof req.body?.username === 'string' ? req.body.username.slice(0, 100) : '')
    };
    // Fokus aufs erste leere Feld: Das iPhone bietet dort die gespeicherte Anmeldung (Face ID) an
    vals.FOCUS_USER = vals.USER ? '' : 'autofocus';
    vals.FOCUS_PASS = vals.USER ? 'autofocus' : '';
    return loginTemplate.replace(/\{\{(ERROR|NEXT|USER|FOCUS_USER|FOCUS_PASS)\}\}/g, (_, k) => vals[k]);
  };

  app.get('/login', (req, res) => {
    if (validToken(tokenFrom(req))) return res.redirect(safeNext(req.query.next));
    res.set('Cache-Control', 'no-store').type('html').send(page(req));
  });
  app.post('/login', express.urlencoded({ extended: false, limit: '4kb' }), (req, res) => {
    const r = attempt(req);
    if (!r.token) {
      if (r.retry) res.set('Retry-After', String(r.retry));
      return res.status(r.status).set('Cache-Control', 'no-store').type('html').send(page(req, r.error));
    }
    setCookie(req, res, r.token);
    res.redirect(303, safeNext(req.body.next));
  });
  app.post('/api/login', express.json({ limit: '4kb' }), (req, res) => {
    const r = attempt(req);
    if (!r.token) {
      if (r.retry) res.set('Retry-After', String(r.retry));
      return res.status(r.status).json({ error: r.error });
    }
    setCookie(req, res, r.token);
    res.json({ ok: true, token: r.token, user: USER });
  });
  app.post('/api/logout', (req, res) => { clearCookie(req, res); res.json({ ok: true }); });

  // Alles andere nur mit gültiger Sitzung. Öffentlich bleiben die Anmeldeseite, der Healthcheck und die
  // Dateien, die auch auf der Anmeldeseite oder fürs "Zum Home-Bildschirm" gebraucht werden.
  const PUBLIC_GET = new Set(['/healthz', '/logo.svg', '/manifest.webmanifest']);
  app.use((req, res, next) => {
    const open = (req.method === 'GET' || req.method === 'HEAD') && !req.path.includes('..')
      && (PUBLIC_GET.has(req.path) || req.path.startsWith('/icons/'));
    if (open) return next();
    if (validToken(tokenFrom(req))) return next();
    if (req.path.startsWith('/api/') || req.path.startsWith('/uploads/')) {
      return res.status(401).set('Cache-Control', 'no-store').json({ error: 'Nicht angemeldet' });
    }
    res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  });

  // Liegt hinter der Prüfung: ohne gültige Sitzung gibt es hier nur 401
  app.get('/api/session', (req, res) => res.set('Cache-Control', 'no-store').json({ auth: true, user: USER }));
};
