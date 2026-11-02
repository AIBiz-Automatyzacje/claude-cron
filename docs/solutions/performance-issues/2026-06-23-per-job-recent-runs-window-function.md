---
title: "N ostatnich runów per job — flat-limit gubi joby o wysokiej kadencji, użyj ROW_NUMBER"
date: 2026-06-23
category: performance-issues
severity: high
stack:
  - SQLite
  - better-sqlite3
  - Node.js
tags:
  - window-functions
  - row-number
  - per-partition-limit
  - query-design
status: verified
last_verified: 2026-06-23
klasa: "cache-i-zapytania"
regula: "N ostatnich rekordów na każdą grupę (job, user, kategoria) wybieraj przez `ROW_NUMBER() OVER (PARTITION BY grupa ORDER BY id DESC)` z filtrem `rn <= N`, nie globalnym `ORDER BY id DESC LIMIT N`. Flat LIMIT cicho gubi grupy, bo jedna grupa o wysokiej kadencji zjada całe okno."
paths:
  - "lib/**"
waga: "wysoka"
szczebel: "regula"
szczebel_powod: "konwersja learned-patterns: regula tekstowa sprzed P10, bez bramki mechanicznej"
zrodlo: "learned-patterns (konwersja 2026-11-02)"
ucieczki: 0
---

# N ostatnich runów per job — flat-limit gubi joby, użyj window function

## Symptomy

- Sparkline / „ostatni run" per job w UI pokazuje pełną historię tylko dla jednego-dwóch jobów,
  a pozostałe joby są puste lub mają 0–1 punktów — mimo że w bazie mają dziesiątki runów.
- Job o wysokiej kadencji (cron `*/1`, czyli co minutę) „zjada" całe okno wyników:
  przy `SELECT * FROM runs ORDER BY id DESC LIMIT 50` ostatnie 50 rekordów należy
  w praktyce w całości do tego jednego joba.

## Root Cause

**Flat-limit zamiast limitu per-partycja.** `ORDER BY id DESC LIMIT N` zwraca N najnowszych
runów w całej tabeli, nie N runów *na każdy job*. Job z dużą częstotliwością dominuje globalne
okno i wypycha runy innych jobów poza limit.

Granica doby w UTC (statystyki „Dziś”) wyszła w tej samej pracy — osobny wpis:
[2026-06-23-sqlite-granica-doby-localtime.md](2026-06-23-sqlite-granica-doby-localtime.md).

## Rozwiązanie

Per-partycja: `ROW_NUMBER() OVER (PARTITION BY job_id ORDER BY id DESC)` i filtr `rn <= N`.
Jeden round-trip do bazy zamiast N+1 (pętla z osobnym query per job).

```javascript
const RECENT_RUNS_DEFAULT = 7;
const RECENT_RUNS_CAP = 50;

// Dokładnie N ostatnich runów per job — niezależnie od kadencji jobów.
function getRecentRunsPerJob(perJob = RECENT_RUNS_DEFAULT) {
  const parsed = parseInt(perJob, 10);
  let limit = Number.isInteger(parsed) && parsed > 0 ? parsed : RECENT_RUNS_DEFAULT;
  if (limit > RECENT_RUNS_CAP) limit = RECENT_RUNS_CAP; // normalizacja inputu

  return getDb().prepare(`
    SELECT * FROM (
      SELECT r.*, ROW_NUMBER() OVER (PARTITION BY job_id ORDER BY id DESC) AS rn
      FROM runs r
    ) WHERE rn <= ?
    ORDER BY job_id ASC, id DESC
  `).all(limit);
}
```

Uwaga dot. routingu (powiązany efekt uboczny): nowy endpoint `GET /api/runs/recent` musi być
matchowany PRZED ogólnym matcherem `segments[1] === 'runs'`, inaczej ogólny handler `/api/runs`
go przechwyci. Kolejność if-ów w routerze jest tu kontraktem.

## Komendy diagnostyczne

```bash
# better-sqlite3 wspiera window functions od SQLite 3.25 — sprawdź wersję wbudowaną
node -e "console.log(require('better-sqlite3')(':memory:').prepare('SELECT sqlite_version() v').get())"

# Reprodukcja flat-limit: wstaw 60 runów jobowi A i po 3 jobom B,C → flat LIMIT 50 gubi B,C
node --test lib/db.test.js
```

## Zapobieganie

- Gdy potrzebujesz „top N per grupa" (per job, per user, per kategoria) — ZAWSZE
  `ROW_NUMBER() OVER (PARTITION BY ...)` + filtr `rn <= N`, nigdy globalny `LIMIT N`.
- Per-job/per-grupa zapytanie w pętli = N+1. Jedno zapytanie z window function = 1 round-trip.
- Waliduj parametr limitu (parseInt + dolny i górny cap) zanim trafi do query.

## Powiązane

- `lib/db.js` — `getRecentRunsPerJob`
- `lib/db.test.js` — test flat-limit regression
- `server.js` — route `GET /api/runs/recent` (kolejność przed `/api/runs`)

## Kontekst

Migracja claude-cron → Puls (`feature/migracja-puls-rebrand`, Faza 1, Unit 2–3).
Node v22, better-sqlite3 ^12 (window functions zweryfikowane lokalnie), scheduler croner ^10.
`failed` w statystykach agreguje też `timeout`/`killed` (jedyne nie-success statusy zakończenia
wg `lib/executor.js`) — inaczej statbar zaniżałby liczbę niepowodzeń.
