// Testy seedu joba inbox sync (finding S-2 z symulacji 22.07):
// seed tylko przy skonfigurowanym inboksie, idempotencja po nazwie, brak configu = brak joba.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const db = require('./db');
const { JOB_NAME, ASSISTANT_JOB_NAME, seedInboxSyncJob } = require('./inbox-seed');

before(() => {
  db.setDbPath(':memory:');
  db.getDb();
});

after(() => {
  db.close();
});

beforeEach(() => {
  db.getDb().exec('DELETE FROM runs; DELETE FROM jobs;');
  delete process.env.INBOX_DB_URL;
  delete process.env.INBOX_USER;
});

function fakeEnv(vars) {
  return async () => { Object.assign(process.env, vars); };
}

test('seed: inbox skonfigurowany + brak joba → tworzy script-job routine co 1 min', async () => {
  const result = await seedInboxSyncJob({
    loadEnvFn: fakeEnv({ INBOX_DB_URL: 'postgres://x', INBOX_USER: 'tester' }),
    repoRoot: '/repo',
  });
  assert.equal(result, 'seeded');
  const job = db.getAllJobs().find((j) => j.name === JOB_NAME);
  assert.ok(job, 'job istnieje');
  assert.equal(job.job_type, 'script');
  assert.equal(job.command, path.join('/repo', 'scripts', 'inbox', 'inbox-sync.mjs'));
  assert.equal(job.cron_expr, '*/1 * * * *');
  assert.equal(job.routine, 1);
  assert.equal(job.telegram_notify, 1);
});

test('seed: job już istnieje → exists, bez duplikatu', async () => {
  const opts = {
    loadEnvFn: fakeEnv({ INBOX_DB_URL: 'postgres://x', INBOX_USER: 'tester' }),
    repoRoot: '/repo',
  };
  await seedInboxSyncJob(opts);
  const result = await seedInboxSyncJob(opts);
  assert.equal(result, 'exists');
  assert.equal(db.getAllJobs().filter((j) => j.name === JOB_NAME).length, 1);
});

test('seed: brak INBOX_DB_URL/INBOX_USER → not_configured, zero jobów', async () => {
  const result = await seedInboxSyncJob({ loadEnvFn: fakeEnv({}), repoRoot: '/repo' });
  assert.equal(result, 'not_configured');
  assert.equal(db.getAllJobs().length, 0);
});

test('seed: job asystenta auto-reply tworzony WYŁĄCZONY, idempotentnie', async () => {
  const opts = {
    loadEnvFn: fakeEnv({ INBOX_DB_URL: 'postgres://x', INBOX_USER: 'tester' }),
    repoRoot: '/repo',
  };
  await seedInboxSyncJob(opts);
  await seedInboxSyncJob(opts);
  const jobs = db.getAllJobs().filter((j) => j.name === ASSISTANT_JOB_NAME);
  assert.equal(jobs.length, 1, 'dokładnie jeden job asystenta');
  assert.equal(jobs[0].enabled, 0, 'seedowany wyłączony — włączenie to świadoma decyzja');
  assert.equal(jobs[0].job_type, 'script');
  assert.equal(jobs[0].command, path.join('/repo', 'scripts', 'inbox', 'auto-reply.mjs'));
  assert.equal(jobs[0].timeout_ms, 300000);
  assert.equal(jobs[0].routine, 1);
});

test('seed: nie zostawia INBOX_* w process.env daemona (script-joby czytają świeży .env)', async () => {
  const result = await seedInboxSyncJob({
    loadEnvFn: fakeEnv({ INBOX_DB_URL: 'postgres://x', INBOX_USER: 'tester', INBOX_TODO_PATH: '/stale/to_do.md' }),
    repoRoot: '/repo',
  });
  assert.equal(result, 'seeded');
  assert.equal(process.env.INBOX_DB_URL, undefined);
  assert.equal(process.env.INBOX_USER, undefined);
  assert.equal(process.env.INBOX_TODO_PATH, undefined);
});

test('seed: loadEnv rzuca → not_configured, start daemona niezablokowany', async () => {
  const result = await seedInboxSyncJob({
    loadEnvFn: async () => { throw new Error('boom'); },
    repoRoot: '/repo',
  });
  assert.equal(result, 'not_configured');
});
