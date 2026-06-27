---
title: "feat: Nadrabianie jobów przegapionych przez nocny restart VPS (run_on_wake opt-out + warning okna restartu)"
type: feat
status: active
date: 2026-06-27
origin: docs/plans/2026-06-26-nocny-restart-vps-przegapione-joby-ustalenia.md
design_md: null          # brak docs/DESIGN.md; feature dodaje tylko tekstowy hint (reuse klasy .hint)
figma_spec: null         # brak mockupów — drobny warning, projektowany z istniejącego wzorca .hint
figma_screens: {}
---

# feat: Nadrabianie jobów przegapionych przez nocny restart VPS

## Przegląd

VPS robi co noc auto-update (`git pull` + `systemctl restart claude-cron`) o **6:00**.
`croner` trzyma harmonogram tylko w RAM (`activeJobs` Map), więc job zaplanowany w oknie
restartu przepada bez śladu — brak nawet runu `failed`. Mechanizm nadrabiania
(`detectMissedJobs` + flaga `run_on_wake`) **już istnieje**, ale jest domyślnie wyłączony.

Ten plan: (1) przełącza `run_on_wake` na opt-out (domyślnie włączone + jednorazowy backfill
istniejących jobów), (2) naprawia bug strefy czasowej w `detectMissedJobs`, (3) dodaje warning
w formularzu, gdy user planuje job w oknie restartu. Killed-w-trakcie pozostaje bez zmian
(świadomie, zob. Granice scope'u).

## Ujęcie problemu

`detectMissedJobs()` (`lib/scheduler.js:85-106`) przy starcie liczy dla jobów z `run_on_wake=1`
pierwsze przegapione odpalenie w czasie przestoju (z `last_active_at` heartbeatu) i dokolejkowuje
**jeden** run `trigger='wake'`. Ma wbudowany collapse (N przegapionych cykli → 1 odpalenie) i brak
podwójnego odpalenia. Problem nie jest brakiem mechanizmu — jest domyślnym opt-outem
(`run_on_wake INTEGER DEFAULT 0`) plus bugiem strefy: detekcja tworzy `new Cron(expr)` bez
`timezone`, podczas gdy `scheduleJob` przekazuje jawnie strefę lokalną — przy serwerze z `TZ`
różną od lokalnej granica okna policzy się źle (zob. źródło: `2026-06-26-...-ustalenia.md`).

## Śledzenie wymagań

- **R1.** Nowo tworzone joby mają `run_on_wake` domyślnie włączone (opt-out). (decyzja #1)
- **R2.** Istniejące joby w produkcyjnej bazie VPS dostają jednorazowy backfill `run_on_wake=1`,
  **bez** nadpisywania świadomych opt-outów usera przy kolejnych restartach. (decyzja #1, potwierdzone: backfill)
- **R3.** `detectMissedJobs` liczy cron z tą samą strefą czasową co `scheduleJob`. (bug do poprawy)
- **R4.** Stała `MAINTENANCE_WINDOW` (okno 6:00–6:15) żyje w `lib/config.js` jako jedyne źródło prawdy. (decyzja #3)
- **R5.** Formularz przy zapisie/edycji joba pokrywającego się z oknem restartu pokazuje ostrzeżenie
  („pokrywa się z nocnym restartem VPS, zostanie nadrobione po starcie"). (decyzja #3)

## Granice scope'u

- **Killed-w-trakcie — bez zmian.** Reaper (`db.js:275`) dalej oznacza `killed` BEZ retry.
  Świadomie: job nieidempotentny nie powinien powtarzać częściowej pracy z efektami ubocznymi. (decyzja #2)
- **Nie zmieniamy harmonogramu auto-update na VPS** — pozostaje `0 6 * * *` (potwierdzone empirycznie, zob. niżej).
- **Brak nowego retry-on-wake** — `wake` dokolejkowuje pojedynczy run; logika retry (`scheduler.js:29`)
  pozostaje jak jest (łapie tylko `failed`).
- **Warning nie blokuje zapisu** — tylko informuje (uświadamia usera zamiast cicho ratować).

## Kontekst i research

### Potwierdzenie okna restartu (rozwiązanie otwartego pytania ze źródła)

Otwarte pytanie ze źródła („czy okno to 6:00 czy zmienione na 2:00, jak długo trwa restart")
zostało **rozwiązane empirycznie** przez `journalctl -u claude-cron` na VPS (`ssh vps`):
restart serwisu następuje **codziennie o 06:00:06–06:00:08 CEST** (7 dni z rzędu, 21–27 czerwca).
Restart NIE został zmieniony na 2:00. `install-vps.sh:437` (`0 6 * * *`) i README:379 zgadzają się
z rzeczywistością. Sam restart zajmuje ~kilka sekund, więc okno **6:00–6:15** to bezpieczny bufor
(uwzględnia wolniejszy `git pull` w dni z dużą zmianą).

### Relevantny kod i wzorce

- `lib/scheduler.js:51-66` — `scheduleJob` buduje `new Cron(expr, { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })`. Wzorzec strefy do skopiowania w `detectMissedJobs`.
- `lib/scheduler.js:85-106` — `detectMissedJobs`; tu wstrzykujemy fix strefy + ekstrakcję pure funkcji.
- `lib/db.js:30-117` — `migrate()`: idempotentne migracje (`ALTER TABLE` w try/catch, `PRAGMA table_info` guard). Tabela `state` tworzona w tym samym bloku — dostępna do guarda backfillu.
- `lib/db.js:310-317` — `getState`/`setState`: wzorzec flagi jednorazowej (`INSERT OR REPLACE`).
- `lib/db.js:129` — `createJob`, domyślny arg `run_on_wake = 0` → zmiana na `1`.
- `public/render-helpers.js:71-97` — `parseCronForCalendar(expr)` zwraca `{ highFreq, hour, minute, dow }`. Reuse do wyliczenia godziny odpalenia w helperze overlap. UMD: `module.exports` (node) + `root.RenderHelpers` (browser).
- `public/render-helpers.test.js` — wzorzec testów pure funkcji frontu (node:test, AAA).
- `public/app.js:798-819` — `openCreateModal`: `form-wake.checked = false` → `true` (R1, UI default).
- `public/app.js:894-926` — `saveJob`: punkt, w którym warning może się pojawić; oraz `updateSchedulePreview` (`app.js:265`) przy zmianie harmonogramu.
- `public/index.html:217` — `#schedule-preview` (klasa `.hint`); obok niego element warningu.
- `server.js:178-181` — `GET /api/env`; rozszerzamy o `maintenance_window` (config → front).
- `lib/scheduler.test.js`, `lib/db.test.js` — wzorzec testów (`:memory:` DI, AAA, node:test).

### Wiedza instytucjonalna

- `.claude/rules/learned-patterns.md`: „Granica doby w SQLite licz w localtime" i ostrzeżenie
  UTC-vs-localtime. Bezpośrednio motywuje R3 (fix strefy) — goła `new Cron(expr)` bez `timezone`
  cicho przesuwa granicę okna o offset strefy.

## Kluczowe decyzje techniczne

- **Backfill jako jednorazowa migracja chroniona flagą w `state`.** Bare `UPDATE jobs SET run_on_wake=1`
  w `migrate()` wykonywałby się przy KAŻDYM starcie (migrate woła się z każdym `getDb()`), co co noc
  resetowałoby świadome opt-outy usera. Guard: sprawdź `state['wake_backfill_done']`; jeśli brak → wykonaj
  `UPDATE` → ustaw flagę. To realizuje R2 bez clobberowania opt-outów.
- **Schema `DEFAULT 1` jest kosmetyczne, realne zachowanie z `createJob`.** `CREATE TABLE IF NOT EXISTS`
  nie przebuduje istniejącej tabeli, a `createJob` zawsze przekazuje `run_on_wake` jawnie. Zmiana
  `db.js:39` na `DEFAULT 1` jest dla spójności/świeżych baz; nowe joby biorą default z arg `createJob` (R1).
- **Ekstrakcja `computeMissedJobs(...)` jako pure funkcja.** `detectMissedJobs` miesza I/O (db, `new Date()`)
  z logiką. Wyciągamy czystą funkcję `(jobs, lastActive, now, timezone) → jobIds[]` budującą
  `new Cron(expr, { timezone })`, by fix strefy + collapse były unit-testowalne bez mockowania czasu/db
  (wzorzec render-helpers). `detectMissedJobs` zostaje cienkim wrapperem I/O.
- **`MAINTENANCE_WINDOW` w config.js + ekspozycja przez `/api/env`.** Jedno źródło prawdy (config),
  front pobiera wartość z API zamiast duplikować stałą. Helper overlap jest pure i przyjmuje window jako arg.
- **Warning to pure helper `overlapsMaintenanceWindow(cronExpr, window)`.** Reuse `parseCronForCalendar`
  do godziny odpalenia; testowalny w `render-helpers.test.js`. `highFreq` (co N min/godz) traktujemy jako
  pokrywające się (odpala też w oknie).

## Otwarte pytania

### Rozwiązane podczas planowania

- **Okno restartu = 6:00, nie 2:00.** Potwierdzone empirycznie z `journalctl` na VPS (7 dni). Window = 6:00–6:15.
- **Backfill istniejących jobów?** Tak — jednorazowy, chroniony flagą `state` (potwierdzone przez usera).
- **Gdzie front bierze stałą okna?** Z `/api/env` (config = źródło prawdy).

### Odroczone do implementacji

- **Dokładny kształt obiektu `MAINTENANCE_WINDOW`** (np. `{ startHour, startMin, endHour, endMin }` vs minuty-od-północy) — wybór po dotknięciu helpera overlap; bez wpływu na architekturę.
- **Czy `highFreq` joby (co N min) w ogóle pokazują warning** — domyślnie tak; do potwierdzenia wzrokowo w UI, czy nie jest to szum (większość high-freq jest idempotentna).
- **Dokładna treść/placement warningu** (pod `#schedule-preview` vs przy checkboxie wake) — drobny detal UX do dopięcia w trakcie.

## Implementation Units

- [x] **Unit 1: `run_on_wake` opt-out — schema, createJob default, jednorazowy backfill**

**Cel:** Nowe joby domyślnie `run_on_wake=1`; istniejące joby w bazie dostają jednorazowy backfill bez clobberowania opt-outów.

**Wymagania:** R1, R2

**Zależności:** Brak

**Pliki:**
- Modyfikuj: `lib/db.js` (schema `:39` → `DEFAULT 1`; `createJob` `:129` → domyślny arg `run_on_wake = 1`; w `migrate()` po `CREATE TABLE state` dodać guarded backfill)
- Test (unit): `lib/db.test.js`

**Delegate to:** feature-builder-data

**Skills in play:** supabase-dev-guidelines, security, sentry-integration

**Podejście:**
- W `migrate(db)`: po blokach `CREATE TABLE` odczytaj flagę `wake_backfill_done` z tabeli `state` (przez przekazany `db`, nie `getDb()`). Jeśli brak → `UPDATE jobs SET run_on_wake = 1` → `INSERT OR REPLACE INTO state` ustaw flagę. Idempotentne i jednorazowe.
- `createJob` default arg `run_on_wake = 1`. Zachowaj jawne `? 1 : 0` przy bindowaniu (createJob pozwala wyłączyć).
- Schema `DEFAULT 1` dla spójności świeżych baz (kosmetyczne — realne nowe joby biorą z arg).

**Notatka wykonawcza:** Backfill test-first — najpierw test „seed job z run_on_wake=0 → po (ponownym) migrate flaga ustawiona, job=1; po ręcznym opt-oucie i kolejnym migrate job zostaje 0".

**Wzorce do naśladowania:**
- `lib/db.js:104-116` (guard `PRAGMA table_info` / idempotentna migracja), `lib/db.js:310-317` (`getState`/`setState`).

**Scenariusze testowe:**
- [Unit] `createJob` bez `run_on_wake` → utworzony job ma `run_on_wake === 1` (happy path R1).
- [Unit] `createJob({ run_on_wake: 0 })` → job ma `run_on_wake === 0` (opt-out działa).
- [Unit] Backfill: seed 2 joby z `run_on_wake=0` przed ustawioną flagą → po `migrate` oba mają `1`, flaga `wake_backfill_done` ustawiona (R2 happy path).
- [Unit] Idempotencja: po backfillu ustaw ręcznie job na `0`, wywołaj `migrate` ponownie → job pozostaje `0` (flaga blokuje re-backfill; opt-out nie jest clobberowany — error case R2).

**Weryfikacja:**
- `node --test lib/db.test.js` przechodzi bez błędów.
- `grep -n "DEFAULT 1" lib/db.js` pokazuje kolumnę `run_on_wake` ze schematem `DEFAULT 1`.

---

- [x] **Unit 2: Fix strefy czasowej w `detectMissedJobs` + ekstrakcja pure `computeMissedJobs`**

**Cel:** Detekcja przegapionych jobów liczy cron z tą samą strefą co `scheduleJob`; logika collapse/strefy staje się unit-testowalna.

**Wymagania:** R3

**Zależności:** Brak (równoległy do Unit 1)

**Pliki:**
- Modyfikuj: `lib/scheduler.js` (wyciągnij pure `computeMissedJobs(jobs, lastActive, now, timezone)`; `detectMissedJobs` przekazuje `Intl.DateTimeFormat().resolvedOptions().timeZone` i woła pure funkcję)
- Test (unit): `lib/scheduler.test.js`

**Delegate to:** feature-builder-data

**Skills in play:** supabase-dev-guidelines, security, sentry-integration

**Podejście:**
- Pure `computeMissedJobs(jobs, lastActive, now, timezone)`: filtruje `enabled && run_on_wake`, dla każdego buduje `new Cron(job.cron_expr, { timezone })`, liczy `cron.nextRun(lastActive)`, zwraca id-ki gdzie `nextFromLast && nextFromLast < now`. Bez I/O, bez `new Date()` w środku — `now`/`lastActive`/`timezone` jako argumenty.
- `detectMissedJobs` zostaje cienkim wrapperem: czyta `last_active_at`, `getAllJobs()`, `new Date()`, woła pure funkcję, dla zwróconych id-ków `enqueueJob(id, 'wake')`. Try/catch na zły cron zostaje wewnątrz pure funkcji (skip invalid).

**Notatka wykonawcza:** Test-first dla pure funkcji — zacznij od scenariusza ze źródła (`0 6 * * *`, restart 5:59 → powrót 6:03) jako asercji.

**Wzorce do naśladowania:**
- `lib/scheduler.js:58` (strefa w `scheduleJob`); `public/render-helpers.js` (wzorzec ekstrakcji pure logiki + jej testów).

**Scenariusze testowe:**
- [Unit] Job `0 6 * * *`, `lastActive`=dziś 5:59, `now`=dziś 6:03, strefa lokalna → zwraca `[jobId]` (przegapione, happy path R3).
- [Unit] Ten sam job, `lastActive`=dziś 6:30, `now`=dziś 6:35 (job już strzelił przed downtime) → `[]` (brak podwójnego odpalenia).
- [Unit] N przegapionych cykli (job `*/5 * * * *`, `lastActive` 30 min temu) → job pojawia się dokładnie raz (collapse).
- [Unit] Job z `run_on_wake=0` lub `enabled=0` → pominięty (`[]`).
- [Unit] Zły cron (`'garbage'`) → pominięty bez rzucenia wyjątku (error case).
- [Unit] Strefa: ten sam `lastActive`/`now` z dwiema różnymi `timezone` daje różną granicę okna (dowodzi, że strefa jest faktycznie używana — regresja buga).

**Weryfikacja:**
- `node --test lib/scheduler.test.js` przechodzi bez błędów.
- `grep -n "timezone" lib/scheduler.js` pokazuje strefę przekazaną w ścieżce detekcji przegapionych (nie tylko w `scheduleJob`).

---

- [x] **Unit 3: `MAINTENANCE_WINDOW` w config.js + ekspozycja przez `/api/env`**

**Cel:** Stała okna restartu (6:00–6:15) w jednym źródle prawdy i dostępna dla frontu.

**Wymagania:** R4

**Zależności:** Brak

**Pliki:**
- Modyfikuj: `lib/config.js` (dodaj `MAINTENANCE_WINDOW` + eksport)
- Modyfikuj: `server.js:178-181` (`GET /api/env` zwraca `maintenance_window`)
- Test (unit): `lib/config.js` nie ma osobnego testu (czyste stałe) — pokrycie przez Unit 4 helper, który konsumuje window; weryfikacja przez grep + ręczne sprawdzenie `/api/env`

**Delegate to:** feature-builder-data

**Skills in play:** supabase-dev-guidelines, security, sentry-integration

**Podejście:**
- `MAINTENANCE_WINDOW = { startHour: 6, startMin: 0, endHour: 6, endMin: 15 }` (lub równoważny kształt minut-od-północy — do dopięcia z helperem w Unit 4). Komentarz z odwołaniem do potwierdzenia empirycznego (restart 06:00 CEST).
- `/api/env`: dorzuć `maintenance_window: MAINTENANCE_WINDOW` do istniejącego `json(res, {...})`. Import z config.

**Wzorce do naśladowania:**
- `lib/config.js:26-38` (blok stałych + eksport w `module.exports`); `server.js:5` (destrukturyzacja z config).

**Scenariusze testowe:**
- [Unit] (w `render-helpers.test.js`, Unit 4) helper overlap przyjmuje ten kształt window i poprawnie klasyfikuje — pokrycie pośrednie.
- [E2E] Scenariusz: otwórz `/` (dev e2e), w devtools/network sprawdź `GET /api/env` → odpowiedź zawiera `maintenance_window` z `startHour: 6`. *(jeśli brak `.env.e2e` → przenieś do Operator checklist)*

**Weryfikacja:**
- `grep -n "MAINTENANCE_WINDOW" lib/config.js server.js` pokazuje definicję i użycie w `/api/env`.
- `node --test` (cały suite) przechodzi bez regresji.

**Operator checklist:** *(jeśli projekt nie ma `.env.e2e`)*
- [ ] Operator odpala serwer i `curl localhost:7777/api/env` → widzi `maintenance_window`.

---

- [x] **Unit 4: Warning okna restartu w formularzu + domyślny checkbox wake + pure helper overlap**

**Cel:** Formularz pokazuje ostrzeżenie przy planowaniu joba w oknie restartu; nowy job ma domyślnie zaznaczony wake.

**Wymagania:** R1 (UI default), R5

**Zależności:** Unit 3 (`maintenance_window` z `/api/env`)

**Pliki:**
- Modyfikuj: `public/render-helpers.js` (dodaj pure `overlapsMaintenanceWindow(cronExpr, window)` + eksport w `api`)
- Modyfikuj: `public/app.js` (`openCreateModal` → `form-wake.checked = true`; pobierz `maintenance_window` z `/api/env`; w `updateSchedulePreview`/`saveJob` pokaż/ukryj warning)
- Modyfikuj: `public/index.html` (element warningu obok `#schedule-preview`, klasa `.hint`)
- Test (unit): `public/render-helpers.test.js`
- Test (e2e): `Scenariusz: otwórz formularz nowego joba, ustaw godzinę 06:05, sprawdź że pojawia się warning okna restartu; zmień na 09:00 → warning znika`

**Delegate to:** feature-builder-ui

**Skills in play:** tailwind-react-guidelines, ux-ui-guidelines, figma:figma-use, figma:figma-implement-design

**Podejście:**
- Pure `overlapsMaintenanceWindow(cronExpr, window)`: użyj `parseCronForCalendar(cronExpr)`; jeśli `null` → `false`; jeśli `highFreq` → `true` (odpala też w oknie); inaczej porównaj `{hour, minute}` z przedziałem `[start, end]` window (granice inclusive na starcie, do końca). Zwraca boolean.
- `app.js`: jednorazowy fetch `maintenance_window` (przy ładowaniu envu, obok istniejącego `/api/env`); przechowaj w module. W `updateSchedulePreview` (woła się przy każdej zmianie harmonogramu) policz overlap dla `buildCronFromForm()` i pokaż/ukryj warning element. `openCreateModal`: `form-wake.checked = true`.
- `index.html`: `<div id="maintenance-warning" class="hint" hidden>` obok `#schedule-preview`; treść: „⚠ Pokrywa się z nocnym restartem VPS (06:00) — zostanie nadrobione po starcie".

**Notatka wykonawcza:** Pure helper test-first (najpierw asercje w `render-helpers.test.js`), potem wiring w app.js.

**Wzorce do naśladowania:**
- `public/render-helpers.js:71-97` (`parseCronForCalendar` + UMD export); `public/app.js:265-275` (`updateSchedulePreview` jako punkt reaktywny); klasa `.hint` z `#schedule-preview` (`index.html:217`).

**Scenariusze testowe:**
- [Unit] `overlapsMaintenanceWindow('0 6 * * *', window)` → `true` (job dokładnie o 6:00).
- [Unit] `overlapsMaintenanceWindow('10 6 * * *', window)` → `true` (6:10 w oknie 6:00–6:15).
- [Unit] `overlapsMaintenanceWindow('0 9 * * *', window)` → `false` (9:00 poza oknem, happy path negatywny).
- [Unit] `overlapsMaintenanceWindow('*/5 * * * *', window)` → `true` (highFreq odpala też w oknie).
- [Unit] `overlapsMaintenanceWindow('', window)` / niepoprawny → `false` (brak crashu, error case).
- [E2E] Otwórz formularz nowego joba → checkbox „Uruchom po przebudzeniu" jest zaznaczony domyślnie (R1).
- [E2E] Ustaw freq=daily, godzina 06:05 → `#maintenance-warning` widoczny; zmień na 09:00 → ukryty (R5).

**Weryfikacja:**
- `node --test public/render-helpers.test.js` przechodzi bez błędów.
- [E2E przez /agent-browser] W formularzu nowego joba checkbox wake jest zaznaczony, a ustawienie godziny 06:05 pokazuje `#maintenance-warning` (widoczny w DOM, `hidden` zdjęte).

**Operator checklist:** *(jeśli projekt nie ma `.env.e2e`)*
- [ ] Operator wizualnie potwierdza, że warning jest czytelny i nie blokuje zapisu joba.

## Wpływ systemowy

- **Graf interakcji:** `detectMissedJobs` wołane raz przy starcie (`scheduler.start`); `enqueueJob('wake')` wpina się w istniejący `processQueue`. Zmiana strefy nie zmienia kontraktu — tylko poprawność granicy. Backfill wpięty w `migrate()` (każdy `getDb()`), chroniony flagą.
- **Propagacja błędów:** Pure `computeMissedJobs` łyka zły cron wewnątrz (skip), jak dziś. Backfill w try/catch migracji nie powinien blokować startu — jeśli `state` niedostępny, log + kontynuacja (fail-safe, nie fail-fast tu, bo to migracja przy starcie).
- **Ryzyka cyklu życia stanu:** Flaga `wake_backfill_done` w `state` to jedyna ochrona przed re-clobberem opt-outów — krytyczna. Test idempotencji (Unit 1) ją pokrywa.
- **Parytet surface API:** `run_on_wake` przechodzi przez `createJob`/`updateJob` (już obsłużone w `allowed`). Brak nowej kolumny — bez zmian w PUT/POST kontrakcie.
- **Pokrycie integracyjne:** Realny scenariusz „restart o 6:00 → nadrobienie o 6:03" jest dowodzony przez unit test pure funkcji (Unit 2), nie wymaga E2E z restartem procesu.

## Ryzyka i zależności

- **Backfill nadpisuje opt-outy, jeśli guard źle napisany.** Mitygacja: test idempotencji (Unit 1) jest obowiązkowy; flaga w `state` sprawdzana przed `UPDATE`.
- **Strefa serwera vs lokalna.** VPS może mieć `TZ=UTC`; `Intl...resolvedOptions().timeZone` zwróci strefę procesu Node. Po fixie obie ścieżki (`scheduleJob` + detekcja) są spójne — to jest cały sens R3. Zależność: zachowanie zależy od tego, że oba miejsca używają **tej samej** strefy (a nie „poprawnej") — co jest wystarczające dla spójności okna.
- **Unit 4 zależy od Unit 3** (`maintenance_window` z API). Sekwencjonuj 3 → 4. Units 1, 2, 3 są wzajemnie niezależne.

## Dokumentacja / Notatki operacyjne

- Po wdrożeniu: użytkownicy z jobami nieidempotentnymi w oknie ~6:00 powinni odznaczyć „Uruchom po przebudzeniu". Warning (R5) ich o tym informuje przy edycji.
- Rozważyć krótką notkę w README przy sekcji auto-update (6:00), że joby w tym oknie są nadrabiane przy starcie — opcjonalne, nie blokujące.

## Źródła i referencje

- **Dokument źródłowy:** [docs/plans/2026-06-26-nocny-restart-vps-przegapione-joby-ustalenia.md](./2026-06-26-nocny-restart-vps-przegapione-joby-ustalenia.md)
- Powiązany kod: `lib/scheduler.js:85-106` (`detectMissedJobs`), `lib/db.js:30-117` (`migrate`), `lib/config.js`, `server.js:178-181` (`/api/env`), `public/render-helpers.js:71-97`.
- Reguła instytucjonalna: `.claude/rules/learned-patterns.md` (UTC-vs-localtime).
- Potwierdzenie okna restartu: `journalctl -u claude-cron` na VPS (06:00 CEST, 21–27.06.2026); `scripts/install-vps.sh:437` (`0 6 * * *`).
