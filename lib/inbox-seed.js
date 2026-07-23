const path = require('node:path');

const db = require('./db');

// Finding S-2 (symulacja 22.07): brak joba sync = cicha śmierć Skrzynki — wiadomości
// wiszą w pending i nikt o tym nie wie. Daemon seeduje job przy starcie, ale TYLKO
// gdy inbox jest skonfigurowany (INBOX_DB_URL + INBOX_USER rozwiązywalne przez
// env-loader skryptów) — na maszynie bez Team OS job by failował co minutę.
const JOB_NAME = 'Team OS — inbox sync';
const ASSISTANT_JOB_NAME = 'Team OS — asystent auto-reply';

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

// MVP autonomii (23.07): agent-first auto-odpowiedzi na query. Seedowany WYŁĄCZONY —
// włączenie asystenta to świadoma decyzja per maszyna (panel Pulsa), nie skutek instalacji.
function assistantJobDef(repoRoot) {
  return {
    name: ASSISTANT_JOB_NAME,
    job_type: 'script',
    command: path.join(repoRoot, 'scripts', 'inbox', 'auto-reply.mjs'),
    cron_expr: '*/1 * * * *',
    timeout_ms: 300000, // spawn Claude'a trwa minuty — nie 60s jak czysty sync
    max_retries: 1,
    run_on_wake: 1,
    routine: 1,
    telegram_notify: 1,
    enabled: 0,
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
  // loadEnv mutuje process.env (m.in. wpisuje rozwiązane defaulty ścieżek INBOX_*),
  // a script-joby dziedziczą env daemona — bez przywrócenia snapshotu konfiguracja
  // INBOX_* zamarza na moment startu daemona i zmiany .env wymagają jego restartu.
  const snapshot = { ...process.env };
  let configured = false;
  try {
    await loadEnvFn();
    configured = Boolean(process.env.INBOX_DB_URL && process.env.INBOX_USER);
  } catch {
    configured = false;
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in snapshot)) delete process.env[key];
    }
    Object.assign(process.env, snapshot);
  }
  if (!configured) return 'not_configured';
  const existing = db.getAllJobs();
  if (!existing.some((job) => job.name === ASSISTANT_JOB_NAME)) {
    db.createJob(assistantJobDef(repoRoot));
  }
  if (existing.some((job) => job.name === JOB_NAME)) return 'exists';
  db.createJob(inboxSyncJobDef(repoRoot));
  return 'seeded';
}

module.exports = { JOB_NAME, ASSISTANT_JOB_NAME, inboxSyncJobDef, assistantJobDef, seedInboxSyncJob };
