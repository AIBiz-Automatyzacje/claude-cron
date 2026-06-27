# Learned Patterns

Reguły wyciągnięte z rozwiązanych problemów w docs/solutions/. Zarządzane przez /dev-compound i /dev-compound-refresh.

<!-- rule-count: 3 -->

- **Top N per grupa = window function, nie flat LIMIT**: Gdy chcesz N ostatnich rekordów *na każdą grupę* (per job/user/kategoria), użyj `ROW_NUMBER() OVER (PARTITION BY grupa ORDER BY id DESC)` + filtr `rn <= N`. Globalny `ORDER BY id DESC LIMIT N` cicho gubi grupy o wysokiej kadencji — jedna grupa zjada całe okno.
  Source: docs/solutions/performance-issues/2026-06-23-per-job-recent-runs-window-function.md

- **Granica doby w SQLite licz w localtime**: Porównania „dziś/wczoraj" rób `date(kolumna,'localtime') = date('now','localtime')`. Goły `date('now')` liczy w UTC i cicho przesuwa granicę doby o offset strefy (dla PL przeskok o 1:00–2:00 zamiast o północy).
  Source: docs/solutions/performance-issues/2026-06-23-per-job-recent-runs-window-function.md

- **Backfill danych w migrate() guard flagą w state, nie bare UPDATE**: `migrate()` woła się przy KAŻDYM `getDb()`/boocie, więc gołe `UPDATE jobs SET x=...` clobberuje świadome zmiany usera co restart. Migracje schematu (`IF NOT EXISTS`, guard `PRAGMA table_info`) są idempotentne z natury; backfill danych NIE — owiń sentinelem `state['<feature>_done']`. Czytaj/pisz flagę przez przekazany `db`, nie `getState/setState` (te wołają `getDb()`, którego połączenie nie istnieje jeszcze w trakcie migrate).
  Source: docs/solutions/runtime-errors/2026-06-27-backfill-w-migrate-clobberuje-opt-outy.md
