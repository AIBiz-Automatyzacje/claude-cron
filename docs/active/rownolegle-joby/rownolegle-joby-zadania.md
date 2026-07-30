# Równoległe joby — checklista zadań

**Branch:** `feature/rownolegle-joby`
**Ostatnia aktualizacja:** 2026-07-30 (Faza 1 zaimplementowana)

Legenda: `Test:` = scenariusz testowy z planu technicznego · `Weryfikacja:` = automatyczne
kryterium PASS/FAIL · `Operator:` = krok wymagający człowieka (autopilot tego nie odznacza).

---

## Faza 1 — Równoległość

### Unit 1: Warstwa danych — kolumny, statystyki czasów, runy aktywne (M)

*Delegate to: feature-builder-data · Zależy od: —*

- [x] Migracja kolumny `lock_group TEXT` w `jobs` (`lib/db.js`, wzorzec z db.js:105-120)
- [x] Migracja kolumny `queued_at TEXT` w `runs` — **bez backfillu**, istniejące wiersze zostają `NULL`
- [x] `createRun` ustawia `queued_at` w momencie wstawienia
- [x] `lock_group` dopisane do allow-list `createJob` (db.js:169) **oraz** `updateJob` (db.js:179)
- [x] `getRunningRuns()` — `getCurrentRun` bez `LIMIT 1`; `getCurrentRun` zostaje (kompatybilność)
- [x] `getRecentSuccessDurations(jobId, limit = 10)` — czasy w ms liczone w JS, nie agregatem SQL
- [x] `getQueueWaitStats(hours)` — średnie/max oczekiwanie, runy bez `queued_at` pomijane
- [x] Test: `migrate()` odpalone dwukrotnie nie rzuca i nie duplikuje kolumn
- [x] Test: `createJob({lock_group})` zapisuje wartość; `updateJob` ją zmienia i czyści
- [x] Test: `createRun` ustawia `queued_at`; `getQueueWaitStats` pomija runy bez znacznika
- [x] Test: `getRunningRuns()` zwraca ≥2 wiersze `running`, `getCurrentRun()` dalej jeden
- [x] Test: `getRecentSuccessDurations` ignoruje `failed`/`timeout`/`killed` i runy bez `started_at`
- [x] Test: `getRecentSuccessDurations` zwraca **liczby** (`typeof === 'number'`), nie BigInt
- [x] Weryfikacja: `node --test lib/db.test.js` przechodzi bez błędów
- [x] Weryfikacja: `npm test` przechodzi w całości (640 istniejących testów bez modyfikacji)

### Unit 2: Executor — mapa aktywnych runów i kill per run (M)

*Delegate to: feature-builder-data · Zależy od: — (równolegle z Unit 1)*
*Notatka wykonawcza: zacznij od testu „dwa runy, kill jednego" — wykrywa powrót do semantyki singletonu.*

- [x] `currentProcess`/`currentRunId` → `activeRuns = Map(runId → {proc, jobId, startedAt})`
- [x] Rejestracja wpisu **synchronicznie** po udanym spawnie (obie ścieżki: claude i script)
- [x] Wyrejestrowanie w `close`/`error`/`finishScriptRun` — idempotentne, domknięte także na `'exit'` z karencją
- [x] `killCurrent()` → `killRun(runId)`; zapis `killed` do DB **przed** ubiciem procesu
- [x] `killCurrent()` zostaje jako shim: 0 → `false`, 1 → kill, >1 → sygnał niejednoznaczności
- [x] `isRunning()` → `activeRuns.size > 0`, `getCurrentRunId()` → pierwszy klucz (shimy dla R7)
- [x] Timery, guard `settled` i guard „kill przez usera" — bez zmian semantycznych
- [x] Test: dwa runy skryptowe równocześnie — `killRun(id1)` kończy run 1 jako `killed`, run 2 jako `success`
- [x] Test: `killRun` zapisuje `killed` przed ubiciem — `close` nie nadpisuje na `failed` i **nie wysyła ❌**
- [x] Test: `killRun(nieistniejący)` zwraca `false` i nie rzuca
- [x] Test: po zakończeniu obu runów `activeRuns.size === 0` i `isRunning() === false`
- [x] Test: proces bez `'close'` (ratunkowy timer) też zwalnia wpis w mapie
- [x] Weryfikacja: `node --test lib/executor.test.js` przechodzi
- [x] Weryfikacja: `npm test` przechodzi w całości

### Unit 3: Scheduler — picker, slot rezerwowy, dzwonek (L) 🔴 rdzeń

*Delegate to: feature-builder-data · Zależy od: Unit 1, Unit 2*
*Notatka wykonawcza: test-first dla obu czystych funkcji i dla scenariusza „krótki dokolejkowany w trakcie długiego".*

- [x] Czysta funkcja `classifyJob(durations, thresholdMs)` → `'short' | 'long'`; pusta historia → `'long'`
- [x] Czysta funkcja `pickEligibleRuns({queued, jobsById, activeRuns, durationsByJob, maxConcurrent, fastThresholdMs})`
- [x] Reguła: globalny limit `maxConcurrent` (z `state`, default 3, sanityzacja ≥ 1)
- [x] Reguła: zadania długie najwyżej `maxConcurrent - 1` (min 1) — reszta to rezerwa dla krótkich
- [x] Reguła: brak aktywnego runu tego samego `job_id`
- [x] Reguła: brak aktywnego runu joba o tym samym niepustym `skill_name` **lub** `command`
- [x] Reguła: brak aktywnego runu z tą samą niepustą `lock_group`
- [x] Pętla drain: startuj kwalifikujące się → `Promise.race([...aktywne, sygnał])` → re-pick
- [x] **Dzwonek** — `enqueueJob` rozwiązuje sygnał nowej pracy; po wybudzeniu tworzony świeży
- [x] Guard `queueProcessing` zostaje; `processQueue()` nadal rozwiązuje się po opróżnieniu kolejki
- [x] Retry-check przeniesiony bez zmian semantycznych (świeży odczyt z DB + `countRecentFailedRuns`)
- [x] `max_concurrent` czytane w momencie pickowania (zmiana z dashboardu bez restartu)
- [x] Test: `classifyJob` — mediana odporna na wartość odstającą (`[0.2, 0.2, 0.3, 975]` → krótki)
- [x] Test: `classifyJob` — pusta historia → długi; wartość dokładnie na progu → długi
- [x] Test: przy `maxConcurrent=3` i dwóch aktywnych długich trzeci długi **nie** startuje, krótki **tak**
- [x] Test: nigdy dwa runy tego samego `job_id`
- [x] Test: dwa joby o tym samym `skill_name` nie biegną razem (bez deklaracji); to samo dla `command`
- [x] Test: dwa joby z `lock_group='dashboard'` nie biegną razem; drugi startuje po pierwszym (FIFO po `id ASC`)
- [x] Test: **(odbiór R1)** krótki run dokolejkowany **w trakcie** długiego kończy się **przed** nim
- [x] Test: retry (R9) działa przy równoległym drainie — fail → retry → ❌ dokładnie raz
- [x] Test: `processQueue()` rozwiązuje się po opróżnieniu kolejki (`scheduler.test.js:285` bez zmian)
- [x] Test: zmiana `max_concurrent` w `state` w trakcie życia procesu wpływa na kolejny pick
- [x] Weryfikacja: `node --test lib/scheduler.test.js` przechodzi
- [x] Weryfikacja: `npm test` przechodzi w całości — 640 istniejących testów bez modyfikacji

### Unit 4: API — kill per run, lista aktywnych, ustawienie limitu (M)

*Delegate to: feature-builder-data · Zależy od: Unit 1-3*

- [x] `POST /api/runs/:id/kill` — kill konkretnego runu
- [x] `POST /api/runs/current/kill` — 1 aktywny → kill; **>1 → 409 z listą**; 0 → jak dziś
- [x] `GET /api/status` — nowe `current_runs` (tablica); `current_run` = pierwszy element
- [x] `GET/PUT` ustawienia `max_concurrent` — walidacja (liczba całkowita ≥ 1, rozsądny sufit)
- [x] Endpoint ustawień **za** guardem XFF (kontrakt kolejności matcherów nienaruszony)
- [x] Test: `POST /api/runs/:id/kill` ubija wskazany run, drugi aktywny żyje
- [x] Test: `POST /api/runs/current/kill` przy dwóch aktywnych → **409** + lista w treści
- [x] Test: `POST /api/runs/current/kill` przy jednym aktywnym → zachowanie jak dziś
- [x] Test: `GET /api/status` zwraca `current_runs` jako tablicę i `current_run` = pierwszy element
- [x] Test: `PUT` limitu odrzuca `0`, ujemne i tekst; przyjmuje `1` i `5`
- [x] Test: żądanie z `X-Forwarded-For` na endpoint ustawień → 403
- [x] Weryfikacja: `npm test` przechodzi w całości
- [x] Weryfikacja: `grep` w `server.js` potwierdza, że `/webhook`, `/ask`, `/inbox/v1` stoją **przed** guardem XFF, a ustawienia **za** nim

### Unit 5: Dashboard — lista biegnących runów, pole grupy, ustawienie limitu (M)

*Delegate to: feature-builder-ui · Zależy od: Unit 4*

- [x] Kill-bar (`public/app.js:328-334`) → lista wierszy: nazwa joba + czas + „Zatrzymaj" per wiersz
- [x] Formularz joba: opcjonalne pole „Grupa wyłączności" z krótkim wyjaśnieniem
- [x] Ustawienia: „Ile zadań naraz" + informacja o slocie rezerwowym i zasięgu per maszyna
- [x] Zachowany guard pollingu (tani podpis payloadu — bez tego lista migocze co 3 s)
- [x] Test: czysty helper renderujący wiersz aktywnego runu (jeśli wyjdzie poza interpolację → `public/render-helpers.js` + test)
- [ ] Test: [E2E] dashboard z dwoma równoczesnymi runami pokazuje **dwa** wiersze; „Zatrzymaj" w pierwszym zostawia drugi (SKIP po review fazy 1 — Operator checklist)
- [ ] Test: [E2E] zapis i odczyt pola „Grupa wyłączności" po przeładowaniu (SKIP po review fazy 1 — Operator checklist)
- [ ] Test: [E2E] zmiana „ile zadań naraz" przeżywa przeładowanie strony (SKIP po review fazy 1 — Operator checklist)
- [x] Weryfikacja: `npm test` przechodzi (helpery frontu)
- [ ] Weryfikacja: scenariusz E2E przez `/agent-browser` — dwa wiersze aktywnych runów widoczne jednocześnie (screenshot), po „Zatrzymaj" zostaje jeden (SKIP — dashboard w przeglądarce nieodegrany; równoważny scenariusz zweryfikowany wyłącznie na poziomie HTTP na odizolowanej instancji → Operator checklist)

### Unit 6: Seed, harmonogramy i dokumentacja (S)

*Delegate to: feature-builder-data · Zależy od: Unit 1, Unit 3*

- [x] `lib/inbox-seed.js` — job „Team OS — inbox sync" dostaje `lock_group: 'dashboard'` **tylko w `createJob`**
- [x] Skill `puls` (`skills/puls/SKILL.md`) — opis pola grupy, zasada klasyfikacji, kod **409** przy `current/kill`
- [x] `CLAUDE.md` — sekcja o `scheduler.js` opisuje limit + slot rezerwowy + klasyfikację z pomiaru
- [x] `docs/CONCEPTS.md` — hasła „zadanie krótkie / długie" i „slot rezerwowy"
- [x] Test: seed nadaje `lock_group='dashboard'` przy tworzeniu joba sync
- [x] Test: seed przy istniejącym jobie **nie** modyfikuje jego `lock_group` ani `enabled`
- [x] Weryfikacja: `node --test lib/inbox-seed.test.js` przechodzi
- [x] Weryfikacja: `grep -c "lock_group" skills/puls/SKILL.md` > 0 (= 5)
- [ ] Operator: przesunąć cron „CC Update" na VPS-ie, by nie pokrywał się z „Aktualizacja folderu .claude"
- [ ] Operator: rozstrzelić poniedziałkowy blok 8:00 na Macu (Weekly memory + Reflect tygodniowy)
- [ ] Operator: ustawić `max_concurrent` (VPS: 3, Mac: 2) i obserwować tydzień

---

## Do poprawy po review fazy 1

*Raport: `docs/active/rownolegle-joby/review-faza-1.md` · Gate: ⚠️ ZASTRZEŻENIA (0×P1, 5×P2)*

- [x] 🟠 [P2] **server.js:295** — Nowe endpointy mutujące (`PUT /api/settings/concurrency`, `POST /api/runs/:id/kill`, `POST /api/runs/current/kill`) bez guardu cross-origin przy globalnym `Access-Control-Allow-Origin: *` — dowolna strona odwiedzona przez usera podmienia limit współbieżności i ubija biegnące runy (preflight przechodzi, kill to simple request). Guard XFF tego NIE łapie (żądanie z przeglądarki idzie bez `X-Forwarded-For` — learned pattern 2026-07-24). Fix: `isCrossOriginRequest(req)` → 403 na gałęziach `server.js:302`, `server.js:452`, `server.js:464`, wzorem `/api/inbox/members` (server.js:502). Proxy `/api/vps/*` nie wysyła `Origin`, więc guard go przepuszcza.
- [x] 🟠 [P2] **lib/scheduler.js:198** — Livelock pętli drain, gdy `executor.executeRun()` odrzuci obietnicę: `startRun` loguje błąd i czyści `inFlight`, ale nie zmienia statusu runu → run zostaje `queued`, jest pickowany w kółko bez backoffu, `processQueue()` nigdy się nie rozwiązuje i pętla nie oddaje kontroli do fazy timerów (zweryfikowane: `setTimeout(3000)` nie odpalił przez 20 s) = zamrożony heartbeat, cron i HTTP. Wyzwalacz: SQLITE_BUSY/IO w `db.getJob`/`db.updateRun` albo synchroniczny throw ze `spawn()`. Fix: w `catch` oznaczyć run jako `failed` (albo `queued` + opóźnienie), by opuścił kolejkę + test „executeRun rzuca → run `failed`, `processQueue()` rozwiązuje się, `executeRun` wołany raz".
- [x] 🟠 [P2] **lib/scheduler.js:191** — Zwolnienie wpisu na `'exit'` z karencją nie przekłada się na slot pickera: `mergeActiveRuns` bierze SUMĘ `executor.getActiveRuns()` i `inFlight`, a `inFlight` czyści się dopiero w `finally` po `await executor.executeRun(run)`, czyli na `'close'`. Zmierzone: `getActiveRuns().length === 0` po 2 s, kolejny run startuje po 12,2 s. Gdy `'close'` nie przyjdzie nigdy (ścieżka `claude` nie ma ratunkowego timera z `executor.js:455`), slot przepada na stałe i `queueProcessing` zostaje `true` do restartu. Fix: domknąć wpis `inFlight` sygnałem z executora, a okno retry-checku pokryć osobnym licznikiem.
- [x] 🟠 [P2] **server.js:307** — Zapis „Ile zadań naraz" z dashboardu nie budzi drainu: `PUT /api/settings/concurrency` robi tylko `db.setState(...)`, a pętla czeka na `Promise.race([...aktywne, waitForNewWork()])` bez okresowego re-picku. Odtworzone na żywo: przy 1 runie biegnącym i 1 w kolejce podniesienie limitu do 3 nie wystartowało nic przez 15 s; dopiero `POST /api/jobs/:id/trigger` (dzwonek) ruszył kolejkę. Fix: po `db.setState(...)` dołożyć `scheduler.processQueue().catch(...)` (wzorzec z `enqueueJob`, scheduler.js:272) + test „PUT z wyższym limitem startuje run bez dodatkowego enqueue".
- [x] 🟠 [P2] **lib/scheduler.test.js:584** — Test „(odbiór R1)" nie mierzy tego, co R1 gwarantuje: oba joby (`r1-long`, `r1-short`) nie mają żadnego udanego runu, więc `classifyJob` klasyfikuje OBA jako `'long'`, a przy `max_concurrent=3` budżet długich = 2 → krótki startuje z wolnego slotu, nie z rezerwy. Test przechodzi także przy zepsutej klasyfikacji; szew `getRecentSuccessDurations → classifyJob → pickEligibleRuns` nie ma pokrycia integracyjnego (learned pattern 2026-07-03). Fix: test drainu z `max_concurrent=2`, jobem krótkim z realną historią ~1 s i długim bez historii — krótki startuje, drugi długi zostaje `queued`.

### P3 (opcjonalne, nie blokują gate'u)

- [ ] 🟡 [P3] **lib/inbox-seed.js:45** — `lock_group:'dashboard'` żyje tylko w `createJob`, więc na każdej istniejącej instalacji job „Team OS — inbox sync" ma `lock_group = NULL` i ochrona R5 przed kolizją na `Zadania/Dashboard.md` nie działa. Fix: backfill w `migrate()` za sentinelem w `state` (wzorzec `wake_backfill_done`) albo jawny krok `Operator:`.
- [ ] 🟡 [P3] **lib/scheduler.js:225** — N+1: `getRecentSuccessDurations` wołane per job, w każdej iteracji pętli drain (dzwoni każdy `enqueueJob`/webhook/trigger). Fix: `getRecentSuccessDurationsByJob(jobIds)` na `ROW_NUMBER() OVER (PARTITION BY job_id …)` (wzorzec `getRecentRunsPerJob`, db.js:256) + memoizacja w obrębie `processQueue`.
- [ ] 🟡 [P3] **lib/executor.js:313** — Bufor `stdout`/`stderr` rośnie bez limitu do finalizacji, a faza mnoży to przez `max_concurrent` (sufit 10) → ryzyko OOM na VPS 1 GB. Fix: przycinanie przyrostowe w handlerze `data` (ogon zgodny z `truncate` i `extractResult`).
- [ ] 🟡 [P3] **lib/scheduler.js:1** — 452 linie (limit 300) i trzy odpowiedzialności; polityka współbieżności to komplet czystych funkcji. Fix: `lib/queue-picker.js` + kolokowany test, re-eksport nazw w schedulerze.
- [ ] 🟡 [P3] **lib/db.js:366** — `getQueueWaitStats` bez call-site'u, a to podstawowa metryka odbioru sprintu (R8). Fix: `GET /api/metrics/queue-wait` za guardem XFF + wiersz w `skills/puls/SKILL.md`, albo usunięcie funkcji z adnotacją w kontekście.
- [ ] 🟡 [P3] **lib/db.js:341** — `getRunningRuns()` robi `SELECT *`, więc `/api/status` (polling co 3 s) i treść 409 niosą `webhook_payload` (publiczne body do 64 KB), `stdout` i `stderr`. Fix: jawna lista kolumn (`id, job_id, status, trigger_type, queued_at, started_at, finished_at`) — front używa tylko `id`, `job_id`, `started_at`.
- [ ] 🟡 [P3] **server.js:464** — Run zwolniony ratunkowo po `'exit'` znika z `activeRuns`, ale w DB zostaje `running` do total timeoutu → kill-bar pokazuje wiersz, którego kill nie domyka („Ten run już nie biegnie"). Fix: gdy `executor.killRun()` zwróci `false`, a świeży wiersz ma `status === 'running'` — dopisać `db.updateRun(..., {status:'killed'})`.
- [ ] 🟡 [P3] **server.js:442** — `GET /api/runs/current` wciąż woła `db.getCurrentRun()` (`LIMIT 1` bez `ORDER BY`), gdy `/api/status` przeszło na `getRunningRuns()[0]` — dwie definicje „pierwszego biegnącego". Fix: `db.getRunningRuns()[0] || null`.
- [ ] 🟡 [P3] **lib/scheduler.js:54** — `resolveMaxConcurrent` sanityzuje tylko dolną granicę: `state.max_concurrent='999'` → picker wystartuje 999 agentów. Fix: `Math.min(parsed, MAX_CONCURRENT_CEILING)` + asercja w istniejącym teście.
- [ ] 🟡 [P3] **lib/scheduler.test.js:484** — Wyłączność (`lock_group`/`skill_name`/`command`) bez testu na żywej pętli drain (tylko czysta funkcja z ręcznie usuwanym runem). Fix: test integracyjny na script-jobach — `started_at` drugiego ≥ `finished_at` pierwszego, kolejka pusta po `processQueue()`.
- [ ] 🟡 [P3] **lib/scheduler.js:126** — Gałąź runu osieroconego (`job` brak → `'long'` + brak kluczy wyłączności) bez testu, a to jedyna reguła świadomie puszczająca run mimo braku danych. Fix: test „run bez joba w `jobsById` jest puszczany i nie wnosi kluczy wyłączności".
- [ ] 🟡 [P3] **lib/scheduler.js:102** — Podwójna sanityzacja limitu (`readMaxConcurrent` już zwraca liczbę, `pickEligibleRuns` sanityzuje ponownie) zaciera kontrakt czystej funkcji. Fix: `const limit = maxConcurrent;`.
- [ ] 🟡 [P3] **lib/scheduler.js:448** — Martwe eksporty `FAST_THRESHOLD_MS` i `DEFAULT_MAX_CONCURRENT` (testy używają literałów, `server.js` ich nie tyka). Fix: usunąć z `module.exports`.
- [ ] 🟡 [P3] **lib/executor.js:27** — Martwe pole `startedAt` w `activeRuns` i w `getActiveRuns()` (nikt nie czyta; UI liczy czas z `run.started_at` z DB). Fix: usunąć.
- [ ] 🟡 [P3] **lib/executor.js:538** — `getCurrentRunId` eksportowany jako „shim dla starych call-site'ów", których nie ma (jedyne użycie: wewnętrzne w `killCurrent`). Fix: usunąć z `module.exports` razem z mylącym komentarzem.
- [ ] 🟡 [P3] **lib/executor.js:49** — `killProcessTree` duplikuje `gracefulKillProc` (executor.js:238-252) i inline kill ze ścieżki skryptowej (449-450); kopie już się rozjechały (`.unref()` tylko w nowej). Trzecia kopia siedzi w `lib/ask.js:169`. Fix: jeden helper (naturalne miejsce: `lib/claude-spawn.js`).

---

## Operator checklist faza 1

*Warunki środowiskowe — NIE zadania do fix. Autopilot nie liczy ich do ukończenia fazy.*

- [ ] Operator: lokalny daemon Pulsa serwuje kod SPRZED commita `bde391d` — `GET localhost:7777/api/settings/concurrency` zwraca 404, `/api/status` nie emituje `current_runs`, a nowy `public/app.js` (czytany z dysku) woła endpointy, których proces nie zna; równoległość NIE jest aktywna na maszynie usera mimo zmergowanego kodu — Operator action: (1) zrestartować daemona (`launchctl kickstart -k gui/$(id -u)/com.claude-cron.scheduler` albo ubić PID 8290 i `npm start` z NOWO otwartego terminala — learned pattern o nieświeżym env), (2) `curl -s localhost:7777/api/settings/concurrency` → oczekiwane `{"max_concurrent":3}`, (3) to samo na VPS-ie.
- [ ] Operator: trzy scenariusze `[E2E]` z Unit 5 (linie 110-112) + `Weryfikacja:` E2E z linii 114 nieodegrane — niepokryte pozostają dwutorowy render `renderKillBar` (`public/app.js:340-360`: `innerHTML` przy zmianie podpisu vs `textContent` czasu), globalna dostępność `killRun` wołanego z `onclick` i round-trip pól `form-lock-group` oraz modala limitu — Operator action: odpalić dashboard w przeglądarce (`/agent-browser`), (1) uruchomić dwa równoczesne runy i potwierdzić screenshotem dwa wiersze, (2) kliknąć „Zatrzymaj" w pierwszym — drugi ma zostać, (3) zapisać „Grupę wyłączności" i limit, przeładować stronę i potwierdzić odczyt.
- [ ] Operator: kill per run przy DWÓCH równoczesnych drzewach procesów na Windowsie (`taskkill /PID <pid> /T /F`, `lib/executor.js:44`) jest nieweryfikowalny na macOS — cała suita równoległości jedzie na `spawn('node', …)` z Uniksa, a plan wymienia to jako ryzyko wprost — Operator action: na maszynie Windows uruchomić dwa równoległe script-joby, wysłać `POST /api/runs/:id/kill` na pierwszy i potwierdzić, że pierwszy jest `killed`, a drugi dalej `running`.

---

## Faza 2 — Instalator

### Unit 7: Konfigurowalny katalog instalacji + wykrycie zajętego portu (M)

*Delegate to: feature-builder-data · Zależy od: — (niezależne od Fazy 1)*

- [ ] Pytanie o katalog instalacji przez `/dev/tty` z domyślną wartością `$HOME/claude-cron` (`install.sh:30`)
- [ ] Symetryczna ścieżka na Windowsie (`install.ps1` / `setup.mjs`)
- [ ] Wykrycie zajętego `CLAUDE_CRON_PORT` przed startem + czytelny komunikat
- [ ] Zapis wybranego portu do konfiguracji (dashboard i autostart używają tej samej wartości)
- [ ] Rozróżnienie „port zajęty przez cudzy proces" vs „przez naszą starą instancję" (re-run, nie błąd)
- [ ] Ubijanie procesów filtrem po **ścieżce instalacji**, nigdy po nazwie binarki (pułapka Windows 28.07)
- [ ] Test: instalacja w niestandardowym katalogu działa i tam startuje
- [ ] Test: zajęty port → komunikat z numerem portu i sugestią; brak cichego „sukcesu" z martwym serwerem
- [ ] Test: port zajęty przez naszą starą instancję → ścieżka re-runu
- [ ] Test: pusta odpowiedź na pytanie o katalog → wartość domyślna
- [ ] Weryfikacja: `bash install.test.sh` przechodzi
- [ ] Weryfikacja: `node --test setup.test.mjs` przechodzi
- [ ] Weryfikacja: przebieg przez **prawdziwy pipe** (`curl … | bash` z env-override źródła), nie lokalne `bash install.sh`
- [ ] Operator: przebieg instalatora na Windowsie (suita macOS nie pokrywa blokad plików)

---

## Faza 3 — Autostart na Macu

### Unit 8: `installMac` przepisany pod wzorzec działającego plista (M)

*Delegate to: feature-builder-data · Zależy od: —*
*Notatka wykonawcza: `lib/platform.js` nie ma dziś żadnego testu — zacznij od characterization testu generatora plista.*

- [ ] Characterization test obecnego `generatePlist()` **przed** zmianą zachowania
- [ ] Wrapper `/bin/sh -c` z `cd <repo> && exec ./.node/<wersja>/bin/node server.js`
- [ ] Logi w `~/Library/Logs/claude-cron/` (nie w `<repo>/data/` — TCC, `EX_CONFIG 78`)
- [ ] Blok `EnvironmentVariables`: `PATH`, `HOME`, `CLAUDE_CRON_WORKSPACE`, `CLAUDE_CRON_VPS_URL`
- [ ] Jedna stała etykiety używana przez `PLIST_PATH`, `installMac` i `getStatus` (koniec rozjazdu)
- [ ] `getStatus()` radzi sobie z instalacją zrobioną ręcznie pod starą nazwą (bez cichego duplikatu agenta)
- [ ] Test: plist zawiera wrapper `/bin/sh -c`, ścieżkę do portable Node z `.node/` i logi **poza** repo
- [ ] Test: plist zawiera `CLAUDE_CRON_WORKSPACE` i `CLAUDE_CRON_VPS_URL`, gdy ustawione w środowisku
- [ ] Test: `getStatus()` rozpoznaje agenta po etykiecie, którą instaluje `installMac()`
- [ ] Test: etykieta to jedna stała — brak rozjazdu nazw między funkcjami
- [ ] Weryfikacja: `node --test lib/platform.test.js` przechodzi
- [ ] Weryfikacja: `npm test` przechodzi w całości
- [ ] Operator: po instalacji `launchctl list | grep claude-cron` pokazuje agenta, panel „zainstalowany", daemon przeżywa reboot

---

## Faza 4 — Opóźnienie startu po wybudzeniu

### Unit 9: Karencja sieciowa po wykryciu wybudzenia (S)

*Delegate to: feature-builder-data · Zależy od: Unit 3*

- [ ] Czysta funkcja `shouldDeferAfterWake(lastActiveAt, now, graceMs)` — bez zegara i bez sieci
- [ ] Wykrycie wybudzenia z luki w heartbeacie (wzorzec progu: `executor.js:20-31`, `SLEEP_GAP_MS`)
- [ ] Odroczenie pierwszego startu runu o 30-60 s po wybudzeniu; retry bez zmian
- [ ] Rozstrzygnąć w implementacji: karencja dla wszystkich jobów czy tylko `run_on_wake`; sztywne czekanie czy probe sieci
- [ ] Test: `shouldDeferAfterWake` → `true` tuż po luce, `false` po karencji, `false` przy normalnej pracy
- [ ] Test: run zakolejkowany w oknie karencji startuje **po** jej upływie — nie ginie i nie jest `failed`
- [ ] Test: zwykły ruch kolejki (bez wybudzenia) nie jest opóźniany o ani jeden tick
- [ ] Weryfikacja: `node --test lib/scheduler.test.js` przechodzi
- [ ] Weryfikacja: `npm test` przechodzi w całości

---

## Odbiór całości

- [ ] Wszystkie Unity 1-9 zamknięte
- [ ] `npm test` — 640 istniejących testów bez modyfikacji + nowe zielone
- [ ] Metryka: średnie oczekiwanie „Team OS — inbox sync" w kolejce spadło z minut do sekund (pon. 8:00-10:00)
- [ ] Metryka kontrolna: liczba runów `failed`/`timeout` w tygodniu po wdrożeniu nie wzrosła
- [ ] Deploy: Mac → obserwacja poniedziałku → VPS, razem z aktualizacją skilla `/puls`
