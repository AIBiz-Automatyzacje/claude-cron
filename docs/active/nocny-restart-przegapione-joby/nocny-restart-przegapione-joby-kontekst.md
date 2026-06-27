# Kontekst: Nadrabianie jobów przegapionych przez nocny restart VPS

**Branch:** `feature/nocny-restart-przegapione-joby`
**Ostatnia aktualizacja:** 2026-06-27

## Powiązane pliki

### Warstwa danych / scheduler
- `lib/scheduler.js:51-66` — `scheduleJob` buduje `new Cron(expr, { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })`. **Wzorzec strefy do skopiowania** w `detectMissedJobs` (Unit 2).
- `lib/scheduler.js:85-106` — `detectMissedJobs`; tu wstrzykujemy fix strefy + ekstrakcję pure `computeMissedJobs` (Unit 2).
- `lib/scheduler.js:29` — logika retry (łapie tylko `failed`); **bez zmian** (granica scope'u).
- `lib/db.js:30-117` — `migrate()`: idempotentne migracje (`ALTER TABLE` w try/catch, `PRAGMA table_info` guard). Tabela `state` w tym samym bloku — dostępna do guarda backfillu (Unit 1).
- `lib/db.js:39` — schema kolumny `run_on_wake` → `DEFAULT 1` (kosmetyczne, Unit 1).
- `lib/db.js:129` — `createJob`, domyślny arg `run_on_wake = 0` → zmiana na `1` (Unit 1, R1).
- `lib/db.js:275` — reaper `killed` BEZ retry; **bez zmian** (granica scope'u).
- `lib/db.js:310-317` — `getState`/`setState` (`INSERT OR REPLACE`): wzorzec flagi jednorazowej dla backfillu.
- `lib/config.js:26-38` — blok stałych + eksport w `module.exports`; tu dodajemy `MAINTENANCE_WINDOW` (Unit 3).
- `server.js:5` — destrukturyzacja z config (wzorzec importu).
- `server.js:178-181` — `GET /api/env`; rozszerzamy o `maintenance_window` (Unit 3).

### Warstwa UI
- `public/render-helpers.js:71-97` — `parseCronForCalendar(expr)` zwraca `{ highFreq, hour, minute, dow }`. Reuse w nowym `overlapsMaintenanceWindow` (Unit 4). UMD: `module.exports` (node) + `root.RenderHelpers` (browser).
- `public/render-helpers.test.js` — wzorzec testów pure funkcji frontu (node:test, AAA).
- `public/app.js:265-275` — `updateSchedulePreview` jako punkt reaktywny (woła się przy zmianie harmonogramu); tu pokaż/ukryj warning (Unit 4).
- `public/app.js:798-819` — `openCreateModal`: `form-wake.checked = false` → `true` (Unit 4, R1 UI default).
- `public/app.js:894-926` — `saveJob`: punkt zapisu.
- `public/index.html:217` — `#schedule-preview` (klasa `.hint`); obok niego element `#maintenance-warning` (Unit 4).

### Testy
- `lib/db.test.js`, `lib/scheduler.test.js` — wzorzec testów (`:memory:` DI, AAA, node:test).
- `public/render-helpers.test.js` — wzorzec testów pure funkcji frontu.

## Decyzje techniczne

1. **Backfill jako jednorazowa migracja chroniona flagą w `state`.** Bare `UPDATE jobs SET run_on_wake=1` w `migrate()` wykonywałby się przy KAŻDYM starcie (migrate woła się z każdym `getDb()`), co co noc resetowałoby świadome opt-outy. Guard: sprawdź `state['wake_backfill_done']`; jeśli brak → `UPDATE` → ustaw flagę.
2. **Schema `DEFAULT 1` jest kosmetyczne.** `CREATE TABLE IF NOT EXISTS` nie przebuduje istniejącej tabeli, a `createJob` zawsze przekazuje `run_on_wake` jawnie. Realne nowe joby biorą default z arg `createJob`.
3. **Ekstrakcja `computeMissedJobs(...)` jako pure funkcja.** `(jobs, lastActive, now, timezone) → jobIds[]` budująca `new Cron(expr, { timezone })`. Fix strefy + collapse unit-testowalne bez mockowania czasu/db. `detectMissedJobs` zostaje cienkim wrapperem I/O.
4. **`MAINTENANCE_WINDOW` w config.js + ekspozycja przez `/api/env`.** Jedno źródło prawdy; front pobiera z API zamiast duplikować stałą. Helper overlap jest pure i przyjmuje window jako arg.
5. **Warning to pure helper `overlapsMaintenanceWindow(cronExpr, window)`.** Reuse `parseCronForCalendar`; `highFreq` traktujemy jako pokrywające się (odpala też w oknie).

## Otwarte pytania (odroczone do implementacji)

- **Dokładny kształt obiektu `MAINTENANCE_WINDOW`** (`{ startHour, startMin, endHour, endMin }` vs minuty-od-północy) — wybór po dotknięciu helpera overlap; bez wpływu na architekturę.
- **Czy `highFreq` joby (co N min) w ogóle pokazują warning** — domyślnie tak; do potwierdzenia wzrokowo w UI.
- **Dokładna treść/placement warningu** (pod `#schedule-preview` vs przy checkboxie wake) — drobny detal UX.

## Zależności

- **`croner`** — `new Cron(expr, { timezone })` (już w projekcie, używane w `scheduleJob`).
- **node:test / node:sqlite (`:memory:`)** — wzorzec DI w testach.
- **Wiedza instytucjonalna:** `.claude/rules/learned-patterns.md` — „Granica doby w SQLite licz w localtime" / ostrzeżenie UTC-vs-localtime. Bezpośrednio motywuje R3 (fix strefy).
- **Sekwencja:** Unit 4 zależy od Unit 3 (`maintenance_window` z `/api/env`). Units 1, 2, 3 niezależne.

## Potwierdzenie okna restartu

Restart serwisu następuje **codziennie o 06:00:06–06:00:08 CEST** (`journalctl -u claude-cron` na VPS, 7 dni z rzędu, 21–27.06.2026). NIE zmieniony na 2:00. `scripts/install-vps.sh:437` (`0 6 * * *`) i README:379 zgadzają się z rzeczywistością. Okno **6:00–6:15** to bezpieczny bufor.

## Źródła
- Requirements doc: (brak — origin to ustalenia, nie `/dev-brainstorm`)
- Plan techniczny: [docs/plans/2026-06-27-001-feat-nocny-restart-przegapione-joby-plan.md](../../plans/2026-06-27-001-feat-nocny-restart-przegapione-joby-plan.md)
- Dokument źródłowy (ustalenia): [docs/plans/2026-06-26-nocny-restart-vps-przegapione-joby-ustalenia.md](../../plans/2026-06-26-nocny-restart-vps-przegapione-joby-ustalenia.md)
