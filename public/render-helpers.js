// Czyste helpery renderu (testowalne bez DOM).
// Dual-export: CommonJS (node:test) + global (root.RenderHelpers) dla <script>.
// Wzorzec jak enum-map.js — brak bundlera, więc to najprostszy sposób
// współdzielenia testowalnej logiki między Node a przeglądarką.
(function (root) {
  const SPARK_WINDOW = 7;
  const OK_STATUSES = new Set(['success']);

  // Podpis payloadu dla guardu poll().
  // KANON §decyzje: MUSI zawierać statusy (nie tylko length + id[0]),
  // inaczej zmiana statusu istniejącego runu nie wywoła re-renderu.
  function pollSignature(runs, status) {
    const list = Array.isArray(runs) ? runs : [];
    const runsSig = list.map((r) => `${r.id}:${r.status}`).join(',');
    const s = status || {};
    const statusSig = [
      s.enabled_jobs,
      s.total_jobs,
      s.queue_length,
      s.today_success,
      s.today_failed,
      s.next ? s.next.next_run : '',
      s.current_run ? s.current_run.id : '',
    ].join('|');
    return `${list.length}#${runsSig}#${statusSig}`;
  }

  // Podpis dla guardu renderJobs() — zmiana joba (enabled/next_run/nazwa/typ) re-renderuje.
  function jobsSignature(jobs) {
    const list = Array.isArray(jobs) ? jobs : [];
    return list
      .map((j) => `${j.id}:${j.enabled ? 1 : 0}:${j.next_run || ''}:${j.cron_expr || ''}:${j.webhook_token ? 1 : 0}`)
      .join(',');
  }

  // Buduje dane sparkline (7 słupków) z listy recent runs danego joba.
  // Wejście: runy posortowane najnowszy-pierwszy (jak /api/runs/recent: id DESC per job).
  // Wyjście: tablica do SPARK_WINDOW elementów { ok } w porządku chronologicznym
  // (najstarszy → najnowszy), bo sparkline rysuje się od lewej.
  function buildSparkData(jobRuns) {
    const list = Array.isArray(jobRuns) ? jobRuns : [];
    const window = list.slice(0, SPARK_WINDOW);
    return window
      .map((r) => ({ ok: OK_STATUSES.has(r.status) }))
      .reverse();
  }

  // Grupuje płaską listę recent runs po job_id, zachowując kolejność (id DESC).
  function groupRecentByJob(recentRuns) {
    const list = Array.isArray(recentRuns) ? recentRuns : [];
    const map = {};
    for (const r of list) {
      if (!map[r.job_id]) map[r.job_id] = [];
      map[r.job_id].push(r);
    }
    return map;
  }

  // === Kalendarz: occurrences w JS (R10) ===
  // Formularz generuje TYLKO 5 wzorców cron (buildCronFromForm):
  //   daily      "mm hh * * *"     → codziennie o hh:mm
  //   weekdays   "mm hh * * 1-5"   → pon–pt o hh:mm
  //   weekly     "mm hh * * d"     → dany dzień tygodnia (0=niedz..6=sob) o hh:mm
  //   hours      "0  */N * * *"    → wysoka częstotliwość (ukryte — filtr skryptowy)
  //   minutes    "*/N * * * *"     → wysoka częstotliwość (ukryte — filtr skryptowy)
  // Bez pełnego parsera cron: rozpoznajemy te 5 kształtów, resztę traktujemy jak nieobsługiwane.

  // Parsuje cron_expr do { hour, minute, dow } gdzie dow to Set numerów dni (0=niedz..6=sob)
  // albo 'all'. highFreq=true → wzorzec godzinowy/minutowy (kalendarz go pomija).
  // Zwraca null gdy expr pusty/nieobsługiwany (np. tylko webhook).
  function parseCronForCalendar(expr) {
    if (!expr || !expr.trim()) return null;
    const parts = expr.trim().split(/\s+/);
    if (parts.length !== 5) return null;
    const [min, hour, dom, mon, dow] = parts;

    if (min.startsWith('*/') || hour.startsWith('*/')) {
      return { highFreq: true };
    }
    if (dom !== '*' || mon !== '*') return null;

    const minute = Number(min);
    const hourNum = Number(hour);
    if (!Number.isInteger(minute) || !Number.isInteger(hourNum)) return null;

    let days;
    if (dow === '*') {
      days = 'all';
    } else if (dow === '1-5') {
      days = new Set([1, 2, 3, 4, 5]);
    } else if (/^[0-6]$/.test(dow)) {
      days = new Set([Number(dow)]);
    } else {
      return null;
    }
    return { highFreq: false, hour: hourNum, minute, dow: days };
  }

  // "HH:MM" z zerowym paddingiem.
  function formatHourMinute(hour, minute) {
    const hh = String(hour).padStart(2, '0');
    const mm = String(minute).padStart(2, '0');
    return `${hh}:${mm}`;
  }

  // Indeksuje runy po dniu (YYYY-MM-DD wg czasu lokalnego) i job_id.
  // Wartość: 'ok' jeśli był sukces danego dnia, inaczej 'err' jeśli był błąd.
  // started_at z API jest UTC (z 'Z' albo bez) — normalizujemy jak formatTime w app.js.
  function indexRunsByDay(runs) {
    const list = Array.isArray(runs) ? runs : [];
    const map = {};
    for (const r of list) {
      if (!r || !r.started_at || r.job_id == null) continue;
      const iso = r.started_at + (r.started_at.endsWith('Z') ? '' : 'Z');
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) continue;
      const dayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const key = `${dayKey}|${r.job_id}`;
      const ok = OK_STATUSES.has(r.status);
      if (map[key] === 'ok') continue; // sukces wygrywa
      map[key] = ok ? 'ok' : 'err';
    }
    return map;
  }

  // Stan kropki eventu: 'ok' (sukces), 'err' (błąd), 'idle' (nieuruchomione/przyszłe).
  function eventStatus(runState) {
    if (runState === 'ok') return 'ok';
    if (runState === 'err') return 'err';
    return 'idle'; // brak runu — niezależnie czy przeszłość bez śladu, czy przyszłość
  }

  // Liczy occurrences dla bieżącego tygodnia.
  // jobs: lista jobów (id, name, enabled, cron_expr). Tylko enabled + niewysokoczęstotliwe.
  // runs: płaska lista runów (job_id, status, started_at) do oznaczenia kropek.
  // weekStart: Date — poniedziałek 00:00 lokalnie. now: Date — "teraz" (today + przyszłość/przeszłość).
  // Zwraca tablicę 7 dni: { date, num, dow(0=niedz..6=sob), isToday, events: [{ time, name, status }] }.
  function computeWeekOccurrences(jobs, runs, weekStart, now) {
    const jobList = Array.isArray(jobs) ? jobs : [];
    const runIndex = indexRunsByDay(runs);
    const nowDay = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    const days = [];
    for (let i = 0; i < 7; i++) {
      const date = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + i);
      const dow = date.getDay();
      const dayKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      const events = [];

      for (const job of jobList) {
        if (!job || !job.enabled) continue;
        const parsed = parseCronForCalendar(job.cron_expr);
        if (!parsed || parsed.highFreq) continue;
        const fires = parsed.dow === 'all' || parsed.dow.has(dow);
        if (!fires) continue;

        const runState = runIndex[`${dayKey}|${job.id}`];
        events.push({
          time: formatHourMinute(parsed.hour, parsed.minute),
          name: job.name,
          status: eventStatus(runState),
        });
      }

      events.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
      days.push({
        date,
        num: date.getDate(),
        dow,
        isToday: dayKey === nowDay,
        events,
      });
    }
    return days;
  }

  // Poniedziałek 00:00 (lokalnie) tygodnia zawierającego `ref`.
  function startOfWeek(ref) {
    const d = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate());
    const dow = d.getDay(); // 0=niedz..6=sob
    const diff = dow === 0 ? -6 : 1 - dow; // cofnij do poniedziałku
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + diff);
  }

  const api = {
    pollSignature, jobsSignature, buildSparkData, groupRecentByJob, SPARK_WINDOW,
    parseCronForCalendar, computeWeekOccurrences, startOfWeek, formatHourMinute,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.RenderHelpers = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
