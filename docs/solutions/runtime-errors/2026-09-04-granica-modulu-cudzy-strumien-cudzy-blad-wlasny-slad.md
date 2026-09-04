---
title: "Granica modułu: kto co sprząta — for await niszczy cudzy strumień, catch-all myli brak z awarią, retencja gubi własny ślad"
date: 2026-09-04
category: runtime-errors
severity: high
stack:
  - Node.js
  - node:sqlite
tags:
  - streams
  - fs
  - retencja
  - kontrakt-modulu
  - review-bota
status: verified
last_verified: 2026-09-04
---

# Trzy błędy sprzątania na granicy modułu

Materiał: uwagi bota PR `zalaczniki-w-skrzynce` (tury 1–2), znalezione PO naszym review.
Wspólny mianownik: moduł źle rozstrzygnął, **co należy do niego, a co do wołającego**.

## Symptomy

1. **Sprząta cudze.** `writeBlobFromStream` czytał `for await (const chunk of stream)`. Domyślny
   iterator `Readable` ma `destroyOnReturn: true`, więc wyjście z pętli przez `throw`
   (limit 25 MB, rozjazd sha) **niszczyło strumień wołającego**. W produkcji tym strumieniem
   jest `req` serwera: zniszczone żądanie pomija drenaż ciała, a odmowa 413/400 leci w gniazdo,
   które klient dostaje jako RST — nadawca widzi „fetch failed" zamiast powodu. Łamało to wprost
   udokumentowany kontrakt „odmowa binarna PO drenażu ciała".
2. **Połyka cudzy błąd.** `blobSize` mapował KAŻDY błąd `fs.statSync` na `null`, a warstwa wyżej
   czyta `null` jako `unknown_attachment` (400). Awaria magazynu huba (EACCES/EIO) wracała do
   nadawcy jako „nie ma takiego załącznika" — nadawca porzucał poprawny plik, operator nie
   dostawał żadnego alarmu. Bliźniak `deleteBlob` w TYM SAMYM module rozróżniał ENOENT od reszty:
   odstępstwo od własnej konwencji modułu.
3. **Nie sprząta swojego.** Po skasowaniu bajtów-sierot retencja nie kasowała wierszy
   `inbox_blob_uploads`. `computeOrphanedBlobs` czyta WYŁĄCZNIE tę tabelę, więc ten sam hash
   wracał w każdym tiku co godzinę **na zawsze**, a tabela rosła bez sufitu. Kilkanaście linii
   wyżej ta sama funkcja stawiała znacznik dla gałęzi `missing` — reguła nie została dociągnięta
   do gałęzi sierot.

## Root Cause

Cukier składniowy (`for await`) i skrót defensywny (`catch → null`) cicho przesuwają granicę
odpowiedzialności: pierwszy przejmuje cykl życia zasobu, którego moduł nie stworzył, drugi
zrównuje „normalny brak" z „awarią infrastruktury". Trzeci przypadek to ta sama klasa, co uwaga
o gałęzi renderu z tego PR: reguła postawiona w jednej gałęzi, sąsiednia jej nie ma.

## Rozwiązanie

```js
// 1. cykl życia strumienia należy do wołającego
const source = typeof stream.iterator === 'function'
  ? stream.iterator({ destroyOnReturn: false })
  : stream;
for await (const chunk of source) { /* … */ }

// 2. null WYŁĄCZNIE dla ENOENT; awaria magazynu leci typowanym błędem (→ 500)
function blobSize(sha256) {
  try { return fs.statSync(blobPath(sha256)).size; }
  catch (err) {
    if (err instanceof InboxBlobError) throw err;
    if (err.code === 'ENOENT') return null;
    throw new InboxBlobError(`nie udało się odczytać rozmiaru bloba: ${err.message}`, 'store_failed');
  }
}

// 3. stan docelowy osiągnięty ('deleted' i 'missing') → kasuj ślad; po 'failed' zostaw
const outcome = deleteBlobSafely(sha, blobs, warn);
if (outcome !== 'failed') db.deleteBlobUploads(sha);
```

## Komendy diagnostyczne

```bash
# for await na strumieniu, którego moduł nie stworzył
grep -rn "for await (const .* of \(req\|stream\))" lib scripts

# catch-all mapujący każdy błąd fs na wartość „brak"
grep -rn -A3 "fs.statSync\|fs.readFileSync" lib | grep -n "return null"

# praca okresowa: czy każda gałąź kończy się zapisem stanu docelowego
grep -n "deleteBlobUploads\|markSwept" lib/inbox-retention.js
```

## Zapobieganie

- Zasób przekazany z zewnątrz zamyka ten, kto go otworzył. W Node: `stream.iterator({ destroyOnReturn: false })`
  wszędzie, gdzie z pętli można wyjść przez `throw`/`break`, a strumieniem jest `req`.
- W `catch` na I/O rozróżniaj kod błędu **zawsze**: „nie ma" i „nie mogę sprawdzić" to dwie różne
  odpowiedzi HTTP (4xx vs 5xx). Wzorzec bierz z bliźniaczej funkcji w tym samym module.
- Zadanie okresowe: po każdej gałęzi pytaj „czy następny tik zobaczy ten rekord ponownie?".
  Jeśli tak, a stan docelowy jest już osiągnięty — brakuje kasowania śladu.

## Powiązane

- `docs/solutions/runtime-errors/2026-07-14-close-nie-odpala-wnuk-dziedziczy-pipe-wyciek-slotu.md`
- `docs/solutions/runtime-errors/2026-08-05-migracja-fail-fast-w-getdb-blokuje-wlasne-lekarstwo.md`
- `docs/solutions/auth-issues/2026-09-04-nowa-galaz-renderu-omija-neutralizacje-i-deklaracja-nadawcy-w-metadanych.md`

## Kontekst

Wszystkie trzy uwagi pochodzą od bota PR, żadnej nie zgłosiło nasze review fazy: testy
jednostkowe przechodziły, bo atrapy strumieni w testach nie mają `req`-owej semantyki drenażu,
a test retencji sprawdzał liczbę skasowanych bajtów, nie stan tabeli po drugim tiku.
