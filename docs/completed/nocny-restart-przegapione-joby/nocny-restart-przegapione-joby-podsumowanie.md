# Podsumowanie: Nadrabianie jobów przegapionych przez nocny restart VPS

**Data ukończenia:** 2026-06-27
**Branch:** `feature/nocny-restart-przegapione-joby`
**Status:** Wszystkie 4 fazy ukończone (execute + review + fix). Suite `node --test`: 108/108 PASS, zero regresji.

## Co zostało dostarczone

System nadrabia joby cron przegapione podczas codziennego nocnego restartu VPS (06:00–06:15 CEST). Po starcie serwera wykrywa joby, których cykl wypadł w oknie downtime, i dokolejkowuje je dokładnie raz (collapse N przegapionych cykli → 1 odpalenie). Job może opt-outować z nadrabiania (`run_on_wake = 0`). UI ostrzega operatora, gdy nowy job pokrywa się z oknem restartu.

- **Unit 1 — opt-out `run_on_wake`:** kolumna ze schematem `DEFAULT 1`, `createJob` domyślnie `run_on_wake = 1`, jednorazowy backfill istniejących jobów chroniony flagą `wake_backfill_done` w tabeli `state`.
- **Unit 2 — fix strefy + pure `computeMissedJobs`:** ekstrakcja czystej funkcji `(jobs, lastActive, now, timezone) → jobIds[]` budującej `new Cron(expr, { timezone })`; `detectMissedJobs` jako cienki wrapper I/O. Naprawiony bug strefy w detekcji przegapionych (wcześniej strefa była tylko w `scheduleJob`).
- **Unit 3 — `MAINTENANCE_WINDOW` w config:** stała `{ startHour: 6, startMin: 0, endHour: 6, endMin: 15 }` jako jedno źródło prawdy, eksponowana przez `GET /api/env` (`maintenance_window`). Zabezpieczona testem integracyjnym `server.env.test.js` (boot serwera → curl → asercja kształtu).
- **Unit 4 — warning UI + domyślny checkbox wake:** pure helper `overlapsMaintenanceWindow(cronExpr, window)` (reuse `parseCronForCalendar`, highFreq → zawsze overlap), warning `#maintenance-warning` reaktywnie pokazywany w `updateSchedulePreview`, checkbox „Uruchom po przebudzeniu" zaznaczony domyślnie w `openCreateModal`.

## Kluczowe decyzje

1. **Backfill jako jednorazowa migracja chroniona flagą w `state`.** Bare `UPDATE jobs SET run_on_wake=1` w `migrate()` (wołane przy każdym `getDb()`) co noc resetowałby świadome opt-outy. Guard: brak `wake_backfill_done` → `UPDATE` → ustaw flagę. Backfill czyta/zapisuje flagę bezpośrednio przez przekazany `db`, nie przez `getState/setState` (które wołają `getDb()` przed przypisaniem globalnego połączenia w trakcie `migrate`).
2. **Schema `DEFAULT 1` jest kosmetyczne.** `CREATE TABLE IF NOT EXISTS` nie przebuduje istniejącej tabeli; realny default biorą nowe joby z arg `createJob`.
3. **Pure `computeMissedJobs` osobno od I/O.** Fix strefy i collapse są unit-testowalne bez mockowania czasu/db.
4. **Jedno źródło prawdy `MAINTENANCE_WINDOW` w config, front pobiera z `/api/env`** zamiast duplikować stałą. Helper overlap przyjmuje window jako arg (pure).
5. **highFreq joby zawsze pokazują warning (świadomy over-warn, R5).** Job co N minut odpala też w oknie restartu — celowy heurystyk, potencjalny szum UX zostawiony do wizualnego potwierdzenia operatora.
6. **Scenariusze E2E przeniesione do Operator checklist.** Projekt to backend Node.js (CommonJS) + vanilla browser JS bez bundlera/harnessu E2E/`.env.e2e`. Pure helpery pokryte `node:test`, wiring DOM zweryfikowany statycznie.

## Główne pliki

- `lib/db.js` — schema `run_on_wake DEFAULT 1`, `createJob` default, guarded backfill w `migrate()`, eksport `migrate`.
- `lib/scheduler.js` — pure `computeMissedJobs`, wrapper `detectMissedJobs` z fixem strefy.
- `lib/config.js` — `MAINTENANCE_WINDOW`.
- `server.js` — `GET /api/env` zwraca `maintenance_window`.
- `public/render-helpers.js` — pure `overlapsMaintenanceWindow`.
- `public/app.js` — domyślny checkbox wake, fetch `maintenance_window`, reaktywny warning.
- `public/index.html` — element `#maintenance-warning`.
- Testy: `lib/db.test.js`, `lib/scheduler.test.js`, `public/render-helpers.test.js`, `server.env.test.js`.

## Wnioski

- **Granica doby/strefa w detekcji przegapionych musi liczyć w localtime.** Zgodne z `.claude/rules/learned-patterns.md` („Granica doby w SQLite licz w localtime") — bezpośrednia motywacja fixu R3. Strefa w `scheduleJob` nie wystarczy; każda ścieżka budująca `new Cron(expr)` musi przekazać `timezone`.
- **Migracje wołane przy każdym `getDb()` wymagają flagi idempotencji dla operacji destruktywnych** (UPDATE/resetów), inaczej cicho nadpisują stan użytkownika przy każdym starcie.
- **Granica testowalności pure vs I/O/DOM:** w stacku bez harnessu E2E split (pure → `node:test`, DOM/integracja → operator/dedykowany test bootujący serwer) pozwala osiągnąć realne pokrycie bez fałszywego E2E. Test `server.env.test.js` (proces potomny + curl) zamknął lukę P2 bez `.env.e2e`.
- **Okno restartu potwierdzone empirycznie:** restart serwisu codziennie 06:00:06–06:00:08 CEST (`journalctl -u claude-cron`, 7 dni, 21–27.06.2026). Bufor 06:00–06:15.

## Otwarte (nieblokujące) — Operator checklist / P3

- Operator: wizualne potwierdzenie czytelności warningu okna restartu i że checkbox wake jest domyślnie zaznaczony (E2E przy 06:05 → warning widoczny, 09:00 → ukryty). Niewykonalne headless.
- Findingi P3 (nity, nie blokują): shadowing parametru `window` w `overlapsMaintenanceWindow` (sugestia `maintenanceWindow`), pusty `catch {}` w `computeMissedJobs` bez logu, duplikacja `Intl...timeZone` (ekstrakcja `LOCAL_TIMEZONE`), `Object.freeze(MAINTENANCE_WINDOW)`, świadomy over-warn highFreq bez testu granicznego.
