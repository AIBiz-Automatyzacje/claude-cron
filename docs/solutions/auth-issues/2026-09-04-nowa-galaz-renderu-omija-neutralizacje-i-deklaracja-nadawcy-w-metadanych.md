---
title: "Druga iteracja tej samej klasy: nowa gałąź renderu omija neutralizację, a deklaracja nadawcy trafia do metadanych"
date: 2026-09-04
category: auth-issues
severity: critical
stack:
  - Node.js
  - SQLite
  - Obsidian
tags:
  - prompt-injection
  - niezaufane-wejscie
  - render-parser
  - review-bota
  - team-os
status: verified
last_verified: 2026-09-04
---

# Nowa gałąź renderu omija istniejącą obronę; deklaracja nadawcy awansuje do roli sterującej

Materiał: uwagi bota w PR `zalaczniki-w-skrzynce` **po** naszym własnym multi-agent review fazy.
Obie uwagi to DRUGA iteracja klasy opisanej w
`docs/solutions/auth-issues/2026-09-03-tresc-nadawcy-jako-akcja-uprawnienie-i-kod-w-skrzynce.md` —
obrona istniała i była udokumentowana, a mimo to dwa nowe miejsca ją ominęły w tym samym PR.

## Symptomy

- `scripts/inbox/inbox-pull.mjs:203` — w `renderMessage` gałąź `Źródło:` zwracała treść nadawcy
  **z pominięciem `neutralizeContentLine`**. Nadawca wpisywał w treść wiadomości linię
  `Źródło: <podstawiony %% id:… thread:… %>` i wstrzykiwał własny marker do calloutu.
  `parseCheckedCallouts` w `inbox-push.mjs` bierze **pierwsze** dopasowanie markera w bloku,
  więc odhaczenie checkboxa przez człowieka domykało **cudzy wątek**.
- `lib/inbox-api.js:255` — `size_bytes` zapisywany do `inbox_attachments` brany z **deklaracji**
  nadawcy, choć bajty leżały już na dysku huba. Fałszywa deklaracja sprawiała, że poprawnie
  pobrany plik NIGDY nie zaliczał się jako pobrany: `defaultIsDownloaded` w `inbox-pull.mjs`
  porównuje rozmiar pliku na dysku z metadanymi, więc checkbox „Pobierz" wracał w nieskończoność.

## Root Cause

Obrona przed treścią nadawcy była wpięta w **jedno wejście** renderu (`neutralizeContentLine`
w mapie linii), a nowa gałąź z wczesnym zwrotem (`return src ? … : neutralize…`) ominęła je
składniowo, nie semantycznie — nikt nie usunął obrony, po prostu obok niej powstała ścieżka.
Symetrycznie: pole `size_bytes` było w tym PR polem **opisowym** (wczesna odmowa przed
transferem), a nowy kod odbiorcy uczynił je polem **sterującym** (warunek stanu „pobrany"),
podczas gdy bramka źródła wartości została przy starej roli.

## Rozwiązanie

Zawężenie gałęzi do kontekstu, w którym w ogóle może istnieć, **plus** neutralizacja także jej
wartości (obrona nie może zależeć od poprawności zawężenia):

```js
// gałąź „Źródło:" należy do renderu auto-odpowiedzi, dla wiadomości człowieka nie istnieje
const src = auto ? l.match(/^Źródło:\s*(.+)$/) : null;
return src ? `<span class="os-src">📄 ${neutralizeContentLine(src[1])}</span>`
           : neutralizeContentLine(l);
```

Wartość sterująca wyprowadzona z artefaktu, nie z deklaracji:

```js
const actualSize = blobs.blobSize(sha256);          // stat pliku, który hub JUŻ ma
if (actualSize === null || !inboxDb.isBlobUploader(sha256, member.name)) {
  return { error: 'unknown_attachment' };
}
items.push({ sha256, filename, size_bytes: actualSize, mime: mime ?? null });
```

## Komendy diagnostyczne

```bash
# gałęzie renderu, które omijają neutralizację (early return przed mapą linii)
grep -n "return .*\`<span" scripts/inbox/inbox-pull.mjs | grep -v neutralizeContentLine

# pola z payloadu nadawcy zapisywane wprost do metadanych
grep -n "items.push\|addAttachments(" lib/inbox-api.js lib/inbox-db.js
```

## Zapobieganie

- Obrona per-linia = **jedno wyjście**: każda gałąź renderu kończy się przejściem przez
  neutralizator. Jeśli gałąź musi zwrócić inny kształt HTML, neutralizuj jej **wartość**,
  nie tylko pozostałe linie.
- Przy każdym nowym polu w metadanych pytaj: **czy jakikolwiek konsument robi z niego warunek?**
  Jeśli tak, wartość musi pochodzić z artefaktu po naszej stronie (`stat`, `sha256`, ślad wgrania),
  a deklaracja nadawcy zostaje wyłącznie wczesną odmową.
- Test odmowy per wektor na PRAWDZIWEJ ścieżce render → parser (patrz `inbox-pull.test.mjs`),
  nie na atrapie danych: atrapa fabrykuje pola, których produkcja nie produkuje.

## Powiązane

- `docs/solutions/auth-issues/2026-09-03-tresc-nadawcy-jako-akcja-uprawnienie-i-kod-w-skrzynce.md`
  — pierwsza iteracja tej klasy (ten sam plik, ten sam roundtrip).
- `docs/solutions/auth-issues/2026-07-26-sekret-w-drzewie-czytanym-przez-agenta-eksfiltracja-prompt-injection.md`

## Kontekst

Znalezione przez bota PR w turze 1, PO przejściu naszego multi-agent review fazy 4 zadania
`zalaczniki-w-skrzynce`. Nasze review sprawdzało obronę tam, gdzie ją dokumentowaliśmy —
nie sprawdziło, czy **każda nowa gałąź** tej samej funkcji też przez nią przechodzi.
