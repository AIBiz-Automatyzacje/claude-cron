# Team OS Hub-API — zadania

Branch: `feature/team-os-hub-api`
Ostatnia aktualizacja: 2026-07-24 (Faza 4 ukończona headless — migracja pg→hub + docs; decommission/wykonanie migracji = OPERATOR)

## Faza 0 — przygotowanie

- [x] Commit zastanych zmian z 24.07 (self-heal Skrzynki, testy inbox-push, eksporty archiwum, CLAUDE.md) — osobny commit PRZED startem F1

## Faza 1 — Hub: dane + API + server.js (XL)

### IU-1.1 `lib/inbox-db.js` (M)
- [x] `lib/inbox-db.js`: otwarcie `data/inbox.db` (ścieżka z configu, `setInboxDbPath` dla testów), idempotentne migracje, smoke-test typów agregatów
- [x] Tabele: `inbox` (id TEXT uuid, thread_id, from_user, to_user, type, title, content, payload TEXT-JSON, status, created_at/updated_at ISO w kodzie), `members` (name UNIQUE, token, created_at)
- [x] Operacje: `pullForUser` (+ pending→delivered), `markDone` (idempotentny; task+Zrobione = transakcja reply+done), `claimQuery` (atomowy UPDATE...RETURNING), `sendMessage`, CRUD członków
- [x] Granica JSON: `payload` obiektem powyżej tej warstwy (parse/stringify TYLKO tu)
- [x] Test: roundtrip `payload {auto_reply:true}` — zapis i odczyt zwraca obiekt, nie string (wymaganie twarde #1)
- [x] Test: `markDone` powtórzony na rekordzie `done` → `already_done`, zero nowych wierszy reply (wymaganie twarde #2)
- [x] Test: `claimQuery` dwa wywołania → drugi dostaje null (atomowość)
- [x] Test: happy + error case dla każdej operacji publicznej

### IU-1.2 `lib/inbox-api.js` (L)
- [x] `matchInboxToken` (`/inbox/v1/:token/<akcja>`) — bliźniak webhook.js, testy happy+error
- [x] Autoryzacja: `timingSafeEqual` po wszystkich tokenach członków; kody dla intruzów bez szczegółów (403/404/405/413)
- [x] Rate limit 60 req/min per token — stała nazwana z komentarzem wyliczenia (rytm: sync 2–4 + auto-reply 2 req/min + retry, ×10); NIE 10/min z /ask (wymaganie twarde #3)
- [x] Cap body 64 KB przed autoryzacją (wzorzec readTextBody z /ask), walidacja inputów na granicy (enum type/action, długości)
- [x] Endpointy: `ping`, `pull` (payload jako obiekt w JSON odpowiedzi), `done` (zwraca pełną nitkę do archiwum), `send`, `claim-query`
- [x] Pole `v:1` w każdej odpowiedzi; nieznana wersja ścieżki → 404 (wymaganie twarde #4)
- [x] Test: autoryzacja (zły token 403, dobry przechodzi), rate limit (61. request w minucie odcięty), walidacja (nieznany type odrzucony)

### IU-1.3 `server.js` + testy HTTP (M)
- [x] Matcher inbox w kolejności: webhook → ask → **inbox** → guard XFF → api/static + aktualizacja komentarza-kontraktu
- [x] Prywatne `/api/inbox/members` (ZA guardem XFF): GET lista (tokeny maskowane), POST dodanie (pełny token + kod zaproszenia jednorazowo w odpowiedzi), DELETE odwołanie
- [x] Test HTTP (żywy proces, wzorzec ask.http.test.js): inbox działa z nagłówkiem XFF; `/api/inbox/members` z XFF → 403
- [x] Test HTTP: powtórzony `done` → `already_done`, bez duplikatu reply
- [x] Test HTTP: `pull` zwraca `payload.auto_reply === true` jako boolean w obiekcie
- [x] Weryfikacja: pełna suita `npm test` zielona (PASS — `npm test` exit 0, 433 pass / 0 fail)

## Do poprawy po review fazy 1

- [x] 🟠 [P2] **server.js:611** (endpoint `/api/inbox/members`, ~403-430) — ekspozycja tokenu przez CORS + brak CSRF: globalne `ACAO:*` + preflight obejmują nowy mutujący endpoint zwracający pełny `token`/`invite_code`; guard XFF nie chroni (fetch z evil.com nie ustawia XFF). Fix: ograniczyć `ACAO` dla `/api` lub odrzucać `Origin` na endpointach mutujących. → naprawione: guard `isCrossOriginRequest` (Origin ≠ Host) odrzuca cross-origin na `/api/inbox/members` PRZED dotknięciem DB; 2 testy CSRF w server.inbox.http.test.js.

### P3 (opcjonalne — do rozważenia)

- [ ] 🟡 [P3·TEST] **lib/inbox-api.test.js** — brak testów 4/6 gałęzi walidacji `handleSend` (`invalid_title`/`invalid_content`/`invalid_thread_id`/`invalid_payload`) + zero testów warunków brzegowych `MAX_*_LEN`.
- [ ] 🟡 [P3·KOD] **lib/inbox-api.js:193-199** — rate limit stosowany PO autoryzacji; nieuwierzytelnione żądania nielimitowane, każde woła synchroniczne `listMembers()`+pętlę `timingSafeEqual`.
- [ ] 🟡 [P3·E2E] **lib/inbox-db.js:135 / lib/inbox-api.js:152** — brak sanityzacji treści na granicy zapisu (stored-injection defense-in-depth); walidacja end-to-end w Fazie 2.
- [ ] 🟡 [P3·KOD] **lib/inbox-db.js:118** — `SELECT *` we wszystkich odczytach (ładuje `payload`/token gdy zbędne).
- [ ] 🟡 [P3·KOD] **lib/inbox-db.js:1** — plik 328 linii, przekracza próg 300; kandydat do podziału member-ops / message-ops.
- [ ] 🟡 [P3·KOD] **server.js:588** — duplikacja wzorca cap-body-413 (handleAsk + handleInbox); ekstrakcja `readCappedBodyOr413`.
- [ ] 🟡 [P3·KOD] **lib/inbox-api.js:126-134, server.js:600-603** — implicit flag (`if (result.json)`) zamiast discriminated union.
- [ ] 🟡 [P3·KOD] **server.js:456-458** — loose parsing id w DELETE (`parseInt('5x')===5`); walidacja `/^\d+$/`.
- [ ] 🟡 [P3·KOD] **lib/inbox-api.js:152-175** — `to_user` nie walidowany jako istniejący członek (wiadomość-sierota).
- [ ] 🟡 [P3·KOD] **lib/inbox-api.js:50** — kontrakt „nieznana wersja → 404" realnie zwraca 403 na ścieżce Funnela; poprawić kod lub komentarz/spec.
- [ ] 🟡 [P3·KOD] **lib/inbox-db.js:292** — `getMemberByToken` martwy kod (konsument tylko w testach); do usunięcia z testami.
- [ ] 🟡 [P3·KOD] **lib/inbox-api.js:232** — nieużywane eksporty `API_VERSION`/`MESSAGE_TYPES`/`DONE_ACTIONS`.
- [ ] 🟡 [P3·TEST] **server.inbox.http.test.js** — brak pokrycia guarda 503 „Funnel URL not configured".
- [ ] 🟡 [P3·TEST] **lib/inbox-api.test.js** — brak testu mapowania `InboxDbError → 400 invalid_input` w dispatchu.

## Faza 2 — Klienci (M)

### IU-2.1 `scripts/inbox/inbox-client.mjs` (S)
- [x] Wrapper fetch: `INBOX_HUB_URL`+`INBOX_TOKEN`, timeout (AbortController), 1 retry na timeout/5xx, czytelne błędy konfiguracji
- [x] Weryfikacja `v:1` w odpowiedzi — mismatch = czytelny błąd „zaktualizuj Pulsa"
- [x] Test: happy + error (timeout, zła wersja, brak konfiguracji)

### IU-2.2 Przepięcie skryptów (M)
- [x] `inbox-pull.mjs`: pg → client.pull; `me` z odpowiedzi huba (pole `user`)
- [x] `inbox-push.mjs`: pg → client.done; OUT transakcje i sprawdzanie done (robi hub); archiwum z nitki zwróconej przez `done`
- [x] `auto-reply.mjs`: pg → client.claimQuery + client.send; OUT własny claim przez UPDATE
- [x] Weryfikacja: parsery, renderery, self-heal i ich testy BEZ zmian — `git diff` czysty na testach warstwy plików (wymaganie twarde #6) (PASS — `git diff --name-only 38d304c d108cfd` nie dotyka inbox-pull.test.mjs / inbox-push.test.mjs / auto-reply.test.mjs)

### IU-2.3 Konfiguracja (S)
- [x] `env-loader.mjs`: `INBOX_HUB_URL`+`INBOX_TOKEN`; OUT `INBOX_DB_URL`/`INBOX_USER`; OUT hardcoded fallback `Documents/kacper_trzepiecinski_workspace`
- [x] `inbox-seed.js`: warunek konfiguracji = HUB_URL && TOKEN
- [x] Test: env-loader happy + error po zmianach; inbox-seed `not_configured` bez nowych zmiennych
- [x] Weryfikacja: pełna suita zielona (PASS — `npm test` exit 0, 465 pass / 0 fail)

## Do poprawy po review fazy 2

Severity gate: ⚠️ ZASTRZEŻENIA (2× P2, 0× P1). Raport: `review-faza-2.md`.

- [x] 🟠 [P2·KOD] **scripts/inbox/inbox-client.mjs:91-129** — retry (1 próba na 5xx/timeout) stosowany do nieidempotentnego `send`: `sendMessage` (inbox-db.js:143) generuje świeży `randomUUID()` bez klucza dedup, więc timeout/5xx PO commicie INSERTa → ponowienie → zdublowana wiadomość/auto-odpowiedź/delegacja. Fix: nie ponawiać `send` na timeout albo idempotency key po stronie huba. → `send` przekazuje `retry:false` (pojedyncza próba, czytelny błąd zamiast duplikatu); testy no-retry na AbortError/502 w inbox-client.test.mjs.
- [x] 🟠 [P2·TEST] **scripts/inbox/auto-reply.main.test.mjs:38** — brak testu happy-path „kandydat jest → runClaude → client.send → appendHistory" (`runClaude` nie jest wstrzykiwany, wbrew konwencji DI). Fix: wstrzyknąć `runClaude`/fake bin i przetestować, że przy odpowiedzi != NO_ANSWER wołane jest `client.send` z poprawnym body i `payload.auto_reply`. → dodano test happy-path (fake bin przez `setClaudeBin`, asercje na body reply + `payload.auto_reply` + historia) oraz test NO_ANSWER.

### P3 (opcjonalne — do rozważenia)

- [ ] 🟡 [P3·TEST] **scripts/inbox/inbox-push.main.test.mjs:105** — gałąź `result:'closed'` (Zapoznane → archiwizacja) i pętla >1 odhaczonego itemu bez pokrycia.
- [ ] 🟡 [P3·KOD] **scripts/inbox/inbox-client.mjs:32-46** — brak wymuszenia `https://` na `INBOX_HUB_URL`; token w ścieżce URL → literówka `http://` = wyciek tokenu do logów. Fail-fast/warn poza localhost.
- [ ] 🟡 [P3·KOD] **scripts/inbox/auto-reply.mjs:30-42** — prompt injection przez treść query huba (agent z Read/Glob/Grep do vaulta); pre-existing, ryzyko rośnie przy sieciowej proweniencji. Auto-reply domyślnie wyłączone.
- [ ] 🟡 [P3·KOD] **scripts/inbox/inbox-pull.mjs:60-73** — injection HTML do Obsidiana (spany `os-*` bez sanityzacji); renderer nietknięty (#6), dane z sieciowego huba.
- [ ] 🟡 [P3·KOD] **scripts/inbox/inbox-push.mjs:138** — N+1: sekwencyjne `client.done()` per callout; regres kosztu vs trwałe pg. Świadomy dług (brak batch-endpointu huba).
- [ ] 🟡 [P3·KOD] **scripts/inbox/inbox-push.mjs:147** — retry `done` po commicie zwraca `already_done` bez `thread` → `stats.skipped++` zamiast `appendToArchive` = luka w archiwum. Ta sama semantyka co P2·KOD retry.
- [ ] 🟡 [P3·KOD] **scripts/inbox/inbox-client.mjs:96** — komunikat błędu 4xx ignoruje pole `error` z body huba (goły kod HTTP utrudnia diagnozę driftu). Sparsować body i dołączyć `error`.
- [ ] 🟡 [P3·KOD] **scripts/inbox/inbox-client.mjs:134** — `ping()` bez konsumenta produkcyjnego (YAGNI); planowany caller w niezaznaczonej fazie setupu. Dociągnąć przy IU-3.2 albo usunąć.
- [ ] 🟡 [P3·TEST] **scripts/inbox/inbox-push.main.test.mjs:20** — martwy `INBOX_USER` w `ENV_KEYS` (tu i w auto-reply.main.test.mjs:13); usunąć leftover z ery pg.
- [ ] 🟡 [P3·TEST] **scripts/inbox/inbox-client.test.mjs:245** — nietestowane gałęzie fail-fast: `done`(brak action), `send`(brak type/title).
- [ ] 🟡 [P3·TEST] **scripts/inbox/inbox-pull.main.test.mjs:49** — ścieżka `delegated` niećwiczona na poziomie main (sekcja Wysłane / banner / `staleDelegatedCount`).

_Findingów typu OPERATOR (niewykonalne headless) w fazie 2: brak — sekcja Operator checklist pominięta._

## Faza 3 — Onboarding (L)

### IU-3.1 `install-vps.sh` — komponent „Team OS hub" (M)
- [x] Pytanie w pełnym trybie (przez `ask_tty`, domyślnie **n**)
- [x] Dodanie członka-admina przez API lokalnego serwera (curl 127.0.0.1:7777); idempotentny re-run
- [x] Guard: brak skonfigurowanego Funnela = fail z instrukcją (nie cichy sukces); kod zaproszenia w podsumowaniu instalacji
- [x] Test: `install-vps.test.sh` — pytanie, guard Funnela, idempotencja

### IU-3.2 `setup.mjs` — blok kodu zaproszenia (M)
- [x] Pytanie „Masz kod zaproszenia do skrzynki zespołowej? (puste = pomiń)" po pytaniu o VPS
- [x] `parseInviteCode` (`puls-inbox:<url>#<token>`) — czysta funkcja
- [x] Probe `GET /ping` przed zapisem; pad → warn i pominięcie, nigdy fail setupu
- [x] Zapis `INBOX_HUB_URL`/`INBOX_TOKEN` do `.env` workspace'u + hint o restarcie daemona (stale env)
- [x] Test: `setup.test.mjs` — parseInviteCode happy+error, probe-fail nie wywala setupu

### IU-3.3 Dashboard — widok „Zespół" (M)
- [x] `public/index.html` + `public/app.js`: sekcja Zespół — lista członków (imię, maska tokenu, data), formularz dodania, przycisk unieważnij z potwierdzeniem
- [x] Kod zaproszenia po utworzeniu: pokazany jednorazowo + przycisk kopiuj + ostrzeżenie „nie pojawi się drugi raz"
- [x] Czyste helpery renderujące w `render-helpers.js` (maska tokenu, wiersz członka)
- [x] Widok działa przez proxy `/api/vps/*` (hub = VPS admina) i bezpośrednio na dashboardzie VPS
- [x] Test: helpery renderujące happy + error w `render-helpers.test.js`
- [ ] Weryfikacja: pełna suita + testy instalatorów zielone; ręcznie — dodanie/unieważnienie członka z lokalnego dashboardu w widoku vps — część CLI PASS (npm test 492/492 exit 0, install-vps.test.sh 110/110 exit 0); część ręczna — wymaga operatora (checklist)

## Do poprawy po review fazy 3

Severity gate: ⚠️ ZASTRZEŻENIA (2× P2, 0× P1). Raport: `review-faza-3.md`.

- [x] 🟠 [P2·KOD] **public/app.js:1135** — Attribute-context XSS: `esc()` (app.js:1258) nie escapuje cudzysłowów, a `renderMembers` wstawia `esc(row.name)` do `aria-label="Unieważnij dostęp ${esc(row.name)}"`. Nazwa członka niewalidowana znakowo (addMember lib/inbox-db.js:271 sprawdza tylko `!name`, validateMemberName tylko długość ≤80) → `x" onmouseover="alert(...)` wstrzykuje handler; w trybie VPS dane z proxy `/api/vps/*`, nie tylko self-XSS. Fix: escapuj `"`/`'` (dedykowany escAttr) albo nie wstawiaj nazwy do atrybutu.
- [x] 🟠 [P2·KOD] **scripts/install-vps.sh:1436** — `is_valid_member_name` whitelist ASCII `^[A-Za-z0-9 ._-]+$` odrzuca polskie diakrytyki (ł/ą/ć/ę/ó/ś/ż/ź/ń). Admin o polskim imieniu → `ask_valid` ponawia → `ASK_MAX_ATTEMPTS` → `fail`/`exit 1` PRZERYWA skonfigurowaną instalację przed `print_summary`, jednorazowy `TEAM_OS_INVITE_CODE` przepada. Niespójne z dashboardem (dowolne znaki) i server.js (brak walidacji). Fix: rozszerzyć klasę o Unicode/diakrytyki, wykluczyć tylko `"` `\` i control chars.

### P3 (opcjonalne — do rozważenia)

- [ ] 🟡 [P3·KOD] **public/app.js:1135** — `row.id` interpolowane bez koercji do `onclick="revokeMember(${row.id})"` (memberRowData: `m.id ?? null`). Fix: `Number(row.id)` / data-atrybut + delegacja.
- [ ] 🟡 [P3·KOD] **public/app.js:1436** — poll() re-fetchuje pełną listę członków co 3 s (na VPS round-trip do wspólnego Postgresa) mimo że roster zmienia się rzadko; transient `{error}` powoduje flicker empty-state. Usunąć team z poll() albo wydłużyć interwał.
- [ ] 🟡 [P3·KOD] **public/app.js:1155-1180** — niespójny prefix nazewnictwa modala: `AddMember` vs `TeamAdd` dla tego samego widoku. Ujednolicić.
- [ ] 🟡 [P3·KOD] **public/app.js:80** — switchEnv woła `loadMembers()` eager wbrew komentarzowi lazy-load (linia 94); pokryte tab-click i poll. Usunąć z allSettled albo zaktualizować komentarz.
- [ ] 🟡 [P3·KOD] **setup.mjs** — `probeInviteCode` catch zakłada Error (`error.message`); nie-Error → „(undefined)". Użyć `error?.message ?? String(error)`.
- [ ] 🟡 [P3·KOD] **public/app.js** — `membersSig` pomija `name` w podpisie guardu (tylko `id:token_masked`+długość); gap latentny na wypadek rename po tym samym id.
- [ ] 🟡 [P3·KOD] **docs/active/team-os-hub-api/team-os-hub-api-kontekst.md** — under-implementacja instrukcji IU-3.2: brak wzmianki, że celowe niedotworzenie plików Skrzynki w setupie pokrywa self-heal `ensureSkrzynkaFile` przy pierwszym runie pull.
- [ ] 🟡 [P3·KOD] **public/render-helpers.js:222** — defensive fallbacki `'—'` dla gwarantowanych pól name/token_masked (regula #10) + zdublowana logika fallbacku `createdAt` (helper + renderMembers app.js:1131). Ujednolicić.
- [ ] 🟡 [P3·TEST] **public/app.js:1093** — `membersSig()` (bliźniak testowanych pollSignature/jobsSignature) bez testu; brzegowe: unieważnienie członka vs brak zmian. Przenieść do render-helpers + test.
- [ ] 🟡 [P3·TEST] **scripts/install-vps.test.sh:1938** — nietestowane gałęzie błędu `setup_team_os_hub`: (a) brak odpowiedzi serwera → warn+skip (:1518), (b) HTTP != 201/503 → warn+skip (:1538), (c) 201 bez invite_code → warn (:1546).

## Operator checklist faza 3

Nie są to zadania do fix — to warunki środowiskowe/ręczne weryfikacje wymagające żywego dashboardu + huba na VPS z Funnelem (niewykonalne headless).

- [ ] Operator: ręczna weryfikacja dodania i unieważnienia członka z LOKALNEGO dashboardu w widoku VPS przez proxy `/api/vps/*` (jedyny otwarty checkbox IU-3.3) — Operator action: 1) postaw hub na VPS admina ze skonfigurowanym Tailscale Funnel; 2) z lokalnego dashboardu przełącz widok na VPS; 3) w zakładce Zespół dodaj testowego członka (sprawdź jednorazowy invite_code + kopiuj + ostrzeżenie); 4) unieważnij go z potwierdzeniem; 5) potwierdź, że lista odświeża się poprawnie i mutacja przeszła przez proxy.
- [ ] Operator: smoke-test pełnej ścieżki onboardingu huba (install-vps.sh `setup_team_os_hub` + setup.mjs `askInboxInvite`/`probeInviteCode`) na realnym VPS z Tailscale Funnel — Operator action: 1) odpal `install-vps.sh` w pełnym trybie, odpowiedz T na „Team OS hub"; 2) potwierdź, że przy braku Funnela pojawia się 503 z instrukcją (guard), a przy skonfigurowanym Funnelu POST `/api/inbox/members` zwraca 201 + invite_code z `WEBHOOK_BASE_URL`; 3) na drugiej maszynie odpal `setup.mjs`, wklej invite_code, potwierdź probe `client.ping` do żywego huba i zapis `INBOX_HUB_URL`/`INBOX_TOKEN` do `.env`.

## Faza 4 — Migracja + decommission + docs (M)

### IU-4.1 Migracja danych (S)
- [x] `scripts/inbox/migrate-pg-to-hub.mjs`: otwarte wątki (`status != 'done'`) ze starego Postgresa → hub (z zachowaniem thread_id/created_at) — surowy `INSERT OR IGNORE` do `data/inbox.db` (zachowuje id/thread_id/from_user/to_user/created_at/status, których `handleSend` by nie zachował), DI (`readRows`/`db`), idempotencja po PRIMARY KEY, throwaway serializacja payloadu lokalnie (usuwany w IU-4.3); 11 testów (transformacja + migrate + fail-fast) zielonych
- [ ] Wykonanie migracji + ręczne przepięcie `.env` operatora i Kamila — **OPERATOR** (wymaga starego Postgresa + VPS-a huba)
- [ ] Weryfikacja: skrzynka end-to-end po hubie (wysłanie, odpowiedź, odhaczenie, archiwum, auto-reply) — **OPERATOR** (żywy hub + vaulty)

### IU-4.2 Decommission (S) — wymaganie twarde #5
- [ ] Kontener Postgresa na 62.72.33.171 zgaszony — **OPERATOR**
- [ ] Hasło z `INBOX_DB_URL` zrewokowane (spalone — jeździło plaintextem po publicznym internecie) — **OPERATOR**
- [ ] Weryfikacja: skan z zewnątrz — port 5433 nie odpowiada (`nc -zv` z innej sieci) — **OPERATOR**
- [ ] Wpis hasła do listy rewokacji w notatce NOW operatora — **OPERATOR**

### IU-4.3 Sprzątanie + docs (S)
- [ ] OUT: `pg` z `package.json`+lock, `schema.sql`, `migrate-pg-to-hub.mjs` — **GATED na operatora**: usunięcie ma sens dopiero PO zweryfikowanej migracji (IU-4.1 wykonanie) + decommissionie (IU-4.2); skrypt migracji wciąż importuje `pg`. Nie usuwamy przed uruchomieniem migracji.
- [x] CLAUDE.md: sekcja Team OS (hub, kontrakt matcherów z inbox, odrzucona opcja minimalna jako decyzja) — nagłówek `## Team OS — Skrzynka (hub lib/inbox-*.js + klienci scripts/inbox/)`, opis hub-and-spoke, `lib/inbox-db.js`/`lib/inbox-api.js`/`inbox-client.mjs`, dedykowany opis prywatnego `/api/inbox/members` (guard XFF + guard cross-origin CSRF), świadomie odrzucona opcja minimalna
- [ ] Weryfikacja: `npm install --omit=dev` na czysto + pełna suita zielona — pełna suita **503/503 zielona** (`npm test` exit 0); `npm install --omit=dev` na czysto = **OPERATOR** (usunięcie `pg` jest gated, więc czysty install weryfikowalny dopiero po IU-4.2/4.3 cleanup)
