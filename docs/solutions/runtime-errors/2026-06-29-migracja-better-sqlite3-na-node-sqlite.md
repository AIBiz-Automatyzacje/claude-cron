---
title: "Migracja better-sqlite3 → node:sqlite — okno wersji, brak .pragma(), ryzyko BigInt"
date: 2026-06-29
category: runtime-errors
severity: high
stack:
  - Node.js
  - node:sqlite
  - SQLite
tags:
  - node-sqlite
  - better-sqlite3
  - migracja
  - runtime-guard
  - native-modules
  - bigint
  - engines
status: verified
last_verified: 2026-06-29
---

# Migracja better-sqlite3 → node:sqlite

Wymiana natywnie kompilowanego `better-sqlite3` na wbudowany `node:sqlite`, by
wyeliminować kompilację natywną przy instalacji (build-essential/python3/VS Build
Tools). Migracja sama w sobie jest mała (kilka linii w `lib/db.js`), ale ma trzy
nieoczywiste pułapki runtime, które cicho psują aplikację albo dają kryptyczne
błędy na złym runtime.

## Symptomy

- **Kryptyczny import na starym Node:** `lib/db.js` robi top-level
  `require('node:sqlite')`. Na Node < 22.13 (lub bez flagi) leci nieczytelny
  `ERR_UNKNOWN_BUILTIN_MODULE` / błąd ładowania modułu — bez wskazówki, że chodzi
  o wersję runtime.
- **Hałas w logach 24/7:** `node:sqlite` jest oznaczony jako eksperymentalny —
  każdy start wypluwa `ExperimentalWarning` na stderr.
- **Ciche złe typy (najgroźniejsze):** niektóre buildy/wersje `node:sqlite`
  zwracają agregaty (`COUNT(*)`, `SUM(...)`) jako `BigInt` lub string zamiast
  `number`. Cała arytmetyka i `JSON.stringify` w aplikacji psuje się bez
  rzuconego wyjątku — bug ujawnia się dopiero w danych wyjściowych.
- **Restart na zbyt nowym Node:** automatyka (cron na VPS) restartująca serwis po
  `git pull` może wepchnąć serwis na Node 25+, który `runtime-guard` ubije
  `exit(1)` — usługa wpada w pętlę padów.

## Root Cause

1. **Okno wersji to `>=22.13 <25`, NIE `>=22.5`.** Bezflagowy
   `require('node:sqlite')` działa dopiero od **22.13.0**; 22.5–22.12 wymaga
   `--experimental-sqlite`, a część buildów 22.5.0 jest zepsuta (ARM Mac).
   Górna granica `<25` jest świadoma (spójność z `engines` i guardem), nie „dowolnie
   nowy Node".
2. **`node:sqlite` ma inne API niż better-sqlite3:** brak metody `.pragma()` —
   PRAGMA ustawia się przez `db.exec('PRAGMA ...')`. Klasa to `DatabaseSync`, nie
   default export `Database`.
3. **Typy agregatów nie są gwarantowane jako `number`** — zależą od buildu
   runtime, więc nie da się tego złapać statycznie; trzeba smoke-testu na żywym
   połączeniu.

## Rozwiązanie

### 1. Zamiana importu i API w `lib/db.js`

```js
// PRZED
const Database = require('better-sqlite3');
db = new Database(target);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// PO
const { DatabaseSync } = require('node:sqlite');
db = new DatabaseSync(target);
db.exec('PRAGMA journal_mode = WAL'); // brak .pragma() w node:sqlite
db.exec('PRAGMA foreign_keys = ON');
```

`prepare(...).get()/.all()/.run()` zostają bez zmian. `db.transaction()` nie było
używane — sprawdź `grep` przed migracją, bo to inna ścieżka API.

### 2. Smoke-test typów po `migrate()` — fail-fast na BigInt

```js
class DbTypeError extends Error {
  constructor(message) { super(message); this.name = 'DbTypeError'; }
}

// Trywialny agregat MUSI zwrócić number. Inaczej niekompatybilny build runtime.
function assertDbReturnsNumbers(conn) {
  const row = conn.prepare('SELECT COUNT(*) AS n FROM jobs').get();
  if (typeof row.n !== 'number') {
    throw new DbTypeError(
      `node:sqlite zwraca agregat jako "${typeof row.n}" zamiast "number" ` +
      `(COUNT(*) → ${String(row.n)}). Niekompatybilny build Node.`
    );
  }
}
```

Wołany w starcie serwera po `getDb()`/`migrate()`. (`readBigInts: false` jest
defaultem — `node:sqlite` rzuca `ERR_OUT_OF_RANGE` przy INTEGER > 2^53, czyli
bezpieczniej niż b-s3, ale agregaty i tak trzeba zweryfikować na żywo.)

### 3. Runtime-guard jako PIERWSZA linia `server.js`

Guard musi wykonać się **przed** top-level `require('node:sqlite')` w `lib/db.js`,
żeby zamienić kryptyczny błąd importu na akcjonowalny komunikat. Zero zależności od
`node:sqlite`; stałe `MIN/MAX_NODE_VERSION` z `config.js` (single source of truth
spójne z `engines`).

```js
// server.js — pierwsza linia
require('./lib/runtime-guard'); // self-executing enforceNodeVersion()

// runtime-guard.js — efekt fail-fast z DI dla testowalności
function enforceNodeVersion(
  version = process.versions.node,
  { onFail = (msg) => { process.stderr.write(msg + '\n'); process.exit(1); } } = {},
) {
  if (!isNodeSupported(version)) onFail(buildUnsupportedMessage(version));
}
enforceNodeVersion();
```

`isNodeSupported(v, min, max)` sprawdza `v >= min && v < max` (górna granica
wykluczająca). DI `onFail` pozwala przetestować ścieżkę fail-fast bez ubijania
procesu testów.

### 4. Wyciszenie ExperimentalWarning w KAŻDEJ ścieżce startu

`--disable-warning=ExperimentalWarning` w: `package.json` `start`, systemd
`ExecStart`, oraz args `spawn(...)` w hooku autostartu. Inaczej logi 24/7 są
zaśmiecone.

### 5. Spójna górna granica w bash (cron/install)

`is_node_supported` w `install-vps.sh` ORAZ wstrzykiwany cron-node-guard MUSZĄ
sprawdzać górną granicę `<25` (`MAX_NODE_MAJOR`), nie tylko dolny próg. Cron robi
`git pull` zawsze, ale `systemctl restart` tylko po PASS guarda — inaczej serwis
ląduje na Node 25+ i wpada w pętlę `exit(1)` z runtime-guarda.

### 6. Usunięcie build-tools

`build-essential`/`python3` (Linux), VS Build Tools (Win) były tylko pod
`better-sqlite3`. Pozostałe natywne deps: `koffi` ma prebuilt binaria, `pg` jest
czystym JS — można je usunąć z instrukcji instalacji.

## Komendy diagnostyczne

```bash
# Czy node:sqlite działa bezflagowo na tym runtime?
node -e "require('node:sqlite'); console.log('ok', process.versions.node)"

# Czy COUNT(*) wraca jako number czy BigInt? (smoke-test na żywo)
node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(':memory:');d.exec('CREATE TABLE t(x)');console.log(typeof d.prepare('SELECT COUNT(*) n FROM t').get().n)"

# Czy zostały gołe .pragma() po migracji?
grep -rn "\.pragma(" lib/

# Czy zostały transakcje wymagające osobnej obsługi?
grep -rn "\.transaction(" lib/

# Składnia wszystkich plików bez TS/eslint
node --check lib/db.js && node --check lib/runtime-guard.js
```

## Zapobieganie

- **Pinuj `engines` do realnie zweryfikowanego okna**, nie do wersji z pierwszego
  źródła w internecie — `node:sqlite` zmieniał wymagania flagowe między 22.5 a 22.13.
- **Każdy nowy/wbudowany silnik DB = smoke-test typów na żywym połączeniu** —
  statyczne typowanie nie złapie BigInt vs number z natywnego runtime.
- **Guard wersji przed pierwszym top-level importem ryzykownego modułu** — nie po,
  bo import wykona się zanim guard zdąży dać czytelny komunikat.
- **Górna granica wersji musi być spójna we WSZYSTKICH miejscach** (engines, JS
  guard, bash install/cron) — rozjazd = serwis restartowany na wersję, którą sam
  potem ubija.

## Powiązane

- `docs/completed/migracja-puls-rebrand/review-faza-3.md` — finding BigInt/SUM, który
  zmotywował smoke-test typów.
- `.claude/rules/learned-patterns.md` — reguła localtime + backfill guard
  (niezmienne przy migracji silnika DB).

## Kontekst

Projekt `claude-cron` (Puls), czysty CommonJS, bez TypeScript/ESLint. Faza 1–2
planu `ulatwienie-instalacji`. Suite po migracji: 121 → 141 testów PASS (node:test,
`:memory:` przez DI `setDbPath`). Portable Node pinowany do 22.17.0 (stabilny 22.x
LTS w oknie). Zamiast typecheck: `node --check`; brak frontendowego buildu.
