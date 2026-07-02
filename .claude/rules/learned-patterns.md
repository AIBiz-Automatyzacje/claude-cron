# Learned Patterns

Reguły wyciągnięte z rozwiązanych problemów w docs/solutions/. Zarządzane przez /dev-compound i /dev-compound-refresh.

<!-- rule-count: 7 -->

- **Top N per grupa = window function, nie flat LIMIT**: Gdy chcesz N ostatnich rekordów *na każdą grupę* (per job/user/kategoria), użyj `ROW_NUMBER() OVER (PARTITION BY grupa ORDER BY id DESC)` + filtr `rn <= N`. Globalny `ORDER BY id DESC LIMIT N` cicho gubi grupy o wysokiej kadencji — jedna grupa zjada całe okno.
  Source: docs/solutions/performance-issues/2026-06-23-per-job-recent-runs-window-function.md

- **Granica doby w SQLite licz w localtime**: Porównania „dziś/wczoraj" rób `date(kolumna,'localtime') = date('now','localtime')`. Goły `date('now')` liczy w UTC i cicho przesuwa granicę doby o offset strefy (dla PL przeskok o 1:00–2:00 zamiast o północy).
  Source: docs/solutions/performance-issues/2026-06-23-per-job-recent-runs-window-function.md

- **Backfill danych w migrate() guard flagą w state, nie bare UPDATE**: `migrate()` woła się przy KAŻDYM `getDb()`/boocie, więc gołe `UPDATE jobs SET x=...` clobberuje świadome zmiany usera co restart. Migracje schematu (`IF NOT EXISTS`, guard `PRAGMA table_info`) są idempotentne z natury; backfill danych NIE — owiń sentinelem `state['<feature>_done']`. Czytaj/pisz flagę przez przekazany `db`, nie `getState/setState` (te wołają `getDb()`, którego połączenie nie istnieje jeszcze w trakcie migrate).
  Source: docs/solutions/runtime-errors/2026-06-27-backfill-w-migrate-clobberuje-opt-outy.md

- **node:sqlite: smoke-test typów agregatów + okno wersji `>=22.13`, nie `22.5`**: Bezflagowy `require('node:sqlite')` działa dopiero od Node 22.13 (22.5–22.12 wymaga `--experimental-sqlite`). Część buildów zwraca `COUNT(*)`/`SUM(...)` jako BigInt zamiast number — arytmetyka i `JSON.stringify` cicho się psują bez wyjątku. Po migracji odpal smoke-test na żywym połączeniu (`typeof row.n === 'number'`, fail-fast) i wymuś wersję Node guardem PRZED pierwszym top-level importem `node:sqlite`. API: brak `.pragma()` (użyj `db.exec('PRAGMA ...')`), klasa `DatabaseSync`.
  Source: docs/solutions/runtime-errors/2026-06-29-migracja-better-sqlite3-na-node-sqlite.md

- **Instalator `curl|bash` z pytaniami: podepnij `/dev/tty`, nie dziedzicz stdin**: W `curl ... | bash` (i `irm|iex`) stdin to pipe z treścią skryptu, nie klawiatura — każde `read`/`readline` cicho dostaje EOF i instalator leci z domyślnymi. Przy handoffie do interaktywnego procesu rób `exec ... < /dev/tty` (Unix) / czytaj z `CONIN$` (Windows), z fallbackiem gdy tty niedostępne. Testuj ZAWSZE przez prawdziwy pipe — lokalne `bash install.sh` ukrywa bug. Bonus: re-run bootstrap chroni dane allowlistą stanowych katalogów (`data/`,`.node/`) + atomowy swap, `rm -rf "${var:?}/..."` zawsze z guardem.
  Source: docs/solutions/deployment-issues/2026-06-30-curl-bash-instalator-interaktywny-tty.md

- **Skrypt ładowany przez `iex` = czyste ASCII; entry-point guard w Node = `realpathSync` po obu stronach**: Plik `.ps1` puszczany przez `irm|iex` trzymaj w ASCII — BOM łamie `iex`, a brak BOM na PS 5.1 czyta UTF-8 jako ANSI i wywala parser; diakrytyki tylko w plikach czytanych jawnym `-Encoding UTF8`/`node`. Pod `irm|iex` NIE rób `exit` bez guardu na `$PSScriptRoot` (zamyka sesję hosta). Persystencję env pisz per platforma: Windows → `[Environment]::SetEnvironmentVariable(...,'User')`, nie `.zshrc`. W Node porównuj entry-point przez `fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))` — macOS symlinkuje `/var`,`/tmp` do `/private/*` i goły `path.resolve` cicho blokuje `main()`. Instalator testuj prawdziwym `curl|bash`/`irm|iex` z env-override źródła (ZIP/TARBALL URL + TOPDIR) PRZED mergem.
  Source: docs/solutions/deployment-issues/2026-07-01-instalator-cross-platform-irm-iex-encoding-env-symlink.md

- **Rollback instalatora kończy się na granicy interakcji usera — dalej leave-partial**: Stos rollbacku (`trap ERR` + LIFO) cofa TYLKO stan utworzony w tym runie (guard-first → `push_rollback` zaraz po akcji mutującej). Na wejściu bloku interaktywnych loginów zdejmij destrukcyjne wpisy (`drop_rollback "userdel -r ..."`) i wyłącz odwijanie — pad loginu = zostaw stan + instrukcja wznowienia (resume przez guardy `has_*`), NIGDY rollback (skasowałby świeże credentiale OAuth). Po finalnej weryfikacji opcjonalne kroki = warn, nie trap ERR. Bash: `trap ERR` w funkcjach wymaga `set -E`; bash 3.2 odpala trap dla `eval` nawet w warunku `if` (użyj dispatchu funkcja-wprost / `bash -c`).
  Source: docs/solutions/deployment-issues/2026-07-02-rollback-stos-a-granica-loginow-oauth.md
