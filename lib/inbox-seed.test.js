// Testy seedu jobów Team OS: seed tylko przy skonfigurowanym inboksie (finding S-2 z symulacji
// 22.07), rola maszyny (`state.inbox_role`) rozstrzyga KTÓRY job powstaje, idempotencja po nazwie,
// zero UPDATE-ów na istniejących jobach.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const db = require('./db');
const { JOB_NAME, ASSISTANT_JOB_NAME, ROLE_STATE_KEY, seedInboxSyncJob } = require('./inbox-seed');

before(() => {
  db.setDbPath(':memory:');
  db.getDb();
});

after(() => {
  db.close();
});

beforeEach(() => {
  db.getDb().exec("DELETE FROM runs; DELETE FROM jobs; DELETE FROM state WHERE key = 'inbox_role';");
  delete process.env.INBOX_HUB_URL;
  delete process.env.INBOX_TOKEN;
});

function fakeEnv(vars) {
  return async () => { Object.assign(process.env, vars); };
}

function seedOpts() {
  return {
    loadEnvFn: fakeEnv({ INBOX_HUB_URL: 'https://hub.example', INBOX_TOKEN: 'tok123' }),
    repoRoot: '/repo',
  };
}

test('seed: brak flagi roli → sync jak dotąd, auto-reply nie powstaje', async () => {
  const result = await seedInboxSyncJob(seedOpts());
  assert.equal(result, 'seeded:sync');
  const job = db.getAllJobs().find((j) => j.name === JOB_NAME);
  assert.ok(job, 'job sync istnieje');
  assert.equal(job.job_type, 'script');
  assert.equal(job.command, path.join('/repo', 'scripts', 'inbox', 'inbox-sync.mjs'));
  assert.equal(job.cron_expr, '*/1 * * * *');
  assert.equal(job.enabled, 1);
  assert.equal(job.routine, 1);
  assert.equal(job.telegram_notify, 1);
  assert.equal(db.getAllJobs().some((j) => j.name === ASSISTANT_JOB_NAME), false, 'auto-reply nie powstaje bez roli agenta');
});

test('seed: rola client → sync, bez auto-reply', async () => {
  db.setState(ROLE_STATE_KEY, 'client');
  const result = await seedInboxSyncJob(seedOpts());
  assert.equal(result, 'seeded:sync');
  const names = db.getAllJobs().map((j) => j.name);
  assert.deepEqual(names, [JOB_NAME]);
});

test('seed: rola agent → auto-reply WŁĄCZONY, sync nie powstaje', async () => {
  db.setState(ROLE_STATE_KEY, 'agent');
  const result = await seedInboxSyncJob(seedOpts());
  assert.equal(result, 'seeded:auto-reply');
  const jobs = db.getAllJobs();
  assert.deepEqual(jobs.map((j) => j.name), [ASSISTANT_JOB_NAME]);
  assert.equal(jobs[0].enabled, 1, 'pytanie w instalatorze zastąpiło ręczne klikanie');
  assert.equal(jobs[0].job_type, 'script');
  assert.equal(jobs[0].command, path.join('/repo', 'scripts', 'inbox', 'auto-reply.mjs'));
  assert.equal(jobs[0].timeout_ms, 300000);
  assert.equal(jobs[0].routine, 1);
  assert.equal(jobs[0].telegram_notify, 1);
});

test('seed: drugie wywołanie → exists, bez duplikatu (obie role)', async () => {
  await seedInboxSyncJob(seedOpts());
  assert.equal(await seedInboxSyncJob(seedOpts()), 'exists:sync');
  assert.equal(db.getAllJobs().filter((j) => j.name === JOB_NAME).length, 1);

  db.setState(ROLE_STATE_KEY, 'agent');
  await seedInboxSyncJob(seedOpts());
  assert.equal(await seedInboxSyncJob(seedOpts()), 'exists:auto-reply');
  assert.equal(db.getAllJobs().filter((j) => j.name === ASSISTANT_JOB_NAME).length, 1);
});

test('seed: job wyłączony ręcznie → seed go NIE włącza (kontrakt: zero UPDATE)', async () => {
  db.setState(ROLE_STATE_KEY, 'agent');
  await seedInboxSyncJob(seedOpts());
  const seeded = db.getAllJobs().find((j) => j.name === ASSISTANT_JOB_NAME);
  db.updateJob(seeded.id, { enabled: 0, cron_expr: '*/5 * * * *' });

  const result = await seedInboxSyncJob(seedOpts());

  assert.equal(result, 'exists:auto-reply');
  const after = db.getAllJobs().filter((j) => j.name === ASSISTANT_JOB_NAME);
  assert.equal(after.length, 1, 'brak duplikatu obchodzącego wyłączenie');
  assert.equal(after[0].enabled, 0, 'ręczne wyłączenie przeżywa restart daemona');
  assert.equal(after[0].cron_expr, '*/5 * * * *', 'ręczna zmiana harmonogramu nietknięta');
});

test('seed: brak INBOX_HUB_URL/INBOX_TOKEN → not_configured, zero jobów niezależnie od roli', async () => {
  db.setState(ROLE_STATE_KEY, 'agent');
  const result = await seedInboxSyncJob({ loadEnvFn: fakeEnv({}), repoRoot: '/repo' });
  assert.equal(result, 'not_configured');
  assert.equal(db.getAllJobs().length, 0);
});

test('seed: nie zostawia INBOX_* w process.env daemona (script-joby czytają świeży .env)', async () => {
  const result = await seedInboxSyncJob({
    loadEnvFn: fakeEnv({ INBOX_HUB_URL: 'https://hub.example', INBOX_TOKEN: 'tok123', INBOX_TODO_PATH: '/stale/to_do.md' }),
    repoRoot: '/repo',
  });
  assert.equal(result, 'seeded:sync');
  assert.equal(process.env.INBOX_HUB_URL, undefined);
  assert.equal(process.env.INBOX_TOKEN, undefined);
  assert.equal(process.env.INBOX_TODO_PATH, undefined);
});

test('seed: loadEnv rzuca → not_configured, start daemona niezablokowany', async () => {
  const result = await seedInboxSyncJob({
    loadEnvFn: async () => { throw new Error('boom'); },
    repoRoot: '/repo',
  });
  assert.equal(result, 'not_configured');
});
