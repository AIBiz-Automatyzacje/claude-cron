const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  pollSignature, jobsSignature, buildSparkData, groupRecentByJob,
  parseCronForCalendar, computeWeekOccurrences, startOfWeek,
  overlapsMaintenanceWindow,
  validateMemberName, memberRowData, MEMBER_NAME_MAX,
  isTabAvailable, resolveVisibleTab,
  runningRunsFrom, formatElapsed, activeRunRows, activeRunsSignature,
  shortRevision, revisionsMatch, updateBarView, sysbarView, hostOf,
} = require('./render-helpers');

const MAINTENANCE_WINDOW = { startHour: 2, startMin: 0, endHour: 2, endMin: 15 };

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
  // runy w poniedziałek 15 czerwca (local). started_at generowany z LOKALNEGO południa
  // tego dnia → po normalizacji UTC w indexRunsByDay wraca na 15 czerwca local w KAŻDEJ
  // strefie (fixture TZ-odporny, nie zależy od TZ maszyny — patrz review-faza-4 P2).
  const runs = [
    { job_id: 1, status: 'success', started_at: new Date(2026, 5, 15, 12, 0).toISOString() },
    { job_id: 2, status: 'failed', started_at: new Date(2026, 5, 15, 13, 0).toISOString() },
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

// === overlapsMaintenanceWindow ===

test('overlapsMaintenanceWindow: job dokładnie o 2:00 (granica startu) → true', () => {
  assert.equal(overlapsMaintenanceWindow('0 2 * * *', MAINTENANCE_WINDOW), true);
});

test('overlapsMaintenanceWindow: 2:10 wewnątrz okna 2:00-2:15 → true', () => {
  assert.equal(overlapsMaintenanceWindow('10 2 * * *', MAINTENANCE_WINDOW), true);
});

test('overlapsMaintenanceWindow: 2:15 (granica końca, inclusive) → true', () => {
  assert.equal(overlapsMaintenanceWindow('15 2 * * *', MAINTENANCE_WINDOW), true);
});

test('overlapsMaintenanceWindow: 9:00 poza oknem → false', () => {
  assert.equal(overlapsMaintenanceWindow('0 9 * * *', MAINTENANCE_WINDOW), false);
});

test('overlapsMaintenanceWindow: 1:59 tuż przed oknem → false', () => {
  assert.equal(overlapsMaintenanceWindow('59 1 * * *', MAINTENANCE_WINDOW), false);
});

test('overlapsMaintenanceWindow: 2:16 tuż po oknie → false', () => {
  assert.equal(overlapsMaintenanceWindow('16 2 * * *', MAINTENANCE_WINDOW), false);
});

test('overlapsMaintenanceWindow: highFreq (minutowy) odpala też w oknie → true', () => {
  assert.equal(overlapsMaintenanceWindow('*/5 * * * *', MAINTENANCE_WINDOW), true);
});

test('overlapsMaintenanceWindow: highFreq (godzinowy) → true', () => {
  assert.equal(overlapsMaintenanceWindow('0 */2 * * *', MAINTENANCE_WINDOW), true);
});

test('overlapsMaintenanceWindow: pusty/webhook-only → false (brak crashu)', () => {
  assert.equal(overlapsMaintenanceWindow('', MAINTENANCE_WINDOW), false);
  assert.equal(overlapsMaintenanceWindow(undefined, MAINTENANCE_WINDOW), false);
});

test('overlapsMaintenanceWindow: nieobsługiwany kształt → false', () => {
  assert.equal(overlapsMaintenanceWindow('0 9 15 * *', MAINTENANCE_WINDOW), false);
});

test('overlapsMaintenanceWindow: brak window → false (degradacja cicha)', () => {
  assert.equal(overlapsMaintenanceWindow('0 2 * * *', null), false);
});

// === validateMemberName ===

test('validateMemberName: poprawne imię → valid + przycięta wartość', () => {
  const r = validateMemberName('  Kasia  ');
  assert.equal(r.valid, true);
  assert.equal(r.value, 'Kasia', 'wartość przycięta z whitespace');
});

test('validateMemberName: puste/whitespace → invalid z komunikatem', () => {
  const empty = validateMemberName('');
  assert.equal(empty.valid, false);
  assert.equal(typeof empty.error, 'string');
  assert.equal(validateMemberName('   ').valid, false, 'same spacje = invalid');
});

test('validateMemberName: nie-string → invalid, nie rzuca', () => {
  assert.doesNotThrow(() => validateMemberName(undefined));
  assert.equal(validateMemberName(null).valid, false);
  assert.equal(validateMemberName(42).valid, false);
});

test('validateMemberName: przekroczona długość → invalid', () => {
  const tooLong = 'x'.repeat(MEMBER_NAME_MAX + 1);
  assert.equal(validateMemberName(tooLong).valid, false);
  assert.equal(validateMemberName('x'.repeat(MEMBER_NAME_MAX)).valid, true, 'dokładnie max = ok');
});

// === memberRowData ===

test('memberRowData: komplet pól → poprawna struktura do renderu', () => {
  const row = memberRowData({ id: 7, name: 'Kasia', token_masked: '…a1b2', created_at: '2026-07-24T10:00:00Z' });
  assert.equal(row.id, 7);
  assert.equal(row.name, 'Kasia');
  assert.equal(row.tokenMasked, '…a1b2');
  assert.equal(row.createdAt, '2026-07-24T10:00:00Z');
});

test('memberRowData: braki pól → bezpieczny fallback (myślnik), nie rzuca', () => {
  assert.doesNotThrow(() => memberRowData(undefined));
  const row = memberRowData({ id: 3 });
  assert.equal(row.name, '—', 'brak name → myślnik');
  assert.equal(row.tokenMasked, '—', 'brak token_masked → myślnik');
  assert.equal(row.createdAt, null, 'brak created_at → null');
  assert.equal(row.id, 3);
});

test('memberRowData: puste/whitespace name → myślnik (nie pusty wiersz)', () => {
  assert.equal(memberRowData({ name: '   ' }).name, '—');
});

// === isTabAvailable / resolveVisibleTab ===

test('isTabAvailable: Zespół tylko gdy oglądana instancja jest hubem', () => {
  assert.equal(isTabAvailable('team', { hubConfigured: true }), true);
  assert.equal(isTabAvailable('team', { hubConfigured: false }), false);
});

test('isTabAvailable: pozostałe zakładki dostępne niezależnie od huba', () => {
  for (const tab of ['jobs', 'history', 'skills']) {
    assert.equal(isTabAvailable(tab, { hubConfigured: false }), true, `${tab} nie zależy od huba`);
    assert.equal(isTabAvailable(tab, { hubConfigured: true }), true);
  }
});

test('isTabAvailable: brak/zły stan huba traktowany jak brak huba (fail-closed)', () => {
  assert.equal(isTabAvailable('team', {}), false, 'brak pola → nie pokazuj administracji hubem');
  assert.equal(isTabAvailable('team', undefined), false);
  assert.equal(isTabAvailable('team', { hubConfigured: 'yes' }), false, 'tylko literalne true otwiera zakładkę');
});

test('resolveVisibleTab: zakładka dostępna zostaje aktywna', () => {
  assert.equal(resolveVisibleTab('team', { hubConfigured: true }), 'team');
  assert.equal(resolveVisibleTab('history', { hubConfigured: false }), 'history');
});

test('resolveVisibleTab: aktywna zakładka znika po przełączeniu env → fallback na Zadania', () => {
  assert.equal(resolveVisibleTab('team', { hubConfigured: false }), 'jobs');
});

test('resolveVisibleTab: nieznana zakładka nie wywraca renderu', () => {
  assert.equal(resolveVisibleTab(undefined, { hubConfigured: false }), 'jobs');
  assert.equal(resolveVisibleTab('nieistniejaca', { hubConfigured: true }), 'nieistniejaca');
});

// === runningRunsFrom / formatElapsed / activeRunRows / activeRunsSignature (R2/R6) ===

test('runningRunsFrom: current_runs zwracane w całości (kilka runów naraz)', () => {
  const status = { current_runs: [{ id: 1 }, { id: 2 }] };
  assert.deepEqual(runningRunsFrom(status).map((r) => r.id), [1, 2]);
});

test('runningRunsFrom: instancja bez current_runs → fallback na current_run (parytet API)', () => {
  assert.deepEqual(runningRunsFrom({ current_run: { id: 7 } }).map((r) => r.id), [7]);
});

test('runningRunsFrom: brak biegnących runów → pusta lista (bez rzucania)', () => {
  assert.deepEqual(runningRunsFrom({ current_run: null }), []);
  assert.deepEqual(runningRunsFrom({}), []);
  assert.deepEqual(runningRunsFrom(null), []);
});

test('runningRunsFrom: pusta tablica current_runs wygrywa ze starym current_run', () => {
  // Nowy serwer po zakończeniu runu oddaje current_runs:[] i current_run:null — ale gdyby
  // stare pole zostało nieopróżnione, pasek nie może wskrzeszać martwego runu.
  assert.deepEqual(runningRunsFrom({ current_runs: [], current_run: { id: 9 } }), []);
});

test('formatElapsed: poniżej minuty → sekundy', () => {
  const start = '2026-07-30T10:00:00Z';
  assert.equal(formatElapsed(start, Date.parse(start) + 12_000), '12s');
});

test('formatElapsed: powyżej minuty → minuty i sekundy', () => {
  const start = '2026-07-30T10:00:00Z';
  assert.equal(formatElapsed(start, Date.parse(start) + 187_000), '3m 7s');
});

test('formatElapsed: znacznik bez sufiksu Z traktowany jako UTC (jak reszta API)', () => {
  const withZ = formatElapsed('2026-07-30T10:00:00Z', Date.parse('2026-07-30T10:00:30Z'));
  const withoutZ = formatElapsed('2026-07-30T10:00:00', Date.parse('2026-07-30T10:00:30Z'));
  assert.equal(withoutZ, withZ);
});

test('formatElapsed: brak/nieparsowalny znacznik → myślnik', () => {
  assert.equal(formatElapsed(null, Date.now()), '—');
  assert.equal(formatElapsed('', Date.now()), '—');
  assert.equal(formatElapsed('nie-data', Date.now()), '—');
});

test('formatElapsed: zegar przeglądarki przed startem runu → 0s, nigdy czas ujemny', () => {
  const start = '2026-07-30T10:00:00Z';
  assert.equal(formatElapsed(start, Date.parse(start) - 5000), '0s');
});

test('activeRunRows: nazwa joba z mapy + czas trwania', () => {
  const now = Date.parse('2026-07-30T10:01:00Z');
  const rows = activeRunRows(
    [{ id: 11, job_id: 3, started_at: '2026-07-30T10:00:30Z' }],
    { 3: { id: 3, name: 'Raport dzienny' } },
    now
  );
  assert.deepEqual(rows, [{ id: 11, name: 'Raport dzienny', elapsed: '30s' }]);
});

test('activeRunRows: dwa równoległe runy → dwa wiersze (R2)', () => {
  const now = Date.parse('2026-07-30T10:01:00Z');
  const rows = activeRunRows(
    [
      { id: 11, job_id: 3, started_at: '2026-07-30T10:00:30Z' },
      { id: 12, job_id: 4, started_at: '2026-07-30T10:00:50Z' },
    ],
    { 3: { name: 'Raport' }, 4: { name: 'Inbox sync' } },
    now
  );
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.id), [11, 12]);
  assert.deepEqual(rows.map((r) => r.name), ['Raport', 'Inbox sync']);
});

test('activeRunRows: job nieznany (usunięty w trakcie runu) → fallback "Job #id"', () => {
  const rows = activeRunRows([{ id: 5, job_id: 42, started_at: null }], {}, Date.now());
  assert.equal(rows[0].name, 'Job #42');
  assert.equal(rows[0].elapsed, '—');
});

test('activeRunRows: run bez liczbowego id pomijany (id trafia do onclick)', () => {
  const rows = activeRunRows(
    [{ id: '7); alert(1', job_id: 1 }, { id: 8, job_id: 1 }],
    { 1: { name: 'Job' } },
    Date.now()
  );
  assert.deepEqual(rows.map((r) => r.id), [8]);
});

test('activeRunRows: nullowe wejścia nie wywracają renderu', () => {
  assert.deepEqual(activeRunRows(null, null, Date.now()), []);
  assert.deepEqual(activeRunRows([null], {}, Date.now()), []);
});

test('activeRunsSignature: sam upływ czasu NIE zmienia podpisu (bez migotania paska)', () => {
  const run = { id: 11, job_id: 3, started_at: '2026-07-30T10:00:00Z' };
  const t0 = Date.parse('2026-07-30T10:00:10Z');
  const a = activeRunsSignature(activeRunRows([run], { 3: { name: 'Raport' } }, t0));
  const b = activeRunsSignature(activeRunRows([run], { 3: { name: 'Raport' } }, t0 + 3000));
  assert.equal(a, b, 'tykający czas trwania nie może przebudowywać listy');
});

test('activeRunsSignature: start drugiego runu zmienia podpis (re-render listy)', () => {
  const jobs = { 3: { name: 'Raport' }, 4: { name: 'Inbox sync' } };
  const now = Date.parse('2026-07-30T10:01:00Z');
  const one = activeRunsSignature(activeRunRows([{ id: 11, job_id: 3 }], jobs, now));
  const two = activeRunsSignature(activeRunRows([{ id: 11, job_id: 3 }, { id: 12, job_id: 4 }], jobs, now));
  assert.notEqual(one, two);
});

test('activeRunsSignature: zakończenie jednego z dwóch runów zmienia podpis (R6)', () => {
  const jobs = { 3: { name: 'Raport' }, 4: { name: 'Inbox sync' } };
  const now = Date.parse('2026-07-30T10:01:00Z');
  const two = activeRunsSignature(activeRunRows([{ id: 11, job_id: 3 }, { id: 12, job_id: 4 }], jobs, now));
  const left = activeRunsSignature(activeRunRows([{ id: 12, job_id: 4 }], jobs, now));
  assert.notEqual(two, left);
});

test('activeRunsSignature: zmiana nazwy joba przebudowuje wiersz', () => {
  const now = Date.parse('2026-07-30T10:01:00Z');
  const before = activeRunsSignature(activeRunRows([{ id: 11, job_id: 3 }], { 3: { name: 'Stara' } }, now));
  const after = activeRunsSignature(activeRunRows([{ id: 11, job_id: 3 }], { 3: { name: 'Nowa' } }, now));
  assert.notEqual(before, after);
});

test('pollSignature: start drugiego równoległego runu zmienia podpis (R2)', () => {
  const runs = [{ id: 1, status: 'running' }];
  const base = { queue_length: 0, current_run: { id: 1 } };
  const one = pollSignature(runs, { ...base, current_runs: [{ id: 1 }] });
  const two = pollSignature(runs, { ...base, current_runs: [{ id: 1 }, { id: 2 }] });
  assert.notEqual(one, two, 'drugi biegnący run MUSI wpływać na podpis historii');
});

// === Pasek aktualizacji (R10) ===

test('updateBarView: „masz najnowszą" milczy — wersja stoi obok, zdanie o niej to szum', () => {
  const view = updateBarView({ status: 'current', can_update: false, local_revision: 'abcdef1234', message: 'Masz najnowszą wersję.' });
  assert.equal(view.message, '');
  assert.equal(view.buttonHidden, true);
});

test('updateBarView: dostępna nowa wersja pokazuje komunikat i przycisk', () => {
  const view = updateBarView({ status: 'available', can_update: true, local_revision: 'abcdef1234', message: 'Dostępna nowa wersja (9876543).' });
  assert.equal(view.buttonHidden, false);
  assert.match(view.message, /9876543/);
});

test('updateBarView: „nie wiem" NIE jest wyciszane — to stan wymagający reakcji', () => {
  const view = updateBarView({ status: 'unknown', can_update: true, local_revision: 'unknown', message: 'Nie wiem…' });
  assert.equal(view.message, 'Nie wiem…');
});

test('updateBarView: pad sprawdzenia jest widoczny i bez przycisku (panel nie wisi)', () => {
  const view = updateBarView({ status: 'check_failed', can_update: false, local_revision: 'abcdef1234', message: 'Nie udało się sprawdzić.' });
  assert.equal(view.message, 'Nie udało się sprawdzić.');
  assert.equal(view.buttonHidden, true);
});

test('updateBarView: trwająca aktualizacja wygrywa ze starym stanem „dostępna nowa wersja"', () => {
  const info = { status: 'available', can_update: true, local_revision: 'abcdef1234', message: 'Dostępna nowa wersja.' };
  const view = updateBarView(info, { message: 'Aktualizuję…' });
  assert.equal(view.message, 'Aktualizuję…');
  assert.equal(view.buttonHidden, true); // drugie kliknięcie w trakcie restartu = podwójna aktualizacja
});

// === Pasek systemowy: wersja + adres VPS (R7 + R10) ===

test('sysbarView: wersja widoczna także przy stanie „wszystko aktualne"', () => {
  // Sedno zmiany: poprzedni pasek chował się przy `current`, a tabelę wersji w rundzie
  // testowej wypełnia się DOKŁADNIE wtedy, gdy nie ma żadnego problemu.
  const view = sysbarView({ version: { revision: 'abcdef1234567890', source: 'git', installed_at: '2026-08-06T07:33:54.825Z' } });
  assert.equal(view.versionText, 'abcdef1');
  assert.equal(view.sourceText, 'git');
  assert.equal(view.installedText, '2026-08-06T07:33:54.825Z');
});

test('sysbarView: brak pliku wersji → „nieznana", nigdy pusty napis', () => {
  assert.equal(sysbarView({}).versionText, 'nieznana');
  assert.equal(sysbarView({ version: { revision: 'unknown' } }).versionText, 'nieznana');
  assert.equal(sysbarView(null).versionText, 'nieznana');
});

test('sysbarView: nagłówek pokazuje SAM host, szczegóły pełne adresy', () => {
  const view = sysbarView({
    version: { revision: 'abcdef1234567890' },
    vps_url: { in_use: 'http://100.122.215.61:7777', persisted: 'http://100.122.215.61:7777', mismatch: false },
  });
  assert.equal(view.vpsHidden, false);
  assert.equal(view.vpsText, '100.122.215.61');
  assert.equal(view.inUseText, 'http://100.122.215.61:7777');
  assert.equal(view.warnHidden, true);
});

test('sysbarView: rozjazd adresu pokazuje ostrzeżenie (widoczne też po zwinięciu)', () => {
  const view = sysbarView({ vps_url: { in_use: 'http://10.0.0.1:7777', persisted: 'http://10.0.0.2:7777', mismatch: true } });
  assert.equal(view.warnHidden, false);
});

test('sysbarView: brak konfiguracji VPS chowa człon adresu, wersja zostaje', () => {
  // Tak wygląda hub oglądany przez przełącznik: nie proxuje sam do siebie.
  const view = sysbarView({ version: { revision: 'abcdef1234567890' }, vps_url: { in_use: '', persisted: null, mismatch: false } });
  assert.equal(view.vpsHidden, true);
  assert.equal(view.versionText, 'abcdef1');
  assert.equal(view.savedText, 'nie udało się odczytać', 'null ≠ pusty adres — „nie wiem" nie udaje wartości');
});

test('hostOf: śmieć w konfiguracji nie wywraca renderu statbara', () => {
  assert.equal(hostOf('http://1.2.3.4:7777'), '1.2.3.4');
  assert.equal(hostOf('https://kacper.tail4f19b2.ts.net:8443/x'), 'kacper.tail4f19b2.ts.net');
  assert.equal(hostOf('to nie jest url'), 'to nie jest url');
  assert.equal(hostOf(''), '');
  assert.equal(hostOf(null), '');
});

test('revisionsMatch: skrócona rewizja lokalna == pełna zdalna; krótszy prefiks nie liczy się', () => {
  assert.equal(revisionsMatch('abcdef1', 'abcdef1234567890'), true);
  assert.equal(revisionsMatch('abcdef1234567890', 'abcdef1234567890'), true);
  assert.equal(revisionsMatch('abcdef', 'abcdef1234567890'), false);
  assert.equal(revisionsMatch('abcdef1', 'ffffff1234567890'), false);
  assert.equal(revisionsMatch('', 'abcdef1234567890'), false);
});

test('shortRevision: brak rewizji nie wywraca renderu', () => {
  assert.equal(shortRevision(undefined), '');
  assert.equal(shortRevision('abcdef1234'), 'abcdef1');
});
