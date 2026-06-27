# Zadania: Nadrabianie jobów przegapionych przez nocny restart VPS

**Branch:** `feature/nocny-restart-przegapione-joby`
**Ostatnia aktualizacja:** 2026-06-27

## Unit 1: `run_on_wake` opt-out — schema, createJob default, backfill
**Delegate:** feature-builder-data · **Wymagania:** R1, R2 · **Zależności:** brak

### Implementacja
- [ ] `lib/db.js:39` — schema kolumny `run_on_wake` → `DEFAULT 1` (kosmetyczne, świeże bazy)
- [ ] `lib/db.js:129` — `createJob` domyślny arg `run_on_wake = 1`, zachowaj jawne `? 1 : 0` przy bindowaniu
- [ ] `lib/db.js` `migrate()` — po `CREATE TABLE state` dodać guarded backfill (odczyt `wake_backfill_done` z `state` przez przekazany `db`; brak → `UPDATE jobs SET run_on_wake = 1` → ustaw flagę)
- [ ] `lib/db.test.js` — testy (backfill test-first, zob. niżej)

### Testy
- [ ] Test: `createJob` bez `run_on_wake` → job ma `run_on_wake === 1` (happy path R1)
- [ ] Test: `createJob({ run_on_wake: 0 })` → job ma `run_on_wake === 0` (opt-out działa)
- [ ] Test: Backfill — seed 2 joby z `run_on_wake=0` przed flagą → po `migrate` oba mają `1`, flaga `wake_backfill_done` ustawiona (R2 happy path)
- [ ] Test: Idempotencja — po backfillu ustaw ręcznie job na `0`, wywołaj `migrate` ponownie → job pozostaje `0` (flaga blokuje re-backfill, error case R2)

### Weryfikacja
- [ ] Weryfikacja: `node --test lib/db.test.js` przechodzi bez błędów
- [ ] Weryfikacja: `grep -n "DEFAULT 1" lib/db.js` pokazuje kolumnę `run_on_wake` ze schematem `DEFAULT 1`

---

## Unit 2: Fix strefy w `detectMissedJobs` + ekstrakcja pure `computeMissedJobs`
**Delegate:** feature-builder-data · **Wymagania:** R3 · **Zależności:** brak (równoległy do Unit 1)

### Implementacja
- [ ] `lib/scheduler.js` — wyciągnij pure `computeMissedJobs(jobs, lastActive, now, timezone)` (filtruje `enabled && run_on_wake`, `new Cron(expr, { timezone })`, `nextRun(lastActive) < now`; try/catch na zły cron wewnątrz)
- [ ] `lib/scheduler.js` — `detectMissedJobs` cienki wrapper: czyta `last_active_at`, `getAllJobs()`, `new Date()`, przekazuje `Intl.DateTimeFormat().resolvedOptions().timeZone`, `enqueueJob(id, 'wake')` dla zwróconych id
- [ ] `lib/scheduler.test.js` — testy pure funkcji (test-first od scenariusza ze źródła)

### Testy
- [ ] Test: Job `0 6 * * *`, `lastActive`=dziś 5:59, `now`=dziś 6:03, strefa lokalna → `[jobId]` (happy path R3)
- [ ] Test: Ten sam job, `lastActive`=dziś 6:30, `now`=dziś 6:35 (strzelił przed downtime) → `[]` (brak podwójnego odpalenia)
- [ ] Test: N przegapionych cykli (`*/5 * * * *`, `lastActive` 30 min temu) → job dokładnie raz (collapse)
- [ ] Test: Job z `run_on_wake=0` lub `enabled=0` → pominięty (`[]`)
- [ ] Test: Zły cron (`'garbage'`) → pominięty bez rzucenia wyjątku (error case)
- [ ] Test: Strefa — ten sam `lastActive`/`now` z dwiema różnymi `timezone` daje różną granicę okna (regresja buga)

### Weryfikacja
- [ ] Weryfikacja: `node --test lib/scheduler.test.js` przechodzi bez błędów
- [ ] Weryfikacja: `grep -n "timezone" lib/scheduler.js` pokazuje strefę w ścieżce detekcji przegapionych (nie tylko w `scheduleJob`)

---

## Unit 3: `MAINTENANCE_WINDOW` w config.js + ekspozycja przez `/api/env`
**Delegate:** feature-builder-data · **Wymagania:** R4 · **Zależności:** brak

### Implementacja
- [ ] `lib/config.js` — dodaj `MAINTENANCE_WINDOW = { startHour: 6, startMin: 0, endHour: 6, endMin: 15 }` + eksport; komentarz z odwołaniem do potwierdzenia empirycznego
- [ ] `server.js:178-181` — `GET /api/env` zwraca `maintenance_window: MAINTENANCE_WINDOW`

### Testy
- [ ] Test: (pokrycie pośrednie w Unit 4) helper overlap przyjmuje ten kształt window i poprawnie klasyfikuje

### Weryfikacja
- [ ] Weryfikacja: `grep -n "MAINTENANCE_WINDOW" lib/config.js server.js` pokazuje definicję i użycie w `/api/env`
- [ ] Weryfikacja: `node --test` (cały suite) przechodzi bez regresji

### Operator checklist *(brak `.env.e2e`)*
- [ ] Operator odpala serwer i `curl localhost:7777/api/env` → widzi `maintenance_window` z `startHour: 6`

---

## Unit 4: Warning okna restartu + domyślny checkbox wake + pure helper overlap
**Delegate:** feature-builder-ui · **Wymagania:** R1 (UI default), R5 · **Zależności:** Unit 3

### Implementacja
- [ ] `public/render-helpers.js` — pure `overlapsMaintenanceWindow(cronExpr, window)` (reuse `parseCronForCalendar`; `null` → false; `highFreq` → true; inaczej porównaj `{hour, minute}` z `[start, end]`) + eksport w `api`
- [ ] `public/app.js` — `openCreateModal` → `form-wake.checked = true`; jednorazowy fetch `maintenance_window` z `/api/env`; w `updateSchedulePreview` policz overlap dla `buildCronFromForm()` i pokaż/ukryj warning
- [ ] `public/index.html:217` — `<div id="maintenance-warning" class="hint" hidden>` obok `#schedule-preview`; treść „⚠ Pokrywa się z nocnym restartem VPS (06:00) — zostanie nadrobione po starcie"
- [ ] `public/render-helpers.test.js` — testy pure helpera (test-first)

### Testy
- [ ] Test: `overlapsMaintenanceWindow('0 6 * * *', window)` → `true` (job dokładnie o 6:00)
- [ ] Test: `overlapsMaintenanceWindow('10 6 * * *', window)` → `true` (6:10 w oknie)
- [ ] Test: `overlapsMaintenanceWindow('0 9 * * *', window)` → `false` (9:00 poza oknem)
- [ ] Test: `overlapsMaintenanceWindow('*/5 * * * *', window)` → `true` (highFreq odpala też w oknie)
- [ ] Test: `overlapsMaintenanceWindow('', window)` / niepoprawny → `false` (brak crashu, error case)
- [ ] Test (E2E): otwórz formularz nowego joba → checkbox „Uruchom po przebudzeniu" zaznaczony domyślnie (R1)
- [ ] Test (E2E): freq=daily, godzina 06:05 → `#maintenance-warning` widoczny; zmień na 09:00 → ukryty (R5)

### Weryfikacja
- [ ] Weryfikacja: `node --test public/render-helpers.test.js` przechodzi bez błędów
- [ ] Weryfikacja: [E2E przez /agent-browser] formularz nowego joba — checkbox wake zaznaczony, godzina 06:05 pokazuje `#maintenance-warning` (`hidden` zdjęte w DOM)

### Operator checklist *(brak `.env.e2e`)*
- [ ] Operator wizualnie potwierdza, że warning jest czytelny i nie blokuje zapisu joba
