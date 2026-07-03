---
title: "feat: Telegram, konfiguracja powiadomień raz-lokalnie, skill puls, podstawowe taski"
type: feat
status: active
date: 2026-07-03
origin: dyskusja w sesji 2026-07-03 (decyzje usera przez AskUserQuestion — brak requirements doc)
design_md: null
figma_spec: null
figma_screens: {}
---

# feat: Telegram, konfiguracja powiadomień raz-lokalnie, skill puls, podstawowe taski

## Przegląd

Domknięcie Pulsa do wersji finalnej (produkt dla kursantów): (1) powiadomienia Telegram obok Discorda, (2) konfiguracja powiadomień podawana RAZ przy instalacji lokalnej i automatycznie wypychana na VPS, (3) skill `puls` uczący agenta Claude Code pracy z API Pulsa, (4) zestaw podstawowych tasków seedowany jednym pytaniem przy instalacji lokalnej.

## Ujęcie problemu

Puls wysyła powiadomienia tylko na Discord, a ich konfiguracja jest zdublowana między instalatorami (lokalnie env w shell RC/rejestrze, na VPS pytanie + `Environment=` w systemd) — user musi podawać to samo dwa razy. Agent Claude Code nie zna API Pulsa (repo nie ma dokumentacji REST), więc nie umie tworzyć/edytować jobów ani czytać logów bez ręcznego projektowania promptów. Kursanci po instalacji dostają pustą listę jobów, mimo że mają z onboardingu gotowe skille (memory-update, reflect, skill-scout) idealne pod harmonogram.

## Śledzenie wymagań

- R1. Powiadomienia Telegram: własny bot (token z @BotFather) + chat ID; per-job flaga `telegram_notify` obok `discord_notify`; wysyłka po udanym runie oraz po ostatecznym failu (R9); chunking do 4096 znaków.
- R2. Konfiguracja powiadomień (Discord + Telegram) podawana RAZ w setupie lokalnym; VPS dostaje ją automatycznie przez push po Tailscale; instalator VPS przestaje pytać o Discord.
- R3. Env vary (`DISCORD_WEBHOOK_URL`, nowe `TELEGRAM_*`) działają jako fallback — istniejące instalacje działają bez zmian.
- R4. Konfigurację powiadomień można zmienić później z dashboardu (zapis lokalny + przycisk wypchnięcia na VPS).
- R5. Skill `puls` żyje w repo i jest instalowany globalnie do `~/.claude/skills` przez setup lokalny; niesie samowystarczalną specyfikację API.
- R6. Podstawowe taski lokalne (memory-update daily/weekly, reflect weekly, skill-scout weekly) seedowane jednym pytaniem zbiorczym `[T/n]`; `enabled=1`; flagi powiadomień (`discord_notify`, `telegram_notify`) wyłączone — kursant włącza świadomie per job; task pomijany gdy user nie ma skilla; re-run instalatora nie duplikuje (idempotencja po `name`).
- R7. Bez seedu tasków na VPS (cron auto-update 02:00 wystarcza — decyzja usera); task „Aktualizacja .env" poza zestawem (za specyficzny).
- R8. Wszystkie testy zielone: `npm test`, `node --test setup.test.mjs`, `bash scripts/install-vps.test.sh`, `bash install.test.sh`.
- R9. Powiadomienia o failach (roast 2026-07-03): ta sama flaga per job obejmuje `fail`/`timeout` po wyczerpaniu retry — „❌ <job> padł" + skrót `error_msg`; `killed` bez powiadomienia (user sam ubił run); oba kanały symetrycznie.
- R10. Push konfiguracji na VPS server-side (roast 2026-07-03): `POST /api/settings/notifications/push-to-vps` — lokalny serwer czyta pełne wartości z własnego state i PUT-uje na VPS; dashboard nigdy nie operuje pełnymi sekretami.

## Granice scope'u

- Powiadomienia o failach WCHODZĄ do scope'u (roast 2026-07-03, R9) — ale bez pingu per próba retry (tylko ostateczny fail) i bez powiadomienia przy `killed`.
- Bez seedu tasków na VPS i bez taska „Aktualizacja .env" (decyzje usera).
- Bez szyfrowania sekretów w DB — ten sam poziom zaufania co env w shell RC; API niedostępne publicznie (guard 403 na `X-Forwarded-For`, `server.js:402-405`).
- Bez zmian identyfikatorów technicznych `claude-cron` (nazwa DB, label launchd, env prefiksy — patrz CLAUDE.md).

## Kontekst i research

### Relevantny kod i wzorce

- `lib/discord.js` — wzorzec kanału powiadomień: `extractResult(stdout)` (parse stream-json, wpis `type:'result'`), `smartSplit(text, maxLen)`, `postWebhook` na `node:https`; guard na pusty config. Telegram = bliźniaczy moduł.
- `lib/executor.js:220-222` (claude) i `295-297` (script) — jedyne punkty wywołania powiadomień: `status==='success' && job.discord_notify`, fire-and-forget `.catch(() => {})`.
- `lib/db.js` — `getState`/`setState` (345-350) gotowe pod konfigurację w `state`; nowszy wzorzec migracji `PRAGMA table_info` → `ALTER` (105-116); whitelisty pól: `createJob` (164/166/169), `updateJob` `allowed` (174) + koercja bool (181); `discord_notify` w `CREATE TABLE` (42) jako wzór dla `telegram_notify`.
- `server.js:176-346` — ręczny router `handleApi`; walidacja POST joba (name wymagane; `script`→`command`; `claude`→`skill_name` lub `arguments`); proxy `/api/vps/*` (129-174) da dashboardowi i setupowi dostęp do endpointu ustawień VPS-a bez nowego kodu.
- `public/index.html:244` (checkbox `form-discord`, hint 228) + `public/app.js` ~821 (reset), ~865 (edit), ~920 (save body) — trzy punkty dotknięcia per-job checkboxa; istniejące modale jako wzorzec stylistyczny dla okna ustawień.
- `setup.mjs` — blok pytań ~497-530 (`ask` z readline), `persistEnvVar` (439-450), smoke-test DB po pytaniach; testy `setup.test.mjs` przez DI czystych funkcji (wzorzec do naśladowania dla nowych helperów).
- `scripts/install-vps.sh` — pytanie o Discord (~1198-1200), walidator `is_valid_discord_webhook` (249-251), `build_puls_env_lines` (1237-1245), podsumowania (~1143-1152, ~1678-1679); testy 21 (~403-434) i 45 (~1191-1211) w `scripts/install-vps.test.sh`.
- `lib/skills.js:96-108` — `getAllSkills()` (project > user > plugin) do sprawdzania dostępności skilli przed seedem.
- Produkcyjna baza usera — sprawdzone wartości starter-tasków (crony, timeouty) przeniesione 1:1 do szablonów.
- Format SKILL.md w ekosystemie: frontmatter `name`, `description` (z frazami-triggerami), `allowed-tools`, treść markdown — wzór: `.claude/skills/*/SKILL.md`.

### Wiedza instytucjonalna (docs/solutions/ via learned-patterns)

- **Backfill/seed danych ≠ migracja schematu** — seed tasków NIE idzie do `migrate()` (leci co boot i clobberowałby opt-outy); idzie do setupu z idempotencją po `name`. (2026-06-27-backfill-w-migrate)
- **Instalator `curl|bash`: stdin to pipe** — nowe pytania w setup.mjs idą przez istniejący mechanizm `ask` (już obsługuje handoff tty); zmiany install-vps.sh testować przez prawdziwy pipe. (2026-06-30-curl-bash-instalator)
- **Stan zewnętrznego CLI/API czytaj z dokładnej frazy i potwierdzaj stan faktyczny** — test-send Telegrama weryfikuje odpowiedź API (`ok:true` w JSON), nie sam kod HTTP; push na VPS potwierdzany odczytem `GET` po zapisie. (2026-07-03-guardy-instalatora)
- **`.ps1` przez `iex` = czyste ASCII** — nie dotykamy install.ps1 (handoff do setup.mjs bez zmian), więc ryzyko nie występuje, ale nowych komunikatów PL nie dodawać do .ps1.

## Kluczowe decyzje techniczne

- **Konfiguracja powiadomień w tabeli `state` (klucze `discord_webhook_url`, `telegram_bot_token`, `telegram_chat_id`), env jako fallback**: umożliwia podanie raz-lokalnie + push na VPS przez API; zero łamania istniejących instalacji (state pusty → czyta env). Rozwiązywanie w czasie wysyłki, nie w czasie `require` (dziś `DISCORD_WEBHOOK_URL` jest zamrażany przy imporcie).
- **Endpoint `GET/PUT /api/settings/notifications`**: GET maskuje sekrety (stan „skonfigurowano" + ostatnie 4 znaki) — służy tylko dashboardowi; PUT przyjmuje pełne wartości z whitelistą kluczy; pusty string czyści klucz (w UI dostępne wyłącznie jawnym przyciskiem „Wyczyść" per kanał). Na VPS dostępny przez istniejące proxy `/api/vps/settings/notifications` — bez nowego kodu proxy.
- **Push na VPS server-side — `POST /api/settings/notifications/push-to-vps`** (roast 2026-07-03): lokalny serwer czyta pełne wartości z własnego state i robi PUT na VPS. Naprawia scenariusz „VPS dokupiony po setupie" — przycisk w modalu działa też przy pustych polach (GET zwraca tylko maski), a sekrety nie przechodzą przez przeglądarkę. Logika pusha we współdzielonym `lib/notify-push.js` (konsumenci: endpoint + setup.mjs) — bez duplikacji.
- **Chat ID wykrywany automatycznie w setupie** (roast 2026-07-03): po podaniu tokena setup prosi „napisz cokolwiek do swojego bota i wciśnij Enter", woła `getUpdates`, proponuje znalezione chat ID do potwierdzenia; ręczne wpisanie jako fallback.
- **Wspólny `lib/notify-format.js`** (`extractResult`, `smartSplit`): ekstrakcja uzasadniona — od teraz 2 konsumentów (Discord, Telegram); zgodne z regułą „abstrakcja przy 2+ użyciach".
- **Telegram plain text, bez `parse_mode`**: zero problemów z escapowaniem Markdown w outputach agentów; limit `TELEGRAM_MAX_LEN = 4096`.
- **Skill dystrybuowany przez kopiowanie, nie symlink**: `skills/puls` → `~/.claude/skills/puls` kopią rekurencyjną (nadpisanie przy re-run) — działa na Windows bez uprawnień do symlinków.
- **Nowy top-level katalog `skills/`** dla skilli dystrybuowanych z produktem — odrębny od deweloperskiego `.claude/skills/` (skille do budowania Pulsa).
- **`templates/starter-jobs.json` deklaratywnie**: jedna lista czytana przez seed i referencowana przez skill puls; łatwe rozszerzanie bez dotykania kodu.
- **Usunięcie pytania o Discord z install-vps.sh**: konsekwencja R2; re-run instalatora na istniejącym VPS usunie `Environment=DISCORD_WEBHOOK_URL` z unita — przejmuje to state po pushu (do zakomunikowania w README).

## Otwarte pytania

### Rozwiązane podczas planowania

- Telegram: własny bot + chat ID, per-job flaga — decyzja usera.
- Konfiguracja raz-lokalnie: state + push na VPS, env fallback — decyzja usera („Tak, state + push na VPS").
- Seed: jedno pytanie zbiorcze; taski enabled=1; „Aktualizacja .env" poza zestawem; VPS bez seedu — decyzje usera.
- Skill puls: w repo + instalacja globalna — decyzja usera.
- Skille tasków (memory-update/reflect/skill-scout) nie są bundlowane z Pulsem — kursanci dostają je w onboardingu; seed pomija task przy braku skilla.

### Rozwiązane podczas roastu (2026-07-03, /zroastuj-mnie)

- Push na VPS server-side (endpoint `push-to-vps`), nie z pól modala — pola bywają puste, bo GET maskuje; naprawia scenariusz „VPS dokupiony po setupie".
- Przycisk „Wyczyść" per kanał w modalu — jedyna droga skasowania konfiguracji z UI (puste pole przy zwykłym zapisie = nie nadpisuj).
- Seedowane starter-taski: wszystkie flagi powiadomień = 0.
- Chat ID: auto-detekcja przez `getUpdates` z fallbackiem ręcznym.
- Powiadomienia o failach wchodzą do scope'u (fail/timeout po retry, bez `killed`) — uchyla wcześniejszą granicę „bez powiadomień o failach".
- Wartości starter-tasków zweryfikowane z żywą lokalną instancją usera (API `localhost:7777`) — crony/timeouty zgodne 1:1 z planem.

### Odroczone do implementacji

- Dokładny moment otwarcia DB w setup.mjs dla `setState` (dziś DB otwierana przy smoke-teście PO pytaniach) — trzymać odpowiedzi w zmiennych i zapisać przy smoke-teście, szczegół kolejności do rozstrzygnięcia w kodzie.
- Kształt maskowania w GET (ostatnie 4 znaki vs sama flaga `configured`) — do domknięcia przy implementacji UI modala.
- Czy `is_valid_discord_webhook` w install-vps.sh ma innych konsumentów (usunąć czy zostawić) — grep przy implementacji.

## Implementation Units

### Faza 1 — fundament powiadomień

- [x] **Unit 1: Wspólny moduł formatowania powiadomień (`notify-format`)**

**Cel:** Wydzielenie `extractResult` i `smartSplit` do współdzielonego modułu — przygotowanie pod drugi kanał (Telegram).

**Wymagania:** R1 (pośrednio), R8

**Zależności:** Brak

**Pliki:**
- Stwórz: `lib/notify-format.js`
- Stwórz (test): `lib/notify-format.test.js`
- Modyfikuj: `lib/discord.js` (import z notify-format, usunięcie lokalnych kopii; eksporty `extractResult`/`smartSplit` z discord.js zostają re-eksportem albo znikają — grep konsumentów przy implementacji)

**Delegate to:** claude (catch-all — backend CommonJS poza matrycą UI/data builderów)

**Skills in play:** —

**Podejście:**
- Przeniesienie 1:1 bez zmian zachowania; `smartSplit` już przyjmuje `maxLen` parametrem — gotowy pod limit 4096.

**Wzorce do naśladowania:** kolokacja testów obok źródła (`lib/db.test.js`), czyste funkcje bez I/O.

**Scenariusze testowe:**
- [Unit] `extractResult`: stdout z wpisem `type:'result'` → zwraca treść; brak wpisu → fallback „Job completed…"; linia z niepoprawnym JSON nie wywala parsowania.
- [Unit] `smartSplit`: tekst < maxLen → 1 chunk; podział po `\n`, potem `. `; słowo dłuższe niż maxLen → twardy podział; każdy chunk ≤ maxLen.

**Weryfikacja:**
- `npm test` przechodzi; `node --test lib/notify-format.test.js` zielony. — ✔ zaliczone 2026-07-03 (suite 202/202 PASS, scenariusze extractResult/smartSplit pokryte)

- [x] **Unit 2: Konfiguracja powiadomień w `state` + endpoint `/api/settings/notifications`**

**Cel:** Źródło prawdy konfiguracji powiadomień w DB (state) z fallbackiem env; API do odczytu (maskowany) i zapisu; Discord czyta config w czasie wysyłki.

**Wymagania:** R2, R3, R4

**Zależności:** Unit 1

**Pliki:**
- Stwórz: `lib/notify-config.js` (czysta funkcja `resolveNotifyConfig(stateGetter, env)` + maskowanie)
- Stwórz (test): `lib/notify-config.test.js`
- Stwórz: `lib/notify-push.js` (współdzielona logika pusha na VPS: czyta state, PUT na `<vpsUrl>/api/settings/notifications`, potwierdza GET-em po zapisie; konsumenci: endpoint push-to-vps i setup.mjs)
- Stwórz (test): `lib/notify-push.test.js`
- Modyfikuj: `lib/config.js` (eksport `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` z `process.env` — obok linii 24)
- Modyfikuj: `lib/discord.js` (webhook URL rozwiązywany przy wysyłce: state → env fallback)
- Modyfikuj: `server.js` (route'y `GET/PUT /api/settings/notifications` + `POST /api/settings/notifications/push-to-vps` w `handleApi`)

**Delegate to:** claude (catch-all)

**Skills in play:** —

**Podejście:**
- Klucze state: `discord_webhook_url`, `telegram_bot_token`, `telegram_chat_id`. Priorytet: state (niepusty) > env.
- PUT: whitelist trzech kluczy, tylko stringi, pusty string = `setState(key, '')` (czyści → fallback env przestaje być nadpisywany… uwaga: pusty state ma oznaczać „brak wartości w state", więc fallback env dalej działa — semantyka do utrwalenia w teście).
- GET: `{ discord: {configured, masked}, telegram: {configured, masked_token, chat_id} }` — sekrety nigdy w pełnej formie.
- Endpoint automatycznie objęty guardem 403 XFF i proxowany na VPS przez `/api/vps/*` — zero zmian w proxy.

**Wzorce do naśladowania:** styl route'ów w `handleApi` (match po `segments`), format odpowiedzi błędów jak przy walidacji POST joba.

**Scenariusze testowe:**
- [Unit] `resolveNotifyConfig`: state ustawiony → wygrywa; state pusty + env ustawione → env; oba puste → kanał nieskonfigurowany.
- [Unit] maskowanie: token 46-znakowy → `…ostatnie 4`; pusty → `configured:false`.
- [Unit] sanityzacja PUT body: nieznane klucze odrzucone, nie-string odrzucony.
- [Unit] `notify-push` z mock fetch: sukces potwierdzony GET-em po PUT; VPS bez endpointu (404, stary serwer) → `{ok:false, reason}` bez rzucania; timeout → `{ok:false}`.

**Weryfikacja:**
- `npm test` zielony; `curl PUT` + `curl GET` na działającym serwerze zwracają zapisany (zamaskowany) stan — scenariusz w kroku weryfikacji E2E planu (sekcja niżej). — ✔ testy jednostkowe zaliczone 2026-07-03 (resolve/maskowanie/sanityzacja/push z mock fetch); curl E2E w kroku review

### Faza 2 — Telegram

- [ ] **Unit 3: Kanał Telegram end-to-end (moduł + kolumna DB + executor)**

**Cel:** Działające powiadomienia Telegram po udanym runie joba z flagą `telegram_notify` oraz powiadomienia o failach na obu kanałach (R9).

**Wymagania:** R1, R3, R9

**Zależności:** Unit 1, Unit 2

**Pliki:**
- Stwórz: `lib/telegram.js`
- Stwórz (test): `lib/telegram.test.js`
- Modyfikuj: `lib/db.js` (kolumna `telegram_notify INTEGER DEFAULT 0`: CREATE TABLE ~42, migracja wzorcem `PRAGMA table_info` ~105-116, `createJob` 164/166/169, `updateJob` `allowed` 174 + koercja bool 181)
- Modyfikuj (test): `lib/db.test.js` (create/update z `telegram_notify`)
- Modyfikuj: `lib/executor.js` (wywołanie obok Discorda w OBU miejscach: ~220-222 i ~295-297)

**Delegate to:** claude (catch-all)

**Skills in play:** —

**Podejście:**
- `sendNotification(job, stdout)`: guard gdy brak token/chat (resolve przez `notify-config`); `extractResult` + `smartSplit(text, 4096)`; POST `https://api.telegram.org/bot<TOKEN>/sendMessage` (`node:https`, JSON `{chat_id, text}`, bez parse_mode); pierwszy chunk z nagłówkiem `✅ <job.name>`.
- Czysta funkcja `buildMessages(jobName, stdout)` → testowalna bez sieci; sieć w cienkiej skorupie.
- Powiadomienia o failach (R9): wariant `❌ <job.name> padł (<status>)` + skrót `error_msg`/ogon stderr; wysyłka tylko po ostatecznym failu/timeout (po wyczerpaniu retry, nie per próba), nigdy przy `killed`. Symetrycznie w `lib/discord.js` (czerwony embed, kolor `0xFF0000`).
- Executor: przy `success` symetrycznie do Discorda dziś; przy ostatecznym `fail`/`timeout` wywołanie wariantu fail dla obu kanałów wg flag joba — wszystko fire-and-forget `.catch(() => {})`, kanały niezależne.

**Wzorce do naśladowania:** `lib/discord.js` (struktura modułu), wzorzec migracji `PRAGMA table_info` (`lib/db.js:105-116`).

**Scenariusze testowe:**
- [Unit] `buildMessages`: krótki wynik → 1 wiadomość z nagłówkiem; wynik > 4096 → N chunków, każdy ≤ 4096, nagłówek tylko w pierwszym.
- [Unit] brak konfiguracji (token/chat puste w state i env) → early return, zero prób sieciowych.
- [Unit] DB: `createJob({telegram_notify:true})` → 1 w bazie; `updateJob` koerca `false`→0; stara baza po migracji ma kolumnę z defaultem 0.
- [Unit] fail: status `fail` z wyczerpanymi retry + flaga → wiadomość ❌ z `error_msg`; `killed` → brak wysyłki; retry jeszcze dostępne → brak wysyłki.

**Weryfikacja:**
- `npm test` zielony (w tym `node --test lib/telegram.test.js`, `lib/db.test.js`).

- [ ] **Unit 4: Checkbox „Powiadomienie Telegram" per job w dashboardzie**

**Cel:** Flaga `telegram_notify` ustawialna z formularza joba.

**Wymagania:** R1

**Zależności:** Unit 3

**Pliki:**
- Modyfikuj: `public/index.html` (checkbox `form-telegram` obok `form-discord` ~244; hint akordeonu „…Discord · Telegram" ~228)
- Modyfikuj: `public/app.js` (reset ~821, `!!job.telegram_notify` w edit ~865, `telegram_notify` w body save ~920)

**Delegate to:** claude (catch-all — vanilla JS, poza matrycą React-builderów)

**Skills in play:** —

**Podejście:** lustrzane odbicie trzech punktów dotknięcia `form-discord`; zero nowych wzorców.

**Wzorce do naśladowania:** istniejący checkbox Discord (identyczny markup i flow zapisu).

**Scenariusze testowe:**
- [E2E] Otwórz `localhost:7777`, dodaj job z zaznaczonym Telegramem → `GET /api/jobs` zwraca `telegram_notify:1`; edytuj job → checkbox odzwierciedla stan z bazy.

**Weryfikacja:**
- Scenariusz E2E przez agent-browser przechodzi (formularz zapisuje i odczytuje flagę).

### Faza 3 — konfiguracja raz-lokalnie

- [ ] **Unit 5: Modal ustawień powiadomień w dashboardzie (+ push na VPS)**

**Cel:** Zmiana konfiguracji powiadomień z UI po instalacji: zapis lokalny + przycisk „Wyślij też na VPS".

**Wymagania:** R4

**Zależności:** Unit 2

**Pliki:**
- Modyfikuj: `public/index.html` (przycisk + modal: 3 pola — Discord webhook URL, Telegram token, Telegram chat ID)
- Modyfikuj: `public/app.js` (otwarcie modala z `GET /api/settings/notifications` — placeholdery z maskowanym stanem; zapis `PUT` lokalny; gdy `GET /api/env → vps_configured` — przycisk „Wyślij na VPS" woła `POST /api/settings/notifications/push-to-vps` — serwer pushuje własny state, działa też przy pustych polach; przycisk „Wyczyść" per kanał — `PUT` z pustymi stringami kluczy kanału)

**Delegate to:** claude (catch-all)

**Skills in play:** —

**Podejście:** stylistyka i mechanika istniejących modali (formularz joba); bez nowych bibliotek; puste pole = nie nadpisuj (wysyłaj tylko pola, które user wypełnił); czyszczenie wyłącznie jawnym przyciskiem „Wyczyść".

**Wzorce do naśladowania:** istniejący modal edycji joba w `public/app.js`.

**Scenariusze testowe:**
- [E2E] Otwórz modal → placeholdery pokazują stan „skonfigurowano/…4242"; wpisz wartość → Zapisz → ponowne otwarcie pokazuje nową maskę.
- [E2E] „Wyczyść" przy kanale → GET pokazuje `configured:false` (przy pustym env).
- [Manual] „Wyślij na VPS" na żywej instancji VPS (wymaga Tailscale) → `GET /api/vps/settings/notifications` odzwierciedla push.

**Weryfikacja:**
- Scenariusz E2E lokalny przez agent-browser przechodzi (zapis + odczyt maski).

**Operator checklist:**
- [ ] Push na żywy VPS zweryfikowany (`GET /api/vps/settings/notifications` po pushu pokazuje `configured:true`).

- [ ] **Unit 6: Setup lokalny — pytania o Discord/Telegram do state, test-send, push na VPS**

**Cel:** Konfiguracja powiadomień podawana RAZ w `setup.mjs`: zapis do state lokalnej bazy, testowa wiadomość Telegram, automatyczny push na VPS gdy skonfigurowany.

**Wymagania:** R2, R3

**Zależności:** Unit 2, Unit 3

**Pliki:**
- Modyfikuj: `setup.mjs` (blok pytań ~512-530: pytanie o Discord przestaje wołać `persistEnvVar` na rzecz zapisu do state; pytanie o Telegram token, potem auto-detekcja chat ID: „napisz cokolwiek do swojego bota i wciśnij Enter" → `getUpdates` → potwierdzenie znalezionego ID, ręczne wpisanie jako fallback; test-send „✅ Puls połączony z Telegramem" z warn przy padzie; push na VPS przez współdzielony `lib/notify-push.js` z timeoutem, warn przy padzie z podpowiedzią o dashboardzie)
- Modyfikuj (test): `setup.test.mjs` (czyste funkcje: `buildNotificationSettingsPayload`, `extractChatIdFromUpdates` z DI; push testowany w `lib/notify-push.test.js`)

**Delegate to:** claude (catch-all)

**Skills in play:** —

**Podejście:**
- Odpowiedzi trzymane w zmiennych; zapis `db.setState` dopiero gdy DB otwarta (przy smoke-teście) — kolejność do domknięcia w kodzie (odroczone).
- Test-send weryfikuje `ok:true` w odpowiedzi API Telegrama (dokładna fraza stanu, nie kod HTTP — learned pattern); fail nie przerywa setupu.
- Push na VPS potwierdzany odczytem GET po PUT (stan faktyczny, nie kod odpowiedzi).

**Wzorce do naśladowania:** DI czystych funkcji w `setup.test.mjs` (np. `buildSetUserEnvCommand`), mechanizm `ask` (obsługuje już tty-handoff).

**Scenariusze testowe:**
- [Unit] `buildNotificationSettingsPayload`: tylko wypełnione pola trafiają do payloadu; wszystkie puste → `null` (pomiń push).
- [Unit] `extractChatIdFromUpdates(json)`: jedna rozmowa → chat ID; brak update'ów → `null` (przejście na ręczny fallback); wiele czatów → najnowszy.
- [Manual] Pełny setup interaktywny na czystej maszynie: pytania → test-send dochodzi na Telegram → push widoczny na VPS.

**Weryfikacja:**
- `node --test setup.test.mjs` zielony.

**Operator checklist:**
- [ ] Przebieg setupu na żywo (prawdziwy bot): testowa wiadomość dochodzi; po setupie VPS ma konfigurację.

- [ ] **Unit 7: Instalator VPS przestaje pytać o Discord**

**Cel:** VPS nie konfiguruje powiadomień — dostaje je pushem z lokalnego setupu/dashboardu.

**Wymagania:** R2

**Zależności:** Unit 6 (semantycznie — push musi istnieć zanim odbierzemy VPS-owi pytanie)

**Pliki:**
- Modyfikuj: `scripts/install-vps.sh` (usuń: pytanie `ask_valid DISCORD_URL` ~1198-1200, linię `DISCORD_WEBHOOK_URL` z `build_puls_env_lines` ~1237-1245, wpisy w podsumowaniach ~1143-1152 i ~1678-1679; walidator `is_valid_discord_webhook` 249-251 usuń jeśli bez innych konsumentów — grep; dodaj linijkę w podsumowaniu końcowym: „Powiadomienia skonfigurujesz przy instalacji lokalnej — trafią tu automatycznie")
- Modyfikuj (test): `scripts/install-vps.test.sh` (test 21 usunięty — testował usuwaną funkcjonalność; test 45: asercja, że unit NIE zawiera `DISCORD_WEBHOOK_URL`, istniejące asercje `WEBHOOK_BASE_URL` zostają)

**Delegate to:** claude (catch-all)

**Skills in play:** —

**Podejście:** czysta subtrakcja; zmiany testów legalne (usuwana funkcjonalność, nie osłabianie asercji).

**Wzorce do naśladowania:** styl testów harnessu (`CLAUDE_CRON_LIB_ONLY=1`, mockowany TTY).

**Scenariusze testowe:**
- [Unit] `build_puls_env_lines` nie emituje `DISCORD_WEBHOOK_URL` niezależnie od env.
- [Unit] Harness instalatora przechodzi bez pytania o Discord (brak wiszącego `read`).

**Weryfikacja:**
- `bash scripts/install-vps.test.sh` zielony; `grep -c DISCORD scripts/install-vps.sh` → 0 (lub wyłącznie komentarz historyczny).

### Faza 4 — onboarding: taski i skill

- [ ] **Unit 8: Podstawowe taski — szablony + seed w setupie lokalnym**

**Cel:** Jedno pytanie `[T/n]` w setupie dodaje zestaw sprawdzonych jobów; pomija te bez dostępnego skilla; re-run nie duplikuje.

**Wymagania:** R6, R7

**Zależności:** Unit 3 (kolumna `telegram_notify` w defaultach createJob — kolejność migracji)

**Pliki:**
- Stwórz: `templates/starter-jobs.json`
- Stwórz: `lib/starter-jobs.js`
- Stwórz (test): `lib/starter-jobs.test.js`
- Modyfikuj: `setup.mjs` (po smoke-teście DB: pytanie zbiorcze → seed → raport dodanych/pominiętych z powodem)

**Delegate to:** claude (catch-all)

**Skills in play:** —

**Podejście:**
- Szablony (wartości z produkcyjnej bazy usera): `Daily memory update` (memory-update, `0 6 * * *`, timeout 1800000), `Weekly memory update` (memory-update weekly, `0 8 * * 1`, 600000), `Reflect tygodniowy` (reflect weekly, `0 8 * * 1`, 1200000), `Poszukiwanie nowych skillów` (skill-scout, `0 9 * * 5`, 600000); wspólnie `enabled=1`, `run_on_wake=1`, `job_type:'claude'`, `discord_notify=0`, `telegram_notify=0` (kursant włącza powiadomienia świadomie per job — roast 2026-07-03).
- Czysta `computeStarterJobsToSeed(defs, existingJobs, availableSkillNames)` → `{toSeed, skipped:[{name, reason}]}`; skorupa `seedStarterJobs()` czyta JSON, woła `lib/skills.getAllSkills()` i `db.createJob`.
- Seed w setupie, NIE w `migrate()` (learned pattern: backfill w migrate clobberuje decyzje usera). Idempotencja po `name` zamiast sentinela w state — user może świadomie usunąć taska i re-run go nie przywróci tylko wtedy… (uwaga: usunięty task wróci przy re-runie z odpowiedzią „T" — akceptowalne, bo seed jest opt-in pytaniem; odnotować w README).
- Wymaga `CLAUDE_CRON_WORKSPACE` w `process.env` — ustawiane wcześniej w setupie przez `persistEnvVar`.

**Wzorce do naśladowania:** czyste funkcje z argumentami zamiast globali (`computeMissedJobs` w `lib/scheduler.js`), kolokacja testów.

**Scenariusze testowe:**
- [Unit] pusty stan + wszystkie skille dostępne → 4 do seedu; job o tej samej nazwie istnieje → pominięty (`reason:'exists'`); skill niedostępny → pominięty (`reason:'missing_skill'`).
- [Unit] seed na DB `:memory:` → `getAllJobs()` zawiera 4 joby z poprawnymi cronami i `enabled=1`; drugi seed → 0 nowych.

**Weryfikacja:**
- `npm test` zielony (w tym `node --test lib/starter-jobs.test.js`).

- [ ] **Unit 9: Skill `puls` + instalacja globalna w setupie**

**Cel:** Agent Claude Code umie tworzyć/edytować joby i czytać logi Pulsa bez ręcznego projektowania promptów.

**Wymagania:** R5

**Zależności:** Unit 2 (endpoint settings w spec API), Unit 8 (referencja do szablonów)

**Pliki:**
- Stwórz: `skills/puls/SKILL.md`
- Modyfikuj: `setup.mjs` (kopiowanie rekurencyjne `skills/puls` → `~/.claude/skills/puls`, nadpisanie przy re-run)
- Modyfikuj (test): `setup.test.mjs` (czysty helper kopiowania z DI ścieżek)

**Delegate to:** claude (catch-all)

**Skills in play:** —

**Podejście:**
- Frontmatter: `name: puls`, `description` z frazami-triggerami PL („dodaj zadanie do Pulsa", „harmonogram", „logi joba", „dlaczego job padł", „zmień cron"), `allowed-tools: ["Bash", "Read"]`.
- Treść samowystarczalna (repo nie ma doc REST): baza `http://localhost:7777` (port z `CLAUDE_CRON_PORT`), instancja VPS przez `/api/vps/*`; tabela endpointów (jobs CRUD, trigger, toggle, webhook token, `GET /api/runs?job_id=&limit=&offset=`, `runs/current` + kill, skills, status, settings/notifications + push-to-vps); pełna whitelist pól joba + defaulty + reguły walidacji (name wymagane; script→command; claude→skill_name lub arguments; timeouty w ms); czytanie logów (`stdout` = stream-json, wynik w linii `type:'result'`, `stderr`/`error_msg` przy failu, statusy); przykłady `curl`; wskazanie `templates/starter-jobs.json`.
- Kopiowanie zamiast symlinku (Windows bez uprawnień); helper czysty, testowalny.

**Wzorce do naśladowania:** format SKILL.md z `.claude/skills/` (frontmatter + markdown), styl `argument-hint`/`description` ze skilli usera.

**Scenariusze testowe:**
- [Unit] helper kopiowania: kopiuje drzewo, nadpisuje istniejące, tworzy katalog docelowy.
- [Manual] Sesja Claude Code po instalacji: „dodaj do Pulsa zadanie X co poniedziałek 8:00" → poprawny POST; „pokaż czemu ostatni run joba Y padł" → odczyt runa z API.

**Weryfikacja:**
- `node --test setup.test.mjs` zielony; `~/.claude/skills/puls/SKILL.md` istnieje po przebiegu helpera; frontmatter parsowalny przez `gray-matter` (skanowanie `lib/skills.js` widzi skill).

**Operator checklist:**
- [ ] Test skilla w żywej sesji Claude Code (utworzenie + diagnoza joba przez rozmowę).

### Faza 5 — dokumentacja

- [ ] **Unit 10: Dokumentacja (README, CLAUDE.md, szablon e2e-env)**

**Cel:** Użytkownik i przyszłe sesje agenta znają nowe mechanizmy.

**Wymagania:** R2, R3 (komunikacja konsekwencji), R8

**Zależności:** Unity 1-9

**Pliki:**
- Modyfikuj: `README.md` (sekcja Telegram: BotFather krok po kroku, chat ID przez `getUpdates`; „Powiadomienia konfigurujesz raz — lokalnie" + nota o re-runie VPS usuwającym env Discorda; podstawowe taski; skill puls)
- Modyfikuj: `CLAUDE.md` (wzmianki: `lib/telegram.js`/`notify-format.js`/`notify-config.js`, priorytet state>env, endpoint settings, `templates/starter-jobs.json`, katalog `skills/`)
- Modyfikuj: `.claude/templates/e2e-env/.env.e2e.example` (`TELEGRAM_*`)

**Delegate to:** claude (catch-all)

**Skills in play:** —

**Scenariusze testowe:** —

**Weryfikacja:**
- `grep -q TELEGRAM_BOT_TOKEN README.md CLAUDE.md` przechodzi; `npm test` zielony (regresja całości).

## Wpływ systemowy

- **Graf interakcji:** executor → discord/telegram (fire-and-forget, oba niezależne); server → db.state (nowy endpoint); setup.mjs → lokalna DB + zdalny VPS API; dashboard → oba (lokalny + proxy VPS).
- **Propagacja błędów:** wysyłka powiadomień nigdy nie wpływa na status runu (`.catch(() => {})` — istniejący kontrakt); pad pusha na VPS w setupie = warn + instrukcja, nigdy fail instalacji (analogicznie do granicy loginów OAuth z learned patterns).
- **Ryzyka cyklu życia stanu:** state nadpisuje env — użytkownik z env-konfiguracją, który zapisze w dashboardzie inną wartość, może być zaskoczony; GET pokazuje aktywne źródło (maskowane), README wyjaśnia priorytet. Re-run instalatora VPS usuwa env Discorda z unita — powiadomienia VPS wymagają wcześniejszego/ponownego pusha.
- **Parytet surface API:** endpoint settings działa identycznie lokalnie i na VPS (ten sam kod serwera) — proxy `/api/vps/*` daje parytet bez zmian.
- **Pokrycie integracyjne:** ścieżka „setup → state → executor → Telegram" weryfikowana ręcznie (Operator checklist Unit 6) — unit testy pokrywają ogniwa osobno.

## Ryzyka i zależności

- **Sekrety w DB plaintext** — świadoma decyzja (poziom zaufania jak shell RC); mitygacja: maskowanie w GET, API prywatne (guard XFF), README ostrzega przed udostępnianiem pliku bazy.
- **Kolejność wdrożenia lokalny↔VPS**: push z setupu wymaga zaktualizowanego serwera na VPS (endpoint settings). Stary VPS bez endpointu → push zwróci 404 → warn z instrukcją aktualizacji VPS (`git pull` robi cron 02:00). Odnotować w komunikacie warn.
- **Skille kursantów**: seed zależy od obecności skilli z onboardingu w źródłach skanera (`project > user > plugin`) — pominięcie z czytelnym powodem zamiast twardego faila.
- **`node:https` do api.telegram.org** — wymaga wyjścia sieciowego z maszyny; timeouty krótkie, fire-and-forget.

## Dokumentacja / Notatki operacyjne

- Po merge: user powinien przejść re-run lokalnego setupu (lub użyć modala w dashboardzie), żeby przenieść konfigurację Discorda z env do state i dodać Telegram; następnie „Wyślij na VPS".
- Istniejący VPS usera ma `Environment=DISCORD_WEBHOOK_URL` w unicie — działa dalej (fallback env) do czasu re-runu instalatora.

## Źródła i referencje

- **Dokument źródłowy:** dyskusja w sesji 2026-07-03 (decyzje przez AskUserQuestion; brak pliku brainstorm)
- **Roast planu:** sesja /zroastuj-mnie 2026-07-03 — 5 decyzji: push server-side (R10), przycisk „Wyczyść", seed bez powiadomień, auto-detect chat ID, powiadomienia o failach (R9)
- Powiązany kod: `lib/discord.js`, `lib/executor.js:220-297`, `lib/db.js:105-181`, `server.js:176-346`, `setup.mjs:497-560`, `scripts/install-vps.sh:1086-1300`
- Wiedza instytucjonalna: `docs/solutions/runtime-errors/2026-06-27-backfill-w-migrate-clobberuje-opt-outy.md`, `docs/solutions/deployment-issues/2026-06-30-curl-bash-instalator-interaktywny-tty.md`, `docs/solutions/deployment-issues/2026-07-03-guardy-instalatora-falszywe-sygnaly-statusow-cli.md`
- Zewnętrzne docs: Telegram Bot API `sendMessage` (limit 4096 znaków), Discord webhook (limit 2000 — istniejący kod)
