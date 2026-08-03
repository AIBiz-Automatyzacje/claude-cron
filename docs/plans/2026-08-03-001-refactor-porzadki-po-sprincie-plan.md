---
title: "refactor: porządki po sprincie równoległych jobów (payload statusu, guard instalatora, martwy kod)"
type: refactor
status: active
date: 2026-08-03
origin: null
design_md: null
figma_spec: null
figma_screens: {}
---

# refactor: porządki po sprincie równoległych jobów

> **Wersja po przeglądzie planu (03.08).** Pierwotna lista miała pięć pozycji. Pomiar na żywej
> bazie i policzenie bloków `lib/scheduler.js` wykluczyły dwie — powody w sekcji „Co wypadło z
> planu i dlaczego". Zostają trzy unity, łączny koszt poniżej godziny.
>
> **Wykonanie:** bez ścieżki `/dev-docs` — jeden subagent implementujący całość, drugi robiący
> review diffa, praca na gałęzi. Uzasadnienie w „Kluczowe decyzje techniczne".

## Przegląd

Trzy punktowe porządki po sprincie równoległych jobów: projekcja kolumn dla biegnących runów,
testowalny guard katalogu instalacji w `install.ps1`, usunięcie martwej gałęzi obsługi błędu w
executorze. Żaden nie zmienia zachowania systemu — wszystkie zmniejszają ilość rzeczy, które w
tym repo są nieprawdziwe albo niesprawdzalne.

To jest **sprzątanie, nie naprawa**. Żadna z pozycji nie ma dziś mierzalnego wpływu na działanie
Pulsa (patrz „Pomiar") i tak należy ją traktować przy ustalaniu priorytetów.

## Ujęcie problemu

Sprint równoległości zamknął się działającą kolejką i zostawił listę drobnych długów. Trzy z nich
łączy jedna cecha: **kod albo dokumentacja twierdzi coś, co nie jest prawdą** — `/api/status`
deklaruje kolumny, których nie potrzebuje; test guardu instalatora twierdzi, że weryfikuje
odmowę, a w praktyce czeka na Enter; komentarz w executorze opisuje obsługę błędu, którego Node
nie rzuca.

### Pomiar (żywa baza, 03.08)

Zanim cokolwiek naprawiamy — liczby z `data/claude-cron.db` (15 jobów, 9 włączonych, 1415 runów):

| Twierdzenie ze zgłoszenia | Stan faktyczny |
|---|---|
| `/api/status` wozi rosnący stdout biegnących runów | **Obalone.** `executor` zapisuje `stdout`/`stderr` do bazy dopiero przy finalizacji (`lib/executor.js:389` dla `claude`, `:467` dla `script`); przy starcie leci sam `status` + `started_at` (`:227`). Wiersz `running` ma te kolumny puste — stream-json rośnie w pamięci procesu |
| Realnym balastem jest `webhook_payload` | **Potwierdzone co do mechanizmu, znikome co do skali.** 1 job ma webhook, 36 runów webhookowych na 1415 (2,5%), największy payload w historii bazy **2038 B**, średni 524 B. `parseBody` (`server.js:45`) nie ma capa rozmiaru, więc 2 KB to stan dzisiejszy, nie gwarancja |
| N+1 w pętli drain to problem | **Obalone dla dzisiejszej skali.** 9 włączonych jobów = ≤9 zapytań o dwie kolumny na przebieg pickera. Jednostki mikrosekund |
| `scheduler.js` łamie limit 300 linii, wydzielenie wake to naprawi | **Obalone arytmetyką.** Wake + heartbeat = 132 linie; po wycięciu zostaje ~553, nie ~510. Nawet wake + picker + retention naraz (301 linii) zostawia ~383 — limit jest w tym pliku nieosiągalny |

Wniosek: naprawiamy to, co jest tanie i sprawdzalne, i nie udajemy, że kupujemy wydajność.

## Co wypadło z planu i dlaczego

Zapisane, żeby nie wracało jako „przecież to trzeba było zrobić".

- **Wydzielenie `lib/scheduler-wake.js` — odrzucone.** Próg 300 linii z `.claude/rules/coding-rules.md`
  jest w `lib/scheduler.js` **nieosiągalny**: po wycięciu wake (132), pickera z klasyfikacją (141)
  i retention (28) zostaje ~383 linie czystej orkiestracji, której nie da się rozciąć bez rozerwania
  pętli drain. Refaktor nie dowiózłby reguły, którą miał dowieźć. Dodatkowo pierwotna rekomendacja
  (ciąć wake) była gorszym z dwóch wariantów: wake to 132 linie **stanu mutowalnego** i dwa timery,
  a picker to 141 linii **czystych funkcji** — gdyby kiedyś ciąć, to picker, bo przenosiny czystych
  funkcji nie mogą zepsuć stanu. Wracamy do tematu dopiero, gdy plik realnie zaboli przy zmianie.
- **Wsadowe zapytanie o próbki czasów (N+1) — odrzucone.** Jedyny unit, w którym błąd byłby
  **cichy**: nowe zapytanie oddające o jedną próbkę mniej przesuwa `classifyJob` z krótkiego na
  długi, a jedynym objawem jest run czekający dłużej. Zysk niemierzalny przy 9 jobach, ryzyko w
  najwrażliwszej logice sprintu. Reguła §12 („MIERZ przed deklaracją") rozstrzyga: dziś wystarcza.
  Zostaje **jednolinijkowy ślad w kodzie** z progiem powrotu (Unit 3).
- **CI dla suit instalatorów — świadomie nie powstanie (decyzja usera, 03.08).** Repo nie ma
  `.github/workflows`, a `npm test` to `node --test`, więc `install.test.sh` i `install.ps1.Tests.ps1`
  nie są odpalane przez nic automatycznie i nie będą. Konsekwencja: wartość obu suit zależy od tego,
  czy ktoś pamięta je odpalić po zmianie w instalatorze. Unit 2 nie jest więc „odblokowaniem
  automatyzacji" — jest **pokryciem destrukcyjnej ścieżki na platformie, gdzie ta ścieżka już raz
  się wyłożyła** (regresja 28.07).
- **Cap rozmiaru na `parseBody`** (`server.js:45`) — realna dziura (nieograniczone body webhooka
  ląduje w bazie i w prompcie joba), ale osobna decyzja: 413 vs obcięcie vs odrzucenie zmienia
  kontrakt integracji z n8n. Kandydat na własny plan.
- **Unit 10 ze sprintu równoległości** (launchd vs hook Claude Code jako autostart na Macu,
  `docs/completed/rownolegle-joby/rownolegle-joby-podsumowanie.md`) — nadal otwarty, świadomie poza
  tym planem: to decyzja produktowa, nie sprzątanie.

## Śledzenie wymagań

- **R1.** `/api/status` (odpytywany cyklicznie, także przez proxy Mac→VPS) nie wozi
  `webhook_payload` ani kolumn logów biegnących runów.
- **R2.** Zmiana R1 nie psuje dashboardu ani skilla `/puls`; dokumentacja kontraktu jest zgodna
  z kodem.
- **R3.** Suita `install.ps1.Tests.ps1` kończy się bez interakcji człowieka niezależnie od tego,
  skąd została odpalona, a guard „obcy katalog" ma pokryte trzy warianty (brak odpowiedzi /
  odmowa / zgoda) — parytet z `install.test.sh` (testy 14/15/16).
- **R4.** Kod nie deklaruje obsługi sytuacji, która w Node nie występuje (`ESRCH` z
  `ChildProcess.kill()`), i nie zostawia po sobie pustego `catch {}`.
- **R5.** Zachowanie zewnętrzne systemu po wszystkich trzech zmianach jest identyczne — pełny
  `npm test` zielony (baseline: 809 pass / 0 fail).

## Granice scope'u

- Bez capa na body webhooka, bez CI, bez refaktoru `scheduler.js`, bez wsadowego zapytania o
  próbki czasów (powody wyżej).
- Bez zmian schematu bazy i bez zmian w `/api/runs` oraz `/api/runs/:id` (lekka historia z 01.08
  zostaje nietknięta).
- Bez zmian w warstwie prezentacji — zweryfikowane: dashboard czyta z biegnących runów wyłącznie
  `id`, `job_id`, `started_at` (`public/render-helpers.js:233`).

## Kontekst i research

### Relevantny kod i wzorce

- `lib/db.js:231` — `RUN_META_COLUMNS`: gotowa projekcja „wszystko poza logami" + rozmiary w bajtach.
  Reużycie wymaga aliasu tabeli (`FROM runs r`), bo stała prefiksuje kolumny `r.`.
- `lib/db.js:314` — `countRecentFailedRuns`: precedens „SELECT samych potrzebnych kolumn, bo pełne
  wiersze niosą logi".
- `install.ps1:79` (`Read-InstallDir` — I/O) vs `install.ps1:127` (`Resolve-InstallDir -Answer` —
  czysta decyzja): podział do powtórzenia w `Confirm-InstallDirReplaceable`.
- `install.test.sh:258,290,316` — trzy warianty guardu po stronie bash, sterowane `INSTALL_TTY`.
  Parytet **zachowań**, nie kopia implementacji.
- `lib/executor.js:72-100` — `killProcessTree` + `signalQuietly`; `lib/ask.js:169-176` — bliźniaczy
  `killProcessTree` z pustym `catch {}` (ta sama fałszywa przesłanka).

### Wiedza instytucjonalna

- `docs/CONCEPTS.md` — słownik domenowy. Istotne hasła: **Run** (status `killed` obejmuje runy
  osierocone przez restart), **Zadanie krótkie / długie** (klasyfikacja z pomiaru — nie ruszamy jej
  w tym planie), **Karencja po wybudzeniu** (opisana jako zachowanie pętli kolejki, co jest kolejnym
  argumentem za trzymaniem wake w schedulerze).
- `docs/solutions/deployment-issues/2026-07-28-windows-re-run-instalatora-zablokowane-pliki-i-cache-raw.md`
  — suita na macOS nie powie **nic** o Windowsie; guard z Unitu 2 stoi dokładnie przed sekwencją,
  która tam padła.
- `docs/solutions/deployment-issues/2026-06-30-curl-bash-instalator-interaktywny-tty.md` — wejście
  interaktywne testujemy podstawiając odpowiedź, nigdy licząc na to, że „w teście nie ma terminala".
- `docs/solutions/runtime-errors/2026-07-14-close-nie-odpala-wnuk-dziedziczy-pipe-wyciek-slotu.md`
  — cykl życia procesu domykany na `'exit'`; Unit 3 nie może ruszyć tej ścieżki.
- `docs/completed/team-os-onboarding-instalatory/team-os-onboarding-instalatory-zadania.md:6` —
  precedens dla pola `Delegate to:` w tym repo (tabela z `/dev-plan` zakłada stack React/Supabase;
  wszystkie IU idą do `feature-builder-data`, materialnie stosuje się tylko `security`).

### Referencje zewnętrzne

- Kontrakt `ChildProcess.kill()` **zweryfikowany empirycznie na Node z tego repo**: kill po
  zakończeniu procesu zwraca `false`, `killed` zostaje `false`, **żadnego wyjątku**; nieznany sygnał
  rzuca `ERR_UNKNOWN_SIGNAL`; `EPERM` Node emituje jako zdarzenie `'error'` na obiekcie dziecka, nie
  wyjątkiem z `kill()`.

## Kluczowe decyzje techniczne

- **Projekcja w `getRunningRuns()`, nie osobny getter dla statusu**: jedno źródło dla `/api/status`,
  `/api/runs/current` i listy w 409 z `/api/runs/current/kill`. Koszt kontraktowy jest **bliski
  zera** — dla runu `running` pole `stdout` jest zawsze puste, więc usuwamy pole, które nigdy nic nie
  niosło, plus `webhook_payload` o zmierzonym maksimum 2 KB.
- **Reużycie `RUN_META_COLUMNS` bez modyfikacji**: `stdout_bytes`/`stderr_bytes` dla biegnącego runu
  wyjdą jako `0` — to prawda o **bazie** (log jeszcze nie został zapisany), nie o świecie. Jeden
  kształt wiersza dla listy i dla biegnących jest wart tej niedokładności; gdyby UI kiedyś pokazywało
  wagę logu przy biegnącym runie, musi to uwzględnić.
- **Seam w PowerShellu przez parametr `-Answer`, nie zmienną środowiskową à la `INSTALL_TTY`**:
  `install.ps1` ma już ten podział (`Read-InstallDir` czyta, `Resolve-InstallDir -Answer` decyduje).
  Trzecia konwencja wejścia w jednym pliku to koszt utrzymania bez zysku.
- **Usunięcie `signalQuietly` zamiast poprawienia komentarza**: warunek `err.code !== 'ESRCH'` jest
  nieosiągalny, a `try/catch` wokół `proc.kill()` z literałem sygnału łapie wyłącznie
  `ERR_UNKNOWN_SIGNAL`, czyli błąd programisty. Zostaje gołe wywołanie + komentarz opisujący
  **faktyczny** kontrakt Node.
- **Wykonanie bez ścieżki `/dev-docs`** (decyzja usera, 03.08): trzy rozłączne mikro-unity poniżej
  godziny łącznie. Review-workflow zwraca się tam, gdzie zmiana może być **cicho** zła — a po
  wycięciu unitu N+1 żadna z pozostałych taka nie jest (błąd w każdej widać natychmiast: dashboard,
  przebieg suity, kill-bar). Zamiast tego: jeden subagent implementujący, jeden recenzent diffa.

## Otwarte pytania

### Rozwiązane podczas planowania i przeglądu

- Czy `/api/status` wozi rosnący stdout? **Nie** — pomiar wyżej.
- Czy projekcja psuje dashboard? **Nie** — kill-bar używa `id`/`job_id`/`started_at`.
- Czy `ESRCH` bywa rzucany przez `ChildProcess.kill()`? **Nie** — weryfikacja empiryczna. Dwa
  istniejące testy (`lib/executor.test.js:510`, `:525`) stoją na atrapie rzucającej `ESRCH`, czyli
  na zachowaniu, którego Node nie ma.
- Czy robić CI? **Nie** — decyzja usera, zapisana wyżej wraz z konsekwencją.
- Czy ciąć `scheduler.js`? **Nie** — arytmetyka wyżej.
- Czy zamieniać N+1 na zapytanie wsadowe? **Nie** — zostaje ślad z progiem.

### Odroczone do implementacji

- Czy komunikaty guardu w `install.ps1` wymagają rozróżnienia „brak odpowiedzi" vs „odmowa" na
  poziomie treści (bash rozróżnia) — do rozstrzygnięcia przy pisaniu, kontrakt zachowań jest ustalony.
- Czy `install.ps1.Tests.ps1` po zmianie przechodzi w całości na realnym Windowsie — sprawdzalne
  wyłącznie na maszynie z Windowsem (`Operator checklist` Unitu 2).

## Implementation Units

- [ ] **Unit 1: Lekki payload biegnących runów**

**Cel:** `getRunningRuns()` przestaje zwracać `webhook_payload` i kolumny logów; cyklicznie
odpytywany `/api/status` wozi wyłącznie metadane.

**Wymagania:** R1, R2, R5

**Zależności:** brak

**Pliki:**
- Modyfikuj: `lib/db.js` (`getRunningRuns` — projekcja `RUN_META_COLUMNS`, `FROM runs r`)
- Modyfikuj: `skills/puls/SKILL.md` (kontrakt `/api/runs/current` i `current_runs`)
- Test (unit): `lib/db.test.js`

**Delegate to:** feature-builder-data *(konwencja repo — patrz precedens w „Wiedza instytucjonalna";
w tym przebiegu wykonuje ad-hoc subagent implementujący)*

**Skills in play:** security *(z frontmatera agenta materialnie stosuje się tylko ten;
`supabase-dev-guidelines` i `sentry-integration` nie mają w tym repo zastosowania)*

**Podejście:**
- Reużyj stałej `RUN_META_COLUMNS` (`lib/db.js:231`); zapytanie musi mieć alias `FROM runs r`.
- Zachowaj `ORDER BY r.id ASC` — kolejność jest kontraktem (`current_run` = pierwszy element).
- Komentarz nad funkcją ma mówić prawdę: uzasadnieniem jest `webhook_payload` (nieograniczony, bo
  `parseBody` nie ma capa), a nie stdout, który dla biegnącego runu jest pusty.
- Sprawdź trzy call-site'y (`server.js:335`, `:468`, `:481`) — żaden nie czyta usuwanych pól.

**Wzorce do naśladowania:**
- `lib/db.js:240` (`getRuns` z `fields=meta`), `lib/db.js:263` (`getRecentRunsPerJob`).

**Scenariusze testowe:**
- [Unit] Biegnący run: wynik **nie ma** kluczy `stdout`, `stderr`, `webhook_payload`, a ma `id`,
  `job_id`, `status`, `trigger_type`, `queued_at`, `started_at`.
- [Unit] Run z niepustym `webhook_payload` przechodzący w `running`: payload nie wycieka do wyniku.
- [Unit] Dwa biegnące runy → kolejność `id ASC` zachowana.
- [Unit] Zero biegnących → `[]` (istniejący `lib/db.test.js:757` zielony).

**Weryfikacja:**
- `node --test lib/db.test.js` przechodzi (nowe testy + `lib/db.test.js:740` i `:757`).
- `npm test` przechodzi w całości (809+ pass / 0 fail).
- `grep -n "getRunningRuns" -A 2 lib/db.js` nie pokazuje `SELECT *`.

---

- [ ] **Unit 2: Guard katalogu instalacji testowalny bez człowieka**

**Cel:** Guard „obcy katalog nie zostaje skasowany" ma na Windowsie pokryte trzy warianty
odpowiedzi, a suita kończy się bez interakcji niezależnie od tego, skąd ją odpalono.

**Wymagania:** R3

**Zależności:** brak

**Pliki:**
- Modyfikuj: `install.ps1` (`Confirm-InstallDirReplaceable` — rozdzielenie odczytu od decyzji)
- Test (unit): `install.ps1.Tests.ps1` (Test 9 → trzy przypadki)

**Delegate to:** feature-builder-data

**Skills in play:** security

**Podejście:**
- Dodaj opcjonalny parametr `-Answer`. Bez niego funkcja czyta wejście jak dziś (`Read-Host` w
  `try/catch`) — produkcyjna ścieżka bez zmian.
- Decyzja pozostaje fail-closed: brak odpowiedzi = odmowa z komunikatem o `INSTALL_DIR`; „n"
  i cokolwiek innego = odmowa „przerwane na życzenie"; „t"/„tak"/„y"/„yes" = zgoda.
- Plik jest w czystym ASCII (wymóg `irm|iex`) — nowe komunikaty bez diakrytyków.
- Test 9 rozbity na trzy wywołania z jawną odpowiedzią; asercja „dane usera przeżyły" w każdym,
  a w wariancie „t" dodatkowo: guard **nie** rzuca.

**Notatka wykonawcza:** zacznij od testu — najpierw trzy przypadki wołające guard z `-Answer`
(RED, bo parametru jeszcze nie ma), potem seam w `install.ps1`.

**Wzorce do naśladowania:**
- `install.ps1:79` / `:127` (podział I/O vs decyzja w tym samym pliku).
- `install.test.sh:258` / `:290` / `:316` (trzy warianty guardu po stronie bash).

**Scenariusze testowe:**
- [Unit] Brak odpowiedzi → guard rzuca, `moje-dane.txt` nietknięty, `setup.mjs` nie pojawia się
  w katalogu.
- [Unit] Odpowiedź „n" → guard rzuca („przerwane na życzenie"), dane nietknięte.
- [Unit] Odpowiedź „t" → guard **nie** rzuca.
- [Unit] Katalog pusty / wyglądający na instalację Pulsa → guard przechodzi bez pytania (regresja
  `Get-InstallTargetKind`).

**Weryfikacja:**
- `grep -c "Confirm-InstallDirReplaceable" install.ps1.Tests.ps1` zwraca ≥ 3.
- `grep -n "Read-Host" install.ps1` pokazuje wystąpienia wyłącznie w `Read-InstallDir` i w gałęzi
  bez `-Answer` w `Confirm-InstallDirReplaceable`.
- Plik pozostaje ASCII: `LC_ALL=C grep -n '[^\x00-\x7F]' install.ps1` nie zwraca nic.
- `npm test` przechodzi (testy Node nie regresują).

**Operator checklist:**
- [ ] Odpalić `powershell -NoProfile -File install.ps1.Tests.ps1` na maszynie Windows („CAVE")
      z interaktywnego terminala i potwierdzić, że suita kończy się sama z wynikiem „N PASS / N total".

---

- [ ] **Unit 3: Kod przestaje kłamać — martwa gałąź ESRCH i ślad o progu N+1**

**Cel:** Ścieżka wysyłki sygnału opisuje faktyczny kontrakt Node zamiast obsługiwać wyjątek,
którego Node nie rzuca; znika puste `catch {}` w bliźniaczej ścieżce `ask.js`; pętla drain dostaje
jednolinijkowy ślad o progu, przy którym warto wrócić do zapytania wsadowego.

**Wymagania:** R4, R5

**Zależności:** brak

**Pliki:**
- Modyfikuj: `lib/executor.js` (`signalQuietly` → gołe `proc.kill(...)` w `killProcessTree`)
- Modyfikuj: `lib/ask.js` (`killProcessTree` — te same dwa wywołania, bez pustych `catch {}`)
- Modyfikuj: `lib/scheduler.js` (komentarz przy pętli zbierającej próbki czasów, ~linia 366)
- Test (unit): `lib/executor.test.js` (zastąpienie dwóch testów stojących na fałszywej atrapie)

**Delegate to:** feature-builder-data

**Skills in play:** security

**Podejście:**
- Komentarz ma zapisać zweryfikowany kontrakt: `kill()` na martwym procesie zwraca `false` **bez
  wyjątku**; `EPERM` przychodzi zdarzeniem `'error'` (executor ma handlery — `lib/executor.js:403`,
  `:506`; `ask.js` — `:361`); wyjątek leci wyłącznie przy nieznanym sygnale, a przekazujemy literały.
- Eskalacja SIGTERM → SIGKILL i kasowanie uzbrojonego SIGKILL na `'exit'` (`lib/executor.js:86`)
  zostają **bez zmian** — to zabezpieczenie przed trafieniem w recyklowany PID, nie obsługa błędu.
- Dwa istniejące testy (`lib/executor.test.js:510`, `:525`) testują **usuwaną** funkcjonalność
  (atrapa rzucająca `ESRCH`) — zastępujemy je testami realnego kontraktu.
- Ślad w `lib/scheduler.js`: jedno zdanie przy pętli — próbki zbierane per job są świadomie N
  zapytaniami, przy skali >30 jobów zamienić na window function wzorem `db.getRecentRunsPerJob`.
  **Bez** zmiany kodu.

**Wzorce do naśladowania:**
- `lib/executor.js:78-86` — komentarz wyjaśniający NIE-oczywiste zachowanie API Node (`proc.killed`
  = „sygnał wysłany", nie „proces umarł"); ten sam styl.

**Scenariusze testowe:**
- [Unit] `killProcessTree` na atrapie, której `kill()` zwraca `false` (proces już martwy) → brak
  wyjątku, brak wpisu w logu, uzbrojony SIGKILL kasowany po `'exit'`.
- [Unit] Żywy proces: `SIGTERM`, a po progu eskalacji `SIGKILL` (istniejące pokrycie zielone).
- [Unit] Regresja `killRun`: run oznaczony `killed` w DB przed ubiciem procesu kończy jako `killed`
  i nie wysyła ❌ (`lib/executor.test.js:219` bez zmian).

**Weryfikacja:**
- `grep -rn "ESRCH" lib/` nie zwraca nic.
- `grep -n "catch {}" lib/ask.js` nie pokazuje pustego catcha w `killProcessTree`.
- `grep -n "getRecentRunsPerJob" lib/scheduler.js` zwraca komentarz ze śladem progu.
- `node --test lib/executor.test.js lib/ask.test.js` przechodzi.
- `npm test` przechodzi w całości.

## Wpływ systemowy

- **Graf interakcji:** Unit 1 dotyka trzech call-site'ów w `server.js` (`/api/status`,
  `/api/runs/current`, 409 z `/api/runs/current/kill`) i kontraktu skilla `/puls`. Unit 3 dotyka
  wyłącznie wysyłki sygnału — nie zwalniania slotu ani finalizacji runu.
- **Propagacja błędów:** Unit 3 świadomie przestaje łapać wyjątek z `kill()`; jedyny osiągalny
  wyjątek (nieznany sygnał) to błąd programisty i ma się propagować. `EPERM` wchodzi ścieżką
  zdarzenia `'error'`, która już finalizuje run jako `failed`.
- **Parytet surface API:** `current_run` musi zostać pierwszym elementem `current_runs` (Unit 1 nie
  zmienia `ORDER BY`); `install.ps1` nie dostaje żadnego nowego pytania (Unit 2 tylko rozdziela
  odczyt od decyzji).
- **Pokrycie:** po Unit 2 warstwa testów instalatorów pozostaje **ręczna** (świadoma decyzja o braku
  CI) — jej wartość zależy od dyscypliny odpalania po zmianach w `install.sh`/`install.ps1`.

## Ryzyka i zależności

- **Kontrakt skilla `/puls`:** po Unit 1 `GET /api/runs/current` nie zwraca `stdout`. Aktualizacja
  `skills/puls/SKILL.md` musi wejść tym samym commitem, inaczej agent czyta pole, którego nie ma.
  Sam skutek dla konsumentów jest znikomy — pole i tak było zawsze puste dla biegnących runów.
- **`parseBody` bez capa** (`server.js:45`) zostaje nietknięty: Unit 1 usuwa payload z odpowiedzi
  API, ale nie z bazy ani z promptu joba (`lib/executor.js:217`).
- **Unit 2 weryfikowalny w pełni tylko na Windowsie** — automat sprawdza kształt (grep + ASCII),
  realny przebieg jest w `Operator checklist`.
- **Brak CI to trwała decyzja** — każda przyszła zmiana w instalatorach wymaga ręcznego odpalenia
  obu suit; jeśli ta dyscyplina padnie, warstwa testów instalatorów staje się ozdobna i trzeba to
  nazwać wprost, zamiast utrzymywać pozory pokrycia.

## Dokumentacja / Notatki operacyjne

- `skills/puls/SKILL.md`: sprostowanie kontraktu `/api/runs/current` i `current_runs` (Unit 1).
- Bez migracji i bez zmian konfiguracji — po zmergowaniu wystarczy restart daemona (lokalnie i na
  VPS). `webhook_payload` nie znika z bazy, tylko z odpowiedzi API.
- `CLAUDE.md` bez zmian — architektura `lib/` się nie zmienia (żaden nowy moduł nie powstaje).

## Źródła i referencje

- Dokument źródłowy: brak; zgłoszenie usera + przegląd planu (roast) z 03.08 — korekty przesłanek
  w sekcjach „Pomiar" i „Co wypadło z planu i dlaczego".
- Powiązany kod: `lib/db.js:231,355`, `lib/executor.js:72-100,389,467`, `lib/ask.js:169-176`,
  `lib/scheduler.js:366`, `install.ps1:155-181`, `install.ps1.Tests.ps1:197`,
  `install.test.sh:258-332`, `public/render-helpers.js:211-233`, `server.js:45,335,468,481`
- Wiedza instytucjonalna: `docs/CONCEPTS.md`,
  `docs/solutions/deployment-issues/2026-07-28-windows-re-run-instalatora-zablokowane-pliki-i-cache-raw.md`,
  `docs/solutions/deployment-issues/2026-06-30-curl-bash-instalator-interaktywny-tty.md`,
  `docs/solutions/runtime-errors/2026-07-14-close-nie-odpala-wnuk-dziedziczy-pipe-wyciek-slotu.md`
- Poprzedni sprint: `docs/completed/rownolegle-joby/rownolegle-joby-podsumowanie.md`
