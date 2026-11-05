// Statische Prüfungen, die in der Praxis Fehler abfangen, die erst im Container oder im Browser auffallen:
// fehlende Dateien im Docker-Image, fehlende Abhängigkeiten, kaputte Skript-Reihenfolge in der Oberfläche.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { builtinModules } = require('node:module');
const { ROOT } = require('../testlib/harness');

const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const pkg = JSON.parse(read('package.json'));

// server.js und alle Dateien, die es (auch indirekt) per require('./…') lädt
function serverFiles() {
  const seen = new Set();
  const visit = file => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const m of read(file).matchAll(/require\(\s*['"]\.\/([\w./-]+?)(?:\.js)?['"]\s*\)/g)) visit(m[1] + '.js');
  };
  visit(pkg.main);
  return [...seen];
}

describe('Docker-Image', () => {
  const dockerfile = read('Dockerfile');
  const copied = new Set(dockerfile.split('\n').filter(l => /^COPY\s/.test(l)).flatMap(l => l.split(/\s+/).slice(1, -1)));

  test('Jede Server-Datei wird ins Image kopiert (sonst startet der Container nicht)', () => {
    const files = serverFiles();
    assert.ok(files.length >= 4, files.join(', '));
    for (const f of files) assert.ok(copied.has(f), `${f} fehlt in den COPY-Zeilen des Dockerfiles`);
  });

  test('Oberfläche, Paketdateien und Entrypoint sind enthalten', () => {
    for (const f of ['public', 'package.json', 'package-lock.json', 'docker-entrypoint.sh']) assert.ok(copied.has(f), f);
    assert.match(dockerfile, /npm ci --omit=dev/);
    assert.match(dockerfile, /HEALTHCHECK[\s\S]*\/healthz/);
  });

  test('.dockerignore schließt Daten und node_modules aus, nicht aber Server-Dateien', () => {
    const ignore = read('.dockerignore').split('\n').map(l => l.trim());
    for (const e of ['node_modules', 'data']) assert.ok(ignore.includes(e), e);
    for (const f of [...serverFiles(), 'public', 'package.json', 'docker-entrypoint.sh']) assert.ok(!ignore.includes(f), f);
  });
});

describe('Abhängigkeiten', () => {
  test('Alles, was der Server von außen lädt, steht in dependencies (nicht devDependencies)', () => {
    const builtin = new Set(builtinModules.flatMap(m => [m, 'node:' + m]));
    const used = new Set();
    for (const f of serverFiles()) {
      for (const m of read(f).matchAll(/require\(\s*['"]([^'"./][^'"]*)['"]\s*\)/g)) used.add(m[1].split('/')[0]);
    }
    const external = [...used].filter(m => !builtin.has(m));
    assert.ok(external.includes('express') && external.includes('better-sqlite3'));
    for (const m of external) assert.ok(pkg.dependencies?.[m], `${m} fehlt in dependencies`);
  });

  test('package-lock.json passt zu package.json (npm ci bricht sonst ab)', () => {
    const lock = JSON.parse(read('package-lock.json'));
    assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies);
    for (const name of Object.keys(pkg.dependencies)) assert.ok(lock.packages['node_modules/' + name], name);
  });

  test('Chart.js liegt dort, wo der Server es ausliefert', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'node_modules/chart.js/dist/chart.umd.js')));
  });
});

describe('Oberfläche', () => {
  const html = read('public/index.html');
  const scripts = [...html.matchAll(/<script[^>]+\bsrc="([^"]+)"/g)].map(m => m[1]);
  const local = scripts.filter(s => !s.startsWith('/vendor/'));

  test('Alle eingebundenen Dateien existieren', () => {
    assert.ok(local.length >= 5);
    for (const s of local) assert.ok(fs.existsSync(path.join(ROOT, 'public', s)), s);
    for (const m of html.matchAll(/<link[^>]+\bhref="([^"#?]+)"/g)) {
      assert.ok(fs.existsSync(path.join(ROOT, 'public', m[1].replace(/^\//, ''))), m[1]);
    }
  });

  test('Jede Skriptdatei in public/ ist auch eingebunden', () => {
    const files = fs.readdirSync(path.join(ROOT, 'public')).filter(f => f.endsWith('.js'));
    for (const f of files) assert.ok(local.includes(f), `${f} wird in index.html nicht geladen`);
  });

  test('Skripte haben keine Syntaxfehler', () => {
    for (const s of local) assert.doesNotThrow(() => new vm.Script(read('public/' + s), { filename: s }), s);
  });

  // Alle Skripte teilen sich einen globalen Bereich. Ein zweites "const x" mit gleichem Namen ist in einem anderen
  // Skript ein SyntaxError ("has already been declared") und legt die ganze Datei lahm; doppelte Funktionsnamen überschreiben still.
  test('Keine doppelten globalen Namen zwischen den Skripten', () => {
    const ctx = vm.createContext({});
    for (const s of local) {
      try { new vm.Script(read('public/' + s), { filename: s }).runInContext(ctx); }
      catch (e) {
        // Fehler beim Ausführen (kein DOM im Test) sind erwartet, Namenskonflikte nicht.
        // Der Fehler stammt aus einem anderen Kontext, "instanceof SyntaxError" würde ihn nicht erkennen.
        assert.notEqual(e?.name, 'SyntaxError', `${s}: ${e?.message}`);
      }
    }
    const fnOwner = {};
    for (const s of local) {
      for (const m of read('public/' + s).matchAll(/^(?:async\s+)?function\s*\*?\s*([\w$]+)/gm)) {
        assert.ok(!fnOwner[m[1]], `Funktion ${m[1]}() steht in ${fnOwner[m[1]]} und in ${s}`);
        fnOwner[m[1]] = s;
      }
    }
  });

  test('Manifest ist gültiges JSON und die Symbole existieren', () => {
    const manifest = JSON.parse(read('public/manifest.webmanifest'));
    assert.ok(manifest.name);
    for (const icon of manifest.icons || []) assert.ok(fs.existsSync(path.join(ROOT, 'public', icon.src.replace(/^\//, ''))), icon.src);
  });

  test('login.html enthält alle Platzhalter, die auth.js ersetzt', () => {
    const login = read('public/login.html');
    for (const p of ['ERROR', 'NEXT', 'USER', 'FOCUS_USER', 'FOCUS_PASS']) assert.ok(login.includes(`{{${p}}}`), p);
  });
});

describe('Repository', () => {
  test('Daten und node_modules sind nicht im Git', () => {
    const ignore = read('.gitignore').split('\n').map(l => l.trim());
    assert.ok(ignore.includes('node_modules/'));
    assert.ok(ignore.includes('data/'));
  });

  test('Der Docker-Workflow läuft auch, wenn sich Server-Dateien ändern', () => {
    const wf = read('.github/workflows/docker.yml');
    const paths = (/pull_request:\s*\n\s*paths:\s*\n((?:\s+- .+\n)+)/.exec(wf) || [])[1] || '';
    for (const f of serverFiles()) {
      assert.ok(paths.includes(f) || /- ['"]?\*\.js/.test(paths), `${f} fehlt in den paths des Docker-Workflows`);
    }
  });
});
