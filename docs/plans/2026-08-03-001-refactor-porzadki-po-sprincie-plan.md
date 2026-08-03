---
title: "refactor: porządki po sprincie równoległych jobów (payload statusu, testowalność guardu, szew wake)"
type: refactor
status: active
date: 2026-08-03
origin: null
design_md: null
figma_spec: null
figma_screens: {}
---

# refactor: porządki po sprincie równoległych jobów

## Przegląd

Pięć niezależnych porządków po sprincie równoległych jobów. Jeden dotyka payloadu cyklicznie
odpytywanego endpointu (`/api/status`), jeden odblokowuje automatyzację testów Windows, trzy
to higiena kodu: martwa gałąź obsługi błędu, N+1 w gorącej ścieżce pickera i wydzielenie szwu
`scheduler-wake.js`.

Pozycje są rozłączne — każda ma własny commit i własną weryfikację, kolejność wynika z ryzyka
(najpierw punktowe, refaktor pliku na końcu).

## Ujęcie problemu

Sprint równoległości zamknął się działającą kolejką, ale zostawił pięć długów, z czego trzy
zostały wykryte dopiero po wdrożeniu (ręczna obserwacja żywego runu i przebieg testów na
maszynie Windows „CAVE"). Żaden nie blokuje działania systemu dziś; każdy podnosi koszt
następnej zmiany albo kłamie o zachowaniu runtime'u.

### Korekta przesłanki pozycji 1 (ustalone w czasie planowania)

Zgłoszenie mówiło, że `/api/status` wozi **rosnący stdout** biegnących runów (dziesiątki KB
przy trzech równoległych jobach). Kod tego nie potwierdza:

- `executor.executeRun` przy starcie runu zapisuje wyłącznie `status` + `started_at`
  (`lib/executor.js:227`), a `stdout`/`stderr` trafiają do bazy **dopiero w finalizacji**
  (`lib/executor.js:389` dla ścieżki `claude`, `:467` dla `script`). Stream-json rośnie w
  pamięci procesu, nie w kolumnie.
- Wiersz ze statusem `running` ma więc `stdout`/`stderr` puste (`NULL`). Klucze widoczne w
  odpowiedzi to nazwy kolumn z `SELECT *`, nie ich zawartość.

Realny balast w tym payloadzie to **`webhook_payload`** — i on jest nieograniczony:
`parseBody` (`server.js:45`) nie ma capa rozmiaru, więc job odpalany z n8n/Make może wnieść
do wiersza runu dowolnie duże ciało żądania, które potem wraca w każdym pollu statusu i idzie
przez proxy Mac→VPS.

Wniosek: naprawa zostaje (projekcja kolumn = parytet z lekką historią, `webhook_payload` znika
z cyklicznie odpytywanego endpointu, kontrakt zamknięty testem), ale jej waga to higiena i
ochrona przed dużym payloadem webhooka, nie „dziesiątki KB co 3 sekundy" w każdej instalacji.
Brak capa na body webhooka jest osobnym długiem — patrz „Granice scope'u".

## Śledzenie wymagań

- **R1.** `/api/status` (odpytywany cyklicznie przez dashboard, także przez proxy Mac→VPS) nie
  wozi `webhook_payload` ani kolumn logów biegnących runów.
- **R2.** Zmiana R1 nie psuje dashboardu (kill-bar) ani skilla `/puls` — pola faktycznie
  używane przez konsumentów zostają.
- **R3.** Testy `install.ps1` przechodzą bez człowieka przy klawiaturze, niezależnie od tego,
  czy sesja ma konsolę; guard „obcy katalog" jest pokryty w trzech wariantach (brak
  odpowiedzi / odmowa / zgoda) w parytecie z `install.test.sh` (testy 14/15/16).
- **R4.** Pętla drain robi **jedno** zapytanie o próbki czasów zamiast jednego na job.
- **R5.** Kod nie deklaruje obsługi sytuacji, która w Node nie występuje (`ESRCH` z
  `ChildProcess.kill()`), i nie zostawia pustego `catch {}`.
- **R6.** Obsługa wybudzenia i heartbeatu żyje w osobnym module; `lib/scheduler.js` schodzi
  poniżej ~520 linii, a picker i pętla drain zostają nietknięte semantycznie.
- **R7.** Zachowanie zewnętrzne systemu (co startuje, co czeka, co dostaje karencję, kiedy
  leci ❌) po wszystkich pięciu zmianach jest identyczne — cały `npm test` zielony.

## Granice scope'u

- **Nie** dodajemy capa rozmiaru na body webhooka (`parseBody`) — realna dziura, ale osobna
  decyzja (odrzucenie vs obcięcie vs 413 zmienia kontrakt integracji n8n). Zgłoszona niżej
  w „Ryzyka i zależności" jako kandydat na osobny plan.
- **Nie** ruszamy `pickEligibleRuns`, `classifyJob` ani reguł wyłączności — wydzielamy tylko
  szew wake (decyzja usera z planowania).
- **Nie** zmieniamy schematu bazy ani formatu odpowiedzi `/api/runs` i `/api/runs/:id`
  (lekka historia została wdrożona 01.08 i zostaje bez zmian).
- **Nie** dotykamy warstwy prezentacji — zweryfikowane: dashboard czyta z biegnących runów
  wyłącznie `id`, `job_id`, `started_at` (`public/render-helpers.js:233`).
- **Nie** wpinamy testów Windows w CI — Unit 2 zdejmuje blokadę, sam pipeline to osobna praca.

## Kontekst i research

### Relevantny kod i wzorce

- `lib/db.js:231` — `RUN_META_COLUMNS`: gotowa projekcja „wszystko poza logami" + rozmiary w
  bajtach (`LENGTH(CAST(... AS BLOB))`). Wzorzec do reużycia w Unit 1, ale zapytanie musi
  aliasować tabelę (`FROM runs r`), bo stała używa prefiksu `r.`.
- `lib/db.js:263` — `getRecentRunsPerJob`: wzorzec window function `ROW_NUMBER() OVER
  (PARTITION BY job_id ORDER BY id DESC)` z jawną listą kolumn. Bezpośredni wzorzec dla
  Unit 3.
- `lib/db.js:314` — `countRecentFailedRuns`: precedens „SELECT samych potrzebnych kolumn,
  bo pełne wiersze niosą do ~100 KB logów".
- `install.ps1:79` (`Read-InstallDir`) + `install.ps1:127` (`Resolve-InstallDir -Answer`) —
  istniejący w TYM SAMYM pliku podział I/O (Read-Host) vs czysta decyzja z argumentem.
  Wzorzec do zastosowania w `Confirm-InstallDirReplaceable` (Unit 2).
- `install.test.sh:258-332` — testy 14/15/16 guardu po stronie bash, sterowane
  `INSTALL_TTY` (plik podstawiany za `/dev/tty`). Parytet zachowań do odtworzenia w PS.
- `lib/scheduler.js:151-238` + `:545-588` — spójny blok karencji/heartbeatu/detekcji pobudki
  do wydzielenia (Unit 5).
- `lib/executor.js:72-100` — `killProcessTree` + `signalQuietly`; `lib/ask.js:169-176` —
  bliźniaczy `killProcessTree` z pustym `catch {}` (ta sama fałszywa przesłanka).

### Wiedza instytucjonalna

- `docs/solutions/performance-issues/2026-06-23-per-job-recent-runs-window-function.md` —
  „Top N per grupa = window function, nie flat LIMIT". Dokładnie kształt Unit 3: N ostatnich
  **udanych** runów **per job** w jednym zapytaniu; globalny `LIMIT` zjadłby okno na jobie o
  wysokiej kadencji (inbox sync co minutę) i zagłodził próbki pozostałych.
- `docs/solutions/runtime-errors/2026-06-29-migracja-better-sqlite3-na-node-sqlite.md` —
  agregaty `node:sqlite` bywają BigInt. Dlatego Unit 3 zostaje przy **surowych znacznikach
  czasu + odejmowaniu w JS** (jak dziś), a nie liczy median/różnic w SQL.
- `docs/solutions/runtime-errors/2026-07-14-close-nie-odpala-wnuk-dziedziczy-pipe-wyciek-slotu.md`
  — cykl życia procesu domykany na `'exit'`; Unit 4 nie może ruszyć tej ścieżki (dotyka
  wyłącznie wysyłki sygnału, nie zwalniania slotu).
- `docs/solutions/runtime-errors/2026-07-30-prog-detekcji-snu-rowny-okresowi-heartbeatu.md` —
  `WAKE_GAP_MS = HEARTBEAT_INTERVAL_MS + SLEEP_GAP_MS`; przenosząc próg do nowego modułu
  (Unit 5) nie wolno go „uprościć" do gołego `SLEEP_GAP_MS`, bo próg równy okresowi tykania
  bierze każde normalne tyknięcie za wybudzenie.
- `docs/solutions/deployment-issues/2026-06-30-curl-bash-instalator-interaktywny-tty.md` —
  wejście interaktywne instalatora testujemy przez podstawiony strumień/odpowiedź, nigdy
  licząc na to, że „w teście nie ma terminala".

### Referencje zewnętrzne

- Zachowanie `ChildProcess.kill()` **zweryfikowane empirycznie na Node z tego repo** (Unit 4),
  nie z pamięci: kill po zakończeniu procesu → zwraca `false`, `killed` zostaje `false`,
  **żadnego wyjątku**; nieznany sygnał → rzuca `ERR_UNKNOWN_SIGNAL`. Błąd typu `EPERM` Node
  emituje jako zdarzenie `'error'` na obiekcie dziecka, a nie wyjątkiem z `kill()`.

## Kluczowe decyzje techniczne

- **Projekcja w `getRunningRuns()`, nie osobny getter dla statusu** (wybór usera): jedno
  źródło dla `/api/status`, `/api/runs/current` i listy w 409 z `/api/runs/current/kill`.
  Dwa gettery zwracające „prawie to samo" rozjechałyby się przy pierwszej zmianie.
- **Reużycie `RUN_META_COLUMNS` bez modyfikacji**: kolumny `stdout_bytes`/`stderr_bytes` dla
  biegnącego runu wyjdą jako `0` (logi trafiają do bazy dopiero w finalizacji) — to prawda o
  stanie, nie brak, a jeden kształt wiersza dla listy i dla biegnących upraszcza konsumentów.
- **Kontrakt skilla `/puls` aktualizowany razem z kodem**: `skills/puls/SKILL.md` mówi dziś, że
  `/api/runs/current` zwraca run; po zmianie musi powiedzieć, że **bez** `stdout`/`stderr`/
  `webhook_payload`, a pełny wiersz daje `GET /api/runs/:id`.
- **Seam w PowerShellu przez parametr `-Answer`, nie przez zmienną środowiskową à la
  `INSTALL_TTY`**: plik `install.ps1` ma już ten podział (`Read-InstallDir` czyta,
  `Resolve-InstallDir -Answer` decyduje). Trzecia konwencja wejścia w tym samym pliku byłaby
  kosztem utrzymania, a zachowania (brak odpowiedzi / „n" / „t") są w pełni pokrywalne
  argumentem.
- **`getRecentSuccessDurations` zastąpione wersją wsadową, bez zostawiania wariantu
  jednojobowego**: jedyny konsument to picker (`lib/scheduler.js:368`); wariant dla jednego
  joba byłby abstrakcją bez drugiego użycia (reguła „abstrakcja dopiero przy 2+ użyciach").
  Istniejące testy jednojobowe **przenosimy na nowe API** (ta sama weryfikowana własność:
  tylko udane runy z kompletem znaczników, limit per job, brak mieszania jobów) — to zmiana
  API testowanej funkcji, nie osłabienie asercji.
- **Usunięcie `signalQuietly` zamiast poprawienia komentarza**: warunek `err.code !== 'ESRCH'`
  jest nieosiągalny, a `try/catch` wokół `proc.kill('SIGTERM'|'SIGKILL')` z literałem sygnału
  łapie wyłącznie `ERR_UNKNOWN_SIGNAL`, czyli błąd programisty. Zostaje gołe wywołanie +
  komentarz opisujący **faktyczny** kontrakt Node (`false` = już nie żyje, `EPERM` przychodzi
  zdarzeniem `'error'`, które executor już obsługuje — `lib/executor.js:403`).
- **Szew wake tnie po stanie, nie po „temacie"**: do `scheduler-wake.js` idzie wszystko, co
  dotyka `wakeDetectedAt`/`lastHeartbeatAt`/`heartbeatInterval`. `computeMissedJobs` i
  `detectMissedJobs` **zostają** w schedulerze — `detectMissedJobs` woła `enqueueJob`, więc
  przeniesienie zrobiłoby cykl `scheduler ↔ scheduler-wake` (zakaz z reguł architektury).
- **Bez fasady re-eksportów w `scheduler.js`**: jedynymi konsumentami eksportów wake są testy
  (zweryfikowane grepem — `server.js` i pozostałe moduły ich nie importują), więc testy
  importują nowy moduł wprost. Fasada byłaby martwym API utrzymywanym w nieskończoność.

## Otwarte pytania

### Rozwiązane podczas planowania

- Czy `/api/status` faktycznie wozi rosnący stdout? **Nie** — logi lądują w bazie dopiero przy
  finalizacji runu; balastem jest `webhook_payload`. Naprawa zostaje, uzasadnienie zmienione.
- Czy projekcja psuje dashboard? **Nie** — kill-bar używa `id`/`job_id`/`started_at`
  (`public/render-helpers.js:233`, `runningRunsFrom` na `current_runs` z fallbackiem na
  `current_run`). Zero zmian we froncie.
- Zakres pozycji 1: projekcja w `getRunningRuns()` (wszystkie trzy call-site'y) — decyzja usera.
- Głębokość refaktoru schedulera: tylko szew wake, picker nietknięty — decyzja usera.
- Czy `ESRCH` bywa rzucany przez `ChildProcess.kill()`? **Nie** (weryfikacja empiryczna na
  Node z tego repo). Istniejące testy `lib/executor.test.js:510` i `:525` stoją na atrapie,
  która rzuca `ESRCH` — czyli na zachowaniu, którego Node nie ma.
- Czy zmiana dotyka UI? **Nie** — plan jest w całości backendowy/instalatorowy, stąd
  `design_md: null` i puste `figma_*` we frontmatterze.

### Odroczone do implementacji

- Dokładny kształt zapytania wsadowego w Unit 3 (lista placeholderów `IN (...)` vs
  `json_each`) — rozstrzygnie się przy pisaniu; kontrakt (mapa `jobId → number[]`) jest ustalony.
- Ile dokładnie linii zostanie w `scheduler.js` po Unit 5 (szacunek ~510) — sprawdzalne dopiero
  po przeniesieniu; próg akceptacji to „istotnie poniżej dzisiejszych 684", nie konkretna liczba.
- Czy testy karencji sterujące przez `scheduler.start()` (`lib/scheduler.test.js:852-965`)
  zostaną w pliku schedulera, czy przejdą do nowego — reguła podziału jest w Unit 5, przypisanie
  konkretnych testów wyjdzie przy przenoszeniu.
- Czy `pwsh`/Windows będzie dostępny w momencie wykonania (na maszynie planowania go nie ma) —
  dlatego weryfikacja Unit 2 jest statyczna, a realny przebieg siedzi w `Operator checklist`.

## Implementation Units

- [ ] **Unit 1: Lekki payload biegnących runów (poz. 1)**

**Cel:** `getRunningRuns()` przestaje zwracać `webhook_payload` i kolumny logów; cyklicznie
odpytywany `/api/status` wozi tylko metadane.

**Wymagania:** R1, R2, R7

**Zależności:** brak

**Pliki:**
- Modyfikuj: `lib/db.js` (`getRunningRuns` — projekcja `RUN_META_COLUMNS`, `FROM runs r`)
- Modyfikuj: `skills/puls/SKILL.md` (kontrakt `/api/runs/current` i `current_runs`)
- Test (unit): `lib/db.test.js`

**Delegate to:** feature-builder-data

**Skills in play:** supabase-dev-guidelines, security, sentry-integration *(mirror frontmatera
agenta; w tym repo operatywne są `.claude/rules/coding-rules.md` i `.claude/rules/learned-patterns.md`
— stack to czysty Node + `node:sqlite`, bez Supabase)*

**Podejście:**
- Reużyj stałej `RUN_META_COLUMNS` (`lib/db.js:231`) — zapytanie musi mieć alias `FROM runs r`,
  bo stała prefiksuje kolumny.
- Zachowaj `ORDER BY r.id ASC` (kolejność jest kontraktem: `current_run` = pierwszy element).
- Zaktualizuj komentarz nad funkcją: uzasadnieniem jest `webhook_payload` (nieograniczony —
  `parseBody` bez capa), a nie stdout, który dla biegnącego runu jest pusty.
- Sprawdź trzy call-site'y (`server.js:335`, `:468`, `:481`) — żaden nie czyta usuwanych pól.

**Wzorce do naśladowania:**
- `lib/db.js:240` (`getRuns` z `fields=meta`), `lib/db.js:263` (`getRecentRunsPerJob` — jawna
  lista kolumn zamiast `SELECT *`).

**Scenariusze testowe:**
- [Unit] Biegnący run: `getRunningRuns()[0]` **nie ma** kluczy `stdout`, `stderr`,
  `webhook_payload`, a ma `id`, `job_id`, `status`, `trigger_type`, `queued_at`, `started_at`.
- [Unit] Run zakolejkowany z dużym `webhook_payload`, po przejściu w `running`: payload nie
  wycieka do wyniku (asercja na braku klucza, nie na wartości).
- [Unit] Dwa biegnące runy → kolejność `id ASC` zachowana (kontrakt `current_run = [0]`).
- [Unit] Zero biegnących → `[]` (istniejący test `lib/db.test.js:757` musi dalej przechodzić).

**Weryfikacja:**
- `node --test lib/db.test.js` przechodzi (nowe testy + `lib/db.test.js:740` i `:757` zielone).
- `npm test` przechodzi w całości (regresja `server.js`/skill).
- `grep -n "SELECT \*" lib/db.js` nie pokazuje już `getRunningRuns`.

---

- [ ] **Unit 2: Guard katalogu instalacji testowalny bez człowieka (poz. 2)**

**Cel:** Test 9 w `install.ps1.Tests.ps1` przestaje zależeć od tego, czy sesja ma konsolę;
guard dostaje pokrycie w trzech wariantach odpowiedzi, w parytecie z bash.

**Wymagania:** R3

**Zależności:** brak

**Pliki:**
- Modyfikuj: `install.ps1` (`Confirm-InstallDirReplaceable` — rozdzielenie odczytu od decyzji)
- Test (unit): `install.ps1.Tests.ps1` (Test 9 → trzy przypadki)

**Delegate to:** feature-builder-data

**Skills in play:** supabase-dev-guidelines, security, sentry-integration *(mirror frontmatera;
tu operatywne są reguły repo + `docs/solutions/deployment-issues/`)*

**Podejście:**
- Dodaj do `Confirm-InstallDirReplaceable` opcjonalny parametr `-Answer` (odpowiedź podana
  z zewnątrz). Gdy nie podano — funkcja czyta wejście jak dziś (`Read-Host` w `try/catch`),
  czyli produkcyjna ścieżka bez zmian.
- Decyzja zostaje fail-closed: brak odpowiedzi (`$null`/pusty) = odmowa z komunikatem o
  `INSTALL_DIR`; „n"/cokolwiek innego = odmowa „przerwane na życzenie"; „t"/„tak"/„y"/„yes"
  = zgoda. Rozróżnienie komunikatów jest częścią kontraktu (bash rozróżnia je tak samo).
- Plik jest w czystym ASCII (`irm|iex`) — nowe komunikaty bez diakrytyków, zgodnie z resztą pliku.
- Test 9 rozbij na trzy wywołania z jawną odpowiedzią; asercja „dane usera przeżyły" zostaje
  w każdym z nich, a w wariancie „t" dodatkowo: guard **nie** rzuca.

**Notatka wykonawcza:** zacznij od testu — najpierw trzy przypadki wołające guard z `-Answer`
(RED, bo parametru jeszcze nie ma), potem seam w `install.ps1`. To jedyny sposób, żeby
zweryfikować, że test faktycznie przestał czekać na klawiaturę.

**Wzorce do naśladowania:**
- `install.ps1:79` (`Read-InstallDir` — I/O) vs `install.ps1:127` (`Resolve-InstallDir -Answer`
  — czysta decyzja); ten sam podział w tym samym pliku.
- `install.test.sh:258` (test 14 — brak terminala = odmowa), `:290` (test 15 — „n" = odmowa),
  `:316` (test 16 — „t" = instalacja). Parytet zachowań, nie kopia implementacji.

**Scenariusze testowe:**
- [Unit] Guard z pustą/brakującą odpowiedzią → rzuca, plik `moje-dane.txt` nietknięty,
  `setup.mjs` nie pojawia się w katalogu.
- [Unit] Guard z odpowiedzią „n" → rzuca („przerwane na życzenie"), dane nietknięte.
- [Unit] Guard z odpowiedzią „t" → **nie** rzuca (świadoma zgoda przechodzi).
- [Unit] Katalog pusty / wyglądający na instalację Pulsa → guard przechodzi bez pytania
  (istniejące zachowanie `Get-InstallTargetKind`, regresja).
- [Manual] Pełny przebieg `powershell -NoProfile -File install.ps1.Tests.ps1` na Windows
  z terminala — kończy się sam, bez czekania na Enter.

**Weryfikacja:**
- `grep -c "Confirm-InstallDirReplaceable" install.ps1.Tests.ps1` zwraca ≥ 3 (trzy warianty).
- `grep -n "Read-Host" install.ps1` pokazuje wystąpienia wyłącznie w `Read-InstallDir` i w
  gałęzi bez `-Answer` w `Confirm-InstallDirReplaceable` (żadne inne wejście interaktywne
  nie stoi na ścieżce testów).
- `npm test` przechodzi (nie regresuje testów Node — plik PS nie jest ich częścią).

**Operator checklist:**
- [ ] Odpalić `powershell -NoProfile -File install.ps1.Tests.ps1` na maszynie Windows („CAVE")
      z interaktywnego terminala i potwierdzić, że suita kończy się bez interakcji, z wynikiem
      „N PASS / N total".

---

- [ ] **Unit 3: Jedno zapytanie o próbki czasów zamiast N (poz. 4)**

**Cel:** Pętla drain przestaje odpytywać bazę raz na job; próbki czasów zbiera jedno zapytanie
window function.

**Wymagania:** R4, R7

**Zależności:** brak (niezależny od Unit 5; oba dotykają `lib/scheduler.js`, więc rób go PRZED
przenosinami, żeby nie mieszać zmiany zachowania z przenoszeniem kodu)

**Pliki:**
- Modyfikuj: `lib/db.js` (`getRecentSuccessDurations` → wariant wsadowy dla listy jobów)
- Modyfikuj: `lib/scheduler.js` (`startEligibleRuns` — jedno wywołanie zamiast pętli)
- Test (unit): `lib/db.test.js`, `lib/scheduler.test.js` (regresja pickera na żywej pętli)

**Delegate to:** feature-builder-data

**Skills in play:** supabase-dev-guidelines, security, sentry-integration *(mirror frontmatera)*

**Podejście:**
- Nowe API: lista `jobId` → mapa `jobId → number[]` (czasy w ms, najnowsze pierwsze), gotowa do
  podstawienia pod `durationsByJob`. Pusta lista wejściowa → pusta mapa, **bez** dotykania bazy.
- Job bez udanych runów MUSI mieć w mapie pustą tablicę, a nie brakujący klucz — `classifyJob`
  na `undefined` zwróciłoby „long" przypadkiem, a nie przez fail-safe.
- N ostatnich per job przez `ROW_NUMBER() OVER (PARTITION BY job_id ORDER BY id DESC)` z filtrem
  `status='success'` i kompletem znaczników **w podzapytaniu** — inaczej okno liczyłoby także
  runy odfiltrowane później i job z serią failów oddawałby mniej próbek, niż prosiliśmy.
- Odejmowanie znaczników dalej w JS (`Date.parse`), zero agregatów SQL — pułapka BigInt.
- Usuń wariant jednojobowy i przenieś jego trzy testy na nowe API (zachowaj weryfikowane
  własności 1:1).

**Wzorce do naśladowania:**
- `lib/db.js:263` (`getRecentRunsPerJob`) — ten sam kształt window function, w tym normalizacja
  limitu i jawna lista kolumn.

**Scenariusze testowe:**
- [Unit] Dwa joby z historią → mapa ma po jednym kluczu na job, próbki się nie mieszają
  (przeniesiony `lib/db.test.js:784`).
- [Unit] Job z serią failów i kilkoma sukcesami → w próbkach wyłącznie udane runy z kompletem
  znaczników (przeniesiony `lib/db.test.js:767`).
- [Unit] `limit=2` przy 5 udanych runach → dokładnie 2 najnowsze **per job**, także gdy drugi
  job ma 20 runów (regresja „flat LIMIT zjada okno").
- [Unit] Job bez udanych runów → klucz obecny, wartość `[]` (error case, fail-safe pickera).
- [Unit] Pusta lista jobów → `{}`.
- [Unit] Wartości są typu `number` (nie BigInt) i nieujemne.
- [Unit] Regresja szwu historia→klasyfikacja→picker na żywej pętli: `lib/scheduler.test.js:1014`
  przechodzi bez zmian w treści.

**Weryfikacja:**
- `node --test lib/db.test.js lib/scheduler.test.js` przechodzi.
- `grep -n "getRecentSuccessDurations" lib/scheduler.js` pokazuje **jedno** wywołanie, poza pętlą
  `for`.
- `npm test` przechodzi w całości.

---

- [ ] **Unit 4: Usunięcie martwej gałęzi ESRCH (poz. 5)**

**Cel:** Kod wysyłający sygnał do procesu opisuje faktyczny kontrakt Node zamiast obsługiwać
wyjątek, którego Node nie rzuca; znika też puste `catch {}` w bliźniaczej ścieżce `ask.js`.

**Wymagania:** R5, R7

**Zależności:** brak

**Pliki:**
- Modyfikuj: `lib/executor.js` (`signalQuietly` → gołe `proc.kill(...)` w `killProcessTree`)
- Modyfikuj: `lib/ask.js` (`killProcessTree` — te same dwa wywołania, bez pustych `catch {}`)
- Test (unit): `lib/executor.test.js` (zastąpienie dwóch testów stojących na fałszywej atrapie)

**Delegate to:** feature-builder-data

**Skills in play:** supabase-dev-guidelines, security, sentry-integration *(mirror frontmatera)*

**Podejście:**
- Zweryfikowany kontrakt Node do wpisania w komentarz: `kill()` na martwym procesie zwraca
  `false` **bez wyjątku**; `EPERM` przychodzi zdarzeniem `'error'` na obiekcie dziecka (executor
  ma na nie handler — `lib/executor.js:403`, `:506`; `ask.js` — `:361`); wyjątek leci wyłącznie
  przy nieznanym sygnale (`ERR_UNKNOWN_SIGNAL`), a my przekazujemy literały.
- Eskalacja SIGTERM → SIGKILL i kasowanie uzbrojonego SIGKILL na `'exit'` (`lib/executor.js:86`)
  zostają **bez zmian** — to zabezpieczenie przed trafieniem w recyklowany PID, nie obsługa błędu.
- Dwa istniejące testy (`lib/executor.test.js:510`, `:525`) testują usuwaną funkcjonalność
  (atrapa rzucająca `ESRCH`) — zastępujemy je testami realnego kontraktu, nie osłabiamy asercji.

**Wzorce do naśladowania:**
- `lib/executor.js:78-86` — komentarz wyjaśniający NIE-oczywiste zachowanie API Node
  (`proc.killed` = „sygnał wysłany", nie „proces umarł"); ten sam styl dla nowego komentarza.

**Scenariusze testowe:**
- [Unit] `killProcessTree` na atrapie, której `kill()` zwraca `false` (proces już martwy) →
  brak wyjątku, brak wpisu w logu, uzbrojony SIGKILL kasowany po `'exit'`.
- [Unit] Żywy proces: `killProcessTree` wysyła `SIGTERM`, a po progu eskalacji `SIGKILL`
  (istniejące pokrycie eskalacji zostaje zielone).
- [Unit] Regresja `killRun`: run oznaczony `killed` w DB przed ubiciem procesu kończy jako
  `killed` i nie wysyła ❌ (`lib/executor.test.js:219` bez zmian).

**Weryfikacja:**
- `grep -rn "ESRCH" lib/` nie zwraca nic.
- `grep -n "catch {}" lib/ask.js` nie pokazuje już pustego catcha w `killProcessTree`
  (dopuszczalne pozostają inne, świadome miejsca — zweryfikuj, że ruszony jest tylko ten).
- `node --test lib/executor.test.js lib/ask.test.js` przechodzi.
- `npm test` przechodzi w całości.

---

- [ ] **Unit 5: Wydzielenie `lib/scheduler-wake.js` (poz. 3)**

**Cel:** Karencja po wybudzeniu, detekcja pobudki i heartbeat wyprowadzone do własnego modułu;
`lib/scheduler.js` zostaje z cronem, pickerem i pętlą drain.

**Wymagania:** R6, R7

**Zależności:** Unit 3 (żeby zmiana zachowania w `startEligibleRuns` nie mieszała się z
przenoszeniem kodu)

**Pliki:**
- Stwórz: `lib/scheduler-wake.js`
- Stwórz: `lib/scheduler-wake.test.js`
- Modyfikuj: `lib/scheduler.js` (import + usunięcie przeniesionych funkcji i eksportów)
- Modyfikuj: `lib/scheduler.test.js` (testy przeniesionych funkcji wychodzą do nowego pliku)
- Modyfikuj: `CLAUDE.md` (opis architektury `lib/` — nowy moduł i granica odpowiedzialności)

**Delegate to:** feature-builder-data

**Skills in play:** supabase-dev-guidelines, security, sentry-integration *(mirror frontmatera)*

**Podejście:**
- Granica cięcia = **stan**: do nowego modułu idzie wszystko, co dotyka `wakeDetectedAt`,
  `lastHeartbeatAt`, `heartbeatInterval` — czyli `WAKE_GRACE_MS`, `WAKE_GAP_MS`, `isWakeGap`,
  `wakeGraceRemainingMs`, `shouldDeferAfterWake`, `markWakeDetected`, `getWakeDetectedAt`,
  `noteWakeIfGap`, `delayPromise` (timer karencji), `startHeartbeat`, `stopHeartbeat`,
  `detectWakeFromDowntime`.
- **Zostają** w schedulerze: `computeMissedJobs` i `detectMissedJobs` — `detectMissedJobs` woła
  `enqueueJob`, więc przeniesienie utworzyłoby cykl `scheduler ↔ scheduler-wake`. Nowy moduł
  zależy wyłącznie od `db`, `config` i `executor.SLEEP_GAP_MS`; **nigdy** od `scheduler`.
- Pętla drain czyta chwilę wybudzenia przez `getWakeDetectedAt()` (dziś sięga po zmienną
  modułową `wakeDetectedAt` bezpośrednio — po przenosinach to musi być funkcja).
- Kolejność wywołań w `start()` jest kontraktem: `detectWakeFromDowntime()` **przed**
  `detectMissedJobs()` i **przed** `startHeartbeat()` — heartbeat nadpisuje `last_active_at`.
  Ta kolejność ma zostać dosłownie taka sama.
- Progi i komentarze przenosimy **bez upraszczania** — zwłaszcza `WAKE_GAP_MS =
  HEARTBEAT_INTERVAL_MS + SLEEP_GAP_MS` wraz z uzasadnieniem (regresja z 30.07).
- Eksporty wake znikają z `module.exports` schedulera (jedynymi konsumentami były testy).
- Podział testów: testy **przeniesionych funkcji** (czyste: `shouldDeferAfterWake`,
  `wakeGraceRemainingMs`, `isWakeGap`) idą do `lib/scheduler-wake.test.js`; testy sterujące
  przez `scheduler.start()` / pętlę drain zostają w `lib/scheduler.test.js` jako testy szwu,
  importując nowy moduł tam, gdzie asercja dotyczy stanu wybudzenia.

**Notatka wykonawcza:** to przenosiny bez zmiany zachowania — żaden test nie może zmienić
treści asercji, tylko miejsce i import. Jeśli test wymaga przepisania asercji, to znaczy, że
cięcie zmieniło zachowanie; wróć do granicy modułu zamiast poprawiać test.

**Wzorce do naśladowania:**
- `lib/claude-spawn.js` — moduł wydzielony jako „to, co MUSI być identyczne po obu stronach",
  z jawnie opisaną granicą odpowiedzialności w nagłówku pliku.
- `lib/notify-config.js` — mały moduł czytany w czasie użycia, bez zależności zwrotnej.

**Scenariusze testowe:**
- [Unit] Wszystkie dzisiejsze testy karencji przechodzą po przeniesieniu, z niezmienionymi
  asercjami (`lib/scheduler.test.js:766`, `:778`, `:791` → nowy plik).
- [Unit] `start()`: downtime dłuższy od progu włącza karencję zanim heartbeat nadpisze ślad
  (`:852`); zwykły restart serwisu jej NIE włącza (`:875`, `:916`).
- [Unit] Heartbeat: luka między tyknięciami włącza karencję (`:892`); tyknięcie spóźnione o
  kilka ms nie jest wybudzeniem (`:935` — jawny jitter, nie równa luka).
- [Unit] Pętla kolejki sama wykrywa wybudzenie, gdy cron wyprzedzi tyknięcie (`:967`).
- [Unit] Bez wybudzenia pętla nie zwalnia o ani jeden tick — run rusza synchronicznie (`:835`).
- [Unit] Brak cyklu importów: `lib/scheduler-wake.js` nie wymaga `./scheduler`.

**Weryfikacja:**
- `node --test lib/scheduler.test.js lib/scheduler-wake.test.js` przechodzi.
- `grep -n "require('./scheduler')" lib/scheduler-wake.js` nie zwraca nic (zero cyklu).
- `wc -l lib/scheduler.js` pokazuje istotnie mniej niż 684 (cel ~510).
- `npm test` przechodzi w całości.

## Wpływ systemowy

- **Graf interakcji:** Unit 1 dotyka trzech call-site'ów w `server.js` (`/api/status`,
  `/api/runs/current`, 409 z `/api/runs/current/kill`) oraz kontraktu skilla `/puls`. Unit 5
  zmienia miejsce, z którego `start()`/`stop()`/pętla drain biorą karencję — bez zmiany kolejności.
- **Propagacja błędów:** Unit 4 świadomie przestaje łapać wyjątek z `kill()`; jedyny osiągalny
  wyjątek (nieznany sygnał) to błąd programisty i ma się propagować, a nie ginąć w logu. `EPERM`
  wchodzi ścieżką zdarzenia `'error'`, która już finalizuje run jako `failed`.
- **Ryzyka cyklu życia stanu:** stan wybudzenia (`wakeDetectedAt`, `lastHeartbeatAt`) żyje w
  pamięci procesu i po Unit 5 ma **jednego** właściciela — nie wolno zostawić kopii ani cache'u
  po stronie schedulera, bo dwa źródła prawdy o pobudce = karencja zamrożona albo pominięta.
- **Parytet surface API:** `current_run` musi zostać pierwszym elementem `current_runs` (Unit 1
  nie może zmienić `ORDER BY`); `install.ps1` nie dostaje ścieżki członka Team OS ani innych
  nowych pytań (Unit 2 wyłącznie rozdziela odczyt od decyzji).
- **Pokrycie integracyjne:** testy jednostkowe pickera i modułu wake przejdą nawet przy zepsutym
  szwie — dlatego regresją Unit 5 są testy sterujące przez `scheduler.start()` i żywą pętlę
  drain, a regresją Unit 3 — test szwu historia→klasyfikacja→picker (`lib/scheduler.test.js:1014`).

## Ryzyka i zależności

- **Kontrakt skilla `/puls`:** po Unit 1 `GET /api/runs/current` przestaje zwracać `stdout`.
  Skill musi kierować po log do `GET /api/runs/:id` — jeśli dokumentacja nie zostanie
  zaktualizowana w tym samym commicie, agent będzie czytał pole, którego nie ma.
- **`parseBody` bez capa (`server.js:45`)** — przyczyna dużego `webhook_payload`. Unit 1 usuwa
  go z payloadu statusu, ale nie z bazy ani z promptu joba (`lib/executor.js:217`). Kandydat na
  osobny plan; do rozważenia razem z limitem, jaki stosują już `/ask` i `/inbox` (64 KB).
- **Unit 5 tuż po sprincie:** przenosiny dotykają kodu, który dopiero co był źródłem błędu
  (próg detekcji snu). Mitygacja: zero zmian w progach i asercjach, weryfikacja przez testy
  sterujące żywą pętlą, refaktor jako ostatni commit serii.
- **Unit 2 weryfikowalny w pełni tylko na Windows** — na maszynie planowania nie ma `pwsh`.
  Automat sprawdza kształt (grep), realny przebieg jest w `Operator checklist`.
- **Kolejność Unit 3 → Unit 5:** oba dotykają `lib/scheduler.js`. Odwrócenie kolejności miesza
  zmianę zachowania z przenosinami i utrudnia bisect.

## Dokumentacja / Notatki operacyjne

- `CLAUDE.md`: opis `lib/` dostaje `scheduler-wake.js` (Unit 5) — granica: „karencja, detekcja
  pobudki, heartbeat; zero zależności zwrotnej do schedulera".
- `skills/puls/SKILL.md`: sprostowanie kontraktu `/api/runs/current` i `current_runs` (Unit 1).
- Deploy bez migracji i bez zmian konfiguracji — po zmergowaniu wystarczy restart daemona
  (lokalnie i na VPS). Nowy `webhook_payload` nie znika z bazy, tylko z odpowiedzi API.

## Źródła i referencje

- Dokument źródłowy: brak (zgłoszenie usera wprost, korekta przesłanki poz. 1 w sekcji „Ujęcie
  problemu")
- Powiązany kod: `lib/db.js:231,355,363`, `lib/scheduler.js:151-238,353-384,545-588`,
  `lib/executor.js:72-100,389,467`, `lib/ask.js:169-176`, `install.ps1:155-181`,
  `install.ps1.Tests.ps1:197`, `install.test.sh:258-332`, `public/render-helpers.js:211-233`
- Wiedza instytucjonalna: `docs/solutions/performance-issues/2026-06-23-per-job-recent-runs-window-function.md`,
  `docs/solutions/runtime-errors/2026-06-29-migracja-better-sqlite3-na-node-sqlite.md`,
  `docs/solutions/runtime-errors/2026-07-30-prog-detekcji-snu-rowny-okresowi-heartbeatu.md`,
  `docs/solutions/runtime-errors/2026-07-14-close-nie-odpala-wnuk-dziedziczy-pipe-wyciek-slotu.md`
- Poprzedni plan sprintu: `docs/plans/archive/2026-07-30-001-feat-rownolegle-joby-sprint-plan.md`,
  `docs/plans/archive/2026-08-01-001-feat-historia-lekki-payload-plan.md`
