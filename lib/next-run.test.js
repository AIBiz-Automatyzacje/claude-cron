const { test } = require('node:test');
const assert = require('node:assert/strict');

const computeNextRun = require('./next-run');

// Stub schedulera: mapuje jobId → ISO next_run (lub null).
function stubGetNextRun(map) {
  return (jobId) => (jobId in map ? map[jobId] : null);
}

test('zwraca job o minimalnym next_run spośród enabled (happy path)', () => {
  const jobs = [
    { id: 1, name: 'wczesny', enabled: 1 },
    { id: 2, name: 'późny', enabled: 1 },
  ];
  const getNextRun = stubGetNextRun({
    1: '2026-06-23T10:00:00.000Z',
    2: '2026-06-23T08:00:00.000Z',
  });

  const result = computeNextRun(jobs, getNextRun);

  assert.deepEqual(result, { job_name: 'późny', next_run: '2026-06-23T08:00:00.000Z' });
});

test('pomija disabled joby przy wyborze minimum', () => {
  const jobs = [
    { id: 1, name: 'disabled-wczesny', enabled: 0 },
    { id: 2, name: 'enabled-późny', enabled: 1 },
  ];
  const getNextRun = stubGetNextRun({
    1: '2026-06-23T08:00:00.000Z',
    2: '2026-06-23T12:00:00.000Z',
  });

  const result = computeNextRun(jobs, getNextRun);

  assert.deepEqual(result, { job_name: 'enabled-późny', next_run: '2026-06-23T12:00:00.000Z' });
});

test('zwraca null gdy wszystkie joby disabled (edge)', () => {
  const jobs = [
    { id: 1, name: 'a', enabled: 0 },
    { id: 2, name: 'b', enabled: 0 },
  ];
  const getNextRun = stubGetNextRun({
    1: '2026-06-23T08:00:00.000Z',
    2: '2026-06-23T09:00:00.000Z',
  });

  const result = computeNextRun(jobs, getNextRun);

  assert.equal(result, null);
});

test('pomija enabled job z null nextRun, wybiera następny', () => {
  const jobs = [
    { id: 1, name: 'bez-runu', enabled: 1 },
    { id: 2, name: 'z-runem', enabled: 1 },
  ];
  const getNextRun = stubGetNextRun({
    1: null,
    2: '2026-06-23T15:00:00.000Z',
  });

  const result = computeNextRun(jobs, getNextRun);

  assert.deepEqual(result, { job_name: 'z-runem', next_run: '2026-06-23T15:00:00.000Z' });
});

test('zwraca null gdy brak enabled jobów (pusta lista)', () => {
  const result = computeNextRun([], stubGetNextRun({}));

  assert.equal(result, null);
});
