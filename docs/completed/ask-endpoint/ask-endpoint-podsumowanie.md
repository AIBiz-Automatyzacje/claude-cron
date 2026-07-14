# Podsumowanie: Endpoint /ask — asystent głosowy

**Data ukończenia:** 2026-07-14
**Branch:** `feature/ask-endpoint`
**Plan źródłowy:** `docs/plans/2026-07-13-001-feat-ask-endpoint-asystent-glosowy-plan.md`

## Co zostało dostarczone

Publiczny (opt-in) endpoint głosowy `POST /ask/:token` — asystent Claude Code odpowiadający synchronicznie w ≤55 s albo odczepiający się w tło z powiadomieniem Discord/Telegram. 6 unitów w 4 fazach, wszystkie z review + adversarial verify + fix; cały suite **332/332 PASS** (+48 nowych testów względem 284 na starcie).

- **U1 — `lib/claude-spawn.js`**: wspólny helper spawnu CLI `claude` (czysty env: strip `CLAUDE_CODE*`/`CLAUDECODE` → OAuth PO stripie; resolve binarki bez `shell:true`; `cwd: WORKSPACE_DIR`). Executor przeszedł na helper, stateful (timeouty, watchdog, caffeinate, kill) został na miejscu.
- **U2 — konfiguracja + matcher**: sekcja `ASK_*` w `config.js` (`ASK_ENABLED` opt-in `=1`, `ASK_TOKEN`/`ASK_SECRET` env bez defaultów, `ASK_TIMEOUT_MS` 55000, `ASK_MAX_MS` 600000, `ASK_MODEL` sonnet — timeouty z override env); `matchAskToken` w `webhook.js`.
- **U3 — bramki wejścia + teczka** (`lib/ask.js`): `verifySecret` (guard długości przed `timingSafeEqual`), kolejność bramek auth → rate limit 10/min → lock sync → 3 sloty tła (rezerwacja pesymistyczna), liczniki czysto in-memory; `getOrCreateAskJob` idempotentny po `name: 'Asystent głosowy'`.
- **U4 — wykonanie**: `executeAsk` (run teczki od razu `running`, spawn `--output-format text --model`, wyścig close vs `ASK_TIMEOUT_MS` = odczepienie bez killa), bezpiecznik `ASK_MAX_MS` (kill drzewa), `finalizeAskRun` idempotentny (świeży odczyt DB, guard `killed`), powiadomienia plain-text przez `sendPlain` w `discord.js`/`telegram.js`.
- **U5 — endpoint HTTP** (`server.js`): match `matchAskToken` MIĘDZY webhookiem a guardem XFF (kontrakt kolejności: webhook → ask → guard XFF → api/static); `readTextBody` z capem 64 KB + `setEncoding('utf8')` + listener error/aborted; odpowiedzi „dla człowieka" zawsze 200 text/plain, kody błędów tylko dla intruzów. Etykieta triggera `ask` w `enum-map.js`.
- **U6 — reaper**: `reapOrphanedRuns` zwraca zebrane runy; runy teczki → ❌ „przerwane przez restart" wg flag; `notifyRunOutcome`/`isFinalFailure` nietknięte („killed milczy" dla zwykłych jobów).

## Kluczowe decyzje

1. **Rezerwacja slotu tła pesymistycznie przy spawnie** — 3 zajęte → natychmiast „⏳ Mam pełne ręce" bez spawnu (godzi „zero killi po timeoucie" z twardym limitem procesów).
2. **Przyjazne komunikaty ZAWSZE jako 200 text/plain** (Shortcuts gubi body przy kodach błędów); 403/405/413 tylko dla intruzów.
3. **Ask omija kolejkę schedulera i `notifyRunOutcome`** — własna ścieżka powiadomień plain-text tylko dla odczepionych; kontrakt „killed milczy" nietknięty.
4. **Teczka get-or-create po `name`, POZA `migrate()`** — nigdy nie nadpisuje flag usera; deploy = tylko włączenie kanału w panelu.
5. **`trigger_type: 'ask'`; pytanie w `webhook_payload`, odpowiedź w `stdout`** — zero migracji schematu.
6. **Liczniki (rate limit/lock/sloty) czysto in-memory** — zero agregatów SQL (pułapka BigInt node:sqlite).
7. **Sekrety w env, nie w state DB**; rotacja = restart daemona.
8. **Decyzje po zapisie na świeżym odczycie z DB** — close handler re-readuje run (guard `killed`); finalize idempotentny.

## Główne pliki

**Nowe:** `lib/claude-spawn.js`(+test), `lib/ask.js`(+test), `lib/ask.http.test.js`
**Modyfikowane:** `lib/executor.js`, `lib/config.js` (+env seamy `CLAUDE_CRON_DB_PATH`/`CLAUDE_CRON_CLAUDE_BIN`), `lib/webhook.js`(+test), `lib/discord.js`(+test), `lib/telegram.js`(+test), `lib/db.js`(+test, `reapOrphanedRuns`), `server.js`, `public/enum-map.js`(+test), `CLAUDE.md`

## Wnioski

- **Body na publicznym endpoincie czytany PRZED auth = wektor OOM** (P1 fazy 3): `readTextBody` bez capu, przed guardem XFF i rate limitem, pozwalał nieuwierzytelnionemu atakującemu z Funnela streamować setki MB → śmierć schedulera. Fix: cap 64 KB + `req.destroy()` + `setEncoding('utf8')` (rozcięty wielobajtowy UTF-8 → U+FFFD, krytyczne dla polskiego głosu) + listener error/aborted.
- **Wnuk CLI dziedziczący pipe blokuje `close` = wyciek slotu** (P2 fazy 2): kill na Unix zabija tylko bezpośrednie dziecko; wnuk trzymający stdout/stderr nie pozwala `close` nadejść → slot wycieka na zawsze (3 = DoS `/ask`). Fix: dodatkowy `proc.on('exit', settle)` (guard `settled` chroni przed podwójnym zwolnieniem). Udokumentowane w `docs/solutions/runtime-errors/2026-07-14-close-nie-odpala-wnuk-dziedziczy-pipe-wyciek-slotu.md`.
- **`shell:true` fallback = command injection** (P2 fazy 1): Node nie escapuje args przy `shell:true`, a args niosą treść z publicznych endpointów. Fix: fail z czytelnym błędem zamiast fallbacku.
- **Test szwu ask+reaper obowiązkowy** — czysta funkcja obu stron przechodzi przy złamanym zachowaniu systemowym (learned pattern 2026-07-03: stale obiekt vs stan DB).
- **Faza 4 = czysto operatorska** (deploy na VPS, realne sekrety, curl przez Funnel, Shortcut na Macu) — niewykonalna headless; substancja pozostaje w Operator checklist. Jedyny headless-wykonalny deliverable fazy 4 to dopisanie `/ask` do `CLAUDE.md` (wykonane).

## Do wykonania przez operatora (nie-headless — patrz Operator checklist w zadania.md)

- Deploy na VPS: merge do `main`, pull, `ASK_*` do env (`openssl rand -hex 32` ×2), restart daemona (env NIE propaguje się do żyjącego procesu), sprawdzić przeżycie `~/.claude-cron-oauth-token`.
- Włączyć kanał powiadomień (Telegram/Discord) na jobie „Asystent głosowy" w panelu.
- Smoke-test curlem z innej maszyny przez Funnel (sekret → odpowiedź; bez sekretu → 403).
- Zbudować Shortcut na Macu, zmierzyć realny limit czekania „Pobierz zawartość URL" (w razie potrzeby obniżyć `ASK_TIMEOUT_MS`).
- Jeśli instalacja Windows ma używać `/ask`: `node --test lib/ask.test.js` + `npm test` na realnej maszynie Windows (gałąź `taskkill` ma skip na win32).
