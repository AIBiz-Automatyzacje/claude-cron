const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  ASK_JOB_NAME,
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_MS,
  MAX_BACKGROUND_SLOTS,
  TEXT_RATE_LIMIT,
  TEXT_SYNC_BUSY,
  TEXT_SLOTS_FULL,
  verifySecret,
  admitRequest,
  releaseSyncLock,
  releaseBackgroundSlot,
  resetAskState,
  getOrCreateAskJob,
  executeAsk,
  TEXT_DETACHED,
  TEXT_SYNC_FAILED,
} = require('./ask');
const { setClaudeBin } = require('./claude-spawn');
const db = require('./db');
const discord = require('./discord');
const telegram = require('./telegram');

// Izolacja: baza in-memory (DI przez setDbPath) — wzorzec z db.test.js.
before(() => {
  db.setDbPath(':memory:');
  db.getDb();
});

after(() => {
  db.close();
});

beforeEach(() => {
  db.getDb().exec('DELETE FROM runs; DELETE FROM jobs;');
  resetAskState();
});

// Config wstrzykiwany do admitRequest — testy nie dotykają env ani lib/config.
const AUTH = { askToken: 'tok_prawidlowy', askSecret: 'sec_prawidlowy' };
const T0 = 1_000_000; // stały punkt startowy zegara

// Poprawne zapytanie z nadpisywalnymi polami.
function validRequest(overrides = {}) {
  return { token: 'tok_prawidlowy', secret: 'sec_prawidlowy', now: T0, ...overrides };
}

// Zwolnienie pełnego zapytania (lock sync + slot tła) — jak po sync-finished.
function releaseAll() {
  releaseSyncLock();
  releaseBackgroundSlot();
}

// === Autoryzacja (R2) ===

test('zły token → 403 bez treści diagnostycznej', () => {
  const decision = admitRequest(validRequest({ token: 'tok_zly' }), AUTH);

  assert.deepEqual(decision, { allowed: false, status: 403 });
  assert.equal(decision.text, undefined);
});

test('zły sekret → 403 bez treści diagnostycznej', () => {
  const decision = admitRequest(validRequest({ secret: 'sec_zly_ale_taka_sama_dl' }), AUTH);

  assert.deepEqual(decision, { allowed: false, status: 403 });
});

test('brak sekretu (undefined) → 403 bez treści diagnostycznej', () => {
  const decision = admitRequest(validRequest({ secret: undefined }), AUTH);

  assert.deepEqual(decision, { allowed: false, status: 403 });
});

test('sekrety o różnych długościach nie rzucają wyjątku (guard przed timingSafeEqual)', () => {
  assert.doesNotThrow(() => verifySecret('krotki', 'znacznie-dluzszy-sekret'));
  assert.equal(verifySecret('krotki', 'znacznie-dluzszy-sekret'), false);
});

test('verifySecret: zgodne sekrety → true', () => {
  assert.equal(verifySecret('sec_prawidlowy', 'sec_prawidlowy'), true);
});

test('brak konfiguracji ASK_TOKEN/ASK_SECRET → odmowa nawet przy „poprawnym" pustym sekrecie', () => {
  const decision = admitRequest(
    { token: '', secret: '', now: T0 },
    { askToken: '', askSecret: '' }
  );

  assert.deepEqual(decision, { allowed: false, status: 403 });
});

test('poprawny token + sekret → przyjęte', () => {
  const decision = admitRequest(validRequest(), AUTH);

  assert.deepEqual(decision, { allowed: true });
});

// === Rate limit (R3) ===

test('10 zapytań w minucie przechodzi, 11. dostaje tekst rate-limitu', () => {
  for (let i = 0; i < RATE_LIMIT_MAX; i++) {
    const decision = admitRequest(validRequest({ now: T0 + i }), AUTH);
    assert.deepEqual(decision, { allowed: true }, `zapytanie ${i + 1} powinno przejść`);
    releaseAll();
  }

  const eleventh = admitRequest(validRequest({ now: T0 + 100 }), AUTH);

  assert.deepEqual(eleventh, { allowed: false, status: 200, text: TEXT_RATE_LIMIT });
});

test('po przesunięciu zegara poza okno rate limit się odnawia', () => {
  for (let i = 0; i < RATE_LIMIT_MAX; i++) {
    admitRequest(validRequest({ now: T0 + i }), AUTH);
    releaseAll();
  }
  assert.equal(admitRequest(validRequest({ now: T0 + 100 }), AUTH).text, TEXT_RATE_LIMIT);

  const afterWindow = admitRequest(validRequest({ now: T0 + RATE_LIMIT_WINDOW_MS }), AUTH);

  assert.deepEqual(afterWindow, { allowed: true });
});

// === Lock sync (R4) ===

test('drugi równoległy sync → tekst „jeszcze myślę"', () => {
  admitRequest(validRequest(), AUTH);

  const second = admitRequest(validRequest({ now: T0 + 1 }), AUTH);

  assert.deepEqual(second, { allowed: false, status: 200, text: TEXT_SYNC_BUSY });
});

test('po zwolnieniu locka sync kolejne zapytanie przechodzi', () => {
  admitRequest(validRequest(), AUTH);
  releaseAll();

  const next = admitRequest(validRequest({ now: T0 + 1 }), AUTH);

  assert.deepEqual(next, { allowed: true });
});

// === Sloty tła (R4, rezerwacja pesymistyczna) ===

test('3 zajęte sloty tła → nowe zapytanie dostaje „mam pełne ręce" bez spawnu', () => {
  // Trzy zapytania odczepione w tło: lock sync zwolniony, slot tła trzymany.
  for (let i = 0; i < MAX_BACKGROUND_SLOTS; i++) {
    const decision = admitRequest(validRequest({ now: T0 + i }), AUTH);
    assert.deepEqual(decision, { allowed: true }, `zapytanie ${i + 1} powinno dostać slot`);
    releaseSyncLock();
  }

  const fourth = admitRequest(validRequest({ now: T0 + 10 }), AUTH);

  assert.deepEqual(fourth, { allowed: false, status: 200, text: TEXT_SLOTS_FULL });
});

test('zwolnienie slotu tła odblokowuje kolejne zapytanie', () => {
  for (let i = 0; i < MAX_BACKGROUND_SLOTS; i++) {
    admitRequest(validRequest({ now: T0 + i }), AUTH);
    releaseSyncLock();
  }
  releaseBackgroundSlot();

  const next = admitRequest(validRequest({ now: T0 + 10 }), AUTH);

  assert.deepEqual(next, { allowed: true });
});

test('kolejność bramek: rate limit sprawdzany przed lockiem sync', () => {
  // Zajmij lock sync, potem wyczerp limit młóceniem w zajęty lock — odmowy
  // liczą się do limitu, więc po RATE_LIMIT_MAX prób tekst zmienia się na rate limit.
  admitRequest(validRequest(), AUTH);
  for (let i = 1; i < RATE_LIMIT_MAX; i++) {
    assert.equal(admitRequest(validRequest({ now: T0 + i }), AUTH).text, TEXT_SYNC_BUSY);
  }

  const overLimit = admitRequest(validRequest({ now: T0 + 100 }), AUTH);

  assert.equal(overLimit.text, TEXT_RATE_LIMIT);
});

// === Teczka: getOrCreateAskJob (R8) ===

test('getOrCreateAskJob tworzy joba-teczkę z poprawnymi flagami', () => {
  const job = getOrCreateAskJob();

  assert.equal(job.name, ASK_JOB_NAME);
  assert.equal(job.skill_name, '');
  assert.equal(job.cron_expr, '');
  assert.equal(job.routine, 1);
  assert.equal(job.run_on_wake, 0);
  assert.equal(job.discord_notify, 0);
  assert.equal(job.telegram_notify, 0);
});

test('getOrCreateAskJob wołane dwa razy → jeden job', () => {
  const first = getOrCreateAskJob();
  const second = getOrCreateAskJob();

  assert.equal(first.id, second.id);
  assert.equal(db.getAllJobs().length, 1);
});

test('ręczna zmiana telegram_notify=1 między wywołaniami NIE jest nadpisana', () => {
  const job = getOrCreateAskJob();
  db.updateJob(job.id, { telegram_notify: 1 });

  const again = getOrCreateAskJob();

  assert.equal(again.id, job.id);
  assert.equal(again.telegram_notify, 1);
  assert.equal(db.getAllJobs().length, 1);
});

// === Wykonanie zapytania: spawn, odczepienie, powiadomienia (Unit 4) ===

// Atrapa CLI przez shebang `#!/usr/bin/env node`: flagi asystenckie (--dangerously-...)
// trafiają do process.argv skryptu, nie do binarki node (setClaudeBin(process.execPath)
// nie zadziała — node odrzuciłby nieznane flagi). Shebang wymaga POSIX → skip na Windows.
const SKIP_WIN = process.platform === 'win32'
  ? 'atrapa CLI przez shebang wymaga POSIX — gałąź spawnu pokryta na macOS/Linux'
  : false;

function makeFakeClaude(t, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-fake-claude-'));
  const scriptPath = path.join(dir, 'fake-claude.js');
  fs.writeFileSync(scriptPath, `#!/usr/bin/env node\n${body}`);
  fs.chmodSync(scriptPath, 0o755);
  setClaudeBin(scriptPath);
  t.after(() => {
    setClaudeBin(null);
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

// Mocki WYŁĄCZNIE na kanałach (zewnętrzne serwisy) — spawn i db realne.
function mockChannels(t) {
  return {
    discord: t.mock.method(discord, 'sendPlain', async () => {}),
    telegram: t.mock.method(telegram, 'sendPlain', async () => {}),
  };
}

// Deterministyczne czekanie na PEŁNE domknięcie cyklu (close odczepionego procesu)
// zamiast sleep-pollingu — executeAsk woła onSettled po finalize + zwolnieniu slotu.
function settledSignal() {
  let onSettled;
  const settled = new Promise((resolve) => { onSettled = resolve; });
  return { settled, onSettled };
}

test('sync happy path: szybka odpowiedź → stdout, run success, zero powiadomień', { skip: SKIP_WIN }, async (t) => {
  // Arrange — atrapa echa promptu (ostatni argv = prompt); flagi kanałów WŁĄCZONE,
  // żeby „zero wywołań" świadczyło o ścieżce sync, a nie o wyłączonych flagach.
  makeFakeClaude(t, 'process.stdout.write("ECHO:" + process.argv[process.argv.length - 1]);');
  const channels = mockChannels(t);
  const job = getOrCreateAskJob();
  db.updateJob(job.id, { discord_notify: 1, telegram_notify: 1 });
  admitRequest(validRequest(), AUTH);
  const { settled, onSettled } = settledSignal();

  // Act
  const result = await executeAsk('Która jest godzina?', { askTimeoutMs: 5000, askMaxMs: 10_000, onSettled });
  await settled;

  // Assert — odpowiedź = stdout atrapy; prompt = template asystencki + pytanie
  assert.equal(result.detached, false);
  assert.equal(result.status, 'success');
  assert.ok(result.text.startsWith('ECHO:'), 'odpowiedź sync to surowy stdout');
  assert.ok(result.text.includes('asystentem głosowym'), 'prompt zawiera template asystencki');
  assert.ok(result.text.includes('Która jest godzina?'), 'prompt zawiera pytanie usera');
  const run = db.getRunWithPayload(result.runId);
  assert.equal(run.status, 'success');
  assert.equal(run.trigger_type, 'ask');
  assert.equal(run.webhook_payload, 'Która jest godzina?');
  assert.ok(run.stdout.includes('Która jest godzina?'), 'odpowiedź zapisana w stdout runu');
  assert.equal(channels.discord.mock.callCount(), 0);
  assert.equal(channels.telegram.mock.callCount(), 0);
});

test('sync happy path zwalnia lock sync i slot tła', { skip: SKIP_WIN }, async (t) => {
  // Arrange
  makeFakeClaude(t, 'process.stdout.write("ok");');
  mockChannels(t);
  admitRequest(validRequest(), AUTH);
  const { settled, onSettled } = settledSignal();

  // Act
  await executeAsk('pytanie', { askTimeoutMs: 5000, askMaxMs: 10_000, onSettled });
  await settled;

  // Assert — po pełnym cyklu sync obie rezerwacje wróciły (kolejne zapytanie wchodzi)
  assert.deepEqual(admitRequest(validRequest({ now: T0 + 1 }), AUTH), { allowed: true });
});

test('odczepienie: wolny proces → „robię w tle", potem run success + dokładnie jedno ✅', { skip: SKIP_WIN }, async (t) => {
  // Arrange — atrapa śpi dłużej niż testowy ASK_TIMEOUT_MS, ale kończy pracę (bez killa)
  makeFakeClaude(t, 'setTimeout(() => { process.stdout.write("późny wynik z tła"); process.exit(0); }, 300);');
  const channels = mockChannels(t);
  const job = getOrCreateAskJob();
  db.updateJob(job.id, { telegram_notify: 1 });
  admitRequest(validRequest(), AUTH);
  const { settled, onSettled } = settledSignal();

  // Act — odpowiedź przychodzi PRZED zakończeniem procesu
  const result = await executeAsk('policz coś długiego', { askTimeoutMs: 50, askMaxMs: 10_000, onSettled });

  // Assert — natychmiastowa odpowiedź „robię w tle"
  assert.equal(result.detached, true);
  assert.equal(result.text, TEXT_DETACHED);
  assert.equal(db.getRunWithPayload(result.runId).status, 'running');

  await settled;

  // Assert — proces NIE ubity: dokończył pracę, wynik w runie i w powiadomieniu
  const run = db.getRunWithPayload(result.runId);
  assert.equal(run.status, 'success');
  assert.ok(run.stdout.includes('późny wynik z tła'), 'proces dokończył pracę po odczepieniu');
  assert.equal(channels.telegram.mock.callCount(), 1, 'dokładnie jedno powiadomienie');
  const message = channels.telegram.mock.calls[0].arguments[0];
  assert.ok(message.startsWith('✅'), 'powiadomienie sukcesu zaczyna się od ✅');
  assert.ok(message.includes('późny wynik z tła'), 'surowy stdout w powiadomieniu');
  assert.equal(channels.discord.mock.callCount(), 0, 'flaga discord_notify=0 → kanał milczy');
});

test('odczepienie zwalnia lock sync od razu, slot tła dopiero po close', { skip: SKIP_WIN }, async (t) => {
  // Arrange
  makeFakeClaude(t, 'setTimeout(() => process.exit(0), 300);');
  mockChannels(t);
  admitRequest(validRequest(), AUTH);
  const { settled, onSettled } = settledSignal();

  // Act
  await executeAsk('pytanie', { askTimeoutMs: 50, askMaxMs: 10_000, onSettled });

  // Assert — lock sync wolny od razu po odczepieniu (kolejny sync może wejść)
  const during = admitRequest(validRequest({ now: T0 + 1 }), AUTH);
  assert.deepEqual(during, { allowed: true });
  releaseAll(); // sonda oddaje swoją rezerwację

  await settled; // close odczepionego procesu oddaje slot tła
  assert.deepEqual(admitRequest(validRequest({ now: T0 + 2 }), AUTH), { allowed: true });
});

test('pad odczepionego procesu (exit≠0) → run failed + dokładnie jedno ❌', { skip: SKIP_WIN }, async (t) => {
  // Arrange
  makeFakeClaude(t, 'setTimeout(() => { process.stderr.write("boom z tła"); process.exit(1); }, 200);');
  const channels = mockChannels(t);
  const job = getOrCreateAskJob();
  db.updateJob(job.id, { telegram_notify: 1 });
  admitRequest(validRequest(), AUTH);
  const { settled, onSettled } = settledSignal();

  // Act
  const result = await executeAsk('padnij', { askTimeoutMs: 50, askMaxMs: 10_000, onSettled });
  await settled;

  // Assert
  assert.equal(result.detached, true);
  const run = db.getRunWithPayload(result.runId);
  assert.equal(run.status, 'failed');
  assert.equal(run.exit_code, 1);
  assert.equal(channels.telegram.mock.callCount(), 1, 'dokładnie jedno powiadomienie');
  const message = channels.telegram.mock.calls[0].arguments[0];
  assert.ok(message.startsWith('❌'), 'powiadomienie pada zaczyna się od ❌');
  assert.ok(message.includes('boom z tła'), 'ogon stderr jako przyczyna pada');
});

test('przekroczenie ASK_MAX_MS → proces ubity, run timeout, dokładnie jedno ❌', { skip: SKIP_WIN }, async (t) => {
  // Arrange — atrapa „wisi" 10 s; bez killa test by tyle trwał
  makeFakeClaude(t, 'setTimeout(() => process.exit(0), 10000);');
  const channels = mockChannels(t);
  const job = getOrCreateAskJob();
  db.updateJob(job.id, { telegram_notify: 1 });
  admitRequest(validRequest(), AUTH);
  const { settled, onSettled } = settledSignal();
  const startedAt = Date.now();

  // Act
  const result = await executeAsk('zawieś się', { askTimeoutMs: 50, askMaxMs: 250, onSettled });
  await settled;

  // Assert — kill zadziałał (cykl domknięty daleko przed 10 s snu atrapy)
  assert.equal(result.detached, true);
  assert.ok(Date.now() - startedAt < 5000, 'proces ubity, nie doczekał końca snu');
  const run = db.getRunWithPayload(result.runId);
  assert.equal(run.status, 'timeout');
  assert.ok(run.error_msg.includes('ASK_MAX_MS'), 'przyczyna w error_msg');
  assert.equal(channels.telegram.mock.callCount(), 1, 'dokładnie jedno ❌ (finalize idempotentne kill vs close)');
  assert.ok(channels.telegram.mock.calls[0].arguments[0].startsWith('❌'));
});

test('wnuk trzymający pipe po wyjściu CLI → cykl domknięty z exit, slot tła zwolniony', { skip: SKIP_WIN }, async (t) => {
  // Arrange — regresja P2 z review fazy 2: atrapa spawnuje odczepionego wnuka
  // DZIEDZICZĄCEGO stdout/stderr i natychmiast kończy. Wnuk żyje ~1.5 s i trzyma
  // pipe, więc 'close' procesu nie nadejdzie — bez domknięcia z 'exit' slot tła
  // wyciekałby na zawsze (permanentne „⏳ Mam pełne ręce").
  makeFakeClaude(t, [
    'const { spawn } = require("node:child_process");',
    'spawn(process.execPath, ["-e", "setTimeout(() => {}, 1500)"], { detached: true, stdio: ["ignore", "inherit", "inherit"] }).unref();',
    'process.stdout.write("wynik przed wyjściem");',
    'process.exit(0);',
  ].join('\n'));
  mockChannels(t);
  admitRequest(validRequest(), AUTH);
  const { settled, onSettled } = settledSignal();
  const startedAt = Date.now();

  // Act
  const result = await executeAsk('pytanie', { askTimeoutMs: 5000, askMaxMs: 10_000, exitCloseGraceMs: 100, onSettled });
  await settled;

  // Assert — domknięcie z karencji po 'exit' (daleko przed śmiercią wnuka), nie z 'close'
  assert.ok(Date.now() - startedAt < 1200, 'cykl domknięty z exit-grace zamiast czekania na close wnuka');
  assert.equal(result.detached, false);
  assert.equal(result.status, 'success');
  assert.ok(result.text.includes('wynik przed wyjściem'), 'stdout sprzed exit dotarł mimo wiszącego pipe');
  assert.equal(db.getRunWithPayload(result.runId).status, 'success');
  assert.deepEqual(
    admitRequest(validRequest({ now: T0 + 1 }), AUTH),
    { allowed: true },
    'lock sync i slot tła zwolnione mimo braku close'
  );
});

test('close po oznaczeniu runu killed w DB → brak nadpisania statusu i brak powiadomienia', { skip: SKIP_WIN }, async (t) => {
  // Arrange — symulacja reapera/usera: run dostaje 'killed' ZANIM proces się domknie
  makeFakeClaude(t, 'setTimeout(() => { process.stdout.write("wynik"); process.exit(0); }, 300);');
  const channels = mockChannels(t);
  const job = getOrCreateAskJob();
  db.updateJob(job.id, { telegram_notify: 1 });
  admitRequest(validRequest(), AUTH);
  const { settled, onSettled } = settledSignal();

  // Act
  const result = await executeAsk('pytanie', { askTimeoutMs: 50, askMaxMs: 10_000, onSettled });
  db.updateRun(result.runId, { status: 'killed', finished_at: new Date().toISOString(), error_msg: 'Killed by user' });
  await settled;

  // Assert — guard świeżego odczytu: close NIE nadpisał killed i NIE powiadomił
  const run = db.getRunWithPayload(result.runId);
  assert.equal(run.status, 'killed');
  assert.equal(run.error_msg, 'Killed by user');
  assert.equal(channels.telegram.mock.callCount(), 0);
  assert.equal(channels.discord.mock.callCount(), 0);
});

test('flagi teczki oba 0 → odczepione zadanie loguje warning zamiast cicho zgubić wynik', { skip: SKIP_WIN }, async (t) => {
  // Arrange — teczka z domyślnymi flagami 0/0 (jedyny dopuszczalny „cichy" przypadek)
  makeFakeClaude(t, 'setTimeout(() => { process.stdout.write("wynik bez kanału"); process.exit(0); }, 200);');
  const channels = mockChannels(t);
  const warnMock = t.mock.method(console, 'warn', () => {});
  admitRequest(validRequest(), AUTH);
  const { settled, onSettled } = settledSignal();

  // Act
  const result = await executeAsk('pytanie', { askTimeoutMs: 50, askMaxMs: 10_000, onSettled });
  await settled;

  // Assert — run domknięty, zero wysyłek, jawny warning [ask]
  assert.equal(db.getRunWithPayload(result.runId).status, 'success');
  assert.equal(channels.telegram.mock.callCount(), 0);
  assert.equal(channels.discord.mock.callCount(), 0);
  const warnings = warnMock.mock.calls.map((c) => String(c.arguments[0]));
  assert.ok(
    warnings.some((w) => w.includes('[ask]') && w.includes('kanału powiadomień')),
    `oczekiwany warning [ask] o braku kanału, dostałem: ${JSON.stringify(warnings)}`
  );
});

test('pad spawnu (nieistniejąca binarka) → sync failed + zwolnione obie rezerwacje', async (t) => {
  // Arrange — spawn emituje 'error' (ENOENT) zamiast close
  setClaudeBin(path.join(os.tmpdir(), 'ask-nieistniejaca-binarka-claude'));
  t.after(() => setClaudeBin(null));
  const channels = mockChannels(t);
  admitRequest(validRequest(), AUTH);
  const { settled, onSettled } = settledSignal();

  // Act
  const result = await executeAsk('pytanie', { askTimeoutMs: 5000, askMaxMs: 10_000, onSettled });
  await settled;

  // Assert — czytelny fail bez powiadomień (sync), rezerwacje oddane
  assert.equal(result.detached, false);
  assert.equal(result.status, 'failed');
  assert.equal(result.text, TEXT_SYNC_FAILED);
  const run = db.getRunWithPayload(result.runId);
  assert.equal(run.status, 'failed');
  assert.ok(run.error_msg.includes('ENOENT'), 'przyczyna spawnu w error_msg');
  assert.equal(channels.telegram.mock.callCount(), 0);
  assert.deepEqual(admitRequest(validRequest({ now: T0 + 1 }), AUTH), { allowed: true });
});
