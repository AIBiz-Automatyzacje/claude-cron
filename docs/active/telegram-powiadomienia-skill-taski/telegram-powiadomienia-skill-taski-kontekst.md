# Kontekst: Telegram, konfiguracja powiadomień raz-lokalnie, skill puls, podstawowe taski

Branch: `feature/telegram-powiadomienia-skill-taski`
Ostatnia aktualizacja: 2026-07-03

## Powiązane pliki

### Istniejące (wzorce i punkty dotknięcia)

- `lib/discord.js` — wzorzec kanału powiadomień: `extractResult` (parse stream-json, wpis `type:'result'`), `smartSplit(text, maxLen)`, `postWebhook` na `node:https`; `DISCORD_WEBHOOK_URL` dziś zamrażany przy `require` — zmiana na resolve przy wysyłce.
- `lib/executor.js:220-222` (claude) i `295-297` (script) — jedyne punkty wywołania powiadomień: `status==='success' && job.discord_notify`, fire-and-forget `.catch(() => {})`. Dochodzi wariant fail (R9) w obu miejscach.
- `lib/db.js` — `getState`/`setState` (345-350); wzorzec migracji `PRAGMA table_info` → `ALTER` (105-116); whitelisty: `createJob` (164/166/169), `updateJob` `allowed` (174) + koercja bool (181); `discord_notify` w `CREATE TABLE` (42) jako wzór dla `telegram_notify`.
- `server.js:176-346` — ręczny router `handleApi` (match po `segments`); proxy `/api/vps/*` (129-174) — forwarduje body dla PUT/POST (zweryfikowane w roaście); guard 403 XFF (400-405) obejmie nowe endpointy automatycznie.
- `public/index.html:244` (checkbox `form-discord`, hint 228) + `public/app.js` ~821 (reset), ~865 (edit), ~920 (save body) — trzy punkty dotknięcia per-job checkboxa; istniejące modale jako wzorzec dla okna ustawień.
- `setup.mjs` — blok pytań ~497-530 (`ask` z readline, obsługuje tty-handoff), `persistEnvVar` (439-450), smoke-test DB PO pytaniach; ESM (import CJS z `lib/` przez default import).
- `scripts/install-vps.sh` — pytanie o Discord ~1198-1200, `is_valid_discord_webhook` 249-251 (grep konsumentów przed usunięciem), `build_puls_env_lines` ~1237-1245, podsumowania ~1143-1152 i ~1678-1679; testy 21 i 45 w `scripts/install-vps.test.sh`.
- `lib/skills.js:96-108` — `getAllSkills()` (project > user > plugin) do sprawdzania dostępności skilli przed seedem.

### Nowe

- `lib/notify-format.js` + test — współdzielone `extractResult`/`smartSplit`.
- `lib/notify-config.js` + test — `resolveNotifyConfig(stateGetter, env)` (state niepusty > env) + maskowanie.
- `lib/notify-push.js` + test — push konfiguracji na VPS (PUT + potwierdzenie GET-em); konsumenci: endpoint push-to-vps i setup.mjs.
- `lib/telegram.js` + test — `buildMessages` (czysta), `sendNotification` (sieć w skorupie), warianty sukces/fail.
- `lib/starter-jobs.js` + test — `computeStarterJobsToSeed(defs, existingJobs, availableSkillNames)`.
- `templates/starter-jobs.json` — deklaratywne szablony 4 tasków.
- `skills/puls/SKILL.md` — nowy top-level katalog `skills/` (skille dystrybuowane z produktem, odrębny od dev `.claude/skills/`).

## Decyzje techniczne

1. **Konfiguracja w `state`** (klucze `discord_webhook_url`, `telegram_bot_token`, `telegram_chat_id`), env jako fallback; resolve w czasie wysyłki, nie przy `require`.
2. **Push na VPS server-side (R10, roast)** — `POST /api/settings/notifications/push-to-vps`: serwer czyta pełne wartości z własnego state i PUT-uje na VPS. GET zawsze maskuje (configured + ostatnie 4 znaki). Dashboard nigdy nie widzi pełnych sekretów.
3. **Czyszczenie tylko jawnym przyciskiem „Wyczyść"** (roast) — PUT z pustym stringiem czyści klucz; puste pole przy zwykłym zapisie = nie nadpisuj.
4. **Powiadomienia o failach (R9, roast)** — ta sama flaga per job; `fail`/`timeout` po wyczerpaniu retry; nigdy `killed`; oba kanały symetrycznie („❌ <job> padł" + skrót `error_msg`; Discord: czerwony embed `0xFF0000`).
5. **Auto-detekcja chat ID (roast)** — setup: „napisz cokolwiek do bota i wciśnij Enter" → `getUpdates` → potwierdzenie; ręczne wpisanie jako fallback.
6. **Seed bez powiadomień (roast)** — wszystkie starter-taski `discord_notify=0`, `telegram_notify=0`.
7. **Telegram plain text, bez `parse_mode`** — zero problemów z escapowaniem; `TELEGRAM_MAX_LEN = 4096`.
8. **Skill kopiowany, nie symlinkowany** — Windows bez uprawnień do symlinków; nadpisanie przy re-run.
9. **Seed w setupie, NIE w `migrate()`** — learned pattern (backfill w migrate clobberuje opt-outy); idempotencja po `name`.
10. **Test-send / push weryfikowane stanem faktycznym** — `ok:true` w JSON odpowiedzi Telegrama (nie kod HTTP); push potwierdzany GET-em po PUT (learned pattern: fałszywe sygnały statusów CLI).
11. **Fallback „Job completed (no result text)" żyje w `extractResult`** (eksport `RESULT_FALLBACK` z `notify-format`), nie u wołającego — dawne `|| fallback` w `sendNotification` pokrywało te same ścieżki, zachowanie end-to-end identyczne (Faza 1, IU-1).
12. **`extractResult`/`smartSplit` NIE są re-eksportowane z `discord.js`** — grep repo wykazał zero konsumentów poza samym `discord.js` (executor importuje tylko `sendNotification`); jedyne źródło to `notify-format` (Faza 1, IU-1).
13. **Payload pusha na VPS budowany z resolved configu (state > env), nie z gołego state** — push użyteczny też dla starych instalacji env-only; sekrety nadal wyłącznie server-side (Faza 1, IU-2).
14. **`discord.js` zależy teraz od `db.js`** (odczyt state przy wysyłce przez `resolveNotifyConfig(db.getState, process.env)`) — bez cyklu importów (db nie importuje discord).
15. **Decyzja „czy fail jest ostateczny" w czystej `isFinalFailure(status, maxRetries, recentFailedCount)`** (eksport z `executor.js`): `timeout` zawsze ostateczny (scheduler nie retry'uje timeoutów), `killed` nigdy nie powiadamia, `failed` ostateczny gdy liczba failów w oknie ostatnich `max_retries+1` runów PRZEKRACZA `max_retries` — to samo okno co logika retry w `scheduler.processQueue`, liczone PO `db.updateRun` (bieżący fail już w bazie). (Faza 2, IU-3)
16. **Guard `killed` w obu close handlerach executora** — `killCurrent` zapisuje status `killed` w DB zanim proces się domknie; close handler czyta stan faktyczny z DB (`getRunWithPayload`) PRZED obliczeniem statusu z exit code, inaczej SIGTERM ≠ 0 → `failed` nadpisałby `killed` i R9 wysłałoby ❌ po świadomym killu usera. (Faza 2, IU-3)
17. **`buildMessages` budżetuje nagłówek w limicie chunków** — `smartSplit` dostaje `4096 - len('✅ <job.name>') - 1`, żeby pierwsza wiadomość (nagłówek + `\n` + chunk) też mieściła się w limicie Telegrama. (Faza 2, IU-3)
18. **Wspólna semantyka skrótu przyczyny failu w obu kanałach** — `error_msg` gdy niepusty, inaczej OGON stderr (ostatnie 1000 znaków; ostatnie linie mówią najwięcej); Discord tnie do 2000 (embed description), Telegram do 4096. (Faza 2, IU-3)
19. **Moment zapisu konfiguracji w setupie rozstrzygnięty** — odpowiedzi z pytań hoistowane do zmiennych przed blokiem `try`; `persistNotifySettings` woła `db.setState` bezpośrednio PO udanym smoke-teście DB (DB dopiero wtedy otwarta), push na VPS zaraz potem; pad test-sendu/pusha = warn z podpowiedzią (dashboard / aktualizacja VPS), nigdy przerwanie setupu. (Faza 3, IU-6)

## Stan realizacji

- **Faza 1 — UKOŃCZONA (2026-07-03).** Unit 1 (notify-format) i Unit 2 (notify-config + notify-push + endpointy `GET/PUT /api/settings/notifications`, `POST .../push-to-vps`) zaimplementowane. `npm test`: 202/202 PASS. Nowe pliki: `lib/notify-format.js(+test)`, `lib/notify-config.js(+test)`, `lib/notify-push.js(+test)`; zmodyfikowane: `lib/config.js` (eksport `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`), `lib/discord.js` (resolve przy wysyłce), `server.js` (3 route'y).
- Nota testowa IU-2: test timeoutu notify-push wymaga ref'owanego keep-alive timera w harnessie — timer `AbortSignal.timeout` jest unref'owany i event loop `node:test` umierał przed abortem (poprawka harnessu, asercje nietknięte).
- **Review fazy 1 (2026-07-03)** — raport: `review-faza-1.md`. Gate: ⚠️ ZASTRZEŻENIA (0×P1, 2×P2, 16×P3, 0×OPERATOR). P2: (1) `notify-push.js:38` — `new URL` poza try łamie kontrakt `{ok, reason}` przy VPS URL bez protokołu; (2) brak `lib/discord.test.js` dla zmienionego wiringowania webhook URL (resolve przy wysyłce). Odroczone curl E2E Unit 2 wykonane w review na izolowanej instancji (port 7791, świeża baza): 5/5 passed — maski w GET, zapis PUT, 400 na nieznany klucz, czyszczenie pustym stringiem, 503 push bez VPS; bonusowe repro potwierdziło P3 `parseBody` (malformed JSON → 200 no-op). Kluczowe wnioski przed fazą 2: naprawić boundary bugi `smartSplit` (chunk maxLen+1, pusty chunk) zanim Telegram odziedziczy chunking 4096; rozstrzygnąć martwe eksporty `TELEGRAM_*` w config.js (dwa źródła prawdy nazw env); znormalizować `reason` do enum-kodów (`network_error`) zanim modal Fazy 3 zacznie po nich mapować. Oba checkboxy `Weryfikacja:` fazy 1 odznaczone (CLI 202/202 + curl E2E).
- **Faza 2 — ZAIMPLEMENTOWANA (2026-07-03), czeka na review.** Unit 3: `lib/telegram.js(+test)` (buildMessages/buildFailureMessage czyste + sendNotification/sendFailureNotification na `node:https`), kolumna `telegram_notify` w `lib/db.js` (CREATE TABLE + migracja PRAGMA + createJob/updateJob, testy w `lib/db.test.js`), `lib/executor.js` — wspólny `notifyRunOutcome` w obu close handlerach (sukces wg flag; ostateczny fail/timeout → ❌ na oba kanały; nigdy `killed`), czysta `isFinalFailure` z testami w nowym `lib/executor.test.js`; wariant fail w `lib/discord.js` (`sendFailureNotification`, czerwony embed) + nowe testy w `lib/discord.test.js`. Unit 4: checkbox `form-telegram` w `public/index.html` + trzy punkty w `public/app.js` (reset/edit/save). `npm test`: 230/230 PASS (było 202; +28). Smoke API na żywym serwerze: `POST /api/jobs {telegram_notify:true}` → GET zwraca `1`, `PUT {telegram_notify:false}` → `0`.
- Nota IU-3: guard `killed` w close handlerach (decyzja 16) to odchylenie od litery IU wymuszone wymogiem R9 „nigdy przy killed" — killCurrent zapisuje `killed` w DB, a close liczył status z exit code i nadpisywał go na `failed`.
- Znane P3 przed review fazy 2: boundary bugi `smartSplit` (chunk maxLen+1 przy `'. '` na granicy, pusty chunk) NIE naprawione w fazie 2 (poza scope IU-3 zgodnie z instrukcją) — `lib/telegram.js` dziedziczy je przez chunking 4096; do domknięcia razem z review-fix `notify-format.js`.
- **Review fazy 2 (2026-07-03)** — raport: `review-faza-2.md`. Gate: ⛔ BLOKUJE (2×P1, 4×P2, 19×P3, 2×OPERATOR). P1 (jeden defekt, dwie kotwice): retry w `scheduler.processQueue` jest MARTWE (warunek `run.status==='failed'` czyta stale-owy obiekt sprzed `executeRun`; status idzie tylko do DB), a `isFinalFailure` w executorze wstrzymuje ❌ zakładając, że retry istnieje → przy domyślnym `max_retries=1` user nie dostaje ŻADNEGO powiadomienia o failu (R9 złamane w domyślnej konfiguracji). P2: DoS nieskończona pętla `smartSplit` przy ujemnym maxLen (długa nazwa joba), off-by-one chunk 4097>4096 (eskalacja P3 z fazy 1 — wymóg naprawy przed fazą 2 zignorowany), brak testów szwu `notifyRunOutcome` i guardu `killed`. Kluczowy wniosek: luka testowa na szwie integracji (P2) zamaskowała P1 — testy czystych funkcji przeszły, zachowanie systemowe złamane. E2E Unit 4: PASS na świeżej instancji (port 7799); produkcyjny `localhost:7777` wymaga restartu (kod sprzed fazy 2 cicho gubi `telegram_notify`) — Operator checklist. Oba checkboxy `Weryfikacja:` fazy 2 odznaczone (CLI 230/230 + 41/41; E2E passed).
- **Fix po review fazy 2 (2026-07-03, commit `0abd9db`)** — wszystkie 2×P1, 4×P2 i wskazane P3 domknięte (checkboxy „Do poprawy po review fazy 2" w zadania.md); pozostałe 16 P3 udokumentowane w `review-faza-2.md`, nie blokują.
- **Faza 3 — ZAIMPLEMENTOWANA (2026-07-03), czeka na review.** Unit 5 (IU-5): modal ustawień powiadomień w `public/index.html` + `public/app.js` (`openNotifyModal`/`saveNotifySettings`/`clearNotifyChannel`/`pushNotifyToVps`; placeholdery z masek `GET /api/settings/notifications`, puste pole = nie nadpisuj, „Wyczyść" per kanał = PUT z pustymi stringami kluczy, „Wyślij na VPS" tylko gdy `vps_configured`, mapa `PUSH_REASON_MESSAGES` na enum-kody reason) — bez testów jednostkowych zgodnie z IU (scenariusze wyłącznie [E2E]/[Manual] dla review/operatora). Unit 6 (IU-6): `setup.mjs` — Discord do state zamiast `persistEnvVar`, pytanie o token Telegrama, auto-detekcja chat ID (`getUpdates` → potwierdzenie `[Y/n]`, ręczny fallback), test-send „✅ Puls połączony z Telegramem" weryfikowany `ok:true` z JSON-a, `persistNotifySettings` po smoke-teście DB + push przez `lib/notify-push.js`; czyste funkcje `buildNotificationSettingsPayload`/`extractChatIdFromUpdates` z testami w `setup.test.mjs`. Unit 7 (IU-7): `scripts/install-vps.sh` — usunięte pytanie o Discord, walidator `is_valid_discord_webhook`, wpisy Discord w podsumowaniach i parametr `discord_url` z `build_puls_env_lines` (nota: powiadomienia trafiają na VPS pushem z lokalnego setupu/dashboardu); `grep -c DISCORD scripts/install-vps.sh` → 0. Walidacja: `npm test` 255/255 PASS (było 230; +25), `node --test setup.test.mjs` 46/46, `bash scripts/install-vps.test.sh` 101/101; `node --check` app.js/setup.mjs i `bash -n` install-vps.sh czyste.

## Zależności

- Kolejność Unitów: 1 → 2 → 3 → {4, 5, 6} → 7; 8 po 3; 9 po 2+8; 10 na końcu.
- Push z setupu wymaga zaktualizowanego serwera na VPS (endpoint settings) — stary VPS → 404 → warn z instrukcją (cron auto-update 02:00).
- Seed wymaga `CLAUDE_CRON_WORKSPACE` w env (ustawiane wcześniej w setupie) i skilli kursanta w źródłach skanera.
- `node:https` do `api.telegram.org` — wymaga wyjścia sieciowego; krótkie timeouty, fire-and-forget.
- Zależności npm: bez nowych (natywny `fetch` w setup.mjs, `node:https` w lib).

## Wiedza instytucjonalna (docs/solutions/)

- `runtime-errors/2026-06-27-backfill-w-migrate-clobberuje-opt-outy.md` — seed poza migrate.
- `deployment-issues/2026-06-30-curl-bash-instalator-interaktywny-tty.md` — nowe pytania przez istniejący `ask`; install-vps.sh testować przez prawdziwy pipe.
- `deployment-issues/2026-07-03-guardy-instalatora-falszywe-sygnaly-statusow-cli.md` — weryfikacja dokładną frazą stanu faktycznego.
- `deployment-issues/2026-07-01-instalator-cross-platform-irm-iex-encoding-env-symlink.md` — install.ps1 nie dotykamy (czyste ASCII).

## Środowisko produkcyjne usera (weryfikacja operatora)

- Lokalna instancja: `http://localhost:7777` (starter-taski istnieją tam 1:1 — zweryfikowane w roaście).
- VPS: `http://100.122.215.61:7777` po Tailscale (env `CLAUDE_CRON_VPS_URL`); szczegóły w memory `vps-puls-produkcja`.

## Źródła

- Requirements doc: brak (decyzje z sesji 2026-07-03 przez AskUserQuestion + roast /zroastuj-mnie — zapis w sekcji „Rozwiązane podczas roastu" planu technicznego)
- Plan techniczny: `docs/plans/2026-07-03-001-feat-telegram-powiadomienia-skill-taski-plan.md`
