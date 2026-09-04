Branch: `feature/zalaczniki-w-skrzynce`
Data ukończenia: 2026-09-03

# Załączniki w Skrzynce Team OS — podsumowanie

## Co zostało dostarczone

Skrzynka Team OS przenosi teraz pliki, nie tylko tekst. Cztery fazy, wszystkie `execute/review/fix = done`,
suita `node --test` na koniec 1279/1279 PASS (projekt nie ma typecheckera, lintera ani buildu).

- **Faza 1 — magazyn bajtów na hubie (IU-1..3):** tabela `inbox_attachments`, magazyn blobów adresowanych
  treścią ze strumieniowym hashowaniem sha256 (`lib/inbox-blobs.js`), binarne endpointy
  `PUT/GET /inbox/v1/:token/blob/:sha256`.
- **Faza 2 — wysyłka (IU-4..5):** operacje binarne klienta (`uploadBlob`/`downloadBlob`, osobny
  `BINARY_TIMEOUT_MS = 180 s`, zapis przez plik tymczasowy + `rename`), przygotowanie załączników nadawcy
  z progiem 25 MB **przed** transferem (`scripts/inbox/attachments.mjs`), powtarzalna flaga `--attach`
  w `send.mjs`/`reply.mjs`, walidacja `attachments` na granicy API i krótka transakcja
  wiadomość-plus-metadane (R1, R2, R3, R4).
- **Faza 3 — odbiór (IU-6..8):** wiersz załącznika w trzech stanach renderowany bezstanowo przy każdym
  pullu, osobny parser odhaczonych pobrań `parseRequestedDownloads` (nietykający `parseCheckedCallouts`),
  pobranie do `Zasoby/inbox-zalaczniki/RRRR-MM/` z sanityzacją nazwy sprawdzającą EFEKT ścieżki, no-op na
  maszynie w roli `agent`, sekwencja syncu push → pobrania → pull w jednym procesie (R5–R10, R14).
- **Faza 4 — retencja i rewokacja (IU-9..10):** `lib/inbox-retention.js` — czyste funkcje progowe
  `computeExpiredAttachments` (14 dni od domknięcia wątku, twardo 90 dni od wysłania) i
  `computeOrphanedBlobs` (karencja 24 h), nad nimi `sweepInboxRetention` i pętla `startInboxRetention`
  (co godzinę, `unref`) pod guardem `isInboxHub()` liczonym przy KAŻDYM ticku; kaskada R13 w `revokeMember`
  (R11, R13).

**Zero nowych zależności** we wszystkich czterech fazach. R12 (kwoty miejsca per nadawca) wycofane decyzją
operatora — nie ma żadnych sufitów.

## Kluczowe decyzje

- **Adresowanie treścią (sha256) zamiast identyfikatorów** — powtórzone wysłanie tego samego pliku nie
  duplikuje bajtów (`deduped:true`), a rewokacja może liczyć referencje.
- **Pobranie jest akcją WYŁĄCZNIE lokalną** — odhaczenie „Pobierz" niczego nie zgłasza hubowi i nie domyka
  wątku; render jest bezstanowy i regeneracja niczego nie cofa.
- **Rola `agent` nie pobiera nigdy** — katalog załączników jest wykluczony z Obsidian Sync, więc pobieranie
  na maszynie 24/7 dawałoby pliki, których człowiek i tak nie zobaczy, plus klasę awarii znaną z
  `Skrzynka.md`.
- **Nazwa pliku od nadawcy to niezaufane wejście** (R14) — o miejscu zapisu decyduje sanityzacja
  sprawdzająca EFEKT rozwiniętej ścieżki, nie kształt stringa.
- **Warunek kasowania bloba to „brak ŻYWEJ (niewygasłej) referencji", nie `countBlobRefs == 0`** — korekta
  planu w fazie 4: rekord metadanych zostaje po wygaśnięciu bajtów, żeby render pokazał trzeci stan wiersza,
  więc licznik referencji nigdy nie spada do zera.
- **Kasowanie bajtów PO commicie transakcji** w kaskadzie `revokeMember`; pad `unlink` to `warn`, nie rzut.
- **Upload bajtów jako `Buffer`, nie strumień** — retry musi wysłać dokładnie te same bajty.

## Główne pliki

Nowe: `lib/inbox-blobs.js`, `lib/inbox-retention.js`, `scripts/inbox/attachments.mjs`,
`scripts/inbox/args.mjs` (+ pliki testowe każdego z nich).
Zmienione: `lib/inbox-db.js`, `lib/inbox-api.js`, `lib/config.js`, `server.js`,
`scripts/inbox/inbox-client.mjs`, `inbox-pull.mjs`, `inbox-push.mjs`, `inbox-sync.mjs`, `env-loader.mjs`,
`send.mjs`, `reply.mjs` (+ ich testy), `server.inbox.http.test.js`.

## Wnioski

- **Odmowa HTTP dla uprawnionego klienta wymaga drenażu ciała.** FAIL testu „PUT blob > limit → 413" był
  przez dwie fazy brany za flake infrastruktury workera, a okazał się defektem serwera: natychmiastowy
  `req.destroy()` po odmowie kasuje odpowiedź RST-em w buforze klienta. Odmowa idzie teraz po drenażu
  z capem i watchdogiem bezczynności. Powtarzalny FAIL w tym samym teście to hipoteza do obalenia, nie flake.
- **Kontrakt render↔parser jest kruchy i święty** — nowy wiersz załącznika dostał WŁASNY parser
  (`parseRequestedDownloads`), a nie rozszerzenie `parseCheckedCallouts`; dwie odrębne semantyki checkboxa
  w jednym parserze skończyłyby się cichym domykaniem wątków przy pobieraniu.
- **Guard roli/huba liczony przy każdym ticku, nie przy starcie** — rola maszyny zmienia się między
  restartami, a pętla retencji żyje godzinami.
- Sanityzacja ścieżek: pytaj o EFEKT (rozwinięta ścieżka wewnątrz katalogu docelowego), nie o kształt
  wejścia — ten sam wzorzec co guard `.gitignore` przez `git check-ignore` w onboardingu.

Wnioski przeniesione do bazy wiedzy w fazie compound:
`docs/solutions/auth-issues/2026-09-03-tresc-nadawcy-jako-akcja-uprawnienie-i-kod-w-skrzynce.md`.

## Smoke operatora

`docs/operator/2026-09-03-zalaczniki-w-skrzynce-smoke.md` — **12 pozycji** do ręcznego sprawdzenia
(m.in. realny transfer 25 MB przez publiczny Funnel, właściciel i uprawnienia `data/inbox-blobs/` na hubie,
przemiatanie retencji w `journalctl`). Scenariuszy `[E2E]` w tym zadaniu nie ma — weryfikacja idzie
przez `node:test`.
