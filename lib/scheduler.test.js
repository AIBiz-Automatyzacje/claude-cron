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
