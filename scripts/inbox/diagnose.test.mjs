// Testy diagnostyki skrzynki: raport ma NAZYWAĆ przyczynę i dawać krok naprawczy,
// nigdy nie wypisywać sekretu i nie mylić „brak env w procesie" z „brak konfiguracji".
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderReport, buildHints } from './diagnose.mjs';

const HEALTHY = {
  repoDir: 'C:\\Users\\x\\claude-cron',
  platform: 'win32 10.0.26100',
  secretFile: 'C:\\Users\\x\\claude-cron\\data\\inbox.env',
  secretKeys: ['INBOX_HUB_URL', 'INBOX_TOKEN', 'INBOX_USER'],
  workspace: 'C:\\Users\\x\\vault',
  workspacePersisted: 'C:\\Users\\x\\vault',
  hubConfigured: true,
  envError: null,
  role: 'client',
  job: { name: 'Team OS — inbox sync', enabled: 1, cron_expr: '*/1 * * * *', id: 7 },
  lastRun: '2026-08-11 12:00:00 → success',
  expectedJobName: 'Team OS — inbox sync',
  skrzynkaPath: 'C:\\Users\\x\\vault\\Zadania\\Skrzynka.md',
  skrzynkaExists: true,
  revision: 'abc1234',
};

test('zdrowa instalacja → same [ok], zero kroków naprawczych poza podpowiedzią końcową', () => {
  const out = renderReport(HEALTHY);
  assert.ok(!out.includes('[!!]'), 'nic nie powinno być zgłoszone jako problem');
  assert.deepEqual(buildHints(HEALTHY).length, 1);
});

test('raport NIGDY nie zawiera wartości sekretu — same nazwy kluczy', () => {
  const out = renderReport({ ...HEALTHY, secretKeys: ['INBOX_TOKEN'] });
  assert.ok(out.includes('INBOX_TOKEN'), 'nazwa klucza jest potrzebna do diagnozy');
  assert.ok(!/INBOX_[A-Z_]*=/.test(out), 'żadnej pary klucz=wartość w raporcie');
});

test('brak workspace w procesie → wskazuje restart komputera, nie reinstalację', () => {
  const facts = { ...HEALTHY, workspace: null, job: null };
  const out = renderReport(facts);
  assert.ok(out.includes('Brak CLAUDE_CRON_WORKSPACE'));
  assert.ok(buildHints(facts).some((h) => h.includes('Zrestartuj komputer')));
});

// Dokładnie przypadek z instalacji na Windowsie: rejestr już naprawiony, ale procesy
// wciąż widzą starą wartość. Bez tego wiersza wygląda to jak zdrowa konfiguracja.
test('rozjazd zapisanej i widzianej wartości → osobny sygnał', () => {
  const facts = { ...HEALTHY, workspace: 'C:\\stare', workspacePersisted: 'C:\\Users\\x\\vault' };
  const out = renderReport(facts);
  assert.ok(out.includes('Rozjazd'), 'rozjazd musi być nazwany wprost');
  assert.ok(buildHints(facts).some((h) => h.includes('Zrestartuj komputer')));
});

test('konfiguracja OK, ale joba brak → każe zrestartować daemona Pulsa', () => {
  const facts = { ...HEALTHY, job: null, skrzynkaExists: false };
  const out = renderReport(facts);
  assert.ok(out.includes('NIE MA w bazie'));
  assert.ok(buildHints(facts).some((h) => h.includes('daemona')));
});

test('job istnieje, ale wyłączony → kieruje do panelu, nie do restartu', () => {
  const facts = { ...HEALTHY, job: { ...HEALTHY.job, enabled: 0 }, skrzynkaExists: false };
  const hints = buildHints(facts);
  assert.ok(hints.some((h) => h.includes('Włącz job')));
  assert.ok(!hints.some((h) => h.includes('daemona')), 'restart daemona nic tu nie da');
});

test('brak pliku sekretu → kieruje do ponownego onboardingu', () => {
  const facts = { ...HEALTHY, secretKeys: null, hubConfigured: false, job: null };
  const out = renderReport(facts);
  assert.ok(out.includes('onboarding skrzynki nie przeszedł'));
  assert.ok(buildHints(facts)[0].includes('kod zaproszenia'));
});
