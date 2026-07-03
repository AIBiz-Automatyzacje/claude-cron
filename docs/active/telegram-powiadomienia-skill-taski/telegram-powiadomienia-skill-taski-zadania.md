# Zadania: Telegram, konfiguracja powiadomień raz-lokalnie, skill puls, podstawowe taski

Branch: `feature/telegram-powiadomienia-skill-taski`
Ostatnia aktualizacja: 2026-07-03

## Faza 1 — fundament powiadomień

### Unit 1: Wspólny moduł formatowania powiadomień (`notify-format`)

- [x] Stwórz `lib/notify-format.js` (przeniesienie 1:1 `extractResult` + `smartSplit` z `lib/discord.js`)
- [x] Stwórz `lib/notify-format.test.js`
- [x] Modyfikuj `lib/discord.js` (import z notify-format; grep konsumentów eksportów `extractResult`/`smartSplit` przed usunięciem re-eksportu)
- [x] Test: `extractResult` — stdout z wpisem `type:'result'` → treść; brak wpisu → fallback „Job completed…"; niepoprawny JSON w linii nie wywala parsowania
- [x] Test: `smartSplit` — tekst < maxLen → 1 chunk; podział po `\n`, potem `. `; słowo > maxLen → twardy podział; każdy chunk ≤ maxLen
- [x] Weryfikacja: `npm test` przechodzi; `node --test lib/notify-format.test.js` zielony (review fazy 1: 202/202 i 10/10, exit 0)

### Unit 2: Konfiguracja powiadomień w `state` + endpointy settings i push-to-vps

- [x] Stwórz `lib/notify-config.js` (`resolveNotifyConfig(stateGetter, env)`: state niepusty > env; maskowanie — configured + ostatnie 4 znaki)
- [x] Stwórz `lib/notify-config.test.js`
- [x] Stwórz `lib/notify-push.js` (push na VPS: PUT `<vpsUrl>/api/settings/notifications` + potwierdzenie GET-em po zapisie; `{ok, reason}` bez rzucania)
- [x] Stwórz `lib/notify-push.test.js`
- [x] Modyfikuj `lib/config.js` (eksport `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`)
- [x] Modyfikuj `lib/discord.js` (webhook URL rozwiązywany przy wysyłce: state → env fallback)
- [x] Modyfikuj `server.js` (route'y `GET/PUT /api/settings/notifications` + `POST /api/settings/notifications/push-to-vps`; PUT: whitelist 3 kluczy, tylko stringi, pusty string czyści)
- [x] Test: `resolveNotifyConfig` — state ustawiony → wygrywa; state pusty + env → env; oba puste → kanał nieskonfigurowany
- [x] Test: maskowanie — token 46-znakowy → `…ostatnie 4`; pusty → `configured:false`
- [x] Test: sanityzacja PUT body — nieznane klucze odrzucone, nie-string odrzucony
- [x] Test: `notify-push` z mock fetch — sukces potwierdzony GET-em po PUT; VPS bez endpointu (404) → `{ok:false, reason}` bez rzucania; timeout → `{ok:false}`
- [x] Weryfikacja: `npm test` zielony; `curl PUT` + `curl GET` na działającym serwerze zwracają zapisany (zamaskowany) stan (review fazy 1: curl E2E S1–S5 passed na izolowanej instancji — maski, 400 na nieznany klucz, czyszczenie pustym stringiem, 503 push bez VPS; szczegóły w `review-faza-1.md`)

## Do poprawy po review fazy 1

- [x] 🟠 [P2] **lib/notify-push.js:38** — `new URL(SETTINGS_PATH, vpsUrl)` stoi PRZED blokiem try i łamie udokumentowany kontrakt "NIGDY nie rzuca — zawsze {ok, reason?}": `CLAUDE_CRON_VPS_URL` bez protokołu (np. `localhost:7777`) rzuca `TypeError: Invalid URL` → POST push-to-vps kończy się generycznym 500 zamiast zmapowanego statusu, a setup.mjs (Unit 6) dostanie goły wyjątek. Fix: guard/try na parsowanie URL → `{ok:false, reason:'invalid_vps_url'}` + test w `lib/notify-push.test.js`
- [x] 🟠 [P2] **lib/discord.js:38** — zmienione zachowanie produkcyjne `sendNotification` (webhook URL rozwiązywany przy każdej wysyłce przez `resolveNotifyConfig(db.getState, process.env)` zamiast zamrożenia przy require) nie ma żadnego testu — `lib/discord.test.js` nie istnieje, a wysyłka jest fire-and-forget z `.catch(()=>{})`, więc regresja wiringowa (zły getter/klucz) przeszłaby niezauważona. Fix: minimalny `lib/discord.test.js` z mockiem `getState` (state wygrywa; env fallback; oba puste → early return bez sieci)
- [x] 🟡 [P3] **lib/notify-format.js:40** — off-by-one w `smartSplit`: gdy `'. '` zaczyna się dokładnie na indeksie maxLen, chunk ma maxLen+1 znaków (potwierdzone repro) — narusza kontrakt "każdy chunk ≤ maxLen"; w fazie 2 Telegram dostanie 4097 znaków → API 400, chunk cicho zgubiony. Naprawić przed fazą 2 + test brzegowy (naprawione w fixie po review fazy 2 — razem z eskalacją do P2)
- [x] 🟡 [P3] **lib/notify-format.js:42** — `smartSplit` może zwrócić pusty chunk (`smartSplit('\n'.repeat(30), 10)` → `[""]`): `trimEnd()` po podziale na granicy `\n` produkuje `''` pushowane bez guardu → pusty content do Discord/Telegram = 400. Naprawić przed fazą 2 + test brzegowy
- [ ] 🟡 [P3] **lib/notify-push.js:63** — reason w catch to wolny tekst `error_${err.message}` zwracany w body 502 do przeglądarki: wyciek szczegółów sieci wewnętrznej, łamie enum-owy kontrakt reason, przy błędzie bez message daje `error_undefined`. Fix: stały kod `'network_error'` (+ ewentualnie osobne pole detail logowane server-side); skorygować test `notify-push.test.js` matchujący `/ECONNREFUSED/`
- [ ] 🟡 [P3] **lib/notify-config.js:56** — `sanitizeNotifySettings` waliduje tylko whitelist kluczy i typ string: brak walidacji formatu (`discord_webhook_url` dowolny string, `telegram_chat_id` dowolny string) i limitu długości — nie-URL cicho zabija powiadomienia (`.catch(()=>{})` w executor), dowolny host = eksfiltracja outputów jobów, domyka też wektor stored-XSS przed Unit 5. Fix: walidacja URL (https + host discord.com/discordapp.com), chat_id `^-?\d+$|^@\w+$`, max length

Pozostałe P3 (10 pozycji: martwe eksporty config.js, parseBody malformed JSON→200, maskSecret dla krótkich wartości, bind na wszystkich interfejsach [pre-existing, osobne zadanie], mapowanie reason→status bez testu, extractResult na pełnym stdout, 3 klucze zamiast 1 w discord.js, setState bez transakcji, drugi format błędu {ok,reason}, duplikacja PUSH_TIMEOUT_MS) — szczegóły i rekomendacje w `review-faza-1.md`; do rozważenia przy fazie 2, nie blokują.

## Faza 2 — Telegram

### Unit 3: Kanał Telegram end-to-end + powiadomienia o failach (R9)

- [x] Stwórz `lib/telegram.js` (`buildMessages(jobName, stdout)` czysta; `sendNotification` — POST `api.telegram.org/bot<TOKEN>/sendMessage`, plain text bez parse_mode, chunking 4096, nagłówek `✅ <job.name>` w pierwszym chunku)
- [x] Stwórz `lib/telegram.test.js`
- [x] Wariant fail (R9): `❌ <job.name> padł (<status>)` + skrót `error_msg`/ogon stderr — w `lib/telegram.js` ORAZ `lib/discord.js` (czerwony embed `0xFF0000`)
- [x] Modyfikuj `lib/db.js` (kolumna `telegram_notify INTEGER DEFAULT 0`: CREATE TABLE ~42, migracja `PRAGMA table_info` ~105-116, `createJob` 164/166/169, `updateJob` allowed 174 + koercja bool 181)
- [x] Modyfikuj `lib/db.test.js` (create/update z `telegram_notify`)
- [x] Modyfikuj `lib/executor.js` (oba punkty ~220-222 i ~295-297: sukces jak dziś dla obu kanałów wg flag; ostateczny `fail`/`timeout` po wyczerpaniu retry → wariant fail dla obu kanałów; nigdy przy `killed`; fire-and-forget `.catch(() => {})`)
- [x] Test: `buildMessages` — krótki wynik → 1 wiadomość z nagłówkiem; wynik > 4096 → N chunków ≤ 4096, nagłówek tylko w pierwszym
- [x] Test: brak konfiguracji (token/chat puste w state i env) → early return, zero prób sieciowych
- [x] Test: DB — `createJob({telegram_notify:true})` → 1; `updateJob` koerca `false`→0; stara baza po migracji ma kolumnę z defaultem 0
- [x] Test: fail — status `fail` z wyczerpanymi retry + flaga → wiadomość ❌ z `error_msg`; `killed` → brak wysyłki; retry jeszcze dostępne → brak wysyłki
- [x] Weryfikacja: `npm test` zielony (w tym `node --test lib/telegram.test.js`, `lib/db.test.js`) (review fazy 2: `npm test` 230/230 i `node --test lib/telegram.test.js lib/db.test.js` 41/41, exit 0)

### Unit 4: Checkbox „Powiadomienie Telegram" per job w dashboardzie

- [x] Modyfikuj `public/index.html` (checkbox `form-telegram` obok `form-discord` ~244; hint akordeonu „…Discord · Telegram" ~228)
- [x] Modyfikuj `public/app.js` (reset ~821; `!!job.telegram_notify` w edit ~865; `telegram_notify` w body save ~920)
- [x] Test: [E2E] `localhost:7777` — dodaj job z zaznaczonym Telegramem → `GET /api/jobs` zwraca `telegram_notify:1`; edytuj job → checkbox odzwierciedla stan z bazy
- [x] Weryfikacja: scenariusz E2E przez agent-browser przechodzi (formularz zapisuje i odczytuje flagę) (review fazy 2: PASS na świeżej instancji z kodem fazy 2, port 7799 — zapis `telegram_notify:1`, edycja odzwierciedla stan, odznaczenie → 0; produkcyjny `localhost:7777` wymaga restartu serwera — patrz Operator checklist faza 2)

## Do poprawy po review fazy 2

- [x] 🔴 [P1] **lib/executor.js:43** — suppresja powiadomienia ❌ w `isFinalFailure` zakłada, że scheduler zrobi retry, ale retry NIGDY nie odpala: `scheduler.js:29` sprawdza `run.status === 'failed'` na stale-owym obiekcie z `getQueuedRuns()` (in-memory status to zawsze `'queued'`; `executeRun` pisze status tylko do DB przez `db.updateRun`, nie mutuje przekazanego obiektu). Skutek: job z domyślnym `max_retries=1` po pierwszym failu → brak ❌ i brak retry → user nie dostaje NIC (R9 cicho złamane w domyślnej konfiguracji). Fix: naprawić odczyt statusu w `scheduler.processQueue` (re-read runu z DB po `executeRun`) albo liczyć ostateczność failu w executorze bez założenia o retry
- [x] 🔴 [P1] **lib/scheduler.js:29** — R9 („wysyłka po ostatecznym failu po wyczerpaniu retry") pozornie zaimplementowane, w praktyce BŁĘDNE dla domyślnej konfiguracji: retry w `processQueue` jest martwe (warunek czyta obiekt sprzed `executeRun`, status idzie wyłącznie do DB), a `isFinalFailure` wstrzymuje ❌ dopóki faile nie PRZEKROCZĄ `max_retries`. Scenariusz: `max_retries=1` (default) + flaga kanału; run pada → brak ❌, retry nie powstaje; ❌ przyjdzie dopiero po drugim failu z rzędu przy następnym runie z crona (może po dobie). Fix: scheduler po `executeRun` czyta świeży status z DB (albo executor zwraca status) + test integracyjny fail→retry→❌ (wspólny fix z poprzednim P1)
- [x] 🟠 [P2] **lib/telegram.js:43** — DoS przez nieskończoną pętlę: `buildMessages` liczy limit chunka jako `TELEGRAM_MAX_LEN - header.length - 1`; przy nazwie joba ≥ ~4090 znaków limit jest ujemny i `smartSplit` z ujemnym `maxLen` wpada w nieskończoną SYNCHRONICZNĄ pętlę (slice z ujemnym indeksem nie zmniejsza `remaining`) — blokuje cały event loop serwera. `POST /api/jobs` nie waliduje długości `name`, ścieżka osiągalna z API. Fix: guard `Math.max(1, ...)` w `buildMessages` i/lub walidacja długości `name` na granicy API; `smartSplit` fail-fast przy `maxLen <= 0`
- [x] 🟠 [P2] **lib/notify-format.js:40** — off-by-one w `smartSplit` przeniesiony do fazy 2 mimo wymogu naprawy PRZED fazą 2 (`zadania.md:36`): gdy `'. '` zaczyna się dokładnie na indeksie `maxLen`, chunk ma `maxLen+1` znaków — repro: pierwsza wiadomość Telegrama 4097 > 4096 → Bot API 400, pozostałe chunki niewysłane, `.catch(()=>{})` połyka błąd, całe powiadomienie cicho przepada. Fix + test brzegowy dokładnie na granicy (eskalacja otwartego P3 z review fazy 1)
- [x] 🟠 [P2] **lib/executor.js:37** — `notifyRunOutcome` (nowy wspólny punkt decyzyjny powiadomień: gating flag `discord_notify`/`telegram_notify`, rozgałęzienie success→`sendNotification` vs final-fail→`sendFailureNotification`, `countRecentFailedRuns` PO `db.updateRun`, niezależność kanałów) nie ma ŻADNEGO testu — regresja zamiany funkcji/odwróconych flag przeszłaby cały suite; checkbox `zadania.md:56` odhaczony mimo braku testu tej ścieżki. Fix: eksport/DI `notifyRunOutcome` + test z mockami kanałów
- [x] 🟠 [P2] **lib/executor.js:242** — nowy guard `killed` (odczyt `priorRun` z DB w close handlerach: 242-243 ścieżka claude, 326-327 ścieżka script) bez testu — samo WYKRYCIE killed jest nieasertowane (`killCurrent` zapisuje `'killed'` w DB zanim proces się domknie; bez odczytu `priorRun` close policzyłby `'failed'` i R9 wysłałoby ❌ mimo świadomego ubicia). Regresja usuwająca odczyt `priorRun` przeszłaby suite. Fix: test integracyjny na DB `:memory:`
- [x] 🟡 [P3] **lib/notify-format.js:42** — pusty chunk w `smartSplit` (repro: `smartSplit('\n'.repeat(30), 10)` → `[""]`) przeniesiony do fazy 2 mimo wymogu naprawy PRZED fazą 2 (`zadania.md:37`) — `buildMessages` wyśle pusty `text` → Telegram 400, powiadomienie cicho zgubione. Fix + test brzegowy (domknąć razem z P2 off-by-one)
- [x] 🟡 [P3] **lib/executor.js:39** — cztery nowe puste `.catch(() => {})` w `notifyRunOutcome` łamią regułę „NIGDY pusty catch": błędny token/chat_id = powiadomienia cicho nie dochodzą, zero śladu do diagnozy. Fix: `.catch(err => console.error('[notify]', err.message))` (komunikat telegram.js celowo bez path/tokenu)
- [x] 🟡 [P3] **lib/executor.js:30** — `countRecentFailedRuns` to dosłowna kopia logiki okna retry z `scheduler.processQueue` (lib/scheduler.js:30-32) — spójność progu „będzie retry / final fail" trzyma się tylko komentarza. Fix: wspólny helper `db.countRecentFailedRuns(jobId, maxRetries)` w `lib/db.js` (executor nie może importować schedulera — cykl) użyty w obu miejscach

Pozostałe P3 (16 pozycji: ekspozycja promptu/webhook_payload w diagLog → powiadomienia, brak timeoutu HTTP w postSendMessage, gorliwe liczenie faili gdy wynik ignorowany, SELECT * zamiast statusów w oknie retry, getRunWithPayload dla samego statusu, brak obsługi 429/capu chunków, SRP executor.js 391 linii → ekstrakcja notify-outcome, duplikacja buildFailureDetail między kanałami, pusty description embeda, mylący parametr `run`, tytuł embeda bez cięcia 256, brak testu multi-chunk sendNotification, brak testu error-path postSendMessage, brak testu cięcia 2000 w Discordzie, E2E Unit 4 bez pokrycia automatycznego [konwencja projektu], pre-existing `API.post` bez `res.ok` → fałszywy toast sukcesu) — szczegóły i rekomendacje w `review-faza-2.md`; nie blokują.

## Operator checklist faza 2

- [ ] Operator: produkcyjny lokalny Puls na `localhost:7777` (PID 96870, uruchomiony 30.06) działa z kodem sprzed fazy 2 — backend cicho gubi `telegram_notify` (POST z `true` → w bazie 0), mimo że frontend z dysku ma już checkbox; na świeżej instancji z kodem fazy 2 feature działa poprawnie — Operator action: zrestartuj lokalny serwer Puls (`launchctl kickstart -k com.claude-cron.scheduler` albo kill PID + `npm start`), potem dodaj job z zaznaczonym Telegramem i potwierdź `GET /api/jobs` → `telegram_notify:1`
- [ ] Operator: realna wysyłka do żywego API Telegrama niezweryfikowana (testy = wyłącznie czyste funkcje + mocki; do potwierdzenia: ścieżka `/bot<token>/sendMessage`, semantyka `ok:false` przy HTTP 200, chunking 4096 na żywo) — Operator action: przy teście fazy setupowej (Unit 6) skonfiguruj prawdziwego bota + chat_id i potwierdź dojście wiadomości testowej oraz powiadomień ✅ i ❌ z realnego runu

## Faza 3 — konfiguracja raz-lokalnie

### Unit 5: Modal ustawień powiadomień w dashboardzie (+ push na VPS + Wyczyść)

- [x] Modyfikuj `public/index.html` (przycisk + modal: 3 pola — Discord webhook URL, Telegram token, Telegram chat ID; przycisk „Wyczyść" per kanał)
- [x] Modyfikuj `public/app.js` (otwarcie modala z `GET /api/settings/notifications` — placeholdery z maskami; zapis `PUT` lokalny, puste pole = nie nadpisuj; „Wyślij na VPS" → `POST /api/settings/notifications/push-to-vps` gdy `vps_configured`; „Wyczyść" → `PUT` z pustymi stringami kluczy kanału)
- [x] Test: [E2E] otwórz modal → placeholdery „skonfigurowano/…4242"; wpisz wartość → Zapisz → ponowne otwarcie pokazuje nową maskę (fix po review fazy 3: PASS przez agent-browser na izolowanej instancji port 7799 — maski `…4242`/`…9999`, puste pole nie nadpisuje drugiego kanału)
- [x] Test: [E2E] „Wyczyść" przy kanale → GET pokazuje `configured:false` (przy pustym env) (fix po review fazy 3: PASS — Wyczyść Telegram i Wyczyść Discord → GET `configured:false` dla obu, toast + placeholdery wracają do „nie skonfigurowano" bez zamykania modala)
- [x] Weryfikacja: scenariusz E2E lokalny przez agent-browser przechodzi (zapis + odczyt maski) (fix po review fazy 3: 3/3 scenariusze PASS headless — izolowana instancja z kodem fazy 3, świeża DB, czysty env powiadomień; produkcyjny `localhost:7777` celowo nietknięty — testowe tokeny zanieczyściłyby realny state)
- [ ] Weryfikacja (operator): push na żywy VPS — `GET /api/vps/settings/notifications` po pushu pokazuje `configured:true` — wymaga operatora (Operator checklist faza 3)

### Unit 6: Setup lokalny — pytania do state, auto-detect chat ID, test-send, push na VPS

- [x] Modyfikuj `setup.mjs` (Discord do state zamiast `persistEnvVar`; pytanie o token Telegrama; auto-detekcja chat ID: „napisz cokolwiek do bota i wciśnij Enter" → `getUpdates` → potwierdzenie, ręczny fallback; test-send „✅ Puls połączony z Telegramem" z warn przy padzie; push przez `lib/notify-push.js` z timeoutem, warn przy padzie z podpowiedzią o dashboardzie i aktualizacji VPS)
- [x] Modyfikuj `setup.test.mjs` (czyste funkcje z DI: `buildNotificationSettingsPayload`, `extractChatIdFromUpdates`)
- [x] Rozstrzygnij moment zapisu `setState` (DB otwierana przy smoke-teście PO pytaniach — odpowiedzi w zmiennych, zapis przy smoke-teście) — rozstrzygnięte: odpowiedzi hoistowane przed `try`, `persistNotifySettings` woła `db.setState` bezpośrednio PO udanym smoke-teście, push na VPS zaraz potem
- [x] Test: `buildNotificationSettingsPayload` — tylko wypełnione pola w payloadzie; wszystkie puste → `null` (pomiń push)
- [x] Test: `extractChatIdFromUpdates(json)` — jedna rozmowa → chat ID; brak update'ów → `null` (ręczny fallback); wiele czatów → najnowszy
- [x] Weryfikacja: `node --test setup.test.mjs` zielony (review fazy 3: 46/46 PASS, exit 0)
- [ ] Weryfikacja (operator): pełny setup na żywo (prawdziwy bot) — chat ID wykryty, testowa wiadomość dochodzi, po setupie VPS ma konfigurację — wymaga operatora (Operator checklist faza 3)

### Unit 7: Instalator VPS przestaje pytać o Discord

- [x] Modyfikuj `scripts/install-vps.sh` (usuń pytanie `ask_valid DISCORD_URL` ~1198-1200; linię `DISCORD_WEBHOOK_URL` z `build_puls_env_lines` ~1237-1245; wpisy w podsumowaniach ~1143-1152 i ~1678-1679; `is_valid_discord_webhook` 249-251 jeśli bez innych konsumentów — grep; dodaj w podsumowaniu: „Powiadomienia skonfigurujesz przy instalacji lokalnej — trafią tu automatycznie")
- [x] Modyfikuj `scripts/install-vps.test.sh` (test 21 usunięty — testował usuwaną funkcjonalność; test 45: asercja, że unit NIE zawiera `DISCORD_WEBHOOK_URL`; asercje `WEBHOOK_BASE_URL` zostają)
- [x] Test: `build_puls_env_lines` nie emituje `DISCORD_WEBHOOK_URL` niezależnie od env
- [x] Test: harness instalatora przechodzi bez pytania o Discord (brak wiszącego `read`)
- [x] Weryfikacja: `bash scripts/install-vps.test.sh` zielony; `grep -c DISCORD scripts/install-vps.sh` → 0 (lub wyłącznie komentarz historyczny) (review fazy 3: 101/101 PASS, exit 0; grep → 0 wystąpień)

## Do poprawy po review fazy 3

- [x] 🟠 [P2] **public/app.js:960** — scenariusze [E2E] Unit 5 niewykonane, cały nowy frontend modala (openNotifyModal, saveNotifySettings, clearNotifyChannel, pushNotifyToVps — 138 linii) bez żadnej weryfikacji zachowania. Wykonalne headless przez agent-browser na `localhost:7777`: (1) otwarcie modala → placeholdery z maskami „skonfigurowano (…4242)"; (2) wpis wartości → Zapisz → ponowne otwarcie pokazuje nową maskę; (3) „Wyczyść" kanału → GET pokazuje `configured:false` (przy pustym env). Po PASS odhaczyć checkboxy [E2E] i Weryfikacja Unit 5 — NAPRAWIONE (fix po review fazy 3): 3/3 scenariusze PASS przez agent-browser na izolowanej instancji (port 7799, świeża DB, czysty env — produkcyjny 7777 celowo nietknięty, testowe tokeny nadpisałyby realny state); checkboxy Unit 5 odhaczone
- [x] 🟠 [P2] **scripts/install-vps.test.sh:600** — scenariusz z planu (Unit 7) „harness instalatora przechodzi bez pytania o Discord — brak wiszącego read" nie istnieje: `collect_config` w harnessie main() jest mockowany (MAIN_COMPONENT_FNS), żaden test nie wykonuje realnego `collect_config` z fixture TTY. Regresja przywracająca pytanie/read w bloku pytań (wiszący read pod curl|bash = EOF i ciche domyślne) nie zostałaby wykryta. Fix: test wykonujący realny `collect_config` z podpiętym fixture stdin/TTY — NAPRAWIONE (fix po review fazy 3): nowy Test 70 `test_collect_config_no_discord_question` wykonuje REALNY `collect_config` (pełny tryb i `--only-puls`) ze stubem `ask_tty` na granicy tty i kolejką o znanej długości — dodatkowe pytanie (np. przywrócony Discord) sięga poza kolejkę i wywala test (guard `:?`), asercje: dokładnie 4/2 pytania, zero `discord|webhook` w outputcie, exit 0; suite 102/102 PASS
- [ ] 🟡 [P3] **setup.mjs:672** — komunikat „[info] Pominięto Telegram (brak chat ID)" niespójny z zachowaniem: `buildNotificationSettingsPayload` i tak zapisuje sam `telegram_bot_token` do state i pushuje na VPS — sekret trafia do bazy mimo deklaracji pominięcia. Fix: nie wkładać tokena do payloadu bez chat ID, albo komunikat zgodny z zachowaniem
- [ ] 🟡 [P3] **setup.mjs:655 + lib/notify-config.js:57** — zero walidacji formatu wartości powiadomień na wszystkich granicach (regresja po usunięciu `is_valid_discord_webhook` z instalatora): prefix `https://discord.com/api/webhooks/`, token `\d+:[A-Za-z0-9_-]+`, chat_id `-?\d+` w jednym wspólnym miejscu (`sanitizeNotifySettings`) + warn w setupie

Pozostałe P3 (13 pozycji: auto-detekcja chat ID bez tożsamości nadawcy, `extractChatIdFromUpdates` zlewa ok:false z brakiem update'ów, trzeci punkt prawdy kluczy snake_case w setup.mjs, druga implementacja klienta Bot API z rozjechaną semantyką sukcesu, main() ~118 linii, push tylko przy vpsUrl z bieżącego runu, `askTelegramChatId` bez DI/testu, guard ok:true-z-body bez asercji, re-run instalatora cicho kasuje DISCORD_WEBHOOK_URL ze starego unitu, listen na wszystkich interfejsach a state = magazyn sekretów [pre-existing, świadoma decyzja], brak guardu in-flight save/clear, wspólny try/catch clear+refresh ze sprzecznymi toastami, push bez ostrzeżenia o niezapisanych polach, czyste helpery frontendu bez testów, inline styl layoutu w headerze) — szczegóły i rekomendacje w `review-faza-3.md`; nie blokują.

## Operator checklist faza 3

- [ ] Operator: push konfiguracji powiadomień na żywy VPS niezweryfikowany (wymaga realnej instancji VPS srv1362522 po Tailscale i prawdziwych credentiali — headless test z fikcyjnym tokenem nadpisałby produkcyjną konfigurację na VPS) — Operator action: (1) na lokalnym dashboardzie otwórz modal 🔔 Powiadomienia z prawdziwym tokenem/chat ID zapisanym w state, (2) kliknij „Wyślij na VPS", (3) zweryfikuj `curl http://localhost:7777/api/vps/settings/notifications` → `telegram.configured:true`
- [ ] Operator: pełny interaktywny przebieg setup.mjs z prawdziwym botem Telegrama niezweryfikowany (wymaga bota z @BotFather i TTY; czyste funkcje pokryte 7 testami, ścieżka integracyjna setup → state → push bez potwierdzenia) — Operator action: (1) załóż/użyj bota przez @BotFather, (2) uruchom `node setup.mjs` i przejdź pytania o powiadomienia, (3) napisz cokolwiek do bota gdy setup poprosi → potwierdź wykryty chat ID, (4) potwierdź dojście wiadomości „✅ Puls połączony z Telegramem", (5) po setupie sprawdź `GET /api/vps/settings/notifications` → konfiguracja na VPS

## Faza 4 — onboarding: taski i skill

### Unit 8: Podstawowe taski — szablony + seed w setupie lokalnym

- [x] Stwórz `templates/starter-jobs.json` (Daily memory update `0 6 * * *`/1800000, Weekly memory update `0 8 * * 1`/600000, Reflect tygodniowy `0 8 * * 1`/1200000, Poszukiwanie nowych skillów `0 9 * * 5`/600000; wspólnie `enabled=1`, `run_on_wake=1`, `job_type:'claude'`, `discord_notify=0`, `telegram_notify=0`)
- [x] Stwórz `lib/starter-jobs.js` (czysta `computeStarterJobsToSeed(defs, existingJobs, availableSkillNames)` → `{toSeed, skipped:[{name, reason}]}`; skorupa `seedStarterJobs()` — JSON + `getAllSkills()` + `db.createJob`)
- [x] Stwórz `lib/starter-jobs.test.js`
- [x] Modyfikuj `setup.mjs` (po smoke-teście DB: pytanie zbiorcze `[T/n]` → seed → raport dodanych/pominiętych z powodem)
- [x] Test: pusty stan + wszystkie skille dostępne → 4 do seedu; job o tej samej nazwie → pominięty (`reason:'exists'`); skill niedostępny → pominięty (`reason:'missing_skill'`)
- [x] Test: seed na DB `:memory:` → `getAllJobs()` zawiera 4 joby z poprawnymi cronami i `enabled=1`; drugi seed → 0 nowych
- [ ] Weryfikacja: `npm test` zielony (w tym `node --test lib/starter-jobs.test.js`)

### Unit 9: Skill `puls` + instalacja globalna w setupie

- [x] Stwórz `skills/puls/SKILL.md` (frontmatter: `name: puls`, `description` z frazami-triggerami PL, `allowed-tools: ["Bash", "Read"]`; treść: baza `http://localhost:7777` + `/api/vps/*`; tabela endpointów — jobs CRUD, trigger, toggle, webhook token, runs, runs/current + kill, skills, status, settings/notifications + push-to-vps; whitelist pól joba + defaulty + walidacja; czytanie logów stream-json; przykłady curl; wskazanie `templates/starter-jobs.json`)
- [x] Modyfikuj `setup.mjs` (kopiowanie rekurencyjne `skills/puls` → `~/.claude/skills/puls`, nadpisanie przy re-run; helper czysty z DI ścieżek)
- [x] Modyfikuj `setup.test.mjs` (test helpera kopiowania)
- [x] Test: helper kopiowania — kopiuje drzewo, nadpisuje istniejące, tworzy katalog docelowy
- [ ] Weryfikacja: `node --test setup.test.mjs` zielony; `~/.claude/skills/puls/SKILL.md` istnieje po przebiegu helpera; frontmatter parsowalny przez `gray-matter` (skaner `lib/skills.js` widzi skill)
- [ ] Weryfikacja (operator): test skilla w żywej sesji Claude Code (utworzenie + diagnoza joba przez rozmowę)

## Faza 5 — dokumentacja

### Unit 10: Dokumentacja (README, CLAUDE.md, szablon e2e-env)

- [ ] Modyfikuj `README.md` (sekcja Telegram: BotFather krok po kroku, auto-detect chat ID w setupie; „Powiadomienia konfigurujesz raz — lokalnie" + priorytet state>env + nota o re-runie VPS usuwającym env Discorda; powiadomienia o failach; podstawowe taski; skill puls)
- [ ] Modyfikuj `CLAUDE.md` (wzmianki: `lib/telegram.js`/`notify-format.js`/`notify-config.js`/`notify-push.js`, priorytet state>env, endpointy settings + push-to-vps, `templates/starter-jobs.json`, katalog `skills/`)
- [ ] Modyfikuj `.claude/templates/e2e-env/.env.e2e.example` (`TELEGRAM_*`)
- [ ] Weryfikacja: `grep -q TELEGRAM_BOT_TOKEN README.md CLAUDE.md` przechodzi; `npm test` zielony (regresja całości)
