# Zadania: Endpoint /ask — asystent głosowy

Branch: `feature/ask-endpoint`
Ostatnia aktualizacja: 2026-07-14 (po review fazy 1)

Źródło definicji unitów: `docs/plans/2026-07-13-001-feat-ask-endpoint-asystent-glosowy-plan.md`

## Unit 1: Wspólny helper spawnowania Claude — `lib/claude-spawn.js` (Delegate: feature-builder-data)

- [x] Stwórz `lib/claude-spawn.js`: czysty env (strip `CLAUDE_CODE*`+`CLAUDECODE` → OAuth z `readOauthToken` PO stripie), resolve binarki (Windows `where claude` bez `shell:true`), spawn `cwd: WORKSPACE_DIR`, `stdio:['ignore','pipe','pipe']`, `windowsHide:true`; argumenty CLI od wywołującego; override binarki dla testów (wzorzec `db.setDbPath`)
- [x] Przenieś `readOauthToken` do helpera (eksport z `claude-spawn.js`; bez cyklu importów z executorem)
- [x] Zmodyfikuj `lib/executor.js` na użycie helpera — stateful rzeczy (currentProcess, timeouty, watchdog, caffeinate, kill, guard killed, `notifyRunOutcome`) ZOSTAJĄ w executorze
- [x] Stwórz `lib/claude-spawn.test.js`
- [x] Test: env po stripie bez żadnego `CLAUDE_CODE*`/`CLAUDECODE`, z `CLAUDE_CODE_OAUTH_TOKEN` gdy plik tokenu istnieje (kolejność strip→inject)
- [x] Test: brak pliku OAuth (ENOENT) → spawn bez tokenu, bez wyjątku
- [x] Test: spawn z override binarki `node` + skrypt tmp zwraca stdout i kod wyjścia
- [x] Test: argumenty CLI przechodzą do procesu bez modyfikacji (echo argv w skrypcie testowym)
- [x] Weryfikacja: `npm test` przechodzi w całości — w tym istniejące `lib/executor.test.js` i `lib/scheduler.test.js` bez zmian asercji
- [x] Weryfikacja: `lib/claude-spawn.test.js` pokrywa scenariusze powyżej i przechodzi

## Unit 2: Konfiguracja `ASK_*` i matcher tokenu (Delegate: feature-builder-data)

- [x] Zmodyfikuj `lib/config.js`: sekcja `// Ask (asystent głosowy)` — `ASK_ENABLED` (opt-in, default false), `ASK_TOKEN`, `ASK_SECRET`, `ASK_TIMEOUT_MS` 55000, `ASK_MAX_MS` 600000, `ASK_MODEL` 'sonnet'; wszystkie w `module.exports`
- [x] Zmodyfikuj `lib/webhook.js`: `ASK_URL_PATTERN` + `matchAskToken(url)` bliźniacze do `matchWebhookToken`
- [x] Test: `matchAskToken('/ask/abc123?x=1')` → `'abc123'`; `/askk/…`, `/ask/`, nie-string → `null` (happy + error path) — w `lib/webhook.test.js`
- [x] Test: defaulty config — `ASK_ENABLED` false bez env, `ASK_TIMEOUT_MS` 55000, `ASK_MODEL` 'sonnet'
- [x] Weryfikacja: `npm test` przechodzi; `lib/webhook.test.js` pokrywa nowy matcher
- [x] Weryfikacja: `node -e "const c=require('./lib/config'); process.exit(c.ASK_ENABLED===false && c.ASK_TIMEOUT_MS===55000 ? 0 : 1)"` kończy się kodem 0

## Do poprawy po review fazy 1

Pełny raport: `docs/active/ask-endpoint/review-faza-1.md` (0× P1, 2× P2, 9× P3, 1× OPERATOR — gate: ZASTRZEŻENIA).

- [x] 🟠 [P2] **lib/claude-spawn.js:65** — Fallback `shell:true` w `resolveClaudeBin` (Windows, gdy `where claude` pada): Node przy `shell:true` NIE escapuje args, więc metaznaki cmd.exe w argumentach wykonują się jako komendy; args zawierają treść atakującego (dziś `webhook_payload` z publicznego `/webhook/:token`, w Unit 4 tekst z publicznego `/ask`). Fix: przy padzie `where` failować run z czytelnym błędem zamiast `shell:true`.
- [x] 🟠 [P2] **lib/config.js:51** — `ASK_TIMEOUT_MS` (55000) i `ASK_MAX_MS` (600000) hardcodowane bez override z env, a plan jawnie zakłada korektę przez env (R6, sekcja Ryzyka, Operator checklist „obniżyć ASK_TIMEOUT_MS w env bez zmiany kodu"). Fix: `Number(process.env.ASK_TIMEOUT_MS) || 55_000` (analogicznie `ASK_MAX_MS`). *(niezweryfikowany adversarially — 0 głosów sceptyków)*

P3 (opcjonalne, nie blokują gate'u — szczegóły w raporcie): log `SPAWN:` w executor.js:96 kłamie o resolved binarce; testy defaultów `ASK_*` w webhook.test.js zależą od ambient env runnera i łamią kolokację (→ config.test.js); brak memoizacji `execSync('where claude')` per spawn; martwy eksport `OAUTH_TOKEN_FILE`; brak testu happy path `ASK_ENABLED='1'` → true; `matchAskToken` bez wariantów „token bez query" i „nielegalny znak"; nieprzetestowana gałąź nie-ENOENT w `readOauthToken`.

## Operator checklist faza 1

- [ ] Operator: Ścieżka Windows w `resolveClaudeBin` (`lib/claude-spawn.js:57` — resolve przez `where claude`, fallback gdy `where` nie znajdzie binarki) jest niewykonalna do weryfikacji headless na Macu (`IS_WIN=false`, gałąź martwa w testach; override binarki ją omija) — Operator action: przy najbliższym teście instalacji Windows (install.ps1/Pester lub ręczny smoke) uruchomić job na maszynie Windows i potwierdzić, że spawn CLI `claude` działa oraz że log pokazuje realnie uruchomioną binarkę.

## Unit 3: `lib/ask.js` — bramki wejścia i teczka (Delegate: feature-builder-data)

- [ ] Stwórz `lib/ask.js`: `verifySecret` (porównanie długości buforów PRZED `crypto.timingSafeEqual`; brak konfiguracji = zawsze odmowa)
- [ ] Rate limiter (10/min per token) i liczniki współbieżności (1 sync + 3 sloty tła, rezerwacja pesymistyczna przy spawnie) — in-memory, enkapsulowany stan z resetem i wstrzykiwanym zegarem; ZERO agregatów SQL
- [ ] Kolejność bramek: auth → rate limit → lock sync („⏳ Jeszcze myślę…") → slot tła („⏳ Mam pełne ręce…"); odmowy jako obiekty decyzji `{status, text}` — mapowanie na HTTP w Unit 5
- [ ] `getOrCreateAskJob()`: szukaj po `name: 'Asystent głosowy'`, brak → `db.createJob({…, cron_expr:'', routine:1, discord_notify:0, telegram_notify:0})`; NIGDY nie nadpisuje istniejącego
- [ ] Stwórz `lib/ask.test.js`
- [ ] Test: zły token / zły sekret / brak sekretu → decyzja 403 bez treści diagnostycznej (trzy przypadki)
- [ ] Test: sekrety o różnych długościach nie rzucają wyjątku (guard przed `timingSafeEqual`)
- [ ] Test: brak `ASK_TOKEN`/`ASK_SECRET` w konfiguracji → odmowa nawet przy „poprawnym" pustym sekrecie
- [ ] Test: 10 zapytań/min przechodzi, 11. → `{status:200, text}` z tekstem rate-limitu; po przesunięciu zegara okno się odnawia
- [ ] Test: drugi równoległy sync → tekst „jeszcze myślę"; po zwolnieniu locka kolejny przechodzi
- [ ] Test: 3 zajęte sloty tła → „mam pełne ręce" BEZ spawnu; zwolnienie slotu odblokowuje
- [ ] Test: `getOrCreateAskJob` × 2 → jeden job; ręczna zmiana `telegram_notify=1` między wywołaniami NIE jest nadpisana
- [ ] Weryfikacja: `npm test` przechodzi; `lib/ask.test.js` pokrywa wszystkie scenariusze Unit 3 z asercjami na treść tekstów

## Unit 4: `lib/ask.js` — wykonanie: spawn, odczepienie, powiadomienia (Delegate: feature-builder-data)

- [ ] Prompt asystencki (template: pytanie → 2–4 zdania czytane na głos; polecenie → wykonaj + potwierdź jednym zdaniem; BEZ klasyfikacji długie/krótkie) + tekst usera
- [ ] Run teczki: `db.createRun({job_id, trigger_type:'ask', webhook_payload: <pytanie>})` → natychmiast `running` + `started_at`
- [ ] Spawn helperem: `--dangerously-skip-permissions --output-format text --model <ASK_MODEL> -p <prompt>` (bez `--verbose`)
- [ ] Wyścig close vs `ASK_TIMEOUT_MS`: zdążył → updateRun (success/failed) + stdout do handlera; nie zdążył → „⏳ robię w tle", proces ŻYJE (odczepienie bez killa), kontynuacja na close
- [ ] Close odczepionego: re-read runu z DB przed zapisem (guard `killed` od reapera/usera) → updateRun → powiadomienie wg flag teczki (surowy stdout, `smartSplit` + `resolveNotifyConfig`; BEZ `extractResult`/`notifyRunOutcome`)
- [ ] Seam plain-text w `lib/discord.js`/`lib/telegram.js` (kształt wg uznania implementatora; + testy kanałów jeśli seam tego wymaga)
- [ ] `ASK_MAX_MS`: timer → kill drzewa (wzorzec executora) → run `timeout` → ❌
- [ ] Idempotentny finalize (jedna funkcja kończąca zadanie odczepione; drugi call = no-op po sprawdzeniu stanu w DB) — strukturalna gwarancja „nigdy cisza"
- [ ] Log konsolowy `[ask]` dla każdego wywołania; sync bez powiadomień
- [ ] Test: happy path sync (atrapa node przez override binarki) → odpowiedź = stdout, run `success` z pytaniem w `webhook_payload` i odpowiedzią w `stdout`, ZERO wywołań kanałów
- [ ] Test: odczepienie (skrypt śpi > testowy `ASK_TIMEOUT_MS`) → „robię w tle", proces NIE ubity, po close run `success` + dokładnie jedno ✅ na zamockowanym kanale
- [ ] Test: pad odczepionego procesu (exit≠0) → run `failed` + dokładnie jedno ❌
- [ ] Test: przekroczenie `ASK_MAX_MS` (testowo małe) → proces ubity, run `timeout`, dokładnie jedno ❌
- [ ] Test: close po oznaczeniu runu `killed` w DB (symulacja reapera/usera) → brak nadpisania statusu, brak podwójnego powiadomienia
- [ ] Test: flagi teczki oba 0 → zadanie odczepione loguje warning zamiast cicho zgubić wynik
- [ ] Weryfikacja: `npm test` przechodzi; scenariusze Unit 4 w `lib/ask.test.js` z mockami wyłącznie na kanałach, spawn realny przez `node` + skrypty tmp

## Unit 5: Endpoint `POST /ask/:token` w `server.js` + etykieta triggera (Delegate: feature-builder-data)

- [ ] Match `matchAskToken(req.url)` w `server.js` dokładnie MIĘDZY blokiem webhooka a guardem `X-Forwarded-For` + polski komentarz o kontrakcie kolejności
- [ ] Handler: `ASK_ENABLED` false → 403; nie-POST → 405; zły token/sekret → 403 bez szczegółów
- [ ] Reader surowego body text/plain (NIE `parseBody`); puste body → 200 z przyjaznym tekstem
- [ ] Odpowiedzi sukcesu i wszystkie ⏳ jako 200 `Content-Type: text/plain; charset=utf-8`
- [ ] Etykieta triggera `ask` w `public/enum-map.js` (+ test jeśli enum-map ma plik testowy)
- [ ] Stwórz `lib/ask.http.test.js` (wzorzec `server.env.test.js`: spawn serwera na efemerycznym porcie + fetch)
- [ ] Test: POST bez `X-Secret` / ze złym sekretem / ze złym tokenem → 403 (trzy przypadki, body bez szczegółów)
- [ ] Test: `ASK_ENABLED` niewłączony → 403 nawet z poprawnymi sekretami
- [ ] Test: GET na `/ask/<token>` → 405
- [ ] Test: happy path E2E po HTTP (env: override binarki na atrapę, testowe `ASK_TOKEN`/`ASK_SECRET`) → 200 text/plain, body = stdout atrapy; run teczki widoczny przez `GET /api/runs`
- [ ] Test: request z `X-Forwarded-For` na `/ask/<token>` przechodzi, a na `/api/jobs` dalej 403 (guard nienaruszony)
- [ ] Test: drugi równoległy POST → 200 z tekstem „jeszcze myślę" (asercja na treść)
- [ ] Weryfikacja: `npm test` przechodzi; `lib/ask.http.test.js` pokrywa scenariusze Unit 5 na żywym procesie serwera
- [ ] Weryfikacja: smoke curlem (konspekt E) zwraca text/plain — pokryty przez test HTTP happy path

## Unit 6: Reaper — ❌ „przerwane przez restart" dla runów teczki + test szwu (Delegate: feature-builder-data)

- [ ] Zmodyfikuj `lib/db.js`: `reapOrphanedRuns` zwraca listę zebranych runów `{id, job_id}` (SELECT przed UPDATE albo RETURNING); semantyka logu startowego dla zwykłych jobów bez zmian
- [ ] Start serwera: runy teczki wśród zebranych → ❌ „przerwane przez restart serwera — poproś jeszcze raz" wg flag teczki (fire-and-forget z `.catch` — pad powiadomienia nie blokuje startu)
- [ ] `notifyRunOutcome`/`isFinalFailure` NIETKNIĘTE (kontrakt „killed milczy" dla zwykłych jobów)
- [ ] Test: `reapOrphanedRuns` zwraca listę z `job_id`; brak osieroconych → pusta lista (w `lib/db.test.js`)
- [ ] Test: test szwu ask+reaper na `:memory:` — run teczki `running` (symulacja odczepionego sprzed restartu) → reap + logika startowa → run `killed`, dokładnie jedno ❌ z tekstem o restarcie (w `lib/ask.test.js`)
- [ ] Test: osierocony run ZWYKŁEGO joba → reap bez żadnego powiadomienia
- [ ] Weryfikacja: `npm test` przechodzi; test szwu w `lib/ask.test.js` i zwrotka reapera w `lib/db.test.js` pokrywają scenariusze Unit 6

## Operator checklist (poza automatyzacją — odznacza człowiek)

- [ ] Deploy: merge do `main`, pull na VPS, `ASK_*` do env (długie losowe `ASK_TOKEN`/`ASK_SECRET`), restart daemona; sprawdzić, że `~/.claude-cron-oauth-token` przeżył
- [ ] W panelu Pulsa włączyć kanał powiadomień (Telegram lub Discord) na jobie „Asystent głosowy" (powstaje automatycznie przy pierwszym `/ask`)
- [ ] Test curlem z innej maszyny przez Funnel (poprawny sekret → odpowiedź; bez sekretu → 403)
- [ ] Zbudować Shortcut „Asystent" na Macu (Dyktuj → Pobierz zawartość URL → Okno dialogowe → Powiedz tekst Zosia Enhanced); zmierzyć realny limit czekania akcji „Pobierz zawartość URL", w razie potrzeby obniżyć `ASK_TIMEOUT_MS` w env
- [ ] Wybrać hotkey (Shortcuts.app/Raycast) i tryb dyktowania (Apple vs VoiceInk)
- [ ] Po wdrożeniu: dopisać `/ask`, `lib/ask.js`, `lib/claude-spawn.js` do `CLAUDE.md` (architektura + granice bezpieczeństwa)
