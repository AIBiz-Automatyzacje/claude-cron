---
title: "Statystyki „Dziś” w SQLite — goły date('now') liczy w UTC i przesuwa granicę doby"
date: 2026-06-23
category: performance-issues
severity: high
stack:
  - SQLite
  - Node.js
tags:
  - sqlite-localtime
  - timezone
  - query-design
status: verified
last_verified: 2026-06-23
klasa: "wartosc-graniczna"
regula: "Porównania „dziś/wczoraj” w SQLite rób przez `date(kolumna,'localtime') = date('now','localtime')`, nie goły `date('now')`. Goły `date('now')` liczy w UTC i przesuwa granicę doby o offset strefy."
paths:
  - "lib/**"
waga: "wysoka"
szczebel: "regula"
szczebel_powod: "konwersja learned-patterns: regula tekstowa sprzed P10, bez bramki mechanicznej"
zrodlo: "learned-patterns (konwersja 2026-11-02)"
ucieczki: 0
---

# Statystyki „Dziś” w SQLite — granica doby w UTC zamiast lokalnej

Wydzielone z [N ostatnich runów per job](2026-06-23-per-job-recent-runs-window-function.md) — oba problemy
wyszły w tej samej pracy, ale to osobne reguły.

## Symptomy

- Statystyki „Dziś” (today_success / today_failed) przeskakują o złą godzinę — liczba
  resetuje się ok. 1:00–2:00 czasu lokalnego (PL) zamiast o północy.

## Root Cause

**Granica doby w UTC zamiast lokalnej.** `date(started_at) = date('now')` w SQLite liczy obie
daty w UTC. Dla PL (UTC+1/+2) granica „dziś” jest przesunięta o 1–2 h — przeskok następuje
o 1:00/2:00 lokalnego, nie o północy.

## Rozwiązanie

Granica „dziś” liczona w czasie lokalnym po obu stronach porównania:

```javascript
function getTodayRunStats() {
  const row = getDb().prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) AS success,
      COALESCE(SUM(CASE WHEN status IN ('failed','timeout','killed') THEN 1 ELSE 0 END), 0) AS failed
    FROM runs
    WHERE started_at IS NOT NULL
      AND date(started_at, 'localtime') = date('now', 'localtime')
  `).get();
  return { success: row.success, failed: row.failed };
}
```

## Zapobieganie

- Każde porównanie dat „dziś/wczoraj” w SQLite — `date(kolumna,'localtime') = date('now','localtime')`.
  Goły `date('now')` to UTC i cicho przesuwa granicę doby.

## Powiązane

- `lib/db.js` — `getTodayRunStats`
- `lib/db.test.js` — test „run tuż po północy lokalnej liczony jako dziś (regresja UTC)”
- `server.js` — `/api/status`
