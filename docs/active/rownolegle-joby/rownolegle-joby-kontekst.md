# Równoległe joby — kontekst techniczny

**Branch:** `feature/rownolegle-joby`
**Ostatnia aktualizacja:** 2026-07-30 — Faza 1 (Unit 1-6) zaimplementowana, `npm test` 707/707

## Źródła

- Requirements doc: — (brak; ustalenia z sesji koncepcyjnej + sesji roastu 30.07)
- Plan techniczny: [docs/plans/2026-07-30-001-feat-rownolegle-joby-sprint-plan.md](../../plans/2026-07-30-001-feat-rownolegle-joby-sprint-plan.md)

## Powiązane pliki

### Rdzeń zmiany

| Plik | Rola w zadaniu | Kotwice |
|---|---|---|
| `lib/scheduler.js` | picker kwalifikowalności, pętla drain, dzwonek, karencja po wybudzeniu | `processQueue` (12-44), `computeMissedJobs` (91-111) — wzorzec czystej funkcji |
| `lib/executor.js` | mapa aktywnych runów, `killRun(runId)` | singletony (8-9), timery per-run (218-250), guard „killed" (286-291, 369-371), guard `settled` (361-391) |
| `lib/db.js` | migracje `lock_group`/`queued_at`, `getRunningRuns`, statystyki czasów | wzorzec migracji (105-120), allow-listy (169, 179), `getCurrentRun` (318), `reapOrphanedRuns` (329-341), `getQueuedRuns` (343) |
| `server.js` | `/api/runs/:id/kill`, 409, `current_runs`, ustawienie limitu | `db.getCurrentRun()` (292, 415), `executor.killCurrent()` (420), kontrakt kolejności matcherów |
| `public/app.js` + `public/index.html` | lista biegnących runów, pole grupy, ustawienie limitu | kill-bar (328-334), guard pollingu (tani podpis payloadu) |
| `lib/inbox-seed.js` | `lock_group` na jobie sync (tylko `createJob`, zero `UPDATE`) | seed rozłączny wg `state.inbox_role` |

### Pozostałe zakresy sprintu

| Plik | Rola |
|---|---|
| `lib/platform.js` | przepisanie `installMac`/`generatePlist`/`getStatus` (Faza 3); **dziś bez żadnego testu** |
| `~/Library/LaunchAgents/com.claude-cron.daemon.plist` | **działający wzorzec z 23.07** — wrapper `/bin/sh -c`, portable Node z `.node/`, logi w `~/Library/Logs/claude-cron/`, pełny blok env |
| `install.sh`, `install.ps1`, `setup.mjs` | katalog instalacji + wykrycie portu (Faza 2) |
| `scripts/sync-heartbeat.mjs` | wzorzec detekcji powrotu sieci po wybudzeniu (Faza 4) |

### Testy

`lib/db.test.js`, `lib/executor.test.js`, `lib/scheduler.test.js` (kotwica R7:
`scheduler.test.js:285` — `processQueue` rozwiązuje się po opróżnieniu kolejki),
`lib/inbox-seed.test.js`, `lib/ask.http.test.js` (wzorzec testu HTTP na żywym procesie),
`install.test.sh`, `setup.test.mjs`, `install.ps1.Tests.ps1`, nowy `lib/platform.test.js`.

## Decyzje techniczne

1. **Jeden limit + slot rezerwowy, nie dwa pasy po `job_type`.** Dane z żywej bazy: Classroom
   sync = `script`/747 s, Aktualizacja .env = `claude`/18 s. `job_type` mówi **czym się
   uruchamia**, nie **jak długo trwa**, i klasyfikuje odwrotnie w obie strony.
2. **`max_concurrent` w tabeli `state`, default 3, per maszyna.** Zero migracji schematu,
   edytowalne z dashboardu, czytane w momencie pickowania (wzorzec `notify-config.js`).
3. **Klasyfikacja: mediana z ostatnich 10 udanych runów < 60 s = krótki.** Mediana, nie średnia
   (inbox sync: typowo 0,2 s, maksimum 975 s po śnie maszyny). Tylko udane runy — timeout mówi
   o limicie, nie o pracy.
4. **Brak historii = długie (fail-safe).** Koszt pomyłki asymetryczny: „nowy uznany za krótki,
   a jest 12-minutowy" blokuje slot rezerwowy i łamie jedyną gwarancję planu.
5. **Próg 60 s bezpieczny** — rozkład czasów jest bimodalny: 747, 346, 298, 293, 165, 115 ‖ 18,
   2, 0 s. Między 18 a 115 s nie ma nic.
6. **Dzwonek: pętla drain czeka na `Promise.race([...aktywne, sygnał nowej pracy])`**,
   `enqueueJob` rozwiązuje sygnał. Bez tego re-pick następuje dopiero po zakończeniu któregoś
   runu i cała zmiana jest no-opem. Guard `queueProcessing` zostaje (jedna pętla naraz).
7. **Wyłączność — trzy reguły, dwie automatyczne:** ten sam `job_id`; ten sam niepusty
   `skill_name` lub `command`; ta sama niepusta `lock_group`.
8. **Model fail-open** (decyzja Kacpra 30.07): brak deklaracji = zgoda na równoległość.
9. **Znane kolizje harmonogramu naprawiamy harmonogramem, nie kodem** — VPS `0 */4 * * *`:
   „CC Update" vs „Aktualizacja folderu .claude"; Mac pon. 8:00: Weekly memory + Reflect.
10. **Picker jako czysta funkcja** `pickEligibleRuns({...})` — wzorzec `computeMissedJobs`.
    Jedyny sposób na przetestowanie kombinatoryki limit × rezerwa × 3 reguły bez spawnów.
11. **`queued_at` na `runs`** — dziś czas oczekiwania w kolejce jest niemierzalny.
12. **`/ask` poza limitem** — ma własne bramki (lock sync + 3 sloty tła) i od tygodni utrzymuje
    do 4 równoległych procesów `claude` w produkcji. To empiryczne obalenie uzasadnienia
    „1 ciężki naraz, bo zasoby" z dokumentu źródłowego.

## Pułapki z bazy wiedzy (`docs/solutions/`)

- **Świeży odczyt z DB, nie obiekt z pamięci** — `2026-07-03-stale-obiekt-w-pamieci-vs-stan-db-martwe-retry.md`.
  Retry w nowej pętli musi dalej czytać `db.getRunWithPayload(run.id)`. Plus: „gdy moduł A zakłada
  zachowanie B — napisz test integracyjny A+B".
- **`'close'` nie zawsze przychodzi** — `2026-07-14-close-nie-odpala-wnuk-dziedziczy-pipe-wyciek-slotu.md`.
  Zwolnienie wpisu w mapie domykaj na `'exit'` z karencją, idempotentnie.
- **Wyścig async przy starcie** — `2026-07-28-async-seed-vs-sync-scheduler-job-bez-harmonogramu.md`.
  Test musi odtwarzać kolejność startu, nie tylko wołać obie strony.
- **BigInt na agregatach `node:sqlite`** — `2026-06-29-migracja-better-sqlite3-na-node-sqlite.md`.
  Mediana liczona w JS z timestampów, nie agregatem SQL.
- **Backfill w `migrate()` clobberuje decyzje usera** — `2026-06-27`. W tym zadaniu backfillu
  **nie ma** i mieć nie może.
- **Top-N per grupa = window function** — `2026-06-23`. Tu pytamy per pojedynczy job, więc
  `LIMIT 10` jest poprawne; przy statystykach dla wszystkich jobów naraz obowiązuje `ROW_NUMBER()`.
- **Instalator: `curl|bash` i tty** — `2026-06-30`; **blokady plików na Windowsie i cache raw**
  — `2026-07-28`; **fałszywe sygnały statusów CLI** — `2026-07-03` (dotyczy `getStatus()` launchd).

## Zależności

- **Wewnętrzne:** Unit 3 zależy od 1 i 2; Unit 4 od 1-3; Unit 5 od 4; Unit 9 od 3.
  Fazy 2 i 3 są niezależne od reszty.
- **Zewnętrzne:** skill `puls` (`skills/puls/SKILL.md` w repo → `~/.claude/skills/puls`) musi
  wyjść razem z deployem — dostanie nowy kod 409.
- **Runtime:** Node ≥ 22.13 (`node:sqlite`), bez nowych zależności npm.
- **Operacyjne:** zmiana cronów na VPS-ie i Macu (rozstrzelenie kolizji) — poza kodem.

## Stan realizacji — Faza 1 (30.07)

Unit 1-6 zamknięte. `npm test`: **707/707 pass, 0 fail** (baseline 640 → 67 nowych testów,
zero modyfikacji istniejących — R7 utrzymane). Zero nowych zależności npm.

### Decyzje podjęte w implementacji (poza literalnym brzmieniem planu)

1. **Kształt `getQueueWaitStats(hours = 24)` → `{ count, avgMs, maxMs }`** (Unit 1). `count`
   dołożony, bo bez liczby próbek średnia jest nieinterpretowalna. Okno liczone po
   `started_at >= cutoff` — metryka dotyczy runów, które **w oknie wystartowały**; plan nie
   precyzował znacznika.
2. **`killRun` zapisuje `killed` do DB PRZED ubiciem procesu** (Unit 2) — to realizacja kontraktu
   z planu, ale **odwrócenie kolejności** względem starego `killCurrent` (bił, potem zapisywał).
   Stąd kontrakt „killed milczy" działa teraz także przy równoległych runach.
3. **`killCurrent()` przy >1 aktywnych zwraca `null`, nie `false`** (Unit 2). `null` jest falsy,
   więc stary call-site degraduje się do „nie zabito"; Unit 4 rozróżnia `null` od `false`, żeby
   zwrócić **409** zamiast cichego „nic nie zrobiono".
4. **Eksporty spoza listy planu:** `executor.getActiveRuns()` (snapshot `{runId, jobId, startedAt}`
   bez uchwytów do procesów — karmi picker i testy), stała `EXIT_RELEASE_GRACE_MS` (test czeka na
   karencję, nie zgaduje liczby). Timer SIGKILL dostał `.unref()` (wzorzec `lib/ask.js:175`).
5. **Dzwonek dzwoni także z `processQueue()`**, nie wyłącznie z `enqueueJob` (Unit 3). Powód:
   `server.js` (webhook) tworzy run przez `db.createRun` i woła `processQueue()` z pominięciem
   `enqueueJob` — bez tego R1 byłby złamany na ścieżce webhooka.
6. **Walidator limitu mieszka w `lib/scheduler.js`**, nie w `server.js` (Unit 4): czysta funkcja
   `sanitizeMaxConcurrent` + `MAX_CONCURRENT_CEILING = 10` obok `readMaxConcurrent`. Wzorzec
   `notify-config.js` (walidację ma moduł-właściciel domeny); `server.js` nie jest unit-testowalny,
   bo przy `require` startuje DB i scheduler.
7. **Endpoint limitu: `GET/PUT /api/settings/concurrency`** (nazwa wzorowana na
   `/api/settings/notifications`). Odpowiedź minimalna `{max_concurrent}` — sufit komunikowany
   wyłącznie w treści błędu 400, bez pól „na przyszłość". **Bez guardu CSRF** (`isCrossOriginRequest`)
   — endpoint nie zwraca ani nie przyjmuje sekretu, a ten guard jest zastrzeżony dla odpowiedzi
   z tokenami (`/api/inbox/members`). Za guardem XFF, jak cały dashboard.
8. **Testy HTTP (`server.runs.test.js`) używają script-jobów ze śpiącym `node`**, nie atrapy CLI
   Claude — ścieżka skryptowa nie odpala `caffeinate` i nie wymaga shebanga, więc scenariusz
   „dwa runy naraz" działa identycznie na macOS/Linux/Windows, a `killRun` jest wspólny dla obu
   ścieżek. Użyte override'y: `CLAUDE_CRON_DB_PATH`, `CLAUDE_CRON_INBOX_DB_PATH`,
   `CLAUDE_CRON_WORKSPACE` (`CLAUDE_CRON_CLAUDE_BIN` nie był potrzebny).
9. **Kill-bar przepisany na kolumnę + siatkę wierszy** (`public/style.css`: `.kill-rows`,
   `.kill-row`, `.kill-dur`) — stary flex poziomy był zaprojektowany na JEDEN run i przy dwóch
   wychodził poza ekran. Zmiana wyłącznie layoutowa, w istniejącym języku wizualnym.
10. **`pollSignature` rozszerzony o identyfikatory biegnących runów** (`render-helpers.js`). Sam
    `current_run` to tylko PIERWSZY z biegnących, więc start/koniec drugiego runu nie odświeżałby
    historii. Istniejące testy podpisu przechodzą bez zmian.
11. **`killCurrent()` usunięty z `public/app.js`** (martwy kod po przejściu na kill per wiersz).
    Endpoint `POST /api/runs/current/kill` po stronie serwera **zostaje** — shim dla skilla `/puls`
    i starych klientów.
12. **Modal limitu chodzi przez `apiBase()`** (respektuje przełącznik LOKALNY/VPS), inaczej niż
    modal powiadomień, który celowo jest local-only. Limit jest własnością maszyny odpalającej
    agentów, a endpoint nie przenosi sekretu — proxy `/api/vps/*` przekazuje body PUT-a.
13. **`CLAUDE.md` linia 38** („executor (jeden na raz)") poprawiona razem z sekcją o schedulerze —
    po tej fazie było to zdanie nieprawdziwe. Skill `/puls` opisuje dodatkowo
    `GET/PUT /api/settings/concurrency` (bez tego zdanie „prawdziwą dźwignią jest podniesienie
    limitu" nie miałoby jak być wykonane przez agenta).

### Dług do domknięcia

- **`lib/scheduler.js` ma 426 linii** (limit z `.claude/rules/coding-rules.md` = 300). Podziału
  świadomie **nie** robiono w tej fazie — plan wskazywał wyłącznie ten plik, a nieplanowany
  refaktor rdzenia razem ze zmianą zachowania byłby zmianą na ślepo. Kandydat na osobny krok.
- **Trzy scenariusze `[E2E]` z Unit 5 nie zostały odegrane** (dwa wiersze aktywnych runów, zapis
  pola „Grupa wyłączności", trwałość „ile zadań naraz"). Wymagają żywego dashboardu przez
  `/agent-browser`; pokrycie jednostkowe helperów (`activeRunRows`, `activeRunsSignature`,
  `formatElapsed`, `runningRunsFrom`) i testy HTTP na żywym serwerze są zielone.
- **Kroki `Operator:`** (rozstrzelenie cronów na VPS i Macu, ustawienie `max_concurrent`) — poza
  kodem, do wykonania przy deployu.

## Kontrakty, których nie wolno naruszyć

1. **640 istniejących testów przechodzi bez modyfikacji** — w szczególności
   `scheduler.test.js:285` (`processQueue` rozwiązuje się po opróżnieniu kolejki).
2. **„Killed milczy"** — zapis `killed` do DB **przed** ubiciem procesu, per `run.id`.
3. **Guard `settled` + ratunkowy timer** (naprawa 29.07) — czyszczą swój wpis w mapie zamiast
   zerować singleton.
4. **Sleep-aware timeouty** (`startSleepAwareTimeout`, 29.07) — nietknięte.
5. **Seed nigdy nie robi `UPDATE` istniejących jobów** — chroni ręczne wyłączenia usera.
6. **Kolejność matcherów w `server.js`:** webhook → ask → inbox → guard XFF → api/static.
   Ustawienie limitu jest prywatne, więc leży **za** guardem.
