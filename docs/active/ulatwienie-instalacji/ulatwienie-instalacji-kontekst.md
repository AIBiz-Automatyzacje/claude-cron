# Kontekst: Ułatwienie instalacji Pulsa

**Branch:** `feature/ulatwienie-instalacji`
**Ostatnia aktualizacja:** 2026-06-29

## Powiązane pliki

### Warstwa DB / runtime (Faza 1)
- `lib/db.js:1` — `require('better-sqlite3')` → `const { DatabaseSync } = require('node:sqlite')` (Unit 1).
- `lib/db.js:22` — `new Database(target)` → `new DatabaseSync(target)`.
- `lib/db.js:23-24` — `db.pragma('journal_mode = WAL')` + `db.pragma('foreign_keys = ON')` → `db.exec('PRAGMA ...')` (jedyne 2 `pragma()`).
- `lib/db.js:9-18` — DI `setDbPath(':memory:')` + `dbPathOverride || DB_PATH` (wzorzec testów zostaje).
- `lib/db.js:123-126` — guarded backfill flagą `state` (idempotencja, `learned-patterns.md`).
- `lib/db.js:228-237` — `getTodayRunStats`: `COALESCE(SUM(...),0)` → cel smoke-testu R4.
- `lib/config.js:9-10` — `DATA_DIR`/`DB_PATH`; kandydat na stałą `MIN_NODE_VERSION` (wzorzec bloku stałych jak `MAINTENANCE_WINDOW:43`).
- `server.js:7` (`"start"` w package.json) — `require('./lib/runtime-guard')` jako pierwsza linia + smoke-test po `migrate()` (Unit 2).
- `package.json:7` — `"start": "node server.js"` → +flaga; brak `engines` → dodać; `better-sqlite3: ^12.0.0` → usunąć.
- `lib/db.test.js` — `:memory:` DI, ~23 testy; rozszerzenie o smoke-test.

### Skrypty instalacyjne (Faza 1 VPS + Faza 2)
- `scripts/install-vps.sh:41-63` — Node check (próg `<18` → `<22.13`); `:87` build-essential+python3 (dla b-s3); `:266` `ExecStart=$NODE_PATH ... server.js` (+flaga); `:438` cron `0 2 * * *` (+guard wersji) (Unit 3).
- `setup.sh:162-270` — generuje hook `{workspace}/.claude/hooks/claude-cron-autostart.js`, rejestruje w `settings.json` (`hooks.UserPromptSubmit`); `:202` `spawn('node', ['server.js'], {detached})`; `:210` `caffeinate` pod guardem `darwin` (JUŻ poprawne).
- `setup-windows.ps1:190-315` — analogiczny (PowerShell), `:225` spawn node.
- `scripts/install-macos.sh` (LaunchAgent), `scripts/install-windows.ps1` (Scheduled Task) — **martwe**, do usunięcia (Unit 6); `package.json install:mac/win` wciąż na nie wskazują.
- `scripts/uninstall-macos.sh`, `scripts/uninstall-windows.ps1` — aktualizacja pod nowy layout (Unit 6).
- `README.md:83-277` (instalacja Mac/Win/VPS); `:201-210` blok VS Build Tools → usunąć (Unit 7).

### Nowe pliki
- `lib/runtime-guard.js` (Unit 2), `install.sh` + `install.ps1` (Unit 4), `setup.mjs` (Unit 5).
- Testy: `lib/runtime-guard.test.js`, `setup.test.mjs`.

## Decyzje techniczne

1. **Okno Node `>=22.13 <25`, NIE `>=22.5` ze źródła.** Research: bezflagowy `require('node:sqlite')` działa dopiero od 22.13.0; 22.5–22.12 wymaga `--experimental-sqlite`, niektóre buildy 22.5.0 zepsute (ARM Mac). Portable Node pinowany do dokładnego patcha 22.x LTS.
2. **Guard wersji jako self-executing moduł wołany PIERWSZY w `server.js`** — przed top-level `require('node:sqlite')` w `lib/db.js`, by zamienić kryptyczny `ERR_UNKNOWN_BUILTIN_MODULE` na czytelny komunikat.
3. **Smoke-test typów po `migrate()` w starcie serwera** — agregaty `typeof === 'number'`, inaczej fail-fast.
4. **`--disable-warning=ExperimentalWarning` w każdej ścieżce startu** (start script, systemd `ExecStart`, spawn w hooku) — czyste logi 24/7.
5. **Portable Node base `.node/`** — pobranie z `nodejs.org/dist`, weryfikacja `SHASUMS256`, binarka `bin/node` (unix) / `node.exe` (win).
6. **Cienki bootstrap (shell) + gruby `setup.mjs` (Node)** — eliminuje duplikację bash↔PowerShell.
7. **`readBigInts: false` (default)** — `number` wszędzie; node:sqlite rzuca `ERR_OUT_OF_RANGE` przy INTEGER > 2^53 (bezpieczniej niż b-s3).

## Postęp implementacji

### Faza 1 — ukończona (2026-06-29)

**Unit 1 — migracja `node:sqlite`:** `lib/db.js` używa `DatabaseSync` z `node:sqlite`; oba PRAGMA przez `db.exec(...)` (zero `.pragma()`). `better-sqlite3` usunięty z `package.json`, dodane `engines: ">=22.13 <25"`. Suite 121 testów PASS, agregaty zwracają `number`.

**Unit 2 — guardy startowe:** `lib/runtime-guard.js` (self-executing, zero zależności od `node:sqlite`) importuje `MIN_NODE_VERSION`/`MAX_NODE_VERSION` z `config.js` (single source of truth). `server.js` woła go pierwszą linią. Smoke-test `assertDbReturnsNumbers(conn)` + typed error `DbTypeError` w `lib/db.js`, wołany po `getDb()` w starcie. `start` w `package.json` ma `--disable-warning=ExperimentalWarning`.

**Unit 3 — VPS:** próg Node rozbity na `MIN_NODE_MAJOR=22`/`MIN_NODE_MINOR=13` (bash porównuje liczby całkowite, nie float). Funkcja `is_node_supported`. Build-tools (`build-essential`/`python3`) usunięte — pozostał tylko komentarz uzasadniający (koffi prebuilt, pg czysty JS). `ExecStart` z flagą wyciszenia. Cron-guard zaimplementowany jako wygenerowany skrypt `scripts/cron-node-guard.sh` (chmod +x, własność `$CLAUDE_USER`) uruchamiany w `CRON_CMD` jako `$CLAUDE_USER` — pewniejszy niż wielolinijkowy one-liner w crontab; `git pull` zawsze, `systemctl restart` tylko po PASS guarda.

### Decyzje z implementacji

- **Test '24.0.0' → true (NIE false).** Scenariusz w planie deklarował `false (poza górną granicą <25)`, ale to wewnętrznie sprzeczne: `24 < 25`. Źródło prawdy = `engines >=22.13 <25`, więc 24 jest wspierane. Test odzwierciedla `true`.
- **Brak typecheck/eslint** — projekt to czysty CommonJS bez TypeScript i bez konfiguracji ESLint. Zamiast typecheck: `node -c` (składnia OK na wszystkich plikach). Brak kroku `vite build` (brak frontendowego buildu).
- **Cron-guard jako osobny skrypt, nie inline.** Cron roota uruchamia komendę w czystym shellu; guard musi czytać wersję Node usera `claude` — `su - $CLAUDE_USER -c '... && bash GUARD'`.

### Faza 2 — ukończona (2026-06-29)

**Unit 4 — portable Node bootstrap:** `install.sh` (Mac/Linux, tar.gz) + `install.ps1` (Windows, zip). Wykrycie platformy+arch, pobranie z `nodejs.org/dist/v22.17.0`, weryfikacja `SHASUMS256` (shasum/sha256sum unix, Get-FileHash win), rozpak do `.node/`, detect-and-touch-only-missing, `exec`/`&` handoff do `setup.mjs`. Layout zagnieżdżony `.node/node-v<ver>-<platform>-<arch>/` (rozstrzygnięcie odroczonej decyzji). Patch pinowany do 22.17.0 (stabilny 22.x LTS w oknie). `bash -n install.sh` OK; `install.ps1` do weryfikacji operatorem na Windows (brak pwsh na macOS).

**Unit 5 — wspólny `setup.mjs`:** ESM, pure helpery (`resolveNodeBinPath(platform, baseDir, nodeVersion, arch)`, `mergeHookIntoSettings`, `removeHookFromSettings`, `buildHookSource(repoDir, nodeBinPath)`, `detectPortableNodeBin(execPath, platform, repoDir, arch)`, `isClaudeInstalled(probe)`) + cienka skorupa I/O w `main()`. Hook wypala ABSOLUTNĄ ścieżkę z `process.execPath` (realnie działający portable Node z `.node/`), `resolveNodeBinPath` to fallback. Flaga `--disable-warning=ExperimentalWarning` w args spawn. Detekcja `claude` w PATH (which/where) → handoff bez instalacji. Smoke-test DB po konfiguracji. Pytania zredukowane do workspace + autostart.

**Unit 6 — sprzątanie:** usunięte martwe `scripts/install-macos.sh` + `scripts/install-windows.ps1`. `package.json`: `install:mac` → `bash install.sh`, `install:win` → `powershell -ExecutionPolicy Bypass -File install.ps1`. Uninstall (mac/win) pod nowy layout: usuwa wpis hooka z `settings.json` przez wspólny `removeHookFromSettings` (single source of truth markera), usuwa plik hooka; `.node/` tylko za flagą `--remove-node`/`-RemoveNode` (confirm-before-delete). Uninstall przyjmuje workspace jako 1. arg (domyślnie `$HOME`).

**Unit 7 — README:** nowy entry point `install.sh`/`install.ps1`, usunięta sekcja VS Build Tools, notka trust/checksum dla `curl|bash`/`irm|iex`, wzmianka o portable Node `.node/`, zredukowana tabela pytań setup (Mac+Win: z 4 na 2 — workspace + autostart).

### Decyzje z implementacji (Faza 2)

- **Hook z `process.execPath`, nie rekonstrukcja ze stałych.** `detectPortableNodeBin` preferuje binarkę, która realnie odpaliła setup; `resolveNodeBinPath` (parametryzowany platform+ver+arch dla testowalności obu OS) to fallback.
- **`.gitignore` += `.node/`** — portable binarki (~50 MB) nie wchodzą do repo (higiena/security). Poza zakresem „Pliki" planu, ale konieczne.
- **`removeHookFromSettings` w `setup.mjs`** (nie duplikat parsowania JSON w bash/ps) — lustro `mergeHookIntoSettings`, jedno źródło markera; uninstall woła go przez portable Node z fallbackiem systemowym.
- **Patch portable Node = 22.17.0** (najnowszy stabilny 22.x LTS w oknie `>=22.13 <25`).
- **Brak typecheck/eslint** (czysty CommonJS/ESM) — zamiast tego `node --check` na `setup.mjs`/`setup.test.mjs`, `bash -n` na shellu. Brak `vite build` (brak frontendowego buildu).

### Walidacja Fazy 2 (2026-06-29)

- `node --test` (cały suite): **141 PASS / 0 FAIL** (121 z Fazy 1 + 20 nowych w `setup.test.mjs`).
- `node --check setup.mjs` / `node --check setup.test.mjs`: OK. `bash -n install.sh` / `bash -n scripts/uninstall-macos.sh`: OK.
- Wszystkie checkboxy Weryfikacja CLI/grep (Unit 4–7) PASS: SHASUMS256+nodejs.org+setup.mjs w install.sh/ps1; martwe skrypty usunięte; package.json przepięte; README bez build-tools/better-sqlite3, z nowym flow.
- Manual/Operator: Windows (`install.ps1`, brak pwsh na macOS), brak `claude` w PATH, realne pobranie portable Node, uninstall end-to-end — do operatora.

### Review fazy 1 (2026-06-29)

Severity gate: **ZASTRZEZENIA** (0× P1, 2× P2, 14× P3 + findingi OPERATOR). Raport: `review-faza-1.md`.

Kluczowe wnioski:
- **P2 KOD** — bash `is_node_supported` + cron-guard sprawdzaja tylko dolny prog; brak gornej granicy `<25` rozjezdza sie z `engines`/`runtime-guard.js`. Na Node 25/26 cron zrestartuje serwis, ktory padnie `exit(1)` — scenariusz, ktoremu guard ma zapobiegac.
- **P2 TEST** — `enforceNodeVersion` (efekt fail-fast `exit(1)`, rdzen R3) jest nietestowalny (czyta `process.versions.node` bez DI) i nieprzetestowany. Potrzebny refaktor z wstrzykiwana wersja + DI exit/stderr.
- Bookkeeping Weryfikacja: wszystkie 11 checkboxow CLI/grep PASS (suite 121, runtime-guard 10).
- E2E: brak scenariuszy przegladarkowych (warstwa DB/runtime/VPS).
- 5 findingow OPERATOR (start na realnym Node, exit(1) na <22.13, install-vps na swiezym VPS, negatywny cron-guard) → sekcja "Operator checklist faza 1" w pliku zadan.

## Otwarte pytania (rozstrzygnięte w implementacji)

- ~~Dokładny patch portable Node~~ → **22.17.0** (najnowszy stabilny 22.x LTS w oknie).
- ~~Mechanika one-linera `curl|bash`/`irm|iex`~~ → README opisuje wariant „pobierz → obejrzyj skrypt → uruchom" + checksum SHASUMS256; bootstrap zakłada repo sklonowane obok `setup.mjs`.
- ~~Layout `.node/`~~ → **zagnieżdżony** `.node/node-v<ver>-<platform>-<arch>/` (zgodny z natywnym layoutem dystrybucji Node, bez post-processingu rozpaku).
- ~~`MIN_NODE_VERSION` w `config.js` vs module guarda~~ → w `config.js` (single source of truth, Faza 1).

## Zależności

- **`node:sqlite`** (wbudowany, Node ≥22.13) — zastępuje `better-sqlite3`.
- **`croner`, `koffi`, `pg`, `gray-matter`** — pozostają; sprawdzić czy `koffi`/`pg` wymagają build-tools przed usunięciem ich z `install-vps.sh`.
- **node:test / `:memory:`** — wzorzec DI w testach.
- **Wiedza instytucjonalna:** `.claude/rules/learned-patterns.md` (localtime, backfill guard — niezmienne przy migracji silnika), `docs/completed/migracja-puls-rebrand/review-faza-3.md:61` (BigInt/SUM → motywuje smoke-test).
- **Sekwencja:** Faza 1 (1→2→3) niezależna od Fazy 2 (4→5→6→7); Unit 1 i 4 równolegle.

## Korekta vs dokument źródłowy

- `caffeinate` **już** pod guardem `darwin` (`setup.sh:210`) — pkt #8 ze źródła to non-issue.
- Brak `db.transaction()` w kodzie (grep) → migracja bez komplikacji transakcyjnych.
- `engines` skorygowane z `>=22.5` na `>=22.13` (research).

## Źródła
- Requirements doc: (brak — origin to ustalenia, nie `/dev-brainstorm`)
- Plan techniczny: [docs/plans/2026-06-29-001-feat-ulatwienie-instalacji-plan.md](../../plans/2026-06-29-001-feat-ulatwienie-instalacji-plan.md)
- Dokument źródłowy (ustalenia): [docs/plans/2026-06-25-ulatwienie-instalacji-ustalenia.md](../../plans/2026-06-25-ulatwienie-instalacji-ustalenia.md)
