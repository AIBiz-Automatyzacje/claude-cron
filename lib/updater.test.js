const assert = require('node:assert');
const os = require('node:os');
const { test, beforeEach } = require('node:test');

const {
  STATUS,
  buildUpdateStatus,
  revisionsMatch,
  fetchLatestRevision,
  checkForUpdate,
  planUpdate,
  buildMacUpdateCommand,
  buildWindowsUpdateCommand,
  buildWindowsBootstrapScript,
  startUpdate,
  isUpdateInProgress,
  resetUpdateState,
  handleUpdateRequest,
} = require('./updater');

// Blokada „aktualizacja już trwa" żyje w module (jak liczniki w ask.js), więc bez
// wyzerowania przeciekałaby między testami i kolejne startUpdate dostawałoby 409.
beforeEach(() => resetUpdateState());

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
  // Treść aktualizacji żyje w PLIKU bootstrapu, nie w argumentach — `irm|iex` w linii
  // komend ukrytego PowerShella to sygnatura droppera i antywirus ciął CreateProcess
  // z EPERM (CAVE 07.08).
  const script = plan.scriptFile.content;
  assert.match(script, new RegExp(`raw\\.githubusercontent\\.com/[^']+/${FULL_SHA}/install\\.ps1`));
  assert.doesNotMatch(script, /refs\/heads/); // nazwa gałęzi = cache raw.githubusercontent
  assert.match(script, /CLAUDE_CRON_NONINTERACTIVE='1'/);
  assert.match(script, /INSTALL_DIR='C:\\Users\\x\\claude-cron'/);
  // Linia komend musi być NIEWINNA: żadnego irm/iex/http — tylko -File <ścieżka>.
  const cmdline = plan.args.join(' ');
  assert.doesNotMatch(cmdline, /irm|iex|https?:/);
  assert.strictEqual(plan.args[plan.args.length - 2], '-File');
  assert.strictEqual(plan.args[plan.args.length - 1], plan.scriptFile.path);
});

test('windows: pośrednik cmd /c start i BEZ detached — oba proste warianty zawodzą', () => {
  // Dowód z żywej maszyny (CAVE, 2026-08-06): z `detached` powershell bez konsoli kończy
  // natychmiast z kodem 0 nie wykonawszy nic; bez pośrednika dziecko ginie z daemonem.
  const plan = planUpdate({ platform: 'win32', repoDir: 'C:\\Users\\x\\claude-cron', revision: FULL_SHA, hasGit: false });
  assert.strictEqual(plan.command, 'cmd');
  // `start` z pustym tytułem okna — bez niego ścieżka w cudzysłowie zostałaby tytułem.
  assert.deepEqual(plan.args.slice(0, 4), ['/c', 'start', '', '/min']);
  assert.strictEqual(plan.args[4], 'powershell');
  assert.strictEqual(plan.detached, false);
});

test('windows: skrypt pisze transkrypt do %TEMP% — śmierć instalatora ma zostawiać ślad', () => {
  const plan = planUpdate({ platform: 'win32', repoDir: 'C:\\x', revision: FULL_SHA, hasGit: false });
  const script = plan.scriptFile.content;
  assert.match(script, /Start-Transcript/);
  assert.match(script, /puls-update\.log/);
  // ASCII only: PS 5.1 czyta plik bez BOM jako ANSI — diakrytyki wywróciłyby parser.
  assert.ok(!/[^\x00-\x7f]/.test(script), 'bootstrap musi być czystym ASCII');
});

test('mac: plan żąda detached — na Uniksie to nowa grupa procesów, skrypt przeżywa kill daemona', () => {
  const plan = planUpdate({ platform: 'darwin', repoDir: '/r', pid: 1, hasGit: true });
  assert.strictEqual(plan.detached, true);
});

test('windows: apostrof w katalogu instalacji jest escapowany po PowerShellowemu', () => {
  const script = buildWindowsBootstrapScript({ repoDir: "C:\\dane\\o'brien", revision: FULL_SHA });
  assert.match(script, /INSTALL_DIR='C:\\dane\\o''brien'/);
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
  const written = [];
  // Handlery zapamiętujemy, żeby test mógł odtworzyć zdarzenie procesu potomnego
  // ('exit' z niezerowym kodem = porażka aktualizacji przy ŻYJĄCYM serwerze).
  const child = {
    handlers: {},
    on(event, fn) { child.handlers[event] = fn; },
    emit(event, ...args) { child.handlers[event]?.(...args); },
    unref() { child.unrefed = true; },
  };
  return {
    spawned,
    logs,
    child,
    written,
    io: {
      spawn: (command, args, options) => { spawned.push({ command, args, options }); return child; },
      exists: () => hasGit,
      writeFile: (file, content) => { written.push({ file, content }); },
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

test('startUpdate na win32 spawnuje BEZ detached — flaga per platforma z planu', () => {
  const { io, spawned } = fakeIo({ hasGit: false });
  const result = startUpdate({ revision: FULL_SHA, repoDir: 'C:\\repo', platform: 'win32', io });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(spawned[0].command, 'cmd');
  assert.strictEqual(spawned[0].options.detached, false);
});

test('watchdog: żyjący serwer po upływie limitu zwalnia flagę i ostrzega', async () => {
  // Scenariusz z CAVE: pośrednik zameldował kod 0, instalator umarł po cichu, daemon
  // żyje — bez watchdoga panel odpowiadałby 409 do restartu procesu.
  const { io, logs, child } = fakeIo({ hasGit: false });
  startUpdate({ revision: FULL_SHA, repoDir: 'C:\\repo', platform: 'win32', watchdogMs: 20, io });
  child.emit('exit', 0, null); // sukces pośrednika — flaga celowo zostaje
  assert.strictEqual(isUpdateInProgress(), true);

  await new Promise(resolve => setTimeout(resolve, 60));
  assert.strictEqual(isUpdateInProgress(), false);
  assert.ok(logs.some(m => /zwalniam blokadę/.test(m)), `brak ostrzeżenia watchdoga: ${logs}`);
});

test('watchdog nie strzela po porażce zgłoszonej przez exit — flaga już zwolniona, bez drugiego warna', async () => {
  const { io, logs, child } = fakeIo();
  startUpdate({ revision: FULL_SHA, repoDir: '/repo', platform: 'darwin', pid: 9, watchdogMs: 20, io });
  child.emit('exit', 1, null); // pad pulla przy żyjącym serwerze
  assert.strictEqual(isUpdateInProgress(), false);
  const warnsAfterExit = logs.filter(m => /nie powiodła się/.test(m)).length;

  await new Promise(resolve => setTimeout(resolve, 60));
  assert.strictEqual(isUpdateInProgress(), false);
  assert.strictEqual(logs.filter(m => /zwalniam blokadę/.test(m)).length, 0);
  assert.strictEqual(logs.filter(m => /nie powiodła się/.test(m)).length, warnsAfterExit);
});

test('startUpdate nie spawnuje niczego, gdy planu nie da się zbudować', () => {
  const { io, spawned } = fakeIo({ hasGit: false });
  const result = startUpdate({ revision: FULL_SHA, repoDir: '/repo', platform: 'darwin', pid: 99, io });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(spawned.length, 0);
});

// === Kontrakt ścieżki maca: wersja i powrót serwera (nie tylko kształt komendy) ===
// Feature powstał po to, żeby po aktualizacji panel pokazał NOWĄ wersję, a scheduler
// dalej pracował. Sam `git pull` obu tych rzeczy nie robi.

test('mac: po pullu zapisuje data/version.json rewizją z gita — inaczej panel raportuje porażkę po sukcesie', () => {
  const script = buildMacUpdateCommand({ repoDir: '/repo', pid: 7, nodeBin: '/repo/.node/bin/node' }).args[1];

  assert.match(script, /git rev-parse HEAD/);
  assert.match(script, /writeVersionFile/);
  assert.match(script, /source:'git'/);
  // Rewizja idzie env-em, nie interpolacją do kodu JS (cudzysłowy w -e i tak są shellowe).
  assert.match(script, /CLAUDE_CRON_UPDATE_REVISION="\$\(git rev-parse HEAD\)"/);
  assert.match(script, /process\.env\.CLAUDE_CRON_UPDATE_REVISION/);
});

test('mac: skrypt sam wznawia serwer — na tej instalacji nic go nie wskrzesza', () => {
  const script = buildMacUpdateCommand({ repoDir: '/repo', pid: 7, nodeBin: '/repo/.node/bin/node' }).args[1];

  assert.match(script, /'\/repo\/\.node\/bin\/node' --disable-warning=ExperimentalWarning server\.js/);
  // Kolejność jest kontraktem: kill → zapis wersji → restart z nowym kodem.
  const killAt = script.indexOf('kill 7');
  const versionAt = script.indexOf('writeVersionFile');
  const restartAt = script.indexOf('server.js');
  assert.ok(killAt > 0 && killAt < versionAt, `kill przed zapisem wersji (kill=${killAt}, wersja=${versionAt})`);
  assert.ok(versionAt < restartAt, `zapis wersji przed restartem (wersja=${versionAt}, restart=${restartAt})`);
});

test('mac: pad zapisu wersji NIE blokuje restartu serwera (średnik, nie &&)', () => {
  const script = buildMacUpdateCommand({ repoDir: '/repo', pid: 7, nodeBin: '/n' }).args[1];
  const afterVersion = script.slice(script.indexOf('writeVersionFile'));
  // Między zapisem wersji a startem serwera nie ma spójnika warunkowego — wersja to
  // metadana, jej pad nie może zostawić maszyny bez schedulera.
  assert.doesNotMatch(afterVersion.slice(0, afterVersion.indexOf('server.js')), /&&/);
  assert.match(afterVersion, /;\s*sleep 2;\s*exec /);
});

test('mac: ścieżka portable Node ze spacją jest cytowana', () => {
  const script = buildMacUpdateCommand({ repoDir: '/repo', pid: 1, nodeBin: '/Users/x/moj puls/.node/bin/node' }).args[1];
  assert.match(script, /'\/Users\/x\/moj puls\/\.node\/bin\/node'/);
});

test('startUpdate na Macu odpala proces z katalogu repo (git pull musi trafić w repo)', () => {
  const { io, spawned } = fakeIo();
  startUpdate({ revision: FULL_SHA, repoDir: '/repo', platform: 'darwin', pid: 99, io });
  assert.strictEqual(spawned[0].options.cwd, '/repo');
});

// === Windows: cwd i źródło zipa ===

test('startUpdate na Windowsie NIE trzyma cwd w katalogu instalacji — inaczej Move-Item pada', () => {
  const { io, spawned } = fakeIo();
  startUpdate({ revision: FULL_SHA, repoDir: 'C:\\Users\\x\\claude-cron', platform: 'win32', pid: 99, io });

  assert.strictEqual(spawned.length, 1);
  assert.strictEqual(spawned[0].options.cwd, os.tmpdir());
  assert.notStrictEqual(spawned[0].options.cwd, 'C:\\Users\\x\\claude-cron');
});

test('windows: gotowy URL zipa po SHA — instalator nie pyta API GitHuba drugi raz', () => {
  const script = buildWindowsBootstrapScript({ repoDir: 'C:\\puls', revision: FULL_SHA, slug: 'org/repo' });

  assert.match(script, new RegExp(`CLAUDE_CRON_ZIP_URL='https://github\\.com/org/repo/archive/${FULL_SHA}\\.zip'`));
  assert.match(script, new RegExp(`CLAUDE_CRON_ZIP_TOPDIR='claude-cron-${FULL_SHA}'`));
  // Bez tej zmiennej Invoke-UpdateFinish nie zapisze data\version.json.
  assert.match(script, new RegExp(`CLAUDE_CRON_INSTALL_REVISION='${FULL_SHA}'`));
});

test('windows bez znanego SHA: żadnego zmyślonego URL-a zipa — instalator rozstrzyga sam', () => {
  const script = buildWindowsBootstrapScript({ repoDir: 'C:\\puls', revision: '' });
  assert.doesNotMatch(script, /CLAUDE_CRON_ZIP_URL/);
  assert.doesNotMatch(script, /CLAUDE_CRON_INSTALL_REVISION/);
});

// === Blokada „aktualizacja już trwa" ===

test('drugi startUpdate przy trwającej aktualizacji nie spawnuje drugiego instalatora', () => {
  const { io, spawned } = fakeIo();
  const first = startUpdate({ revision: FULL_SHA, repoDir: '/repo', platform: 'darwin', pid: 9, io });
  const second = startUpdate({ revision: FULL_SHA, repoDir: '/repo', platform: 'darwin', pid: 9, io });

  assert.strictEqual(first.ok, true);
  assert.strictEqual(second.ok, false);
  assert.strictEqual(second.busy, true);
  assert.strictEqual(spawned.length, 1);
  assert.strictEqual(isUpdateInProgress(), true);
});

test('nieudany plan NIE zapala blokady — user może poprawić stan i spróbować ponownie', () => {
  const { io } = fakeIo({ hasGit: false });
  startUpdate({ revision: FULL_SHA, repoDir: '/repo', platform: 'darwin', pid: 9, io });
  assert.strictEqual(isUpdateInProgress(), false);
});

// === Szew HTTP GET/POST /api/update ===
// Zależności wstrzykiwane zamiast żywego serwera: realny POST chodzi do api.github.com
// i UBIJA własny proces, więc test na żywym daemonie musiałby albo zaufać sieci, albo
// naprawdę zaktualizować maszynę runnera.

function fakeCheck(info) {
  const calls = [];
  return { calls, impl: async () => { calls.push(true); return info; } };
}

function fakeStart(result = { ok: true, kind: 'mac' }) {
  const calls = [];
  return { calls, impl: (args) => { calls.push(args); return result; } };
}

test('nieudana aktualizacja (exit ≠ 0) zwalnia blokadę — user może kliknąć ponownie', () => {
  // Ścieżka maca: `kill` stoi za `&&`, więc pad `git pull` zostawia ŻYWY serwer
  // z zapaloną blokadą. Bez zwolnienia każdy kolejny POST dostaje 409 „już trwa".
  const { io, child } = fakeIo();
  startUpdate({ revision: FULL_SHA, repoDir: '/repo', platform: 'darwin', pid: 9, io });
  assert.strictEqual(isUpdateInProgress(), true);

  child.emit('exit', 1);

  assert.strictEqual(isUpdateInProgress(), false, 'blokada musi puścić po porażce');
  const second = startUpdate({ revision: FULL_SHA, repoDir: '/repo', platform: 'darwin', pid: 9, io });
  assert.strictEqual(second.ok, true, 'ponowna próba musi być możliwa bez restartu daemona');
});

test('instalator ubity sygnałem (code null) zwalnia blokadę — to porażka, nie sukces', () => {
  // `code === null` znaczy „zabity sygnałem", a nie „poszło dobrze": serwer żyje dalej,
  // więc bez zwolnienia panel do końca życia daemona odpowiadałby 409.
  const { io, child } = fakeIo();
  startUpdate({ revision: FULL_SHA, repoDir: '/repo', platform: 'darwin', pid: 9, io });

  child.emit('exit', null, 'SIGTERM');

  assert.strictEqual(isUpdateInProgress(), false);
});

test('podwójne zdarzenie (error + exit) zwalnia raz i ostrzega raz', () => {
  const { io, child, logs } = fakeIo();
  startUpdate({ revision: FULL_SHA, repoDir: '/repo', platform: 'darwin', pid: 9, io });

  child.emit('error', new Error('ENOENT'));
  child.emit('exit', 1);

  assert.strictEqual(isUpdateInProgress(), false);
  assert.strictEqual(logs.filter((m) => m.includes('nie powiodła się')).length, 1);
});

test('udana aktualizacja (exit 0) NIE zwalnia blokady — proces i tak zaraz ginie', () => {
  // Zwolnienie przy powodzeniu otworzyłoby okno na drugi instalator w trakcie
  // podmiany plików instalacji.
  const { io, child } = fakeIo();
  startUpdate({ revision: FULL_SHA, repoDir: '/repo', platform: 'darwin', pid: 9, io });

  child.emit('exit', 0);

  assert.strictEqual(isUpdateInProgress(), true);
});

test('GET /api/update → 200 ze stanem ze sprawdzenia serwera', async () => {
  const check = fakeCheck({ status: STATUS.AVAILABLE, can_update: true, remote_revision: FULL_SHA });
  const out = await handleUpdateRequest({ method: 'GET', check: check.impl });

  assert.strictEqual(out.status, 200);
  assert.strictEqual(out.body.remote_revision, FULL_SHA);
});

test('kolejne GET-y w oknie TTL NIE pytają GitHuba drugi raz (limit 60/h)', async () => {
  // Panel woła loadUpdateStatus przy każdej inicjalizacji karty; bez cache kilka
  // odświeżeń wyczerpuje anonimowy limit api.github.com i funkcja aktualizacji
  // przestaje działać do końca godziny.
  const check = fakeCheck({ status: STATUS.AVAILABLE, can_update: true, remote_revision: FULL_SHA });
  const t0 = 1_000_000;

  await handleUpdateRequest({ method: 'GET', check: check.impl, now: t0 });
  await handleUpdateRequest({ method: 'GET', check: check.impl, now: t0 + 1_000 });
  const third = await handleUpdateRequest({ method: 'GET', check: check.impl, now: t0 + 60_000 });

  assert.strictEqual(check.calls.length, 1, 'trzy odświeżenia = jedno pytanie do GitHuba');
  assert.strictEqual(third.body.remote_revision, FULL_SHA, 'z cache wraca ten sam stan');
});

test('GET po wygaśnięciu TTL pyta ponownie — stan nie zamarza na stałe', async () => {
  const check = fakeCheck({ status: STATUS.AVAILABLE, can_update: true, remote_revision: FULL_SHA });
  const t0 = 1_000_000;

  await handleUpdateRequest({ method: 'GET', check: check.impl, now: t0 });
  await handleUpdateRequest({ method: 'GET', check: check.impl, now: t0 + 300_001 });

  assert.strictEqual(check.calls.length, 2);
});

test('POST NIGDY nie czyta cache — klik musi zobaczyć świeży stan', async () => {
  // Pobranie rewizji sprzed pięciu minut mogłoby ściągnąć commit, którego już nie ma.
  const check = fakeCheck({ status: STATUS.AVAILABLE, can_update: true, remote_revision: FULL_SHA });
  const start = fakeStart();
  const t0 = 1_000_000;

  await handleUpdateRequest({ method: 'GET', check: check.impl, now: t0 });
  await handleUpdateRequest({ method: 'POST', check: check.impl, start: start.impl, now: t0 + 1_000 });

  assert.strictEqual(check.calls.length, 2, 'POST pyta niezależnie od cache GET-a');
  assert.strictEqual(start.calls.length, 1);
});

test('POST /api/update przy can_update:false → 409, ZERO uruchomień instalatora', async () => {
  const check = fakeCheck({ status: STATUS.CURRENT, can_update: false, message: 'Masz najnowszą wersję.' });
  const start = fakeStart();
  const out = await handleUpdateRequest({ method: 'POST', check: check.impl, start: start.impl });

  assert.strictEqual(out.status, 409);
  assert.strictEqual(out.body.started, false);
  assert.strictEqual(start.calls.length, 0);
});

test('POST /api/update gdy startUpdate odmawia (brak .git / Linux) → 500 z powodem', async () => {
  const check = fakeCheck({ status: STATUS.AVAILABLE, can_update: true, remote_revision: FULL_SHA });
  const start = fakeStart({ ok: false, error: 'Ta instalacja nie ma repozytorium git' });
  const out = await handleUpdateRequest({ method: 'POST', check: check.impl, start: start.impl });

  assert.strictEqual(out.status, 500);
  assert.strictEqual(out.body.started, false);
  assert.match(out.body.error, /repozytorium git/);
});

test('POST /api/update przy trwającej aktualizacji → 409 (konflikt stanu), nie 500', async () => {
  const check = fakeCheck({ status: STATUS.AVAILABLE, can_update: true, remote_revision: FULL_SHA });
  const start = fakeStart({ ok: false, busy: true, error: 'Aktualizacja już trwa' });
  const out = await handleUpdateRequest({ method: 'POST', check: check.impl, start: start.impl });

  assert.strictEqual(out.status, 409);
  assert.match(out.body.error, /już trwa/);
});

test('POST /api/update IGNORUJE rewizję z body — klient nie decyduje, jaki kod się instaluje', async () => {
  const check = fakeCheck({ status: STATUS.AVAILABLE, can_update: true, remote_revision: FULL_SHA });
  const start = fakeStart({ ok: true, kind: 'mac' });
  const out = await handleUpdateRequest({
    method: 'POST',
    body: { revision: OTHER_SHA },
    check: check.impl,
    start: start.impl,
  });

  assert.strictEqual(start.calls[0].revision, FULL_SHA);
  assert.notStrictEqual(start.calls[0].revision, OTHER_SHA);
  assert.strictEqual(out.body.revision, FULL_SHA);
  assert.strictEqual(out.status, 200);
});

test('inna metoda niż GET/POST na /api/update → 405, bez sprawdzania i bez instalacji', async () => {
  const check = fakeCheck({ status: STATUS.AVAILABLE, can_update: true, remote_revision: FULL_SHA });
  const start = fakeStart();
  const out = await handleUpdateRequest({ method: 'DELETE', check: check.impl, start: start.impl });

  assert.strictEqual(out.status, 405);
  assert.strictEqual(check.calls.length, 0);
  assert.strictEqual(start.calls.length, 0);
});

// === EPERM i bootstrap przez plik (CAVE 07.08: antywirus ciął irm|iex w linii komend) ===

test('windows: bootstrap zapisany do pliku PRZED spawnem, ścieżka spójna z argumentami', () => {
  const { io, spawned, written } = fakeIo({ hasGit: false });
  const result = startUpdate({ revision: FULL_SHA, repoDir: 'C:\\repo', platform: 'win32', io });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(written.length, 1);
  assert.match(written[0].content, /irm .*install\.ps1.* \| iex/);
  assert.strictEqual(spawned[0].args[spawned[0].args.length - 1], written[0].file);
});

test('spawn rzuca (EPERM — antywirus) → czytelny błąd zamiast wyjątku, flaga wolna', () => {
  const { io } = fakeIo({ hasGit: false });
  const eperm = Object.assign(new Error('spawn EPERM'), { code: 'EPERM' });
  io.spawn = () => { throw eperm; };

  const result = startUpdate({ revision: FULL_SHA, repoDir: 'C:\\repo', platform: 'win32', io });

  assert.strictEqual(result.ok, false);
  assert.match(result.error, /EPERM/);
  assert.match(result.error, /antywirus/);
  // Flaga NIE może zostać ustawiona — inaczej panel odpowiadałby 409 do restartu daemona.
  assert.strictEqual(isUpdateInProgress(), false);
});

test('pad zapisu pliku bootstrapu → czytelny błąd, zero spawnu', () => {
  const { io, spawned } = fakeIo({ hasGit: false });
  io.writeFile = () => { throw new Error('EACCES: permission denied'); };

  const result = startUpdate({ revision: FULL_SHA, repoDir: 'C:\\repo', platform: 'win32', io });

  assert.strictEqual(result.ok, false);
  assert.match(result.error, /skryptu aktualizacji/);
  assert.strictEqual(spawned.length, 0);
});
