const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  pollSignature, jobsSignature, buildSparkData, groupRecentByJob,
  parseCronForCalendar, computeWeekOccurrences, startOfWeek,
} = require('./render-helpers');

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

test('pollSignature: zmiana today_success zmienia podpis (statbar R7/R8)', () => {
  const runs = [{ id: 1, status: 'success' }];
  const a = pollSignature(runs, { queue_length: 0, today_success: 2, today_failed: 1 });
  const b = pollSignature(runs, { queue_length: 0, today_success: 3, today_failed: 1 });
  assert.notEqual(a, b, 'today_success MUSI wpływać na podpis statbara');
});

test('pollSignature: zmiana today_failed zmienia podpis (statbar R7/R8)', () => {
  const runs = [{ id: 1, status: 'success' }];
  const a = pollSignature(runs, { queue_length: 0, today_success: 2, today_failed: 1 });
  const b = pollSignature(runs, { queue_length: 0, today_success: 2, today_failed: 2 });
  assert.notEqual(a, b, 'today_failed MUSI wpływać na podpis statbara');
});

test('pollSignature: zmiana next.next_run zmienia podpis (statbar Następne)', () => {
  const runs = [{ id: 1, status: 'success' }];
  const a = pollSignature(runs, { queue_length: 0, next: { next_run: '2026-06-23T10:00:00Z' } });
  const b = pollSignature(runs, { queue_length: 0, next: { next_run: '2026-06-23T11:00:00Z' } });
  assert.notEqual(a, b, 'next.next_run MUSI wpływać na podpis statbara');
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

// === parseCronForCalendar ===

test('parseCronForCalendar: daily → all days, godzina/minuta', () => {
  const r = parseCronForCalendar('0 9 * * *');
  assert.equal(r.highFreq, false);
  assert.equal(r.hour, 9);
  assert.equal(r.minute, 0);
  assert.equal(r.dow, 'all');
});

test('parseCronForCalendar: weekdays → pon-pt (1-5)', () => {
  const r = parseCronForCalendar('30 8 * * 1-5');
  assert.equal(r.dow.has(1), true);
  assert.equal(r.dow.has(5), true);
  assert.equal(r.dow.has(0), false);
  assert.equal(r.dow.has(6), false);
});

test('parseCronForCalendar: weekly → pojedynczy dzień tygodnia', () => {
  const r = parseCronForCalendar('0 14 * * 3');
  assert.equal(r.dow.size, 1);
  assert.equal(r.dow.has(3), true);
});

test('parseCronForCalendar: minutowy → highFreq (filtr skryptowy)', () => {
  assert.equal(parseCronForCalendar('*/5 * * * *').highFreq, true);
});

test('parseCronForCalendar: godzinowy → highFreq (filtr skryptowy)', () => {
  assert.equal(parseCronForCalendar('0 */2 * * *').highFreq, true);
});

test('parseCronForCalendar: pusty/webhook-only → null', () => {
  assert.equal(parseCronForCalendar(''), null);
  assert.equal(parseCronForCalendar('   '), null);
  assert.equal(parseCronForCalendar(undefined), null);
});

test('parseCronForCalendar: nieobsługiwany kształt (dom/mon != *) → null', () => {
  assert.equal(parseCronForCalendar('0 9 15 * *'), null);
  assert.equal(parseCronForCalendar('0 9 * 6 *'), null);
});

// === startOfWeek ===

test('startOfWeek: środa → cofa do poniedziałku tego tygodnia', () => {
  const wed = new Date(2026, 5, 17); // 17 czerwca 2026 = środa
  const mon = startOfWeek(wed);
  assert.equal(mon.getDay(), 1, 'poniedziałek');
  assert.equal(mon.getDate(), 15);
});

test('startOfWeek: niedziela → cofa do poniedziałku tego samego tygodnia (nie następnego)', () => {
  const sun = new Date(2026, 5, 21); // 21 czerwca 2026 = niedziela
  const mon = startOfWeek(sun);
  assert.equal(mon.getDay(), 1);
  assert.equal(mon.getDate(), 15, 'poniedziałek 15, nie 22');
});

// === computeWeekOccurrences ===

const WEEK_START = new Date(2026, 5, 15); // pon 15 czerwca 2026
const NOW = new Date(2026, 5, 17, 12, 0); // śr 17 czerwca 12:00

test('computeWeekOccurrences: zwraca 7 dni z poprawnymi numerami i flagą today', () => {
  const days = computeWeekOccurrences([], [], WEEK_START, NOW);
  assert.equal(days.length, 7);
  assert.equal(days[0].num, 15);
  assert.equal(days[6].num, 21);
  assert.equal(days[2].isToday, true, 'środa 17 = dziś');
  assert.equal(days[0].isToday, false);
});

test('computeWeekOccurrences: daily job widoczny każdego dnia tygodnia', () => {
  const jobs = [{ id: 1, name: 'Daily', enabled: true, cron_expr: '0 6 * * *' }];
  const days = computeWeekOccurrences(jobs, [], WEEK_START, NOW);
  for (const d of days) {
    assert.equal(d.events.length, 1, `dzień ${d.num} ma 1 event`);
    assert.equal(d.events[0].time, '06:00');
    assert.equal(d.events[0].name, 'Daily');
  }
});

test('computeWeekOccurrences: weekly job tylko w swoim dniu', () => {
  // dow=3 = środa
  const jobs = [{ id: 1, name: 'Środa', enabled: true, cron_expr: '0 14 * * 3' }];
  const days = computeWeekOccurrences(jobs, [], WEEK_START, NOW);
  const withEvents = days.filter((d) => d.events.length > 0);
  assert.equal(withEvents.length, 1);
  assert.equal(withEvents[0].num, 17, 'tylko środa 17');
});

test('computeWeekOccurrences: weekdays job pon-pt, brak w weekend', () => {
  const jobs = [{ id: 1, name: 'Robocze', enabled: true, cron_expr: '30 8 * * 1-5' }];
  const days = computeWeekOccurrences(jobs, [], WEEK_START, NOW);
  assert.equal(days[0].events.length, 1, 'pon');
  assert.equal(days[4].events.length, 1, 'pt');
  assert.equal(days[5].events.length, 0, 'sob bez eventu');
  assert.equal(days[6].events.length, 0, 'niedz bez eventu');
});

test('computeWeekOccurrences: wyłączony job → brak wystąpień', () => {
  const jobs = [{ id: 1, name: 'Off', enabled: false, cron_expr: '0 6 * * *' }];
  const days = computeWeekOccurrences(jobs, [], WEEK_START, NOW);
  assert.equal(days.every((d) => d.events.length === 0), true);
});

test('computeWeekOccurrences: minutowy/godzinowy job ukryty (filtr highFreq)', () => {
  const jobs = [
    { id: 1, name: 'Min', enabled: true, cron_expr: '*/5 * * * *' },
    { id: 2, name: 'Hr', enabled: true, cron_expr: '0 */2 * * *' },
  ];
  const days = computeWeekOccurrences(jobs, [], WEEK_START, NOW);
  assert.equal(days.every((d) => d.events.length === 0), true);
});

test('computeWeekOccurrences: kropka 3-stanowa — sukces=ok, błąd=err, brak runu=idle', () => {
  const jobs = [
    { id: 1, name: 'A', enabled: true, cron_expr: '0 6 * * *' },
    { id: 2, name: 'B', enabled: true, cron_expr: '0 7 * * *' },
  ];
  // runy w poniedziałek 15 czerwca (local). started_at jako UTC bez offsetu dnia.
  const runs = [
    { job_id: 1, status: 'success', started_at: '2026-06-15T06:00:00Z' },
    { job_id: 2, status: 'failed', started_at: '2026-06-15T07:00:00Z' },
  ];
  const days = computeWeekOccurrences(jobs, runs, WEEK_START, NOW);
  const mon = days[0];
  const evA = mon.events.find((e) => e.name === 'A');
  const evB = mon.events.find((e) => e.name === 'B');
  assert.equal(evA.status, 'ok');
  assert.equal(evB.status, 'err');
  // wtorek — brak runów → idle
  const tueA = days[1].events.find((e) => e.name === 'A');
  assert.equal(tueA.status, 'idle');
});

test('computeWeekOccurrences: eventy posortowane po godzinie rosnąco', () => {
  const jobs = [
    { id: 1, name: 'Późny', enabled: true, cron_expr: '0 20 * * *' },
    { id: 2, name: 'Wczesny', enabled: true, cron_expr: '0 6 * * *' },
  ];
  const days = computeWeekOccurrences(jobs, [], WEEK_START, NOW);
  assert.equal(days[0].events[0].name, 'Wczesny');
  assert.equal(days[0].events[1].name, 'Późny');
});

test('computeWeekOccurrences: nullowe wejścia nie rzucają', () => {
  assert.doesNotThrow(() => computeWeekOccurrences(null, null, WEEK_START, NOW));
});
