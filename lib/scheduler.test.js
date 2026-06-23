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
