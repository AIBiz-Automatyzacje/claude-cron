# Plan: Endpoint /ask — asystent głosowy (faza 1, backend)

Branch: `feature/ask-endpoint`
Ostatnia aktualizacja: 2026-07-13

## Podsumowanie wykonawcze

Nowy publiczny endpoint `POST /ask/:token` w Pulsie: przyjmuje podyktowany tekst (text/plain), spawnuje CLI `claude` (Sonnet, `--output-format text`) z dostępem do vaulta i skilli, zwraca odpowiedź w tym samym połączeniu HTTP (≤ `ASK_TIMEOUT_MS` 55 s). Zapytania za długie są „odczepiane w tło" (bez killa — zero podwójnych wykonań), wynik wraca powiadomieniem Discord/Telegram wg flag dedykowanego joba-teczki „Asystent głosowy". Konsument: Apple Shortcut na Macu (faza 1); Apple Watch = faza 2, poza tym planem.

Pełny plan techniczny z decyzjami i uzasadnieniami: `docs/plans/2026-07-13-001-feat-ask-endpoint-asystent-glosowy-plan.md` (ten dokument jest jego operacyjnym rozwinięciem — przy rozjeździe wygrywa plan techniczny).

## Cele i zakres

**Cele (wymagania R1–R12 planu technicznego):**
- Synchroniczna odpowiedź text/plain w ≤ 55 s; po timeoucie odczepienie w tło + powiadomienie.
- Autoryzacja podwójna (token URL + `X-Secret`, `timingSafeEqual`), rate limit 10/min, współbieżność: 1 sync + 3 tła (rezerwacja slotu pesymistycznie przy spawnie — decyzja usera 13.07).
- Kody błędów tylko dla intruzów (403/404/405); wszystko „dla człowieka" = 200 z tekstem (limit Shortcuts).
- Gwarancja „nigdy cisza" dla zadań odczepionych: dokładnie jedno z ✅ / ❌ pad lub `ASK_MAX_MS` / ❌ restart (reaper).
- Job-teczka: każdy `/ask` = run (trigger `ask`, `routine=1`), poza kolejką schedulera; powiadomienia TYLKO dla odczepionych.
- Wspólny helper spawnu wydzielony z `executor.js` bez regresji (charakteryzacja: istniejące testy bez zmian).

**Poza zakresem:**
- Faza 2 (Apple Watch) + eksperyment pomiarowy cierpliwości zegarka.
- Klikanie Shortcuta na Macu (Operator checklist, nie kod).
- Klasyfikacja „długie vs krótkie" w prompcie; serializacja ask vs joby na vaulcie; nowe ekrany dashboardu; zmiany sieci.

## Fazy wdrożenia

Fazy = Implementation Units z planu technicznego, uporządkowane po zależnościach. Szczegółowe podejście, wzorce i pułapki per unit — w planie technicznym; checklisty wykonawcze — w `ask-endpoint-zadania.md`.

### Faza 1 — Fundament (bez zależności)

**Unit 1: `lib/claude-spawn.js` — wspólny helper spawnu** (nakład: M)
Wydzielenie z `executor.js:100-152`: czysty env (strip `CLAUDE_CODE*`/`CLAUDECODE` → OAuth PO stripie), resolve binarki (Windows `where claude`), spawn `cwd: WORKSPACE_DIR`; argumenty CLI parametryzowane; override binarki dla testów (wzorzec `setDbPath`). Stateful rzeczy (currentProcess, timeouty, watchdog, caffeinate, kill) ZOSTAJĄ w executorze.
*Kryterium akceptacji:* `npm test` w całości zielony, w tym `executor.test.js`/`scheduler.test.js` bez zmiany asercji; nowy `claude-spawn.test.js` pokrywa strip/OAuth/spawn.

**Unit 2: konfiguracja `ASK_*` + matcher tokenu** (nakład: S)
`config.js`: `ASK_ENABLED` (opt-in, default false), `ASK_TOKEN`, `ASK_SECRET`, `ASK_TIMEOUT_MS` 55000, `ASK_MAX_MS` 600000, `ASK_MODEL` 'sonnet'. `webhook.js`: `matchAskToken` bliźniaczy do `matchWebhookToken`.
*Kryterium akceptacji:* matcher pokryty testami (happy + error), defaulty configu zweryfikowane.

### Faza 2 — Rdzeń modułu ask (sekwencyjnie po Fazie 1)

**Unit 3: `lib/ask.js` — bramki wejścia i teczka** (nakład: M; zależy od U2)
Czyste funkcje decyzyjne: `verifySecret` (guard długości przed `timingSafeEqual`; brak konfiguracji = odmowa), rate limiter i liczniki współbieżności in-memory (wstrzykiwany zegar; zero agregatów SQL — pułapka BigInt), kolejność bramek: auth → rate limit → lock sync → slot tła. `getOrCreateAskJob()` idempotentnie po `name`, nigdy nie nadpisuje flag usera.
*Kryterium akceptacji:* wszystkie decyzje odmowne testowane z asercjami na TREŚĆ tekstów; dwukrotny get-or-create nie clobberuje ręcznej zmiany flagi.

**Unit 4: `lib/ask.js` — wykonanie: spawn, odczepienie, powiadomienia** (nakład: L; zależy od U1+U3)
Prompt asystencki + run teczki (`trigger_type:'ask'`, pytanie w `webhook_payload`) → spawn helperem (`--output-format text --model <ASK_MODEL>`, bez `--verbose`) → wyścig close vs `ASK_TIMEOUT_MS` → sync-odpowiedź albo odczepienie (bez killa). Close odczepionego: re-read runu z DB (guard `killed`) → updateRun → powiadomienie plain-text (`smartSplit` + `resolveNotifyConfig`, Z POMINIĘCIEM `extractResult`/`notifyRunOutcome`). `ASK_MAX_MS` → kill drzewa + ❌. Idempotentny finalize = strukturalna gwarancja „nigdy cisza". Seam plain-text w `discord.js`/`telegram.js` — kształt odroczony do implementacji.
*Kryterium akceptacji:* sync bez powiadomienia; odczepienie → dokładnie jedno ✅/❌; guard na `killed` bez podwójnego powiadomienia; brak skonfigurowanego kanału → warning w logu.

### Faza 3 — Integracja HTTP i domknięcie gwarancji

**Unit 5: endpoint w `server.js` + etykieta triggera** (nakład: M; zależy od U3+U4)
Match `/ask/:token` między webhookiem (`server.js:436`) a guardem XFF (`server.js:438`); gate `ASK_ENABLED` → 403, nie-POST → 405; własny reader surowego body (istniejący `parseBody` JSON-uje); odpowiedzi 200 `text/plain; charset=utf-8`; log `[ask]`; etykieta `ask` w `public/enum-map.js`.
*Kryterium akceptacji:* test HTTP na żywym serwerze (wzorzec `server.env.test.js`): 403×3, 405, happy path E2E, guard XFF nienaruszony dla `/api/*`, „jeszcze myślę" przy drugim równoległym.

**Unit 6: reaper — ❌ „przerwane przez restart" + test szwu** (nakład: M; zależy od U4+U5)
`reapOrphanedRuns` zwraca zebrane runy (`{id, job_id}`); start serwera wysyła ❌ dla runów teczki (fire-and-forget z catch); kontrakt „`killed` milczy" dla zwykłych jobów nienaruszony (`notifyRunOutcome`/`isFinalFailure` nietknięte). Test szwu ask+reaper na `:memory:` PRZED podłączeniem do `server.js`.
*Kryterium akceptacji:* test szwu: osierocony run teczki → `killed` + dokładnie jedno ❌ z tekstem o restarcie; osierocony run zwykłego joba → zero powiadomień.

### Faza 4 — Deploy i Shortcut (operator, poza automatyzacją)

Merge → pull na VPS → `ASK_*` do env (długie losowe sekrety) → restart daemona → włączenie kanału powiadomień na teczce w panelu → test curlem przez Funnel → budowa Shortcuta „Asystent" na Macu (+ pomiar realnego limitu akcji „Pobierz zawartość URL", ewentualna korekta `ASK_TIMEOUT_MS` w env). Szczegóły: Operator checklist w `ask-endpoint-zadania.md`.

## Ocena ryzyka i mitygacje

- **Refactor executora (U1) na żywym sercu systemu** → charakteryzacja: istniejące testy bez zmian asercji jako twardy gate.
- **Wyścig trzech pisarzy statusu runu** (close handler / reaper / kill) → świeży odczyt z DB przed każdym zapisem + idempotentny finalize + test szwu (lekcja `2026-07-03-stale-obiekt…`).
- **Limit cierpliwości Shortcuts nieznany** (55 s blisko granicy) → `ASK_TIMEOUT_MS` w env, pomiar w fazie 4; fallback „robię w tle" istnieje niezależnie.
- **Sierota OS-owa po restarcie serwera** → wynik przepada, user dostaje ❌ „poproś jeszcze raz"; ryzyko duplikacji side-effectów przy ponownej prośbie świadomie zaakceptowane (skrajny przypadek).
- **Wysoka kadencja runów teczki** → `routine=1` (retencja 24 h, ukrycie z list) + istniejące window function.
- **Rotacja sekretów = restart daemona** (env czytane raz) → udokumentowane, zgodne z konwencją projektu.

## Mierniki sukcesu

- `npm test` zielony na każdym unicie; zero zmian w asercjach istniejących testów.
- Lokalny curl (konspekt E) zwraca odpowiedź text/plain; 403 bez sekretu.
- Po deployu: zapytanie głosowe z Maca wraca w okienku ≤ 55 s; długie zlecenie kończy się dokładnie jednym powiadomieniem.

## Szacunki

Serwer: ~250 linii + testy, 1–2 sesje (konspekt). Rozbicie: U1=M, U2=S, U3=M, U4=L, U5=M, U6=M. Shortcut Mac: ~10 min klikania (operator).

## Źródła

- Requirements doc: brak (rolę pełni `docs/konspekt-endpoint-ask.md`, wersja po roaście 13.07.2026)
- Plan techniczny: `docs/plans/2026-07-13-001-feat-ask-endpoint-asystent-glosowy-plan.md`
