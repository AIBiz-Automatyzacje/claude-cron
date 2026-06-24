const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const db = require('./db');

// Izolacja testów w warstwie testu (DI), bez dotykania config.js:
// baza in-memory — szybka, izolowana, nie śmieci plikiem (źródło §292).
before(() => {
  db.setDbPath(':memory:');
  db.getDb();
});

after(() => {
  db.close();
});

beforeEach(() => {
  const conn = db.getDb();
  conn.exec('DELETE FROM runs; DELETE FROM jobs;');
});

function seedRuns(jobId, count) {
  const conn = db.getDb();
  const stmt = conn.prepare(
    "INSERT INTO runs (job_id, status, trigger_type) VALUES (?, 'success', 'scheduled')"
  );
  for (let i = 0; i < count; i += 1) {
    stmt.run(jobId);
  }
}

// Wstawia run ze started_at jako UTC ISO (tak jak produkcja: new Date().toISOString()).
function seedRunAt(jobId, startedAtIso, status) {
  const conn = db.getDb();
  conn
    .prepare(
      "INSERT INTO runs (job_id, status, trigger_type, started_at) VALUES (?, ?, 'scheduled', ?)"
    )
    .run(jobId, status, startedAtIso);
}

// Zwraca UTC ISO odpowiadający lokalnej godzinie `hour:minute` dnia (dziś + dayOffset).
// Konstruujemy moment przez lokalne pola, więc toISOString() zwraca poprawny UTC
// niezależnie od strefy — dokładnie tak jak produkcyjny new Date().toISOString().
function localMomentIso(dayOffset, hour = 12, minute = 0) {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

// Wstawia pojedynczy run o zadanym statusie i finished_at (ISO lub null) — zwraca id.
function seedRunWith(jobId, status, finishedAtIso = null) {
  const conn = db.getDb();
  const result = conn
    .prepare(
      "INSERT INTO runs (job_id, status, trigger_type, finished_at) VALUES (?, ?, 'scheduled', ?)"
    )
    .run(jobId, status, finishedAtIso);
  return result.lastInsertRowid;
}

// ISO odpowiadający chwili sprzed N godzin (UTC, jak produkcja).
function hoursAgoIso(hours) {
  return new Date(Date.now() - hours * 3600000).toISOString();
}

test('getTodayRunStats jest wyeksportowany', () => {
  assert.equal(typeof db.getTodayRunStats, 'function');
});

test('liczy tylko dzisiejsze runy i rozdziela success vs failed', () => {
  // Arrange
  const job = db.createJob({ name: 'A', skill_name: 's', cron_expr: '*/1 * * * *' });
  seedRunAt(job.id, localMomentIso(0, 9, 0), 'success');
  seedRunAt(job.id, localMomentIso(0, 10, 0), 'success');
  seedRunAt(job.id, localMomentIso(0, 11, 0), 'failed');
  // wczoraj — nie powinno być liczone
  seedRunAt(job.id, localMomentIso(-1, 23, 30), 'success');
  seedRunAt(job.id, localMomentIso(-1, 23, 45), 'failed');

  // Act
  const stats = db.getTodayRunStats();

  // Assert
  assert.equal(stats.success, 2);
  assert.equal(stats.failed, 1);
});

test('timeout i killed wliczane do failed', () => {
  // Arrange
  const job = db.createJob({ name: 'A', skill_name: 's', cron_expr: '*/1 * * * *' });
  seedRunAt(job.id, localMomentIso(0, 8, 0), 'timeout');
  seedRunAt(job.id, localMomentIso(0, 8, 30), 'killed');
  seedRunAt(job.id, localMomentIso(0, 9, 0), 'success');

  // Act
  const stats = db.getTodayRunStats();

  // Assert
  assert.equal(stats.success, 1);
  assert.equal(stats.failed, 2);
});

test('run tuż po północy lokalnej liczony jako dziś (regresja UTC)', () => {
  // Arrange — run o 00:30 lokalnego czasu dzisiaj.
  // Dla stref dodatnich (np. PL UTC+1/+2) ten moment w UTC to jeszcze WCZORAJ.
  // date(started_at,'localtime') = date('now','localtime') musi zaliczyć go do dziś.
  const job = db.createJob({ name: 'A', skill_name: 's', cron_expr: '*/1 * * * *' });
  seedRunAt(job.id, localMomentIso(0, 0, 30), 'success');

  // Act
  const stats = db.getTodayRunStats();

  // Assert
  assert.equal(stats.success, 1);
  assert.equal(stats.failed, 0);
});

test('brak runów dziś → {success:0, failed:0} (nie null)', () => {
  // Arrange — tylko wczorajszy run
  const job = db.createJob({ name: 'A', skill_name: 's', cron_expr: '*/1 * * * *' });
  seedRunAt(job.id, localMomentIso(-1, 12, 0), 'success');

  // Act
  const stats = db.getTodayRunStats();

  // Assert
  assert.equal(stats.success, 0);
  assert.equal(stats.failed, 0);
});

test('pomija joby routine=1 — statbar bez szumu (np. inbox sync co minutę)', () => {
  // Arrange — nierutynowy job + rutynowy job, oba z dzisiejszymi runami
  const normal = db.createJob({ name: 'A', skill_name: 's', cron_expr: '0 9 * * *' });
  const routine = db.createJob({ name: 'inbox', skill_name: 's', cron_expr: '*/1 * * * *', routine: 1 });
  seedRunAt(normal.id, localMomentIso(0, 9, 0), 'success');
  seedRunAt(routine.id, localMomentIso(0, 9, 1), 'success');
  seedRunAt(routine.id, localMomentIso(0, 9, 2), 'failed');

  // Act
  const stats = db.getTodayRunStats();

  // Assert — liczony tylko nierutynowy job
  assert.equal(stats.success, 1);
  assert.equal(stats.failed, 0);
});

test('getRecentRunsPerJob jest wyeksportowany', () => {
  assert.equal(typeof db.getRecentRunsPerJob, 'function');
});

test('zwraca dokładnie N runów dla joba o dużej kadencji, mniej gdy mniej runów', () => {
  // Arrange — job A (częsty, 20 runów), job B (rzadki, 3 runy)
  const jobA = db.createJob({ name: 'A', skill_name: 's', cron_expr: '*/1 * * * *' });
  const jobB = db.createJob({ name: 'B', skill_name: 's', cron_expr: '0 0 * * *' });
  seedRuns(jobA.id, 20);
  seedRuns(jobB.id, 3);

  // Act
  const rows = db.getRecentRunsPerJob(7);

  // Assert — A dostaje 7 (cap), B dostaje 3 (wszystkie, bo mniej niż N)
  const aRuns = rows.filter(r => r.job_id === jobA.id);
  const bRuns = rows.filter(r => r.job_id === jobB.id);
  assert.equal(aRuns.length, 7);
  assert.equal(bRuns.length, 3);
});

test('wynik posortowany DESC po id w obrębie joba', () => {
  // Arrange
  const job = db.createJob({ name: 'A', skill_name: 's', cron_expr: '*/1 * * * *' });
  seedRuns(job.id, 10);

  // Act
  const rows = db.getRecentRunsPerJob(7).filter(r => r.job_id === job.id);

  // Assert — id malejące
  for (let i = 1; i < rows.length; i += 1) {
    assert.ok(rows[i - 1].id > rows[i].id, 'runy joba muszą być DESC po id');
  }
});

test('per_job=0 → fallback default (nie pusta tablica gdy są runy)', () => {
  // Arrange
  const job = db.createJob({ name: 'A', skill_name: 's', cron_expr: '*/1 * * * *' });
  seedRuns(job.id, 10);

  // Act — 0 jest nieprawidłowe, helper musi użyć defaultu
  const rows = db.getRecentRunsPerJob(0);

  // Assert — default to 7
  const jobRuns = rows.filter(r => r.job_id === job.id);
  assert.equal(jobRuns.length, 7);
});

test('brak argumentu → fallback default 7', () => {
  // Arrange
  const job = db.createJob({ name: 'A', skill_name: 's', cron_expr: '*/1 * * * *' });
  seedRuns(job.id, 10);

  // Act
  const rows = db.getRecentRunsPerJob();

  // Assert
  assert.equal(rows.filter(r => r.job_id === job.id).length, 7);
});

test('per_job ponad cap → przycięty do cap (50)', () => {
  // Arrange — 60 runów, żądanie 999
  const job = db.createJob({ name: 'A', skill_name: 's', cron_expr: '*/1 * * * *' });
  seedRuns(job.id, 60);

  // Act
  const rows = db.getRecentRunsPerJob(999);

  // Assert — przycięte do 50
  assert.equal(rows.filter(r => r.job_id === job.id).length, 50);
});

// === getRuns({ hideRoutine }) ===

test('hideRoutine ukrywa SUCCESS rutynowego joba, ale jego FAIL zostaje widoczny', () => {
  // Arrange — rutynowy job (routine=1) z udanym i nieudanym runem
  const routine = db.createJob({ name: 'inbox', skill_name: 's', cron_expr: '*/1 * * * *', routine: 1 });
  const okId = seedRunWith(routine.id, 'success');
  const failId = seedRunWith(routine.id, 'failed');

  // Act
  const rows = db.getRuns({ hideRoutine: true });

  // Assert — success ukryty, fail widoczny
  const ids = rows.map(r => r.id);
  assert.ok(!ids.includes(okId), 'udany run rutynowego joba musi być ukryty');
  assert.ok(ids.includes(failId), 'nieudany run rutynowego joba musi być widoczny');
});

test('hideRoutine pokazuje WSZYSTKIE runy nierutynowego joba (także success)', () => {
  // Arrange — nierutynowy job (routine=0 default)
  const normal = db.createJob({ name: 'report', skill_name: 's', cron_expr: '0 9 * * *' });
  const okId = seedRunWith(normal.id, 'success');
  const failId = seedRunWith(normal.id, 'failed');

  // Act
  const rows = db.getRuns({ hideRoutine: true });

  // Assert — oba widoczne
  const ids = rows.map(r => r.id);
  assert.ok(ids.includes(okId), 'success nierutynowego joba zawsze widoczny');
  assert.ok(ids.includes(failId), 'fail nierutynowego joba zawsze widoczny');
});

// === getRuns({ job_id }) ===

test('job_id filtruje runy tylko danego joba, DESC po id, respektuje limit', () => {
  // Arrange — dwa joby, każdy z runami
  const jobA = db.createJob({ name: 'A', skill_name: 's', cron_expr: '*/1 * * * *' });
  const jobB = db.createJob({ name: 'B', skill_name: 's', cron_expr: '*/1 * * * *' });
  seedRuns(jobA.id, 5);
  seedRuns(jobB.id, 3);

  // Act — tylko jobA, limit 3
  const rows = db.getRuns({ job_id: jobA.id, limit: 3 });

  // Assert — wszystkie należą do jobA
  assert.equal(rows.length, 3);
  assert.ok(rows.every(r => r.job_id === jobA.id), 'tylko runy jobA');
  // DESC po id
  for (let i = 1; i < rows.length; i += 1) {
    assert.ok(rows[i - 1].id > rows[i].id, 'runy muszą być DESC po id');
  }
});

// === deleteOldRoutineRuns ===

test('deleteOldRoutineRuns kasuje tylko stare SUCCESS rutynowych jobów', () => {
  // Arrange
  const routine = db.createJob({ name: 'inbox', skill_name: 's', cron_expr: '*/1 * * * *', routine: 1 });
  const normal = db.createJob({ name: 'report', skill_name: 's', cron_expr: '0 9 * * *' });

  const oldSuccess = seedRunWith(routine.id, 'success', hoursAgoIso(48)); // kasowany
  const recentSuccess = seedRunWith(routine.id, 'success', hoursAgoIso(1)); // zostaje (świeży)
  const oldFail = seedRunWith(routine.id, 'failed', hoursAgoIso(48)); // zostaje (nie success)
  const oldTimeout = seedRunWith(routine.id, 'timeout', hoursAgoIso(48)); // zostaje
  const normalOldSuccess = seedRunWith(normal.id, 'success', hoursAgoIso(48)); // zostaje (nierutynowy)

  // Act — cutoff 24h
  const deleted = db.deleteOldRoutineRuns(24);

  // Assert — usunięto dokładnie 1 (stary success rutynowego)
  assert.equal(deleted, 1);
  const remainingIds = db.getRuns({ limit: 100 }).map(r => r.id);
  assert.ok(!remainingIds.includes(oldSuccess), 'stary success rutynowego skasowany');
  assert.ok(remainingIds.includes(recentSuccess), 'świeży success zostaje');
  assert.ok(remainingIds.includes(oldFail), 'fail zostaje na zawsze');
  assert.ok(remainingIds.includes(oldTimeout), 'timeout zostaje na zawsze');
  assert.ok(remainingIds.includes(normalOldSuccess), 'success nierutynowego joba zostaje');
});

// === reapOrphanedRuns ===

test('reapOrphanedRuns oznacza osierocony running jako killed z finished_at i error_msg', () => {
  // Arrange — run 'running' bez finished_at (jak po przerwanym procesie)
  const job = db.createJob({ name: 'A', skill_name: 's', cron_expr: '*/1 * * * *' });
  const orphanId = seedRunWith(job.id, 'running', null);

  // Act
  const reaped = db.reapOrphanedRuns();

  // Assert
  assert.equal(reaped, 1);
  const row = db.getDb().prepare('SELECT status, finished_at, error_msg FROM runs WHERE id = ?').get(orphanId);
  assert.equal(row.status, 'killed');
  assert.ok(row.finished_at, 'finished_at musi być ustawione');
  assert.equal(row.error_msg, 'Przerwany — restart serwera');
});

test('reapOrphanedRuns nie tyka runów zakończonych ani w kolejce', () => {
  // Arrange — success, failed, queued (żaden nie jest osierocony)
  const job = db.createJob({ name: 'A', skill_name: 's', cron_expr: '*/1 * * * *' });
  const okId = seedRunWith(job.id, 'success', hoursAgoIso(1));
  const failId = seedRunWith(job.id, 'failed', hoursAgoIso(1));
  const queuedId = seedRunWith(job.id, 'queued', null);

  // Act
  const reaped = db.reapOrphanedRuns();

  // Assert — nic nie naprawiono, statusy nietknięte
  assert.equal(reaped, 0);
  const conn = db.getDb();
  assert.equal(conn.prepare('SELECT status FROM runs WHERE id = ?').get(okId).status, 'success');
  assert.equal(conn.prepare('SELECT status FROM runs WHERE id = ?').get(failId).status, 'failed');
  assert.equal(conn.prepare('SELECT status FROM runs WHERE id = ?').get(queuedId).status, 'queued');
});

test('reapOrphanedRuns gasi getCurrentRun (kill-bar już nie wisi)', () => {
  // Arrange — osierocony running powoduje, że getCurrentRun coś zwraca
  const job = db.createJob({ name: 'A', skill_name: 's', cron_expr: '*/1 * * * *' });
  seedRunWith(job.id, 'running', null);
  assert.ok(db.getCurrentRun(), 'przed reaperem kill-bar ma co pokazać');

  // Act
  db.reapOrphanedRuns();

  // Assert — brak running → kill-bar pusty
  assert.equal(db.getCurrentRun(), null);
});

// === CASCADE delete ===

test('deleteJob kasuje też wszystkie runy tego joba (ON DELETE CASCADE)', () => {
  // Arrange
  const job = db.createJob({ name: 'A', skill_name: 's', cron_expr: '*/1 * * * *' });
  seedRuns(job.id, 4);
  assert.equal(db.getRuns({ job_id: job.id, limit: 100 }).length, 4);

  // Act
  db.deleteJob(job.id);

  // Assert — runy zniknęły wraz z jobem
  assert.equal(db.getRuns({ job_id: job.id, limit: 100 }).length, 0);
  assert.equal(db.getJob(job.id), undefined);
});
