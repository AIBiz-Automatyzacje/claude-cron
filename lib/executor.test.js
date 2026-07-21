const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { isFinalFailure, readOauthToken } = require('./executor');

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
