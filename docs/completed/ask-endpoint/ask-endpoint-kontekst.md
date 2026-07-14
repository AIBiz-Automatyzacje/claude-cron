# Kontekst: Endpoint /ask — asystent głosowy

Branch: `feature/ask-endpoint`
Ostatnia aktualizacja: 2026-07-14 (review fazy 4 — Deploy i Shortcut)

## Stan po fazie 3 (U5 + U6)

- **U5 — endpoint HTTP**: `server.js` — handler `handleAsk` (opt-in `ASK_ENABLED` → 403; nie-POST → 405; 403 bez szczegółów dla intruzów; odmowy „dla człowieka" i sukces jako 200 `text/plain; charset=utf-8` przez helper `plainText`), własny `readTextBody` (surowy tekst — `parseBody` zawsze JSON-uje), puste body → 200 „Nic nie usłyszałem" ze zwrotem OBU rezerwacji z `admitRequest`. Match `matchAskToken` wpięty dokładnie MIĘDZY webhookiem a guardem XFF z polskim komentarzem o kontrakcie kolejności (webhook → ask → guard XFF → api/static). Etykieta triggera `ask` („Asystent", ikona ⌾) w `public/enum-map.js` + test.
- **U6 — reaper**: `db.reapOrphanedRuns()` zwraca listę zebranych `{id, job_id}` (SELECT przed UPDATE; normalizacja null-prototype wierszy node:sqlite), semantyka logu startowego dla zwykłych jobów bez zmian. `lib/ask.js`: `notifyInterruptedAskRuns(reapedRuns)` — lookup teczki po `name` BEZ tworzenia (reaper nie seeduje teczki na czystej instalacji), jedno ❌ „przerwane przez restart serwera — poproś jeszcze raz" per przerwany run teczki; wspólny szew wysyłki `sendAskNotification` (fire-and-forget, pad kanału tylko do logu) wydzielony z `notifyAskOutcome`. `notifyRunOutcome`/`isFinalFailure` nietknięte — kontrakt „killed milczy" dla zwykłych jobów zachowany.
- **Odchylenie od sekcji Pliki planu (U5)**: zmodyfikowany dodatkowo `lib/config.js` — env seamy `CLAUDE_CRON_CLAUDE_BIN` (plan wymaga override binarki przez env przy spawnie serwera; mechanizm nie istniał) i `CLAUDE_CRON_DB_PATH` (izolacja bazy — test HTTP pisze joby/runy i bez seamu zaśmiecałby realną `data/claude-cron.db` usera przy każdym `npm test`).
- Testy: `lib/ask.http.test.js` (8 testów na ŻYWYM procesie serwera, wzorzec `server.env.test.js` — dwa serwery: enabled/disabled, atrapa CLI różnicowana treścią promptu; skip na Windows jak w `lib/ask.test.js`). Scenariusz „trzy przypadki 403" pokryty w dwóch testach: brak `X-Secret` osobno; zły sekret + zły token razem z `deepEqual` na identyczność body (nierozróżnialność dla intruza). Test szwu ask+reaper ×3 w `lib/ask.test.js` (teczka → killed + jedno ❌; zwykły job → cisza mimo włączonych flag; brak osieroconych → no-op), zwrotka reapera ×3 w `lib/db.test.js`, etykieta w `public/enum-map.test.js`.
- Cały suite: **332/332 PASS** (było 318 — +14 nowych). Audyt error-handlingu diffu: zero pustych catchy (`.catch(logNotifyError)` loguje), logi `[ask]`/`[reaper]` przez console = wymóg planu i konwencja repo (rozstrzygnięte w audycie fazy 2).

## Stan po fazie 2 (U3 + U4)

- `lib/ask.js` powstał (335 linii): bramki wejścia + wykonanie w jednym module (struktura narzucona planem — Unit 3 i 4 współdzielą plik; >300 linii z coding-rules zgłoszone do rozważenia splitu w kolejnych fazach).
  - **U3**: `verifySecret` (guard długości przed `timingSafeEqual`), `verifyAuth` (token+sekret liczone bez short-circuit), `admitRequest` (bramki: auth 403 → rate limit 10/min stały kubeł → lock sync → 3 sloty tła; rezerwacja pesymistyczna locka I slotu przy przyjęciu), `releaseSyncLock`/`releaseBackgroundSlot` (floor 0), `resetAskState` (izolacja testów), `getOrCreateAskJob` (idempotencja po `name`, nigdy nie nadpisuje; `run_on_wake:0`, `routine:1`).
  - **U4**: `executeAsk` — run teczki od razu `running`, spawn helperem (`--output-format text --model`), wyścig close vs `ASK_TIMEOUT_MS` (odczepienie logiczne bez killa, lock sync puszczany przy odczepieniu), bezpiecznik `ASK_MAX_MS` liczony OD SPAWNU (rozstrzygnięcie kwestii odroczonej — prostszy wariant, pokryty testem) z finalize już w timerze killa (kill może nie dać close), `finalizeAskRun` idempotentny przez świeży odczyt DB (guard `killed`), `notifyAskOutcome` (✅ stdout / ❌ ogon stderr; oba kanały off = jawny warning `[ask]`), pad spawnu = failed + zwrot OBU rezerwacji.
- Seam kanałów: `sendPlain(text)` w `lib/discord.js` i `lib/telegram.js` (rozstrzygnięcie kwestii odroczonej — bez parametru `job`, ask sam składa nagłówek ✅/❌); surowy tekst przez `smartSplit`, bez embedów/parse_mode/`extractResult`, `resolveNotifyConfig` w czasie wysyłki; testy chunkowania i braku konfiguracji w testach kanałów.
- Testy: `lib/ask.test.js` (26 testów — bramki z wstrzykiwanym zegarem i configiem, spawn realny przez atrapę CLI z shebangiem `#!/usr/bin/env node` + `setClaudeBin`; shebang wymaga POSIX → skip na Windows z jawnym powodem; mocki tylko na kanałach) + po 2 testy `sendPlain` w `lib/discord.test.js`/`lib/telegram.test.js`. Hak testowy `onSettled` w `executeAsk` (DI, wzorzec wstrzykiwanego zegara) — deterministyczne czekanie na close odczepionego procesu zamiast sleep-pollingu.
- Cały suite: **318/318 PASS** (było 284 — +34 nowe). Audyt error-handlingu: logi `[ask]` przez console to wymóg planu i konwencja repo (brak pino/Sentry, zero nowych zależności); puste catche tylko wokół `kill`/`taskkill` (wzorzec executora, wyścig ESRCH).

## Review fazy 4 (2026-07-14)

Multi-agent review + adversarial verify. Raport: `review-faza-4.md`. Gate: **⚠️ ZASTRZEŻENIA** (KOD/TEST/E2E: 0× P1, 1× P2, 3× P3; OPERATOR: 5, w tym 2× P1). Kluczowe wnioski:

- **P2 [KOD]**: jedyny headless-wykonalny deliverable fazy 4 niewykonany — `CLAUDE.md` bez żadnej wzmianki o `/ask`, `lib/ask.js`, `lib/claude-spawn.js` (plan: „po implementacji dopisać do architektury i granic bezpieczeństwa"), mimo `execute=done` w stanie autopilota. Przy tej samej edycji domknąć P3-15 fazy 3 (env-vary `CLAUDE_CRON_DB_PATH`/`CLAUDE_CRON_CLAUDE_BIN`).
- **OPERATOR 2× P1**: cała substancja fazy (deploy `/ask` na VPS, realne sekrety w env + restart daemona, przeżycie OAuth tokenu, curl przez prawdziwy Funnel z innej maszyny, kanał powiadomień na teczce) niewykonalna headless — granica auth publicznego endpointu do czasu wykonania pozostaje udowodniona tylko symulacją XFF + atrapą CLI. OPERATOR nie blokuje gate'u, ale blokuje wdrożenie.
- P3 [KOD]: „długie losowe" sekrety bez komendy generacji (jedyna obrona ścieżki 403 poza rate limitem — dopisać `openssl rand -hex 32` ×2); `execute:'done'` dla fazy czysto operatorskiej bez zapisanej konwencji (ryzyko fałszywej archiwizacji z funkcją nigdy nie wdrożoną); niezacommitowany bookkeeping review fazy 3 w working tree.
- Bookkeeping `Weryfikacja:`: faza 4 nie definiuje ŻADNYCH checkboxów `Weryfikacja:` (0 trafień regexem) — substancja fazy to Operator checklist. E2E: 0 passed / 0 failed / 2 skipped (Funnel + Shortcut → operator).

## Review fazy 3 (2026-07-14)

Multi-agent review + adversarial verify. Raport: `review-faza-3.md`. Gate: **⛔ BLOKUJE** (1× P1, 2× P2, 17× P3, 2× OPERATOR). Kluczowe wnioski:

- **P1**: `readTextBody` w `server.js` czyta body bez limitu rozmiaru, w całości PRZED autoryzacją, na publicznym endpoincie (przed guardem XFF, `matchAskToken` przepuszcza dowolny token) — nieuwierzytelniony atakujący z Funnela streamuje setki MB per połączenie → OOM procesu na VPS = śmierć całego schedulera. Fix: cap (np. 64 KB) + `req.destroy()` po przekroczeniu.
- **P2 ×2**: ten sam `readTextBody` — (a) brak listenera `error`/`aborted` (abort klienta = ryzyko uncaughtException + wisząca Promise), (b) brak `req.setEncoding('utf8')` → rozcięty między chunki znak wielobajtowy daje U+FFFD (udowodnione: „pytanie o pogod��") — krytyczne dla polskiego endpointu głosowego za proxy Funnel. Wszystkie 3 findingi zamyka jeden wspólny helper czytania body z limitem + encoding + error handling (docelowo współdzielony z pre-existing `parseBody`, który ma tę samą lukę na `/webhook/:token` — P3).
- P3 klastrują się wokół: bezpieczeństwa defense-in-depth (403 poza rate limitem — brute-force bez lockoutu; 405 przed auth = fingerprinting `ASK_ENABLED`), duplikacji/SRP (`lib/ask.js` 385 linii → wydzielić `ask-notify.js`; lookup teczki ×2 → `findAskJob()`; `TEXT_EMPTY_QUESTION` poza katalogiem tekstów; leaky abstraction pary rezerwacji w server.js), spec (R11 bez logu odmów; N identycznych ❌ przy wielu przerwanych runach; env-vary `CLAUDE_CRON_DB_PATH`/`CLAUDE_CRON_CLAUDE_BIN` niedopisane do CLAUDE.md) i luk pokrycia (granica rozmiaru body po fixie P1, „bez tworzenia runu" przy pustym body, wiele przerwanych runów naraz).
- Realny Funnel + prawdziwa binarka `claude` + Shortcut na Macu niewykonalne headless → Operator checklist faza 3.
- Bookkeeping `Weryfikacja:`: 3/3 PASS (`npm test` 332/332; realny smoke curlem na żywym serwerze z env-override — 200 `text/plain; charset=utf-8`, bez sekretu 403). E2E: 0 passed / 0 failed / 2 skipped (oba → operator).

## Review fazy 2 (2026-07-14)

Multi-agent review + adversarial verify. Raport: `review-faza-2.md`. Gate: **⚠️ ZASTRZEŻENIA** (0× P1, 1× P2, 14× P3, 1× OPERATOR). Kluczowe wnioski:

- **P2 #1**: wyciek slotu tła — `settle()` zwalnia slot tylko na `close`, a `killProcessTree` na Unix zabija tylko bezpośrednie dziecko; wnuk CLI trzymający pipe stdout/stderr blokuje `close` na zawsze → 3 zdarzenia = permanentny „⏳ Mam pełne ręce" (DoS `/ask` do restartu). Fix: dodatkowy `proc.on('exit', ...)` → `settle` (guard `settled` już chroni przed podwójnym zwolnieniem).
- P3 klastrują się wokół: rozmiaru/SRP pliku (335 linii, naturalny split ask-gates.js + ask.js najtańszy przed Unit 5), duplikacji z executorem (`truncateTail`, kill drzewa — wersje już się rozjeżdżają), nieudokumentowanych trade-offów bezpieczeństwa (403 poza rate limitem, leak długości sekretu timingiem) i luk pokrycia (sync-fail exit≠0, ✅ na obu kanałach naraz, gałąź obcinania >50KB).
- Zgodność ze spec: jedno odchylenie literalne — treść `TEXT_DETACHED` inna niż cytat R5/konspektu (sens zachowany, P3).
- Gałąź Windows (`taskkill`, skip testów spawnu na win32) niewykonalna headless na Macu → Operator checklist faza 2.
- Bookkeeping `Weryfikacja:`: 2/2 CLI PASS (`npm test` 318/318, `lib/ask.test.js` 26/26). Zero E2E (faza bez UI — endpoint HTTP dopiero w U5).

## Review fazy 1 (2026-07-14)

Multi-agent review + adversarial verify. Raport: `review-faza-1.md`. Gate: **⚠️ ZASTRZEŻENIA** (0× P1, 2× P2, 9× P3, 1× OPERATOR). Kluczowe wnioski:

- **P2 #1**: fallback `shell:true` w `resolveClaudeBin` (Windows) — Node nie escapuje args przy `shell:true`, a args niosą treść z publicznych endpointów (`webhook_payload`, w U4 tekst z `/ask`). Fix: fail z czytelnym błędem zamiast fallbacku.
- **P2 #2**: `ASK_TIMEOUT_MS`/`ASK_MAX_MS` hardcodowane bez override z env — plan zakładał mitygację limitu Shortcuts przez env bez zmiany kodu. Fix: `Number(process.env.ASK_TIMEOUT_MS) || 55_000`.
- P3 klastrują się wokół: testów config zależnych od ambient env runnera (VPS z `ASK_*` w env = fałszywy FAIL `npm test`), luk pokrycia przeniesionych 1:1 z executora (nie-ENOENT w `readOauthToken`, memoizacja `where claude`) i kolokacji (testy config w webhook.test.js).
- Ścieżka Windows `resolveClaudeBin` niewykonalna headless na Macu → Operator checklist faza 1.
- Bookkeeping `Weryfikacja:`: 4/4 CLI PASS (284/284 testów, defaulty config exit 0). Zero E2E (faza bez UI).

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
