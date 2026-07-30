---
title: "feat: Równoległe joby (limit + slot rezerwowy) + instalator, autostart Maca, opóźnienie po wybudzeniu"
type: feat
status: active
date: 2026-07-30
origin: docs/plans/2026-07-30-rownolegle-joby.md
design_md: null
figma_spec: null
figma_screens: {}
---

# feat: Równoległe joby (limit + slot rezerwowy) + trzy zakresy sprintu

## Przegląd

Sprint zamyka cztery zakresy w jednym planie:

1. **Równoległe joby** — jeden limit współbieżności zamiast globalnego slotu, jeden slot
   zarezerwowany dla zadań krótkich, klasyfikacja krótkie/długie **z historii czasów** (nie
   z `job_type`), budzenie kolejki przy dokolejkowaniu runu, wyłączność plikowa punktowo.
2. **Instalator** — konfigurowalny katalog instalacji + wykrycie zajętego portu.
3. **Autostart na Macu** — panel kłamie (`installed:false` mimo działającego launchd),
   a `generatePlist()` produkuje plist, który by nie wstał.
4. **Opóźnienie startu po wybudzeniu** — joby wymagające sieci padają zaraz po wybudzeniu Maca.

Zakres 1 to ~⅔ wysiłku sprintu i jedyny, który zmienia architekturę. Pozostałe trzy są
niezależne i mogą lądować w dowolnej kolejności po nim.

> **Ten plan zastępuje `docs/plans/2026-07-30-rownolegle-joby.md`** w części architektonicznej.
> Dokument źródłowy zostaje jako zapis rozważań i odrzuconych alternatyw — ale jego sekcje
> „Decyzja: Dwa pasy i śluzy", „Scheduler: nowy processQueue" i „Nowe testy" są **nieaktualne**
> (patrz `Rozważane alternatywy` → „Dwa pasy po `job_type`").

## Ujęcie problemu

`lib/executor.js` trzyma jeden globalny slot (`currentProcess`/`currentRunId`, executor.js:8-9),
a `scheduler.processQueue` (scheduler.js:12-44) wykonuje jeden run naraz i przerywa pętlę,
gdy `executor.isRunning()`. Skutek: każde zadanie czeka za każdym innym.

Zmierzone na żywej bazie Maca (`data/claude-cron.db`, typowe czasy udanych runów):

| Job | `job_type` | typowy czas | kadencja |
|---|---|---|---|
| Classroom sync → repo zespołu | **script** | **747 s** (max 910 s) | pon. 9:00 |
| Weekly memory update | claude | 346 s | pon. 8:00 |
| Poszukiwanie nowych skillów | claude | 298 s | pt. 9:00 |
| Daily memory update | claude | 293 s | codz. 10:00 |
| Reflect tygodniowy | claude | 165 s | pon. 8:00 |
| FB Emaile (webhook) | claude | 115 s | ad-hoc |
| Aktualizacja .env | claude | **18 s** | 8/12/16/20 |
| Team OS — inbox sync | script | **2 s** (max 975 s — sen maszyny) | **co minutę** |
| Sync — kontrola vaulta | script | **0 s** | co 15 min |

W poniedziałek ~9:00 Skrzynka stoi kwadrans, choć obiecuje latencję minuty.

**Dane obalają podział z dokumentu źródłowego.** Najdłuższy job w systemie (Classroom sync,
747 s) ma `job_type: 'script'` — czyli trafiłby na „pas lekki" z limitem 1 i zablokowałby
inbox sync dokładnie w tym scenariuszu, dla którego projekt powstał. Symetrycznie
„Aktualizacja .env" (claude, 18 s) trafiłaby na pas ciężki. `job_type` opisuje **czym się
uruchamia** (skrypt Node vs agent), nie **jak długo trwa**.

## Śledzenie wymagań

- **R1.** Run zadania krótkiego nigdy nie czeka na zakończenie zadania długiego — także gdy
  zostaje dokolejkowany **w trakcie** biegnącego runu długiego.
- **R2.** Domyślnie kilka zadań długich biegnie równolegle (decyzja Kacpra 30.07 —
  uzasadnienie „1 naraz, bo zasoby" odrzucone jako obalone przez `/ask`, patrz niżej).
- **R3.** Podział krótkie/długie wynika z **pomiaru**, nie z deklaracji ani z `job_type`.
- **R4.** Dwa runy tego samego joba nigdy nie biegną równocześnie.
- **R5.** Zadania piszące w te same pliki da się rozłączyć deklaratywnie; zadania używające
  tego samego skilla/skryptu są rozłączone **automatycznie**, bez deklaracji.
- **R6.** Kill działa per konkretny run; kontrakt „killed milczy" (zapis `killed` do DB PRZED
  ubiciem procesu) zostaje nienaruszony.
- **R7.** Istniejące 640 testów przechodzi **bez modyfikacji**.
- **R8.** Da się zmierzyć efekt: czas oczekiwania runu w kolejce jest zapisywany.
- **R9.** Instalator pozwala wybrać katalog instalacji i nie wywala się cicho na zajętym porcie.
- **R10.** Panel pokazuje prawdę o autostarcie na Macu, a instalowany plist **wstaje**.
- **R11.** Joby wymagające sieci nie padają natychmiast po wybudzeniu maszyny.

## Granice scope'u

- **Nie** dotykamy `/ask` — asystent głosowy ma własne bramki (lock sync + 3 sloty tła,
  `lib/ask.js`) i celowo **nie wlicza się** do limitu współbieżności jobów. Zmiana tego byłaby
  osobną decyzją produktową; dziś działa i nikt się nie skarżył.
- **Nie** budujemy wykrywania kolizji plikowych (`fs.watch`, profile zapisu, hooki PreToolUse) —
  odrzucone w dokumencie źródłowym i podtrzymane: na maszynie z Obsidian Sync nie da się
  odróżnić zapisu agenta od zapisu synchronizacji.
- **Nie** robimy przycisku „zatrzymaj wszystko" — przy 2-3 równoczesnych runach lista z
  przyciskiem per wiersz wystarcza.
- **Nie** zmieniamy identyfikatorów technicznych (`claude-cron` w nazwach plików, labelach,
  env-varach) — patrz `docs/CONCEPTS.md` → „Puls".
- **Nie** wchodzimy w rebrand — jest w `main` od 27.06 (gałąź `feature/migracja-puls-rebrand`
  jest przodkiem maina, archiwum w `docs/completed/migracja-puls-rebrand/`).

## Kontekst i research

### Relevantny kod i wzorce

- `lib/scheduler.js:12-44` — `processQueue`, guard `queueProcessing`, retry-check na świeżym
  odczycie z DB (scheduler.js:31). Cała ta logika przenosi się do nowej pętli **bez zmian
  semantycznych**.
- `lib/scheduler.js:91-111` — `computeMissedJobs` jako wzorzec **czystej, testowalnej funkcji
  bez I/O**: argumenty wchodzą, decyzja wychodzi. Picker kwalifikowalności ma być zbudowany
  dokładnie tak samo.
- `lib/executor.js:8-9` — jedyne globalne singletony. Timery (idle/watchdog/sleep-aware,
  executor.js:218-250) **już żyją w domknięciu `executeRun`**, czyli są per-run i nie wymagają
  zmian.
- `lib/executor.js:286-291, 369-371` — guard „kill przez usera nie kończy jako `failed`":
  świeży odczyt runu z DB przed zapisem statusu. Działa per `run.id` i przechodzi bez zmian.
- `lib/executor.js:361-391` — guard `settled` + ratunkowy timer (naprawa 29.07). Musi czyścić
  swój wpis w mapie zamiast zerować singleton.
- `lib/db.js:105-120` — wzorzec migracji kolumn (`PRAGMA table_info` + `ALTER TABLE`),
  idempotentny, do naśladowania dla `lock_group` i `queued_at`.
- `lib/db.js:169-180` — allow-listy `createJob`/`updateJob`; nowa kolumna musi trafić do obu.
- `lib/db.js:318, 329-341, 343-345` — `getCurrentRun` (`LIMIT 1` do zdjęcia), `reapOrphanedRuns`
  (już obsługuje wiele wierszy `running` — zero zmian), `getQueuedRuns` (`ORDER BY id ASC`).
- `lib/platform.js:6, 10-48` — `PLIST_LABEL = 'com.claude-cron.scheduler'` vs realnie działający
  `com.claude-cron.daemon`; `generatePlist()` bierze `which node` i pisze logi do `<repo>/data/`.
- `~/Library/LaunchAgents/com.claude-cron.daemon.plist` — **działający wzorzec z 23.07**:
  wrapper `/bin/sh -c`, `cd <repo> && exec ./.node/.../bin/node server.js`, logi w
  `~/Library/Logs/claude-cron/`, env (`CLAUDE_CRON_WORKSPACE`, `CLAUDE_CRON_VPS_URL`, `HOME`, `PATH`).
- `install.sh:30` — `INSTALL_DIR="${INSTALL_DIR:-$HOME/claude-cron}"` (env-override już jest,
  brakuje pytania interaktywnego); `lib/config.js:25` — `PORT` z `CLAUDE_CRON_PORT`, default 7777.
- `scripts/sync-heartbeat.mjs` — istniejący wzorzec „osąd tylko na właściwej maszynie" i
  wykrywania powrotu sieci po wybudzeniu; źródło pomysłów dla zakresu 4.

### Wiedza instytucjonalna (`docs/solutions/`)

- **`2026-07-03-stale-obiekt-w-pamieci-vs-stan-db-martwe-retry.md`** — po zapisie wyniku do DB
  decyduj na **świeżym odczycie**, nie na obiekcie z pamięci. Retry w nowej pętli musi dalej
  czytać `db.getRunWithPayload(run.id)`, a nie obiekt z pickera. Dodatkowo: „gdy moduł A
  wstrzymuje akcję zakładając, że B coś zrobi — napisz test integracyjny A+B". Dotyczy dosłownie
  pary scheduler↔executor w tym planie.
- **`2026-07-14-close-nie-odpala-wnuk-dziedziczy-pipe-wyciek-slotu.md`** — zwolnienie zasobu
  (tu: **wpisu w mapie aktywnych runów**) nie może wisieć wyłącznie na `'close'`; domykaj na
  `'exit'` z karencją, w idempotentnym `settle()`. Przy jednym globalnym slocie wyciek blokował
  całą kolejkę; przy mapie wycieknie slot i zafałszuje picker — ten sam błąd, cichszy objaw.
- **`2026-07-28-async-seed-vs-sync-scheduler-job-bez-harmonogramu.md`** — asynchroniczna
  operacja przy starcie tworząca stan, który czyta kod po niej, to wyścig; dawaj hak, nie licz
  na kolejność. Test musi **odtwarzać kolejność startu**.
- **`2026-06-27-backfill-w-migrate-clobberuje-opt-outy.md`** — `migrate()` leci co boot; backfill
  danych owijaj sentinelem w `state`. W tym planie **nie ma backfillu** (nowe kolumny startują
  puste i to jest poprawne zachowanie) — reguła jest tu jako zakaz, nie jako zadanie.
- **`2026-06-29-migracja-better-sqlite3-na-node-sqlite.md`** — pułapka BigInt na agregatach
  SQL. Klasyfikacja krótki/długi **nie liczy median w SQL** — pobiera do 10 wartości i liczy
  medianę w JS.
- **`2026-06-23-per-job-recent-runs-window-function.md`** — „N ostatnich per grupa" wymaga window
  function. Tu **świadomie** pytamy per pojedynczy job (kolejka ma jednostki, nie tysiące
  wierszy), więc `LIMIT 10` jest poprawne — ale jeśli kiedyś będziemy liczyć statystyki dla
  wszystkich jobów naraz, obowiązuje `ROW_NUMBER() OVER (PARTITION BY job_id ...)`.
- **`2026-07-28-windows-re-run-instalatora-zablokowane-pliki-i-cache-raw.md`** — dotyczy
  zakresu 2 (instalator): podmiana katalogu wymaga wcześniejszego ubicia procesów po **ścieżce
  instalacji**, a testy na macOS nie powiedzą nic o Windowsie.

### Referencje zewnętrzne

Pominięte świadomie — problem jest wewnętrzny (własny scheduler, własna baza), a codebase ma
mocne wzorce lokalne dla każdej potrzebnej decyzji.

## Kluczowe decyzje techniczne

- **Jeden limit + slot rezerwowy zamiast dwóch pasów po `job_type`.** `max_concurrent` (klucz
  w tabeli `state`, zero migracji schematu, edytowalny z dashboardu, **per maszyna** — każda
  instancja ma własny SQLite). Zadania długie mogą zająć najwyżej `max_concurrent - 1` slotów;
  ostatni slot jest zawsze dostępny wyłącznie dla krótkich. To jest mechanizm realizujący R1 i
  jedyny, który nie zależy od poprawności żadnej etykiety.
- **Default `max_concurrent = 3`.** Nie „ile wlezie": limit planu Claude jest wspólny dla
  wszystkich procesów, więc równoległość nie tworzy przepustowości — przyspiesza zużycie
  okna. 3 daje 2 długie + rezerwę i jest liczbą do podniesienia na podstawie obserwacji, nie
  na wyrost.
- **Klasyfikacja z pomiaru: mediana czasu ostatnich 10 **udanych** runów < 60 s = krótki.**
  Mediana, nie średnia — inbox sync ma typowo 0,2 s przy maksimum 975 s (sen maszyny); średnia
  wrzuciłaby najlżejszy job systemu do kategorii długich. Tylko udane runy — timeout mówi o
  limicie, nie o pracy; efekt uboczny: job, który zawsze pada, nigdy nie wejdzie do rezerwy.
- **Zero udanych runów = długi (fail-safe).** Koszt pomyłki jest asymetryczny: „nowy uznany za
  krótki, a jest 12-minutowy" zajmuje slot rezerwowy i blokuje inbox sync — czyli łamie jedyną
  gwarancję planu. Odwrotna pomyłka kosztuje jedno opóźnione uruchomienie.
- **Próg 60 s bezpieczny, bo rozkład jest bimodalny.** Typowe czasy: 747, 346, 298, 293, 165,
  115 ‖ 18, 2, 0 s. Między 18 a 115 s nie ma nic — dokładna wartość progu nie zmienia podziału.
- **Budzenie kolejki („dzwonek").** Pętla drain czeka na `Promise.race([...aktywne runy, sygnał
  nowej pracy])`; `enqueueJob` rozwiązuje sygnał. Bez tego pętla re-pickuje dopiero po
  zakończeniu któregoś runu — a wtedy inbox sync dokolejkowany o 9:01 czeka do 9:14 mimo wolnego
  slotu, czyli feature nie robi nic. Guard `queueProcessing` **zostaje** (jedna pętla; wielokrotne
  współbieżne pętle mnożą retry-check i utrudniają rozumowanie).
- **Wyłączność: trzy reguły, dwie automatyczne.** (a) nigdy dwa runy tego samego `job_id`;
  (b) nigdy dwa runy jobów o tym samym niepustym `skill_name` **lub** tym samym niepustym
  `command` — to za darmo rozłącza „Daily memory update" i „Weekly memory update" (ten sam skill
  `memory-update`); (c) nigdy dwa runy z tą samą niepustą `lock_group` (nowa nullable kolumna
  w `jobs`) — dla kolizji między różnymi skillami.
- **Model fail-open (decyzja Kacpra 30.07).** Brak deklaracji = zgoda na równoległość. Świadomie
  przyjęte ryzyko: nowe zadanie piszące w te same pliki co inne nie jest chronione, dopóki ktoś
  tego nie zauważy. Odrzucony wariant fail-closed opisany w `Rozważane alternatywy`.
- **Kolizje znane z harmonogramu naprawiamy harmonogramem, nie mechanizmem.** Na VPS-ie
  „Aktualizacja folderu .claude" (script) i „CC Update" (skill `changelog-sync`) odpalają
  `0 */4 * * *` — ta sama minuta, 6× na dobę, oba dotykają obszaru `.claude`. Rozstrzelenie
  godzin usuwa kolizję trwale i bez kodu. Analogicznie pon. 8:00 na Macu (Weekly memory +
  Reflect tygodniowy + Aktualizacja .env).
- **Picker jako czysta funkcja.** `pickEligibleRuns({queued, jobsById, activeRuns, stats,
  maxConcurrent, fastThresholdMs})` → lista runów do startu. Zero I/O, zero `Date.now()` w
  środku — wzorzec `computeMissedJobs`. To jest jedyny sposób, żeby przetestować kombinatorykę
  (limit × rezerwa × 3 reguły wyłączności) bez spawnowania procesów.
- **`queued_at` na `runs`.** Tabela ma dziś tylko `started_at`/`finished_at`, więc czas
  oczekiwania w kolejce jest **niemierzalny** — ani przed, ani po zmianie. Jedna kolumna daje
  metrykę odbioru całego sprintu (R8).
- **`/ask` poza limitem.** Dziś potrafi trzymać 1 run synchroniczny + 3 w tle, niezależnie od
  kolejki jobów — czyli produkcja od tygodni pokazuje 4 równoległe procesy `claude` bez
  problemów zasobowych. To jest empiryczne obalenie uzasadnienia „1 ciężki naraz, bo zasoby"
  z dokumentu źródłowego i powód, dla którego R2 jest bezpieczne.

## Otwarte pytania

### Rozwiązane podczas planowania

- **Czym rozdzielić tory — `job_type` czy pomiar?** Pomiarem. Dane z żywej bazy (Classroom sync
  = script/747 s, Aktualizacja .env = claude/18 s) pokazują, że `job_type` klasyfikuje odwrotnie
  w obie strony.
- **Ile równolegle?** 3 domyślnie, edytowalne, per maszyna. Ograniczeniem jest okno limitu planu
  Claude, nie CPU/RAM.
- **Co z nowym zadaniem bez historii?** Traktowane jak długie do pierwszego udanego runu.
- **Fail-open czy fail-closed dla zadań długich?** Fail-open (decyzja Kacpra 30.07).
- **Czy `/ask` wlicza się do limitu?** Nie — ma własne bramki, zmiana byłaby osobną decyzją.
- **Czy kolejność sprintu zmienia rebrand?** Nie — rebrand jest w `main` od 27.06.

### Odroczone do implementacji

- **Dokładny kształt sygnału budzenia** (deferred promise vs `EventEmitter` vs krótki tick) —
  rozstrzygnąć przy pisaniu pętli; kontraktem jest zachowanie (test z IU 3), nie mechanizm.
- **Czy `getRunningRuns()` wystarczy do UI, czy dashboard potrzebuje też `queued`** — okaże się
  przy pierwszym uruchomieniu z 2-3 równoczesnymi runami.
- **Próg „ile próbek wystarcza"** — plan mówi „do 10 ostatnich udanych"; czy przy 1-2 próbkach
  ufać medianie, czy wymagać minimum 3, rozstrzygnąć na realnych danych po wdrożeniu
  (dziś: każdy job z historią ma ich kilkanaście).
- **Czy zakres 4 (opóźnienie po wybudzeniu) potrzebuje realnego testu sieci**, czy wystarczy
  test czystej funkcji decydującej o odroczeniu — zależy od kształtu, jaki przyjmie detekcja.

## Implementation Units

> **Uwaga o polach `Delegate to` / `Skills in play`:** repo jest czystym CommonJS + vanilla JS
> (zero Reacta, Tailwinda, Supabase). Pola wypełnione zgodnie z konwencją `/dev-plan`
> (warstwa danych/backend → `feature-builder-data`, warstwa prezentacji → `feature-builder-ui`),
> a lustrzane listy skilli są **nominalne** — realnie obowiązują `.claude/rules/coding-rules.md`,
> `.claude/rules/learned-patterns.md` i CLAUDE.md tego repo.

### Faza 1 — Równoległość (rdzeń sprintu)

- [x] **Unit 1: Warstwa danych — kolumny, statystyki czasów, runy aktywne**

**Cel:** dać schedulerowi wszystko, czego potrzebuje do decyzji, i wprowadzić metrykę odbioru.

**Wymagania:** R3, R4, R5, R8

**Zależności:** brak

**Pliki:**
- Modyfikuj: `lib/db.js`
- Test (unit): `lib/db.test.js`

**Delegate to:** feature-builder-data

**Skills in play:** supabase-dev-guidelines, security, sentry-integration *(nominalnie — patrz uwaga wyżej)*

**Podejście:**
- Migracja kolumny `lock_group TEXT` w `jobs` i `queued_at TEXT` w `runs` wzorcem z db.js:105-120
  (`PRAGMA table_info` + `ALTER TABLE` w warunku). **Bez backfillu** — istniejące runy zostają
  z `queued_at = NULL` i to jest poprawne (nie znamy tej wartości wstecz).
- `createRun` ustawia `queued_at` na moment wstawienia.
- `lock_group` dopisane do allow-list `createJob` (db.js:169) **oraz** `updateJob` (db.js:179).
- `getRunningRuns()` — dzisiejszy `getCurrentRun` bez `LIMIT 1`. `getCurrentRun` zostaje
  (kompatybilność `server.js:292`, `server.js:415`).
- `getRecentSuccessDurations(jobId, limit = 10)` — zwraca tablicę czasów w ms z ostatnich udanych
  runów (`status='success'`, `started_at`/`finished_at` niepuste, `ORDER BY id DESC`). **Liczby
  liczone w JS z timestampów**, nie agregatem SQL (pułapka BigInt, `docs/solutions/2026-06-29`).
- `getQueueWaitStats(hours)` — średni i maksymalny czas `started_at - queued_at`; zasila metrykę
  odbioru i przyszłą diagnostykę. Runy z `queued_at = NULL` pomijane.

**Wzorce do naśladowania:**
- `lib/db.js:105-120` (migracje idempotentne), `lib/db.js:329-341` (`reapOrphanedRuns` — zwracanie
  znormalizowanych obiektów, node:sqlite oddaje wiersze z null-prototype).

**Scenariusze testowe:**
- [Unit] `migrate()` odpalone dwukrotnie nie rzuca i nie duplikuje kolumn.
- [Unit] `createJob({lock_group:'dashboard'})` zapisuje wartość; `updateJob` ją zmienia i czyści.
- [Unit] `createRun` ustawia `queued_at`; `getQueueWaitStats` liczy czekanie i **pomija** runy bez
  `queued_at`.
- [Unit] `getRunningRuns()` zwraca wszystkie wiersze `running` (≥2), `getCurrentRun()` dalej jeden.
- [Unit] `getRecentSuccessDurations` ignoruje runy `failed`/`timeout`/`killed` i runy bez
  `started_at`; zwraca **liczby** (`typeof === 'number'`), nie BigInt.

**Weryfikacja:**
- `node --test lib/db.test.js` przechodzi bez błędów.
- `npm test` przechodzi w całości (640 istniejących testów bez modyfikacji).

---

- [x] **Unit 2: Executor — mapa aktywnych runów i kill per run**

**Cel:** zdjąć globalny slot, nie ruszając ani jednego timera i ani jednego guardu.

**Wymagania:** R2, R6, R7

**Zależności:** brak (może lecieć równolegle z Unit 1)

**Pliki:**
- Modyfikuj: `lib/executor.js`
- Test (unit): `lib/executor.test.js`

**Delegate to:** feature-builder-data

**Skills in play:** supabase-dev-guidelines, security, sentry-integration *(nominalnie)*

**Podejście:**
- `currentProcess`/`currentRunId` → `activeRuns = Map(runId → {proc, jobId, startedAt})`.
  Rejestracja **synchronicznie** zaraz po udanym spawnie, wyrejestrowanie w `close`/`error`/
  `finishScriptRun`.
- `killCurrent()` → `killRun(runId)`: ta sama sekwencja (zapis `killed` do DB **przed** ubiciem
  procesu, SIGTERM→SIGKILL / `taskkill /T /F`). `killCurrent()` zostaje jako cienki shim:
  0 aktywnych → `false`, 1 → `killRun(tego)`, >1 → sygnał niejednoznaczności dla warstwy HTTP.
- `isRunning()` → `activeRuns.size > 0`, `getCurrentRunId()` → pierwszy klucz. Shimy istnieją
  wyłącznie dla starych call-site'ów i testów (R7).
- **Wyrejestrowanie musi być idempotentne i domknięte także na `'exit'`** — `docs/solutions/
  2026-07-14`: wnuk dziedziczący pipe potrafi nie dopuścić `'close'`. Wpis w mapie to dziś
  odpowiednik slotu z tamtej awarii.
- Timery (executor.js:218-250), guard `settled` (executor.js:361) i guard „kill przez usera"
  (executor.js:286-291, 369-371) **bez zmian semantycznych** — tylko czyszczą swój wpis w mapie
  zamiast zerować singleton.

**Notatka wykonawcza:** zacznij od testu „dwa jednoczesne runy: kill jednego, drugi żyje" — to
jedyny test, który wykrywa przypadkowy powrót do semantyki singletonu.

**Wzorce do naśladowania:**
- `lib/executor.js:361-391` (`finishScriptRun` z guardem `settled`) — kształt idempotentnej
  finalizacji do powtórzenia dla wyrejestrowania z mapy.

**Scenariusze testowe:**
- [Unit] Dwa runy skryptowe równocześnie: `killRun(id1)` kończy run 1 jako `killed`, run 2
  kończy się normalnie jako `success`.
- [Unit] `killRun` zapisuje `killed` do DB **przed** ubiciem — `close` nie nadpisuje statusu na
  `failed` i **nie wysyła ❌** (kontrakt „killed milczy").
- [Unit] `killRun(nieistniejący)` zwraca `false` i nie rzuca.
- [Unit] Po zakończeniu obu runów `activeRuns.size === 0` i `isRunning() === false`.
- [Unit] Proces, dla którego `'close'` nigdy nie przychodzi (ratunkowy timer), też zwalnia wpis
  w mapie.

**Weryfikacja:**
- `node --test lib/executor.test.js` przechodzi.
- `npm test` przechodzi w całości.

---

- [x] **Unit 3: Scheduler — picker, slot rezerwowy, dzwonek**

**Cel:** serce zmiany. Zamienia „weź pierwszy i czekaj" na „startuj wszystko, co się kwalifikuje,
i reaguj natychmiast, gdy pojawi się nowa praca".

**Wymagania:** R1, R2, R3, R4, R5, R7

**Zależności:** Unit 1, Unit 2

**Pliki:**
- Modyfikuj: `lib/scheduler.js`
- Test (unit): `lib/scheduler.test.js`

**Delegate to:** feature-builder-data

**Skills in play:** supabase-dev-guidelines, security, sentry-integration *(nominalnie)*

**Podejście:**
- **Czysta funkcja `classifyJob(durations, thresholdMs)`** → `'short' | 'long'`: mediana z
  przekazanych czasów; pusta tablica → `'long'`.
- **Czysta funkcja `pickEligibleRuns({queued, jobsById, activeRuns, durationsByJob,
  maxConcurrent, fastThresholdMs})`** → tablica runów do startu. Reguły, w kolejności:
  1. globalny limit `maxConcurrent`;
  2. zadania długie mogą zajmować najwyżej `maxConcurrent - 1` (minimum 1) — reszta to rezerwa
     dla krótkich;
  3. brak aktywnego runu tego samego `job_id`;
  4. brak aktywnego runu joba o tym samym niepustym `skill_name` **lub** `command`;
  5. brak aktywnego runu z tą samą niepustą `lock_group`.
  Skan po `id ASC` (FIFO w obrębie każdej blokady wychodzi naturalnie).
- **Pętla drain** w `processQueue`: startuj kwalifikujące się → `await Promise.race([...aktywne,
  sygnałNowejPracy])` → re-pick → powtarzaj aż kolejka pusta **i** brak aktywnych. Guard
  `queueProcessing` zostaje (jedna pętla naraz). Promise `processQueue()` nadal rozwiązuje się po
  opróżnieniu kolejki — `scheduler.test.js:285` musi przejść bez zmian (R7).
- **Sygnał nowej pracy** rozwiązywany przez `enqueueJob` po `db.createRun`; po każdym wybudzeniu
  tworzony świeży. To jest realizacja R1 — bez tego wszystko powyżej jest ozdobą.
- **Retry-check bez zmian semantycznych**: po zakończeniu każdego runu świeży odczyt
  `db.getRunWithPayload(run.id)` i `db.countRecentFailedRuns` (scheduler.js:31-39) —
  `docs/solutions/2026-07-03-stale-obiekt-w-pamieci`. Przenosimy logikę, nie przepisujemy.
- `max_concurrent` czytane z `state` **w momencie pickowania** (zmiana z dashboardu działa bez
  restartu — wzorzec `notify-config.js`), z domyślną wartością 3 i sanityzacją (liczba ≥ 1).

**Notatka wykonawcza:** test-first dla obu czystych funkcji i dla scenariusza „krótki
dokolejkowany w trakcie długiego". Ten ostatni **musi** kolejkować run krótki dopiero po starcie
długiego — wersja, w której oba stoją w kolejce od początku, przechodzi także na zepsutej
implementacji i daje fałszywe zielone światło.

**Wzorce do naśladowania:**
- `lib/scheduler.js:91-111` (`computeMissedJobs`) — czysta funkcja, argumenty zamiast globali.
- `lib/notify-config.js` — rozwiązywanie konfiguracji w czasie użycia, nie przy `require`.

**Scenariusze testowe:**
- [Unit] `classifyJob`: mediana odporna na wartość odstającą (`[0.2, 0.2, 0.3, 975]` → krótki);
  pusta historia → długi; wartość dokładnie na progu → długi (granica domknięta w dół).
- [Unit] `pickEligibleRuns`: przy `maxConcurrent=3` i dwóch aktywnych długich **nie startuje**
  trzeciego długiego, ale **startuje** krótki.
- [Unit] `pickEligibleRuns`: nigdy dwa runy tego samego `job_id`.
- [Unit] `pickEligibleRuns`: dwa joby o tym samym `skill_name` nie biegną razem (bez deklaracji);
  to samo dla identycznego `command`.
- [Unit] `pickEligibleRuns`: dwa joby z `lock_group='dashboard'` nie biegną razem; drugi startuje
  po zakończeniu pierwszego, w kolejności `id ASC`.
- [Unit] **(test odbioru R1)** run krótkiego joba dokolejkowany **w trakcie** biegnącego runu
  długiego kończy się **przed** nim.
- [Unit] Retry (R9) działa przy równoległym drainie: fail → retry → ❌ dokładnie raz.
- [Unit] `processQueue()` rozwiązuje się dopiero po opróżnieniu kolejki i domknięciu aktywnych
  runów (istniejący `scheduler.test.js:285` bez modyfikacji).
- [Unit] `max_concurrent` zmieniony w `state` w trakcie życia procesu wpływa na kolejny pick.

**Weryfikacja:**
- `node --test lib/scheduler.test.js` przechodzi.
- `npm test` przechodzi w całości — 640 istniejących testów bez modyfikacji (R7).

---

- [x] **Unit 4: API — kill per run, lista aktywnych, ustawienie limitu**

**Cel:** wystawić nowy stan na zewnątrz bez psucia istniejących klientów (dashboard, skill `/puls`).

**Wymagania:** R2, R6, R8

**Zależności:** Unit 1, Unit 2, Unit 3

**Pliki:**
- Modyfikuj: `server.js`
- Test (unit): `lib/scheduler.test.js` *(sekcja HTTP)* lub nowy `server.runs.test.js` — decyzja
  implementatora zgodnie z układem istniejących testów HTTP (`lib/ask.http.test.js` jako wzorzec)

**Delegate to:** feature-builder-data

**Skills in play:** supabase-dev-guidelines, security, sentry-integration *(nominalnie)*

**Podejście:**
- `POST /api/runs/:id/kill` — kill konkretnego runu.
- `POST /api/runs/current/kill` **zostaje**: 0 aktywnych → dzisiejsza odpowiedź, 1 → kill,
  >1 → **409 z listą aktywnych runów** (żadnego zgadywania, który zabić).
- `GET /api/status` — nowe pole `current_runs` (tablica z `db.getRunningRuns()`); `current_run`
  zostaje jako pierwszy element (kompatybilność z dashboardem i skillem `/puls`).
- `GET/PUT` ustawienia `max_concurrent` — walidacja: liczba całkowita ≥ 1, rozsądny sufit
  (odrzuć wartości absurdalne z czytelnym błędem). Endpoint **prywatny**, czyli za guardem XFF —
  kontrakt kolejności matcherów (webhook → ask → inbox → guard XFF → api/static) **nienaruszony**.
- Bez zmian w `reapOrphanedRuns()` przy starcie (db.js:329 już obsługuje wiele wierszy).

**Wzorce do naśladowania:**
- `server.js` — sekcja `/api/settings/notifications` (walidacja PUT, whitelist kluczy `state`).
- `lib/ask.http.test.js` — wzorzec testu HTTP na żywym procesie serwera z `CLAUDE_CRON_DB_PATH`
  i `CLAUDE_CRON_CLAUDE_BIN`.

**Scenariusze testowe:**
- [Unit] `POST /api/runs/:id/kill` ubija wskazany run; drugi aktywny żyje dalej.
- [Unit] `POST /api/runs/current/kill` przy dwóch aktywnych → **409** i lista w treści.
- [Unit] `POST /api/runs/current/kill` przy jednym aktywnym → zachowanie jak dziś.
- [Unit] `GET /api/status` zwraca `current_runs` jako tablicę i `current_run` = pierwszy element.
- [Unit] `PUT` ustawienia limitu odrzuca `0`, wartość ujemną i tekst; przyjmuje `1` i `5`.
- [Unit] Żądanie z nagłówkiem `X-Forwarded-For` na endpoint ustawień → 403 (guard XFF działa).

**Weryfikacja:**
- `npm test` przechodzi w całości.
- `grep` w `server.js` potwierdza, że matcher ustawień limitu leży **za** guardem XFF, a
  `/webhook`, `/ask`, `/inbox/v1` **przed** nim.

---

- [x] **Unit 5: Dashboard — lista biegnących runów, pole grupy, ustawienie limitu**

**Cel:** panel przestaje zakładać, że biegnie najwyżej jedno zadanie.

**Wymagania:** R2, R5, R6

**Zależności:** Unit 4

**Pliki:**
- Modyfikuj: `public/app.js`, `public/index.html`
- Test (e2e): `Scenariusz: dashboard z dwoma równoczesnymi runami — lista pokazuje oba wiersze
  z nazwą joba i czasem, przycisk „Zatrzymaj" przy jednym z nich kończy tylko ten run`

**Delegate to:** feature-builder-ui

**Skills in play:** tailwind-react-guidelines, ux-ui-guidelines, figma:figma-use,
figma-design-to-code *(nominalnie — repo używa vanilla JS bez frameworka i bez mockupów Figmy)*

**Podejście:**
- Kill-bar (public/app.js:328-334) → lista wierszy: nazwa joba + czas trwania + „Zatrzymaj" per
  wiersz. Bez przycisku „zatrzymaj wszystko".
- Formularz joba: opcjonalne pole „Grupa wyłączności" z krótkim wyjaśnieniem (grupa = wspólny
  plik/artefakt, **nie** „cały vault").
- Ustawienia: „Ile zadań naraz" z informacją, że wartość jest per maszyna i że jeden slot jest
  zarezerwowany dla zadań krótkich.
- Zachować istniejący guard pollingu (tani podpis payloadu, pomijanie `innerHTML` gdy bez zmian)
  — lista aktywnych runów zmienia się co sekundę i bez tego panel zacząłby migotać.

**Wzorce do naśladowania:**
- `public/app.js` — istniejący kill-bar i sekcja ustawień powiadomień; `public/render-helpers.js`
  jako miejsce na ewentualną czystą funkcję formatującą wiersz runu (jedyne testowane helpery
  frontu).

**Scenariusze testowe:**
- [Unit] Czysty helper renderujący wiersz aktywnego runu (nazwa + czas) — jeśli logika wyjdzie
  poza trywialną interpolację, ląduje w `public/render-helpers.js` z testem.
- [E2E] Dashboard `http://localhost:7777` z dwoma równoczesnymi runami: widoczne **dwa** wiersze
  aktywnych runów; kliknięcie „Zatrzymaj" w pierwszym zostawia drugi biegnący.
- [E2E] Formularz joba: zapis wartości w polu „Grupa wyłączności" i jej odczyt po przeładowaniu.
- [E2E] Ustawienia: zmiana „ile zadań naraz" zapisuje się i przeżywa przeładowanie strony.

**Weryfikacja:**
- `npm test` przechodzi (helpery frontu).
- Scenariusz E2E przez `/agent-browser`: dwa wiersze aktywnych runów widoczne jednocześnie,
  screenshot potwierdza; po kliknięciu „Zatrzymaj" zostaje jeden wiersz.

---

- [x] **Unit 6: Seed, harmonogramy i dokumentacja skilla `/puls`**

**Cel:** domknąć znane kolizje i opisać nowy model tam, gdzie go używa człowiek i agent.

**Wymagania:** R5

**Zależności:** Unit 1, Unit 3

**Pliki:**
- Modyfikuj: `lib/inbox-seed.js`
- Test (unit): `lib/inbox-seed.test.js`
- Modyfikuj: `CLAUDE.md` *(sekcja o schedulerze — nowy model kolejki)*
- Modyfikuj: skill `puls` (`skills/puls/SKILL.md` w repo — instalowany do `~/.claude/skills/puls`)

**Delegate to:** feature-builder-data

**Skills in play:** supabase-dev-guidelines, security, sentry-integration *(nominalnie)*

**Podejście:**
- Seed joba „Team OS — inbox sync" dostaje `lock_group: 'dashboard'` (przepisuje banner
  w `Dashboard.md`). **Wyłącznie w `createJob`, zero `UPDATE`** — seed leci co boot, a „naprawianie"
  istniejącego joba clobberowałoby ręczne decyzje usera (kontrakt z CLAUDE.md).
- Skill `/puls`: opis pola „grupa wyłączności", zasada klasyfikacji krótki/długi (żeby agent nie
  wymyślał własnej) i **409 przy `current/kill`** z dwoma aktywnymi runami — stary klient bez
  aktualizacji zobaczy nieznany kod.
- Rozstrzelenie znanych kolizji harmonogramu — **operatorsko, nie kodem**: VPS „CC Update"
  vs „Aktualizacja folderu .claude" (`0 */4 * * *` → przesunięcie o kilkanaście minut);
  Mac pon. 8:00 (Weekly memory + Reflect tygodniowy).

**Scenariusze testowe:**
- [Unit] Seed nadaje `lock_group='dashboard'` przy tworzeniu joba sync.
- [Unit] Seed odpalony przy istniejącym jobie **nie** modyfikuje jego `lock_group` ani `enabled`.

**Weryfikacja:**
- `node --test lib/inbox-seed.test.js` przechodzi.
- `grep -c "lock_group" skills/puls/SKILL.md` > 0 — skill opisuje nowe pole.

**Operator checklist:**
- [ ] Przesunąć cron „CC Update" na VPS-ie tak, by nie pokrywał się z „Aktualizacja folderu .claude".
- [ ] Przejrzeć poniedziałkowy blok 8:00 na Macu i rozstrzelić godziny.
- [ ] Ustawić `max_concurrent` na VPS-ie (start: 3) i na Macu (start: 2), obserwować tydzień.

### Faza 2 — Instalator

- [x] **Unit 7: Konfigurowalny katalog instalacji i wykrycie zajętego portu**

**Cel:** pierwszy kontakt zespołu z produktem ma przejść gładko.

**Wymagania:** R9

**Zależności:** brak (niezależne od Fazy 1)

**Pliki:**
- Modyfikuj: `install.sh`, `install.ps1`, `setup.mjs`
- Test (unit): `install.test.sh`, `setup.test.mjs`, `install.ps1.Tests.ps1`

**Delegate to:** feature-builder-data

**Skills in play:** supabase-dev-guidelines, security, sentry-integration *(nominalnie)*

**Podejście:**
- Katalog instalacji: `install.sh:30` ma już `INSTALL_DIR` z env-override — brakuje **pytania**
  (przez `/dev/tty`, z domyślną wartością `$HOME/claude-cron`). Symetrycznie na Windowsie.
- Port: przed startem sprawdzić, czy `CLAUDE_CRON_PORT` (default 7777) jest wolny. Zajęty →
  czytelny komunikat z podpowiedzią, plus zapis wybranego portu do konfiguracji, żeby dashboard
  i autostart używały tej samej wartości.
- **Rozróżniać „port zajęty przez cudzy proces" od „port zajęty przez naszą starą instancję"** —
  drugi przypadek to normalny re-run instalatora, nie błąd.
- `docs/solutions/2026-07-28-windows-re-run-instalatora`: podmiana katalogu wymaga ubicia
  procesów **filtrem po ścieżce instalacji**, nigdy po nazwie binarki; suita na macOS tego nie
  wykryje.

**Scenariusze testowe:**
- [Unit] Instalator z podanym niestandardowym katalogiem instaluje tam i tam startuje.
- [Unit] Zajęty port → komunikat zawiera numer portu i sugestię; instalacja nie kończy się cicho
  „sukcesem" z martwym serwerem.
- [Unit] Port zajęty przez **naszą** starą instancję → ścieżka re-runu, nie błąd.
- [Unit] Pusta odpowiedź na pytanie o katalog → wartość domyślna (`$HOME/claude-cron`).

**Weryfikacja:**
- `bash install.test.sh` przechodzi.
- `node --test setup.test.mjs` przechodzi.
- Test przez **prawdziwy pipe** (`curl … | bash` z env-override źródła) — nie lokalne
  `bash install.sh` (`docs/solutions/2026-06-30-curl-bash-instalator-interaktywny-tty`).

**Operator checklist:**
- [ ] Przebieg instalatora na Windowsie (suita macOS nie pokrywa blokad plików).

### Faza 3 — Autostart na Macu

- [ ] **Unit 8: `installMac` przepisany pod wzorzec działającego plista**

**Cel:** panel przestaje kłamić, a instalowany plist faktycznie wstaje.

**Wymagania:** R10

**Zależności:** brak

**Pliki:**
- Modyfikuj: `lib/platform.js`
- Test (unit): `lib/platform.test.js` *(nowy — dziś modułu nie pokrywa żaden test)*

**Delegate to:** feature-builder-data

**Skills in play:** supabase-dev-guidelines, security, sentry-integration *(nominalnie)*

**Podejście:**
- **Nie naprawiać samej etykiety.** `PLIST_LABEL` (platform.js:6) rozjeżdża się z realnie
  działającym `com.claude-cron.daemon`, ale samo wyrównanie nazwy dałoby panel mówiący prawdę
  o pliście, który i tak by nie wstał: `generatePlist()` pisze logi do `<repo>/data/`
  w `~/Documents` (TCC → `EX_CONFIG 78`), bierze `which node` zamiast portable Node z `.node/`
  i nie ustawia env (`CLAUDE_CRON_WORKSPACE`, `CLAUDE_CRON_VPS_URL`).
- Wzorzec docelowy = działający `~/Library/LaunchAgents/com.claude-cron.daemon.plist` z 23.07:
  wrapper `/bin/sh -c` z `cd <repo> && exec ./.node/<wersja>/bin/node server.js`, logi w
  `~/Library/Logs/claude-cron/`, pełny blok `EnvironmentVariables`.
- `getStatus()` musi rozpoznawać stan po **tej samej** etykiecie, którą instaluje, i radzić sobie
  z instalacją zrobioną ręcznie pod starą nazwą (migracja albo czytelna informacja — bez cichego
  duplikowania dwóch launchd agentów robiących to samo).
- Uwaga z `docs/solutions/2026-07-03-guardy-instalatora-falszywe-sygnaly`: stan zewnętrznego CLI
  czytaj z **dokładnej frazy**, nie substringiem, i potwierdzaj stan faktyczny.

**Notatka wykonawcza:** `lib/platform.js` nie ma dziś żadnego testu — zacznij od
characterization testu generatora plista (kształt XML, ścieżki, env), zanim zmienisz zachowanie.

**Scenariusze testowe:**
- [Unit] Wygenerowany plist zawiera wrapper `/bin/sh -c`, ścieżkę do portable Node z `.node/`
  i logi **poza** drzewem repo.
- [Unit] Wygenerowany plist zawiera `CLAUDE_CRON_WORKSPACE` i `CLAUDE_CRON_VPS_URL`, gdy są
  ustawione w środowisku instalacji.
- [Unit] `getStatus()` rozpoznaje agenta po etykiecie, którą instaluje `installMac()`.
- [Unit] Etykieta użyta w `PLIST_PATH`, `installMac` i `getStatus` to **jedna** stała
  (brak rozjazdu nazw).

**Weryfikacja:**
- `node --test lib/platform.test.js` przechodzi.
- `npm test` przechodzi w całości.

**Operator checklist:**
- [ ] Po instalacji: `launchctl list | grep claude-cron` pokazuje agenta, panel pokazuje
      „zainstalowany", a daemon przeżywa reboot Maca.

### Faza 4 — Opóźnienie startu po wybudzeniu

- [ ] **Unit 9: Karencja sieciowa po wykryciu wybudzenia**

**Cel:** joby wymagające sieci nie padają na `ENOTFOUND` w pierwszych sekundach po wybudzeniu.

**Wymagania:** R11

**Zależności:** Unit 3 (dotyka tej samej pętli kolejki)

**Pliki:**
- Modyfikuj: `lib/scheduler.js`
- Test (unit): `lib/scheduler.test.js`

**Delegate to:** feature-builder-data

**Skills in play:** supabase-dev-guidelines, security, sentry-integration *(nominalnie)*

**Podejście:**
- Wykrycie wybudzenia: heartbeat (`last_active_at`, co 60 s) już zapisuje ślad snu; luka między
  tyknięciami większa od progu = maszyna spała. Wzorzec progu i uzasadnienie „dlaczego minuta,
  a nie kilkanaście sekund" — `lib/executor.js:20-31` (`SLEEP_GAP_MS`).
- Po wykryciu wybudzenia odroczyć **pierwszy** start runu o 30-60 s. Decyzję wyrazić **czystą
  funkcją** (`shouldDeferAfterWake(lastActiveAt, now, graceMs)`), żeby dała się przetestować bez
  zegara i bez sieci.
- Retry zostaje bez zmian — to karencja, nie zamiennik retry.
- Rozstrzygnąć w implementacji (świadomie odroczone): czy karencja dotyczy wszystkich jobów, czy
  tylko tych z `run_on_wake`; oraz czy zamiast sztywnego czekania nie jest lepszy krótki
  probe sieci — `scripts/sync-heartbeat.mjs` ma już wzorzec „gate wake łapie powrót sieci".

**Scenariusze testowe:**
- [Unit] `shouldDeferAfterWake` zwraca `true` tuż po luce większej od progu, `false` po upływie
  karencji i `false` przy normalnej pracy bez luki.
- [Unit] Run zakolejkowany w oknie karencji startuje **po** jej upływie, nie jest gubiony ani
  oznaczany jako `failed`.
- [Unit] Zwykły ruch kolejki (bez wybudzenia) nie jest opóźniany o ani jeden tick.

**Weryfikacja:**
- `node --test lib/scheduler.test.js` przechodzi.
- `npm test` przechodzi w całości.

## Wpływ systemowy

- **Graf interakcji:** `scheduler.processQueue` ↔ `executor.executeRun` to jedyny szew, w którym
  zmienia się kontrakt (jeden run → N runów). Konsumenci stanu: `server.js` (`/api/status`,
  kill), `public/app.js` (kill-bar), skill `/puls` (klient REST). `lib/ask.js` **nie** przechodzi
  przez kolejkę i pozostaje nietknięty.
- **Propagacja błędów:** pad jednego runu nie może przerwać pętli drain ani zabić pozostałych
  aktywnych runów — awaria jednego zadania to dziś wynik zapisany w DB, i tak ma zostać.
- **Ryzyka cyklu życia stanu:** wpis w `activeRuns` to nowy zasób do zwolnienia; wyciek nie
  zablokuje już całej kolejki (jak w awarii z 2026-07-14), tylko **cicho zmniejszy limit** —
  objaw trudniejszy do zauważenia, dlatego domknięcie na `'exit'` i idempotentność są w Unit 2
  wymogiem, nie ozdobą.
- **Parytet surface API:** `current_run` (stary) i `current_runs` (nowy) muszą przez jakiś czas
  współistnieć — skill `/puls` i dashboard aktualizują się osobno.
- **Pokrycie integracyjne:** testy czystych funkcji pickera przejdą także wtedy, gdy pętla drain
  nie budzi się na nową pracę. Scenariusz „krótki dokolejkowany w trakcie długiego" jest
  **jedynym** dowodem systemowym (`docs/solutions/2026-07-03`: „napisz test integracyjny A+B").

## Ryzyka i zależności

- **Wspólne okno limitu planu Claude.** Równoległość nie zwiększa przepustowości — przyspiesza
  zużycie limitu. Mitygacja: start od 3, obserwacja tygodnia, dopiero potem podnoszenie.
- **Fail-open dla kolizji plikowych (świadomie przyjęte).** Nowe zadanie piszące w te same pliki
  co inne nie jest chronione, dopóki ktoś nie zadeklaruje grupy. Mitygacja: dwie reguły
  automatyczne (ten sam skill / ten sam skrypt), rozstrzelenie znanych kolizji, opis w skillu
  `/puls`.
- **Obsidian Sync a równoległe zapisy w vaultcie.** Dwa agenty piszące różne pliki są bezpieczne;
  dwa piszące ten sam plik dają cichy lost update, którego Sync nie rozstrzygnie semantycznie
  (ta sama klasa problemu, co udokumentowany zakaz syncu Skrzynki na dwóch maszynach).
- **Windows: dwa równoczesne drzewa procesów.** `taskkill /T /F` działa per PID, więc kill per run
  jest poprawny — ale nietestowane pod obciążeniem; maszyna CAVE stoi na starym kodzie.
- **Regresja kompatybilności skilla `/puls`.** 409 przy `current/kill` to nowy kod dla starego
  klienta — skill musi wyjść razem z deployem (Unit 6).
- **`lib/platform.js` bez testów.** Zakres 3 zaczyna od characterization testu, inaczej
  przepisanie generatora plista jest zmianą na ślepo.

## Metryki sukcesu

- **Podstawowa (R1/R8):** średni i maksymalny czas oczekiwania runu „Team OS — inbox sync"
  w kolejce (`queued_at → started_at`) w poniedziałkowym oknie 8:00-10:00 spada z rzędu
  minut do sekund. Przed zmianą wartość jest **niemierzalna** — dlatego `queued_at` ląduje
  w Unit 1, przed resztą.
- **Kontrolna:** liczba runów `failed`/`timeout` w tygodniu po wdrożeniu nie rośnie (proxy na
  limit planu i na kolizje plikowe).
- **Regresyjna:** 640 istniejących testów przechodzi bez modyfikacji na każdym kroku.

## Rozważane alternatywy

- **Dwa pasy po `job_type` (propozycja z dokumentu źródłowego).** Odrzucone: dane z żywej bazy
  pokazują, że `job_type` klasyfikuje odwrotnie w obie strony (Classroom sync = script/747 s,
  Aktualizacja .env = claude/18 s), więc sztandarowy scenariusz „poniedziałek 9:00" nie zostałby
  naprawiony. Dodatkowo teza „auto-reply jest jedynym jobem script na maszynie agenta" jest
  nieprawdziwa — VPS ma cztery joby script.
- **Limit 1 dla jobów claude z uzasadnieniem zasobowym.** Odrzucone: `/ask` od tygodni utrzymuje
  do czterech równoległych procesów `claude` w produkcji. Realnym ogranicznikiem jest okno
  limitu planu i kolizje plikowe, nie CPU/RAM — i tak to nazywamy.
- **Fail-closed (długie zadania rozłączne, dopóki user nie zaznaczy „może równolegle").**
  Bezpieczniejsze wobec kolizji, ale wymaga jednorazowego przejścia przez wszystkie joby i każde
  nowe zadanie startuje jako nierównoległe — czyli obietnica z R2 działa dopiero po decyzji
  usera. Odrzucone świadomie 30.07; wracamy do tematu, jeśli wystąpi pierwsza realna kolizja.
- **Wykrywanie kolizji plikowych z pomiaru (`fs.watch`, profile zapisu).** Odrzucone w dokumencie
  źródłowym i podtrzymane — Obsidian Sync zaśmieca profil, więc detektor produkowałby fałszywe
  alarmy.
- **Wiele współbieżnych pętli `processQueue` (rezygnacja z guardu `queueProcessing`).**
  Kuszące, bo `executeRun` ustawia status `running` synchronicznie, więc podwójny start tego
  samego runu jest mało prawdopodobny. Odrzucone: mnoży retry-check i czyni rozumowanie o
  kolejce zależnym od szczegółu implementacyjnego executora.

## Fazowe dostarczanie

### Faza 1 — Równoległość (Unit 1-6)
Rdzeń sprintu. Unit 1 i 2 mogą lecieć równolegle; Unit 3 zależy od obu; Unit 4-5 od 3; Unit 6
domyka seed i dokumentację.

### Faza 2 — Instalator (Unit 7)
Niezależna. Priorytet zaraz po Fazie 1 — bramka dla onboardingu zespołu.

### Faza 3 — Autostart Maca (Unit 8)
Niezależna. Dziś objaw jest kosmetyczny (launchd realnie działa pod inną etykietą), ale
`generatePlist()` wyprodukowałby plist, który nie wstaje — czyli świeża instalacja na cudzym
Macu jest zepsuta.

### Faza 4 — Opóźnienie po wybudzeniu (Unit 9)
Ostatnia. Dotyka tej samej pętli co Faza 1, więc wchodzi po jej ustabilizowaniu; obejście
(przesunięte godziny) działa w międzyczasie.

## Dokumentacja / Notatki operacyjne

- `CLAUDE.md` — sekcja o `scheduler.js` opisuje dziś „kolejka jest serializowana, jeden run
  naraz". Po Fazie 1 to zdanie jest nieprawdziwe i musi opisywać limit + slot rezerwowy +
  klasyfikację z pomiaru (Unit 6).
- `docs/CONCEPTS.md` — kandydaci na hasła: **„zadanie krótkie / długie"** (klasyfikacja
  z mediany ostatnich udanych runów, nie z `job_type`) i **„slot rezerwowy"**. Oba mają
  znaczenie projektowo-specyficzne i wprost przeczą intuicji z `job_type`.
- Skill `/puls` — jedyny klient REST poza dashboardem; wymaga aktualizacji razem z deployem.
- Rollout: najpierw Mac (widać efekt w poniedziałek), potem VPS. `max_concurrent` zaczyna od
  wartości zachowawczej; podnosić po tygodniu obserwacji.

## Źródła i referencje

- **Dokument źródłowy:** [docs/plans/2026-07-30-rownolegle-joby.md](./2026-07-30-rownolegle-joby.md)
  — ustalenia sesji koncepcyjnej + odrzucone alternatywy („Locki przy piórze", „Budżet i ślady").
- Sesja roastu 30.07 — weryfikacja planu wobec kodu i danych produkcyjnych (obalenie podziału po
  `job_type`, brak dzwonka w pętli drain, rebrand już w `main`).
- Kod: `lib/scheduler.js`, `lib/executor.js`, `lib/db.js`, `lib/platform.js`, `server.js`,
  `public/app.js`, `install.sh`, `setup.mjs`.
- Wiedza instytucjonalna: `docs/solutions/runtime-errors/2026-07-03-stale-obiekt-w-pamieci-vs-stan-db-martwe-retry.md`,
  `docs/solutions/runtime-errors/2026-07-14-close-nie-odpala-wnuk-dziedziczy-pipe-wyciek-slotu.md`,
  `docs/solutions/runtime-errors/2026-07-28-async-seed-vs-sync-scheduler-job-bez-harmonogramu.md`,
  `docs/solutions/runtime-errors/2026-06-29-migracja-better-sqlite3-na-node-sqlite.md`,
  `docs/solutions/deployment-issues/2026-07-28-windows-re-run-instalatora-zablokowane-pliki-i-cache-raw.md`,
  `docs/solutions/deployment-issues/2026-06-30-curl-bash-instalator-interaktywny-tty.md`,
  `docs/solutions/deployment-issues/2026-07-03-guardy-instalatora-falszywe-sygnaly-statusow-cli.md`.
