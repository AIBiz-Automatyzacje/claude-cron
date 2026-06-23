const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Izolacja: każdy bieg testów dostaje własny plik bazy w temp.
const TMP_DB = path.join(os.tmpdir(), `claude-cron-test-${process.pid}.db`);
process.env.CLAUDE_CRON_DB = TMP_DB;

const db = require('./db');

function cleanupDbFiles() {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(TMP_DB + suffix);
    } catch {
      // Plik nie istnieje — nic do sprzątania
    }
  }
}

before(() => {
  cleanupDbFiles();
  db.getDb();
});

after(() => {
  db.close();
  cleanupDbFiles();
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
