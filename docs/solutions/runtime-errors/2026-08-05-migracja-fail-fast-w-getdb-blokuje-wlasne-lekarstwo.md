---
title: "Migracja z fail-fast na DANYCH w ścieżce otwarcia połączenia ubija całą aplikację razem z lekarstwem"
date: 2026-08-05
category: runtime-errors
severity: high
stack:
  - Node.js
  - node:sqlite
tags:
  - migracje
  - sqlite
  - fail-fast
  - degradacja
  - collate-nocase
  - team-os
status: verified
last_verified: 2026-08-05
---

# Migracja z fail-fast na DANYCH w ścieżce otwarcia połączenia ubija całą aplikację razem z lekarstwem

## Symptomy

- Po deployu Fazy 1 (`members.name` → `COLLATE NOCASE`) hub skrzynki Team OS zwracał **500 na
  KAŻDYM** żądaniu `/inbox/v1/:token/*` i `/api/inbox/members`, jeśli w bazie istniała para nazw
  różniących się wyłącznie wielkością liter (`"Cave"` + `"cave"`).
- W logu daemona jeden komunikat: `migrate: nie mogę włączyć COLLATE NOCASE na members.name …`.
- Kluczowy objaw: **naprawa była nieosiągalna z aplikacji**. Zduplikowanego członka kasuje się
  przez `listMembers`/`revokeMember` (dashboard → Skrzynka → Członkowie), a te też wołają
  `getInboxDb()` → `migrate()` → ten sam rzut. Jedyne wyjście: ręczny `sqlite3` na VPS-ie.

## Root Cause

`migrate()` biegnie w `getInboxDb()` przy **każdej** operacji (leniwe otwarcie połączenia,
`inboxDb` przypisywany dopiero po udanej migracji — patrz `lib/inbox-db.js:44`). Migracja
`rebuildMembersWithNocase` robi fail-fast na **stanie danych**, a nie na stanie schematu:
kolizja nazw nie może być cicho scalona, bo oddałaby cudze wiadomości nie tej osobie. Rzut z tak
umiejscowionej migracji nie jest „awarią jednej ścieżki" — jest awarią **całego procesu**,
włącznie z endpointami, które ten stan naprawiają. Fail-fast na schemacie (zły build runtime,
brak kolumny) jest poprawny, bo nic w aplikacji tego nie naprawi; fail-fast na danych jest
pułapką, bo naprawa siedzi po tej samej stronie bariery.

## Rozwiązanie

Degradacja zamiast rzutu: zostaw schemat legacy, wykrzycz do człowieka **wykonywalny** komunikat,
leć dalej — a niezmiennik bezpieczeństwa utrzymaj w warstwie logiki, nie w migracji.

```js
// lib/inbox-db.js
function migrate(db, warn = console.warn) {
  db.exec(/* CREATE TABLE IF NOT EXISTS … */);
  if (needsMembersNocaseRebuild(db)) tryRebuildMembersWithNocase(db, warn);
}

// Kolizja nazw NIE MOŻE zabić huba. migrate() biegnie w getInboxDb() przy KAŻDEJ operacji,
// więc rzut stąd czynił martwym także LEKARSTWO (listMembers/revokeMember, /api/inbox/members).
function tryRebuildMembersWithNocase(db, warn = console.warn) {
  try {
    rebuildMembersWithNocase(db);
  } catch (err) {
    // Wąski catch: łapiemy WYŁĄCZNIE znany, odwracalny przez usera stan danych.
    if (!(err instanceof InboxDbError) || err.code !== 'members_nocase_collision') throw err;
    warn(`[inbox-db] ${err.message}`);
  }
}
```

Trzy warunki, bez których ta degradacja byłaby zamiataniem błędu pod dywan:

1. **Niezmiennik bezpieczeństwa trzyma warstwa logiki, nie migracja.** `resolveRecipient()`
   dopasowuje adresata case-insensitive w JS i przy wielu trafieniach rzuca
   `ambiguous_recipient` → 400. Kolidująca para jest zablokowana; reszta zespołu pracuje
   normalnie. Migracja była *optymalizacją* wymuszenia (kolacja na indeksie UNIQUE), nie
   jedynym miejscem gwarancji.
2. **Catch jest wąski i typowany.** Tylko `InboxDbError` z `code === 'members_nocase_collision'`.
   Każdy inny błąd (uszkodzona baza, pad DDL) leci dalej i nadal jest fail-fast.
3. **Komunikat jest instrukcją, nie diagnozą.** Adresat to człowiek czytający log daemona przez
   SSH, więc podaje obie kolidujące nazwy, skutek („wysyłka do tych nazw odrzucana"),
   dwie drogi wyjścia (dashboard albo gotowe `sqlite3 …`) i warunek domknięcia
   (restart Pulsa → migracja dokończy się sama).

Guard idempotencji czytany z **faktycznego DDL**, nie z sentinela — `migrate()` leci co boot,
a `PRAGMA table_info` nie zdradza kolacji:

```js
function needsMembersNocaseRebuild(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='members'").get();
  if (!row || !row.sql) return false; // tabeli brak — CREATE wyżej zakłada ją już z NOCASE
  return !/COLLATE\s+NOCASE/i.test(row.sql);
}
```

## Komendy diagnostyczne

```bash
# Czy tabela ma już kolację (PRAGMA table_info jej NIE pokaże)
sqlite3 data/inbox.db "SELECT sql FROM sqlite_master WHERE type='table' AND name='members';"

# Kolidujące nazwy członków
sqlite3 data/inbox.db "SELECT id, name FROM members ORDER BY lower(name);"

# Czy hub żyje mimo nierozstrzygniętej kolizji
curl -s https://<funnel>/inbox/v1/<token>/ping

# Log degradacji na VPS
journalctl -u claude-cron -n 200 | grep '\[inbox-db\]'
```

## Zapobieganie

- Zanim napiszesz `throw` w migracji, odpowiedz: **czy naprawa tego stanu jest osiągalna przez
  kod, który ten rzut właśnie zablokował?** Jeśli tak — degraduj i ostrzegaj.
- Rozdziel w migracjach dwa rodzaje niepowodzeń: **schemat/runtime** (fail-fast — user i tak nic
  nie zrobi z poziomu aplikacji) i **dane** (degradacja + głośny warn — user ma to naprawić).
- Utrzymuj niezmiennik bezpieczeństwa w warstwie logiki. Wtedy migracja wzmacniająca ten sam
  niezmiennik może bezpiecznie odpuścić.
- Test odtwarza **prawdziwą ścieżkę** (`getInboxDb()` na bazie z zaszczepioną kolizją), nie samą
  `migrate()` — asercja brzmi „hub odpowiada i `revokeMember` działa", nie „`migrate()` rzuciło".
- Guard idempotencji rebuilda czytaj z `sqlite_master.sql`; sentinel w `state` rozjedzie się z
  rzeczywistością po ręcznej interwencji operatora, a `PRAGMA table_info` nie zna kolacji.

## Powiązane

- [docs/solutions/runtime-errors/2026-06-27-backfill-w-migrate-clobberuje-opt-outy.md](2026-06-27-backfill-w-migrate-clobberuje-opt-outy.md)
  — druga strona tej samej monety: `migrate()` biegnie co boot, więc gołe `UPDATE` clobberuje
  decyzje usera. Tam problemem jest *zbyt dużo* działania, tu *zbyt twarde* zatrzymanie.
- [docs/solutions/runtime-errors/2026-06-29-migracja-better-sqlite3-na-node-sqlite.md](2026-06-29-migracja-better-sqlite3-na-node-sqlite.md)
  — smoke-test typów agregatów w tej samej ścieżce `getInboxDb()`; to przykład rzutu, który
  fail-fastować MUSI (niekompatybilny build Node).
- Plan: `docs/plans/2026-08-05-001-fix-team-os-naprawy-po-testach-plan.md` (U2), review Fazy 1:
  `docs/active/naprawy-team-os/review-faza-1.md`.

## Kontekst

Puls / Team OS, hub skrzynki na VPS-ie (`lib/inbox-db.js`, `data/inbox.db` osobna od
`data/claude-cron.db`). Node 22.17 (`node:sqlite`, `DatabaseSync`). Znalezione w review Fazy 1
zadania `naprawy-team-os`, naprawione w `dfab2f1`. SQLite nie zmienia kolacji kolumny przez
`ALTER` — jedyna droga to przepisanie tabeli, stąd w ogóle rebuild z ryzykiem kolizji.
