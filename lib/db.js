const Database = require('better-sqlite3');
const path = require('node:path');
const fs = require('node:fs');
const { DB_PATH, DATA_DIR } = require('./config');

let db;
let dbPathOverride = null;

// Wstrzyknięcie ścieżki bazy dla izolacji testów (np. ':memory:').
// Produkcja NIE używa tej funkcji — domyślnie obowiązuje DB_PATH z config.js.
function setDbPath(testPath) {
  dbPathOverride = testPath;
}

function getDb() {
  if (db) return db;

  const target = dbPathOverride || DB_PATH;
  if (target !== ':memory:') {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  db = new Database(target);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      skill_name TEXT NOT NULL,
      cron_expr TEXT NOT NULL,
      arguments TEXT DEFAULT '',
      enabled INTEGER DEFAULT 1,
      run_on_wake INTEGER DEFAULT 0,
      timeout_ms INTEGER DEFAULT 600000,
      max_retries INTEGER DEFAULT 1,
      discord_notify INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      trigger_type TEXT NOT NULL DEFAULT 'scheduled',
      started_at TEXT,
      finished_at TEXT,
      exit_code INTEGER,
      stdout TEXT DEFAULT '',
      stderr TEXT DEFAULT '',
      error_msg TEXT DEFAULT '',
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_runs_job_id ON runs(job_id);
    CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
    CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs(started_at);
  `);

  // Migration: add discord_notify column to existing DBs
  try {
    db.exec('ALTER TABLE jobs ADD COLUMN discord_notify INTEGER DEFAULT 0');
  } catch {
    // Column already exists
  }

  // Migration: add webhook_token column to jobs
  try {
    db.exec('ALTER TABLE jobs ADD COLUMN webhook_token TEXT');
  } catch {
    // Column already exists
  }
  try {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_webhook_token ON jobs(webhook_token) WHERE webhook_token IS NOT NULL');
  } catch {
    // Index already exists
  }

  // Migration: add webhook_payload column to runs
  try {
    db.exec('ALTER TABLE runs ADD COLUMN webhook_payload TEXT DEFAULT \'\'');
  } catch {
    // Column already exists
  }

  // Migration: add idle_timeout_ms column to jobs (per-job override of 5min default)
  try {
    db.prepare('ALTER TABLE jobs ADD COLUMN idle_timeout_ms INTEGER DEFAULT 300000').run();
  } catch {
    // Column already exists
  }

  // Migration: add job_type + command columns to jobs (Faza 1.6 — script jobs)
  const jobCols = db.prepare('PRAGMA table_info(jobs)').all().map(c => c.name);
  if (!jobCols.includes('job_type')) {
    db.prepare("ALTER TABLE jobs ADD COLUMN job_type TEXT DEFAULT 'claude'").run();
  }
  if (!jobCols.includes('command')) {
    db.prepare('ALTER TABLE jobs ADD COLUMN command TEXT').run();
  }
  // Migration: add routine column — joby oznaczone jako rutynowe mają chowane udane runy
  // (np. inbox sync co minutę) + krótszą retencję. Default 0 = job widoczny.
  if (!jobCols.includes('routine')) {
    db.prepare('ALTER TABLE jobs ADD COLUMN routine INTEGER DEFAULT 0').run();
  }
}

// === Jobs ===

function getAllJobs() {
  return getDb().prepare('SELECT * FROM jobs ORDER BY id').all();
}

function getJob(id) {
  return getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(id);
}

function createJob({ name, skill_name = '', cron_expr = '', arguments: args = '', enabled = 1, run_on_wake = 0, timeout_ms = 600000, idle_timeout_ms = 300000, max_retries = 1, discord_notify = 0, job_type = 'claude', command = null, routine = 0 }) {
  const stmt = getDb().prepare(`
    INSERT INTO jobs (name, skill_name, cron_expr, arguments, enabled, run_on_wake, timeout_ms, idle_timeout_ms, max_retries, discord_notify, job_type, command, routine)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(name, skill_name, cron_expr, args, enabled ? 1 : 0, run_on_wake ? 1 : 0, timeout_ms, idle_timeout_ms, max_retries, discord_notify ? 1 : 0, job_type, command, routine ? 1 : 0);
  return getJob(result.lastInsertRowid);
}

function updateJob(id, fields) {
  const allowed = ['name', 'skill_name', 'cron_expr', 'arguments', 'enabled', 'run_on_wake', 'timeout_ms', 'idle_timeout_ms', 'max_retries', 'discord_notify', 'job_type', 'command', 'routine'];
  const updates = [];
  const values = [];

  for (const key of allowed) {
    if (fields[key] !== undefined) {
      let val = fields[key];
      if (key === 'enabled' || key === 'run_on_wake' || key === 'discord_notify' || key === 'routine') val = val ? 1 : 0;
      updates.push(`${key} = ?`);
      values.push(val);
    }
  }

  if (updates.length === 0) return getJob(id);

  updates.push("updated_at = datetime('now')");
  values.push(id);

  getDb().prepare(`UPDATE jobs SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  return getJob(id);
}

function deleteJob(id) {
  return getDb().prepare('DELETE FROM jobs WHERE id = ?').run(id);
}

function toggleJob(id) {
  const job = getJob(id);
  if (!job) return null;
  return updateJob(id, { enabled: !job.enabled });
}

// === Runs ===

function getRuns({ limit = 50, offset = 0, job_id, hideRoutine = false } = {}) {
  if (job_id) {
    return getDb().prepare('SELECT * FROM runs WHERE job_id = ? ORDER BY id DESC LIMIT ? OFFSET ?').all(job_id, limit, offset);
  }
  if (hideRoutine) {
    // Ukryj udane runy jobów oznaczonych routine=1 (np. inbox sync co minutę). Pokaż fails + resztę.
    return getDb().prepare(`
      SELECT r.* FROM runs r
      LEFT JOIN jobs j ON j.id = r.job_id
      WHERE NOT (COALESCE(j.routine,0) = 1 AND r.status = 'success')
      ORDER BY r.id DESC LIMIT ? OFFSET ?
    `).all(limit, offset);
  }
  return getDb().prepare('SELECT * FROM runs ORDER BY id DESC LIMIT ? OFFSET ?').all(limit, offset);
}

// Domyślna i maksymalna liczba runów per job dla /api/runs/recent (sparkline + ostatni run).
const RECENT_RUNS_DEFAULT = 7;
const RECENT_RUNS_CAP = 50;

// Zwraca dokładnie N ostatnich runów per job (niezależnie od kadencji) via window function.
// Normalizuje perJob: nie-int / <=0 → default; powyżej cap → cap.
function getRecentRunsPerJob(perJob = RECENT_RUNS_DEFAULT) {
  const parsed = parseInt(perJob, 10);
  let limit = Number.isInteger(parsed) && parsed > 0 ? parsed : RECENT_RUNS_DEFAULT;
  if (limit > RECENT_RUNS_CAP) limit = RECENT_RUNS_CAP;

  // Jawne kolumny: sparkline + "ostatni run" potrzebują tylko tych pól.
  // NIE ciągniemy stdout/stderr/webhook_payload (zbędny payload §12) ani pomocniczej rn.
  return getDb().prepare(`
    SELECT id, job_id, status, trigger_type, started_at, finished_at FROM (
      SELECT r.id, r.job_id, r.status, r.trigger_type, r.started_at, r.finished_at,
             ROW_NUMBER() OVER (PARTITION BY job_id ORDER BY id DESC) AS rn
      FROM runs r
    ) WHERE rn <= ?
    ORDER BY job_id ASC, id DESC
  `).all(limit);
}

// Statystyki runów z DZISIAJ (granica liczona w czasie lokalnym, nie UTC).
// Zwraca { success, failed } — failed agreguje status failed/timeout/killed.
// date('now','localtime') jest kluczowe: bez localtime granica doby liczona byłaby w UTC,
// co dla PL przesuwa "dziś" o 1-2h (przeskok o 1:00/2:00 czasu lokalnego).
function getTodayRunStats() {
  const row = getDb().prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) AS success,
      COALESCE(SUM(CASE WHEN status IN ('failed', 'timeout', 'killed') THEN 1 ELSE 0 END), 0) AS failed
    FROM runs
    WHERE started_at IS NOT NULL
      AND date(started_at, 'localtime') = date('now', 'localtime')
  `).get();
  return { success: row.success, failed: row.failed };
}

// Retention — usuń successful runy rutynowych jobów (routine=1) starsze niż N godzin.
// Failed/timeout/killed zostają forever dla debug, joby nierutynowe też zostają.
function deleteOldRoutineRuns(olderThanHours = 24) {
  const cutoff = new Date(Date.now() - olderThanHours * 3600000).toISOString();
  const result = getDb().prepare(`
    DELETE FROM runs
    WHERE status = 'success'
      AND finished_at < ?
      AND job_id IN (SELECT id FROM jobs WHERE routine = 1)
  `).run(cutoff);
  return result.changes;
}

function createRun({ job_id, trigger_type = 'scheduled', webhook_payload = '' }) {
  const stmt = getDb().prepare(`
    INSERT INTO runs (job_id, status, trigger_type, webhook_payload) VALUES (?, 'queued', ?, ?)
  `);
  const result = stmt.run(job_id, trigger_type, webhook_payload);
  return getDb().prepare('SELECT * FROM runs WHERE id = ?').get(result.lastInsertRowid);
}

function updateRun(id, fields) {
  const allowed = ['status', 'started_at', 'finished_at', 'exit_code', 'stdout', 'stderr', 'error_msg'];
  const updates = [];
  const values = [];

  for (const key of allowed) {
    if (fields[key] !== undefined) {
      updates.push(`${key} = ?`);
      values.push(fields[key]);
    }
  }

  if (updates.length === 0) return;
  values.push(id);
  getDb().prepare(`UPDATE runs SET ${updates.join(', ')} WHERE id = ?`).run(...values);
}

function getCurrentRun() {
  return getDb().prepare("SELECT * FROM runs WHERE status = 'running' LIMIT 1").get() || null;
}

function getQueuedRuns() {
  return getDb().prepare("SELECT * FROM runs WHERE status = 'queued' ORDER BY id ASC").all();
}

// === Webhooks ===

function getJobByWebhookToken(token) {
  return getDb().prepare('SELECT * FROM jobs WHERE webhook_token = ?').get(token) || null;
}

function setWebhookToken(id, token) {
  getDb().prepare('UPDATE jobs SET webhook_token = ?, updated_at = datetime(\'now\') WHERE id = ?').run(token, id);
  return getJob(id);
}

function clearWebhookToken(id) {
  getDb().prepare('UPDATE jobs SET webhook_token = NULL, updated_at = datetime(\'now\') WHERE id = ?').run(id);
  return getJob(id);
}

function getRunWithPayload(id) {
  return getDb().prepare('SELECT * FROM runs WHERE id = ?').get(id) || null;
}

// === State ===

function getState(key) {
  const row = getDb().prepare('SELECT value FROM state WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setState(key, value) {
  getDb().prepare('INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)').run(key, value);
}

// === Cleanup ===

function close() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = {
  getDb,
  setDbPath,
  getAllJobs,
  getJob,
  createJob,
  updateJob,
  deleteJob,
  toggleJob,
  getRuns,
  getRecentRunsPerJob,
  getTodayRunStats,
  deleteOldRoutineRuns,
  createRun,
  updateRun,
  getCurrentRun,
  getQueuedRuns,
  getJobByWebhookToken,
  setWebhookToken,
  clearWebhookToken,
  getRunWithPayload,
  getState,
  setState,
  close,
};
