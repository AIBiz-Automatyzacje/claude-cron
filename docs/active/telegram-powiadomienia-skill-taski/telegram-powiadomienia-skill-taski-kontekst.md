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

## Stan realizacji

- **Faza 1 — UKOŃCZONA (2026-07-03).** Unit 1 (notify-format) i Unit 2 (notify-config + notify-push + endpointy `GET/PUT /api/settings/notifications`, `POST .../push-to-vps`) zaimplementowane. `npm test`: 202/202 PASS. Nowe pliki: `lib/notify-format.js(+test)`, `lib/notify-config.js(+test)`, `lib/notify-push.js(+test)`; zmodyfikowane: `lib/config.js` (eksport `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`), `lib/discord.js` (resolve przy wysyłce), `server.js` (3 route'y).
- Nota testowa IU-2: test timeoutu notify-push wymaga ref'owanego keep-alive timera w harnessie — timer `AbortSignal.timeout` jest unref'owany i event loop `node:test` umierał przed abortem (poprawka harnessu, asercje nietknięte).
- Faza 2 (Telegram end-to-end) — następna.

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
