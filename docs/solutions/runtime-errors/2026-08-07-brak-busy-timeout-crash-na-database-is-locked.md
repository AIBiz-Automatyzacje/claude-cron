---
title: "node:sqlite bez PRAGMA busy_timeout — rywalizacja o zapis to natychmiastowy crash, nie czekanie"
date: 2026-08-07
category: runtime-errors
severity: high
stack:
  - Node.js
  - node:sqlite
tags:
  - sqlite
  - busy-timeout
  - database-is-locked
  - wal
  - concurrency
status: verified
last_verified: 2026-08-07
---

# `database is locked` zabija proces, zanim detekcja intruza zdąży go zgłosić

## Symptomy

- Drugi proces `server.js` na tej samej bazie pada po ~minucie z nieobsłużonym wyjątkiem:

```
Error: database is locked
    at Object.createRun (lib/db.js:328) …
  code: 'ERR_SQLITE_ERROR', errcode: 5
```

- Detekcja drugiego schedulera (odcisk w state per heartbeat) **nie zdążyła** wypisać 🔴 —
  intruz umarł na locku przed własnym tyknięciem
- Ta sama mina czeka WŁAŚCIWEGO daemona: dowolny drugi pisarz (narzędzie CLI na żywej bazie,
  zabłąkany proces) może ubić produkcyjny scheduler jednym trafieniem w okno blokady

## Root Cause

`node:sqlite` (`DatabaseSync`) domyślnie ma `busy_timeout = 0`: każde trafienie w blokadę
zapisu (nawet mikrosekundowe okno commitu WAL drugiego połączenia) zwraca natychmiast
`SQLITE_BUSY` → `ERR_SQLITE_ERROR` → wyjątek, który poza try/catch zabija proces. WAL ogranicza
blokady, ale ich nie eliminuje — dwa piszące połączenia zawsze mogą się zderzyć.

## Rozwiązanie

Commit `116d9a5` — pragma przy otwieraniu KAŻDEGO połączenia (obie bazy: `db.js` i `inbox-db.js`):

```js
db = new DatabaseSync(target);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000'); // czekaj do 5 s zamiast crashować; potem błąd wraca
```

Test kontraktu (w obu suitach):

```js
assert.equal(conn.prepare('PRAGMA busy_timeout').get().timeout, 5000);
```

Weryfikacja behawioralna na żywo: retest N4 — drugi proces przeżył pełne 150 s równoległej
pracy i **zdążył** wypisać `🔴 DRUGI scheduler pisze do tej samej bazy…` co tyknięcie heartbeatu.

## Komendy diagnostyczne

```bash
# Czy połączenie ma ustawiony timeout:
node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('data/claude-cron.db');console.log(d.prepare('PRAGMA busy_timeout').get())"
```

## Zapobieganie

- `PRAGMA busy_timeout` ustawiaj ZAWSZE tuż po otwarciu połączenia, obok WAL —
  traktuj trójkę WAL + foreign_keys + busy_timeout jako komplet
- Pamiętaj, że dotyczy to też skryptów pomocniczych otwierających żywą bazę do zapisu

## Powiązane

- Detekcja drugiego schedulera (odcisk per heartbeat): CLAUDE.md, sekcja scheduler
- Pułapki node:sqlite (BigInt, okno wersji): `2026-06-29-migracja-better-sqlite3-na-node-sqlite.md`

## Kontekst

Wykryte testem N4 rundy końcowej Team OS (07.08.2026) na Macu: drugi proces odpalony celowo
na porcie 7778 miał dowieść detekcji intruza, a zamiast tego obnażył brak `busy_timeout`.
