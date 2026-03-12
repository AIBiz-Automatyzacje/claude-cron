const Database = require('better-sqlite3');
const path = require('node:path');
const fs = require('node:fs');
const { DB_PATH, DATA_DIR } = require('./config');

let db;

function getDb() {
  if (db) return db;

  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(DB_PATH);
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
}

// === Jobs ===

function getAllJobs() {
  return getDb().prepare('SELECT * FROM jobs ORDER BY id').all();
}

function getJob(id) {
  return getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(id);
}

function createJob({ name, skill_name, cron_expr, arguments: args = '', enabled = 1, run_on_wake = 0, timeout_ms = 600000, max_retries = 1, discord_notify = 0 }) {
  const stmt = getDb().prepare(`
    INSERT INTO jobs (name, skill_name, cron_expr, arguments, enabled, run_on_wake, timeout_ms, max_retries, discord_notify)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(name, skill_name, cron_expr, args, enabled ? 1 : 0, run_on_wake ? 1 : 0, timeout_ms, max_retries, discord_notify ? 1 : 0);
  return getJob(result.lastInsertRowid);
}

function updateJob(id, fields) {
  const allowed = ['name', 'skill_name', 'cron_expr', 'arguments', 'enabled', 'run_on_wake', 'timeout_ms', 'max_retries', 'discord_notify'];
  const updates = [];
  const values = [];

  for (const key of allowed) {
    if (fields[key] !== undefined) {
      let val = fields[key];
      if (key === 'enabled' || key === 'run_on_wake' || key === 'discord_notify') val = val ? 1 : 0;
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

function getRuns({ limit = 50, offset = 0, job_id } = {}) {
  if (job_id) {
    return getDb().prepare('SELECT * FROM runs WHERE job_id = ? ORDER BY id DESC LIMIT ? OFFSET ?').all(job_id, limit, offset);
  }
  return getDb().prepare('SELECT * FROM runs ORDER BY id DESC LIMIT ? OFFSET ?').all(limit, offset);
}

function createRun({ job_id, trigger_type = 'scheduled' }) {
  const stmt = getDb().prepare(`
    INSERT INTO runs (job_id, status, trigger_type) VALUES (?, 'queued', ?)
  `);
  const result = stmt.run(job_id, trigger_type);
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
  getAllJobs,
  getJob,
  createJob,
  updateJob,
  deleteJob,
  toggleJob,
  getRuns,
  createRun,
  updateRun,
  getCurrentRun,
  getQueuedRuns,
  getState,
  setState,
  close,
};
