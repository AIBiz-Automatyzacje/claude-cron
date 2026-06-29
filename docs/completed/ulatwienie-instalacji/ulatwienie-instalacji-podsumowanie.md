# Podsumowanie: Ułatwienie instalacji Pulsa

**Data ukończenia:** 2026-06-29
**Branch:** `feature/ulatwienie-instalacji`
**Status:** Obie fazy ukończone (execute + review + fix). Suite `node --test`: 141/141 PASS (121 z Fazy 1 + 20 nowych w `setup.test.mjs`), zero regresji.

## Co zostało dostarczone

Usunięcie największej bariery wejścia w instalacji Pulsa w dwóch krokach:

1. **Migracja DB (globalna, Mac/Win/VPS):** `better-sqlite3` → wbudowany `node:sqlite` (`DatabaseSync`). Koniec natywnej kompilacji i wymogu 3-5 GB VS Build Tools na Windows. Objęte guardami fail-fast (wersja Node + smoke-test typów DB) oraz zabezpieczeniem VPS (nocny auto-update nie restartuje serwisu na niekompatybilnym Node).
2. **Smart setup (lokalny, Mac/Win):** portable Node w `.node/`, absolutna ścieżka Node wypalona w hooku autostartu, cienki bootstrap per-OS (`install.sh`/`install.ps1`) + wspólny gruby `setup.mjs`.

- **Unit 1 — migracja `node:sqlite`:** `lib/db.js` na `DatabaseSync`, oba PRAGMA przez `db.exec(...)` (zero `.pragma()`); `better-sqlite3` usunięty z deps, dodane `engines: ">=22.13 <25"`. Agregaty zwracają `number`, nie `BigInt`.
- **Unit 2 — guardy startowe:** `lib/runtime-guard.js` (self-executing, zero zależności od `node:sqlite`, wołany pierwszą linią `server.js`); smoke-test `assertDbReturnsNumbers(conn)` + typed error `DbTypeError` po `migrate()`; `--disable-warning=ExperimentalWarning` w `start`. `MIN_NODE_VERSION`/`MAX_NODE_VERSION` w `config.js` (single source of truth). Po review fazy 1: `enforceNodeVersion(version, { onFail })` z DI (testowalny fail-fast) + górna granica `<25` w bash i cron-guardzie.
- **Unit 3 — VPS:** próg Node `<18` → `<22.13` (rozbity na `MIN_NODE_MAJOR`/`MIN_NODE_MINOR` dla porównania liczb całkowitych w bashu); usunięte build-tools (`build-essential`/`python3` — koffi prebuilt, pg czysty JS); `ExecStart` z flagą wyciszenia; cron-guard jako osobny skrypt `scripts/cron-node-guard.sh` (`git pull` zawsze, `systemctl restart` tylko po PASS guarda).
- **Unit 4 — portable Node bootstrap:** `install.sh` (tar.gz) + `install.ps1` (zip): wykrycie platformy+arch, pobranie z `nodejs.org/dist/v22.17.0`, weryfikacja `SHASUMS256`, rozpak do `.node/`, detect-and-touch-only-missing, handoff do `setup.mjs`.
- **Unit 5 — wspólny `setup.mjs`:** ESM z pure helperami (`resolveNodeBinPath`, `mergeHookIntoSettings`, `removeHookFromSettings`, `buildHookSource`, `detectPortableNodeBin`, `isClaudeInstalled`) + cienka skorupa I/O. Hook wypala absolutną ścieżkę z `process.execPath` (+flaga). Detekcja `claude` w PATH → handoff bez instalacji. Po review fazy 2: persystencja env (workspace + VPS + Discord), backup `settings.json` zamiast nadpisywania przy uszkodzonym JSON.
- **Unit 6 — sprzątanie:** usunięte martwe `scripts/install-macos.sh`/`install-windows.ps1` oraz osierocone root `setup.sh`/`setup-windows.ps1` (stary bugowany hook `spawn('node', ...)`); `package.json` przepięty (`install:mac` → `bash install.sh`, `install:win` → `powershell ... install.ps1`); uninstall pod nowy layout (usuwa wpis hooka z `settings.json` przez `removeHookFromSettings`, `.node/` tylko za flagą `--remove-node`/`-RemoveNode`).
- **Unit 7 — README:** nowy entry point, usunięta sekcja VS Build Tools, notka trust/checksum dla `curl|bash`/`irm|iex`, wzmianka o portable Node `.node/`, zredukowana tabela pytań setup.

## Kluczowe decyzje

1. **Okno Node `>=22.13 <25`, NIE `>=22.5` ze źródła.** Bezflagowy `require('node:sqlite')` działa dopiero od 22.13.0; 22.5-22.12 wymaga `--experimental-sqlite`, niektóre buildy 22.5.0 zepsute (ARM Mac). Górna granica `<25`: ten sam major dev/prod, `defensive: true` od 24.14.
2. **Guard wersji jako self-executing moduł wołany PIERWSZY w `server.js`** — przed top-level `require('node:sqlite')` w `lib/db.js`, by zamienić kryptyczny `ERR_UNKNOWN_BUILTIN_MODULE` na czytelny komunikat.
3. **Smoke-test typów po `migrate()`** — agregaty `typeof === 'number'`, inaczej fail-fast (`DbTypeError`). `readBigInts: false` (default) — node:sqlite rzuca `ERR_OUT_OF_RANGE` przy INTEGER > 2^53.
4. **`--disable-warning=ExperimentalWarning` w każdej ścieżce startu** (start script, systemd `ExecStart`, spawn w hooku) — czyste logi 24/7.
5. **Cienki bootstrap (shell) + gruby `setup.mjs` (Node)** — eliminuje duplikację bash↔PowerShell; logika konfiguracji w jednym pliku ESM, testowalna pure helperami.
6. **Hook z `process.execPath`, nie rekonstrukcja ze stałych** — `detectPortableNodeBin` preferuje binarkę która realnie odpaliła setup; `resolveNodeBinPath` (parametryzowany platform+ver+arch) to fallback.
7. **Cron-guard jako osobny skrypt, nie inline** — cron roota uruchamia komendę w czystym shellu; guard musi czytać wersję Node usera `claude` przez `su - $CLAUDE_USER -c '... && bash GUARD'`.
8. **Test '24.0.0' → true (NIE false jak w planie).** Plan deklarował false „poza górną granicą <25", ale `24 < 25` — wewnętrznie sprzeczne. Źródło prawdy = `engines >=22.13 <25`.
9. **Brak typecheck/eslint** — projekt to czysty CommonJS/ESM bez TS i ESLint. Zamiast: `node --check`/`node -c` na plikach JS/mjs, `bash -n` na shellu. Brak `vite build` (brak frontendowego buildu).

## Główne pliki

- `lib/db.js` — `DatabaseSync` z `node:sqlite`, PRAGMA przez `exec`, `assertDbReturnsNumbers`, `DbTypeError`.
- `lib/runtime-guard.js` — self-executing guard wersji Node, `enforceNodeVersion(version, { onFail })`, `isNodeSupported`.
- `lib/config.js` — `MIN_NODE_VERSION`/`MAX_NODE_VERSION` (single source of truth).
- `package.json` — usunięty `better-sqlite3`, `engines`, `start` z flagą, `install:mac`/`install:win` przepięte.
- `scripts/install-vps.sh` — próg Node 22.13, bez build-tools, `ExecStart` z flagą, cron-guard.
- `scripts/cron-node-guard.sh` — wygenerowany guard restartu (git pull zawsze, restart warunkowy).
- `install.sh` / `install.ps1` — portable Node bootstrap (SHASUMS256 + handoff do setup.mjs).
- `setup.mjs` — wspólna logika konfiguracji (pure helpery + I/O), hook z absolutną ścieżką.
- `scripts/uninstall-macos.sh` / `scripts/uninstall-windows.ps1` — nowy layout (hook + opcjonalnie `.node/`).
- `README.md` — nowy flow, bez VS Build Tools.
- Testy: `lib/db.test.js`, `lib/runtime-guard.test.js`, `setup.test.mjs`.
- Usunięte: `scripts/install-macos.sh`, `scripts/install-windows.ps1`, root `setup.sh`, `setup-windows.ps1`.

## Wnioski

- **Migracja silnika SQLite (better-sqlite3 → node:sqlite) wymaga charakteryzacji parytetu PRZED zmianą** — `ROW_NUMBER() OVER`, `ON DELETE CASCADE`, `PRAGMA table_info`, `datetime('now','localtime')`, backfill guard flagą `state` muszą przejść na nowym silniku. Zielony suite przed nowymi asercjami.
- **node:sqlite zwraca INTEGER jako `number` (readBigInts: false default)** — bezpieczniejsze niż BigInt z b-s3, ale agregaty SUM/COALESCE wymagają smoke-testu typu (`typeof === 'number'`), bo regresja silnika może wrócić BigInt cicho.
- **Fail-fast wymaga DI, by był testowalny** — `enforceNodeVersion` czytający `process.versions.node` bez parametru jest nieprzetestowalny; refaktor na `(version, { onFail })` zamknął lukę testową rdzenia R3.
- **Porównanie wersji w bashu rób na liczbach całkowitych, nie float** — `22.13` jako float (`22.1`) myli porównanie minor; rozbicie na `MAJOR`/`MINOR` jako osobne inty. Górna i dolna granica MUSZĄ być spójne w OBU kopiach (funkcja + heredoc cron-guarda) — ryzyko rozjazdu z `engines`.
- **Hook autostartu MUSI wypalać absolutną ścieżkę Node** — goły `spawn('node', ...)` zakłada Node na PATH; w sesji Claude Code (bez fnm/nvm) to niemy fail. `process.execPath` to binarka która realnie odpaliła setup.
- **Pusty `catch` przy parsowaniu `settings.json` + `writeFileSync` = utrata danych usera** (permissions, inne hooki, env). Fail-fast z backupem zamiast nadpisania.
- **Granica testowalności pure vs I/O/manual:** stack bez harnessu E2E — pure helpery pokryte `node:test`, bootstrap shell/portable Node/Windows/realne pobranie → Operator checklist.

## Otwarte (nieblokujące) — Operator checklist / P3

**Operator checklist (manual, niewykonalne headless):**
- Start serwera na wspieranym Node (>=22.13 <25) → brak `ExperimentalWarning`, czysty start, smoke-test nie blokuje.
- `exit(1)` na Node <22.13 → czytelny komunikat z wykrytą i wymaganą wersją.
- `install-vps.sh` na świeżym VPS → Node >=22.13, serwis `is-active`, cron z guardem; scenariusz negatywny cron-guard (zdegradowany Node → git pull przechodzi, restart wstrzymany, ostrzeżenie w journalu).
- Bootstrap portable Node przez `install.sh`/`install.ps1` na czystej maszynie (Mac/Win); hook detached server z portable Node bez fnm/nvm na PATH.
- Brak `claude` w PATH → setup handoff + `exit(1)`, niczego nie instaluje.
- `npm run uninstall:mac`/`uninstall:win` end-to-end (hook z settings.json + plik; `.node/` tylko za flagą).
- Integralność archiwum Node opiera się tylko na SHASUMS256 (bez GPG) — świadome ograniczenie scope; rozważyć GPG dla wyższego zaufania.

**Findingi P3 (nity, nie blokują):** `$VAULT_GIT` niecytowany w `CRON_CMD` (escaping przy ścieżce ze spacją); duplikacja logiki porównania wersji bash↔heredoc; smoke-test R4 error-case używa stringa `'0'` zamiast BigInt `0n`; brak jawnej walidacji `conn` w `assertDbReturnsNumbers`; `parseVersion` gubi pre-release tag; komentarz „22.5 stabilne" mylący; luźne `assert.equal` bez asercji typu; `parseVersion`/`compareVersions` bez bezpośredniego testu; pusty catch bez logu w `setup.mjs`; `runSmokeTest` materializuje produkcyjną DB zamiast `:memory:`; `detectPortableNodeBin` fallback bez walidacji arch; inline JSON.parse w uninstall bez try/catch; rozbieżność liczby testów w opisie commita (20 vs 17, później dopisane do 20).

## Źródła

- Plan techniczny: `docs/plans/2026-06-29-001-feat-ulatwienie-instalacji-plan.md`
- Dokument źródłowy (ustalenia): `docs/plans/2026-06-25-ulatwienie-instalacji-ustalenia.md`
- Rozwiązanie udokumentowane: `docs/solutions/runtime-errors/2026-06-29-migracja-better-sqlite3-na-node-sqlite.md`
