# Równoległe joby — checklista zadań

**Branch:** `feature/rownolegle-joby`
**Ostatnia aktualizacja:** 2026-07-30

Legenda: `Test:` = scenariusz testowy z planu technicznego · `Weryfikacja:` = automatyczne
kryterium PASS/FAIL · `Operator:` = krok wymagający człowieka (autopilot tego nie odznacza).

---

## Faza 1 — Równoległość

### Unit 1: Warstwa danych — kolumny, statystyki czasów, runy aktywne (M)

*Delegate to: feature-builder-data · Zależy od: —*

- [ ] Migracja kolumny `lock_group TEXT` w `jobs` (`lib/db.js`, wzorzec z db.js:105-120)
- [ ] Migracja kolumny `queued_at TEXT` w `runs` — **bez backfillu**, istniejące wiersze zostają `NULL`
- [ ] `createRun` ustawia `queued_at` w momencie wstawienia
- [ ] `lock_group` dopisane do allow-list `createJob` (db.js:169) **oraz** `updateJob` (db.js:179)
- [ ] `getRunningRuns()` — `getCurrentRun` bez `LIMIT 1`; `getCurrentRun` zostaje (kompatybilność)
- [ ] `getRecentSuccessDurations(jobId, limit = 10)` — czasy w ms liczone w JS, nie agregatem SQL
- [ ] `getQueueWaitStats(hours)` — średnie/max oczekiwanie, runy bez `queued_at` pomijane
- [ ] Test: `migrate()` odpalone dwukrotnie nie rzuca i nie duplikuje kolumn
- [ ] Test: `createJob({lock_group})` zapisuje wartość; `updateJob` ją zmienia i czyści
- [ ] Test: `createRun` ustawia `queued_at`; `getQueueWaitStats` pomija runy bez znacznika
- [ ] Test: `getRunningRuns()` zwraca ≥2 wiersze `running`, `getCurrentRun()` dalej jeden
- [ ] Test: `getRecentSuccessDurations` ignoruje `failed`/`timeout`/`killed` i runy bez `started_at`
- [ ] Test: `getRecentSuccessDurations` zwraca **liczby** (`typeof === 'number'`), nie BigInt
- [ ] Weryfikacja: `node --test lib/db.test.js` przechodzi bez błędów
- [ ] Weryfikacja: `npm test` przechodzi w całości (640 istniejących testów bez modyfikacji)

### Unit 2: Executor — mapa aktywnych runów i kill per run (M)

*Delegate to: feature-builder-data · Zależy od: — (równolegle z Unit 1)*
*Notatka wykonawcza: zacznij od testu „dwa runy, kill jednego" — wykrywa powrót do semantyki singletonu.*

- [ ] `currentProcess`/`currentRunId` → `activeRuns = Map(runId → {proc, jobId, startedAt})`
- [ ] Rejestracja wpisu **synchronicznie** po udanym spawnie (obie ścieżki: claude i script)
- [ ] Wyrejestrowanie w `close`/`error`/`finishScriptRun` — idempotentne, domknięte także na `'exit'` z karencją
- [ ] `killCurrent()` → `killRun(runId)`; zapis `killed` do DB **przed** ubiciem procesu
- [ ] `killCurrent()` zostaje jako shim: 0 → `false`, 1 → kill, >1 → sygnał niejednoznaczności
- [ ] `isRunning()` → `activeRuns.size > 0`, `getCurrentRunId()` → pierwszy klucz (shimy dla R7)
- [ ] Timery, guard `settled` i guard „kill przez usera" — bez zmian semantycznych
- [ ] Test: dwa runy skryptowe równocześnie — `killRun(id1)` kończy run 1 jako `killed`, run 2 jako `success`
- [ ] Test: `killRun` zapisuje `killed` przed ubiciem — `close` nie nadpisuje na `failed` i **nie wysyła ❌**
- [ ] Test: `killRun(nieistniejący)` zwraca `false` i nie rzuca
- [ ] Test: po zakończeniu obu runów `activeRuns.size === 0` i `isRunning() === false`
- [ ] Test: proces bez `'close'` (ratunkowy timer) też zwalnia wpis w mapie
- [ ] Weryfikacja: `node --test lib/executor.test.js` przechodzi
- [ ] Weryfikacja: `npm test` przechodzi w całości

### Unit 3: Scheduler — picker, slot rezerwowy, dzwonek (L) 🔴 rdzeń

*Delegate to: feature-builder-data · Zależy od: Unit 1, Unit 2*
*Notatka wykonawcza: test-first dla obu czystych funkcji i dla scenariusza „krótki dokolejkowany w trakcie długiego".*

- [ ] Czysta funkcja `classifyJob(durations, thresholdMs)` → `'short' | 'long'`; pusta historia → `'long'`
- [ ] Czysta funkcja `pickEligibleRuns({queued, jobsById, activeRuns, durationsByJob, maxConcurrent, fastThresholdMs})`
- [ ] Reguła: globalny limit `maxConcurrent` (z `state`, default 3, sanityzacja ≥ 1)
- [ ] Reguła: zadania długie najwyżej `maxConcurrent - 1` (min 1) — reszta to rezerwa dla krótkich
- [ ] Reguła: brak aktywnego runu tego samego `job_id`
- [ ] Reguła: brak aktywnego runu joba o tym samym niepustym `skill_name` **lub** `command`
- [ ] Reguła: brak aktywnego runu z tą samą niepustą `lock_group`
- [ ] Pętla drain: startuj kwalifikujące się → `Promise.race([...aktywne, sygnał])` → re-pick
- [ ] **Dzwonek** — `enqueueJob` rozwiązuje sygnał nowej pracy; po wybudzeniu tworzony świeży
- [ ] Guard `queueProcessing` zostaje; `processQueue()` nadal rozwiązuje się po opróżnieniu kolejki
- [ ] Retry-check przeniesiony bez zmian semantycznych (świeży odczyt z DB + `countRecentFailedRuns`)
- [ ] `max_concurrent` czytane w momencie pickowania (zmiana z dashboardu bez restartu)
- [ ] Test: `classifyJob` — mediana odporna na wartość odstającą (`[0.2, 0.2, 0.3, 975]` → krótki)
- [ ] Test: `classifyJob` — pusta historia → długi; wartość dokładnie na progu → długi
- [ ] Test: przy `maxConcurrent=3` i dwóch aktywnych długich trzeci długi **nie** startuje, krótki **tak**
- [ ] Test: nigdy dwa runy tego samego `job_id`
- [ ] Test: dwa joby o tym samym `skill_name` nie biegną razem (bez deklaracji); to samo dla `command`
- [ ] Test: dwa joby z `lock_group='dashboard'` nie biegną razem; drugi startuje po pierwszym (FIFO po `id ASC`)
- [ ] Test: **(odbiór R1)** krótki run dokolejkowany **w trakcie** długiego kończy się **przed** nim
- [ ] Test: retry (R9) działa przy równoległym drainie — fail → retry → ❌ dokładnie raz
- [ ] Test: `processQueue()` rozwiązuje się po opróżnieniu kolejki (`scheduler.test.js:285` bez zmian)
- [ ] Test: zmiana `max_concurrent` w `state` w trakcie życia procesu wpływa na kolejny pick
- [ ] Weryfikacja: `node --test lib/scheduler.test.js` przechodzi
- [ ] Weryfikacja: `npm test` przechodzi w całości — 640 istniejących testów bez modyfikacji

### Unit 4: API — kill per run, lista aktywnych, ustawienie limitu (M)

*Delegate to: feature-builder-data · Zależy od: Unit 1-3*

- [ ] `POST /api/runs/:id/kill` — kill konkretnego runu
- [ ] `POST /api/runs/current/kill` — 1 aktywny → kill; **>1 → 409 z listą**; 0 → jak dziś
- [ ] `GET /api/status` — nowe `current_runs` (tablica); `current_run` = pierwszy element
- [ ] `GET/PUT` ustawienia `max_concurrent` — walidacja (liczba całkowita ≥ 1, rozsądny sufit)
- [ ] Endpoint ustawień **za** guardem XFF (kontrakt kolejności matcherów nienaruszony)
- [ ] Test: `POST /api/runs/:id/kill` ubija wskazany run, drugi aktywny żyje
- [ ] Test: `POST /api/runs/current/kill` przy dwóch aktywnych → **409** + lista w treści
- [ ] Test: `POST /api/runs/current/kill` przy jednym aktywnym → zachowanie jak dziś
- [ ] Test: `GET /api/status` zwraca `current_runs` jako tablicę i `current_run` = pierwszy element
- [ ] Test: `PUT` limitu odrzuca `0`, ujemne i tekst; przyjmuje `1` i `5`
- [ ] Test: żądanie z `X-Forwarded-For` na endpoint ustawień → 403
- [ ] Weryfikacja: `npm test` przechodzi w całości
- [ ] Weryfikacja: `grep` w `server.js` potwierdza, że `/webhook`, `/ask`, `/inbox/v1` stoją **przed** guardem XFF, a ustawienia **za** nim

### Unit 5: Dashboard — lista biegnących runów, pole grupy, ustawienie limitu (M)

*Delegate to: feature-builder-ui · Zależy od: Unit 4*

- [ ] Kill-bar (`public/app.js:328-334`) → lista wierszy: nazwa joba + czas + „Zatrzymaj" per wiersz
- [ ] Formularz joba: opcjonalne pole „Grupa wyłączności" z krótkim wyjaśnieniem
- [ ] Ustawienia: „Ile zadań naraz" + informacja o slocie rezerwowym i zasięgu per maszyna
- [ ] Zachowany guard pollingu (tani podpis payloadu — bez tego lista migocze co 3 s)
- [ ] Test: czysty helper renderujący wiersz aktywnego runu (jeśli wyjdzie poza interpolację → `public/render-helpers.js` + test)
- [ ] Test: [E2E] dashboard z dwoma równoczesnymi runami pokazuje **dwa** wiersze; „Zatrzymaj" w pierwszym zostawia drugi
- [ ] Test: [E2E] zapis i odczyt pola „Grupa wyłączności" po przeładowaniu
- [ ] Test: [E2E] zmiana „ile zadań naraz" przeżywa przeładowanie strony
- [ ] Weryfikacja: `npm test` przechodzi (helpery frontu)
- [ ] Weryfikacja: scenariusz E2E przez `/agent-browser` — dwa wiersze aktywnych runów widoczne jednocześnie (screenshot), po „Zatrzymaj" zostaje jeden

### Unit 6: Seed, harmonogramy i dokumentacja (S)

*Delegate to: feature-builder-data · Zależy od: Unit 1, Unit 3*

- [ ] `lib/inbox-seed.js` — job „Team OS — inbox sync" dostaje `lock_group: 'dashboard'` **tylko w `createJob`**
- [ ] Skill `puls` (`skills/puls/SKILL.md`) — opis pola grupy, zasada klasyfikacji, kod **409** przy `current/kill`
- [ ] `CLAUDE.md` — sekcja o `scheduler.js` opisuje limit + slot rezerwowy + klasyfikację z pomiaru
- [ ] `docs/CONCEPTS.md` — hasła „zadanie krótkie / długie" i „slot rezerwowy"
- [ ] Test: seed nadaje `lock_group='dashboard'` przy tworzeniu joba sync
- [ ] Test: seed przy istniejącym jobie **nie** modyfikuje jego `lock_group` ani `enabled`
- [ ] Weryfikacja: `node --test lib/inbox-seed.test.js` przechodzi
- [ ] Weryfikacja: `grep -c "lock_group" skills/puls/SKILL.md` > 0
- [ ] Operator: przesunąć cron „CC Update" na VPS-ie, by nie pokrywał się z „Aktualizacja folderu .claude"
- [ ] Operator: rozstrzelić poniedziałkowy blok 8:00 na Macu (Weekly memory + Reflect tygodniowy)
- [ ] Operator: ustawić `max_concurrent` (VPS: 3, Mac: 2) i obserwować tydzień

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
