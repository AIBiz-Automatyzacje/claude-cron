const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// Izolacja bazy w warstwie testu (DI), bez dotykania config.js — tak jak db.test.js.
// scheduler.scheduleJob/getNextRun nie wołają db, ale moduł requiruje db przy ładowaniu,
// więc ustawiamy in-memory by nie tknąć realnego pliku.
const db = require('./db');

before(() => {
  db.setDbPath(':memory:');
  db.getDb();
});

after(() => {
  db.close();
});

const scheduler = require('./scheduler');

// Sprzątanie zaplanowanych jobów między testami (activeJobs to globalny stan modułu).
const SCHEDULED_IDS = [1, 2, 3, 4, 5, 6];
afterEach(() => {
  for (const id of SCHEDULED_IDS) {
    scheduler.unscheduleJob(id);
  }
});

function scheduledJob(id, cronExpr) {
  return { id, name: `job-${id}`, enabled: 1, cron_expr: cronExpr };
}

test('getNextRun jest wyeksportowany', () => {
  assert.equal(typeof scheduler.getNextRun, 'function');
});

// 5 wzorców odpowiadających wyjściu buildCronFromForm (public/app.js):
// daily, weekdays, weekly, hours, minutes. Asercje na LOKALNYCH polach Date
// (getHours/getMinutes), bo croner planuje w lokalnej strefie — niezależne od CI TZ.
test('daily "30 9 * * *" → następny run o 09:30 lokalnie', () => {
  // Arrange
  scheduler.scheduleJob(scheduledJob(1, '30 9 * * *'));

  // Act
  const next = scheduler.getNextRun(1);

  // Assert
  assert.ok(next, 'powinien zwrócić ISO timestamp');
  const d = new Date(next);
  assert.equal(d.getHours(), 9);
  assert.equal(d.getMinutes(), 30);
});

test('weekdays "0 8 * * 1-5" → następny run w dzień roboczy (pon-pt) o 08:00', () => {
  // Arrange
  scheduler.scheduleJob(scheduledJob(2, '0 8 * * 1-5'));

  // Act
  const next = scheduler.getNextRun(2);

  // Assert
  assert.ok(next, 'powinien zwrócić ISO timestamp');
  const d = new Date(next);
  assert.equal(d.getHours(), 8);
  assert.equal(d.getMinutes(), 0);
  const dow = d.getDay();
  assert.ok(dow >= 1 && dow <= 5, `dzień tygodnia ${dow} musi być 1-5 (pon-pt)`);
});

test('weekly "15 7 * * 3" → następny run w środę o 07:15', () => {
  // Arrange — day=3 (środa)
  scheduler.scheduleJob(scheduledJob(3, '15 7 * * 3'));

  // Act
  const next = scheduler.getNextRun(3);

  // Assert
  assert.ok(next, 'powinien zwrócić ISO timestamp');
  const d = new Date(next);
  assert.equal(d.getHours(), 7);
  assert.equal(d.getMinutes(), 15);
  assert.equal(d.getDay(), 3);
});

test('hours "0 */6 * * *" → następny run o pełnej minucie, godzina podzielna przez 6', () => {
  // Arrange — co 6h
  scheduler.scheduleJob(scheduledJob(4, '0 */6 * * *'));

  // Act
  const next = scheduler.getNextRun(4);

  // Assert
  assert.ok(next, 'powinien zwrócić ISO timestamp');
  const d = new Date(next);
  assert.equal(d.getMinutes(), 0);
  assert.equal(d.getHours() % 6, 0);
});

test('minutes "*/5 * * * *" → następny run w ciągu 5 minut, minuta podzielna przez 5', () => {
  // Arrange — co 5 min
  scheduler.scheduleJob(scheduledJob(5, '*/5 * * * *'));

  // Act
  const next = scheduler.getNextRun(5);

  // Assert
  assert.ok(next, 'powinien zwrócić ISO timestamp');
  const d = new Date(next);
  assert.equal(d.getMinutes() % 5, 0);
  const deltaMs = d.getTime() - Date.now();
  assert.ok(deltaMs > 0 && deltaMs <= 5 * 60 * 1000, 'następny run w oknie do 5 minut');
});

test('zły cron → kontrolowany null (scheduleJob nie planuje, brak cichego crashu)', () => {
  // Arrange — niepoprawny wzorzec; scheduleJob łapie błąd croner i NIE dodaje do activeJobs
  scheduler.scheduleJob(scheduledJob(6, 'garbage cron'));

  // Act
  const next = scheduler.getNextRun(6);

  // Assert — null, nie rzucony wyjątek
  assert.equal(next, null);
});

// === computeMissedJobs (pure, Unit 2 / R3) ===

// Strefa stała w testach, by były deterministyczne niezależnie od TZ maszyny CI.
const TZ = 'Europe/Warsaw';

// Helper: godzina ścienna w Europe/Warsaw (CEST, UTC+2 w czerwcu) jako Date UTC.
// 6:00 lokalnie = 04:00 UTC.
function warsawDate(year, month, day, hour, minute) {
  return new Date(Date.UTC(year, month - 1, day, hour - 2, minute));
}

function missedJob(overrides) {
  return { id: 1, name: 'job', cron_expr: '0 6 * * *', enabled: 1, run_on_wake: 1, ...overrides };
}

test('computeMissedJobs: 0 6 * * *, lastActive 5:59, now 6:03 → przegapiony [1] (happy path R3)', () => {
  // Arrange
  const lastActive = warsawDate(2026, 6, 27, 5, 59);
  const now = warsawDate(2026, 6, 27, 6, 3);

  // Act
  const result = scheduler.computeMissedJobs([missedJob()], lastActive, now, TZ);

  // Assert
  assert.deepEqual(result, [1]);
});

test('computeMissedJobs: job strzelił przed downtime (lastActive 6:30, now 6:35) → [] (brak podwójnego odpalenia)', () => {
  // Arrange
  const lastActive = warsawDate(2026, 6, 27, 6, 30);
  const now = warsawDate(2026, 6, 27, 6, 35);

  // Act
  const result = scheduler.computeMissedJobs([missedJob()], lastActive, now, TZ);

  // Assert
  assert.deepEqual(result, []);
});

test('computeMissedJobs: */5 * * * *, 30 min downtime → id raz (collapse N cykli)', () => {
  // Arrange
  const lastActive = warsawDate(2026, 6, 27, 12, 0);
  const now = warsawDate(2026, 6, 27, 12, 30);
  const job = missedJob({ cron_expr: '*/5 * * * *' });

  // Act
  const result = scheduler.computeMissedJobs([job], lastActive, now, TZ);

  // Assert
  assert.deepEqual(result, [1], 'mimo ~6 przegapionych cykli id pojawia się dokładnie raz');
});

test('computeMissedJobs: run_on_wake=0 → pominięty []', () => {
  // Arrange
  const lastActive = warsawDate(2026, 6, 27, 5, 59);
  const now = warsawDate(2026, 6, 27, 6, 3);
  const job = missedJob({ run_on_wake: 0 });

  // Act
  const result = scheduler.computeMissedJobs([job], lastActive, now, TZ);

  // Assert
  assert.deepEqual(result, []);
});

test('computeMissedJobs: enabled=0 → pominięty []', () => {
  // Arrange
  const lastActive = warsawDate(2026, 6, 27, 5, 59);
  const now = warsawDate(2026, 6, 27, 6, 3);
  const job = missedJob({ enabled: 0 });

  // Act
  const result = scheduler.computeMissedJobs([job], lastActive, now, TZ);

  // Assert
  assert.deepEqual(result, []);
});

test("computeMissedJobs: zły cron 'garbage' → pominięty bez wyjątku []", () => {
  // Arrange
  const lastActive = warsawDate(2026, 6, 27, 5, 59);
  const now = warsawDate(2026, 6, 27, 6, 3);
  const job = missedJob({ cron_expr: 'garbage' });

  // Act
  let result;
  assert.doesNotThrow(() => {
    result = scheduler.computeMissedJobs([job], lastActive, now, TZ);
  });

  // Assert
  assert.deepEqual(result, []);
});

test('computeMissedJobs: mieszany batch wielu jobów → tylko przegapione id (główna ścieżka getAllJobs)', () => {
  // Arrange — realny caller (detectMissedJobs) podaje całą listę z getAllJobs() naraz.
  // lastActive 5:59, now 6:03 → przegapione są joby strzelające 6:00; reszta odfiltrowana.
  const lastActive = warsawDate(2026, 6, 27, 5, 59);
  const now = warsawDate(2026, 6, 27, 6, 3);
  const jobs = [
    missedJob({ id: 1 }),                                 // 6:00, przegapiony → 1
    missedJob({ id: 2, run_on_wake: 0 }),                 // 6:00 ale run_on_wake=0 → pominięty
    missedJob({ id: 3, cron_expr: '0 9 * * *' }),         // 9:00, jeszcze nie strzelił → pominięty
    missedJob({ id: 4, enabled: 0 }),                     // 6:00 ale wyłączony → pominięty
    missedJob({ id: 5, cron_expr: '0 6 * * *' }),         // 6:00, przegapiony → 5
  ];

  // Act
  const result = scheduler.computeMissedJobs(jobs, lastActive, now, TZ);

  // Assert — filtrowanie mieszanej listy + zwrócenie WIELU id naraz, w kolejności wejścia
  assert.deepEqual(result, [1, 5]);
});

test('computeMissedJobs: ten sam lastActive/now, dwie strefy → różny wynik (strefa faktycznie używana, regresja R3)', () => {
  // Arrange — cron 0 6 * * * = "6:00 lokalnie". lastActive = 02:59 UTC.
  // Warsaw (CEST, UTC+2): 02:59 UTC = 04:59 lokalnie → najbliższe 06:00 lokalne = 04:00 UTC.
  // Reykjavik (UTC+0):    02:59 UTC = 02:59 lokalnie → najbliższe 06:00 lokalne = 06:00 UTC.
  // now = 05:00 UTC leży MIĘDZY tymi granicami: dla Warszawy job już minął (przegapiony),
  // dla Reykjaviku jeszcze nie nadszedł.
  const lastActive = new Date(Date.UTC(2026, 5, 27, 2, 59));
  const now = new Date(Date.UTC(2026, 5, 27, 5, 0));
  const job = missedJob();

  // Act
  const warsaw = scheduler.computeMissedJobs([job], lastActive, now, 'Europe/Warsaw');
  const reykjavik = scheduler.computeMissedJobs([job], lastActive, now, 'Atlantic/Reykjavik');

  // Assert
  assert.deepEqual(warsaw, [1], 'w Warszawie nextRun = 04:00 UTC < now 05:00 UTC → przegapione');
  assert.deepEqual(reykjavik, [], 'w Reykjaviku nextRun = 06:00 UTC > now 05:00 UTC → jeszcze nie strzelił');
  assert.notDeepEqual(warsaw, reykjavik, 'strefa MUSI zmieniać wynik detekcji');
});

// === processQueue: retry + R9 (integracja scheduler↔executor↔db na :memory:, P1 z review fazy 2) ===
// Mock WYŁĄCZNIE kanału (granica sieci); executor odpala realny `node <skrypt>` (job_type script).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const telegram = require('./telegram');

function failingScript(t, label) {
  const scriptPath = path.join(os.tmpdir(), `puls-${label}-${process.pid}.js`);
  fs.writeFileSync(scriptPath, 'process.exit(1);');
  t.after(() => fs.rmSync(scriptPath, { force: true }));
  return scriptPath;
}

test('processQueue: fail → retry → ostateczny fail wysyła ❌ dokładnie raz (R9, max_retries=1)', async (t) => {
  // Arrange — skrypt zawsze pada; przed fixem retry było martwe (warunek czytał in-memory
  // run.status==='queued' sprzed executeRun) i user nie dostawał NIC
  const failCalls = [];
  t.mock.method(telegram, 'sendFailureNotification', async (...a) => { failCalls.push(a); });
  const job = db.createJob({
    name: 'retry-r9-job', job_type: 'script', command: failingScript(t, 'retry-r9'),
    max_retries: 1, telegram_notify: 1,
  });
  db.createRun({ job_id: job.id, trigger_type: 'manual' });

  // Act — jedna pętla processQueue konsumuje oryginał ORAZ dokolejkowany retry
  await scheduler.processQueue();

  // Assert — status po runie czytany świeżo z DB: retry POWSTAJE, ❌ dopiero po failu retry
  const runs = db.getRuns({ job_id: job.id, limit: 10 });
  assert.equal(runs.length, 2, 'oryginał + dokładnie jeden retry');
  assert.ok(runs.every((r) => r.status === 'failed'), 'oba runy failed');
  assert.equal(runs.filter((r) => r.trigger_type === 'retry').length, 1, 'retry z trigger_type=retry');
  assert.equal(failCalls.length, 1, '❌ dokładnie raz — po OSTATECZNYM failu, nie po pierwszym');
  assert.equal(failCalls[0][1].status, 'failed');
});

test('processQueue: max_retries=0 → fail od razu ostateczny: ❌ raz, zero retry', async (t) => {
  // Arrange
  const failCalls = [];
  t.mock.method(telegram, 'sendFailureNotification', async (...a) => { failCalls.push(a); });
  const job = db.createJob({
    name: 'no-retry-job', job_type: 'script', command: failingScript(t, 'no-retry'),
    max_retries: 0, telegram_notify: 1,
  });
  db.createRun({ job_id: job.id, trigger_type: 'manual' });

  // Act
  await scheduler.processQueue();

  // Assert
  const runs = db.getRuns({ job_id: job.id, limit: 10 });
  assert.equal(runs.length, 1, 'bez retry przy max_retries=0');
  assert.equal(runs[0].status, 'failed');
  assert.equal(failCalls.length, 1, '❌ natychmiast — fail bez retry jest ostateczny');
});
