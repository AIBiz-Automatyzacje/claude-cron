# Zadania: Endpoint /ask — asystent głosowy

Branch: `feature/ask-endpoint`
Ostatnia aktualizacja: 2026-07-14 (review fazy 4 — Deploy i Shortcut)

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

- [x] Stwórz `lib/ask.js`: `verifySecret` (porównanie długości buforów PRZED `crypto.timingSafeEqual`; brak konfiguracji = zawsze odmowa)
- [x] Rate limiter (10/min per token) i liczniki współbieżności (1 sync + 3 sloty tła, rezerwacja pesymistyczna przy spawnie) — in-memory, enkapsulowany stan z resetem i wstrzykiwanym zegarem; ZERO agregatów SQL
- [x] Kolejność bramek: auth → rate limit → lock sync („⏳ Jeszcze myślę…") → slot tła („⏳ Mam pełne ręce…"); odmowy jako obiekty decyzji `{status, text}` — mapowanie na HTTP w Unit 5
- [x] `getOrCreateAskJob()`: szukaj po `name: 'Asystent głosowy'`, brak → `db.createJob({…, cron_expr:'', routine:1, discord_notify:0, telegram_notify:0})`; NIGDY nie nadpisuje istniejącego
- [x] Stwórz `lib/ask.test.js`
- [x] Test: zły token / zły sekret / brak sekretu → decyzja 403 bez treści diagnostycznej (trzy przypadki)
- [x] Test: sekrety o różnych długościach nie rzucają wyjątku (guard przed `timingSafeEqual`)
- [x] Test: brak `ASK_TOKEN`/`ASK_SECRET` w konfiguracji → odmowa nawet przy „poprawnym" pustym sekrecie
- [x] Test: 10 zapytań/min przechodzi, 11. → `{status:200, text}` z tekstem rate-limitu; po przesunięciu zegara okno się odnawia
- [x] Test: drugi równoległy sync → tekst „jeszcze myślę"; po zwolnieniu locka kolejny przechodzi
- [x] Test: 3 zajęte sloty tła → „mam pełne ręce" BEZ spawnu; zwolnienie slotu odblokowuje
- [x] Test: `getOrCreateAskJob` × 2 → jeden job; ręczna zmiana `telegram_notify=1` między wywołaniami NIE jest nadpisana
- [x] Weryfikacja: `npm test` przechodzi; `lib/ask.test.js` pokrywa wszystkie scenariusze Unit 3 z asercjami na treść tekstów

## Unit 4: `lib/ask.js` — wykonanie: spawn, odczepienie, powiadomienia (Delegate: feature-builder-data)

- [x] Prompt asystencki (template: pytanie → 2–4 zdania czytane na głos; polecenie → wykonaj + potwierdź jednym zdaniem; BEZ klasyfikacji długie/krótkie) + tekst usera
- [x] Run teczki: `db.createRun({job_id, trigger_type:'ask', webhook_payload: <pytanie>})` → natychmiast `running` + `started_at`
- [x] Spawn helperem: `--dangerously-skip-permissions --output-format text --model <ASK_MODEL> -p <prompt>` (bez `--verbose`)
- [x] Wyścig close vs `ASK_TIMEOUT_MS`: zdążył → updateRun (success/failed) + stdout do handlera; nie zdążył → „⏳ robię w tle", proces ŻYJE (odczepienie bez killa), kontynuacja na close
- [x] Close odczepionego: re-read runu z DB przed zapisem (guard `killed` od reapera/usera) → updateRun → powiadomienie wg flag teczki (surowy stdout, `smartSplit` + `resolveNotifyConfig`; BEZ `extractResult`/`notifyRunOutcome`)
- [x] Seam plain-text w `lib/discord.js`/`lib/telegram.js` (kształt wg uznania implementatora; + testy kanałów jeśli seam tego wymaga)
- [x] `ASK_MAX_MS`: timer → kill drzewa (wzorzec executora) → run `timeout` → ❌
- [x] Idempotentny finalize (jedna funkcja kończąca zadanie odczepione; drugi call = no-op po sprawdzeniu stanu w DB) — strukturalna gwarancja „nigdy cisza"
- [x] Log konsolowy `[ask]` dla każdego wywołania; sync bez powiadomień
- [x] Test: happy path sync (atrapa node przez override binarki) → odpowiedź = stdout, run `success` z pytaniem w `webhook_payload` i odpowiedzią w `stdout`, ZERO wywołań kanałów
- [x] Test: odczepienie (skrypt śpi > testowy `ASK_TIMEOUT_MS`) → „robię w tle", proces NIE ubity, po close run `success` + dokładnie jedno ✅ na zamockowanym kanale
- [x] Test: pad odczepionego procesu (exit≠0) → run `failed` + dokładnie jedno ❌
- [x] Test: przekroczenie `ASK_MAX_MS` (testowo małe) → proces ubity, run `timeout`, dokładnie jedno ❌
- [x] Test: close po oznaczeniu runu `killed` w DB (symulacja reapera/usera) → brak nadpisania statusu, brak podwójnego powiadomienia
- [x] Test: flagi teczki oba 0 → zadanie odczepione loguje warning zamiast cicho zgubić wynik
- [x] Weryfikacja: `npm test` przechodzi; scenariusze Unit 4 w `lib/ask.test.js` z mockami wyłącznie na kanałach, spawn realny przez `node` + skrypty tmp

## Do poprawy po review fazy 2

Pełny raport: `docs/active/ask-endpoint/review-faza-2.md` (0× P1, 1× P2, 14× P3, 1× OPERATOR — gate: ZASTRZEŻENIA).

- [x] 🟠 [P2] **lib/ask.js:296** — Slot tła zwalniany wyłącznie w `settle()` na zdarzeniu `close`, a `killProcessTree` na Unix (lib/ask.js:161-168) zabija tylko bezpośrednie dziecko (SIGTERM/SIGKILL do `proc.pid`, bez grupy procesów). Wnuk CLI dziedziczący stdout/stderr trzyma pipe po SIGKILL rodzica, więc `close` nigdy nie nadchodzi i slot wycieka na zawsze — 3 takie zdarzenia = permanentne „⏳ Mam pełne ręce" (DoS /ask do restartu serwera). Fix: dodatkowo `proc.on('exit', ...)` wołające `settle` — guard `settled` już chroni przed podwójnym zwolnieniem.

P3 (opcjonalne, nie blokują gate'u — szczegóły w raporcie): plik 335 linii → split ask-gates.js + ask.js najtańszy przed Unit 5; ścieżka 403 nielimitowana (brute-force poza rate limitem) — udokumentować trade-off lub luźny licznik 403; `verifySecret` zdradza timingiem długość sekretu (porównanie skrótów SHA-256 zamiast guardu długości); `getOrCreateAskJob` ładuje pełną kolekcję jobów per zapytanie; nieucięty stdout do `sendPlain` (setki POST-ów przy dużym outpucie); `truncateTail` = duplikacja `truncate()` z executora; `isRateLimited` mutuje stan mimo prefixu `is*`; puste `catch {}` w `killProcessTree`; duplikacja literału komunikatu ASK_MAX_MS (linie 282/308); treść `TEXT_DETACHED` niezgodna z literalnym cytatem spec (R5/konspekt); `killProcessTree` duplikuje kill drzewa executora (wersje już się rozjeżdżają); brak testu sync-fail (close z exit≠0 przed timeoutem); brak testu ✅ na obu kanałach naraz przy odczepieniu; brak pokrycia gałęzi obcinania `truncateTail` >50KB.

## Operator checklist faza 2

- [ ] Operator: Gałąź Windows w `lib/ask.js` (`killProcessTree` przez `taskkill /PID /T /F`, lib/ask.js:162) oraz pełny cykl `executeAsk` są niewykonalne do weryfikacji headless na macOS — wszystkie testy spawnu w `lib/ask.test.js` mają skip na win32 (atrapa CLI przez shebang wymaga POSIX) — Operator action: jeśli instalacja Windows ma używać `/ask`, przed deployem uruchomić `node --test lib/ask.test.js` (i pełny `npm test`) na realnej maszynie Windows i potwierdzić, że kill drzewa przez taskkill oraz cykl sync/odczepienie/timeout działają.

## Unit 5: Endpoint `POST /ask/:token` w `server.js` + etykieta triggera (Delegate: feature-builder-data)

- [x] Match `matchAskToken(req.url)` w `server.js` dokładnie MIĘDZY blokiem webhooka a guardem `X-Forwarded-For` + polski komentarz o kontrakcie kolejności
- [x] Handler: `ASK_ENABLED` false → 403; nie-POST → 405; zły token/sekret → 403 bez szczegółów
- [x] Reader surowego body text/plain (NIE `parseBody`); puste body → 200 z przyjaznym tekstem
- [x] Odpowiedzi sukcesu i wszystkie ⏳ jako 200 `Content-Type: text/plain; charset=utf-8`
- [x] Etykieta triggera `ask` w `public/enum-map.js` (+ test jeśli enum-map ma plik testowy)
- [x] Stwórz `lib/ask.http.test.js` (wzorzec `server.env.test.js`: spawn serwera na efemerycznym porcie + fetch)
- [x] Test: POST bez `X-Secret` / ze złym sekretem / ze złym tokenem → 403 (trzy przypadki, body bez szczegółów)
- [x] Test: `ASK_ENABLED` niewłączony → 403 nawet z poprawnymi sekretami
- [x] Test: GET na `/ask/<token>` → 405
- [x] Test: happy path E2E po HTTP (env: override binarki na atrapę, testowe `ASK_TOKEN`/`ASK_SECRET`) → 200 text/plain, body = stdout atrapy; run teczki widoczny przez `GET /api/runs`
- [x] Test: request z `X-Forwarded-For` na `/ask/<token>` przechodzi, a na `/api/jobs` dalej 403 (guard nienaruszony)
- [x] Test: drugi równoległy POST → 200 z tekstem „jeszcze myślę" (asercja na treść)
- [x] Weryfikacja: `npm test` przechodzi; `lib/ask.http.test.js` pokrywa scenariusze Unit 5 na żywym procesie serwera *(review fazy 3: 332 pass, 0 fail)*
- [x] Weryfikacja: smoke curlem (konspekt E) zwraca text/plain — pokryty przez test HTTP happy path *(review fazy 3: wykonany też realny smoke curlem na żywym serwerze z env-override — 200 `text/plain; charset=utf-8` przy poprawnym sekrecie, 403 bez sekretu)*

## Unit 6: Reaper — ❌ „przerwane przez restart" dla runów teczki + test szwu (Delegate: feature-builder-data)

- [x] Zmodyfikuj `lib/db.js`: `reapOrphanedRuns` zwraca listę zebranych runów `{id, job_id}` (SELECT przed UPDATE albo RETURNING); semantyka logu startowego dla zwykłych jobów bez zmian
- [x] Start serwera: runy teczki wśród zebranych → ❌ „przerwane przez restart serwera — poproś jeszcze raz" wg flag teczki (fire-and-forget z `.catch` — pad powiadomienia nie blokuje startu)
- [x] `notifyRunOutcome`/`isFinalFailure` NIETKNIĘTE (kontrakt „killed milczy" dla zwykłych jobów)
- [x] Test: `reapOrphanedRuns` zwraca listę z `job_id`; brak osieroconych → pusta lista (w `lib/db.test.js`)
- [x] Test: test szwu ask+reaper na `:memory:` — run teczki `running` (symulacja odczepionego sprzed restartu) → reap + logika startowa → run `killed`, dokładnie jedno ❌ z tekstem o restarcie (w `lib/ask.test.js`)
- [x] Test: osierocony run ZWYKŁEGO joba → reap bez żadnego powiadomienia
- [x] Weryfikacja: `npm test` przechodzi; test szwu w `lib/ask.test.js` i zwrotka reapera w `lib/db.test.js` pokrywają scenariusze Unit 6 *(review fazy 3: 332 pass, 0 fail)*

## Do poprawy po review fazy 3

Pełny raport: `docs/active/ask-endpoint/review-faza-3.md` (1× P1, 2× P2, 17× P3, 2× OPERATOR — gate: BLOKUJE).

- [x] 🔴 [P1] **server.js:451** — `readTextBody` bez limitu rozmiaru body na publicznym endpoincie `/ask/:token`, a body czytane w całości PRZED autoryzacją. `matchAskToken` to czysty regex (przepuszcza dowolny token), endpoint stoi przed guardem `X-Forwarded-For`, więc przy `ASK_ENABLED=1` nieuwierzytelniony atakujący z internetu (Funnel) streamuje dowolnie duże body — `body += chunk` rośnie bez ograniczeń (rate limit w `admitRequest` liczy się dopiero PO pełnej konsumpcji streama, auth-fail w ogóle nie jest rate-limitowany). Kilka równoległych requestów po kilkaset MB = OOM procesu na VPS = śmierć całego schedulera. Fix: cap (np. 64 KB) — po przekroczeniu `req.destroy()` + odmowa, licznik długości zamiast konkatenacji do skutku.
- [x] 🟠 [P2] **server.js:423** — `readTextBody` buforuje CAŁE body do stringa bez limitu i bez obsługi zdarzenia `error`/`aborted` na streamie requesta (abort klienta w połowie body = `error` bez listenera → ryzyko uncaughtException + nierozwiązana promise, `end` nigdy nie nadejdzie). Nowa instancja wzorca z `parseBody` na NOWEJ publicznej powierzchni. Fix: limit rozmiaru (np. 16 KB, powyżej destroy + 403/413) + listener `error`/`aborted` resolvujący promise (wspólny fix z P1).
- [x] 🟠 [P2] **server.js:422** — `readTextBody` skleja chunki przez `body += chunk` (Buffer.toString() per chunk) bez `req.setEncoding('utf8')` — znak wielobajtowy UTF-8 rozcięty między chunki daje U+FFFD („pytanie o pogod��"); to główna ścieżka wejścia polskiego endpointu głosowego, a granice chunków za proxy Funnel są poza kontrolą. Fix jednoliniowy: `req.setEncoding('utf8')` przed handlerem `data`.

P3 (opcjonalne, nie blokują gate'u — szczegóły w raporcie): `parseBody` (server.js:41) z tą samą luką unbounded body na publicznym webhooku (pre-existing — najlepiej wspólny helper czytania body z limitem); ścieżka 403 poza rate limitem (brute-force token+sekret bez lockoutu, brak wymuszania entropii sekretów); 405 przed auth = fingerprinting `ASK_ENABLED`; wisząca Promise `readTextBody` przy zerwaniu połączenia; lookup teczki przez pełny skan `getAllJobs().find` zduplikowany w 2 miejscach (→ `findAskJob()`/`db.getJobByName`); `lib/ask.js` 385 linii i 3 odpowiedzialności (→ wydzielić `ask-notify.js`); N przerwanych runów teczki = N identycznych ❌ bez skrótu pytania; leaky abstraction pary rezerwacji w `server.js:461` (→ `ask.releaseAdmission()`); `TEXT_EMPTY_QUESTION` poza katalogiem tekstów w `lib/ask.js`; R11 „logowanie każdego wywołania" bez odmów (403/rate-limit/puste body bez śladu w konsoli); guard `!reapedRuns` na niemożliwy scenariusz; nowe env-vary `CLAUDE_CRON_DB_PATH`/`CLAUDE_CRON_CLAUDE_BIN` niedopisane do `CLAUDE.md`; brak testu granicy rozmiaru body (po fixie P1); test pustego body nie asertuje „bez tworzenia runu"; `waitForServerReady` skopiowane 1:1 z `server.env.test.js`; brak testu z wieloma przerwanymi runami teczki naraz.

## Operator checklist faza 3

- [x] Operator: Happy path z PRAWDZIWĄ binarką `claude` (OAuth token z `~/.claude-cron-oauth-token`, model sonnet) oraz dostępność `/ask` przez realny Tailscale Funnel są niewykonalne headless — testy pokrywają to atrapą CLI i nagłówkiem `X-Forwarded-For` symulującym Funnel — Operator action: po deployu na VPS wykonać smoke-test curlem z innej maszyny przez Funnel (poprawny sekret → odpowiedź; bez sekretu → 403) — pokrywa się z pozycjami Operator checklist planu. *(2026-07-14: wykonane, oba przypadki OK)*
- [x] Operator: Granica Funnel/XFF w realnej sieci i limit czekania Shortcuts są niewykonalne headless (testy HTTP pokrywają logikę lokalnie) — Operator action: deploy na VPS z realnymi `ASK_TOKEN`/`ASK_SECRET`; test curlem z innej maszyny przez Tailscale Funnel; włączyć kanał powiadomień na jobie „Asystent głosowy" w panelu; zbudować Shortcut na Macu i zmierzyć realny limit czekania akcji „Pobierz zawartość URL" (w razie potrzeby obniżyć `ASK_TIMEOUT_MS` w env). *(2026-07-21: wszystko wykonane — patrz Operator checklist wyżej)*

## Operator checklist (poza automatyzacją — odznacza człowiek)

- [x] Deploy: merge do `main`, pull na VPS, `ASK_*` do env (długie losowe `ASK_TOKEN`/`ASK_SECRET`), restart daemona; sprawdzić, że `~/.claude-cron-oauth-token` przeżył *(2026-07-14: sekrety w `data/puls.env` chmod 600 + `EnvironmentFile` w unicie systemd)*
- [x] W panelu Pulsa włączyć kanał powiadomień (Telegram lub Discord) na jobie „Asystent głosowy" (powstaje automatycznie przy pierwszym `/ask`) *(2026-07-21: Discord włączony, potwierdzony realnym ✅ na kanale)*
- [x] Test curlem z innej maszyny przez Funnel (poprawny sekret → odpowiedź; bez sekretu → 403) *(2026-07-14: smoke testy przeszły)*
- [x] Zbudować Shortcut „Asystent" na Macu (Dyktuj → Pobierz zawartość URL → Okno dialogowe → Powiedz tekst Zosia Enhanced); zmierzyć realny limit czekania akcji „Pobierz zawartość URL", w razie potrzeby obniżyć `ASK_TIMEOUT_MS` w env *(2026-07-21: Shortcut przeżył pełne 55 s — dostał „⏳ robię w tle" zamiast timeoutu, `ASK_TIMEOUT_MS` bez zmian; „Powiedz" usunięte — Zosia przekręca cyfry, ElevenLabs odłożony)*
- [x] Wybrać hotkey (Shortcuts.app/Raycast) i tryb dyktowania (Apple vs VoiceInk) *(2026-07-21: Ctrl+A + VoiceInk (Whisper) — dyktowanie Apple odrzucone, bo polski model nie łapie anglicyzmów („Meta", „Moonshot"). One-button flow: skrót snapshotuje schowek, Toggle VoiceInk Recorder, pętla 90×1 s polluje schowek, po zmianie POST + Pokaż + Zatrzymaj skrót; stop nagrywania hotkeyem VoiceInk)*
- [x] Po wdrożeniu: dopisać `/ask`, `lib/ask.js`, `lib/claude-spawn.js` do `CLAUDE.md` (architektura + granice bezpieczeństwa) *(fix po review fazy 4 — dopisane w sekcjach „Architektura backendu" i „server.js — HTTP i granice bezpieczeństwa")*

## Do poprawy po review fazy 4

Pełny raport: `docs/active/ask-endpoint/review-faza-4.md` (KOD/TEST/E2E: 0× P1, 1× P2, 3× P3; OPERATOR: 5 — gate: ZASTRZEŻENIA).

- [x] 🟠 [P2] **CLAUDE.md** (via ask-endpoint-zadania.md:139) — jedyny headless-wykonalny deliverable fazy 4 niewykonany: plan (sekcja „Dokumentacja / Notatki operacyjne") wymaga dopisania `/ask` do sekcji „server.js — HTTP i granice bezpieczeństwa" oraz `lib/ask.js`+`lib/claude-spawn.js` do „Architektura backendu", a grep `CLAUDE.md` nie znajduje żadnej wzmianki o `/ask`, `lib/ask.js` ani `lib/claude-spawn.js` — mimo `execute=done` w `.autopilot-state.json`. Implementacja (fazy 1–3) ukończona, więc warunek „po implementacji" zachodzi. Przy tej samej edycji domknąć P3-15 z review fazy 3: nieudokumentowane env-vary `CLAUDE_CRON_DB_PATH`/`CLAUDE_CRON_CLAUDE_BIN`.

P3 (opcjonalne, nie blokują gate'u — szczegóły w raporcie): checklist deployu mówi „długie losowe `ASK_TOKEN`/`ASK_SECRET`" bez konkretnej komendy generacji (entropia sekretów to jedyna obrona ścieżki 403 poza rate limitem — dopisać np. `openssl rand -hex 32` ×2); `.autopilot-state.json` ma `execute:'done'` dla fazy 4 mimo zera odhaczonych pozycji checklisty (konwencja „done = brak pracy automatyzowalnej" nigdzie nie zapisana — ryzyko fałszywego domknięcia zadania przy archiwizacji); bookkeeping review fazy 3 wisi niezacommitowany w working tree (zmodyfikowany kontekst, untracked `review-faza-3.md` + `.autopilot-state.json`) — do commitu przy najbliższym kroku pipeline'u.

## Operator checklist faza 4

- [x] Operator: Cała substancja fazy 4 (deploy publicznej powierzchni `/ask`) jest niewykonalna headless i pozostaje NIEZWERYFIKOWANA (P1) — granica auth nowego publicznego endpointu udowodniona wyłącznie testami z symulowanym `X-Forwarded-For` i atrapą CLI — Operator action: merge do `main`, pull na VPS, wpisać do env długie losowe `ASK_TOKEN`/`ASK_SECRET` (np. `openssl rand -hex 32` per sekret), restart daemona (env NIE propaguje się do żyjącego procesu — learned pattern 2026-07-07), sprawdzić że `~/.claude-cron-oauth-token` przeżył deploy. *(2026-07-14: wykonane)*
- [x] Operator: Smoke-test granicy bezpieczeństwa w realnej sieci niewykonalny headless (P1) — testy fazy 3 pokrywają to atrapą CLI i symulowanym nagłówkiem XFF — Operator action: po deployu curl z INNEJ maszyny przez Tailscale Funnel (poprawny sekret → odpowiedź text/plain; bez sekretu → 403) oraz włączyć kanał powiadomień (Telegram lub Discord) na jobie „Asystent głosowy" w panelu Pulsa (job powstaje przy pierwszym `/ask`; bez flagi kanału wynik odczepionego zapytania ginie — tylko warning w logu). Pozycje 2–3 checklisty deployu powyżej. *(2026-07-21: smoke 2026-07-14, Discord na teczce włączony i potwierdzony realną odpowiedzią odczepioną)*
- [x] Operator: Budowa Shortcuta „Asystent" na Macu i pomiar realnego limitu czekania akcji „Pobierz zawartość URL" niewykonalne headless (P2) — 55 s jest blisko typowych limitów Shortcuts, pomiar to jawna mitygacja ryzyka z planu — Operator action: zbudować Shortcut (Dyktuj → Pobierz zawartość URL → Okno dialogowe → Powiedz tekst), zmierzyć limit; strona kodowa gotowa — `ASK_TIMEOUT_MS` ma override z env (fix P2 fazy 1), korekta bez zmiany kodu. *(2026-07-21: Shortcut przeżył pełne 55 s i pokazał „⏳ robię w tle" — limit Shortcuts wystarcza, `ASK_TIMEOUT_MS` bez zmian)*
- [x] Operator: Shortcut przechowuje `ASK_SECRET` plaintext w definicji akcji i domyślnie synchronizuje się przez iCloud na wszystkie urządzenia konta (P3, spójne z poziomem zaufania projektu — sekrety plaintext „jak shell RC") — Operator action: świadoma decyzja przy budowie Shortcuta; przy podejrzeniu wycieku rotacja wg planu (nowe wartości w env + restart daemona). *(2026-07-21: zaakceptowane świadomie)*
- [ ] Operator: Gałąź Windows w `lib/ask.js` (`killProcessTree` przez `taskkill /PID /T /F`) i pełny cykl `executeAsk` mają skip testów na win32 (P3, atrapa CLI wymaga POSIX shebang) — Operator action: jeśli jakakolwiek instalacja Windows ma używać `/ask`, przed deployem odpalić `node --test lib/ask.test.js` + pełny `npm test` na realnej maszynie Windows.
