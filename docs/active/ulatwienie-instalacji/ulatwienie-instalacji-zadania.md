# Zadania: Ułatwienie instalacji Pulsa

**Branch:** `feature/ulatwienie-instalacji`
**Ostatnia aktualizacja:** 2026-06-29

## Faza 1 — Migracja DB (globalna) + guardy + VPS

### Unit 1: Migracja `lib/db.js` na `node:sqlite` + `package.json`
**Delegate:** feature-builder-data · **Wymagania:** R1, R2 · **Zależności:** brak

#### Implementacja
- [ ] `lib/db.js:1` — import → `const { DatabaseSync } = require('node:sqlite')`
- [ ] `lib/db.js:22` — `new DatabaseSync(target)`
- [ ] `lib/db.js:23-24` — `db.pragma(...)` → `db.exec('PRAGMA journal_mode = WAL')` + `db.exec('PRAGMA foreign_keys = ON')`
- [ ] `package.json` — usuń `better-sqlite3` z `dependencies`; dodaj `"engines": { "node": ">=22.13 <25" }`
- [ ] `lib/db.test.js` — charakteryzacja parytetu (suite zielony przed nowymi asercjami)

#### Testy
- [ ] Test: Pełny `lib/db.test.js` PASS na `node:sqlite` — `ROW_NUMBER() OVER`, `ON DELETE CASCADE`, `PRAGMA table_info`, `datetime('now','localtime')`, backfill guard flagą `state`
- [ ] Test: `createJob` zwraca `lastInsertRowid` jako `number`; `deleteOldRoutineRuns`/`reapOrphanedRuns` zwracają `.changes` jako `number`
- [ ] Test: `getTodayRunStats` zwraca `{ success, failed }` typu `number` (happy path + zero-runs COALESCE→0)

#### Weryfikacja
- [ ] Weryfikacja: `node --test` (cały suite) przechodzi bez regresji
- [ ] Weryfikacja: `grep -n "better-sqlite3" lib/ server.js package.json` zwraca pusto
- [ ] Weryfikacja: `grep -n "node:sqlite" lib/db.js` pokazuje import `DatabaseSync`
- [ ] Weryfikacja: `grep -c "\.pragma(" lib/db.js` zwraca `0`

---

### Unit 2: Guardy startowe (wersja Node + smoke-test typów + wyciszenie ExperimentalWarning)
**Delegate:** feature-builder-data · **Wymagania:** R3, R4 · **Zależności:** Unit 1

#### Implementacja
- [ ] Stwórz `lib/runtime-guard.js` (self-executing: porównanie `process.versions.node` z `MIN_NODE_VERSION`; poniżej → czytelny komunikat na stderr + `process.exit(1)`; ZERO zależności od `node:sqlite`)
- [ ] `server.js` — `require('./lib/runtime-guard')` jako pierwsza linia; po `migrate()` wołaj smoke-test typów
- [ ] `lib/db.js` lub `lib/config.js` — eksport `MIN_NODE_VERSION` + funkcja smoke-testu (`assertDbReturnsNumbers(db)`)
- [ ] `package.json` — `"start": "node --disable-warning=ExperimentalWarning server.js"`
- [ ] Stwórz `lib/runtime-guard.test.js`; rozszerz `lib/db.test.js` o smoke-test

#### Testy
- [ ] Test: `isNodeSupported('22.13.0', '22.13')` → true; `'22.12.5'` → false; `'24.0.0'` → false; `'22.22.3'` → true
- [ ] Test: Smoke-test — `:memory:` DB z agregatem `number` przechodzi; symulacja nie-number → typed error (error case R4)
- [ ] Test: Guard z wersją poniżej minimum produkuje komunikat zawierający wymaganą wersję

#### Weryfikacja
- [ ] Weryfikacja: `node --test lib/runtime-guard.test.js` przechodzi
- [ ] Weryfikacja: `grep -n "disable-warning=ExperimentalWarning" package.json` pokazuje flagę w `start`
- [ ] Weryfikacja: `node -e "require('./lib/runtime-guard')"` na wspieranym Node nie rzuca; `grep -n "MIN_NODE_VERSION" lib/` pokazuje stałą

#### Operator checklist
- [ ] Operator startuje serwer na wspieranym Node → brak `ExperimentalWarning` na stderr, czysty start (smoke-test nie blokuje)

---

### Unit 3: Zabezpieczenie VPS (próg Node, build-tools, cron-guard)
**Delegate:** feature-builder-data · **Wymagania:** R5 · **Zależności:** Unit 1

#### Implementacja
- [ ] `scripts/install-vps.sh:41-63` — próg z `<18` na `<22.13` → instaluj 22.x LTS
- [ ] `scripts/install-vps.sh:87` — usuń `build-essential`/`python3` instalowane dla `better-sqlite3` (po weryfikacji, że nie potrzebne dla `koffi`/`pg`)
- [ ] `scripts/install-vps.sh:266` — `ExecStart` dodaj `--disable-warning=ExperimentalWarning`
- [ ] `scripts/install-vps.sh:438` — cron-guard: `systemctl restart` tylko gdy `node -v` ≥ minimum; inaczej `git pull` zostaje, restart wstrzymany + log

#### Testy
- [ ] Test [Manual]: Na realnym VPS ze starym Node cron robi `git pull`, ale NIE restartuje serwisu; log zawiera ostrzeżenie o niekompatybilnym Node

#### Weryfikacja
- [ ] Weryfikacja: `bash -n scripts/install-vps.sh` (brak błędów składni)
- [ ] Weryfikacja: `grep -n "22.13\|disable-warning=ExperimentalWarning" scripts/install-vps.sh` pokazuje próg + flagę
- [ ] Weryfikacja: `grep -n "better-sqlite3\|build-essential" scripts/install-vps.sh` — brak build-tools pod b-s3 (lub komentarz uzasadniający)

#### Operator checklist
- [ ] Operator uruchamia zaktualizowany `install-vps.sh` na świeżym VPS → Node ≥22.13, serwis `is-active`, cron z guardem wersji

## Faza 2 — Smart setup lokalny (Mac/Win) + sprzątanie

### Unit 4: Portable Node bootstrap (`install.sh` + `install.ps1`)
**Delegate:** feature-builder-data · **Wymagania:** R6, R8 · **Zależności:** brak (równoległy do Fazy 1)

#### Implementacja
- [ ] Stwórz `install.sh` (Mac/Linux bootstrap): wykryj platformę+arch, pobierz z `nodejs.org/dist/v<ver>/`, weryfikuj `SHASUMS256.txt`, rozpakuj do `.node/`, `exec .node/.../node setup.mjs`
- [ ] Stwórz `install.ps1` (Windows bootstrap): analogicznie (zip → `node.exe`)
- [ ] Detect-and-touch-only-missing: pomiń pobieranie gdy `.node/` z poprawną wersją istnieje; nie dotykaj systemowego Node/PATH/profilu

#### Testy
- [ ] Test [Manual]: Mac — `bash install.sh` pobiera portable Node do `.node/`, weryfikuje sumę, odpala `setup.mjs`
- [ ] Test [Manual]: Windows — `install.ps1` analogicznie (zip → `node.exe`)

#### Weryfikacja
- [ ] Weryfikacja: `bash -n install.sh` (brak błędów składni)
- [ ] Weryfikacja: `grep -n "SHASUMS256\|nodejs.org/dist" install.sh install.ps1` pokazuje oficjalne źródło + weryfikację sumy
- [ ] Weryfikacja: `grep -n "setup.mjs" install.sh install.ps1` pokazuje przekazanie sterowania

#### Operator checklist
- [ ] Operator na czystym Macu i Windowsie: bootstrap stawia portable Node bez globalnej instalacji i bez zmian PATH

---

### Unit 5: Wspólny `setup.mjs` (pytania, hook z absolutną ścieżką, settings.json, smoke-test)
**Delegate:** feature-builder-data · **Wymagania:** R7, R8, R9 · **Zależności:** Unit 4, Unit 2

#### Implementacja
- [ ] Stwórz `setup.mjs` (pytania, generowanie hooka, merge `settings.json`, wywołanie smoke-testu, setup env)
- [ ] Migruj logikę z `setup.sh:162-270` i `setup-windows.ps1:190-315` do `setup.mjs` (shell zostaje cienki)
- [ ] Hook: absolutna ścieżka portable Node wypalona w `spawn()` + komendzie w `settings.json` + `--disable-warning=ExperimentalWarning` w args
- [ ] Claude Code precondition: wykryj `claude` w PATH; brak → handoff-komunikat, NIE instaluj
- [ ] Stwórz `setup.test.mjs` (pure helpery)

#### Testy
- [ ] Test: `resolveNodeBinPath('darwin', base)` → `.../bin/node`; `('win32', base)` → `...\node.exe`
- [ ] Test: `mergeHookIntoSettings` — pusty settings dodaje wpis; istniejący wpis → bez duplikatu (idempotencja)
- [ ] Test: generowany hook zawiera absolutną ścieżkę node (nie goły `'node'`) + flagę `--disable-warning=ExperimentalWarning`
- [ ] Test [Manual]: brak `claude` w PATH → setup zatrzymuje się z handoff, niczego nie instaluje

#### Weryfikacja
- [ ] Weryfikacja: `node --test setup.test.mjs` przechodzi
- [ ] Weryfikacja: `grep -n "node.exe\|bin/node\|disable-warning" setup.mjs` pokazuje absolutną ścieżkę + flagę w hooku
- [ ] Weryfikacja: `grep -n "claude" setup.mjs` pokazuje detekcję warunku wstępnego (handoff)

#### Operator checklist
- [ ] Operator na Macu i Windowsie: po setup hook autostartu wstaje serwer w detached procesie (portable Node, bez fnm/nvm na PATH)

---

### Unit 6: Sprzątanie skryptów + przepięcie package.json + uninstall
**Delegate:** feature-builder-data · **Wymagania:** R10 · **Zależności:** Unit 4, Unit 5

#### Implementacja
- [ ] Usuń `scripts/install-macos.sh`, `scripts/install-windows.ps1` (martwe LaunchAgent/Scheduled Task)
- [ ] `package.json` — `install:mac` → `bash install.sh`; `install:win` → `powershell -ExecutionPolicy Bypass -File install.ps1`
- [ ] `scripts/uninstall-macos.sh`, `scripts/uninstall-windows.ps1` — nowy layout: usuń wpis hooka z `settings.json` + plik hooka; `.node/` tylko za zgodą/flagą (confirm-before-delete)

#### Testy
- [ ] Test [Manual]: `npm run uninstall:mac` po instalacji czysto usuwa hook z `settings.json` i plik hooka; `.node/` tylko za zgodą

#### Weryfikacja
- [ ] Weryfikacja: `test ! -f scripts/install-macos.sh && test ! -f scripts/install-windows.ps1` (usunięte)
- [ ] Weryfikacja: `grep -n "install.sh\|install.ps1" package.json` pokazuje przepięte skrypty
- [ ] Weryfikacja: `grep -rn "install-macos.sh\|install-windows.ps1" .` (poza historią git) zwraca pusto

---

### Unit 7: README — nowy flow instalacji + usunięcie wymogu VS Build Tools
**Delegate:** feature-builder-data · **Wymagania:** R10 · **Zależności:** Unit 4, Unit 5, Unit 6

#### Implementacja
- [ ] `README.md` — sekcje Mac/Win: nowy entry point `install.sh`/`install.ps1`
- [ ] `README.md:201-210` — usuń sekcję VS Build Tools
- [ ] `README.md` — zaktualizuj wymaganą wersję Node; dodaj notkę trust/checksum dla `curl|bash`/`irm|iex`; wzmianka o portable Node `.node/`

#### Testy
- [ ] Test [Manual]: czytelnik na czystym Windows przechodzi instalację z README bez instalowania VS Build Tools

#### Weryfikacja
- [ ] Weryfikacja: `grep -in "build tools\|better-sqlite3" README.md` zwraca pusto (lub tylko kontekst historyczny)
- [ ] Weryfikacja: `grep -n "install.sh\|install.ps1\|.node" README.md` pokazuje nowy flow
