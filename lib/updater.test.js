const assert = require('node:assert');
const { test } = require('node:test');

const {
  STATUS,
  buildUpdateStatus,
  revisionsMatch,
  fetchLatestRevision,
  checkForUpdate,
  planUpdate,
  buildWindowsUpdateCommand,
  startUpdate,
} = require('./updater');

const FULL_SHA = 'a'.repeat(39) + '1';
const OTHER_SHA = 'b'.repeat(39) + '2';

function version(revision, extra = {}) {
  return { revision, installed_at: '2026-08-01T10:00:00.000Z', source: 'zip', ...extra };
}

function okRemote(revision = FULL_SHA) {
  return { ok: true, revision };
}

// Atrapa fetch: jedna odpowiedź, zapisuje URL i nagłówki do asercji.
function fakeFetch(response) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    if (response instanceof Error) throw response;
    return response;
  };
  return { impl, calls };
}

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

// === Porównanie rewizji ===

test('rewizja lokalna == zdalna → brak sygnału aktualizacji', () => {
  const info = buildUpdateStatus({ version: version(FULL_SHA), remote: okRemote(FULL_SHA) });
  assert.strictEqual(info.status, STATUS.CURRENT);
  assert.strictEqual(info.can_update, false);
  assert.strictEqual(info.remote_revision, FULL_SHA);
});

test('skrócona rewizja lokalna (git rev-parse --short) == pełna zdalna → aktualne', () => {
  const info = buildUpdateStatus({ version: version(FULL_SHA.slice(0, 7)), remote: okRemote(FULL_SHA) });
  assert.strictEqual(info.status, STATUS.CURRENT);
});

test('prefiks krótszy niż 7 znaków NIE jest dopasowaniem — zbieg przypadku to nie ta sama wersja', () => {
  assert.strictEqual(revisionsMatch('aaa', FULL_SHA), false);
  assert.strictEqual(revisionsMatch(FULL_SHA.slice(0, 7), FULL_SHA), true);
  assert.strictEqual(revisionsMatch(FULL_SHA, OTHER_SHA), false);
});

test('rewizja lokalna starsza → sygnał dostępnej aktualizacji z numerem', () => {
  const info = buildUpdateStatus({ version: version(OTHER_SHA), remote: okRemote(FULL_SHA) });
  assert.strictEqual(info.status, STATUS.AVAILABLE);
  assert.strictEqual(info.can_update, true);
  assert.strictEqual(info.remote_revision, FULL_SHA);
  assert.match(info.message, new RegExp(FULL_SHA.slice(0, 7)));
});

test('wersja `unknown` → stan „nie wiem", NIGDY fałszywe „aktualne"', () => {
  const info = buildUpdateStatus({ version: version('unknown'), remote: okRemote(FULL_SHA) });
  assert.strictEqual(info.status, STATUS.UNKNOWN);
  assert.notStrictEqual(info.status, STATUS.CURRENT);
  // Instalacja bez znanej wersji to dokładnie ta, którą warto przeinstalować.
  assert.strictEqual(info.can_update, true);
  assert.match(info.message, /Nie wiem/);
});

test('brak obiektu wersji w ogóle → też „nie wiem", nie wyjątek', () => {
  const info = buildUpdateStatus({ remote: okRemote(FULL_SHA) });
  assert.strictEqual(info.status, STATUS.UNKNOWN);
  assert.strictEqual(info.local_revision, 'unknown');
});

test('API GitHuba niedostępne → stan „nie udało się sprawdzić", panel nie wisi', () => {
  const info = buildUpdateStatus({ version: version(FULL_SHA), remote: { ok: false, error: 'HTTP 503' } });
  assert.strictEqual(info.status, STATUS.CHECK_FAILED);
  assert.strictEqual(info.can_update, false);
  assert.strictEqual(info.remote_revision, null);
  assert.match(info.message, /HTTP 503/);
});

// === Odpytanie GitHuba ===

test('poprawna odpowiedź GitHuba → pełny SHA i wywołanie publicznego API bez tokenu', async () => {
  const { impl, calls } = fakeFetch(jsonResponse({ sha: FULL_SHA }));
  const remote = await fetchLatestRevision({ fetchImpl: impl, slug: 'org/repo', ref: 'main' });

  assert.deepStrictEqual(remote, { ok: true, revision: FULL_SHA });
  assert.strictEqual(calls[0].url, 'https://api.github.com/repos/org/repo/commits/main');
  assert.strictEqual(calls[0].options.headers.Authorization, undefined);
});

test('błąd sieci przy odpytaniu → {ok:false} z powodem, bez rzucania', async () => {
  const { impl } = fakeFetch(new Error('getaddrinfo ENOTFOUND'));
  const remote = await fetchLatestRevision({ fetchImpl: impl });
  assert.strictEqual(remote.ok, false);
  assert.match(remote.error, /ENOTFOUND/);
});

test('HTTP 403 (limit API) → {ok:false} ze statusem', async () => {
  const { impl } = fakeFetch(jsonResponse({}, { ok: false, status: 403 }));
  const remote = await fetchLatestRevision({ fetchImpl: impl });
  assert.deepStrictEqual(remote, { ok: false, error: 'HTTP 403' });
});

test('odpowiedź bez poprawnego SHA → {ok:false}, śmieć nie trafia do panelu', async () => {
  const { impl } = fakeFetch(jsonResponse({ sha: 'nie-jest-sha' }));
  const remote = await fetchLatestRevision({ fetchImpl: impl });
  assert.strictEqual(remote.ok, false);
});

test('szew checkForUpdate: wersja lokalna + odpowiedź API → jeden stan dla panelu', async () => {
  const { impl } = fakeFetch(jsonResponse({ sha: FULL_SHA }));
  const info = await checkForUpdate({ version: version(OTHER_SHA), fetchImpl: impl });
  assert.strictEqual(info.status, STATUS.AVAILABLE);
  assert.strictEqual(info.remote_revision, FULL_SHA);
});

test('szew checkForUpdate przy padzie API → check_failed, nie wyjątek', async () => {
  const { impl } = fakeFetch(new Error('socket hang up'));
  const info = await checkForUpdate({ version: version(FULL_SHA), fetchImpl: impl });
  assert.strictEqual(info.status, STATUS.CHECK_FAILED);
});

// === Plan aktualizacji per OS ===

test('mac z repozytorium git → git pull --ff-only i kill własnego procesu', () => {
  const plan = planUpdate({ platform: 'darwin', repoDir: '/Users/x/claude-cron', pid: 4242, hasGit: true });
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.kind, 'mac');
  assert.strictEqual(plan.command, '/bin/sh');
  const script = plan.args[1];
  assert.match(script, /git pull --ff-only/);
  assert.match(script, /kill 4242/);
  // kill TYLKO po udanym pullu — nieudana aktualizacja nie może ubić żywego serwera.
  assert.match(script, /git pull --ff-only && kill/);
});

test('mac: katalog ze spacją/apostrofem jest cytowany', () => {
  const plan = planUpdate({ platform: 'darwin', repoDir: "/Users/x/moj puls", pid: 1, hasGit: true });
  assert.match(plan.args[1], /cd '\/Users\/x\/moj puls'/);
});

test('mac bez .git (instalacja zipowa) → czytelna odmowa, nie próba pulla', () => {
  const plan = planUpdate({ platform: 'darwin', repoDir: '/Users/x/claude-cron', pid: 1, hasGit: false });
  assert.strictEqual(plan.ok, false);
  assert.match(plan.error, /instalatora/);
});

test('windows: instalator adresowany po SHA, tryb nieinteraktywny, katalog instalacji', () => {
  const plan = planUpdate({ platform: 'win32', repoDir: 'C:\\Users\\x\\claude-cron', revision: FULL_SHA, hasGit: false });
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.kind, 'windows');
  assert.strictEqual(plan.command, 'powershell');
  const script = plan.args[plan.args.length - 1];
  assert.match(script, new RegExp(`raw\\.githubusercontent\\.com/[^']+/${FULL_SHA}/install\\.ps1`));
  assert.doesNotMatch(script, /refs\/heads/); // nazwa gałęzi = cache raw.githubusercontent
  assert.match(script, /CLAUDE_CRON_NONINTERACTIVE='1'/);
  assert.match(script, /INSTALL_DIR='C:\\Users\\x\\claude-cron'/);
});

test('windows: apostrof w katalogu instalacji jest escapowany po PowerShellowemu', () => {
  const cmd = buildWindowsUpdateCommand({ repoDir: "C:\\dane\\o'brien", revision: FULL_SHA });
  assert.match(cmd.args[cmd.args.length - 1], /INSTALL_DIR='C:\\dane\\o''brien'/);
});

test('platforma bez wsparcia → czytelna odmowa zamiast cichego nic', () => {
  const plan = planUpdate({ platform: 'linux', repoDir: '/opt/puls', hasGit: true });
  assert.strictEqual(plan.ok, false);
  assert.match(plan.error, /linux/);
});

// === Uruchomienie ===

function fakeIo({ hasGit = true } = {}) {
  const spawned = [];
  const logs = [];
  const child = { on() {}, unref() { child.unrefed = true; } };
  return {
    spawned,
    logs,
    child,
    io: {
      spawn: (command, args, options) => { spawned.push({ command, args, options }); return child; },
      exists: () => hasGit,
      log: m => logs.push(m),
      warn: m => logs.push(m),
    },
  };
}

test('startUpdate odpala proces odczepiony od rodzica (przeżywa śmierć daemona)', () => {
  const { io, spawned, child } = fakeIo();
  const result = startUpdate({ revision: FULL_SHA, repoDir: '/repo', platform: 'darwin', pid: 99, io });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(spawned.length, 1);
  assert.strictEqual(spawned[0].options.detached, true);
  assert.strictEqual(spawned[0].options.stdio, 'ignore');
  assert.strictEqual(child.unrefed, true);
});

test('startUpdate nie spawnuje niczego, gdy planu nie da się zbudować', () => {
  const { io, spawned } = fakeIo({ hasGit: false });
  const result = startUpdate({ revision: FULL_SHA, repoDir: '/repo', platform: 'darwin', pid: 99, io });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(spawned.length, 0);
});
