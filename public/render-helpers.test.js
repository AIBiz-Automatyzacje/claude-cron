const { test } = require('node:test');
const assert = require('node:assert/strict');

const { pollSignature, jobsSignature, buildSparkData, groupRecentByJob } = require('./render-helpers');

// === pollSignature ===

test('pollSignature: identyczne dane → identyczny podpis (pomija re-render)', () => {
  const runs = [{ id: 2, status: 'success' }, { id: 1, status: 'failed' }];
  const status = { enabled_jobs: 3, total_jobs: 5, queue_length: 0, today_success: 2, today_failed: 1, next: { next_run: '2026-06-23T10:00:00Z' }, current_run: null };
  assert.equal(pollSignature(runs, status), pollSignature(runs, status));
});

test('pollSignature: zmiana STATUSU istniejącego runu zmienia podpis (kanon)', () => {
  const status = { enabled_jobs: 1, total_jobs: 1, queue_length: 0, today_success: 0, today_failed: 0, next: null, current_run: null };
  const before = pollSignature([{ id: 5, status: 'running' }], status);
  const after = pollSignature([{ id: 5, status: 'success' }], status);
  assert.notEqual(before, after, 'status istniejącego runu MUSI wpływać na podpis');
});

test('pollSignature: zmiana queue_length zmienia podpis', () => {
  const runs = [{ id: 1, status: 'success' }];
  const a = pollSignature(runs, { queue_length: 0 });
  const b = pollSignature(runs, { queue_length: 2 });
  assert.notEqual(a, b);
});

test('pollSignature: nullowe/niezdefiniowane wejścia nie rzucają (degradacja cicha)', () => {
  assert.doesNotThrow(() => pollSignature(null, null));
  assert.doesNotThrow(() => pollSignature(undefined, undefined));
});

// === jobsSignature ===

test('jobsSignature: toggle enabled zmienia podpis', () => {
  const before = jobsSignature([{ id: 1, enabled: true, next_run: 'x' }]);
  const after = jobsSignature([{ id: 1, enabled: false, next_run: 'x' }]);
  assert.notEqual(before, after);
});

test('jobsSignature: brak jobów → pusty string, nie rzuca', () => {
  assert.equal(jobsSignature([]), '');
  assert.doesNotThrow(() => jobsSignature(undefined));
});

// === buildSparkData ===

test('buildSparkData: 7 runów → 7 słupków, success=ok, fail=not-ok', () => {
  const jobRuns = [
    { status: 'success' }, { status: 'failed' }, { status: 'success' },
    { status: 'timeout' }, { status: 'success' }, { status: 'success' }, { status: 'killed' },
  ];
  const spark = buildSparkData(jobRuns);
  assert.equal(spark.length, 7);
  // wejście najnowszy-pierwszy; wyjście chronologiczne (reverse) → ostatni element = najnowszy (success)
  assert.equal(spark[spark.length - 1].ok, true);
  assert.equal(spark.filter((s) => s.ok).length, 4);
});

test('buildSparkData: więcej niż 7 runów → przycina do 7', () => {
  const jobRuns = Array.from({ length: 12 }, () => ({ status: 'success' }));
  assert.equal(buildSparkData(jobRuns).length, 7);
});

test('buildSparkData: brak runów → pusta tablica, nie rzuca', () => {
  assert.deepEqual(buildSparkData([]), []);
  assert.doesNotThrow(() => buildSparkData(undefined));
});

// === groupRecentByJob ===

test('groupRecentByJob: grupuje po job_id zachowując kolejność', () => {
  const recent = [
    { id: 9, job_id: 2, status: 'success' },
    { id: 8, job_id: 2, status: 'failed' },
    { id: 7, job_id: 1, status: 'success' },
  ];
  const grouped = groupRecentByJob(recent);
  assert.equal(grouped[2].length, 2);
  assert.equal(grouped[1].length, 1);
  assert.equal(grouped[2][0].id, 9, 'pierwszy element grupy = najnowszy');
});

test('groupRecentByJob: pusta/nullowa lista → pusty obiekt, nie rzuca', () => {
  assert.deepEqual(groupRecentByJob([]), {});
  assert.doesNotThrow(() => groupRecentByJob(null));
});
