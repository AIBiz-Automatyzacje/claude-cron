const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { readVersionFile, writeVersionFile, UNKNOWN } = require('./version');

function tmpFile(name = 'version.json') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puls-version-'));
  return path.join(dir, name);
}

// Zbiera ostrzeżenia zamiast zaśmiecać output testów — a przy okazji pozwala
// asertować, że błędny plik NIE przechodzi po cichu.
function collectWarnings() {
  const warnings = [];
  return { warn: (msg) => warnings.push(msg), warnings };
}

test('poprawny plik wersji → rewizja, data i źródło z pliku', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({
    revision: 'abc1234',
    installed_at: '2026-08-05T10:00:00.000Z',
    source: 'tarball',
  }));

  const { warn, warnings } = collectWarnings();
  assert.deepStrictEqual(readVersionFile(file, warn), {
    revision: 'abc1234',
    installed_at: '2026-08-05T10:00:00.000Z',
    source: 'tarball',
  });
  assert.deepStrictEqual(warnings, []);
});

test('brak pliku (stara instalacja) → unknown, bez wyjątku i bez ostrzeżenia', () => {
  const file = path.join(tmpFile(), 'nie-ma-takiego', 'version.json');
  const { warn, warnings } = collectWarnings();

  assert.deepStrictEqual(readVersionFile(file, warn), {
    revision: UNKNOWN,
    installed_at: null,
    source: UNKNOWN,
  });
  // ENOENT to normalny stan instalacji sprzed tej zmiany — nie alarmujemy.
  assert.deepStrictEqual(warnings, []);
});

test('uszkodzony JSON → unknown, bez wyjątku, z ostrzeżeniem', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{ "revision": "abc123');

  const { warn, warnings } = collectWarnings();
  assert.deepStrictEqual(readVersionFile(file, warn), {
    revision: UNKNOWN,
    installed_at: null,
    source: UNKNOWN,
  });
  assert.strictEqual(warnings.length, 1);
});

test('niepełny JSON → brakujące pola schodzą do unknown/null', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ revision: 'abc1234' }));

  const { warn } = collectWarnings();
  assert.deepStrictEqual(readVersionFile(file, warn), {
    revision: 'abc1234',
    installed_at: null,
    source: UNKNOWN,
  });
});

test('śmieciowe typy pól (liczba, pusty string) traktowane jak brak', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ revision: 42, installed_at: '   ', source: {} }));

  const { warn } = collectWarnings();
  assert.deepStrictEqual(readVersionFile(file, warn), {
    revision: UNKNOWN,
    installed_at: null,
    source: UNKNOWN,
  });
});

test('JSON nie-obiektowy (tablica) → unknown z ostrzeżeniem', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '["abc1234"]');

  const { warn, warnings } = collectWarnings();
  assert.strictEqual(readVersionFile(file, warn).revision, UNKNOWN);
  assert.strictEqual(warnings.length, 1);
});

test('writeVersionFile tworzy katalog i zapisuje odczytywalny plik', () => {
  const file = path.join(tmpFile(), 'data', 'version.json');
  const written = writeVersionFile({ revision: 'deadbee', source: 'zip' }, file);

  assert.strictEqual(written.revision, 'deadbee');
  assert.strictEqual(written.source, 'zip');
  // Roundtrip: to, co zapisał instalator, musi być tym, co pokaże /api/status.
  assert.deepStrictEqual(readVersionFile(file, () => {}), written);
});

test('writeVersionFile bez rewizji → unknown zamiast pustego pola', () => {
  const file = tmpFile();
  const written = writeVersionFile({ source: 'git' }, file);

  assert.strictEqual(written.revision, UNKNOWN);
  assert.strictEqual(written.source, 'git');
  assert.match(written.installed_at, /^\d{4}-\d{2}-\d{2}T/);
});
