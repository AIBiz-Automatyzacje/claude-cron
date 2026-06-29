// Guard startowy wersji Node — fail-fast PRZED jakimkolwiek importem node:sqlite.
// Musi być wymagany jako PIERWSZA linia server.js (przed require('./lib/db')),
// bo lib/db.js robi top-level require('node:sqlite'), który rzuca brzydkim,
// nieczytelnym błędem na starym/niekompatybilnym Node. Tutaj dajemy akcjonowalny
// komunikat + process.exit(1).
//
// ZERO zależności od node:sqlite. Importuje tylko czyste stałe z config.js
// (config nie ciąga node:sqlite), by mieć jedno źródło prawdy dla zakresu wersji.
const { MIN_NODE_VERSION, MAX_NODE_VERSION } = require('./config');

// Parsuje "major.minor.patch" (lub "major.minor") do tablicy liczb [major, minor, patch].
// Brakujące segmenty → 0. Nie-numeryczne segmenty → 0 (fail-safe; lepiej zaniżyć niż przepuścić).
function parseVersion(version) {
  return String(version)
    .split('.')
    .slice(0, 3)
    .map((seg) => {
      const n = parseInt(seg, 10);
      return Number.isInteger(n) ? n : 0;
    });
}

// Porównuje dwie wersje numerycznie. Zwraca -1 / 0 / 1 (a<b / a==b / a>b).
function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  const len = Math.max(va.length, vb.length);
  for (let i = 0; i < len; i += 1) {
    const da = va[i] || 0;
    const db = vb[i] || 0;
    if (da !== db) return da < db ? -1 : 1;
  }
  return 0;
}

// Czysta, testowalna predykata: czy wersja Node mieści się w [min, max) — czyli
// version >= min ORAZ version < max. Granica górna wykluczająca (spójne z "engines" <25).
// Pure: brak side-effectów, brak odczytu process — wersje wstrzykiwane argumentami.
function isNodeSupported(version, min = MIN_NODE_VERSION, max = MAX_NODE_VERSION) {
  return compareVersions(version, min) >= 0 && compareVersions(version, max) < 0;
}

// Buduje akcjonowalny komunikat: aktualna vs wymagana wersja + jak naprawić.
function buildUnsupportedMessage(current, min = MIN_NODE_VERSION, max = MAX_NODE_VERSION) {
  return [
    `[runtime-guard] Niekompatybilna wersja Node.js.`,
    `  Wykryto:   v${current}`,
    `  Wymagane:  >=${min} <${max}`,
    ``,
    `Jak naprawić:`,
    `  • nvm:      nvm install ${min} && nvm use ${min}`,
    `  • portable: pobierz Node ${min}+ z https://nodejs.org/en/download i dodaj do PATH`,
    ``,
    `Powód: ta aplikacja używa wbudowanego node:sqlite, dostępnego dopiero od Node ${min}.`,
  ].join('\n');
}

// Self-executing guard. Sprawdza process.versions.node; jeśli poza zakresem →
// komunikat na stderr + exit(1). Eksportowane funkcje pozostają czyste/testowalne.
function enforceNodeVersion() {
  const current = process.versions.node;
  if (!isNodeSupported(current)) {
    process.stderr.write(buildUnsupportedMessage(current) + '\n');
    process.exit(1);
  }
}

enforceNodeVersion();

module.exports = {
  isNodeSupported,
  compareVersions,
  parseVersion,
  buildUnsupportedMessage,
  enforceNodeVersion,
};
