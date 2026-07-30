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
      // Równoległość (R2): sam `current_run` to tylko PIERWSZY z biegnących — start
      // i koniec drugiego runu nie zmieniłyby podpisu i historia zamarzłaby na 3 s
      // dłużej niż trzeba. `runningRunsFrom` daje parytet ze starym polem.
      runningRunsFrom(s).map((r) => r.id).join('+'),
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

  // Czy job o danym cron_expr pokrywa się z oknem restartu VPS (R5).
  // window: { startHour, startMin, endHour, endMin } z /api/env (maintenance_window).
  // - nieparsowalny/webhook-only → false (nie ostrzegamy o czymś bez harmonogramu),
  // - highFreq (minutowy/godzinowy) → true (odpala też w oknie),
  // - inaczej: porównanie {hour,minute} z przedziałem [start, end], granice inclusive.
  function overlapsMaintenanceWindow(cronExpr, window) {
    if (!window) return false;
    const parsed = parseCronForCalendar(cronExpr);
    if (!parsed) return false;
    if (parsed.highFreq) return true;

    const fireMinutes = parsed.hour * 60 + parsed.minute;
    const startMinutes = window.startHour * 60 + window.startMin;
    const endMinutes = window.endHour * 60 + window.endMin;
    return fireMinutes >= startMinutes && fireMinutes <= endMinutes;
  }

  // === Aktywne runy (równoległość — R2/R6) ===

  // Lista biegnących runów z /api/status. Parytet pól: `current_runs` (nowe) wygrywa,
  // ale instancja sprzed równoległości (np. starszy VPS za proxy /api/vps/*) oddaje tylko
  // `current_run` — bez fallbacku jej pasek byłby pusty mimo biegnącego zadania.
  function runningRunsFrom(status) {
    const s = status || {};
    if (Array.isArray(s.current_runs)) return s.current_runs;
    return s.current_run ? [s.current_run] : [];
  }

  // Czas od startu runu: "12s" / "3m 7s" (styl formatDuration z app.js).
  // Brak/nieparsowalny znacznik → '—'; ujemna różnica (rozjazd zegara przeglądarki
  // z serwerem) domykana do zera, żeby pasek nie pokazywał czasu wstecz.
  function formatElapsed(startedAt, nowMs) {
    if (typeof startedAt !== 'string' || !startedAt) return '—';
    const iso = startedAt + (startedAt.endsWith('Z') ? '' : 'Z');
    const startMs = Date.parse(iso);
    if (!Number.isFinite(startMs) || !Number.isFinite(nowMs)) return '—';
    const totalSec = Math.max(0, Math.floor((nowMs - startMs) / 1000));
    if (totalSec < 60) return `${totalSec}s`;
    return `${Math.floor(totalSec / 60)}m ${totalSec % 60}s`;
  }

  // Wiersze kill-bara: { id, name, elapsed }. Nazwa z mapy jobów, z fallbackiem
  // "Job #<id>" (job mógł zostać usunięty w trakcie runu). Runy bez liczbowego id
  // są POMIJANE — id trafia do `onclick="killRun(<id>)"`, więc musi być liczbą.
  function activeRunRows(runs, jobsMap, nowMs) {
    const list = Array.isArray(runs) ? runs : [];
    const jobs = jobsMap || {};
    const rows = [];
    for (const run of list) {
      if (!run) continue;
      const id = Number(run.id);
      if (!Number.isInteger(id)) continue;
      const job = jobs[run.job_id];
      rows.push({
        id,
        name: job && job.name ? job.name : `Job #${run.job_id}`,
        elapsed: formatElapsed(run.started_at, nowMs),
      });
    }
    return rows;
  }

  // Podpis SZKIELETU listy aktywnych runów (id + nazwa). Czas trwania świadomie poza
  // podpisem: tyka co sekundę, więc wchodząc do niego przebudowywałby innerHTML paska
  // przy każdym pollu (migotanie). App.js dopisuje czas per wiersz przez textContent.
  function activeRunsSignature(rows) {
    const list = Array.isArray(rows) ? rows : [];
    return list.map((r) => `${r.id}:${r.name}`).join(',') + '#' + list.length;
  }

  // === Zespół (Team OS Hub) — członkowie skrzynki ===
  const MEMBER_NAME_MAX = 80;

  // Walidacja imienia członka PRZED POST-em (szybki feedback, zanim uderzy hub).
  // Zwraca discriminated result: { valid:true, value } albo { valid:false, error }.
  // Backend i tak waliduje (name required) + zwraca 409 na duplikat — to warstwa UX.
  function validateMemberName(name) {
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (!trimmed) return { valid: false, error: 'Podaj imię członka' };
    if (trimmed.length > MEMBER_NAME_MAX) {
      return { valid: false, error: `Imię za długie (maks. ${MEMBER_NAME_MAX} znaków)` };
    }
    return { valid: true, value: trimmed };
  }

  // Normalizuje wiersz członka z /api/inbox/members do danych do renderu.
  // Wejście: { id, name, token_masked, created_at } (token ZAWSZE zamaskowany z backendu).
  // Braki pól nie wywalają renderu — bezpieczny fallback prezentacyjny (myślnik).
  function memberRowData(member) {
    const m = member || {};
    const name = typeof m.name === 'string' && m.name.trim() ? m.name : '—';
    const tokenMasked = typeof m.token_masked === 'string' && m.token_masked ? m.token_masked : '—';
    return {
      id: m.id ?? null,
      name,
      tokenMasked,
      createdAt: m.created_at || null,
    };
  }

  // === Widoczność zakładek zależna od oglądanej instancji ===
  // Zespół to administracja HUBEM skrzynki, a hubem jest wyłącznie instancja ze
  // skonfigurowanym Funnelem (WEBHOOK_BASE_URL) — bez niego `POST /api/inbox/members`
  // i tak odmawia (503, kod zaproszenia bez publicznego URL-a jest bezużyteczny),
  // a lista pokazywałaby PUSTĄ lokalną `inbox.db`, która nie jest hubem żadnego zespołu.
  // Kryterium jest „ta instancja ma Funnela", NIE „przełącznik stoi na VPS": dashboard
  // otwarty wprost na hubie (przez Tailscale) działa w trybie `local` i musi tę zakładkę
  // pokazywać — tam ona jest jedynym miejscem dodawania członków.
  const HUB_ONLY_TABS = ['team'];
  const DEFAULT_TAB = 'jobs';

  // Fail-closed: cokolwiek innego niż literalne `true` znaczy „nie wiem" → chowamy
  // administrację hubem (stan huba bywa nieznany, gdy VPS jest nieosiągalny).
  function isTabAvailable(tab, state) {
    if (!HUB_ONLY_TABS.includes(tab)) return true;
    return (state || {}).hubConfigured === true;
  }

  // Zakładka, która ma być aktywna po zmianie środowiska — gdy bieżąca właśnie
  // zniknęła, cofamy użytkownika na Zadania zamiast zostawiać widok bez zakładki.
  // Brak nazwy (np. `querySelector('.tab.active')` zwrócił null) też ląduje na Zadaniach.
  function resolveVisibleTab(tab, state) {
    if (typeof tab !== 'string' || !tab) return DEFAULT_TAB;
    return isTabAvailable(tab, state) ? tab : DEFAULT_TAB;
  }

  const api = {
    pollSignature, jobsSignature, buildSparkData, groupRecentByJob, SPARK_WINDOW,
    parseCronForCalendar, computeWeekOccurrences, startOfWeek, formatHourMinute,
    overlapsMaintenanceWindow,
    runningRunsFrom, formatElapsed, activeRunRows, activeRunsSignature,
    isTabAvailable, resolveVisibleTab, DEFAULT_TAB,
    validateMemberName, memberRowData, MEMBER_NAME_MAX,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.RenderHelpers = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
