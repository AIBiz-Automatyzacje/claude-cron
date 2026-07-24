# Review fazy 1 — Team OS Hub-API

Faza: **1 — Hub: dane + API + wpięcie w server.js (XL)**
Data review: 2026-07-24
Branch: `feature/team-os-hub-api`

## Severity gate: ⚠️ ZASTRZEŻENIA

Kontynuuj z zastrzeżeniami — **1 problem P2** do naprawy (ekspozycja tokenu przez CORS na mutującym endpointcie). Zero P1 blokujących. Pozostałe 13 findingów to P3 (nity / long-tail walidacji / martwy kod / test coverage granicznych gałęzi).

## Statystyki

| Severity | KOD | TEST | E2E | OPERATOR | Razem |
|---|---|---|---|---|---|
| P1 | 0 | 0 | 0 | 0 | **0** |
| P2 | 1 | 0 | 0 | 0 | **1** |
| P3 | 9 | 3 | 1 | 0 | **13** |
| **Razem** | 10 | 3 | 1 | 0 | **14** |

- Findingi OPERATOR (poza fix, do Operator checklist): **0**
- E2E: passed 0 / failed 0 / skipped 0 (faza backendowa — brak testów przeglądarkowych; finding typu E2E to notatka defense-in-depth do Fazy 2, nie wykonany run)

---

## Findingi (P1 → P2 → P3)

### P2

#### [P2 · KOD] `server.js:611` (endpoint `/api/inbox/members`, ~403-430) — ekspozycja tokenu przez CORS + brak CSRF
Globalne `Access-Control-Allow-Origin: *` (server.js:611) + `Allow-Methods GET/POST/DELETE` + preflight `OPTIONS→204` obejmują NOWY prywatny endpoint `/api/inbox/members`. Guard XFF nie chroni: `fetch` z evil.com do `http://localhost:7777` NIE ustawia `X-Forwarded-For`, więc przechodzi. Skutek: strona odwiedzona przez admina z działającym lokalnym Pulsem może po cichu wysłać `POST /api/inbox/members` (application/json, preflight przechodzi), utworzyć członka i ODCZYTAĆ pełny token z odpowiedzi 201 (`ACAO:*` pozwala czytać) — trwałe mintowanie dostępu do skrzynki. GET jest zamaskowany, ale POST zwraca `token` i `invite_code` w plaintext.

Root cause `ACAO:*` jest pre-existing (dotyczy całego dashboardu), ale ta faza dokłada endpoint zwracający SEKRET. Mitygacja: ograniczyć `ACAO` dla `/api` (nie `*`) lub odrzucać żądania z nagłówkiem `Origin` na endpointach mutujących. Blast radius wg planu ograniczony do skrzynki („token nie daje nic poza skrzynką").

### P3

#### [P3 · TEST] `lib/inbox-api.test.js` — brak testów 4 z 6 gałęzi walidacji granicznej `handleSend`
`handleSend` ma 6 gałęzi walidacji, z których 4 nie mają ŻADNEGO testu: `invalid_title` (inbox-api.js:155), `invalid_content` (156), `invalid_thread_id` (160), `invalid_payload` (163). Testowane są tylko `invalid_to_user` i `invalid_type`. Brak też testów warunków brzegowych długości mimo `MAX_TITLE_LEN=500`, `MAX_CONTENT_LEN=20000`, `MAX_USER_LEN=100`, `MAX_ID_LEN=100` (grep `MAX_*_LEN` w teście = 0 trafień). Publiczny endpoint granicy bezpieczeństwa — `content>20000` znaków i `payload` jako tablica przechodzą bez pokrycia. Plan (IU-1.2) wymagał tylko „nieznany type odrzucony" (spełnione), ale invalid inputs + boundary są w mandacie fazy.

#### [P3 · KOD] `lib/inbox-api.js:193-199` — rate limit stosowany PO autoryzacji
`resolveMember`→403 (l.194) wykonuje się PRZED `isRateLimited` (l.197). Nieuwierzytelnione żądania (błędny token) NIE są limitowane, a każde woła synchroniczne `inboxDb.listMembers()` (SELECT po całej tabeli) + pętlę `timingSafeEqual` po wszystkich członkach. Na publicznym endpointcie (Funnel) daje to wektor blokowania event-loopu synchronicznymi zapytaniami SQLite bez limitu. Zgodne ze wzorcem `/ask` (plan: „auth → rate limit"), OOM załatwiony capem 64 KB, brute-force tokenu niewykonalny (256-bit) — dlatego P3, ale coding-rule „rate limiting na KAŻDYM public endpoint" spełniona tylko dla uwierzytelnionych.

#### [P3 · E2E] `lib/inbox-db.js:135` (sendMessage) / `lib/inbox-api.js:152` (handleSend) — brak sanityzacji treści na granicy zapisu (stored-injection defense-in-depth)
`handleSend` waliduje tylko typ/długość title/content/payload, nie zawartość. Hub jest teraz NOWĄ granicą przechowywania, a klient (`scripts/inbox/inbox-pull.mjs`, redesign 07.2026) renderuje treść jako inline HTML spany `os-*` w podglądzie Obsidiana — zaproszony (semi-trusted) członek może wstrzyknąć markup/markdown do vaulta innego członka. Renderery są celowo poza zakresem Fazy 1 (wymaganie twarde #6, nietknięte), członkowie są zapraszani — dlatego P3/notatka do walidacji end-to-end w Fazie 2, nie blocker.

#### [P3 · KOD] `lib/inbox-db.js:118` — `SELECT *` we wszystkich odczytach
`getMessage`, `getThread`, `pullForUser` x3, `claimQuery RETURNING *` ładują kolumnę `payload TEXT` nawet gdy konsument jej nie potrzebuje; `listMembers`/`resolveMember` ładują pełny token przy każdym request. Dla pull payload jest potrzebny, więc realny narzut mały. Nit — brak wpływu przy obecnej kardynalności, do rozważenia jeśli payloady urosną.

#### [P3 · KOD] `lib/inbox-db.js:1` — plik 328 linii, przekracza próg 300 (reguła 1)
Moduł spójny (jedna warstwa SQLite huba), ale łączy migracje + smoke-test + granicę JSON + operacje wiadomości + CRUD członków. Kandydat do podziału member-ops / message-ops jeśli urośnie. Borderline — nowy izolowany, dobrze posekcjonowany kod, nie blokuje.

#### [P3 · KOD] `server.js:588` — duplikacja wzorca cap-body-413
Wzorzec `readTextBody → null → res.once('finish', () => req.destroy()) → writeHead(413)` zduplikowany w `handleAsk` i `handleInbox`. 2. użycie tego samego szwu I/O — próg „abstrakcja przy 2+ użyciach" osiągnięty; kandydat do ekstrakcji `readCappedBodyOr413(req,res,max)`. Pragmatycznie akceptowalne (Duplication > Complexity), ale warto odnotować przed kolejnymi publicznymi endpointami.

#### [P3 · KOD] `lib/inbox-api.js:126-134`, `server.js:600-603` — implicit flag zamiast discriminated union
Kontrakt `handleInboxRequest`↔`server.js` dyskryminuje wariant zwrotki przez OBECNOŚĆ pola `json` (`if (result.json)`), nie po jawnym tagu (`kind:'body'|'bare'`). Działa poprawnie (intruder 403/404/405/413 nie ma `json`, reszta ma), ale każdy przyszły wariant zwracający pustą/falsy treść w `json` cicho poleci jako goły status. Jawny discriminator byłby odporniejszy.

#### [P3 · KOD] `server.js:456-458` — loose parsing id w DELETE członka
`DELETE /api/inbox/members/:id` używa `parseInt(segments[3],10)` z guardem tylko na `isNaN`. `parseInt('5x',10)===5`, więc `/api/inbox/members/5x` odwoła członka 5 (zamiast walidacji `/^\d+$/`). Endpoint za guardem XFF (tylko admin przez Tailscale) → wpływ minimalny, ale to walidacja inputu na granicy API.

#### [P3 · KOD] `lib/inbox-api.js:152-175` — `to_user` nie walidowany jako istniejący członek
Literówka w odbiorcy tworzy wiadomość-sierotę (nikt jej nie wypulluje). Nie w pełni cicha: nadawca widzi ją w `delegated` jako otwartą pozycję bez odpowiedzi → realny wpływ niski. Plan (kontrakt send) nie wymaga tej walidacji, ale reguła „waliduj KAŻDY input na granicy API" sugeruje rozważenie.

#### [P3 · KOD] `lib/inbox-api.js:50` (+ server.js matcher/guard XFF) — zachowanie odbiega od zapisanego kontraktu 404
Twarde wymaganie #4 i komentarz w inbox-api.js:50 deklarują „nieznana wersja ścieżki (`/inbox/v2/...`) → 404 bez szczegółów". W praktyce zwrot zależy od transportu: `matchInboxToken` zwraca null dla `/inbox/v2/...`, request spada do guardu XFF — przez Tailscale Funnel (XFF obecny, główny transport klientów) dostaje **403, NIE 404**. 404 tylko lokalnie (bez XFF). Oba opaque dla intruza, realna obsługa driftu stoi na polu `v:1` w 200 (IU-2.1), więc funkcjonalnie nieszkodliwe, ale komentarz mylący. Fix: dopasować `/inbox/` prefix i rozstrzygać wersję w handlerze (404 niezależnie od XFF), albo poprawić komentarz/spec.

#### [P3 · KOD] `lib/inbox-db.js:292` — `getMemberByToken` martwy kod produkcyjny
Brak konsumenta poza własnymi testami (`lib/inbox-db.test.js`). Autoryzacja w inbox-api.js świadomie NIE używa lookupu po tokenie, tylko `resolveMember()` z `timingSafeEqual` po `listMembers()` (ochrona przed timing attack). Funkcja + jej 4 testy istnieją wyłącznie po to, by się testować (anty-pattern #1 over-specification). Do usunięcia razem z testami — jeśli późniejsza faza potrzebna, dopisać przy realnym 2. użyciu.

#### [P3 · KOD] `lib/inbox-api.js:232` — nieużywane eksporty
`API_VERSION`, `MESSAGE_TYPES`, `DONE_ACTIONS` konsumowane wyłącznie wewnątrz modułu — testy asertują wersję literałem (inbox-api.test.js:91 `over.json.v === 1`), server.js ich nie tyka. Realnie importowane tylko `matchInboxToken`/`handleInboxRequest`/`MAX_BODY_SIZE`/`resetInboxApiState`/`INBOX_RATE_LIMIT_PER_MIN`/`RATE_WINDOW_MS`. Zawęzić powierzchnię eksportu.

#### [P3 · TEST] `server.inbox.http.test.js` — brak pokrycia guarda 503 „Funnel URL not configured"
Guard dla `POST /api/inbox/members` (server.js:427-429) nie ma pokrycia — harness zawsze spawnuje serwer z ustawionym `WEBHOOK_BASE_URL` (l.71), więc gałąź fail-fast (chroni przed osieroconym członkiem bez działającego kodu zaproszenia) nigdy się nie wykonuje. Wymaga osobnego spawnu bez `WEBHOOK_BASE_URL`.

#### [P3 · TEST] `lib/inbox-api.test.js` — brak testu mapowania `InboxDbError → 400 invalid_input`
Catch w dispatchu `handleInboxRequest` (inbox-api.js:225-227) przechwytujący naruszenie kontraktu warstwy danych podczas dispatchu (np. `sendMessage` rzuca `InboxDbError` mimo przejścia walidacji API) jest niepokryty — brak asercji, że warstwowy błąd danych daje 400, nie 500.

---

## Zgodność ze spec

Faza 1 realizuje IU-1.1, IU-1.2, IU-1.3. Twarde wymagania #1–#4 pokryte testami (roundtrip payload obiektem, idempotentny `markDone`→`already_done`, atomowy `claimQuery`, rate limit 60/min). Wymaganie #6 (renderery/self-heal nietknięte) należy do Fazy 2 — w Fazie 1 nienaruszone.

Odchylenie od kontraktu: wymaganie twarde #4 („nieznana wersja → 404") realnie zwraca 403 na ścieżce Funnela (finding P3 · inbox-api.js:50). Funkcjonalnie nieszkodliwe (oba kody opaque), ale komentarz w kodzie mylący.

---

## Bookkeeping checkboxów Weryfikacja:

- Odznaczone automatycznie (CLI/grep): **1**
- Odznaczone na podstawie Agent 5 E2E: 0
- Pozostawione dla operatora (Manual): 0
- Niejasne (P3): 0
- Failujące (P2): 0

### Szczegóły
- [x] CLI: `Weryfikacja: pełna suita npm test zielona` → PASS (komenda: `npm test`, exit 0, 433 pass / 0 fail)
