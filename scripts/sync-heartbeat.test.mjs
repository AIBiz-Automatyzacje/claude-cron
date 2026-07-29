// Testy wykrywania cichej awarii Obsidian Sync (patrz nagłówek sync-heartbeat.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderHeartbeat, evaluateHeartbeat, resolveRole } from './sync-heartbeat.mjs';

const NOW = Date.parse('2026-07-29T10:00:00.000Z');

test('świeży znacznik → wiek bliski zeru', () => {
  const raw = renderHeartbeat({ device: 'vps', now: '2026-07-29T09:58:00.000Z' });
  const v = evaluateHeartbeat(raw, NOW);
  assert.equal(v.ok, true);
  assert.ok(v.ageMin >= 1.9 && v.ageMin <= 2.1, `oczekiwano ~2 min, było ${v.ageMin}`);
});

// Awaria z 29.07 trwała 26 h — przy progu 45 min alarm poszedłby po niecałej godzinie.
test('znacznik sprzed 26 h → wiek daleko ponad próg alarmu', () => {
  const raw = renderHeartbeat({ device: 'vps', now: '2026-07-28T08:00:00.000Z' });
  const v = evaluateHeartbeat(raw, NOW);
  assert.equal(v.ok, true);
  assert.equal(v.ageMin, 26 * 60);
  assert.ok(v.ageMin > 45, 'przekracza domyślny próg 45 min');
});

test('brak pliku → powód "missing" (druga maszyna nigdy nic nie dostarczyła)', () => {
  assert.deepEqual(evaluateHeartbeat(null, NOW), { ok: false, reason: 'missing' });
});

test('plik bez pola updated → "malformed", nie cichy sukces', () => {
  assert.deepEqual(evaluateHeartbeat('---\ndevice: vps\n---\n', NOW), { ok: false, reason: 'malformed' });
});

test('niedata w polu updated → "malformed"', () => {
  assert.deepEqual(evaluateHeartbeat('---\nupdated: wczoraj\n---\n', NOW), { ok: false, reason: 'malformed' });
});

// Zegary maszyn potrafią się rozjechać. Znacznik „z przyszłości" nie jest dowodem
// awarii synchronizacji, więc nie może wywołać alarmu — liczymy go jako wiek 0.
test('znacznik z przyszłości → wiek 0, bez fałszywego alarmu', () => {
  const raw = renderHeartbeat({ device: 'vps', now: '2026-07-29T10:30:00.000Z' });
  const v = evaluateHeartbeat(raw, NOW);
  assert.equal(v.ok, true);
  assert.equal(v.ageMin, 0);
});

test('renderHeartbeat zapisuje datę i urządzenie w postaci czytelnej dla parsera', () => {
  const raw = renderHeartbeat({ device: 'maczek', now: '2026-07-29T09:00:00.000Z' });
  assert.match(raw, /^updated: 2026-07-29T09:00:00\.000Z$/m);
  assert.match(raw, /^device: maczek$/m);
  assert.equal(evaluateHeartbeat(raw, NOW).ageMin, 60);
});

// === Tryb automatyczny — job Pulsa nie może przekazać argumentów ===
// `spawn('node', [job.command])` w executorze przekazuje wyłącznie ścieżkę skryptu,
// więc rola maszyny musi wynikać ze środowiska, nie z CLI.
test('resolveRole: macOS pisze mac.md i sprawdza vps.md', () => {
  const r = resolveRole({ platform: 'darwin' });
  assert.equal(r.self, 'Zasoby/_sync/mac.md');
  assert.equal(r.peer, 'Zasoby/_sync/vps.md');
  assert.equal(r.device, 'maczek');
});

test('resolveRole: linux pisze vps.md i sprawdza mac.md (odwrotnie niż Mac)', () => {
  const r = resolveRole({ platform: 'linux' });
  assert.equal(r.self, 'Zasoby/_sync/vps.md');
  assert.equal(r.peer, 'Zasoby/_sync/mac.md');
  assert.equal(r.device, 'vps');
});

test('resolveRole: jawne env wygrywa nad platformą (trzecia maszyna)', () => {
  const r = resolveRole({
    platform: 'linux',
    env: { SYNC_HEARTBEAT_SELF: 'Zasoby/_sync/cave.md', SYNC_HEARTBEAT_PEER: 'Zasoby/_sync/mac.md', SYNC_HEARTBEAT_DEVICE: 'cave' },
  });
  assert.equal(r.self, 'Zasoby/_sync/cave.md');
  assert.equal(r.peer, 'Zasoby/_sync/mac.md');
  assert.equal(r.device, 'cave');
});

test('resolveRole: niepełne env NIE nadpisuje platformy (brak peer)', () => {
  const r = resolveRole({ platform: 'darwin', env: { SYNC_HEARTBEAT_SELF: 'Zasoby/_sync/x.md' } });
  assert.equal(r.self, 'Zasoby/_sync/mac.md', 'połowiczna konfiguracja jest ignorowana w całości');
});
