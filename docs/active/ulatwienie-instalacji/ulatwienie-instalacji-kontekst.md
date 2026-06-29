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

## Otwarte pytania (odroczone do implementacji)

- Dokładny patch portable Node (najnowszy stabilny 22.x LTS w momencie implementacji).
- Mechanika one-linera `curl|bash`/`irm|iex` (klonuje repo vs zakłada sklonowane).
- Layout `.node/` (flat vs zagnieżdżony `<dist-name>/`).
- `MIN_NODE_VERSION` w `config.js` vs dedykowanym module guarda.

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
