---
title: "feat: Ułatwienie instalacji Pulsa (migracja node:sqlite + smart setup z portable Node)"
type: feat
status: active
date: 2026-06-29
origin: docs/plans/2026-06-25-ulatwienie-instalacji-ustalenia.md
design_md: null          # feature pure-infra: migracja DB + skrypty instalacyjne + runtime; brak warstwy UI
figma_spec: null
figma_screens: {}
---

# feat: Ułatwienie instalacji Pulsa

## Przegląd

Instalacja Pulsa wymaga dziś ~6-10 kroków terminalowych, ręcznej instalacji prereqs, a na Windows
**3-5 GB Visual Studio Build Tools** (bo `better-sqlite3` kompiluje się natywnie). Ten plan usuwa
największą barierę wejścia w dwóch krokach:

1. **#1 — Migracja DB (globalna, Mac/Win/VPS):** `better-sqlite3` → wbudowany `node:sqlite`
   (`DatabaseSync`). Po migracji projekt **nie ma ani jednego natywnie kompilowanego modułu**
   (`koffi` używa prebuildów) → koniec VS Build Tools na Windows i `node-gyp` przy zmianie wersji Node.
2. **#2 — Smart setup (lokalny, Mac/Win):** portable Node w folderze projektu (`.node/`), absolutna
   ścieżka Node wypalona w hooka autostartu, cienki bootstrap per-OS + wspólny `setup.mjs`.

Migracja jest objęta **guardami fail-fast** (wersja Node + smoke-test typów DB) i **zabezpieczeniem
VPS** (nocny auto-update nie może zrestartować serwisu na niekompatybilnym Node).

## Ujęcie problemu

(zob. źródło: `docs/plans/2026-06-25-ulatwienie-instalacji-ustalenia.md`)

- **Target:** istniejący użytkownik Claude Code, który nie czuje się pewnie w terminalu. NIE „osoba
  zupełnie nietechniczna" — login Claude (interaktywny OAuth) i subskrypcja to kroki, których żaden
  installer nie zautomatyzuje.
- **Bariera #1 (Windows):** `better-sqlite3` wymaga VS Build Tools — README:201 wprost ostrzega
  „bez tego `npm install` się wywali".
- **Bariera #2 (oba OS):** wymóg globalnej instalacji konkretnej wersji Node + ryzyko, że autostart
  w detached procesie woła zły/systemowy Node przez shimy `fnm`/`nvm`.

## Śledzenie wymagań

- **R1.** `lib/db.js` używa wbudowanego `node:sqlite` zamiast `better-sqlite3`; pełny suite testów PASS bez regresji. (źródło #1.3)
- **R2.** `better-sqlite3` usunięte z `dependencies`; `package.json` ma `engines` z poprawnym oknem Node. (źródło #1.3, #1.4)
- **R3.** Serwer fail-fast z czytelnym komunikatem, gdy Node jest poniżej minimum (zamiast kryptycznego `ERR_UNKNOWN_BUILTIN_MODULE`). (źródło #1.4, #1.5)
- **R4.** Smoke-test typów po `migrate()`: agregaty (`SUM`/`COUNT`) zwracają `number`, nie `BigInt` — inaczej fail-fast. (źródło #1.4)
- **R5.** `install-vps.sh` zapewnia Node ≥ minimum; nocny auto-update cron nie restartuje serwisu na niekompatybilnym Node. (źródło #1.5)
- **R6.** Portable Node w `.node/` — jeden mechanizm dla Mac i Windows; systemowy Node usera nietknięty. (źródło #2.7)
- **R7.** Hook autostartu woła Node po **absolutnej ścieżce** portable Node (w `spawn()` i w `settings.json`), nie gołe `node`. (źródło #2.8)
- **R8.** Cienki bootstrap per-OS (`install.sh`/`install.ps1`, tylko portable Node) + wspólny `setup.mjs` (pytania, hook, `settings.json`, smoke-test). (źródło #2.9)
- **R9.** Claude Code jako warunek wstępny z łagodnym handoffem — setup NIE instaluje Claude sam. (źródło #2.6)
- **R10.** Sprzątanie: usuń martwe `scripts/install-macos.sh` + `install-windows.ps1`, przepnij `package.json` `install:mac`/`install:win`, zaktualizuj uninstall pod nowy layout, README pod nowy flow. (źródło #2.9, ryzyka)

## Granice scope'u

- **Brak pakowania `.dmg`/`.exe`** — odrzucone w źródle (#kontekst): wymaga płatnych certyfikatów (Apple $99/rok, Windows ~$200-400/rok), inaczej Gatekeeper/SmartScreen straszy. Terminalowy one-liner omija to za darmo.
- **Nie automatyzujemy loginu/subskrypcji Claude** — interaktywne, poza zasięgiem installera (R9 to tylko handoff).
- **Nie zmieniamy logiki domenowej** (cron, webhook, polling, scheduler) — migracja DB jest pod-warstwowa, kontrakt `lib/db.js` bez zmian.
- **Nie zmieniamy harmonogramu auto-update VPS** — pozostaje `0 2 * * *` (zmienione w poprzednim zadaniu; zob. `install-vps.sh:438`).
- **Nie włączamy `readBigInts`** — domyślny `number` wystarcza; node:sqlite i tak rzuca `ERR_OUT_OF_RANGE` przy INTEGER > 2^53 (bezpieczniej niż b-s3).

## Kontekst i research

### Relevantny kod i wzorce

- `lib/db.js:1` — `require('better-sqlite3')`; `:22` `new Database(target)`; `:23-24` `db.pragma('journal_mode = WAL')` + `db.pragma('foreign_keys = ON')`. **To jedyne miejsca dotykające API silnika.** ~44 wywołań `prepare().get/all/run`, `.exec`, `lastInsertRowid`, `.changes`, `.close()` — wszystkie mają parytet w `node:sqlite` (zob. research zewnętrzny).
- `lib/db.js:9-18` — DI `setDbPath(':memory:')` + `dbPathOverride || DB_PATH`. Wzorzec testów `:memory:` zostaje.
- `lib/db.js:123-126` — guarded backfill flagą `state` (wzorzec idempotencji, `learned-patterns.md`).
- `lib/db.js:228-237` — `getTodayRunStats`: `COALESCE(SUM(...),0)` → dziś `number`. Cel smoke-testu R4.
- `lib/config.js:9-10` — `DATA_DIR`/`DB_PATH`. Kandydat na stałą `MIN_NODE_VERSION` (wzorzec bloku stałych jak `MAINTENANCE_WINDOW`).
- `package.json:7` `"start": "node server.js"`; brak pola `engines`; `better-sqlite3: ^12.0.0` w deps.
- `scripts/install-vps.sh:41-63` — instaluje Node 22 tylko gdy `< 18` (próg za niski); `:87` build-essential+python3 dla b-s3; `:266` `ExecStart=$NODE_PATH $INSTALL_DIR/server.js`; `:438` cron `0 2 * * *`.
- `setup.sh:162-270` / `setup-windows.ps1:190-315` — generują hook `{workspace}/.claude/hooks/claude-cron-autostart.js`, rejestrują w `{workspace}/.claude/settings.json` (`hooks.UserPromptSubmit`). Hook woła `spawn('node', ['server.js'], {detached})` (`setup.sh:202`, `setup-windows.ps1:225`).
- `scripts/install-macos.sh` (LaunchAgent), `scripts/install-windows.ps1` (Scheduled Task) — **martwe** (README ich nie używa, ale `package.json` `install:mac`/`install:win` wciąż na nie wskazują).
- `lib/db.test.js` — `:memory:` DI, ~23 testy; wzorzec do rozszerzenia.

### Wiedza instytucjonalna

- `.claude/rules/learned-patterns.md` — „Granica doby w SQLite licz w localtime" i „Backfill w migrate() guard flagą w state". Oba **niezmienne przy migracji silnika** (czysty SQL + logika JS), ale walidacja idempotencji migracji jest częścią testów R1.
- `docs/completed/migracja-puls-rebrand/review-faza-3.md:61` — ostrzeżenie: `SUM(...)` może teoretycznie zwrócić BigInt. Bezpośrednio motywuje smoke-test R4.

### Referencje zewnętrzne

- Node.js SQLite docs (v22.x / v24.x), nodejs/node#53905, #53906, #58611 — synteza w research:
  - **Bezflagowy `require('node:sqlite')` działa dopiero od 22.13.0** (22.5–22.12 wymaga `--experimental-sqlite`; niektóre buildy 22.5.0 zepsute na ARM Mac).
  - **`ExperimentalWarning` emitowane na `stderr`** przy pierwszym użyciu — wyciszenie: `--disable-warning=ExperimentalWarning`.
  - **Typy:** domyślnie INTEGER → `number`; `readBigInts: false` default; INTEGER > 2^53 → `ERR_OUT_OF_RANGE` (fail-fast, bezpieczniej niż b-s3).
  - **Parytet API** pełny dla naszego użycia; **brak `db.pragma()`** (→ `db.exec()`) i **brak `db.transaction()`** (nie używamy — zweryfikowane grepem).
  - **FK domyślnie ON** w node:sqlite (`enableForeignKeyConstraints: true`), ale jawne `PRAGMA foreign_keys = ON` przez `exec()` zostaje dla pewności.
  - **Portable Node:** `nodejs.org/dist/v<ver>/`, weryfikacja `SHASUMS256.txt`; binarka `bin/node` (unix) / `node.exe` (win, w korzeniu rozpakowanego zip).

## Kluczowe decyzje techniczne

- **Okno Node `>=22.13 <25`, NIE `>=22.5` ze źródła.** Research dowodzi, że `22.5` jest realnie zepsute (flaga + niedziałające wczesne buildy). `22.13` to pierwszy bezflagowy import. Portable Node pinujemy do dokładnego patcha aktualnego 22.x LTS (np. `22.22.x`). (zob. źródło #1.4 — korekta wartości na podstawie researchu)
- **Guard wersji jako self-executing moduł wołany PIERWSZY w `server.js`.** `require('node:sqlite')` jest top-level w `lib/db.js` → na starym Node rzuca kryptyczny `ERR_UNKNOWN_BUILTIN_MODULE` zanim cokolwiek zdążymy zalogować. Guard musi wykonać się przed `require('./lib/db')`, bez zależności od `node:sqlite`.
- **Smoke-test typów po `migrate()` w starcie serwera, nie tylko w teście.** Trywialny SELECT agregatu → `typeof === 'number'`; inaczej fail-fast. Chroni produkcję, gdyby przyszła wersja node:sqlite zmieniła domyślne typowanie.
- **`--disable-warning=ExperimentalWarning` w każdej ścieżce startu** (`package.json start`, systemd `ExecStart`, spawn w hooku) — czyste logi dla serwisu 24/7 ze structured loggingiem.
- **Portable Node base = `.node/` w korzeniu projektu** (źródło #2.7). Bootstrap pobiera tarball/zip z `nodejs.org/dist`, weryfikuje `SHASUMS256.txt`, rozpakowuje; binarka rozwiązywana per platforma (`bin/node` vs `node.exe`).
- **Cienki bootstrap (shell) + gruby `setup.mjs` (Node).** Bootstrap robi tylko portable Node; cała logika konfiguracyjna (pytania, hook z absolutną ścieżką, `settings.json`, smoke-test, env) w `setup.mjs` uruchamianym portable Nodem — eliminuje duplikację bash↔PowerShell.

## Otwarte pytania

### Rozwiązane podczas planowania

- **Czy `db.transaction()` blokuje migrację?** Nie — grep potwierdza brak użycia w `lib/`/`server.js`. Tylko 2× `db.pragma()` do przepisania.
- **Jakie okno Node?** `>=22.13 <25` (research), patch pinowany do aktualnego 22.x LTS. Nadpisuje `>=22.5` ze źródła.
- **`caffeinate` na Windows?** Non-issue — już pod guardem `process.platform === 'darwin'` (`setup.sh:210`, ten sam kod w hooku Windows). Bez zmian.
- **BigInt?** `readBigInts` zostaje `false` (default `number`); smoke-test pilnuje regresji.

### Odroczone do implementacji

- **Dokładny patch portable Node** (np. 22.22.3 vs nowszy 22.x w momencie implementacji) — wybór najnowszego stabilnego 22.x LTS przy dotknięciu bootstrapu.
- **Mechanika one-linera `curl|bash` / `irm|iex`** (czy klonuje repo, czy zakłada sklonowane) — dopięcie przy README; bootstrap sam zakłada repo obecne.
- **Layout `.node/`** (flat vs zagnieżdżony `<dist-name>/`) — po dotknięciu rozpakowywania w bootstrapie.
- **Czy `MIN_NODE_VERSION` w `config.js` vw dedykowanym module guarda** — drobny wybór przy pisaniu guarda.

## Implementation Units

### Faza 1 — Migracja DB (globalna) + guardy + zabezpieczenie VPS

> Ląduje pierwsza i samodzielnie. Po jej merge VPS/Mac/Win działają na `node:sqlite` z fail-fast guardami. Faza 2 (lokalny smart setup) jest niezależna i może iść później.

- [x] **Unit 1: Migracja `lib/db.js` na `node:sqlite` + `package.json` (engines, usunięcie deps)**

**Cel:** `lib/db.js` używa `DatabaseSync` z `node:sqlite`; `better-sqlite3` znika z projektu; `engines` pinuje poprawne okno Node.

**Wymagania:** R1, R2

**Zależności:** Brak

**Pliki:**
- Modyfikuj: `lib/db.js` (`:1` import → `const { DatabaseSync } = require('node:sqlite')`; `:22` `new DatabaseSync(target)`; `:23-24` `db.pragma(...)` → `db.exec('PRAGMA journal_mode = WAL')` + `db.exec('PRAGMA foreign_keys = ON')`)
- Modyfikuj: `package.json` (usuń `better-sqlite3` z `dependencies`; dodaj `"engines": { "node": ">=22.13 <25" }`)
- Test (unit): `lib/db.test.js`

**Delegate to:** feature-builder-data

**Skills in play:** supabase-dev-guidelines, security, sentry-integration

**Podejście:**
- Migracja mechaniczna — reszta API (`prepare().get/all/run`, `.exec`, `lastInsertRowid`, `.changes`, `:memory:`, `.close()`, named/pozycyjne params) ma parytet, bez zmian w warstwie konsumującej.
- Zostaw jawne `PRAGMA foreign_keys = ON` mimo że node:sqlite ma FK domyślnie ON — defense in depth, zerowy koszt.
- `npm install` po usunięciu deps musi przejść bez kompilacji natywnej.

**Notatka wykonawcza:** Najpierw uruchom istniejący suite na zmienionym `lib/db.js` (charakteryzacja parytetu) — zielony suite jest dowodem migracji, dopiero potem ewentualne nowe asercje.

**Wzorce do naśladowania:**
- `lib/db.js:9-18` (DI `:memory:`), `lib/db.test.js` (`:memory:` + `beforeEach` cleanup).

**Scenariusze testowe:**
- [Unit] Pełny `lib/db.test.js` PASS na `node:sqlite` — `ROW_NUMBER() OVER`, `ON DELETE CASCADE`, `PRAGMA table_info`, `datetime('now','localtime')`, backfill guard flagą `state` (parytet zachowań).
- [Unit] `createJob` zwraca `lastInsertRowid` jako `number`; `deleteOldRoutineRuns`/`reapOrphanedRuns` zwracają `.changes` jako `number`.
- [Unit] `getTodayRunStats` zwraca `{ success, failed }` typu `number` (nie BigInt, nie string) — happy path + zero-runs (COALESCE→0).

**Weryfikacja:**
- `node --test` (cały suite) przechodzi bez regresji.
- `grep -n "better-sqlite3" lib/ server.js package.json` zwraca pusto (usunięte wszędzie).
- `grep -n "node:sqlite" lib/db.js` pokazuje import `DatabaseSync`.
- `grep -c "\.pragma(" lib/db.js` zwraca `0` (pragmy przepisane na `exec`).

---

- [x] **Unit 2: Guardy startowe — wersja Node (fail-fast) + smoke-test typów DB + wyciszenie ExperimentalWarning**

**Cel:** Serwer odmawia startu z czytelnym komunikatem na niekompatybilnym Node lub gdy DB zwraca złe typy; logi czyste (bez ExperimentalWarning).

**Wymagania:** R3, R4

**Zależności:** Unit 1

**Pliki:**
- Stwórz: `lib/runtime-guard.js` (self-executing: czyta `process.versions.node`, porównuje z `MIN_NODE_VERSION`; jeśli poniżej → czytelny, akcjonowalny komunikat na stderr + `process.exit(1)`; ZERO zależności od `node:sqlite`)
- Modyfikuj: `server.js` (`require('./lib/runtime-guard')` jako **pierwsza** linia, przed `require('./lib/db')`; po `migrate()` wołaj smoke-test typów)
- Modyfikuj: `lib/db.js` lub `lib/config.js` (eksport `MIN_NODE_VERSION` + funkcja smoke-testu typów, np. `assertDbReturnsNumbers(db)`)
- Modyfikuj: `package.json` (`"start": "node --disable-warning=ExperimentalWarning server.js"`)
- Test (unit): `lib/runtime-guard.test.js`, rozszerzenie `lib/db.test.js` o smoke-test

**Delegate to:** feature-builder-data

**Skills in play:** supabase-dev-guidelines, security, sentry-integration

**Podejście:**
- Guard wersji jako osobny moduł bez `require('node:sqlite')`, by wykonał się przed top-level importem w `lib/db.js`. Komunikat: aktualna vs wymagana wersja + jak naprawić (portable Node / `nvm install`).
- Smoke-test: po `migrate()` trywialny SELECT agregatu (reuse `getTodayRunStats` lub dedykowany `SELECT COUNT(*)`), asercja `typeof === 'number'`; inaczej rzuć typed error z czytelnym komunikatem (fail-fast).
- Parsowanie `process.versions.node` (semver „major.minor.patch") porównaj numerycznie — pokryj edge `22.13` granicę.

**Notatka wykonawcza:** Test-first dla `runtime-guard` — pure funkcja porównania wersji (`isNodeSupported(version, min)`) testowalna bez mockowania procesu; sam efekt `exit(1)` weryfikowany przez wstrzyknięcie wersji jako argument.

**Wzorce do naśladowania:**
- `lib/config.js:26-43` (blok stałych + eksport), wzorzec typed error z `.claude/rules` (nie string throw).

**Scenariusze testowe:**
- [Unit] `isNodeSupported('22.13.0', '22.13')` → true; `'22.12.5'` → false; `'24.0.0'` → false (poza górną granicą `<25`); `'22.22.3'` → true.
- [Unit] Smoke-test: stub/`:memory:` DB z agregatem zwracającym `number` → przechodzi; symulacja nie-number → rzuca typed error (error case R4).
- [Unit] Guard z wersją poniżej minimum produkuje komunikat zawierający wymaganą wersję (asercja na treść, nie tylko exit).

**Weryfikacja:**
- `node --test lib/runtime-guard.test.js` przechodzi.
- `grep -n "disable-warning=ExperimentalWarning" package.json` pokazuje flagę w `start`.
- `node -e "require('./lib/runtime-guard')"` na wspieranym Node nie rzuca; `grep -n "MIN_NODE_VERSION" lib/` pokazuje stałą.

**Operator checklist:**
- [ ] Operator startuje serwer na wspieranym Node i potwierdza brak `ExperimentalWarning` na stderr oraz czysty start (smoke-test nie blokuje).

---

- [x] **Unit 3: Zabezpieczenie VPS — próg Node ≥22.13, usunięcie build-tools dla b-s3, guard cron auto-update**

**Cel:** `install-vps.sh` gwarantuje kompatybilny Node; nocny auto-update nie zrestartuje serwisu na Node bez `node:sqlite`.

**Wymagania:** R5

**Zależności:** Unit 1 (migracja musi istnieć, by guard miał sens)

**Pliki:**
- Modyfikuj: `scripts/install-vps.sh` (`:41-63` próg z `< 18` na `< 22.13` → instaluj 22.x LTS; usuń `build-essential`/`python3` instalowane dla `better-sqlite3` z `:87`, o ile nie są potrzebne dla innej zależności; `:266` `ExecStart` dodaj `--disable-warning=ExperimentalWarning`; `:438` przed `systemctl restart` w cronie dodaj pre-check wersji Node — pomiń restart + zaloguj ostrzeżenie, jeśli Node niekompatybilny)

**Delegate to:** feature-builder-data

**Skills in play:** supabase-dev-guidelines, security, sentry-integration

**Podejście:**
- Próg Node: jeśli zainstalowany Node < 22.13 → instaluj pinowaną 22.x LTS z nodesource (lub portable, spójnie z Fazą 2 — do dopięcia). Sam serwer i tak ma guard z Unit 2 jako drugą linię obrony.
- Cron guard: rozszerz `CRON_CMD` tak, by `systemctl restart` wykonał się **tylko** gdy `node -v` ≥ minimum; inaczej `git pull` zostaje (kod się zaktualizuje), ale restart wstrzymany + log do journal/pliku, by operator wiedział. Zapobiega scenariuszowi „stary Node 18 → wszystkie joby padają w nocy".
- Sprawdź, czy `build-essential`/`python3` nie są wymagane przez `koffi`/`pg` — jeśli tak, zostaw; jeśli były tylko dla `better-sqlite3`, usuń.

**Notatka wykonawcza:** Zmiany w bash — brak unit testów; weryfikacja przez `grep`/`bash -n` (syntax) + Operator checklist na realnym VPS.

**Wzorce do naśladowania:**
- `scripts/install-vps.sh:41-63` (istniejący Node check), `:438` (budowa `CRON_CMD`).

**Scenariusze testowe:**
- [Manual] Na realnym VPS ze starym Node: cron auto-update robi `git pull`, ale NIE restartuje serwisu; log zawiera ostrzeżenie o niekompatybilnym Node.

**Weryfikacja:**
- `bash -n scripts/install-vps.sh` (brak błędów składni).
- `grep -n "22.13\|disable-warning=ExperimentalWarning" scripts/install-vps.sh` pokazuje podniesiony próg i flagę w `ExecStart`.
- `grep -n "better-sqlite3\|build-essential" scripts/install-vps.sh` — brak instalacji build-tools pod b-s3 (lub komentarz uzasadniający pozostawienie pod inną zależność).

**Operator checklist:**
- [ ] Operator uruchamia zaktualizowany `install-vps.sh` na świeżym VPS i potwierdza: Node ≥22.13, serwis `is-active`, cron obecny z guardem wersji.

### Faza 2 — Smart setup lokalny (Mac/Win) + sprzątanie

> Niezależna od Fazy 1 w sensie DB, ale Unit 5 (hook z absolutną ścieżką) zakłada portable Node z Unit 4.

- [x] **Unit 4: Portable Node bootstrap — `install.sh` (Mac/Linux) + `install.ps1` (Windows)**

**Cel:** Cienki bootstrap per-OS stawia pinowany portable Node w `.node/` (z weryfikacją sumy) i przekazuje sterowanie do `setup.mjs`.

**Wymagania:** R6, R8

**Zależności:** Brak (równoległy do Fazy 1)

**Pliki:**
- Stwórz: `install.sh` (Mac/Linux bootstrap)
- Stwórz: `install.ps1` (Windows bootstrap)

**Delegate to:** feature-builder-data

**Skills in play:** supabase-dev-guidelines, security, sentry-integration

**Podejście:**
- Wykryj platformę+arch, pobierz `node-v<ver>-<platform>-<arch>.(tar.gz|zip)` z `nodejs.org/dist/v<ver>/`, **zweryfikuj `SHASUMS256.txt`** (tani guard przed uszkodzonym/podmienionym archiwum — security), rozpakuj do `.node/`.
- „Detect-and-touch-only-missing": jeśli `.node/` z poprawną wersją już istnieje → pomiń pobieranie. Nie dotykaj systemowego Node usera, PATH, `.zshrc`/profilu PS.
- Po postawieniu portable Node: `exec .node/.../node setup.mjs` (przekaż sterowanie). Bootstrap NIE zawiera logiki konfiguracyjnej.
- Rozwiązanie binarki: `bin/node` (unix) / `node.exe` w korzeniu rozpakowanego folderu (win).

**Notatka wykonawcza:** Skrypty shell/PS — weryfikacja przez `bash -n` / `Test-Path` + Operator checklist (realne pobranie). Pure logika (parsowanie platformy→nazwa archiwum) jeśli wyciągalna do `setup.mjs`, testowalna tam.

**Wzorce do naśladowania:**
- `setup.sh` (struktura pytań/echo, choć logika przenoszona do `setup.mjs`); nazewnictwo dist z researchu zewnętrznego (sekcja 4).

**Scenariusze testowe:**
- [Manual] Mac: `bash install.sh` pobiera portable Node do `.node/`, weryfikuje sumę, odpala `setup.mjs`.
- [Manual] Windows: `install.ps1` analogicznie (zip → `node.exe`).

**Weryfikacja:**
- `bash -n install.sh` (brak błędów składni).
- `grep -n "SHASUMS256\|nodejs.org/dist" install.sh install.ps1` pokazuje pobieranie z oficjalnego źródła + weryfikację sumy.
- `grep -n "setup.mjs" install.sh install.ps1` pokazuje przekazanie sterowania.

**Operator checklist:**
- [ ] Operator na czystym Macu i czystym Windowsie potwierdza, że bootstrap stawia portable Node bez globalnej instalacji i bez zmian PATH.

---

- [x] **Unit 5: Wspólny `setup.mjs` — pytania, hook z absolutną ścieżką Node, settings.json, smoke-test**

**Cel:** Jedna ścieżka konfiguracji (Node, identyczna Mac/Win): generuje hook autostartu wołający portable Node po absolutnej ścieżce, rejestruje w `settings.json`, woła smoke-test, obsługuje warunek wstępny Claude Code.

**Wymagania:** R7, R8, R9

**Zależności:** Unit 4 (portable Node), Unit 2 (smoke-test do wywołania)

**Pliki:**
- Stwórz: `setup.mjs` (pytania konfiguracyjne, generowanie hooka, manipulacja `settings.json`, wywołanie smoke-testu, setup env)
- Modyfikuj/zastąp: logika z `setup.sh:162-270` i `setup-windows.ps1:190-315` migruje do `setup.mjs` (shell zostaje cienki w Unit 4)
- Test (unit): `setup.test.mjs` (pure helpery: budowa ścieżki node, merge `settings.json`)

**Delegate to:** feature-builder-data

**Skills in play:** supabase-dev-guidelines, security, sentry-integration

**Podejście:**
- **Absolutna ścieżka Node (R7):** rozwiąż ścieżkę portable binarki i **wypal ją na sztywno** w `spawn()` generowanego hooka oraz w komendzie w `settings.json` — koniec gołego `node` w detached procesie. Dodaj `--disable-warning=ExperimentalWarning` do args spawn.
- **Claude Code precondition (R9):** wykryj `claude` w PATH; jeśli brak → zatrzymaj z jasnym komunikatem („zainstaluj jedną komendą, uruchom `claude` raz, zaloguj się, wróć"), **NIE** instaluj Claude sam.
- **`settings.json` merge** idempotentny (nie duplikuj wpisu hooka przy re-runie) — wzorzec z obecnego `setup.sh:228-253` (`node -e` do JSON).
- `caffeinate` zostaje pod guardem `darwin` (bez zmian — już poprawne).
- Po konfiguracji: wywołaj smoke-test typów (Unit 2) raz, by od razu wykryć niekompatybilność.

**Notatka wykonawcza:** Pure helpery (`resolveNodeBinPath(platform, baseDir)`, `mergeHookIntoSettings(existing, hook)`) test-first; I/O (zapis plików, pytania) jako cienka skorupa.

**Wzorce do naśladowania:**
- `setup.sh:195-253` (kształt hooka + rejestracja w settings.json), `setup.sh:210` (guard `darwin` dla caffeinate).

**Scenariusze testowe:**
- [x] [Unit] `resolveNodeBinPath('darwin', base)` → `.../bin/node`; `('win32', base)` → `...\node.exe`.
- [x] [Unit] `mergeHookIntoSettings`: pusty settings → dodaje wpis; settings z istniejącym wpisem hooka → bez duplikatu (idempotencja).
- [x] [Unit] Generowany hook zawiera absolutną ścieżkę node (nie goły `'node'`) i flagę `--disable-warning=ExperimentalWarning`.
- [Manual] Brak `claude` w PATH → setup zatrzymuje się z handoff-komunikatem, niczego nie instaluje.

**Weryfikacja:**
- `node --test setup.test.mjs` przechodzi.
- `grep -n "node.exe\|bin/node\|disable-warning" setup.mjs` pokazuje absolutną ścieżkę + flagę w generowanym hooku.
- `grep -n "claude" setup.mjs` pokazuje detekcję warunku wstępnego (handoff, nie instalacja).

**Operator checklist:**
- [ ] Operator na Macu i Windowsie potwierdza, że po setup hook autostartu wstaje serwer w detached procesie (portable Node, bez fnm/nvm na PATH).

---

- [x] **Unit 6: Sprzątanie skryptów + przepięcie `package.json` + uninstall pod nowy layout**

**Cel:** Koniec dwóch konkurencyjnych ścieżek instalacji; `package.json` i uninstall spójne z nowym flow.

**Wymagania:** R10

**Zależności:** Unit 4, Unit 5

**Pliki:**
- Usuń: `scripts/install-macos.sh`, `scripts/install-windows.ps1` (martwe LaunchAgent/Scheduled Task)
- Modyfikuj: `package.json` (`install:mac` → `bash install.sh`; `install:win` → `powershell -ExecutionPolicy Bypass -File install.ps1`)
- Modyfikuj: `scripts/uninstall-macos.sh`, `scripts/uninstall-windows.ps1` (nowy layout: usuń `.node/`, przepięty hook z `settings.json`, absolutna ścieżka)

**Delegate to:** feature-builder-data

**Skills in play:** supabase-dev-guidelines, security, sentry-integration

**Podejście:**
- Przed usunięciem zweryfikuj, że nic poza `package.json` nie referuje martwych skryptów (`grep`).
- Uninstall musi czysto cofnąć nowy layout: wpis hooka w `settings.json`, plik hooka, opcjonalnie `.node/` (zapytaj/flaga, bo to 50 MB runtime — nie kasuj niespodzianie).

**Notatka wykonawcza:** Confirm-before-delete — uninstall nie kasuje `.node/` bez jawnej zgody/flagi (memory: potwierdzaj destrukcję).

**Wzorce do naśladowania:**
- `scripts/uninstall-macos.sh` (obecne usuwanie LaunchAgent → zamień na usuwanie wpisu hooka).

**Scenariusze testowe:**
- [Manual] `npm run uninstall:mac` po instalacji czysto usuwa hook z `settings.json` i plik hooka; `.node/` tylko za zgodą.

**Weryfikacja:**
- `test ! -f scripts/install-macos.sh && test ! -f scripts/install-windows.ps1` (usunięte).
- `grep -n "install.sh\|install.ps1" package.json` pokazuje przepięte skrypty; `grep -rn "install-macos.sh\|install-windows.ps1" .` (poza historią git) zwraca pusto.

---

- [x] **Unit 7: README — nowy flow instalacji (one-liner + checksum), usunięcie wymogu VS Build Tools**

**Cel:** Dokumentacja odzwierciedla nowy, prostszy flow; znika wymóg VS Build Tools; opisany trust `curl|bash`/`irm|iex`.

**Wymagania:** R10

**Zależności:** Unit 4, Unit 5, Unit 6

**Pliki:**
- Modyfikuj: `README.md` (sekcje Mac/Windows: nowy entry point `install.sh`/`install.ps1`; **usuń sekcję VS Build Tools** `:201-210`; zaktualizuj wymaganą wersję Node; dodaj notkę o `curl|bash`/`irm|iex` z odsyłaczem „przeczytaj skrypt najpierw" / weryfikacją sumy; wzmianka o portable Node `.node/`)

**Delegate to:** feature-builder-data

**Skills in play:** supabase-dev-guidelines, security, sentry-integration

**Podejście:**
- Windows: usuń cały blok o Visual Studio Build Tools — po migracji niepotrzebny (to główny payoff „ułatwienia").
- Trust: świadomie akceptowany `curl|bash` (omija Gatekeeper/SmartScreen za darmo) — w README dać sprawdzalny checksum / instrukcję obejrzenia skryptu (ryzyko #11 ze źródła).

**Notatka wykonawcza:** Dokumentacja — weryfikacja przez `grep`.

**Wzorce do naśladowania:**
- Istniejąca struktura sekcji instalacji w `README.md:83-277`.

**Scenariusze testowe:**
- [Manual] Czytelnik na czystym Windows przechodzi instalację z README bez instalowania VS Build Tools.

**Weryfikacja:**
- `grep -in "build tools\|better-sqlite3" README.md` zwraca pusto (lub tylko w kontekście historycznym/changelog).
- `grep -n "install.sh\|install.ps1\|.node" README.md` pokazuje nowy flow.

## Wpływ systemowy

- **Graf interakcji:** Migracja DB jest pod-warstwowa — `getDb()`/`migrate()` zachowują kontrakt, więc scheduler/webhook/polling/server bez zmian. Guard wersji wpina się jako pierwszy w `server.js`; smoke-test po `migrate()`. Hook autostartu zmienia tylko binarkę (goły `node` → absolutna ścieżka), nie semantykę.
- **Propagacja błędów:** Niekompatybilny Node → fail-fast w `runtime-guard` z czytelnym komunikatem (zamiast `ERR_UNKNOWN_BUILTIN_MODULE`). Złe typy DB → typed error ze smoke-testu. INTEGER > 2^53 → `ERR_OUT_OF_RANGE` z node:sqlite (bezpieczny fail).
- **Ryzyka cyklu życia stanu:** Backfill flagą `state` (`learned-patterns.md`) musi przejść po migracji silnika — pokryte testem parytetu (Unit 1). FK domyślnie ON w node:sqlite + jawny PRAGMA = brak ryzyka osieroconych runów.
- **Parytet surface API:** Brak zmian w API HTTP/`createJob`/`updateJob`. `lib/db.js` to jedyny konsument silnika.
- **Pokrycie integracyjne:** Realny scenariusz „VPS restart na starym Node" dowodzony przez Operator checklist (Unit 3) — nie da się go w pełni odtworzyć w unit teście; guard wersji (Unit 2) jest jego unit-testowalnym rdzeniem.

## Ryzyka i zależności

- **Windows nietestowany.** Cały research/weryfikacja na Macu (Node 22.22.3). `node:sqlite` jest wbudowane w binarkę Node (kompilowane przez zespół Node), więc ryzyko niskie, ale portable Node + hook autostartu MUSZĄ być odpalone na prawdziwym Windowsie przed „gotowe" (Operator checklist Unit 4/5).
- **Próg Node na VPS.** Jeśli `build-essential`/`python3` są potrzebne przez `koffi`/`pg` — nie usuwać (Unit 3 weryfikuje przed usunięciem).
- **`defensive: true` domyślnie od Node 24.14.** Trzymaj ten sam major w dev i prod (portable Node pinowany do 22.x); górna granica `engines <25` to zabezpiecza.
- **Sekwencja:** Faza 1 (Unit 1→2→3) niezależna od Fazy 2. W Fazie 2: Unit 4 → Unit 5 → Unit 6 → Unit 7. Unit 1 i Unit 4 mogą startować równolegle.

## Rozważane alternatywy

- **Pakowanie `.dmg`/`.exe`** — odrzucone w źródle: płatne certyfikaty, inaczej Gatekeeper/SmartScreen straszy. Terminalowy one-liner omija to za darmo.
- **`nvm`/`fnm` zamiast portable Node** — odrzucone: shimy nie ładują się w detached/non-interactive procesie hooka (to przyczyna obecnego buga), wymagają zmian PATH/profilu.
- **`readBigInts: true` globalnie** — niepotrzebne; default `number` + fail-fast `ERR_OUT_OF_RANGE` jest bezpieczniejsze i nie wymaga zmian w warstwie konsumującej.

## Plan dokumentacji

- README (Unit 7): nowy flow, usunięcie VS Build Tools, notka trust/checksum, wersja Node.
- Rozważyć krótką notkę migracyjną dla istniejących instalacji (b-s3 → node:sqlite jest transparentne dla danych — ten sam plik `.db`), opcjonalne.

## Źródła i referencje

- **Dokument źródłowy:** [docs/plans/2026-06-25-ulatwienie-instalacji-ustalenia.md](./2026-06-25-ulatwienie-instalacji-ustalenia.md)
- Powiązany kod: `lib/db.js:1-24`, `package.json:7`, `scripts/install-vps.sh:41-63,87,266,438`, `setup.sh:162-270`, `setup-windows.ps1:190-315`, `scripts/install-macos.sh`, `scripts/install-windows.ps1`, `README.md:201-210`.
- Wiedza instytucjonalna: `.claude/rules/learned-patterns.md` (localtime, backfill guard), `docs/completed/migracja-puls-rebrand/review-faza-3.md:61` (BigInt/SUM).
- Zewnętrzne: Node.js SQLite docs (v22.x/v24.x), nodejs/node#53905, #53906, #58611; `nodejs.org/dist/v<ver>/` + `SHASUMS256.txt`.
