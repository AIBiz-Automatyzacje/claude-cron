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

test('pusty stan + wszystkie skille dostępne → wszystkie szablony do seedu', () => {
  const defs = loadStarterJobDefs();

  const { toSeed, skipped } = computeStarterJobsToSeed(defs, [], ALL_SKILLS);

  assert.equal(toSeed.length, 5);
  assert.deepEqual(skipped, []);
});

test('job o tej samej nazwie istnieje → pominięty z reason exists', () => {
  const defs = loadStarterJobDefs();
  const existingJobs = [{ name: 'Daily memory update' }];

  const { toSeed, skipped } = computeStarterJobsToSeed(defs, existingJobs, ALL_SKILLS);

  assert.equal(toSeed.length, 4);
  assert.deepEqual(skipped, [{ name: 'Daily memory update', reason: SKIP_REASON.EXISTS }]);
});

test('skill niedostępny → pominięty z reason missing_skill', () => {
  const defs = loadStarterJobDefs();
  const withoutSkillScout = ALL_SKILLS.filter((name) => name !== 'skill-scout');

  const { toSeed, skipped } = computeStarterJobsToSeed(defs, [], withoutSkillScout);

  assert.equal(toSeed.length, 4);
  assert.deepEqual(skipped, [
    { name: 'Poszukiwanie nowych skillów', reason: SKIP_REASON.MISSING_SKILL },
  ]);
});

// === seedStarterJobs (skorupa na DB :memory:) ===

test('seed tworzy joby z poprawnymi cronami i enabled=1', () => {
  const { added, skipped } = seedStarterJobs({ availableSkillNames: ALL_SKILLS });

  assert.equal(added.length, 5);
  assert.deepEqual(skipped, []);

  const jobs = db.getAllJobs();
  assert.equal(jobs.length, 5);
  const cronByName = Object.fromEntries(jobs.map((job) => [job.name, job.cron_expr]));
  assert.deepEqual(cronByName, {
    'Daily memory update': '0 6 * * *',
    'Weekly memory update': '0 8 * * 1',
    'Reflect tygodniowy': '0 8 * * 1',
    'Puls — kontrola spójności': '0 9 * * *',
    'Poszukiwanie nowych skillów': '0 9 * * 5',
  });
  for (const job of jobs) {
    assert.equal(job.enabled, 1, `job "${job.name}" powinien być enabled`);
    assert.equal(job.run_on_wake, 1, `job "${job.name}" powinien mieć run_on_wake=1`);
    assert.equal(job.discord_notify, 0, `job "${job.name}" powinien mieć discord_notify=0`);
  }
});

// Script-job kontroli spójności: bez skilla, z ABSOLUTNĄ ścieżką skryptu (JSON trzyma
// wartość względną) i z lock_group 'dashboard' — pisze do tego samego pliku co inbox sync.
test('seed kontroli spójności: job_type script, absolutny command, lock_group dashboard', () => {
  seedStarterJobs({ availableSkillNames: ALL_SKILLS });

  const job = db.getAllJobs().find((j) => j.name === 'Puls — kontrola spójności');
  assert.equal(job.job_type, 'script');
  assert.ok(job.command.endsWith('scripts/consistency-check.mjs'), `command: ${job.command}`);
  assert.ok(require('node:path').isAbsolute(job.command));
  assert.equal(job.lock_group, 'dashboard');
  assert.equal(job.routine, 1);
  assert.equal(job.telegram_notify, 1); // routine tłumi sukcesy — flaga znaczy „alarmuj o failach"
});

test('drugi seed nie duplikuje — 0 nowych, wszystkie pominięte jako exists', () => {
  seedStarterJobs({ availableSkillNames: ALL_SKILLS });

  const { added, skipped } = seedStarterJobs({ availableSkillNames: ALL_SKILLS });

  assert.deepEqual(added, []);
  assert.equal(skipped.length, 5);
  assert.ok(skipped.every((entry) => entry.reason === SKIP_REASON.EXISTS));
  assert.equal(db.getAllJobs().length, 5);
});

test('seed z niedostępnym skillem nie tworzy joba dla tego szablonu', () => {
  const { added, skipped } = seedStarterJobs({
    availableSkillNames: ['memory-update', 'reflect'],
  });

  assert.equal(added.length, 4);
  assert.deepEqual(skipped, [
    { name: 'Poszukiwanie nowych skillów', reason: SKIP_REASON.MISSING_SKILL },
  ]);
  assert.equal(db.getAllJobs().length, 4);
});
