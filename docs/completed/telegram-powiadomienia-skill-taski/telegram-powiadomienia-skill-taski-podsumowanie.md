# Podsumowanie: Telegram, konfiguracja powiadomień raz-lokalnie, skill puls, podstawowe taski

**Data ukończenia:** 2026-07-03
**Branch:** `feature/telegram-powiadomienia-skill-taski`
**Status:** wszystkie 5 faz ukończone (execute + review + fix), walidacja końcowa i compound zaliczone; otwarte pozostały wyłącznie opcjonalne P3 oraz checklisty operatora (żywy bot Telegrama, push na żywy VPS, test skilla w żywej sesji) — udokumentowane w `*-zadania.md`.

## Co zostało dostarczone

1. **Fundament powiadomień** — wspólny moduł formatowania `lib/notify-format.js` (`extractResult`, `smartSplit` z naprawionymi bugami brzegowymi: off-by-one na granicy `'. '`, pusty chunk, fail-fast przy `maxLen <= 0`); konfiguracja powiadomień w `state` z priorytetem state > env (`lib/notify-config.js`); push konfiguracji na VPS z potwierdzeniem GET-em po PUT (`lib/notify-push.js`); endpointy `GET/PUT /api/settings/notifications` + `POST /api/settings/notifications/push-to-vps` (GET zawsze maskuje sekrety — configured + ostatnie 4 znaki).
2. **Kanał Telegram end-to-end** — `lib/telegram.js` (plain text bez parse_mode, chunking 4096 z budżetem nagłówka), kolumna `telegram_notify` w DB z migracją, checkbox per job w dashboardzie; powiadomienia o failach (R9) na oba kanały symetrycznie (❌ po ostatecznym failu/timeout, nigdy przy `killed`); wspólny punkt decyzyjny `notifyRunOutcome` w executorze + naprawione martwe retry w schedulerze (P1).
3. **Konfiguracja raz-lokalnie** — modal 🔔 Powiadomienia w dashboardzie (zapis, „Wyczyść" per kanał, „Wyślij na VPS"); `setup.mjs` pyta o Discord/Telegrama z auto-detekcją chat ID (`getUpdates`) i test-sendem; instalator VPS przestał pytać o Discord (konfiguracja przychodzi pushem z lokalnej instalacji).
4. **Onboarding** — `templates/starter-jobs.json` (4 startowe taski) + idempotentny seed w setupie (`lib/starter-jobs.js`) z reschedule na działającym serwerze; skill `skills/puls/SKILL.md` instalowany globalnie do `~/.claude/skills/puls` (kopiowanie, nie symlink — Windows).
5. **Dokumentacja** — README (sekcje Powiadomienia/Podstawowe taski/Skill puls, BotFather krok po kroku), CLAUDE.md (architektura powiadomień, setup), szablon e2e-env z `TELEGRAM_*`.

## Kluczowe decyzje

- **Konfiguracja w `state`, env jako fallback; resolve przy każdej wysyłce**, nie przy `require` — umożliwia zmianę bez restartu i push na VPS.
- **Push na VPS server-side** — serwer czyta pełne wartości z własnego state i PUT-uje na VPS; dashboard nigdy nie widzi pełnych sekretów (GET wyłącznie maski; wyjątek: `chat_id` jawny).
- **Czyszczenie tylko jawnym przyciskiem** — pusty string w PUT czyści klucz; puste pole przy zwykłym zapisie = nie nadpisuj.
- **Fail-notify (R9)**: ta sama flaga per job, ostateczność failu liczona czystą `isFinalFailure` na świeżym stanie z DB (nie na stale-owym obiekcie in-memory), `timeout` zawsze ostateczny, `killed` nigdy nie powiadamia.
- **Telegram plain text bez `parse_mode`** (zero problemów z escapowaniem), limit 4096 z budżetem nagłówka w pierwszym chunku.
- **Seed w setupie, NIE w `migrate()`** (learned pattern: backfill w migrate clobberuje opt-outy); idempotencja po `name`, opt-in `[T/n]`.
- **Test-send i push weryfikowane stanem faktycznym** (`ok:true` z JSON-a Telegrama, GET po PUT) — learned pattern o fałszywych sygnałach statusów CLI.

## Główne pliki

- Nowe: `lib/notify-format.js`, `lib/notify-config.js`, `lib/notify-push.js`, `lib/telegram.js`, `lib/starter-jobs.js` (wszystkie z kolokowanymi testami), `lib/discord.test.js`, `lib/executor.test.js`, `templates/starter-jobs.json`, `skills/puls/SKILL.md`.
- Zmodyfikowane: `lib/discord.js`, `lib/executor.js`, `lib/scheduler.js`, `lib/db.js`, `lib/config.js`, `server.js`, `public/index.html`, `public/app.js`, `setup.mjs` (+`setup.test.mjs`), `scripts/install-vps.sh` (+test), `README.md`, `CLAUDE.md`.
- Testy: 202 → 267 PASS (`npm test`), instalator VPS 102/102.

## Wyciągnięte wnioski

- **Stale obiekt in-memory vs stan w DB = martwa logika**: retry w `scheduler.processQueue` czytał `run.status` z obiektu sprzed `executeRun`, a status szedł wyłącznie do DB — retry nigdy nie odpalało, a R9 milczało w domyślnej konfiguracji. Po mutacji stanu w DB czytaj świeży rekord, nie trzymany obiekt. (Udokumentowane w `docs/solutions/runtime-errors/2026-07-03-stale-obiekt-w-pamieci-vs-stan-db-martwe-retry.md`.)
- **Luka testowa na szwie integracji maskuje P1** — testy czystych funkcji przeszły, zachowanie systemowe było złamane; szwy (`notifyRunOutcome`, guard `killed`) wymagają testów integracyjnych na DB `:memory:`.
- **Boundary bugi chunkingu odroczone „na później" eskalują** — off-by-one `smartSplit` z fazy 1 (P3) w fazie 2 stał się P2 (Telegram 400, powiadomienie cicho przepada przez `.catch(()=>{})`).
- **`buildMessages` z nielimitowanym inputem = DoS**: ujemny `maxLen` po odjęciu długiego nagłówka wpędzał `smartSplit` w nieskończoną synchroniczną pętlę — guardy `Math.max(1, ...)` i fail-fast na granicach.
- **E2E na izolowanej instancji, nie na produkcyjnym porcie** — testowe tokeny w state zanieczyściłyby realną konfigurację; świeża DB + czysty env na osobnym porcie (7799).
- **Mockowany harness nie łapie regresji interakcji** — test „brak pytania o Discord" wymagał wykonania REALNEGO `collect_config` ze stubem na granicy tty (Test 70), mock `collect_config` niczego nie dowodził.
