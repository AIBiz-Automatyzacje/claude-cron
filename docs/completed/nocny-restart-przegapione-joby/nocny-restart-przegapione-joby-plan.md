# Plan: Nadrabianie jobów przegapionych przez nocny restart VPS

**Branch:** `feature/nocny-restart-przegapione-joby`
**Ostatnia aktualizacja:** 2026-06-27

> **Korekta po wdrożeniu (2026-06-27):** ten plan zakłada okno restartu **06:00** (potwierdzone empirycznie w momencie planowania). Po ukończeniu restart auto-update przeniesiono na **02:00** — `MAINTENANCE_WINDOW`, cron w `install-vps.sh`, treść warningu i testy okna są w kodzie ustawione na 02:00–02:15 (commit `4ff262d`). Wszystkie wzmianki „6:00 / 06:00 / `0 6 * * *`" poniżej to zapis pierwotnego planu; aktualny stan = **02:00**. Szczegóły: `nocny-restart-przegapione-joby-podsumowanie.md`.

## Podsumowanie wykonawcze

VPS robi co noc auto-update (`git pull` + `systemctl restart claude-cron`) o **6:00** (potwierdzone empirycznie: restart 06:00:06–06:00:08 CEST, 7 dni z rzędu). `croner` trzyma harmonogram tylko w RAM (`activeJobs` Map), więc job zaplanowany w oknie restartu przepada bez śladu — brak nawet runu `failed`. Mechanizm nadrabiania (`detectMissedJobs` + flaga `run_on_wake`) **już istnieje**, ale jest domyślnie wyłączony i ma bug strefy czasowej.

Ten plan realizuje cztery rzeczy:
1. Przełącza `run_on_wake` na **opt-out** (domyślnie włączone + jednorazowy backfill istniejących jobów).
2. Naprawia **bug strefy czasowej** w `detectMissedJobs` (ekstrakcja pure `computeMissedJobs`).
3. Wprowadza stałą `MAINTENANCE_WINDOW` (6:00–6:15) jako jedyne źródło prawdy + ekspozycja przez `/api/env`.
4. Dodaje **warning** w formularzu, gdy user planuje job w oknie restartu.

Killed-w-trakcie pozostaje bez zmian (świadoma decyzja — job nieidempotentny nie powinien powtarzać częściowej pracy).

## Cele i zakres

### W zakresie
- R1: nowe joby domyślnie `run_on_wake=1` (schema + `createJob` + UI checkbox).
- R2: jednorazowy backfill istniejących jobów chroniony flagą `state['wake_backfill_done']` (bez clobberowania opt-outów).
- R3: `detectMissedJobs` liczy cron z tą samą strefą co `scheduleJob`.
- R4: stała `MAINTENANCE_WINDOW` w `lib/config.js` + ekspozycja przez `/api/env`.
- R5: formularz pokazuje ostrzeżenie przy zapisie/edycji joba pokrywającego się z oknem restartu (informuje, nie blokuje).

### Poza zakresem (Granice scope'u)
- Killed-w-trakcie — reaper (`db.js:275`) dalej oznacza `killed` BEZ retry.
- Zmiana harmonogramu auto-update na VPS — pozostaje `0 6 * * *`.
- Nowy retry-on-wake — `wake` dokolejkowuje pojedynczy run; logika retry (`scheduler.js:29`) bez zmian.
- Warning nie blokuje zapisu.

## Fazy i Implementation Units

### Unit 1: `run_on_wake` opt-out — schema, createJob default, jednorazowy backfill
**Wymagania:** R1, R2 · **Zależności:** brak · **Effort:** M · **Delegate:** feature-builder-data

Nowe joby domyślnie `run_on_wake=1`; istniejące dostają jednorazowy backfill bez clobberowania opt-outów.

**Podejście:**
- W `migrate(db)` po blokach `CREATE TABLE` odczytaj flagę `wake_backfill_done` z `state` (przez przekazany `db`, nie `getDb()`). Jeśli brak → `UPDATE jobs SET run_on_wake = 1` → `INSERT OR REPLACE INTO state` ustaw flagę. Idempotentne i jednorazowe.
- `createJob` default arg `run_on_wake = 1`. Zachowaj jawne `? 1 : 0` przy bindowaniu (createJob pozwala wyłączyć).
- Schema `DEFAULT 1` (`db.js:39`) dla spójności świeżych baz (kosmetyczne — realne nowe joby biorą z arg).

**Kryteria akceptacji:**
- `createJob` bez `run_on_wake` tworzy job z `run_on_wake === 1`.
- `createJob({ run_on_wake: 0 })` daje opt-out działający.
- Backfill ustawia istniejące joby na `1` i flagę `wake_backfill_done`.
- Ponowny `migrate` po ręcznym opt-oucie NIE przywraca `1` (idempotencja).

---

### Unit 2: Fix strefy czasowej w `detectMissedJobs` + ekstrakcja pure `computeMissedJobs`
**Wymagania:** R3 · **Zależności:** brak (równoległy do Unit 1) · **Effort:** M · **Delegate:** feature-builder-data

Detekcja przegapionych jobów liczy cron z tą samą strefą co `scheduleJob`; logika collapse/strefy staje się unit-testowalna.

**Podejście:**
- Pure `computeMissedJobs(jobs, lastActive, now, timezone)`: filtruje `enabled && run_on_wake`, dla każdego buduje `new Cron(job.cron_expr, { timezone })`, liczy `cron.nextRun(lastActive)`, zwraca id-ki gdzie `nextFromLast && nextFromLast < now`. Bez I/O, bez `new Date()` w środku. Try/catch na zły cron wewnątrz (skip invalid).
- `detectMissedJobs` zostaje cienkim wrapperem I/O: czyta `last_active_at`, `getAllJobs()`, `new Date()`, przekazuje `Intl.DateTimeFormat().resolvedOptions().timeZone`, woła pure funkcję, dla zwróconych id-ków `enqueueJob(id, 'wake')`.

**Kryteria akceptacji:**
- Job `0 6 * * *`, restart 5:59 → powrót 6:03 zwraca `[jobId]`.
- Job który strzelił przed downtime → `[]` (brak podwójnego odpalenia).
- N przegapionych cykli → job pojawia się dokładnie raz (collapse).
- Strefa jest faktycznie używana (różne `timezone` → różna granica okna).

---

### Unit 3: `MAINTENANCE_WINDOW` w config.js + ekspozycja przez `/api/env`
**Wymagania:** R4 · **Zależności:** brak · **Effort:** S · **Delegate:** feature-builder-data

Stała okna restartu (6:00–6:15) w jednym źródle prawdy i dostępna dla frontu.

**Podejście:**
- `MAINTENANCE_WINDOW = { startHour: 6, startMin: 0, endHour: 6, endMin: 15 }` (lub równoważny kształt minut-od-północy — do dopięcia z helperem w Unit 4). Komentarz z odwołaniem do potwierdzenia empirycznego (restart 06:00 CEST).
- `/api/env` (`server.js:178-181`): dorzuć `maintenance_window: MAINTENANCE_WINDOW` do istniejącego `json(res, {...})`. Import z config.

**Kryteria akceptacji:**
- `grep -n "MAINTENANCE_WINDOW" lib/config.js server.js` pokazuje definicję i użycie.
- `GET /api/env` zwraca `maintenance_window` z `startHour: 6`.
- Cały suite testów bez regresji.

---

### Unit 4: Warning okna restartu w formularzu + domyślny checkbox wake + pure helper overlap
**Wymagania:** R1 (UI default), R5 · **Zależności:** Unit 3 (`maintenance_window` z `/api/env`) · **Effort:** M · **Delegate:** feature-builder-ui

Formularz pokazuje ostrzeżenie przy planowaniu joba w oknie restartu; nowy job ma domyślnie zaznaczony wake.

**Podejście:**
- Pure `overlapsMaintenanceWindow(cronExpr, window)` w `render-helpers.js`: użyj `parseCronForCalendar(cronExpr)`; jeśli `null` → `false`; jeśli `highFreq` → `true`; inaczej porównaj `{hour, minute}` z przedziałem `[start, end]` window. Zwraca boolean. Eksport w `api` (UMD).
- `app.js`: jednorazowy fetch `maintenance_window` (obok istniejącego `/api/env`); `openCreateModal` → `form-wake.checked = true`; w `updateSchedulePreview` (`app.js:265`) policz overlap dla `buildCronFromForm()` i pokaż/ukryj warning.
- `index.html`: `<div id="maintenance-warning" class="hint" hidden>` obok `#schedule-preview` (`index.html:217`); treść: „⚠ Pokrywa się z nocnym restartem VPS (06:00) — zostanie nadrobione po starcie".

**Kryteria akceptacji:**
- `overlapsMaintenanceWindow` klasyfikuje poprawnie (`0 6` → true, `0 9` → false, `*/5` → true, pusty → false bez crashu).
- W formularzu nowego joba checkbox wake zaznaczony domyślnie.
- Godzina 06:05 → `#maintenance-warning` widoczny; 09:00 → ukryty.

## Sekwencjonowanie

- Units **1, 2, 3** są wzajemnie niezależne (można równolegle).
- Unit **4 zależy od Unit 3** (`maintenance_window` z API). Sekwencja: 3 → 4.

## Ocena ryzyka i mitygacje

- **Backfill nadpisuje opt-outy, jeśli guard źle napisany.** Mitygacja: test idempotencji (Unit 1) obowiązkowy; flaga w `state` sprawdzana przed `UPDATE`.
- **Strefa serwera vs lokalna.** VPS może mieć `TZ=UTC`; po fixie obie ścieżki (`scheduleJob` + detekcja) używają **tej samej** strefy — to cały sens R3 (spójność, nie „poprawność").
- **`highFreq` joby pokazujące warning jako szum.** Do potwierdzenia wzrokowo; domyślnie pokazujemy.

## Mierniki sukcesu

- `node --test` (cały suite) przechodzi bez błędów.
- Realny scenariusz „restart o 6:00 → nadrobienie o 6:03" dowodzony przez unit test pure funkcji (Unit 2).
- Warning widoczny w formularzu przy oknie 06:00–06:15, niewidoczny poza nim.

## Źródła
- Requirements doc: (brak — origin to ustalenia, nie `/dev-brainstorm`)
- Plan techniczny: [docs/plans/2026-06-27-001-feat-nocny-restart-przegapione-joby-plan.md](../../plans/2026-06-27-001-feat-nocny-restart-przegapione-joby-plan.md)
- Dokument źródłowy (ustalenia): [docs/plans/2026-06-26-nocny-restart-vps-przegapione-joby-ustalenia.md](../../plans/2026-06-26-nocny-restart-vps-przegapione-joby-ustalenia.md)
