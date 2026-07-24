# Review Fazy 4 — Migracja + decommission + docs (Team OS Hub-API)

Data: 2026-07-24
Zakres: IU-4.1 (skrypt migracji pg → hub SQLite), IU-4.2 (decommission — OPERATOR), IU-4.3 (sprzątanie + docs)
Metoda: multi-agent review + adversarial verify (P1×3 sceptyków, P2×1).

## Severity gate: ✅ CZYSTE

- P1 (blocking): 0
- P2 (important, KOD/TEST/E2E): 0
- P3 (nit, KOD/TEST/E2E): 12
- OPERATOR (niewykonalne headless, poza gate'em fix): 2

Zero P1/P2 → gate nie blokuje. Wszystkie findingi KOD/TEST to nity (P3) na jednorazowym, throwaway skrypcie migracji (usuwanym w IU-4.3). Dwa findingi OPERATOR to warunki środowiskowe (realny Postgres + VPS + skan z zewnątrz), nieweryfikowalne headless.

## Statystyki

| Kategoria | Liczba |
|---|---|
| P1 KOD/TEST/E2E | 0 |
| P2 KOD/TEST/E2E | 0 |
| P3 KOD/TEST/E2E | 12 |
| OPERATOR | 2 |
| **Razem findingów** | **14** |

Testy automatyczne:
- `npm test` → 503 pass / 0 fail (exit 0)

## Findingi (P1 → P2 → P3 → OPERATOR)

Brak P1. Brak P2.

### P3 — nit

#### P3-1 · KOD · `scripts/inbox/migrate-pg-to-hub.mjs:77` — no-op ternary (dead code)
`content: row.content == null ? null : row.content` — obie gałęzie ternary zwracają dokładnie `row.content`. Uprość do `content: row.content`. Nie jest to defekt bezpieczeństwa, ale narusza self-check „usuwaj dead code".

#### P3-2 · KOD · `scripts/inbox/migrate-pg-to-hub.mjs:111` — pętla migrate() bez transakcji i bez mapowania błędów INSERT na MigrateError
Pętla `migrate()` nie jest owinięta transakcją i nie mapuje błędów SQLite INSERT na typowany `MigrateError`. Źródłowy wiersz z type/status poza CHECK huba albo z NULL w title (NOT NULL) rzuci surowy błąd node:sqlite w połowie iteracji → częściowa migracja + nieczytelny komunikat dla operatora (reszta pliku konsekwentnie używa MigrateError). Ryzyko łagodzone idempotentnym `INSERT OR IGNORE` przy re-runie; nie jest to problem bezpieczeństwa danych.

#### P3-3 · KOD · `scripts/inbox/migrate-pg-to-hub.mjs:111` — batch INSERT bez transakcji (fsync per wiersz)
W node:sqlite każdy INSERT bez jawnej transakcji auto-commituje (fsync na dysk per wiersz), co przy większej liczbie otwartych wątków daje N osobnych commitów zamiast jednego. Opakowanie w `conn.exec('BEGIN')`/`('COMMIT')` (z rollbackiem w catch) zredukowałoby to do jednego commitu. Realny wpływ minimalny — zbiór jest bounded (`WHERE status != 'done'`, otwarte wątki) i skrypt jest jednorazowy/throwaway (usuwany w IU-4.3), więc nit, nie blocker.

#### P3-4 · KOD · `scripts/inbox/migrate-pg-to-hub.mjs:117` — type/status bez walidacji względem CHECK huba
`type` i `status` ze źródłowego Postgresa trafiają do raw INSERT bez walidacji względem CHECK huba (`type IN task/query/reply/close`, `status IN pending/delivered/done` — inbox-db.js:67,71). Jeśli stary PG zawiera wartość spoza whitelisty, pętla przerywa się surowym błędem SQLite CHECK w połowie (brak transakcji = częściowa migracja), co przeczy deklarowanemu celowi MigrateError „czytelny komunikat zamiast kryptycznego błędu pg/sqlite" (nagłówek + linia 30-31). Ryzyko niskie (schematy zgodne per CLAUDE.md) i re-run idempotentny domyka resztę, ale walidacja type/status przed INSERT dałaby spójny fail-fast.

#### P3-5 · KOD · `scripts/inbox/migrate-pg-to-hub.mjs:117` — stmt.run() nie owinięty w MigrateError
Deklarowany cel skryptu to „czytelny komunikat dla operatora zamiast kryptycznego błędu pg/sqlite", ale błędy warstwy INSERT tego nie realizują. Pola wymagane (from_user/to_user/type/title/status) idą surowo do `stmt.run`; gdyby wiersz źródłowy miał którekolwiek jako `undefined` (np. brak kolumny), node:sqlite rzuci kryptycznym „cannot bind", a nie MigrateError. W praktyce niskie ryzyko (kolumny są NOT NULL w źródle i jawnie selektowane), stąd P3. Rozważ try/catch wokół `stmt.run` mapujący na MigrateError, spójnie z `pgRowToHubRow`/`readSourceUrl`.

#### P3-6 · KOD · `scripts/inbox/migrate-pg-to-hub.mjs:112,143` — filtr status per-wiersz vs migracja „otwartych WĄTKÓW"
Filtr `status != 'done'` działa PER-WIERSZ, choć IU-4.1 mówi o migracji „otwartych WĄTKÓW" (plan.md:107, zadania.md:155). Wątek gdzie root task jest `done` (ukończony), ale dołączony reply „Zrobione ✅" jest jeszcze `pending` (adresat nie odhaczył) → migruje się tylko reply, a jego root nie. W hubie `getThread(thread_id)` zwróci wtedy sierotę bez roota, a renderer pokaże niepełną nitkę. Zgodne z DOSŁOWNYM zapisem spec (`status != done`), więc nie jest to odstępstwo od litery IU — ale operator powinien wiedzieć o tym edge przed jednorazową migracją danych zespołu. Rozważ filtr per-thread (migruj wszystkie wiersze wątku, który ma choć jeden otwarty wiersz) albo świadomie udokumentuj akceptację sierot.

#### P3-7 · KOD · `scripts/inbox/migrate-pg-to-hub.mjs:103,132` — INSERT OR IGNORE tłumi CICHO każdy constraint
`INSERT OR IGNORE` tłumi CICHO KAŻDE naruszenie constraintu (CHECK type/status, NOT NULL to_user/title, UNIQUE), nie tylko konflikt PRIMARY KEY — a każdy zignorowany wiersz jest liczony jako `skippedDuplicate` („już w hubie"). Dla jednorazowego narzędzia migracyjnego to fałszywe poczucie sukcesu: wiersz odrzucony przez constraint = cicha utrata danych raportowana jako „pominięto (już w hubie)". Ryzyko realnie niskie (schemat starego Postgresa i huba są zgodne co do CHECK/NOT NULL), stąd P3, ale migracja powinna być głośna o wierszach, których nie dało się wstawić (np. rozróżnić `changes==0` przy istniejącym id vs realny błąd, albo INSERT bez OR IGNORE w try/catch z policzeniem odrzuconych).

#### P3-8 · KOD · `scripts/inbox/migrate-pg-to-hub.mjs:112` — podwójny filtr status != done (defensive, gałąź nieosiągalna w prod)
Realny reader ma już `WHERE status != 'done'` w SQL (linia 143), a `migrate()` dodatkowo filtruje `row.status === 'done'` (linia 112) + liczy `skippedDone`. W produkcji gałąź `skippedDone++` jest nieosiągalna (SQL nigdy nie zwróci `done`) — to defensive code na scenariusz, który nie może wystąpić (anti-pattern #10). Jedno źródło prawdy: albo usuń `WHERE` z SQL (wtedy filtr w kodzie realny i testowalny), albo usuń filtr w kodzie. Duplikacja świadomie zostawiona dla testowalności fake-readerem, ale wtedy `WHERE` w SQL jest zbędny.

#### P3-9 · KOD · `scripts/inbox/migrate-pg-to-hub.mjs:54` — toIso string-branch to martwy kod na ścieżce produkcyjnej
`toIso` obsługuje gałąź string (parse + walidacja `Number.isNaN`), która istnieje wyłącznie dla fixtures testowych/guardu — pg dla timestamptz zawsze zwraca obiekt Date, więc w produkcji string-handling to martwy kod (scaffolding testowy w ścieżce produkcyjnej). Dla throwaway skryptu akceptowalne, ale to niepotrzebna złożoność na niemożliwy w prod input.

#### P3-10 · TEST · `scripts/inbox/migrate-pg-to-hub.test.mjs:155` — brak error-case dla dwóch gałęzi fail-fast migrate()/toIso()
Brakuje testów error-case dla dwóch gałęzi fail-fast: (1) `migrate()` z niepoprawnym `db` (brak `getInboxDb`) rzucającym MigrateError (linia 98 impl) — testowany jest tylko zły `readRows`; (2) `toIso()` dla wartości nie-Date i nie-string (np. number/undefined) rzucającej MigrateError (linia 61 impl) — test pokrywa tylko string `'nie-data'`. Reguła projektu: każda funkcja = min. 1 happy + 1 error case dla KAŻDEJ gałęzi walidacji.

#### P3-11 · TEST · `scripts/inbox/migrate-pg-to-hub.test.mjs:155` — gałąź „db bez getInboxDb" nieprzetestowana
`migrate()` ma dwie gałęzie fail-fast (`readRows` nie-funkcja ORAZ `db` bez `getInboxDb`), ale test pokrywa tylko pierwszą. Gałąź „migrate: db musi być modułem inbox-db" (linia 98 w źródle) jest nieprzetestowana. Minimum reguły (1 happy + 1 error) spełnione, więc opcjonalne — dorzucenie `assert.rejects` dla `db=null` domknęłoby walidację kontraktu DI.

#### P3-12 · TEST · `scripts/inbox/migrate-pg-to-hub.test.mjs:72` — toIso() dla updated_at i wariant string ISO niepokryte
`toIso()` jest wołane dla `created_at` ORAZ `updated_at` (linie 80-81), ale test nieparsowalnej daty pokrywa tylko `created_at`. Ścieżka `updated_at` nieparsowalny → MigrateError niepokryta (ta sama funkcja, ale osobne pole/komunikat). Analogicznie brak testu wariantu, w którym `created_at` przychodzi jako STRING ISO (komentarz linia 53 deklaruje ten kontrakt dla fake source, testowany jest tylko wariant Date).

### OPERATOR — niewykonalne headless (poza fix, do Operator checklist)

#### OP-1 · `scripts/inbox/migrate-pg-to-hub.mjs:149`
`main()`/`readOpenRowsFromPg` wymagają realnego połączenia do starego, produkcyjnego Postgresa (`INBOX_DB_URL`) — ścieżka nieweryfikowalna headless (`pg.Client.connect` do zewnętrznej bazy). Testy pokrywają czyste transformacje i `migrate()` na `:memory:`, ale end-to-end pull ze źródła oraz decommission zależności `pg`/`schema.sql` to kroki operatorskie. Nie defekt kodu.

#### OP-2 · `docs/active/team-os-hub-api/team-os-hub-api-zadania.md`
IU-4.1 (faktyczne wykonanie migracji na produkcyjnym Postgresie via `INBOX_DB_URL`) oraz IU-4.2 (decommission: zgaszenie kontenera 62.72.33.171, rewokacja spalonego hasła, skan portu 5433 nc/nmap z zewnątrz) są niewykonalne headless — wymagają realnego dostępu do starego Postgresa i sieci VPS. Zgodnie z planem to kroki OPERATORA; skrypt migracji i jego DI-testowalna logika są kompletne, ale weryfikacja end-to-end migracji danych (miernik sukcesu 5 z planu) nie może być potwierdzona w tym środowisku.

## Bookkeeping checkboxów Weryfikacja:

- Odznaczone automatycznie (CLI/grep): 0 (jedyny CLI to część compound checkboxa IU-4.3 — patrz niżej)
- Odznaczone na podstawie Agent 5 E2E: 0
- Pozostawione dla operatora (Manual/E2E headless): 3
- Niejasne (P3): 0
- Failujące (P2): 0

### Szczegóły

Faza 4 ma trzy niezaznaczone checkboxy `Weryfikacja:`:

- [ ] **IU-4.1 (linia 157)**: „skrzynka end-to-end po hubie (wysłanie, odpowiedź, odhaczenie, archiwum, auto-reply)" → **E2E niewykonalny headless** (żywy hub + vaulty) → Operator checklist (OP-2). Zostaje `- [ ]`.
- [ ] **IU-4.2 (linia 162)**: „skan z zewnątrz — port 5433 nie odpowiada (`nc -zv` z innej sieci)" → **Manual/Operator** (wymaga skanu z innej sieci na VPS) → Operator checklist (OP-2). Zostaje `- [ ]`.
- [ ] **IU-4.3 (linia 168)**: compound „`npm install --omit=dev` na czysto + pełna suita zielona":
  - Część CLI: pełna suita → **PASS** (`npm test` exit 0, 503 pass / 0 fail).
  - Część `npm install --omit=dev` na czysto → **OPERATOR** (gated — usunięcie `pg` z IU-4.3 ma sens dopiero po wykonanej migracji IU-4.1 + decommissionie IU-4.2; skrypt migracji wciąż importuje `pg`, więc czysty install weryfikowalny dopiero po cleanupie). Zostaje `- [ ]` z adnotacją.

Nowe P2/P3 z bookkeepingu: 0 (brak CLI FAIL, brak Grep FAIL). Część CLI checkboxa IU-4.3 potwierdzona (npm test PASS). Severity gate bez zmian: ✅ CZYSTE.
