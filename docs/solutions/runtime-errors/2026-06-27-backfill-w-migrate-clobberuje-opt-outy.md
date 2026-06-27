---
title: "Bare UPDATE w migrate() co restart clobberuje świadome opt-outy usera"
date: 2026-06-27
category: runtime-errors
severity: high
stack:
  - Node.js
  - SQLite
tags:
  - migrations
  - idempotency
  - state-flag
  - data-loss
  - backfill
status: verified
last_verified: 2026-06-27
---

# Bare UPDATE w migrate() co restart clobberuje świadome opt-outy usera

## Symptomy

- Zmiana defaultu kolumny boolean na opt-out (`run_on_wake`: 0 → 1) wymaga backfillu istniejących wierszy.
- Naiwny `UPDATE jobs SET run_on_wake = 1` wstawiony do `migrate()` "naprawia" istniejące rekordy.
- Problem niewidoczny w testach jednego startu: po pierwszym backfillu wszystko wygląda OK.
- Cicha regresja: każde ręczne wyłączenie flagi przez usera (`run_on_wake=0`) zostaje **co noc** nadpisane z powrotem na `1`. Brak błędu, brak crasha — tylko niespodziewanie reaktywowane joby po porannym restarcie VPS.

## Root Cause

`migrate()` jest wołany z **każdego** `getDb()`, nie tylko przy pierwszej inicjalizacji bazy. Migracje schematu (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN` w guardzie `PRAGMA table_info`) są naturalnie idempotentne, więc bezpiecznie powtarzają się przy każdym starcie. Ale bare `UPDATE` na danych NIE jest jednorazowy — wykonuje się przy każdym boocie i kasuje świadome decyzje usera podjęte po backfillu.

## Rozwiązanie

Backfill danych chroń flagą jednorazową w tabeli `state` (sentinel), żeby `UPDATE` wykonał się dokładnie raz w całym życiu bazy:

```javascript
function migrate(db) {
  // ... CREATE TABLE IF NOT EXISTS + ALTER TABLE guards (idempotentne) ...

  // Backfill danych — NIE idempotentny sam z siebie, więc guard flagą w state.
  const backfillDone = db
    .prepare("SELECT value FROM state WHERE key = 'wake_backfill_done'")
    .get();
  if (!backfillDone) {
    db.prepare('UPDATE jobs SET run_on_wake = 1').run();
    db.prepare(
      "INSERT OR REPLACE INTO state (key, value) VALUES ('wake_backfill_done', '1')"
    ).run();
  }
}
```

Dwie pułapki przy implementacji:

1. **Używaj przekazanego `db`, nie helperów `getState/setState`.** Te helpery wołają `getDb()`, a w trakcie `migrate()` globalne połączenie nie jest jeszcze przypisane (`migrate` odpala się wewnątrz `getDb()` PRZED `db = ...`). Czytaj/pisz flagę bezpośrednio `db.prepare(...)`.
2. **Schema `DEFAULT 1` to tylko nowe wiersze.** `CREATE TABLE IF NOT EXISTS` nie przebuduje istniejącej tabeli; zmiana `DEFAULT` w DDL nie dotyka już-istniejących wierszy. Backfill (UPDATE) jest jedynym mechanizmem migrującym stare dane, a `createJob` musi jawnie przekazać nowy default dla nowych jobów.

## Komendy diagnostyczne

```bash
# Czy backfill już się odpalił (flaga powinna istnieć po 1. starcie)
sqlite3 data/cron.db "SELECT * FROM state WHERE key = 'wake_backfill_done';"

# Czy jakiś opt-out został clobberowany (po restarcie wszystko = 1 = podejrzane)
sqlite3 data/cron.db "SELECT id, name, run_on_wake FROM jobs;"

# Test regresji: dwa wywołania migrate() na tym samym połączeniu nie nadpisują ręcznego 0
node --test lib/db.test.js
```

## Zapobieganie

- W `migrate()` rozróżniaj **migracje schematu** (idempotentne z natury — `IF NOT EXISTS`, guard `PRAGMA table_info`) od **backfillów danych** (NIE idempotentne — zawsze guard flagą w `state`).
- Każdy `UPDATE`/`DELETE` danych w ścieżce bootowej = pytanie "co się stanie przy 100. restarcie?". Jeśli kasuje stan usera — owiń sentinelem.
- Test regresji: wywołaj `migrate(conn)` dwa razy na tym samym połączeniu po ręcznym ustawieniu `0` i asercjuj, że drugie wywołanie NIE przywraca `1`.

## Powiązane

- `docs/solutions/performance-issues/2026-06-23-per-job-recent-runs-window-function.md` — inny przypadek cichej regresji w warstwie SQLite (granica doby/grupy bez błędu).

## Kontekst

claude-cron (scheduler jobów na VPS, restart serwisu codziennie ~06:00 CEST). Stack: czysty Node.js CommonJS + node:sqlite, bez ORM/bundlera. Walidacja `node --test` (108/108 PASS po fazie 4), brak typecheck/lint w stacku. Pochodzi z zadania `nocny-restart-przegapione-joby`, decyzja techniczna #1 w kontekście fazy 1.
