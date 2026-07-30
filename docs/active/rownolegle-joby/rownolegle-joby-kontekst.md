# Równoległe joby — kontekst techniczny

**Branch:** `feature/rownolegle-joby`
**Ostatnia aktualizacja:** 2026-07-30 — Faza 3 (Unit 8, autostart na Macu) zaimplementowana
+ fix po review; `npm test` 782/782 (0 fail), `node --test lib/platform.test.js` 36/36
(na wymuszonym `process.platform='linux'`: 35 pass / 1 skip / 0 fail)

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

## Review fazy 1 (2026-07-30)

Raport: [review-faza-1.md](review-faza-1.md) · Gate: ⚠️ **ZASTRZEŻENIA** (0×P1, 5×P2, 17×P3,
4 pozycje operatora). Wszystkie checkboxy `Weryfikacja:` typu CLI/grep odznaczone — `npm test`
707 pass / 0 fail, kontrakt kolejności matcherów potwierdzony gerpem (webhook 719 → ask 730 →
inbox 735 → guard XFF 745 → api 751).

**Wnioski, które przeżyją tę fazę:**

1. **Pętla drain ma trzy defekty żywotności, nie poprawności pickera.** Picker (czyste funkcje) jest
   zdrowy; psuje się to, co wisi na obietnicach: (a) odrzucona obietnica `executeRun` zostawia run
   `queued` i zapętla drain bez oddania kontroli do fazy timerów = zamrożony demon, (b) slot zwalnia
   się dopiero na `'close'`, więc karencja `'exit'` z Unit 2 nie przekłada się na `inFlight`,
   (c) zmiana limitu z dashboardu nie dzwoni dzwonkiem. Wspólny mianownik: **każde nowe źródło
   zmiany stanu kolejki musi mieć swój dzwonek, a każda ścieżka wyjścia z runu — swoje domknięcie.**
2. **Guard XFF nie jest guardem CSRF** — powtórka learned-patternu 2026-07-24 na nowych endpointach
   mutujących. Notatka wykonawcza fazy uzasadniała brak guardu tym, że „endpoint nie zwraca sekretu";
   to zamyka wektor odczytu, nie zapisu.
3. **Test odbiorczy R1 mierzył dzwonek, nie rezerwę** — oba joby bez historii runów klasyfikują się
   jako długie, więc krótki startował z wolnego slotu. Szew `getRecentSuccessDurations → classifyJob
   → pickEligibleRuns` nie ma dziś pokrycia integracyjnego.
4. **`lock_group` w seedzie chroni tylko nowe instalacje** — `createJob`-only (słusznie: zero
   `UPDATE`), więc na maszynach, gdzie job sync już istnieje, kolumna zostaje `NULL` i ochrona R5
   przed kolizją na `Zadania/Dashboard.md` nie działa mimo włączonej równoległości.

## Stan realizacji — Faza 2, Unit 7 (30.07)

Instalator pyta o katalog (`install.sh` → `ask_install_dir`/`resolve_install_dir`, `install.ps1` →
`Read-InstallDir`/`Resolve-InstallDir`) i rozstrzyga port dashboardu przed hookiem i startem serwera
(`setup.mjs` → `resolveDashboardPort`). `npm test` 736 pass / 0 fail, `bash install.test.sh`
13 PASS / 13.

### Decyzje podjęte w implementacji (poza literalnym brzmieniem planu)

- **Stan portu z DWÓCH sygnałów, nie z `lsof`.** `classifyPortState` łączy bind-test (`net.createServer`
  na `0.0.0.0`, tak jak `server.listen`) z odpowiedzią `GET /api/status`. Rozpoznanie „to nasza stara
  instancja" idzie po **zestawie pól kontraktu** (`uptime`, `queue_length`, `total_jobs`,
  `enabled_jobs`), nie po luźnym substringu — na zajętym porcie może siedzieć dowolne API zwracające
  JSON, a fałszywe „to nasze" kazałoby instalatorowi zignorować realną kolizję i zameldować sukces
  z martwym serwerem. Narzędzia systemowe (`lsof`/`Get-NetTCPConnection`) różnią się per OS i tak
  czy siak nie powiedzą, **czyj** to serwer — trafiły więc tylko do komunikatu diagnostycznego.
- **`pingDashboard` zaostrzony do kontraktu `/api/status`.** Wcześniej wystarczyła dowolna odpowiedź
  HTTP, więc obcy serwer na 7777 dawał setupowi „dashboard żyje" i auto-open cudzej aplikacji.
- **Port wypalany do trzech miejsc naraz**: `persistEnvVar('CLAUDE_CRON_PORT')`, źródło hooka
  autostartu (`buildHookSource(..., port)` — health-check **i** `env` spawnowanego serwera) oraz
  `spawnServer`. Powód wprost z learned-patternu 2026-07-07: zmiana env nie propaguje się do
  żyjących procesów, a hook żyje w sesji Claude Code z env sprzed instalacji.
- **`buildStaleHookPortWarning` + `warnIfHookPortStale` (poza literalną checklistą).** Zmiana portu
  przy odmowie reinstalacji hooka zostawiała autostart na starym porcie — cicha rozbieżność
  „dashboard vs autostart", której wymóg R9 ma nie dopuścić.
- **`has_tty` zamiast `[ -r /dev/tty ]` — i to samo w istniejącym `handoff_to_setup`.** Test prawa
  odczytu **kłamie**: na macOS bez terminala kontrolującego węzeł urządzenia jest „czytelny", ale
  otwarcie zwraca `Device not configured` i pod `set -e` kończyło instalator bez jednego słowa.
  Guard sprawdza stan faktyczny (otwiera i zamyka) — dokładnie ta klasa błędu, którą opisuje
  learned-pattern „potwierdzaj stan faktyczny, nie kod wyjścia".
- **Regresja tej samej klasy naprawiona w nagłówku skryptu**: `[ -n "$INSTALL_DIR" ] && VAR=1` na
  poziomie skryptu kończyło `install.sh` kodem 1 przy pustym env (fałszywy test na końcu listy pod
  `set -e`). Zamienione na `if/then` + test regresyjny ładujący skrypt w osobnej powłoce bez env.
- **`INSTALL_TTY` jako DI (override WYŁĄCZNIE dla testów).** Bez tego ścieżka terminalowa
  `ask_install_dir` była nietestowalna — a to właśnie ona, nie stdin, jest ścieżką `curl|bash`.
- **`probeDashboardPort` wyeksportowany**, żeby bind-test był pokryty na **prawdziwych gniazdach**
  (free / ours / foreign), nie na atrapie.
- **Env-override `INSTALL_DIR` pomija pytanie** (obie platformy) — nieinteraktywny przebieg
  z jawnie podanym katalogiem nie ma o co pytać. Odpowiedź usera przechodzi przez sanityzację:
  cudzysłowy z Findera/Explorera, escape'owane spacje, `~` (nie rozwijane w wartości z `read`),
  ścieżka względna → absolutna.

### Dług do domknięcia (Faza 2)

- **`install.ps1.Tests.ps1` nie uruchomione** — brak `pwsh`/`powershell` na macOS. Trzy nowe testy
  (pusta odpowiedź, sanityzacja, instalacja w niestandardowym katalogu) czekają na krok operatora
  z planu: przebieg instalatora na Windowsie, gdzie dopiero widać blokady plików.
- **Przebieg przez prawdziwy pipe** (`curl … | bash` z env-override źródła) — pozycja `Weryfikacja:`
  dla review; suita pokrywa ścieżkę terminalową przez podstawiony `INSTALL_TTY`, ale nie zastępuje
  przebiegu z realnym potokiem na stdin.
- **Port nie jest pytany wprost przy wolnym porcie** — pytanie pada dopiero przy kolizji z cudzym
  procesem. Świadomie: jedno pytanie mniej w onboardingu, a `CLAUDE_CRON_PORT` z env nadal wygrywa.

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

## Review fazy 2 (2026-07-30)

Raport: `docs/active/rownolegle-joby/review-faza-2.md` · Gate: **⛔ BLOKUJE** (1×P1, 6×P2, 11×P3
+ 2 findingi OPERATOR). Obie automatyczne `Weryfikacja:` przeszły (`bash install.test.sh` → 13/13,
`node --test setup.test.mjs` → 102/102, oba exit 0).

Wnioski kluczowe:

1. **Katalog instalacji stał się wolnym wejściem usera, ale kod-konsument nie dostał guardu** —
   to wspólny mianownik P1 (`install.sh:204`: `mv "$INSTALL_DIR"` do tmp kasowanego przez
   `trap … rm -rf`, bez sprawdzenia czy to w ogóle instalacja Pulsa) i P2 (`install.ps1:152`:
   `Contains` bez granicy ścieżki ubija cudze procesy `node`). Zmiana źródła wartości wymaga
   przejrzenia KAŻDEGO miejsca, które na tej wartości robi coś destrukcyjnego.
2. **Wykrywanie zajętego portu ma dziurę na macOS** — bind wyłącznie na `0.0.0.0` udaje się,
   gdy obcy proces trzyma `127.0.0.1:<port>` (zweryfikowane na żywo). Trzeba probować oba adresy,
   inaczej Unit 7 nie zamyka scenariusza, dla którego powstał.
3. **`install.sh` nie ma odpowiednika `Stop-PulsProcesses`** — checkbox „ubijanie procesów filtrem
   po ścieżce instalacji" odhaczono mając tylko implementację Windows; na macOS stary daemon
   przeżywa podmianę katalogu i setup kończy się „Gotowe!" na starym kodzie.
4. **Klasyfikacja OURS zakłada jedną instalację na maszynie** — a ta sama faza dodała drugą.
   `/api/status` nie zdradza katalogu instalacji, więc cudzy Puls jest nieodróżnialny od re-runu.

## Faza 3 — Autostart na Macu (Unit 8, 2026-07-30)

`lib/platform.js` przepisany pod wzorzec plista, który realnie wstaje; `lib/platform.test.js`
to pierwsze pokrycie tego modułu (26 testów). `npm test` 772/772.

### Co się zmieniło

- **`generatePlist()` → cienka skorupa nad czystym `buildPlist({label, repoDir, nodeBin, logFile, env})`.**
  Wrapper `/bin/sh -c` z `cd <repo> && exec <node> --disable-warning=ExperimentalWarning server.js`
  zamiast gołego `[node, server.js]` — jedno miejsce na cwd i flagi, ta sama flaga co `npm start`.
- **Logi w `~/Library/Logs/claude-cron/daemon.log`, nie w `<repo>/data/`.** Repo stoi
  w `~/Documents`, a launchd nie ma zgody TCC na ten katalog → agent padał na `EX_CONFIG (78)`
  bez wpisu w logu (bo logu nie było gdzie zapisać). `installMac()` tworzy katalog logów **przed**
  `load` — launchd sam go nie utworzy.
- **Node z `.node/`, nie z `which node`** (`resolvePortableNodeBin`): launchd startuje z minimalnym
  PATH, a instalatory celowo nie dotykają systemowego Node. Kolejność: `process.execPath` (gdy sam
  biegnie z `.node/`) → istniejący dyst w `.node/` (pinowany ma pierwszeństwo przed „pierwszym
  alfabetycznie", bo po podbiciu wersji leżą dwa) → pinowana wersja jako ostatni fallback.
- **`EnvironmentVariables`: `PATH`, `HOME`, `CLAUDE_CRON_WORKSPACE`, `CLAUDE_CRON_VPS_URL`**
  ze środowiska INSTALACJI (`pickPlistEnv`). Klucz pusty/whitespace jest POMIJANY, nie wpisywany
  pustym stringiem — pusty `CLAUDE_CRON_VPS_URL` wygląda na skonfigurowany i myli diagnozę proxy
  (503 „brak env" vs 502/504 „sieć"; learned-pattern 2026-07-07).
- **`escapeXml` na wszystkich wartościach** — `&&` w komendzie musi być encją, inaczej plist jest
  niepoprawnym XML-em; ścieżki cytowane dla `/bin/sh -c` (`shellQuote`).
- **`getStatus()` czyta pełny `launchctl list` i filtruje czystym `parseLaunchctlList`.**
  Decyduje **kolumna PID** (`-` = wczytany, ale nie biegnie), nie substring linii — stara wersja
  robiła `!out.includes('-')`, a myślnik siedzi w samej nazwie `claude-cron`, więc `running` był
  zawsze `false`. Dopasowanie po CAŁEJ etykiecie (`com.claude-cron.scheduler.backup` ≠ nasz agent).
  To dokładnie learned-pattern „dokładna fraza, nie substring".

### Decyzje

- **Etykieta kanoniczna zostaje `com.claude-cron.scheduler`** — CLAUDE.md wymienia ją jako
  identyfikator techniczny; zmiana psuje istniejące instalacje. Rozjazd z ręcznie postawionym
  `com.claude-cron.daemon` (23.07) rozwiązany w drugą stronę: nowa stała `LEGACY_PLIST_LABELS`.
  `getStatus()` rozpoznaje legacy agenta (gdy kanonicznego nie ma), a `installMac()` unloaduje go
  i kasuje plik **przed** `load` nowego — dwa agenty startujące ten sam serwer biją się o port 7777
  i user widzi „daemon działa" przy losowym zwycięzcy wyścigu.
- **`getStatus()` na macOS zwraca ADDYTYWNIE `label` i `legacy`**; kontrakt
  `{installed, running, platform}` bez zmian, więc `server.js` (`/api/status`) i dashboard działają
  jak dotąd.
- **`execFileSync` z tablicą argumentów zamiast `execSync` z interpolacją** wszędzie, gdzie doszła
  nowa ścieżka (`load`, `unload`, `list`) — ścieżka instalacji jest od Fazy 2 wolnym wejściem usera.
- **`unloadAgent` zwraca `{ok, error}` zamiast łykać pad po cichu.** Przy własnej etykiecie pad to
  norma (pierwsza instalacja — nie ma czego odpinać, a realny problem wyjdzie głośno na `load`
  ze `stdio:'inherit'`); przy kasowaniu legacy oznacza sierotę trzymającą port 7777 do reboota,
  więc leci `console.warn` z instrukcją. Zero pustych `catch {}` w nowym kodzie.
- **`readLaunchctlList()` ostrzega RAZ na proces** — `getStatus()` wisi pod `/api/status`, które
  dashboard odpytuje co 3 s; logowanie przy każdym padzie zalałoby log daemona.
- **`resolvePortableNodeBin` świadomie duplikuje `detectPortableNodeBin` z `setup.mjs`** — granica
  CJS/ESM, brak synchronicznego importu; wspólny shim byłby droższy niż 10 linii (reguła
  „Duplication > Complexity"). `PINNED_NODE_VERSION = '22.17.0'` to **trzecia** kopia pinu
  (`install.sh`, `setup.mjs`, `platform.js`) — używana wyłącznie jako ostatni fallback.
- **Characterization test napisany i przepuszczony na GREEN (7/7) PRZED zmianą**, potem — zgodnie
  z planem — przepisany na nowy kontrakt: niezmienniki (kształt XML, `RunAtLoad`/`KeepAlive`,
  etykieta) zostały, wady (`<repo>/data/*.log`, `which node`) zamienione w asercje odwrotne.

### Dług do domknięcia (Faza 3)

- **Krok operatora niezweryfikowany**: po instalacji `launchctl list | grep claude-cron` musi
  pokazać agenta, panel „zainstalowany", a daemon przeżyć reboot Maca. Testy pokrywają czyste
  funkcje — realnego `launchctl load` nikt jeszcze nie odpalił na tej maszynie.
- **Baseline testów w dokumentach był nieaktualny** (plan mówi 640, zadania 736): przed Fazą 3 repo
  miało 746 testów, po niej 772. Żaden istniejący plik testowy nie został tknięty.

## Review fazy 3 (2026-07-30)

**Raport:** `docs/active/rownolegle-joby/review-faza-3.md` · **Gate:** ⚠️ ZASTRZEŻENIA
(0×P1, 3×P2, 14×P3 + 2 findingi OPERATOR poza gate'em). Bookkeeping `Weryfikacja:`: 2 checkboxy CLI
odznaczone (`node --test lib/platform.test.js` 26/26, `npm test` 772/772, oba exit 0), 1 checkbox
operatora przeniesiony do „Operator checklist faza 3". Tester E2E pominięty przez routing (brak
warstwy UI, 0 browserowych checkboxów) — nic browserowego nie zostało odznaczone.

**Kluczowe wnioski:**

- **Unit 8 nie ma dziś konsumenta** (P2, `lib/platform.js:169`) — `installMac()`/`install()` nie jest
  wołany z żadnej ścieżki usera (`lib/platform` importuje wyłącznie `server.js:13`, i tylko po
  `getStatus()`), a `public/` w ogóle nie renderuje pola `autostart` (grep = 0 trafień). Realny
  autostart to hook Claude Code z `setup.mjs:1197`, nie launchd. Cel „panel przestaje kłamić" nie
  może przejść bez wpięcia modułu w setup/endpoint albo jawnego przeniesienia wpięcia do osobnego
  Unitu. To rozstrzygnięcie determinuje też dwa sprzeczne findingi P3 wokół `buildMacStatus`
  (asymetryczne DI vs YAGNI gałęzi legacy) — jedna decyzja zamyka oba.
- **Cała ścieżka I/O `installMac()` jest bez testu** (P2) — odhaczony checkbox „unloaduje i kasuje
  stary plist przed load" opiera się na inspekcji kodu; przetestowana jest tylko połowa czytająca.
  Learned-pattern 2026-07-28: testy czystych funkcji przechodzą przy złamanym zachowaniu systemowym.
- **Nowy plik testowy jest nieprzenośny** (P2, `lib/platform.test.js:210`) — asercja na
  `path.basename(PLIST_PATH)` failuje na Linuksie (`PLIST_PATH === ''` poza darwinem), a repo działa
  produkcyjnie na VPS-ie. Zweryfikowane empirycznie: 25/26 na wymuszonym `process.platform='linux'`.
- **Powtórka antywzorca z Fazy 2**: `resolvePortableNodeBin` dopasowuje `.node/` substringiem bez
  granicy katalogu — dokładnie to, co review Fazy 2 zgłosiło dla `Contains` w `install.ps1`.
- **Operator jest jedynym, kto może domknąć tę fazę na Macu** — i musi zrobić kopię działającego
  ręcznego plista `com.claude-cron.daemon` PRZED pierwszym `installMac()`, bo instalacja go kasuje
  bezpowrotnie.

### Fix po review fazy 3 (2026-07-30)

- **Zakres Unitu 8 doprecyzowany: moduł TAK, wpięcie w ścieżkę usera NIE (P2 `lib/platform.js:169`).**
  Cel „panel przestaje kłamić" dotyczy *modułu* — `installMac()` produkuje plist, który wstaje,
  a `getStatus()` czyta stan po tej samej etykiecie. Wpięcia (`setup.mjs` / `POST /api/autostart`
  / pole `autostart` na dashboardzie) świadomie NIE robimy w tej fazie, bo:
  (a) autostart na Macu robi dziś **hook Claude Code** (`setup.mjs:1197`,
  `claude-cron-autostart.js`) — dołożenie launchd bez wygaszenia hooka daje DWA mechanizmy
  wskrzeszające serwer na tym samym porcie 7777 (dokładnie ta klasa awarii, którą Faza 2 właśnie
  zamykała wykryciem zajętego portu); wybór „hook czy launchd" to decyzja produktowa, której plan
  Fazy 3 (R10) nie podejmował;
  (b) `POST /api/autostart` to nowa mutująca powierzchnia wymagająca guardów (XFF + cross-origin,
  jak `/api/inbox/members`) i UI — over-specification wobec zakresu Unitu 8.
  Wpięcie jest zapisane jako **Unit 10 w „Follow-up po Fazie 3"** (`rownolegle-joby-zadania.md`).
  Konsekwencja dla operatora: dopóki wpięcia nie ma, instalacja launchd idzie ręcznie —
  `node -e "console.log(require('./lib/platform').install())"` (checklist operatora zaktualizowana).
  Ta sama decyzja zawiesza dwa sprzeczne findingi P3 wokół `buildMacStatus` (asymetryczne DI vs
  YAGNI gałęzi legacy) — rozstrzyga je dopiero konsument w UI.
- **`installMac()`/`removeLegacyAgents()`/`unloadAgent()`/`readLaunchctlList()` dostały wstrzykiwalne
  I/O** (`REAL_IO`, domyślny argument `io`) i pierwsze testy — kontraktem tych funkcji jest
  KOLEJNOŚĆ kroków (katalog logów + unload PRZED zapisem plista i przed `load`), której nie da się
  zweryfikować czystą funkcją, a realny `launchctl load` wymaga sesji GUI. Wzorzec ten sam co
  `db.setDbPath` / `claude-spawn.setClaudeBin`. Zachowanie produkcyjne bez zmian.
  Pokryte: kolejność kroków, sprzątanie legacy przed zapisem, pad `unload` nieprzerywający
  instalacji, kasowanie legacy plista mimo padu `unload` (świadomy kontrakt + ostrzeżenie),
  `unloadAgent` ok/pad, `readLaunchctlList` output/pad z ostrzeżeniem RAZ na proces.
- **Suita jest przenośna** — asercja o `path.basename(PLIST_PATH)` dostała
  `{ skip: process.platform !== 'darwin' }`, a kontrakt „jedna stała etykiety" ma teraz drugą,
  platformo-niezależną asercję (`status.label === PLIST_LABEL`). Zweryfikowane wymuszonym
  `process.platform='linux'`: 35 pass / 1 skip / 0 fail (na macOS 36/36).
