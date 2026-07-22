const path = require('node:path');

const db = require('./db');

// Finding S-2 (symulacja 22.07): brak joba sync = cicha śmierć Skrzynki — wiadomości
// wiszą w pending i nikt o tym nie wie. Daemon seeduje job przy starcie, ale TYLKO
// gdy inbox jest skonfigurowany (INBOX_DB_URL + INBOX_USER rozwiązywalne przez
// env-loader skryptów) — na maszynie bez Team OS job by failował co minutę.
const JOB_NAME = 'Team OS — inbox sync';

function inboxSyncJobDef(repoRoot) {
  return {
    name: JOB_NAME,
    job_type: 'script',
    command: path.join(repoRoot, 'scripts', 'inbox', 'inbox-sync.mjs'),
    cron_expr: '*/1 * * * *',
    timeout_ms: 60000,
    max_retries: 1,
    run_on_wake: 1,
    routine: 1,
    telegram_notify: 1, // alarm o failach; routine tłumi powiadomienia o sukcesie
  };
}

// loadEnvFn wstrzykiwalne dla testów; domyślnie env-loader współdzielony ze skryptami.
async function defaultLoadEnv() {
  const { loadEnv } = await import('../scripts/inbox/env-loader.mjs');
  await loadEnv();
}

// Zwraca 'seeded' | 'exists' | 'not_configured'. Nigdy nie rzuca — seed nie może
// blokować startu daemona.
async function seedInboxSyncJob({ loadEnvFn = defaultLoadEnv, repoRoot = path.join(__dirname, '..') } = {}) {
  try {
    await loadEnvFn();
  } catch {
    return 'not_configured';
  }
  if (!process.env.INBOX_DB_URL || !process.env.INBOX_USER) return 'not_configured';
  if (db.getAllJobs().some((job) => job.name === JOB_NAME)) return 'exists';
  db.createJob(inboxSyncJobDef(repoRoot));
  return 'seeded';
}

module.exports = { JOB_NAME, inboxSyncJobDef, seedInboxSyncJob };
