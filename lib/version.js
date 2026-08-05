// Wersja zainstalowanego kodu — jedno źródło prawdy dla /api/status.
//
// Źródłem NIE jest `git rev-parse`: instalacja przez tarball/zip (curl|bash, irm|iex)
// nie ma repozytorium git, a to właśnie ona jest domyślną drogą u użytkowników.
// Plik pisze instalator (setup.mjs) PO swapie katalogów — `data/` jest na allowliście
// katalogów stanowych, więc wersja przeżywa re-instalację i opisuje kod, który
// faktycznie leży na dysku.
//
// Kontrakt: odczyt NIGDY nie rzuca. Brak pliku (instalacja sprzed tej zmiany),
// uszkodzony JSON i błąd I/O dają ten sam kształt z `unknown` — /api/status musi
// odpowiedzieć nawet wtedy, gdy o wersji nic nie wiadomo.

const fs = require('node:fs');
const path = require('node:path');

const { DATA_DIR } = require('./config');

const VERSION_FILE = path.join(DATA_DIR, 'version.json');

const UNKNOWN = 'unknown';

function unknownVersion() {
  return { revision: UNKNOWN, installed_at: null, source: UNKNOWN };
}

// Pole tekstowe z pliku: pusty string / liczba / obiekt to dla nas BRAK wartości.
// Plik wersji nie może wpuścić śmieci do publicznego kontraktu /api/status.
function pickString(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

// Czysty odczyt: ścieżka wstrzykiwana (testy), `warn` wstrzykiwany (cisza w testach).
// ENOENT jest normalnym stanem starych instalacji — milczymy. Każdy inny błąd
// (uszkodzony JSON, brak uprawnień) logujemy, ale nadal zwracamy `unknown`:
// maskowanie realnego problemu bez śladu byłoby gorsze niż brak wersji.
function readVersionFile(filePath = VERSION_FILE, warn = console.warn) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') warn(`[version] Nie mogę odczytać ${filePath}: ${err.message}`);
    return unknownVersion();
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    warn(`[version] Uszkodzony ${filePath}: ${err.message}`);
    return unknownVersion();
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    warn(`[version] Nieoczekiwany kształt ${filePath} — oczekiwano obiektu.`);
    return unknownVersion();
  }

  return {
    revision: pickString(parsed.revision, UNKNOWN),
    installed_at: pickString(parsed.installed_at, null),
    source: pickString(parsed.source, UNKNOWN),
  };
}

// Wersja tej instalacji (domyślna ścieżka `data/version.json`).
function getInstallVersion() {
  return readVersionFile();
}

// Zapis robi instalator. `installed_at` domyślnie „teraz" — data POBRANIA kodu,
// nie data commita: interesuje nas, kiedy ta maszyna dostała ten kod.
function writeVersionFile({ revision, source, installedAt } = {}, filePath = VERSION_FILE) {
  const payload = {
    revision: pickString(revision, UNKNOWN),
    installed_at: pickString(installedAt, new Date().toISOString()),
    source: pickString(source, UNKNOWN),
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}

module.exports = {
  UNKNOWN,
  VERSION_FILE,
  getInstallVersion,
  readVersionFile,
  unknownVersion,
  writeVersionFile,
};
