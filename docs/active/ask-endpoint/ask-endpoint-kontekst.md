# Kontekst: Endpoint /ask — asystent głosowy

Branch: `feature/ask-endpoint`
Ostatnia aktualizacja: 2026-07-13 (faza 1 ukończona: U1 + U2)

## Stan po fazie 1 (U1 + U2)

- `lib/claude-spawn.js` powstał: `spawnClaude(args)`, `buildCleanEnv(baseEnv, oauthTokenFile)` (strip `CLAUDE_CODE*`/`CLAUDECODE` → inject OAuth PO stripie), `readOauthToken`, `setClaudeBin` (override binarki dla testów, wzorzec `db.setDbPath`), `OAUTH_TOKEN_FILE`.
- `lib/executor.js` przeszedł na `claudeSpawn.spawnClaude(args)`; stateful (currentProcess, timeouty, watchdog, caffeinate, kill) został na miejscu. `readOauthToken` re-eksportowany z executora dla kompatybilności istniejących importów (m.in. `lib/executor.test.js`).
- `lib/config.js`: sekcja `// Ask (asystent głosowy)` — `ASK_ENABLED` (opt-in, truthy tylko przy `'1'`), `ASK_TOKEN`/`ASK_SECRET` (env, brak defaultów), `ASK_TIMEOUT_MS` 55000, `ASK_MAX_MS` 600000, `ASK_MODEL` 'sonnet'.
- `lib/webhook.js`: `ASK_URL_PATTERN` + `matchAskToken(url)` bliźniacze do `matchWebhookToken`.
- Testy: `lib/claude-spawn.test.js` (5 testów, realny spawn `node <skrypt tmp>`, w tym regresja shell:true na wielowyrazowym prompcie) + rozszerzony `lib/webhook.test.js` (matcher + defaulty config). Cały suite: 284/284 PASS, testy executora/schedulera bez zmian asercji (refactor charakteryzacyjny potwierdzony).

## Powiązane pliki

**Nowe:**
- `lib/claude-spawn.js` + `lib/claude-spawn.test.js` — wspólny helper spawnu CLI claude (U1)
- `lib/ask.js` + `lib/ask.test.js` — moduł asystenta: bramki, teczka, wykonanie, powiadomienia (U3, U4, U6)
- `lib/ask.http.test.js` — test HTTP na żywym serwerze, wzorzec `server.env.test.js` (U5)

**Modyfikowane:**
- `lib/executor.js` — przejście na helper spawnu; linie 100-152 to źródło wydzielenia; `readOauthToken` (24-33, eksport 413) wędruje do helpera (U1)
- `lib/config.js` — sekcja `ASK_*` obok `// Webhooks` (linie 41-43) (U2)
- `lib/webhook.js` + `lib/webhook.test.js` — `matchAskToken` bliźniaczy do `matchWebhookToken` (5-11) (U2)
- `lib/discord.js`, `lib/telegram.js` (+ testy) — seam plain-text dla powiadomień ask (kształt odroczony) (U4)
- `server.js` — routing `/ask/:token` MIĘDZY webhookiem (432-436) a guardem XFF (438-444); reader surowego body (`parseBody` 40-49 nie nadaje się — zawsze JSON-uje); wywołanie powiadomień reapera przy starcie (466-467) (U5, U6)
- `lib/db.js` + `lib/db.test.js` — `reapOrphanedRuns` (326-333) zwraca zebrane runy zamiast samego `changes` (U6)
- `public/enum-map.js` — etykieta triggera `ask` (U5)

**Referencyjne (wzorce, nie do zmiany):**
- `lib/starter-jobs.js` — idempotentny seed joba po `name`
- `lib/notify-format.js` — `smartSplit` (reuse), `extractResult` (NIE używać — parsuje stream-json)
- `lib/notify-config.js` — `resolveNotifyConfig` w czasie wysyłki
- `lib/executor.js:250-288` — close handler (re-read → status → updateRun → notify), 172-186 kill drzewa
- `server.env.test.js:13-54` — spawn serwera na efemerycznym porcie + fetch
- `scheduler.test.js:266-271`, `executor.test.js:85-92` — realny spawn `node <skrypt tmp>`, mock tylko kanałów

## Decyzje techniczne

(pełne uzasadnienia: plan techniczny, sekcja „Kluczowe decyzje techniczne")

1. **Rezerwacja slotu tła pesymistycznie przy spawnie** (decyzja usera 13.07): 3 zajęte sloty → natychmiast „⏳ Mam pełne ręce" bez spawnu. Jedyny wariant godzący „zero killi po timeoucie" z twardym limitem procesów.
2. **Przyjazne komunikaty ZAWSZE jako 200** (Shortcuts gubi body przy kodach błędów); 403/404/405 tylko dla intruzów. Testy assertują TREŚĆ.
3. **Ask omija kolejkę schedulera i `notifyRunOutcome`** — własna ścieżka powiadomień plain-text tylko dla odczepionych; kontrakt „`killed` milczy" schedulera nietknięty.
4. **`--output-format text`** — surowy stdout do zwrotu i powiadomień (`smartSplit`), bez `--verbose`, bez `extractResult`.
5. **Teczka get-or-create po `name: 'Asystent głosowy'`** przy pierwszym użyciu, POZA `migrate()`; nigdy nie nadpisuje flag usera. Deploy = tylko włączenie kanału w panelu.
6. **`trigger_type: 'ask'`**; pytanie w `runs.webhook_payload`, odpowiedź w `stdout` — zero migracji schematu. Statusy bez nowych wartości: success/failed/timeout(`ASK_MAX_MS`)/killed(reaper).
7. **Liczniki (rate limit, sync lock, sloty) czysto in-memory** — zero agregatów SQL (pułapka BigInt w node:sqlite); reset przy restarcie spójny z rzeczywistością (procesy giną z serwerem, reaper domyka runy).
8. **Sekrety w env, nie w state DB** (jawna decyzja konspektu); rotacja = restart daemona.
9. **Helper spawnu**: czyste „env+binarka+spawn" z parametryzowanymi argumentami; stateful (currentProcess, timeouty, watchdog, caffeinate, kill) zostaje w executorze. Override binarki dla testów (wzorzec `db.setDbPath`).
10. **Decyzje po zapisie na świeżym odczycie z DB** — close handler odczepionego procesu re-readuje run przed zapisem (guard `killed` od reapera/usera); finalize idempotentny.

## Zależności

- Kolejność unitów: U1, U2 (równoległe) → U3 → U4 → U5 → U6.
- Zewnętrzne: CLI `claude` na VPS + OAuth w `~/.claude-cron-oauth-token` (istnieje); Tailscale Funnel na `kacper.tail4f19b2.ts.net:8443` (bez zmian); Node ≥22.13 (bez zmian).
- Brak nowych zależności npm — czysty node:http, node:crypto, child_process.

## Pułapki z wiedzy instytucjonalnej

- `docs/solutions/runtime-errors/2026-07-03-stale-obiekt-w-pamieci-vs-stan-db-martwe-retry.md` — świeży odczyt przed zapisem; test szwu ask+reaper OBOWIĄZKOWY.
- `docs/solutions/runtime-errors/2026-06-27-backfill-w-migrate-clobberuje-opt-outy.md` — teczka nigdy w `migrate()`, idempotencja po `name`.
- `docs/solutions/performance-issues/2026-06-23-per-job-recent-runs-window-function.md` — kolejność matcherów routera to kontrakt; nie regresować window function.
- `docs/solutions/runtime-errors/2026-06-29-migracja-better-sqlite3-na-node-sqlite.md` — agregaty BigInt; liczniki in-memory.
- `docs/solutions/deployment-issues/2026-07-07-stale-env-vps-url-hook-respawn-serwera.md` — env czytane raz; rotacja sekretów = restart.

## Źródła

- Requirements doc: brak (rolę pełni `docs/konspekt-endpoint-ask.md`, wersja po roaście 13.07.2026)
- Plan techniczny: `docs/plans/2026-07-13-001-feat-ask-endpoint-asystent-glosowy-plan.md`
