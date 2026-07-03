const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const db = require('./db');
const {
  SKIP_REASON,
  computeStarterJobsToSeed,
  loadStarterJobDefs,
  seedStarterJobs,
} = require('./starter-jobs');

// Izolacja: baza in-memory (DI przez setDbPath) — wzorzec z db.test.js.
before(() => {
  db.setDbPath(':memory:');
  db.getDb();
});

after(() => {
  db.close();
});

beforeEach(() => {
  db.getDb().exec('DELETE FROM runs; DELETE FROM jobs;');
});

// Wszystkie skille wymagane przez szablony — fixture dla scenariuszy „dostępne".
const ALL_SKILLS = ['memory-update', 'reflect', 'skill-scout'];

// === computeStarterJobsToSeed (pure) ===

test('pusty stan + wszystkie skille dostępne → 4 szablony do seedu', () => {
  const defs = loadStarterJobDefs();

  const { toSeed, skipped } = computeStarterJobsToSeed(defs, [], ALL_SKILLS);

  assert.equal(toSeed.length, 4);
  assert.deepEqual(skipped, []);
});

test('job o tej samej nazwie istnieje → pominięty z reason exists', () => {
  const defs = loadStarterJobDefs();
  const existingJobs = [{ name: 'Daily memory update' }];

  const { toSeed, skipped } = computeStarterJobsToSeed(defs, existingJobs, ALL_SKILLS);

  assert.equal(toSeed.length, 3);
  assert.deepEqual(skipped, [{ name: 'Daily memory update', reason: SKIP_REASON.EXISTS }]);
});

test('skill niedostępny → pominięty z reason missing_skill', () => {
  const defs = loadStarterJobDefs();
  const withoutSkillScout = ALL_SKILLS.filter((name) => name !== 'skill-scout');

  const { toSeed, skipped } = computeStarterJobsToSeed(defs, [], withoutSkillScout);

  assert.equal(toSeed.length, 3);
  assert.deepEqual(skipped, [
    { name: 'Poszukiwanie nowych skillów', reason: SKIP_REASON.MISSING_SKILL },
  ]);
});

// === seedStarterJobs (skorupa na DB :memory:) ===

test('seed tworzy 4 joby z poprawnymi cronami i enabled=1', () => {
  const { added, skipped } = seedStarterJobs({ availableSkillNames: ALL_SKILLS });

  assert.equal(added.length, 4);
  assert.deepEqual(skipped, []);

  const jobs = db.getAllJobs();
  assert.equal(jobs.length, 4);
  const cronByName = Object.fromEntries(jobs.map((job) => [job.name, job.cron_expr]));
  assert.deepEqual(cronByName, {
    'Daily memory update': '0 6 * * *',
    'Weekly memory update': '0 8 * * 1',
    'Reflect tygodniowy': '0 8 * * 1',
    'Poszukiwanie nowych skillów': '0 9 * * 5',
  });
  for (const job of jobs) {
    assert.equal(job.enabled, 1, `job "${job.name}" powinien być enabled`);
    assert.equal(job.run_on_wake, 1, `job "${job.name}" powinien mieć run_on_wake=1`);
    assert.equal(job.discord_notify, 0, `job "${job.name}" powinien mieć discord_notify=0`);
    assert.equal(job.telegram_notify, 0, `job "${job.name}" powinien mieć telegram_notify=0`);
    assert.equal(job.job_type, 'claude');
  }
});

test('drugi seed nie duplikuje — 0 nowych, wszystkie pominięte jako exists', () => {
  seedStarterJobs({ availableSkillNames: ALL_SKILLS });

  const { added, skipped } = seedStarterJobs({ availableSkillNames: ALL_SKILLS });

  assert.deepEqual(added, []);
  assert.equal(skipped.length, 4);
  assert.ok(skipped.every((entry) => entry.reason === SKIP_REASON.EXISTS));
  assert.equal(db.getAllJobs().length, 4);
});

test('seed z niedostępnym skillem nie tworzy joba dla tego szablonu', () => {
  const { added, skipped } = seedStarterJobs({
    availableSkillNames: ['memory-update', 'reflect'],
  });

  assert.equal(added.length, 3);
  assert.deepEqual(skipped, [
    { name: 'Poszukiwanie nowych skillów', reason: SKIP_REASON.MISSING_SKILL },
  ]);
  assert.equal(db.getAllJobs().length, 3);
});
