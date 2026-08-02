const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { isFinalFailure, readOauthToken } = require('./executor');

// Próg eskalacji — ten sam, którego używa killProcessTree (test nie zgaduje wartości).
const KILL_ESCALATION_MS = 5000;

// === readOauthToken — długożyjący token OAuth (setup-token) dla headless auth ===
// Wcześniej żył jako niezacommitowana łatka na VPS usera — upstreamowany, żeby
// przeżywał auto-update (git pull) bez ręcznego stash-dance.

test('readOauthToken: plik z tokenem → token po trim', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-token-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, '.claude-cron-oauth-token');
  fs.writeFileSync(file, '  sk-ant-oat01-abc123  \n');
  assert.equal(readOauthToken(file), 'sk-ant-oat01-abc123');
});

test('readOauthToken: brak pliku → null (normalny przypadek, bez rzucania)', () => {
  assert.equal(readOauthToken('/nieistniejacy/katalog/.claude-cron-oauth-token'), null);
});

test('readOauthToken: pusty plik (same białe znaki) → null', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-token-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, '.claude-cron-oauth-token');
  fs.writeFileSync(file, '   \n');
  assert.equal(readOauthToken(file), null);
});

// Czysta decyzja "czy wysłać ❌" (R9): tylko OSTATECZNY fail/timeout, nigdy killed,
// nigdy gdy retry jeszcze przed nami. Okno liczenia failów = to samo co retry
// w scheduler.processQueue (max_retries + 1 ostatnich runów joba).

test('timeout jest zawsze ostateczny (scheduler nie retry\'uje timeoutów)', () => {
  assert.equal(isFinalFailure('timeout', 3, 0), true);
});

test('killed nigdy nie powiadamia — świadoma decyzja usera', () => {
  assert.equal(isFinalFailure('killed', 0, 1), false);
});

test('success nie jest failem — brak wysyłki ❌', () => {
  assert.equal(isFinalFailure('success', 1, 0), false);
});

test('failed z max_retries=0 → od razu ostateczny', () => {
  assert.equal(isFinalFailure('failed', 0, 1), true);
});

test('failed z retry jeszcze dostępnym → brak wysyłki (1 fail w oknie, max_retries=1)', () => {
  assert.equal(isFinalFailure('failed', 1, 1), false);
});

test('failed po wyczerpaniu retry → wysyłka (2 faile w oknie, max_retries=1)', () => {
  assert.equal(isFinalFailure('failed', 1, 2), true);
});

// === notifyRunOutcome (wiring powiadomień) + guard killed — integracja na DB :memory: ===
// Mockowane są WYŁĄCZNIE zewnętrzne kanały (discord/telegram — granica sieci); db jest realne.

const { before, after, beforeEach } = require('node:test');

const db = require('./db');
const discord = require('./discord');
const telegram = require('./telegram');
const executor = require('./executor');

before(() => {
  db.setDbPath(':memory:');
  db.getDb();
});

after(() => {
  db.close();
});

beforeEach(() => {
  db.getDb().exec('DELETE FROM runs; DELETE FROM jobs;');
});

// Mock wszystkich 4 metod kanałów; zwraca nagrane wywołania per metoda.
function mockChannels(t) {
  const calls = { discordSuccess: [], telegramSuccess: [], discordFail: [], telegramFail: [] };
  t.mock.method(discord, 'sendNotification', async (...a) => { calls.discordSuccess.push(a); });
  t.mock.method(telegram, 'sendNotification', async (...a) => { calls.telegramSuccess.push(a); });
  t.mock.method(discord, 'sendFailureNotification', async (...a) => { calls.discordFail.push(a); });
  t.mock.method(telegram, 'sendFailureNotification', async (...a) => { calls.telegramFail.push(a); });
  return calls;
}

function totalCalls(calls) {
  return calls.discordSuccess.length + calls.telegramSuccess.length
    + calls.discordFail.length + calls.telegramFail.length;
}

function notifyJob(overrides = {}) {
  return db.createJob({ name: 'notify-job', skill_name: 's', cron_expr: '0 9 * * *', ...overrides });
}

test('notifyRunOutcome: success + obie flagi → sendNotification OBU kanałów ze stdoutem, zero ❌', (t) => {
  // Arrange
  const calls = mockChannels(t);
  const job = notifyJob({ discord_notify: 1, telegram_notify: 1 });

  // Act
  executor.notifyRunOutcome(job, 'success', { stdout: 'SUROWY-STDOUT', stderr: '', errorMsg: '' });

  // Assert — rozgałęzienie success→sendNotification (nie sendFailureNotification)
  assert.equal(calls.discordSuccess.length, 1);
  assert.equal(calls.telegramSuccess.length, 1);
  assert.equal(calls.telegramSuccess[0][0].id, job.id);
  assert.equal(calls.telegramSuccess[0][1], 'SUROWY-STDOUT');
  assert.equal(calls.discordFail.length + calls.telegramFail.length, 0);
});

test('notifyRunOutcome: success bez flag kanałów → zero wywołań (gating flagami)', (t) => {
  // Arrange — domyślne discord_notify=0, telegram_notify=0
  const calls = mockChannels(t);
  const job = notifyJob();

  // Act
  executor.notifyRunOutcome(job, 'success', { stdout: 'wynik', stderr: '', errorMsg: '' });

  // Assert
  assert.equal(totalCalls(calls), 0);
});

test('notifyRunOutcome: tylko telegram_notify=1 → Discord nietknięty (niezależność kanałów)', (t) => {
  // Arrange
  const calls = mockChannels(t);
  const job = notifyJob({ telegram_notify: 1 });

  // Act
  executor.notifyRunOutcome(job, 'success', { stdout: 'wynik', stderr: '', errorMsg: '' });

  // Assert — odwrócenie flag kanałów byłoby złapane tutaj
  assert.equal(calls.telegramSuccess.length, 1);
  assert.equal(calls.discordSuccess.length, 0);
});

test('notifyRunOutcome: routine + flagi → success NIE wysyła (sukces rutynowy = szum)', (t) => {
  // Arrange — job typu inbox sync (co 1 min): flaga kanału ma być alarmem o failach, nie spamem
  const calls = mockChannels(t);
  const job = notifyJob({ telegram_notify: 1, discord_notify: 1, routine: 1 });

  // Act
  executor.notifyRunOutcome(job, 'success', { stdout: 'wynik', stderr: '', errorMsg: '' });

  // Assert
  assert.equal(totalCalls(calls), 0);
});

test('notifyRunOutcome: routine + flaga → ostateczny fail DALEJ alarmuje (routine tłumi tylko sukcesy)', (t) => {
  // Arrange
  const calls = mockChannels(t);
  const job = notifyJob({ telegram_notify: 1, routine: 1, max_retries: 0 });
  const run = db.createRun({ job_id: job.id, trigger_type: 'manual' });
  db.updateRun(run.id, { status: 'failed' });

  // Act
  executor.notifyRunOutcome(job, 'failed', { stdout: '', stderr: 'STDERR', errorMsg: 'boom' });

  // Assert
  assert.equal(calls.telegramFail.length, 1);
  assert.equal(calls.telegramSuccess.length, 0);
});

test('notifyRunOutcome: ostateczny fail (max_retries=0) + flaga → ❌ z kształtem {status, error_msg, stderr}', (t) => {
  // Arrange — fail w bazie (notifyRunOutcome liczy okno PO db.updateRun)
  const calls = mockChannels(t);
  const job = notifyJob({ telegram_notify: 1, max_retries: 0 });
  const run = db.createRun({ job_id: job.id, trigger_type: 'manual' });
  db.updateRun(run.id, { status: 'failed' });

  // Act
  executor.notifyRunOutcome(job, 'failed', { stdout: '', stderr: 'STDERR-OGON', errorMsg: 'boom' });

  // Assert — final-fail idzie do sendFailureNotification (nie sendNotification), kontrakt kształtu
  assert.equal(calls.telegramFail.length, 1);
  assert.deepEqual(calls.telegramFail[0][1], { status: 'failed', error_msg: 'boom', stderr: 'STDERR-OGON' });
  assert.equal(calls.telegramSuccess.length, 0);
  assert.equal(calls.discordFail.length, 0, 'flaga Discorda wyłączona — kanał nie wołany');
});

test('notifyRunOutcome: fail z retry przed nami (max_retries=1, 1 fail w oknie) → suppresja ❌', (t) => {
  // Arrange — pierwszy fail: scheduler dorzuci retry, więc ❌ jeszcze nie idzie (R9)
  const calls = mockChannels(t);
  const job = notifyJob({ telegram_notify: 1, discord_notify: 1, max_retries: 1 });
  const run = db.createRun({ job_id: job.id, trigger_type: 'manual' });
  db.updateRun(run.id, { status: 'failed' });

  // Act
  executor.notifyRunOutcome(job, 'failed', { stdout: '', stderr: 'x', errorMsg: '' });

  // Assert
  assert.equal(totalCalls(calls), 0);
});

test('notifyRunOutcome: killed → żaden kanał nie wołany mimo flag (świadome ubicie przez usera)', (t) => {
  // Arrange
  const calls = mockChannels(t);
  const job = notifyJob({ telegram_notify: 1, discord_notify: 1, max_retries: 0 });
  const run = db.createRun({ job_id: job.id, trigger_type: 'manual' });
  db.updateRun(run.id, { status: 'killed' });

  // Act
  executor.notifyRunOutcome(job, 'killed', { stdout: '', stderr: '', errorMsg: 'Killed by user' });

  // Assert
  assert.equal(totalCalls(calls), 0);
});

test('guard killed (ścieżka script): status killed w DB przed close wygrywa nad exit code — run zostaje killed, zero ❌', async (t) => {
  // Arrange — max_retries=0: regresja usuwająca odczyt priorRun w close dałaby status
  // 'failed' (exit ≠ 0) → isFinalFailure=true → wysyłkę ❌ mimo świadomego ubicia przez usera
  const calls = mockChannels(t);
  const scriptPath = path.join(os.tmpdir(), `puls-killed-guard-${process.pid}.js`);
  fs.writeFileSync(scriptPath, 'setTimeout(() => process.exit(1), 500);');
  t.after(() => fs.rmSync(scriptPath, { force: true }));

  const job = db.createJob({
    name: 'killed-job', job_type: 'script', command: scriptPath,
    max_retries: 0, discord_notify: 1, telegram_notify: 1,
  });
  const run = db.createRun({ job_id: job.id, trigger_type: 'manual' });

  // Act — start runu; w trakcie życia procesu zapis 'killed' do DB (dokładnie jak killCurrent)
  const done = executor.executeRun(run);
  await new Promise((r) => setTimeout(r, 150));
  db.updateRun(run.id, { status: 'killed', finished_at: new Date().toISOString(), error_msg: 'Killed by user' });
  await done;

  // Assert — close NIE nadpisał killed failem i nie powiadomił żadnego kanału
  const final = db.getRunWithPayload(run.id);
  assert.equal(final.status, 'killed');
  assert.equal(final.error_msg, 'Killed by user');
  assert.equal(totalCalls(calls), 0);
});

// === activeRuns: równoległość runów i kill per run (Unit 2) ===
// Mapa aktywnych runów zastąpiła globalny slot. Testy jadą na REALNYCH procesach
// skryptowych (spawn `node <plik>`) — mockowanie procesu ukryłoby dokładnie to, co
// tu boli: kto i kiedy zwalnia wpis w mapie.

function writeTempScript(t, body) {
  const file = path.join(os.tmpdir(), `puls-exec-${process.pid}-${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(file, body);
  t.after(() => fs.rmSync(file, { force: true }));
  return file;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function scriptJob(overrides) {
  return db.createJob({ name: `script-${Math.random().toString(36).slice(2)}`, job_type: 'script', max_retries: 0, ...overrides });
}

test('dwa runy równocześnie: killRun ubija wskazany, drugi dobiega do success (koniec semantyki singletonu)', async (t) => {
  // Arrange — dwa realne procesy w locie naraz; przy globalnym slocie drugi spawn
  // nadpisywałby pierwszy i kill trafiałby w niewłaściwy proces.
  const calls = mockChannels(t);
  const longScript = writeTempScript(t, 'setTimeout(() => process.exit(0), 5000);');
  const shortScript = writeTempScript(t, 'setTimeout(() => process.exit(0), 400);');
  const jobLong = scriptJob({ command: longScript, telegram_notify: 1, discord_notify: 1 });
  const jobShort = scriptJob({ command: shortScript });
  const runLong = db.createRun({ job_id: jobLong.id, trigger_type: 'manual' });
  const runShort = db.createRun({ job_id: jobShort.id, trigger_type: 'manual' });

  // Act
  const doneLong = executor.executeRun(runLong);
  const doneShort = executor.executeRun(runShort);
  assert.equal(executor.getActiveRuns().length, 2, 'oba runy biegną równolegle');

  assert.equal(executor.killRun(runLong.id), true);
  await Promise.all([doneLong, doneShort]);

  // Assert — kill dotknął DOKŁADNIE jednego runu
  assert.equal(db.getRunWithPayload(runLong.id).status, 'killed');
  assert.equal(db.getRunWithPayload(runShort.id).status, 'success');
  assert.equal(totalCalls(calls), 0, 'killed milczy, a sukces drugiego joba nie ma flag kanałów');
  assert.equal(executor.getActiveRuns().length, 0, 'po zakończeniu obu runów mapa pusta');
  assert.equal(executor.isRunning(), false);
});

test('killRun: status killed ląduje w DB PRZED ubiciem procesu — close nie nadpisuje go failem ani nie wysyła ❌', async (t) => {
  // Arrange — max_retries=0 + exit 1: gdyby kolejność się odwróciła, close policzyłby
  // 'failed' (exit ≠ 0 po SIGTERM) → isFinalFailure=true → ❌ mimo decyzji usera.
  const calls = mockChannels(t);
  const script = writeTempScript(t, 'setTimeout(() => process.exit(1), 5000);');
  const job = scriptJob({ command: script, telegram_notify: 1, discord_notify: 1 });
  const run = db.createRun({ job_id: job.id, trigger_type: 'manual' });

  // Act
  const done = executor.executeRun(run);
  executor.killRun(run.id);

  // Assert — zapis widoczny SYNCHRONICZNIE po powrocie z killRun, czyli zanim
  // jakiekolwiek zdarzenie procesu zdąży się obsłużyć.
  assert.equal(db.getRunWithPayload(run.id).status, 'killed');

  await done;
  const final = db.getRunWithPayload(run.id);
  assert.equal(final.status, 'killed');
  assert.equal(final.error_msg, 'Killed by user');
  assert.equal(totalCalls(calls), 0);
});

test('killRun(nieistniejący run) → false, bez rzucania (id przychodzi od usera)', () => {
  assert.equal(executor.killRun(999_999), false);
});

test('killCurrent: 0 aktywnych → false, 1 → kill, >1 → null (niejednoznaczne, warstwa HTTP nie zgaduje)', async (t) => {
  // Arrange
  mockChannels(t);
  const script = writeTempScript(t, 'setTimeout(() => process.exit(0), 3000);');
  const jobA = scriptJob({ command: script });
  const jobB = scriptJob({ command: script });

  // Assert — nic nie biegnie
  assert.equal(executor.killCurrent(), false);

  // Act — dwa aktywne runy
  const runA = db.createRun({ job_id: jobA.id, trigger_type: 'manual' });
  const runB = db.createRun({ job_id: jobB.id, trigger_type: 'manual' });
  const doneA = executor.executeRun(runA);
  const doneB = executor.executeRun(runB);

  assert.equal(executor.killCurrent(), null, 'przy dwóch aktywnych killCurrent nie wybiera ofiary');
  assert.equal(db.getRunWithPayload(runA.id).status, 'running', 'żaden run nie został tknięty');
  assert.equal(db.getRunWithPayload(runB.id).status, 'running');

  // Act — zostaje jeden aktywny: shim zachowuje się jak dawniej
  executor.killRun(runA.id);
  await doneA;
  assert.equal(executor.killCurrent(), true);
  await doneB;

  // Assert
  assert.equal(db.getRunWithPayload(runB.id).status, 'killed');
  assert.equal(executor.isRunning(), false);
});

test('wpis w mapie zwalnia się także wtedy, gdy close nie przychodzi (wnuk trzyma pipe)', async (t) => {
  // Arrange — dziecko odpala wnuka DZIEDZICZĄCEGO stdio i kończy się natychmiast.
  // Wnuk trzyma pipe, więc 'close' rodzica przyjdzie dopiero po jego śmierci; wpis
  // wiszący wyłącznie na 'close' wyciekłby i cicho zmniejszył limit współbieżności
  // (docs/solutions/2026-07-14).
  mockChannels(t);
  const grandchildMs = executor.EXIT_RELEASE_GRACE_MS + 2000;
  const script = writeTempScript(t, [
    "const { spawn } = require('node:child_process');",
    `spawn(process.execPath, ['-e', 'setTimeout(() => {}, ${grandchildMs})'], { stdio: 'inherit' });`,
    'process.exit(0);',
  ].join('\n'));
  const job = scriptJob({ command: script });
  const run = db.createRun({ job_id: job.id, trigger_type: 'manual' });

  // Act
  const done = executor.executeRun(run);
  await sleep(executor.EXIT_RELEASE_GRACE_MS + 600);

  // Assert — proces jeszcze nie domknął stdio (run wciąż 'running'), a slot już wolny
  assert.equal(db.getRunWithPayload(run.id).status, 'running', 'close faktycznie jeszcze nie przyszedł');
  assert.equal(executor.getActiveRuns().length, 0, 'ratunkowe zwolnienie po exit uwolniło wpis');
  assert.equal(executor.isRunning(), false);

  await done;
  assert.equal(db.getRunWithPayload(run.id).status, 'success', 'spóźniony close finalizuje run normalnie');
  assert.equal(executor.getActiveRuns().length, 0);
});

// === startSleepAwareTimeout — twardy timeout, który nie liczy snu maszyny ===
// Regresja z 28/29.07: `setTimeout(timeout_ms)` mierzy wall-clock, więc uśpiony Mac
// zjadał budżet runu. 15 timeoutów inbox synca (limit 60 s) przy realnym czasie pracy
// ~0,2 s i job „Aktualizacja .env" ubity po 600 s mimo sześciu porcji roboty.
//
// ⓘ mock.timers.tick(N) przesuwa zegar o CAŁE N, a dopiero potem odpala zaległe
// callbacki — pierwszy widzi całą lukę naraz. To ten sam kształt, co odblokowany
// event loop po śnie, więc normalne tykanie symulujemy serią małych ticków.
function tickSteadily(t, totalMs, stepMs = executor.TIMEOUT_TICK_MS) {
  for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) t.mock.timers.tick(stepMs);
}

test('startSleepAwareTimeout: bez snu wygasa po zadanym czasie', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  let expired = 0;

  executor.startSleepAwareTimeout({ timeoutMs: 60_000, onExpire: () => { expired++; } });

  tickSteadily(t, 55_000);
  assert.equal(expired, 0, 'przed upływem limitu run żyje');

  tickSteadily(t, 10_000);
  assert.equal(expired, 1, 'po przekroczeniu limitu run zabity dokładnie raz');
});

test('startSleepAwareTimeout: sen przesuwa deadline zamiast zabijać run', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  let expired = 0;
  const sleeps = [];

  executor.startSleepAwareTimeout({
    timeoutMs: 60_000,
    onExpire: () => { expired++; },
    onSleep: (gap) => sleeps.push(gap),
  });

  // 30 s realnej pracy, potem 30 min snu — wall-clock dawno za limitem 60 s.
  tickSteadily(t, 30_000);
  t.mock.timers.tick(1_800_000);

  assert.equal(expired, 0, 'sen nie jest powodem do zabicia runu');
  assert.deepEqual(sleeps, [1_800_000], 'luka rozpoznana jako sen, z jej realną długością');

  // Po wybudzeniu zostaje dokładnie tyle budżetu, ile było przed zaśnięciem: 30 z 60 s.
  tickSteadily(t, 25_000);
  assert.equal(expired, 0, 'po wybudzeniu run dostaje resztę swojego limitu');
  tickSteadily(t, 10_000);
  assert.equal(expired, 1, 'limit liczony od czasu REALNEJ pracy, nie wall-clocku');
});

test('startSleepAwareTimeout: krótka zadyszka event loopu NIE uchodzi za sen', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  let expired = 0;
  const sleeps = [];

  executor.startSleepAwareTimeout({
    timeoutMs: 60_000,
    onExpire: () => { expired++; },
    onSleep: (gap) => sleeps.push(gap),
  });

  // Zablokowany event loop na 30 s: wygląda jak luka, ale jest poniżej progu snu.
  // Gdyby przesunął deadline, twardy timeout przestałby cokolwiek znaczyć.
  t.mock.timers.tick(30_000);
  assert.deepEqual(sleeps, [], 'zadyszka poniżej progu nie jest snem');

  tickSteadily(t, 35_000);
  assert.equal(expired, 1, 'zadyszka wliczona do limitu — run zabity w terminie');
});

test('startSleepAwareTimeout: clear() zatrzymuje zegar (run zakończony w terminie)', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  let expired = 0;

  const timer = executor.startSleepAwareTimeout({ timeoutMs: 10_000, onExpire: () => { expired++; } });
  timer.clear();

  tickSteadily(t, 60_000);
  assert.equal(expired, 0, 'po clear() nic już nie zabija procesu');
});

// === killProcessTree — eskalacja SIGTERM → SIGKILL (Unix) ===
// Regresja z review CodeRabbita (PR #2): warunek `if (!proc.killed)` przed SIGKILL
// zabijał całą eskalację, bo `proc.killed` znaczy „sygnał wysłany", a NIE „proces
// umarł" — po SIGTERM flaga jest już `true`. Skutek: proces ignorujący SIGTERM żył
// dalej, a slot (zwalniany na 'exit') wisiał do restartu serwera.

function fakeProc() {
  const signals = [];
  const listeners = { exit: [] };
  return {
    pid: 4242,
    signals,
    // Wierne odwzorowanie Node: kill() ustawia `killed` niezależnie od tego, czy
    // proces faktycznie zareagował na sygnał.
    killed: false,
    kill(sig) { this.killed = true; signals.push(sig); return true; },
    once(event, fn) { (listeners[event] || (listeners[event] = [])).push(fn); },
    emit(event) { for (const fn of listeners[event] || []) fn(); },
  };
}

test('killProcessTree: proces ignorujący SIGTERM dostaje SIGKILL po karencji', (t) => {
  if (process.platform === 'win32') return; // ścieżka taskkill, bez sygnałów
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const proc = fakeProc();

  executor.killProcessTree(proc);
  assert.deepEqual(proc.signals, ['SIGTERM'], 'najpierw grzeczna prośba');

  // Jawny jitter: tick DOKŁADNIE równy progowi to wartość na realnym event loopie
  // nieosiągalna, więc test przechodziłby też przy złamanym warunku (learned pattern
  // 2026-07-30). Najpierw tuż PRZED progiem — SIGKILL nie ma prawa jeszcze polecieć.
  t.mock.timers.tick(KILL_ESCALATION_MS - 1);
  assert.deepEqual(proc.signals, ['SIGTERM'], 'przed upływem karencji nie dobijamy');

  t.mock.timers.tick(2);
  assert.deepEqual(proc.signals, ['SIGTERM', 'SIGKILL'], 'po karencji dobicie mimo killed=true');
});

test('killProcessTree: śmierć procesu przed karencją ANULUJE SIGKILL (ochrona przed reużyciem PID)', (t) => {
  if (process.platform === 'win32') return;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const proc = fakeProc();

  executor.killProcessTree(proc);
  proc.emit('exit'); // proces grzecznie zakończył się po SIGTERM

  t.mock.timers.tick(KILL_ESCALATION_MS + 2);
  assert.deepEqual(proc.signals, ['SIGTERM'], 'martwemu procesowi nie wysyłamy SIGKILL — PID może być już cudzy');
});

test('killProcessTree: martwy proces (kill rzuca ESRCH) nie wywraca eskalacji', (t) => {
  if (process.platform === 'win32') return;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const proc = {
    pid: 4243,
    killed: false,
    kill() { const e = new Error('kill ESRCH'); e.code = 'ESRCH'; throw e; },
    once() {},
  };

  assert.doesNotThrow(() => executor.killProcessTree(proc), 'SIGTERM na martwym procesie');
  assert.doesNotThrow(() => t.mock.timers.tick(KILL_ESCALATION_MS - 1), 'przed progiem cisza');
  assert.doesNotThrow(() => t.mock.timers.tick(2), 'SIGKILL na martwym procesie');
});

test('killProcessTree: błąd INNY niż ESRCH trafia do logu (zero pustego catch)', (t) => {
  if (process.platform === 'win32') return;
  const warnings = [];
  t.mock.method(console, 'warn', (msg) => warnings.push(String(msg)));
  const proc = {
    pid: 4244,
    kill() { const e = new Error('operation not permitted'); e.code = 'EPERM'; throw e; },
    once() {},
  };

  executor.killProcessTree(proc);

  assert.equal(warnings.length, 1, 'EPERM nie może zniknąć po cichu');
  assert.match(warnings[0], /SIGTERM.*4244/);
});
