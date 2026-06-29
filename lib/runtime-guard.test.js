const { test } = require('node:test');
const assert = require('node:assert/strict');

const { isNodeSupported, buildUnsupportedMessage } = require('./runtime-guard');

// isNodeSupported(version, min, max) — czysta predykata zakresu [min, max).
// Domyślnie min='22.13', max='25' (z config.js).

test('isNodeSupported jest wyeksportowany', () => {
  assert.equal(typeof isNodeSupported, 'function');
});

test('wersja równa minimum → true (granica dolna włączająca)', () => {
  assert.equal(isNodeSupported('22.13.0', '22.13', '25'), true);
});

test('wersja minor poniżej minimum → false', () => {
  assert.equal(isNodeSupported('22.12.5', '22.13', '25'), false);
});

test('wersja patch wyższa w obrębie minora → true', () => {
  assert.equal(isNodeSupported('22.22.3', '22.13', '25'), true);
});

test('wersja w środku zakresu (major 24) → true', () => {
  // 24.0.0 jest w >=22.13 <25 — spójne z "engines" w package.json.
  assert.equal(isNodeSupported('24.0.0', '22.13', '25'), true);
});

test('wersja równa górnej granicy → false (max wykluczające)', () => {
  assert.equal(isNodeSupported('25.0.0', '22.13', '25'), false);
});

test('wersja powyżej górnej granicy → false', () => {
  assert.equal(isNodeSupported('26.1.0', '22.13', '25'), false);
});

test('major poniżej minimum (np. 18) → false', () => {
  assert.equal(isNodeSupported('18.20.0', '22.13', '25'), false);
});

test('działa z domyślnymi stałymi z config (bez podania min/max)', () => {
  // Bieżący runtime testów jest wspierany — guard się nie wykonał z exit(1).
  assert.equal(isNodeSupported(process.versions.node), true);
});

test('komunikat dla wersji poniżej minimum zawiera wymagany zakres i wykrytą wersję', () => {
  const msg = buildUnsupportedMessage('20.1.0', '22.13', '25');
  assert.match(msg, /22\.13/); // wymagana wersja
  assert.match(msg, /v20\.1\.0/); // wykryta wersja
  assert.match(msg, /nvm install 22\.13/); // akcjonowalna instrukcja naprawy
});
