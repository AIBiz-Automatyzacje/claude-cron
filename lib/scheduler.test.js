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
const executor = require('./executor');

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

// === classifyJob (pure, R3 — podział krótkie/długie z POMIARU, nie z job_type) ===

test('classifyJob: mediana odporna na odstającą wartość — [0,2s, 0,2s, 0,3s, 975s] → short', () => {
  // Arrange — profil inbox synca: typowo 0,2 s, ale jeden run przespał 975 s (sen maszyny).
  // Średnia dałaby ~244 s i wrzuciłaby najlżejszy job systemu do długich.
  const durations = [200, 200, 300, 975_000];

  // Act
  const kind = scheduler.classifyJob(durations, 60_000);

  // Assert
  assert.equal(kind, 'short');
});

test('classifyJob: pusta historia → long (fail-safe)', () => {
  // Arrange/Act — nowy job bez ani jednego udanego runu
  const kind = scheduler.classifyJob([], 60_000);

  // Assert — pomyłka „krótki, a jest 12-minutowy" zjadłaby slot rezerwowy i złamała R1
  assert.equal(kind, 'long');
});

test('classifyJob: wartość dokładnie na progu → long (granica domknięta w dół)', () => {
  // Arrange — mediana == threshold
  const durations = [60_000, 60_000, 60_000];

  // Act
  const kind = scheduler.classifyJob(durations, 60_000);

  // Assert
  assert.equal(kind, 'long');
});

test('classifyJob: mediana poniżej progu przy jednym długim runie → short', () => {
  // Arrange — 3 próbki: 1 s, 2 s, 700 s → mediana 2 s
  const kind = scheduler.classifyJob([1_000, 2_000, 700_000], 60_000);

  // Assert
  assert.equal(kind, 'short');
});

// === pickEligibleRuns (pure, R1/R2/R4/R5) ===

function pickJob(id, overrides = {}) {
  return { id, name: `job-${id}`, skill_name: '', command: null, lock_group: null, ...overrides };
}

function pickRun(id, jobId) {
  return { id, job_id: jobId };
}

function jobsIndex(jobs) {
  const index = {};
  for (const job of jobs) index[job.id] = job;
  return index;
}

const SHORT_HISTORY = [1_000, 1_000, 1_000];
const LONG_HISTORY = [300_000, 300_000, 300_000];

test('pickEligibleRuns: maxConcurrent=3 + dwa aktywne długie → trzeci długi czeka, krótki startuje (R1/R2)', () => {
  // Arrange — dwa sloty zajęte przez długie; trzeci to REZERWA dla krótkich
  const jobs = [pickJob(1), pickJob(2), pickJob(3), pickJob(4)];
  const picked = scheduler.pickEligibleRuns({
    queued: [pickRun(10, 3), pickRun(11, 4)],
    jobsById: jobsIndex(jobs),
    activeRuns: [{ runId: 1, jobId: 1 }, { runId: 2, jobId: 2 }],
    durationsByJob: { 1: LONG_HISTORY, 2: LONG_HISTORY, 3: LONG_HISTORY, 4: SHORT_HISTORY },
    maxConcurrent: 3,
    fastThresholdMs: 60_000,
  });

  // Assert — wyłącznie krótki run #11; długi #10 nie dostaje ostatniego slotu
  assert.deepEqual(picked.map((r) => r.id), [11]);
});

test('pickEligibleRuns: krótki też respektuje globalny limit (3 aktywne → nikt nie startuje)', () => {
  // Arrange — limit wyczerpany globalnie, rezerwa nie tworzy czwartego slotu
  const jobs = [pickJob(1), pickJob(2), pickJob(3), pickJob(4)];
  const picked = scheduler.pickEligibleRuns({
    queued: [pickRun(10, 4)],
    jobsById: jobsIndex(jobs),
    activeRuns: [{ runId: 1, jobId: 1 }, { runId: 2, jobId: 2 }, { runId: 3, jobId: 3 }],
    durationsByJob: { 1: SHORT_HISTORY, 2: SHORT_HISTORY, 3: SHORT_HISTORY, 4: SHORT_HISTORY },
    maxConcurrent: 3,
  });

  // Assert
  assert.deepEqual(picked, []);
});

test('pickEligibleRuns: nigdy dwa runy tego samego job_id (R4)', () => {
  // Arrange — job 1 już biegnie, a w kolejce stoi jego kolejny run; job 2 jest wolny
  const jobs = [pickJob(1), pickJob(2)];
  const picked = scheduler.pickEligibleRuns({
    queued: [pickRun(10, 1), pickRun(11, 2)],
    jobsById: jobsIndex(jobs),
    activeRuns: [{ runId: 1, jobId: 1 }],
    durationsByJob: { 1: SHORT_HISTORY, 2: SHORT_HISTORY },
    maxConcurrent: 3,
  });

  // Assert
  assert.deepEqual(picked.map((r) => r.id), [11]);
});

test('pickEligibleRuns: dwa runy tego samego joba w kolejce → startuje tylko pierwszy (R4)', () => {
  // Arrange — nic nie biegnie, ale oba runy należą do joba 1
  const picked = scheduler.pickEligibleRuns({
    queued: [pickRun(10, 1), pickRun(11, 1)],
    jobsById: jobsIndex([pickJob(1)]),
    activeRuns: [],
    durationsByJob: { 1: SHORT_HISTORY },
    maxConcurrent: 3,
  });

  // Assert
  assert.deepEqual(picked.map((r) => r.id), [10]);
});

test('pickEligibleRuns: ten sam skill_name rozłącza joby bez deklaracji (R5)', () => {
  // Arrange — "Daily memory update" i "Weekly memory update" dzielą skill memory-update
  const jobs = [pickJob(1, { skill_name: 'memory-update' }), pickJob(2, { skill_name: 'memory-update' }), pickJob(3, { skill_name: '' })];
  const picked = scheduler.pickEligibleRuns({
    queued: [pickRun(10, 2), pickRun(11, 3)],
    jobsById: jobsIndex(jobs),
    activeRuns: [{ runId: 1, jobId: 1 }],
    durationsByJob: { 1: SHORT_HISTORY, 2: SHORT_HISTORY, 3: SHORT_HISTORY },
    maxConcurrent: 3,
  });

  // Assert — job 2 zablokowany skillem, job 3 (pusty skill) leci
  assert.deepEqual(picked.map((r) => r.id), [11]);
});

test('pickEligibleRuns: ten sam command rozłącza script-joby (R5)', () => {
  // Arrange
  const jobs = [
    pickJob(1, { job_type: 'script', command: 'scripts/inbox/inbox-sync.mjs' }),
    pickJob(2, { job_type: 'script', command: 'scripts/inbox/inbox-sync.mjs' }),
  ];
  const picked = scheduler.pickEligibleRuns({
    queued: [pickRun(10, 2)],
    jobsById: jobsIndex(jobs),
    activeRuns: [{ runId: 1, jobId: 1 }],
    durationsByJob: { 1: SHORT_HISTORY, 2: SHORT_HISTORY },
    maxConcurrent: 3,
  });

  // Assert
  assert.deepEqual(picked, []);
});

test('pickEligibleRuns: pusty skill_name/command NIE jest kluczem wyłączności', () => {
  // Arrange — dwa różne script-joby bez skilla; brak wartości nie może ich rozłączać
  const jobs = [pickJob(1, { skill_name: '', command: 'a.mjs' }), pickJob(2, { skill_name: '', command: 'b.mjs' })];
  const picked = scheduler.pickEligibleRuns({
    queued: [pickRun(10, 2)],
    jobsById: jobsIndex(jobs),
    activeRuns: [{ runId: 1, jobId: 1 }],
    durationsByJob: { 1: SHORT_HISTORY, 2: SHORT_HISTORY },
    maxConcurrent: 3,
  });

  // Assert
  assert.deepEqual(picked.map((r) => r.id), [10]);
});

test('pickEligibleRuns: lock_group rozłącza joby deklaratywnie, kolejność id ASC (R5)', () => {
  // Arrange — dwa joby w grupie 'dashboard', nic nie biegnie; wejście CELOWO nieposortowane
  const jobs = [pickJob(1, { lock_group: 'dashboard' }), pickJob(2, { lock_group: 'dashboard' })];
  const args = {
    jobsById: jobsIndex(jobs),
    activeRuns: [],
    durationsByJob: { 1: SHORT_HISTORY, 2: SHORT_HISTORY },
    maxConcurrent: 3,
  };

  // Act — pierwszy przebieg: startuje tylko run o NIŻSZYM id (FIFO)
  const first = scheduler.pickEligibleRuns({ ...args, queued: [pickRun(11, 2), pickRun(10, 1)] });
  // ...a po zakończeniu pierwszego (kolejka bez #10, nic aktywnego) rusza drugi
  const second = scheduler.pickEligibleRuns({ ...args, queued: [pickRun(11, 2)] });

  // Assert
  assert.deepEqual(first.map((r) => r.id), [10]);
  assert.deepEqual(second.map((r) => r.id), [11]);
});

test('pickEligibleRuns: maxConcurrent=1 → rezerwa nie odbiera jedynego slotu (min 1 długi)', () => {
  // Arrange — przy limicie 1 nie ma z czego robić rezerwy; długi job musi móc wystartować
  const picked = scheduler.pickEligibleRuns({
    queued: [pickRun(10, 1)],
    jobsById: jobsIndex([pickJob(1)]),
    activeRuns: [],
    durationsByJob: { 1: LONG_HISTORY },
    maxConcurrent: 1,
  });

  // Assert
  assert.deepEqual(picked.map((r) => r.id), [10]);
});

// === resolveMaxConcurrent / readMaxConcurrent (konfiguracja czytana w czasie picku) ===

test('resolveMaxConcurrent: sanityzacja — śmieci, 0 i wartości ujemne → default 3', () => {
  assert.equal(scheduler.resolveMaxConcurrent(null), 3);
  assert.equal(scheduler.resolveMaxConcurrent(''), 3);
  assert.equal(scheduler.resolveMaxConcurrent('abc'), 3);
  assert.equal(scheduler.resolveMaxConcurrent('0'), 3);
  assert.equal(scheduler.resolveMaxConcurrent('-2'), 3);
  assert.equal(scheduler.resolveMaxConcurrent('5'), 5);
  assert.equal(scheduler.resolveMaxConcurrent(2), 2);
});

test('readMaxConcurrent: zmiana w state działa BEZ restartu procesu', (t) => {
  // Arrange — sprzątanie stanu współdzielonego z innymi testami
  t.after(() => db.setState('max_concurrent', ''));

  // Act/Assert — brak klucza → default, po zapisie → nowa wartość przy KOLEJNYM odczycie
  db.setState('max_concurrent', '');
  assert.equal(scheduler.readMaxConcurrent(), 3);
  db.setState('max_concurrent', '5');
  assert.equal(scheduler.readMaxConcurrent(), 5);
});

// === sanitizeMaxConcurrent (walidacja wejścia z API — PUT /api/settings/concurrency) ===

test('sanitizeMaxConcurrent: przyjmuje 1 i 5 (także jako string z <input>)', () => {
  assert.deepEqual(scheduler.sanitizeMaxConcurrent(1), { ok: true, value: 1 });
  assert.deepEqual(scheduler.sanitizeMaxConcurrent(5), { ok: true, value: 5 });
  assert.deepEqual(scheduler.sanitizeMaxConcurrent('5'), { ok: true, value: 5 });
  assert.deepEqual(scheduler.sanitizeMaxConcurrent(' 3 '), { ok: true, value: 3 });
});

test('sanitizeMaxConcurrent: 0, wartość ujemna i tekst → odrzucone z komunikatem', () => {
  // Kontrast z resolveMaxConcurrent (ciche zejście do 3): wejście z API musi FAILOWAĆ,
  // inaczej user wpisujący „pięć" dostałby 200 i cichą podmianę wartości.
  for (const bad of [0, -2, 'pięć', '5x', '', null, undefined, true, 2.5, {}]) {
    const result = scheduler.sanitizeMaxConcurrent(bad);
    assert.equal(result.ok, false, `${JSON.stringify(bad)} powinno zostać odrzucone`);
    assert.ok(result.error.length > 0, 'odrzucenie musi mieć komunikat dla usera');
  }
});

test('sanitizeMaxConcurrent: wartość powyżej sufitu odrzucona, sufit jeszcze przechodzi', () => {
  const ceiling = scheduler.MAX_CONCURRENT_CEILING;
  assert.deepEqual(scheduler.sanitizeMaxConcurrent(ceiling), { ok: true, value: ceiling });
  assert.equal(scheduler.sanitizeMaxConcurrent(ceiling + 1).ok, false);
});

// === Pętla drain: dzwonek, limit ze state, retry przy równoległości (integracja) ===

function scriptFile(t, label, body) {
  const scriptPath = path.join(os.tmpdir(), `puls-${label}-${process.pid}.js`);
  fs.writeFileSync(scriptPath, body);
  t.after(() => fs.rmSync(scriptPath, { force: true }));
  return scriptPath;
}

async function waitUntil(predicate, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitUntil: ${label} nie nastąpiło w ${timeoutMs} ms`);
}

test('R1: krótki run dokolejkowany W TRAKCIE długiego kończy się PRZED nim (dzwonek)', async (t) => {
  // Arrange — long biegnie 1,5 s; short jest kolejkowany DOPIERO po jego starcie.
  // Wersja z obydwoma runami w kolejce od początku przechodzi też na zepsutej pętli.
  const longJob = db.createJob({
    name: 'r1-long', job_type: 'script', command: scriptFile(t, 'r1-long', 'setTimeout(() => {}, 1500);'), max_retries: 0,
  });
  const shortJob = db.createJob({
    name: 'r1-short', job_type: 'script', command: scriptFile(t, 'r1-short', 'process.exit(0);'), max_retries: 0,
  });
  const longRun = db.createRun({ job_id: longJob.id, trigger_type: 'manual' });

  // Act — pętla startuje długi, po jego starcie dokolejkowujemy krótki
  const drain = scheduler.processQueue();
  await waitUntil(() => db.getRunWithPayload(longRun.id).status === 'running', 'start długiego runu');
  const shortRun = scheduler.enqueueJob(shortJob.id, 'manual');
  await drain;

  // Assert
  const finishedLong = db.getRunWithPayload(longRun.id);
  const finishedShort = db.getRunWithPayload(shortRun.id);
  assert.equal(finishedLong.status, 'success');
  assert.equal(finishedShort.status, 'success');
  assert.ok(
    Date.parse(finishedShort.started_at) < Date.parse(finishedLong.finished_at),
    'krótki wystartował, gdy długi jeszcze biegł (nie czekał na slot)'
  );
  assert.ok(
    Date.parse(finishedShort.finished_at) < Date.parse(finishedLong.finished_at),
    'krótki skończył PRZED długim'
  );
});

test('max_concurrent=1 ze state → runy nie zachodzą na siebie (limit czytany przy picku)', async (t) => {
  // Arrange — limit ustawiony PO załadowaniu modułu; wartość nie może być zamrożona przy require
  db.setState('max_concurrent', '1');
  t.after(() => db.setState('max_concurrent', ''));
  const jobA = db.createJob({ name: 'limit-a', job_type: 'script', command: scriptFile(t, 'limit-a', 'setTimeout(() => {}, 300);'), max_retries: 0 });
  const jobB = db.createJob({ name: 'limit-b', job_type: 'script', command: scriptFile(t, 'limit-b', 'setTimeout(() => {}, 300);'), max_retries: 0 });
  const runA = db.createRun({ job_id: jobA.id, trigger_type: 'manual' });
  const runB = db.createRun({ job_id: jobB.id, trigger_type: 'manual' });

  // Act
  await scheduler.processQueue();

  // Assert — B rusza dopiero po zakończeniu A
  const a = db.getRunWithPayload(runA.id);
  const b = db.getRunWithPayload(runB.id);
  assert.equal(a.status, 'success');
  assert.equal(b.status, 'success');
  assert.ok(Date.parse(b.started_at) >= Date.parse(a.finished_at), 'przy limicie 1 runy nie mogą się nakładać');
});

test('retry (R9) powstaje także wtedy, gdy obok biegnie inny run (szew scheduler↔executor)', async (t) => {
  // Arrange — job padający z max_retries=1 startuje RÓWNOLEGLE z dłuższym jobem;
  // retry-check musi działać per run, nie „po ostatnim runie pętli"
  const failJob = db.createJob({
    name: 'par-retry-fail', job_type: 'script', command: scriptFile(t, 'par-retry-fail', 'process.exit(1);'), max_retries: 1,
  });
  const busyJob = db.createJob({
    name: 'par-retry-busy', job_type: 'script', command: scriptFile(t, 'par-retry-busy', 'setTimeout(() => {}, 700);'), max_retries: 0,
  });
  db.createRun({ job_id: failJob.id, trigger_type: 'manual' });
  db.createRun({ job_id: busyJob.id, trigger_type: 'manual' });

  // Act
  await scheduler.processQueue();

  // Assert — oryginał + dokładnie jeden retry, oba failed; drugi job dojechał do końca
  const failRuns = db.getRuns({ job_id: failJob.id, limit: 10 });
  assert.equal(failRuns.length, 2, 'oryginał + dokładnie jeden retry');
  assert.equal(failRuns.filter((r) => r.trigger_type === 'retry').length, 1);
  assert.ok(failRuns.every((r) => r.status === 'failed'));
  const busyRuns = db.getRuns({ job_id: busyJob.id, limit: 10 });
  assert.equal(busyRuns[0].status, 'success', 'równoległy run nie ucierpiał na retry sąsiada');
});

test('processQueue: kolejka wielu jobów drenuje się do końca (rozwiązuje się po domknięciu runów)', async (t) => {
  // Arrange — trzy niezależne krótkie joby naraz
  const jobs = [1, 2, 3].map((n) => db.createJob({
    name: `drain-${n}`, job_type: 'script', command: scriptFile(t, `drain-${n}`, 'process.exit(0);'), max_retries: 0,
  }));
  const runs = jobs.map((job) => db.createRun({ job_id: job.id, trigger_type: 'manual' }));

  // Act
  await scheduler.processQueue();

  // Assert — po rozwiązaniu promise'a nie ma ani jednego runu w kolejce ani w locie
  for (const run of runs) {
    assert.equal(db.getRunWithPayload(run.id).status, 'success');
  }
  assert.equal(db.getQueuedRuns().length, 0);
});

// === Odbiór P2 review fazy 1 ===

test('pickEligibleRuns: job w finalizacji nie zajmuje slotu, ale blokuje kolejny run TEGO joba', () => {
  // Arrange — proces joba 1 już zdechł (executor zwolnił wpis na 'exit'), ale run nie jest
  // rozliczony. Slot MUSI być wolny (inaczej ciche obniżenie limitu), a job 1 zablokowany.
  const jobs = [pickJob(1), pickJob(2)];
  const args = {
    jobsById: jobsIndex(jobs),
    activeRuns: [],
    finalizingJobIds: [1],
    durationsByJob: { 1: LONG_HISTORY, 2: LONG_HISTORY },
    maxConcurrent: 1,
  };

  // Act
  const sameJob = scheduler.pickEligibleRuns({ ...args, queued: [pickRun(10, 1)] });
  const otherJob = scheduler.pickEligibleRuns({ ...args, queued: [pickRun(11, 2)] });

  // Assert
  assert.deepEqual(sameJob, [], 'kolejny run joba w finalizacji czeka na retry-check');
  assert.deepEqual(otherJob.map((r) => r.id), [11], 'slot po zdechłym procesie jest wolny dla innego joba');
});

test('executeRun rzuca → run kończy jako failed, processQueue rozwiązuje się, run pickowany RAZ', async (t) => {
  // Arrange — wyjątek z executora (np. SQLITE_BUSY na db.updateRun) zostawiał run 'queued',
  // więc picker brał go w kółko: pętla drain nie oddawała kontroli do fazy timerów
  // (zamrożony heartbeat, cron i HTTP), zamiast zgłosić jeden padnięty run.
  const job = db.createJob({
    name: 'crash-executor', job_type: 'script', command: scriptFile(t, 'crash-executor', 'process.exit(0);'), max_retries: 0,
  });
  const run = db.createRun({ job_id: job.id, trigger_type: 'manual' });
  let calls = 0;
  t.mock.method(executor, 'executeRun', () => {
    calls++;
    return Promise.reject(new Error('boom'));
  });

  // Act
  await scheduler.processQueue();

  // Assert
  assert.equal(calls, 1, 'run nie może być pickowany ponownie po padzie');
  const finished = db.getRunWithPayload(run.id);
  assert.equal(finished.status, 'failed', 'run musi opuścić kolejkę');
  assert.match(finished.error_msg, /boom/);
  assert.equal(db.getQueuedRuns().length, 0);
});

test('slot zwalnia się na zdechłym procesie, nie na close (wnuk trzyma stdio)', async (t) => {
  // Arrange — limit 1. Job A kończy się natychmiast, ale zostawia wnuka dziedziczącego
  // stdio: 'close' przyjdzie dopiero po jego śmierci (~6 s). Executor zwalnia wpis na
  // 'exit' + karencja, więc job B musi ruszyć DUŻO wcześniej niż finalizacja A.
  db.setState('max_concurrent', '1');
  t.after(() => db.setState('max_concurrent', ''));
  // detached + unref: rodzic ma ZAKOŃCZYĆ się od razu (inaczej trzyma event loop przy
  // żywym dziecku), a wnuk ma dalej dziedziczyć jego stdio — to trzyma pipe i wstrzymuje 'close'.
  const grandchild = "const { spawn } = require('node:child_process');"
    + "const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 6000)'], { stdio: 'inherit', detached: true });"
    + 'c.unref();';
  const jobA = db.createJob({
    name: 'release-a', job_type: 'script', command: scriptFile(t, 'release-a', grandchild), max_retries: 0,
  });
  const jobB = db.createJob({
    name: 'release-b', job_type: 'script', command: scriptFile(t, 'release-b', 'process.exit(0);'), max_retries: 0,
  });
  const runA = db.createRun({ job_id: jobA.id, trigger_type: 'manual' });
  const runB = db.createRun({ job_id: jobB.id, trigger_type: 'manual' });

  // Act — czekamy tylko na start B; pełny drain domknie się dopiero po śmierci wnuka
  const drain = scheduler.processQueue();
  const t0 = Date.now();
  await waitUntil(() => (db.getRunWithPayload(runB.id).started_at || '') !== '', 'start runu B', 5_000);
  const waitedMs = Date.now() - t0;
  await drain;

  // Assert
  const a = db.getRunWithPayload(runA.id);
  const b = db.getRunWithPayload(runB.id);
  assert.ok(waitedMs < 5_000, `B wystartował po ${waitedMs} ms — slot nie czekał na 'close'`);
  assert.equal(b.status, 'success');
  assert.ok(
    Date.parse(b.started_at) < Date.parse(a.finished_at),
    'B wystartował zanim A został sfinalizowany (na close)'
  );
});

// === Karencja po wybudzeniu (R11, Unit 9) ===

test('shouldDeferAfterWake: true tuż po wybudzeniu, false po upływie karencji, false bez wybudzenia', () => {
  // Arrange — zegar podany argumentem, zero Date.now() w funkcji
  const grace = scheduler.WAKE_GRACE_MS;
  const wakeAt = 1_000_000;

  // Act / Assert
  assert.equal(scheduler.shouldDeferAfterWake(wakeAt, wakeAt + 1_000, grace), true, 'tuż po wybudzeniu odraczamy');
  assert.equal(scheduler.shouldDeferAfterWake(wakeAt, wakeAt + grace, grace), false, 'granica domknięta — karencja minęła');
  assert.equal(scheduler.shouldDeferAfterWake(wakeAt, wakeAt + grace + 5_000, grace), false, 'długo po karencji startujemy');
  assert.equal(scheduler.shouldDeferAfterWake(null, wakeAt, grace), false, 'normalna praca bez wybudzenia NIGDY nie czeka');
});

test('wakeGraceRemainingMs: reszta karencji maleje z czasem, zegar cofnięty → 0 (kolejka nie zamarza)', () => {
  // Arrange
  const grace = 45_000;
  const wakeAt = 500_000;

  // Act / Assert
  assert.equal(scheduler.wakeGraceRemainingMs(wakeAt, wakeAt, grace), grace);
  assert.equal(scheduler.wakeGraceRemainingMs(wakeAt, wakeAt + 30_000, grace), 15_000);
  assert.equal(scheduler.wakeGraceRemainingMs(wakeAt, wakeAt + grace + 1, grace), 0);
  assert.equal(scheduler.wakeGraceRemainingMs(wakeAt, wakeAt - 10_000, grace), 0, 'NTP cofnął zegar — nie blokujemy w nieskończoność');
  assert.equal(scheduler.wakeGraceRemainingMs(null, wakeAt, grace), 0);
});

test('isWakeGap: luka większa od progu snu = wybudzenie; próg wzięty z executora (jedna definicja snu)', () => {
  // Arrange — próg NIE jest lokalną kopią: sen definiuje executor.SLEEP_GAP_MS
  const gapMs = executor.SLEEP_GAP_MS;
  const prev = 2_000_000;

  // Act / Assert
  assert.equal(scheduler.isWakeGap(prev, prev + gapMs + 1), true, 'luka ponad próg = sen maszyny');
  assert.equal(scheduler.isWakeGap(prev, prev + gapMs), false, 'dokładnie próg to jeszcze zadławienie, nie sen');
  assert.equal(scheduler.isWakeGap(prev, prev + 1_000), false, 'normalne tyknięcie heartbeatu');
  assert.equal(scheduler.isWakeGap(null, prev), false, 'brak poprzedniego śladu = brak wnioskowania o śnie');
});

test('karencja: run zakolejkowany po wybudzeniu startuje PO jej upływie — nie ginie i nie jest failed', async (t) => {
  // Arrange — udajemy wybudzenie sprzed (WAKE_GRACE_MS - 400 ms), więc do końca karencji
  // zostało ~400 ms. Używamy PRAWDZIWEJ stałej — test nie zna innego progu niż produkcja.
  const remainingMs = 400;
  scheduler.markWakeDetected(Date.now() - (scheduler.WAKE_GRACE_MS - remainingMs));
  t.after(() => scheduler.markWakeDetected(null));
  const job = db.createJob({
    name: 'wake-grace', job_type: 'script', command: scriptFile(t, 'wake-grace', 'process.exit(0);'), max_retries: 0,
  });
  const run = db.createRun({ job_id: job.id, trigger_type: 'wake' });
  // Timer karencji jest unref'owany (nie może trzymać daemona przy życiu), więc w gołym
  // procesie testowym event loop opustoszałby na czas czekania. W produkcji trzymają go
  // heartbeat i cron — tutaj odtwarzamy to jednym ref'owanym interwałem.
  const keepAlive = setInterval(() => {}, 50);
  t.after(() => clearInterval(keepAlive));

  // Act — pętla startuje; timer karencji ma ją obudzić SAM, bez żadnego enqueueJob w międzyczasie
  const t0 = Date.now();
  const drain = scheduler.processQueue();
  assert.equal(db.getRunWithPayload(run.id).status, 'queued', 'w oknie karencji run jeszcze nie rusza');
  await drain;

  // Assert — run wykonany, nie zgubiony i nie oznaczony jako failed
  const finished = db.getRunWithPayload(run.id);
  assert.equal(finished.status, 'success');
  assert.ok(
    Date.parse(finished.started_at) - t0 >= remainingMs - 50,
    `start po karencji (czekał ${Date.parse(finished.started_at) - t0} ms)`
  );
  assert.equal(db.getQueuedRuns().length, 0, 'kolejka pusta — karencja odracza, nie porzuca');
});

test('bez wybudzenia kolejka nie zwalnia o ani jeden tick — run rusza synchronicznie (regresja R1)', async (t) => {
  // Arrange — brak śladu wybudzenia to stan normalny; ścieżka musi iść bez ani jednego await
  scheduler.markWakeDetected(null);
  const job = db.createJob({
    name: 'no-wake-fast', job_type: 'script', command: scriptFile(t, 'no-wake-fast', 'process.exit(0);'), max_retries: 0,
  });
  const run = db.createRun({ job_id: job.id, trigger_type: 'manual' });

  // Act — świadomie BEZ await: sprawdzamy stan po synchronicznej części processQueue
  const drain = scheduler.processQueue();

  // Assert — status 'running' zapisany zanim pętla oddała kontrolę do event loopu
  assert.equal(db.getRunWithPayload(run.id).status, 'running', 'run wystartował w tym samym ticku');
  await drain;
  assert.equal(db.getRunWithPayload(run.id).status, 'success');
});

test('start(): downtime dłuższy od progu snu włącza karencję ZANIM heartbeat nadpisze ślad', (t) => {
  // Arrange — odtwarzamy KOLEJNOŚĆ startu, nie same funkcje: heartbeat nadpisuje
  // last_active_at przy pierwszym wywołaniu, więc detekcja po nim widziałaby zero luki.
  const downtimeMs = 30 * 60 * 1000;
  db.setState('last_active_at', new Date(Date.now() - downtimeMs).toISOString());
  scheduler.markWakeDetected(null);
  t.after(() => {
    scheduler.stop();
    scheduler.markWakeDetected(null);
    db.setState('last_active_at', '');
  });

  // Act
  scheduler.start();

  // Assert — karencja żyje, mimo że ślad w DB jest już świeży (nadpisany przez heartbeat)
  const wakeAt = scheduler.getWakeDetectedAt();
  assert.notEqual(wakeAt, null, 'downtime ponad próg snu MUSI zostać wykryty przy starcie');
  assert.equal(scheduler.shouldDeferAfterWake(wakeAt, Date.now()), true, 'pierwszy run po restarcie czeka na sieć');
  const freshMs = Date.now() - Date.parse(db.getState('last_active_at'));
  assert.ok(freshMs < executor.SLEEP_GAP_MS, 'heartbeat zdążył nadpisać ślad — decyzja nie może od niego zależeć');
});

test('start(): krótka przerwa (zwykły restart serwisu) NIE włącza karencji', (t) => {
  // Arrange — przerwa poniżej progu snu to normalny redeploy, nie pobudka maszyny
  db.setState('last_active_at', new Date(Date.now() - 5_000).toISOString());
  scheduler.markWakeDetected(null);
  t.after(() => {
    scheduler.stop();
    scheduler.markWakeDetected(null);
    db.setState('last_active_at', '');
  });

  // Act
  scheduler.start();

  // Assert
  assert.equal(scheduler.getWakeDetectedAt(), null, 'bez luki nie ma wybudzenia — kolejka rusza od razu');
});

test('heartbeat: luka między tyknięciami przy ŻYJĄCYM procesie włącza karencję (główny scenariusz snu Maca)', (t) => {
  // Arrange — zegar i timery sterowane; startHeartbeat jest wołany przez start()
  db.setState('last_active_at', '');
  scheduler.markWakeDetected(null);
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  t.after(() => {
    scheduler.stop();
    scheduler.markWakeDetected(null);
    db.setState('last_active_at', '');
  });
  scheduler.start();

  // Act — najpierw normalne tyknięcie, potem 20 min snu (zegar skacze, timer odpala zaległy callback)
  t.mock.timers.tick(60_000);
  assert.equal(scheduler.getWakeDetectedAt(), null, 'zwykłe tyknięcie NIE jest wybudzeniem');
  t.mock.timers.setTime(Date.now() + 20 * 60 * 1000);
  t.mock.timers.tick(60_000);

  // Assert
  const wakeAt = scheduler.getWakeDetectedAt();
  assert.notEqual(wakeAt, null, 'luka ponad próg snu musi zostać wykryta z samego heartbeatu');
  assert.equal(scheduler.shouldDeferAfterWake(wakeAt, Date.now()), true, 'pierwszy run po pobudce czeka na sieć');
});

test('start(): restart ze znacznikiem przestarzałym o jedno tyknięcie (65 s) NIE włącza karencji', (t) => {
  // Arrange — `last_active_at` zapisuje heartbeat CO 60 s, więc w chwili zatrzymania daemona
  // jest przestarzały o 0–60 s. Przy progu równym okresowi zwykły redeploy trafiałby
  // w karencję za każdym razem, gdy staleness + downtime przekroczy minutę.
  db.setState('last_active_at', new Date(Date.now() - 65_000).toISOString());
  scheduler.markWakeDetected(null);
  t.after(() => {
    scheduler.stop();
    scheduler.markWakeDetected(null);
    db.setState('last_active_at', '');
  });

  // Act
  scheduler.start();

  // Assert
  assert.equal(scheduler.getWakeDetectedAt(), null, 'przestarzały znacznik to nie sen maszyny — kolejka rusza od razu');
});

test('heartbeat: tyknięcie spóźnione o kilka ms (realny jitter libuv) NIE jest wybudzeniem', (t) => {
  // Arrange — na żywym event loopie setInterval(60_000) budzi się po 60_00x ms (zmierzone
  // 60002–60003 ms), bo timery gwarantują tylko „nie wcześniej niż". Próg RÓWNY okresowi
  // heartbeatu brałby więc KAŻDE tyknięcie za sen i zamrażał kolejkę karencją co minutę.
  // Mock daje idealne 60000, dlatego jitter dokładamy jawnie — bez niego test byłby zielony
  // przy złamanej produkcji (learned-patterns: testy obu stron zielone, system zepsuty).
  db.setState('last_active_at', '');
  scheduler.markWakeDetected(null);
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  t.after(() => {
    scheduler.stop();
    scheduler.markWakeDetected(null);
    db.setState('last_active_at', '');
  });
  scheduler.start();

  // Act / Assert — kilka kolejnych tyknięć, każde spóźnione jak na realnym event loopie
  for (const jitterMs of [2, 3, 2]) {
    t.mock.timers.setTime(Date.now() + jitterMs);
    t.mock.timers.tick(60_000);
    assert.equal(
      scheduler.getWakeDetectedAt(),
      null,
      `tyknięcie spóźnione o ${jitterMs} ms NIE jest wybudzeniem`
    );
  }
  assert.ok(
    scheduler.WAKE_GAP_MS > 60_000,
    'próg snu na ścieżce heartbeatu musi być OSTRO większy od okresu tyknięcia'
  );
});

test('pętla kolejki sama wykrywa wybudzenie, gdy cron wyprzedzi tyknięcie heartbeatu (R11)', async (t) => {
  // Arrange — mockujemy WYŁĄCZNIE Date: heartbeat (setInterval 60 s) zostaje prawdziwy, więc
  // w trakcie testu nie tyknie ani razu. To odtwarza produkcyjną kolejność po pobudce: libuv
  // odpala zaległe timery wg due-time, a cron joba `* * * * *` (inbox sync) typowo wypada
  // wcześniej niż kolejne tyknięcie — wtedy karencja MUSI wyjść z samej pętli kolejki.
  db.setState('last_active_at', '');
  scheduler.markWakeDetected(null);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.after(() => {
    scheduler.stop();
    scheduler.markWakeDetected(null);
    db.setState('last_active_at', '');
  });
  scheduler.start(); // startHeartbeat zapisuje ślad „ostatniego tyknięcia"
  const job = db.createJob({
    name: 'wake-loop', job_type: 'script', command: scriptFile(t, 'wake-loop', 'process.exit(0);'), max_retries: 0,
  });
  const run = db.createRun({ job_id: job.id, trigger_type: 'scheduled' });

  // Act — maszyna śpi 20 minut, po czym zaległy cron wchodzi do pętli (heartbeat jeszcze nie tyknął)
  t.mock.timers.setTime(Date.now() + 20 * 60 * 1000);
  const drain = scheduler.processQueue();

  // Assert — pętla wykryła lukę sama i wstrzymała start (bez tego run padłby na ENOTFOUND)
  assert.notEqual(scheduler.getWakeDetectedAt(), null, 'pętla kolejki wykrywa lukę bez pomocy heartbeatu');
  assert.equal(db.getRunWithPayload(run.id).status, 'queued', 'pierwszy run po pobudce nie startuje natychmiast');

  // Karencja mija (zegar sterowany), dzwonek nowej pracy budzi pętlę → run rusza normalnie
  t.mock.timers.setTime(Date.now() + scheduler.WAKE_GRACE_MS + 1_000);
  scheduler.processQueue();
  await drain;
  assert.equal(db.getRunWithPayload(run.id).status, 'success', 'po karencji run wykonuje się normalnie');
});

// Historia udanych runów w bazie — wejście dla db.getRecentSuccessDurations → classifyJob.
function seedSuccessHistory(jobId, durationMs, count = 3) {
  for (let i = 0; i < count; i++) {
    const run = db.createRun({ job_id: jobId, trigger_type: 'manual' });
    const startedAt = new Date(Date.now() - 3_600_000);
    db.updateRun(run.id, {
      status: 'success',
      started_at: startedAt.toISOString(),
      finished_at: new Date(startedAt.getTime() + durationMs).toISOString(),
    });
  }
}

test('R1 na żywej pętli: rezerwa przepuszcza KRÓTKI job, drugi długi czeka (szew historia→klasyfikacja→picker)', async (t) => {
  // Arrange — limit 2 ⇒ budżet długich = 1. Krótki job ma REALNĄ historię udanych runów
  // po ~1 s w bazie; oba długie nie mają żadnej (fail-safe 'long'). Gdyby szew
  // getRecentSuccessDurations → classifyJob → pickEligibleRuns był rozjechany (np. złe
  // kluczowanie durationsByJob), krótki poszedłby do długich i czekał za pierwszym.
  db.setState('max_concurrent', '2');
  t.after(() => db.setState('max_concurrent', ''));
  const longOne = db.createJob({
    name: 'res-long-1', job_type: 'script', command: scriptFile(t, 'res-long-1', 'setTimeout(() => {}, 1500);'), max_retries: 0,
  });
  const longTwo = db.createJob({
    name: 'res-long-2', job_type: 'script', command: scriptFile(t, 'res-long-2', 'process.exit(0);'), max_retries: 0,
  });
  const shortJob = db.createJob({
    name: 'res-short', job_type: 'script', command: scriptFile(t, 'res-short', 'process.exit(0);'), max_retries: 0,
  });
  seedSuccessHistory(shortJob.id, 1_000);

  const runLongOne = db.createRun({ job_id: longOne.id, trigger_type: 'manual' });
  const runLongTwo = db.createRun({ job_id: longTwo.id, trigger_type: 'manual' });
  const runShort = db.createRun({ job_id: shortJob.id, trigger_type: 'manual' });

  // Act
  await scheduler.processQueue();

  // Assert
  const l1 = db.getRunWithPayload(runLongOne.id);
  const l2 = db.getRunWithPayload(runLongTwo.id);
  const s = db.getRunWithPayload(runShort.id);
  assert.equal(l1.status, 'success');
  assert.equal(l2.status, 'success');
  assert.equal(s.status, 'success');
  assert.ok(
    Date.parse(s.started_at) < Date.parse(l1.finished_at),
    'krótki job wystartował dzięki slotowi rezerwowemu, nie czekał na pierwszy długi'
  );
  assert.ok(
    Date.parse(l2.started_at) >= Date.parse(l1.finished_at),
    'drugi DŁUGI job musi czekać — rezerwa nie jest dla niego'
  );
});
