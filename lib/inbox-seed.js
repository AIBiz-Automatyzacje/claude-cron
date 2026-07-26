const path = require('node:path');

const db = require('./db');

// Finding S-2 (symulacja 22.07): brak joba sync = cicha śmierć Skrzynki — wiadomości
// wiszą w pending i nikt o tym nie wie. Daemon seeduje job przy starcie, ale TYLKO
// gdy inbox jest skonfigurowany (INBOX_HUB_URL + INBOX_TOKEN rozwiązywalne przez
// env-loader skryptów) — na maszynie bez Team OS job by failował co minutę.
const JOB_NAME = 'Team OS — inbox sync';
const ASSISTANT_JOB_NAME = 'Team OS — asystent auto-reply';

// Rola maszyny (ustawiana WYŁĄCZNIE przez instalatory, tu tylko czytana): 'client' = laptop
// człowieka (sync vaulta), 'agent' = VPS 24/7 (auto-odpowiedzi). Rozstrzyga, KTÓRY job powstaje —
// dwie maszyny synchronizujące Skrzynkę pod Obsidian Sync gubią odhaczenia `[x]` (pull nadpisuje
// plik w całości), a auto-reply czyta pytania prosto z huba i syncu nie potrzebuje.
// Brak flagi = zachowanie sprzed wprowadzenia ról (sync), żeby instalacje konfigurowane ręcznie
// nie ucichły po deployu.
const ROLE_STATE_KEY = 'inbox_role';
const ROLE_AGENT = 'agent';

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

// MVP autonomii (23.07): agent-first auto-odpowiedzi na query. Powstaje TYLKO na maszynie
// z rolą 'agent' i od razu włączony — pytanie w instalatorze („czy ta maszyna ma odpowiadać
// za zespół?") zastąpiło ręczne klikanie w panelu, więc job wyłączony po instalacji byłby
// już tylko mylącym artefaktem.
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
    enabled: 1,
  };
}

// loadEnvFn wstrzykiwalne dla testów; domyślnie env-loader współdzielony ze skryptami.
async function defaultLoadEnv() {
  const { loadEnv } = await import('../scripts/inbox/env-loader.mjs');
  await loadEnv();
}

// Zwraca 'not_configured' | 'seeded:sync' | 'exists:sync' | 'seeded:auto-reply' |
// 'exists:auto-reply' — sufiks mówi, KTÓRY job dotyczy wyniku, żeby log startowy nie kłamał
// o stanie faktycznym maszyny. Seed nie może blokować startu daemona.
async function seedInboxSyncJob({ loadEnvFn = defaultLoadEnv, repoRoot = path.join(__dirname, '..') } = {}) {
  // loadEnv mutuje process.env (m.in. wpisuje rozwiązane defaulty ścieżek INBOX_*),
  // a script-joby dziedziczą env daemona — bez przywrócenia snapshotu konfiguracja
  // INBOX_* zamarza na moment startu daemona i zmiany .env wymagają jego restartu.
  const snapshot = { ...process.env };
  let configured = false;
  try {
    await loadEnvFn();
    configured = Boolean(process.env.INBOX_HUB_URL && process.env.INBOX_TOKEN);
  } catch {
    configured = false;
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in snapshot)) delete process.env[key];
    }
    Object.assign(process.env, snapshot);
  }
  if (!configured) return 'not_configured';
  const isAgent = db.getState(ROLE_STATE_KEY) === ROLE_AGENT;
  const jobName = isAgent ? ASSISTANT_JOB_NAME : JOB_NAME;
  const label = isAgent ? 'auto-reply' : 'sync';
  // Wyłącznie createJob gdy joba brak — NIGDY updateJob. Seed leci przy każdym boocie, więc
  // „naprawianie" istniejącego joba pod rolę clobberowałoby ręczne wyłączenia użytkownika.
  if (db.getAllJobs().some((job) => job.name === jobName)) return `exists:${label}`;
  db.createJob(isAgent ? assistantJobDef(repoRoot) : inboxSyncJobDef(repoRoot));
  return `seeded:${label}`;
}

module.exports = {
  JOB_NAME,
  ASSISTANT_JOB_NAME,
  ROLE_STATE_KEY,
  inboxSyncJobDef,
  assistantJobDef,
  seedInboxSyncJob,
};
