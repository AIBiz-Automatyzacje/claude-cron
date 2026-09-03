Branch: `feature/zalaczniki-w-skrzynce`
Ostatnia aktualizacja: 2026-09-03 (faza 3)

# Załączniki w Skrzynce Team OS — kontekst

## Źródła

- **Plan techniczny:** `docs/plans/2026-09-03-001-feat-zalaczniki-w-skrzynce-plan.md`
- **Requirements doc:** `docs/brainstorms/2026-09-02-zalaczniki-w-skrzynce-requirements.md`
- **Przygotowanie dla operatora:** `docs/operator/zalaczniki-w-skrzynce-przygotowanie.md`

## Plan techniczny

Kluczowe pliki, decyzje techniczne, odroczone pytania i wzorce do naśladowania:
`docs/plans/2026-09-03-001-feat-zalaczniki-w-skrzynce-plan.md` (sekcje „Kluczowe decyzje techniczne",
„Otwarte pytania", `Pliki:` i `Wzorce do naśladowania:` w blokach IU).

## Wymagania wstępne operatora

`docs/operator/zalaczniki-w-skrzynce-przygotowanie.md` — **brak pozycji blokujących**. Wszystkie decyzje
i weryfikacje środowiska zostały domknięte 2026-09-03 (wpis `Zasoby/inbox-zalaczniki/` w `.gitignore`
vaulta, pomiar 25 MB przez Tailscale Funnel, sprawdzenie dysku huba).

Pozycje otwarte w tym dokumencie są **po implementacji** i nie blokują żadnej fazy: wydanie skilla
`deleguj` i snippetu `skrzynka.css` w pluginie zespołowym, aktualizacja pluginu u czterech osób,
wykluczenie `Zasoby/inbox-zalaczniki/` z listy wykluczeń Obsidian Sync (katalog powstanie dopiero
przy pierwszym pobraniu, więc wcześniej nie ma czego wskazać).

## Dziennik

<!-- execute-wf dopisuje tu zmiany i decyzje per faza -->

### 2026-09-03 — Faza 1: Magazyn bajtów na hubie (IU-1, IU-2, IU-3)

- **Zaimplementowane:** tabela `inbox_attachments` + funkcje warstwy danych (`lib/inbox-db.js`),
  magazyn blobów na dysku ze strumieniowym hashowaniem (`lib/inbox-blobs.js` — nowy),
  binarne endpointy `PUT/GET /inbox/v1/:token/blob/:sha256` (`lib/inbox-api.js`, `server.js`).
- **Walidacja:** pełna suita `node --test` — 1145/1145 PASS. Testy fazy (4 pliki) — 133/133 PASS.
  Projekt nie ma typecheckera, lintera ani buildu (czysty CommonJS + `node:test`).
- **Odchylenia od planu** (opisane w planie technicznym, sekcja „Odchylenia — faza 1"):
  walidacja kształtu metadanych w `addAttachments`, `findAttachmentForUser` w warstwie danych,
  `INBOX_BLOBS_DIR` + override `CLAUDE_CRON_INBOX_BLOBS_DIR` w `lib/config.js`,
  `handleInbox(req, res, match)` zamiast czterech argumentów, `Connection: close` na odmowach binarnych.
- **Zero nowych zależności.** Kontrakt `matchInboxToken` zmieniony na `{token, action, param}`
  — trzy istniejące asercje zaktualizowane do nowego kształtu (pełny `deepStrictEqual`, bez osłabienia).

### 2026-09-03 — Faza 2: Wysyłka z załącznikami (IU-4, IU-5)

- **Zaimplementowane:** operacje binarne klienta huba `uploadBlob`/`downloadBlob` z osobnym
  `BINARY_TIMEOUT_MS = 180 s` i zapisem przez plik tymczasowy + `rename`
  (`scripts/inbox/inbox-client.mjs`); przygotowanie załączników nadawcy — próg 25 MB przed
  transferem, sha256, upload (`scripts/inbox/attachments.mjs` — nowy); powtarzalna flaga
  `--attach` (`scripts/inbox/args.mjs`) wpięta w `send.mjs` i `reply.mjs`; walidacja
  `attachments` na granicy API + krótka transakcja wiadomość-plus-metadane
  (`lib/inbox-api.js`, `lib/inbox-db.js`).
- **Walidacja:** pełna suita `node --test` — 1200/1201 PASS; jedyny FAIL to flake infrastruktury
  workera na `server.inbox.http.test.js` (PASS 3/3 w izolacji), nie defekt. Testy fazy
  (5 plików) — 185/185 PASS. Projekt nie ma typecheckera, lintera ani buildu.
- **Odchylenia od planu:** opisane w planie technicznym, sekcja „Odchylenia — faza 2"
  (`docs/plans/2026-09-03-001-feat-zalaczniki-w-skrzynce-plan.md`) — m.in. upload bajtów jako
  `Buffer` zamiast strumienia (retry musi wysłać te same bajty), warunek „to TEN nadawca wgrał
  te bajty" w `handleSend` oraz `MAX_ATTACHMENTS_PER_MESSAGE = 10`.
- **Zero nowych zależności.** Audyt error-handlingu diffu: brak `console.log` i pustych `catch`;
  jedyny nowy log to `console.warn` z prefiksem modułu (konwencja projektu, lustro `lib/inbox-blobs.js`).

### 2026-09-03 — Faza 3: Odbiór — render, odhaczenie, zapis do vaulta (IU-6, IU-7, IU-8)

- **Zaimplementowane:** wiersz załącznika w trzech stanach renderowany bezstanowo przy każdym pullu
  (`scripts/inbox/inbox-pull.mjs`); osobny parser odhaczonych pobrań `parseRequestedDownloads`, nietykający
  `parseCheckedCallouts` (`scripts/inbox/inbox-push.mjs`); pobranie do `Zasoby/inbox-zalaczniki/RRRR-MM/`
  z sanityzacją nazwy sprawdzającą EFEKT ścieżki i no-opem na maszynie w roli `agent`
  (`scripts/inbox/attachments.mjs`, `scripts/inbox/env-loader.mjs`); sekwencja syncu push → pobrania → pull
  w jednym procesie (`scripts/inbox/inbox-sync.mjs` + nowy `inbox-sync.test.mjs`).
- **Walidacja:** pełna suita `node --test` — 1236/1236 PASS. `server.inbox.http.test.js` 24/24 w izolacji,
  trzy przebiegi z rzędu. Projekt nie ma typecheckera, lintera ani buildu.
- **Naprawa poza IU:** FAIL testu „PUT blob: ciało większe niż limit → 413" był brany za flake
  infrastruktury (faza 2 i raporty builderów), a okazał się defektem serwera: natychmiastowy `req.destroy()`
  po odmowie kasuje odpowiedź RST-em w buforze klienta. Odmowa dla uprawnionego klienta idzie teraz po
  drenażu ciała z capem i watchdogiem bezczynności — szczegóły i uzasadnienie w planie technicznym,
  sekcja „Odchylenia — faza 3".
- **Odchylenia od planu:** opisane w planie technicznym
  (`docs/plans/2026-09-03-001-feat-zalaczniki-w-skrzynce-plan.md`, sekcja „Odchylenia — faza 3").
- **Zero nowych zależności.** Audyt error-handlingu diffu: zero pustych `catch` (każdy raportuje
  `console.warn`/`console.error` z prefiksem modułu — konwencja skryptów CLI projektu), zero `console.log`
  w kodzie serwera.
