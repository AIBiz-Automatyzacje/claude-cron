# Zadania: Telegram, konfiguracja powiadomień raz-lokalnie, skill puls, podstawowe taski

Branch: `feature/telegram-powiadomienia-skill-taski`
Ostatnia aktualizacja: 2026-07-03

## Faza 1 — fundament powiadomień

### Unit 1: Wspólny moduł formatowania powiadomień (`notify-format`)

- [ ] Stwórz `lib/notify-format.js` (przeniesienie 1:1 `extractResult` + `smartSplit` z `lib/discord.js`)
- [ ] Stwórz `lib/notify-format.test.js`
- [ ] Modyfikuj `lib/discord.js` (import z notify-format; grep konsumentów eksportów `extractResult`/`smartSplit` przed usunięciem re-eksportu)
- [ ] Test: `extractResult` — stdout z wpisem `type:'result'` → treść; brak wpisu → fallback „Job completed…"; niepoprawny JSON w linii nie wywala parsowania
- [ ] Test: `smartSplit` — tekst < maxLen → 1 chunk; podział po `\n`, potem `. `; słowo > maxLen → twardy podział; każdy chunk ≤ maxLen
- [ ] Weryfikacja: `npm test` przechodzi; `node --test lib/notify-format.test.js` zielony

### Unit 2: Konfiguracja powiadomień w `state` + endpointy settings i push-to-vps

- [ ] Stwórz `lib/notify-config.js` (`resolveNotifyConfig(stateGetter, env)`: state niepusty > env; maskowanie — configured + ostatnie 4 znaki)
- [ ] Stwórz `lib/notify-config.test.js`
- [ ] Stwórz `lib/notify-push.js` (push na VPS: PUT `<vpsUrl>/api/settings/notifications` + potwierdzenie GET-em po zapisie; `{ok, reason}` bez rzucania)
- [ ] Stwórz `lib/notify-push.test.js`
- [ ] Modyfikuj `lib/config.js` (eksport `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`)
- [ ] Modyfikuj `lib/discord.js` (webhook URL rozwiązywany przy wysyłce: state → env fallback)
- [ ] Modyfikuj `server.js` (route'y `GET/PUT /api/settings/notifications` + `POST /api/settings/notifications/push-to-vps`; PUT: whitelist 3 kluczy, tylko stringi, pusty string czyści)
- [ ] Test: `resolveNotifyConfig` — state ustawiony → wygrywa; state pusty + env → env; oba puste → kanał nieskonfigurowany
- [ ] Test: maskowanie — token 46-znakowy → `…ostatnie 4`; pusty → `configured:false`
- [ ] Test: sanityzacja PUT body — nieznane klucze odrzucone, nie-string odrzucony
- [ ] Test: `notify-push` z mock fetch — sukces potwierdzony GET-em po PUT; VPS bez endpointu (404) → `{ok:false, reason}` bez rzucania; timeout → `{ok:false}`
- [ ] Weryfikacja: `npm test` zielony; `curl PUT` + `curl GET` na działającym serwerze zwracają zapisany (zamaskowany) stan

## Faza 2 — Telegram

### Unit 3: Kanał Telegram end-to-end + powiadomienia o failach (R9)

- [ ] Stwórz `lib/telegram.js` (`buildMessages(jobName, stdout)` czysta; `sendNotification` — POST `api.telegram.org/bot<TOKEN>/sendMessage`, plain text bez parse_mode, chunking 4096, nagłówek `✅ <job.name>` w pierwszym chunku)
- [ ] Stwórz `lib/telegram.test.js`
- [ ] Wariant fail (R9): `❌ <job.name> padł (<status>)` + skrót `error_msg`/ogon stderr — w `lib/telegram.js` ORAZ `lib/discord.js` (czerwony embed `0xFF0000`)
- [ ] Modyfikuj `lib/db.js` (kolumna `telegram_notify INTEGER DEFAULT 0`: CREATE TABLE ~42, migracja `PRAGMA table_info` ~105-116, `createJob` 164/166/169, `updateJob` allowed 174 + koercja bool 181)
- [ ] Modyfikuj `lib/db.test.js` (create/update z `telegram_notify`)
- [ ] Modyfikuj `lib/executor.js` (oba punkty ~220-222 i ~295-297: sukces jak dziś dla obu kanałów wg flag; ostateczny `fail`/`timeout` po wyczerpaniu retry → wariant fail dla obu kanałów; nigdy przy `killed`; fire-and-forget `.catch(() => {})`)
- [ ] Test: `buildMessages` — krótki wynik → 1 wiadomość z nagłówkiem; wynik > 4096 → N chunków ≤ 4096, nagłówek tylko w pierwszym
- [ ] Test: brak konfiguracji (token/chat puste w state i env) → early return, zero prób sieciowych
- [ ] Test: DB — `createJob({telegram_notify:true})` → 1; `updateJob` koerca `false`→0; stara baza po migracji ma kolumnę z defaultem 0
- [ ] Test: fail — status `fail` z wyczerpanymi retry + flaga → wiadomość ❌ z `error_msg`; `killed` → brak wysyłki; retry jeszcze dostępne → brak wysyłki
- [ ] Weryfikacja: `npm test` zielony (w tym `node --test lib/telegram.test.js`, `lib/db.test.js`)

### Unit 4: Checkbox „Powiadomienie Telegram" per job w dashboardzie

- [ ] Modyfikuj `public/index.html` (checkbox `form-telegram` obok `form-discord` ~244; hint akordeonu „…Discord · Telegram" ~228)
- [ ] Modyfikuj `public/app.js` (reset ~821; `!!job.telegram_notify` w edit ~865; `telegram_notify` w body save ~920)
- [ ] Test: [E2E] `localhost:7777` — dodaj job z zaznaczonym Telegramem → `GET /api/jobs` zwraca `telegram_notify:1`; edytuj job → checkbox odzwierciedla stan z bazy
- [ ] Weryfikacja: scenariusz E2E przez agent-browser przechodzi (formularz zapisuje i odczytuje flagę)

## Faza 3 — konfiguracja raz-lokalnie

### Unit 5: Modal ustawień powiadomień w dashboardzie (+ push na VPS + Wyczyść)

- [ ] Modyfikuj `public/index.html` (przycisk + modal: 3 pola — Discord webhook URL, Telegram token, Telegram chat ID; przycisk „Wyczyść" per kanał)
- [ ] Modyfikuj `public/app.js` (otwarcie modala z `GET /api/settings/notifications` — placeholdery z maskami; zapis `PUT` lokalny, puste pole = nie nadpisuj; „Wyślij na VPS" → `POST /api/settings/notifications/push-to-vps` gdy `vps_configured`; „Wyczyść" → `PUT` z pustymi stringami kluczy kanału)
- [ ] Test: [E2E] otwórz modal → placeholdery „skonfigurowano/…4242"; wpisz wartość → Zapisz → ponowne otwarcie pokazuje nową maskę
- [ ] Test: [E2E] „Wyczyść" przy kanale → GET pokazuje `configured:false` (przy pustym env)
- [ ] Weryfikacja: scenariusz E2E lokalny przez agent-browser przechodzi (zapis + odczyt maski)
- [ ] Weryfikacja (operator): push na żywy VPS — `GET /api/vps/settings/notifications` po pushu pokazuje `configured:true`

### Unit 6: Setup lokalny — pytania do state, auto-detect chat ID, test-send, push na VPS

- [ ] Modyfikuj `setup.mjs` (Discord do state zamiast `persistEnvVar`; pytanie o token Telegrama; auto-detekcja chat ID: „napisz cokolwiek do bota i wciśnij Enter" → `getUpdates` → potwierdzenie, ręczny fallback; test-send „✅ Puls połączony z Telegramem" z warn przy padzie; push przez `lib/notify-push.js` z timeoutem, warn przy padzie z podpowiedzią o dashboardzie i aktualizacji VPS)
- [ ] Modyfikuj `setup.test.mjs` (czyste funkcje z DI: `buildNotificationSettingsPayload`, `extractChatIdFromUpdates`)
- [ ] Rozstrzygnij moment zapisu `setState` (DB otwierana przy smoke-teście PO pytaniach — odpowiedzi w zmiennych, zapis przy smoke-teście)
- [ ] Test: `buildNotificationSettingsPayload` — tylko wypełnione pola w payloadzie; wszystkie puste → `null` (pomiń push)
- [ ] Test: `extractChatIdFromUpdates(json)` — jedna rozmowa → chat ID; brak update'ów → `null` (ręczny fallback); wiele czatów → najnowszy
- [ ] Weryfikacja: `node --test setup.test.mjs` zielony
- [ ] Weryfikacja (operator): pełny setup na żywo (prawdziwy bot) — chat ID wykryty, testowa wiadomość dochodzi, po setupie VPS ma konfigurację

### Unit 7: Instalator VPS przestaje pytać o Discord

- [ ] Modyfikuj `scripts/install-vps.sh` (usuń pytanie `ask_valid DISCORD_URL` ~1198-1200; linię `DISCORD_WEBHOOK_URL` z `build_puls_env_lines` ~1237-1245; wpisy w podsumowaniach ~1143-1152 i ~1678-1679; `is_valid_discord_webhook` 249-251 jeśli bez innych konsumentów — grep; dodaj w podsumowaniu: „Powiadomienia skonfigurujesz przy instalacji lokalnej — trafią tu automatycznie")
- [ ] Modyfikuj `scripts/install-vps.test.sh` (test 21 usunięty — testował usuwaną funkcjonalność; test 45: asercja, że unit NIE zawiera `DISCORD_WEBHOOK_URL`; asercje `WEBHOOK_BASE_URL` zostają)
- [ ] Test: `build_puls_env_lines` nie emituje `DISCORD_WEBHOOK_URL` niezależnie od env
- [ ] Test: harness instalatora przechodzi bez pytania o Discord (brak wiszącego `read`)
- [ ] Weryfikacja: `bash scripts/install-vps.test.sh` zielony; `grep -c DISCORD scripts/install-vps.sh` → 0 (lub wyłącznie komentarz historyczny)

## Faza 4 — onboarding: taski i skill

### Unit 8: Podstawowe taski — szablony + seed w setupie lokalnym

- [ ] Stwórz `templates/starter-jobs.json` (Daily memory update `0 6 * * *`/1800000, Weekly memory update `0 8 * * 1`/600000, Reflect tygodniowy `0 8 * * 1`/1200000, Poszukiwanie nowych skillów `0 9 * * 5`/600000; wspólnie `enabled=1`, `run_on_wake=1`, `job_type:'claude'`, `discord_notify=0`, `telegram_notify=0`)
- [ ] Stwórz `lib/starter-jobs.js` (czysta `computeStarterJobsToSeed(defs, existingJobs, availableSkillNames)` → `{toSeed, skipped:[{name, reason}]}`; skorupa `seedStarterJobs()` — JSON + `getAllSkills()` + `db.createJob`)
- [ ] Stwórz `lib/starter-jobs.test.js`
- [ ] Modyfikuj `setup.mjs` (po smoke-teście DB: pytanie zbiorcze `[T/n]` → seed → raport dodanych/pominiętych z powodem)
- [ ] Test: pusty stan + wszystkie skille dostępne → 4 do seedu; job o tej samej nazwie → pominięty (`reason:'exists'`); skill niedostępny → pominięty (`reason:'missing_skill'`)
- [ ] Test: seed na DB `:memory:` → `getAllJobs()` zawiera 4 joby z poprawnymi cronami i `enabled=1`; drugi seed → 0 nowych
- [ ] Weryfikacja: `npm test` zielony (w tym `node --test lib/starter-jobs.test.js`)

### Unit 9: Skill `puls` + instalacja globalna w setupie

- [ ] Stwórz `skills/puls/SKILL.md` (frontmatter: `name: puls`, `description` z frazami-triggerami PL, `allowed-tools: ["Bash", "Read"]`; treść: baza `http://localhost:7777` + `/api/vps/*`; tabela endpointów — jobs CRUD, trigger, toggle, webhook token, runs, runs/current + kill, skills, status, settings/notifications + push-to-vps; whitelist pól joba + defaulty + walidacja; czytanie logów stream-json; przykłady curl; wskazanie `templates/starter-jobs.json`)
- [ ] Modyfikuj `setup.mjs` (kopiowanie rekurencyjne `skills/puls` → `~/.claude/skills/puls`, nadpisanie przy re-run; helper czysty z DI ścieżek)
- [ ] Modyfikuj `setup.test.mjs` (test helpera kopiowania)
- [ ] Test: helper kopiowania — kopiuje drzewo, nadpisuje istniejące, tworzy katalog docelowy
- [ ] Weryfikacja: `node --test setup.test.mjs` zielony; `~/.claude/skills/puls/SKILL.md` istnieje po przebiegu helpera; frontmatter parsowalny przez `gray-matter` (skaner `lib/skills.js` widzi skill)
- [ ] Weryfikacja (operator): test skilla w żywej sesji Claude Code (utworzenie + diagnoza joba przez rozmowę)

## Faza 5 — dokumentacja

### Unit 10: Dokumentacja (README, CLAUDE.md, szablon e2e-env)

- [ ] Modyfikuj `README.md` (sekcja Telegram: BotFather krok po kroku, auto-detect chat ID w setupie; „Powiadomienia konfigurujesz raz — lokalnie" + priorytet state>env + nota o re-runie VPS usuwającym env Discorda; powiadomienia o failach; podstawowe taski; skill puls)
- [ ] Modyfikuj `CLAUDE.md` (wzmianki: `lib/telegram.js`/`notify-format.js`/`notify-config.js`/`notify-push.js`, priorytet state>env, endpointy settings + push-to-vps, `templates/starter-jobs.json`, katalog `skills/`)
- [ ] Modyfikuj `.claude/templates/e2e-env/.env.e2e.example` (`TELEGRAM_*`)
- [ ] Weryfikacja: `grep -q TELEGRAM_BOT_TOKEN README.md CLAUDE.md` przechodzi; `npm test` zielony (regresja całości)
