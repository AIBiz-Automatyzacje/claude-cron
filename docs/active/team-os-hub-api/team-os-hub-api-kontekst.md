# Team OS Hub-API — kontekst

Branch: `feature/team-os-hub-api`
Ostatnia aktualizacja: 2026-07-24 (Faza 4 ukończona headless — skrypt migracji pg→hub + docs; wykonanie migracji + decommission = OPERATOR)

## Postęp

- **Faza 0** — commit zastanych zmian z 24.07 (self-heal Skrzynki + testy inbox-push): `9830119`.
- **Faza 1 — Hub: dane + API + server.js** ✅ (IU-1.1/1.2/1.3): `lib/inbox-db.js` (warstwa SQLite `data/inbox.db`, granica JSON, idempotentny `markDone`, atomowy `claimQuery`), `lib/inbox-api.js` (czysty handler `/inbox/v1/:token/*`, rate limit 60/min per token, `timingSafeEqual`, cap 64 KB, pole `v:1`), `server.js` (matcher inbox w kontrakcie webhook→ask→inbox→guard XFF, prywatne `/api/inbox/members` za guardem, kod zaproszenia `puls-inbox:<url>#<token>`). Pełna suita `npm test`: **433/433 zielone**.
  - Odchylenia builderów utrwalone: `thread_id` = `id` dla roota (NOT NULL, brak COALESCE); `markDone`/`pullForUser`/`claimQuery` zwracają sygnały ustrukturyzowane (`not_found|skipped|already_done|replied|closed`) zamiast rzucać — idempotencja/autoryzacja to normalne stany; `InboxDbError` tylko przy naruszeniu kontraktu wejścia. `pullForUser` NIE zawiera auto-close (logika renderująco-biznesowa — ew. F2). Handler przyjmuje `method` (dla 405) i surowy `rawBody` string (parse JSON w czystej funkcji). Kod zaproszenia budowany w `server.js` (`INVITE_CODE_PREFIX='puls-inbox:'`, kontrakt z `parseInviteCode` z IU-3.2); źródło Funnel-URL = istniejący `WEBHOOK_BASE_URL` (brak dedykowanej zmiennej); POST członka robi fail-fast 503 gdy `WEBHOOK_BASE_URL` puste PRZED `addMember` (brak osieroconego wpisu). Zero nowych zależności npm.
- **Faza 2 — Klienci: przepięcie transportu** ✅ (IU-2.1/2.2/2.3): `scripts/inbox/inbox-client.mjs` (wrapper fetch `/inbox/v1/:token/*`, timeout 15 s przez AbortController, 1 retry na timeout/5xx, weryfikacja `v:1` z czytelnym błędem driftu, `InboxClientError`, konfiguracja czytana per-żądanie — stale-env-safe); `inbox-pull.mjs`/`inbox-push.mjs`/`auto-reply.mjs` przepięte z `pg` na `client.pull|done|claimQuery|send`; `env-loader.mjs` na `INBOX_HUB_URL`+`INBOX_TOKEN` (OUT `INBOX_DB_URL`/`INBOX_USER`/hardcoded fallback usera); `inbox-seed.js` warunek konfiguracji na nowe zmienne. Pełna suita `npm test`: **465/465 zielone** (+32 vs F1). Parsery/renderery/self-heal i ich testy (`*-pull/push/auto-reply.test.mjs`) — `git diff` czysty (wymaganie twarde #6 zweryfikowane).
  - Odchylenia builderów utrwalone: (a) `done()`/`send()` uczynione `async` — walidacja wejścia zwraca odrzucony promise zamiast rzucać synchronicznie (spójny kontrakt promise'owy wszystkich 5 metod klienta). (b) DI klienta do `main({ client = inboxClient } = {})` w trzech skryptach dla testowalności szwu klient↔renderer (I/O cienka skorupa w `main()`); `inbox-sync.mjs`/entry-point wołają `main()` bez argów → default = realny klient. (c) `closedBy` w stopce archiwum wyprowadzone z nitki huba (kotwica `m.id===item.id` ma `to_user===me`) zamiast z `INBOX_USER` — zero dodatkowego żądania o tożsamość. (d) Testy transportu w NOWYCH plikach `*.main.test.mjs` (nie dopisane do `*-pull/push/auto-reply.test.mjs`, żeby te miały czysty git diff — #6). (e) auto-reply: usunięty osobny log „claimed by another run" — atomowy claim po stronie huba sprowadza brak kandydata i przegraną rywalizację do jednego przypadku `query:null`.
  - ⚠️ **REGRESJA do decyzji właściciela huba** (poza kontrolą F2): dawny **Auto-close 1** w `inbox-pull` (moje wysłane `query` → `status=done` gdy ktoś inny odpisał `reply`) ZNIKA — hub `pullForUser` go nie realizuje, a F1 jest zamrożona (465 testów) i `pg` jest zakazane w kliencie. Skutek: moje odpowiedziane query zostają w sekcji Delegowane aż do ręcznego domknięcia. Kandydat do dodania po stronie huba (`lib/inbox-db.js` `pullForUser`) w F3/F4 — wymaga świadomej decyzji, bo dotyka kontraktu warstwy F1.
- **Faza 3 — Onboarding w instalatorach** ✅ (IU-3.1/3.2/3.3): `scripts/install-vps.sh` (komponent `setup_team_os_hub` — pytanie `ask_tty` domyślnie N w pełnym trybie, `team_os_wait_for_server` potwierdza żywy serwer PRZED POST-em, POST `/api/inbox/members` z rozstrzygnięciem na kodzie HTTP: 201=utworzony, **503=guard braku Funnela z instrukcją + resume one-liner**, idempotencja przez `team_os_member_exists` na GET-cie, kod zaproszenia w `print_summary` jednorazowo); `setup.mjs` (czysta `parseInviteCode` = odwrotnik `buildInviteCode` z huba, `INVITE_CODE_PREFIX='puls-inbox:'`; `upsertDotenvLine` = dedykowany helper formatu `.env` bez `export` — round-trip z `env-loader.mjs`; `askInboxInvite` = parse → probe `/ping` przez `inbox-client.ping()` → zapis `.env` → hint restartu daemona; probe NIE mutuje trwale `process.env` — snapshot+restore w finally); `public/` (widok „Zespół" — leniwe `loadMembers`, guard podpisu `membersSig`, modal dodania + modal kodu zaproszenia jednorazowy z czyszczeniem pola przy zamknięciu, `revokeMember` z natywnym `confirm`, czyste helpery `validateMemberName`/`memberRowData` w `render-helpers.js`). Widok operuje na `/api/inbox/members` przez `apiBase()` (respektuje przełącznik LOKALNY/VPS). Pełna suita `npm test`: **492/492 zielone** (+27 vs F2); `install-vps.test.sh`: **110/110** (nowe: `test_setup_team_os_hub`, `_sequence`, `test_print_summary_team_os`).
- **Faza 4 — Migracja + decommission + docs** ✅ headless (IU-4.1/4.3; IU-4.2 + wykonanie migracji = OPERATOR): `scripts/inbox/migrate-pg-to-hub.mjs` — jednorazowy skrypt migracyjny (odpalany ręcznie przez operatora na VPS-ie huba), czyta **otwarte** wątki (`status != 'done'`) ze starego Postgresa i wstawia je surowym `INSERT OR IGNORE` wprost do `data/inbox.db` przez `lib/inbox-db.js`. CLAUDE.md: sekcja Team OS przepisana na architekturę hub-and-spoke (hub `lib/inbox-*.js` + klienci `scripts/inbox/`), dopisany dedykowany opis prywatnego `/api/inbox/members` (guard XFF + guard cross-origin CSRF) i świadomie odrzucona opcja minimalna. Pełna suita `npm test`: **503/503 zielone** (+11 vs F3 — testy migracji).
  - Odchylenia builderów utrwalone: (a) **IU-4.1 transport migracji** — wybrano surowy `INSERT OR IGNORE` + lokalna serializacja payloadu w skrypcie zamiast trasy przez `send`: `handleSend` wymusza `from_user` z tokenu i generuje świeży `created_at`/`randomUUID()`, więc nie zachowałby oryginalnych id/thread_id/from_user/created_at/status. Świadomy udokumentowany wyjątek od reguły „granica JSON tylko w inbox-db" — throwaway-logika żyje lokalnie, bo skrypt jest usuwany w IU-4.3 (zero martwego kodu w produkcyjnym inbox-db). `thread_id` roota NULL → coalesce do `id` (spójnie z konwencją huba). Idempotencja przez PRIMARY KEY `id` (operator może odpalić 2×); porównanie `res.changes > 0` bez arytmetyki (pułapka BigInt). DI: `readRows`/`db` wstrzykiwane (test: fake source + `:memory:`). (b) **IU-4.3 GATED na operatora** — NIE usunięto `pg` z package.json+lock, `schema.sql` ani `migrate-pg-to-hub.mjs`: usunięcie ma sens dopiero PO zweryfikowanej migracji (IU-4.1 wykonanie) i decommissionie (IU-4.2), a skrypt migracji wciąż importuje `pg`. Docs opisują transport docelowy = hub z adnotacją, że `pg`/`schema.sql` są w trakcie wygaszania. (c) Nagłówek sekcji Team OS zmieniony na `## Team OS — Skrzynka (hub lib/inbox-*.js + klienci scripts/inbox/)` — logika przeniosła się do warstwy huba.
- **Faza 3 — Onboarding** — odchylenia builderów utrwalone: (a) **IU-3.1 bramka trybu** — hub pytany tylko w pełnym trybie (`FLAG_ONLY_PULS != 1`) zgodnie z zapisem „w pełnym trybie" i konwencją rejestratora wywołań; hub-serwer technicznie działa też przy `--only-puls` (do ew. decyzji orkiestratora). (b) 503/błędy = głośny `warn` z instrukcją + `return 0` (loud fail bez odwijania działającej instalacji — learned pattern „opcjonalne kroki finału = warn, nie trap ERR"). (c) Dodana lekka `is_valid_member_name` (imię idzie do ciała JSON i curl — walidacja na granicy). (d) **IU-3.2** brak istniejącego mechanizmu zapisu workspace `.env` (`persistEnvVar`/`upsertEnvLine` targetuje shell RC/rejestr w formacie `export VAR=...`, niekompatybilnym z czytnikiem `env-loader.mjs` `^KEY=value`) → dodano czysty `upsertDotenvLine`; `askInboxInvite` wyeksportowany do testu end-to-end probe-fail (env NIE zapisany) / probe-OK. (e) **IU-3.3** akcja Unieważnij używa natywnego `confirm()` zamiast dedykowanego modala Figma (spójne z `deleteJob`); dwa pozostałe modale (Zespół, Kod zaproszenia) odwzorowane jako pełne modale. Zero nowych zależności npm.

## Powiązane pliki

### Do utworzenia
- `lib/inbox-db.js` + `lib/inbox-db.test.js` — SQLite `data/inbox.db` (osobny plik obok `claude-cron.db`)
- `lib/inbox-api.js` + `lib/inbox-api.test.js` — handler `/inbox/v1/:token/*` + rate limit + tokeny członków
- `scripts/inbox/inbox-client.mjs` + `.test.mjs` — wrapper fetch do huba
- `scripts/inbox/migrate-pg-to-hub.mjs` — jednorazowy (usuwany w IU-4.3)

### Do modyfikacji
- `server.js` — matcher inbox w kontrakcie kolejności + prywatne `/api/inbox/members`; testy HTTP wzorcem `lib/ask.http.test.js`
- `scripts/inbox/inbox-pull.mjs`, `inbox-push.mjs`, `auto-reply.mjs` — wymiana ~19 wywołań `pg` na inbox-client; **parsery/renderery/self-heal nietknięte**
- `scripts/inbox/env-loader.mjs` — `INBOX_HUB_URL`+`INBOX_TOKEN`; OUT: `INBOX_DB_URL`, `INBOX_USER`, hardcoded fallback `Documents/kacper_trzepiecinski_workspace`
- `lib/inbox-seed.js` — warunek konfiguracji na nowe zmienne
- `lib/config.js` — ścieżka `data/inbox.db` (+ override dla testów HTTP na żywym procesie)
- `scripts/install-vps.sh` + `install-vps.test.sh` — komponent „Team OS hub"
- `setup.mjs` + `setup.test.mjs` — blok kodu zaproszenia
- `public/app.js` + `public/render-helpers.js` (+ testy helperów) + `public/index.html` — widok „Zespół" (IU-3.3)
- `package.json` — OUT `pg` (dopiero w F4!)
- `scripts/inbox/schema.sql` — OUT w F4
- `CLAUDE.md` — sekcja Team OS + kontrakt matcherów

### Wzorce do kopiowania (nie wymyślać od nowa)
- `lib/webhook.js` — matcher tokenu z URL (23 linie); `matchInboxToken` to jego bliźniak z segmentem wersji
- `lib/ask.js` — bramki wejścia, `timingSafeEqual` (oba porównania zawsze), kody błędów bez szczegółów, cap body 64 KB, in-memory stan współbieżności (świadomie zero agregatów SQL — pułapka BigInt)
- `lib/ask.http.test.js` — testy na żywym procesie serwera przez env-override (`CLAUDE_CRON_DB_PATH`, port)
- `lib/db.js` — leniwe otwarcie + `migrate()` idempotentny, `setDbPath(':memory:')`, `assertDbReturnsNumbers()`
- Maskowanie sekretów: wzorzec `GET /api/settings/notifications` (configured + ostatnie 4 znaki)
- `scripts/install-vps.sh` — `setup_funnel`/`parse_funnel_url` już istnieją; komponenty z guardami `has_*`

## Decyzje techniczne

1. **Hub-and-spoke po HTTPS zamiast współdzielonej bazy** — każdy członek ma własny tailnet (własny VPS), więc bezpośredni dostęp do bazy wymagałby wspólnego tailnetu (RCE między członkami przez dashboard bez auth) albo node-sharingu (ACL-e ręcznie w konsoli — poza zasięgiem nietechnicznych). Funnel-URL + token działa z dowolnej sieci.
2. **Odrzucona opcja minimalna** („Postgres zostaje, TLS + role per user") — tańsza, ale: connection stringi w onboardingu nietechnicznych, brak odwoływalnych tokenów zarządzanych z Pulsa, publiczny port z pełnym protokołem pg, utrzymana zależność `pg`. Decyzja zamknięta — nie wracamy.
3. **SQLite zamiast Postgresa na hubie** — do bazy sięga wyłącznie proces serwera Pulsa; `node:sqlite` już jest fundamentem projektu. Osobny plik `data/inbox.db`: dane zespołowe ≠ dane jobów.
4. **Granica JSON w `inbox-db.js`** — `payload` jako obiekt wszędzie powyżej tej warstwy (pg zwracał jsonb jako obiekt; renderer polega na `m.payload?.auto_reply === true`). Wymaganie twarde operatora #1.
5. **Idempotencja+atomowość na hubie, nie w klientach** — retry po timeoutach Funnela nie może wstawić duplikatu „Zrobione ✅" (wymaganie #2); claim auto-reply jednym `UPDATE...RETURNING` (koniec wyścigu).
6. **Rate limit 60 req/min per token** — wyliczony z rytmu systemu (sync 2–4 + auto-reply 2 req/min + retry, ×10 zapasu), NIE skopiowany z `/ask` (10/min utnie normalną pracę). Wymaganie #3.
7. **Wersjonowanie od startu**: ścieżka `/inbox/v1/` + pole `v:1` w każdej odpowiedzi; klient weryfikuje. Hub i lokalne Pulsy aktualizują się niezależnie. Wymaganie #4.
8. **Kolejność matcherów**: webhook → ask → **inbox** → guard XFF → api/static. Inbox przed guardem (Funnel daje XFF), admin-API członków ZA guardem (Tailscale-only).
9. **`user` z tokenu, nie z env** — hub jest źródłem tożsamości; `pull` zwraca `user`, render używa go jako `me`. `INBOX_USER` znika.
10. **Czysta wymiana env bez okresu podwójnego wsparcia** — użytkowników starego trybu jest dwóch (operator + Kamil), migrujemy ręcznie w F4; utrzymywanie dwóch transportów to zbędna złożoność.
11. **Pliki vaulta tworzy self-heal, nie setup** — `ensureSkrzynkaFile`/`SKRZYNKA_TEMPLATE` w `inbox-pull.mjs` (dodane 24.07) załatwia pierwszy run; setup tylko waliduje kod zaproszenia probe'em `/ping`.
12. **Kod zaproszenia**: `puls-inbox:<funnel-url>#<token>` — jeden string, czysta funkcja parsująca z testami. Pełny token widoczny JEDNORAZOWO przy tworzeniu członka (potem tylko maska).
12a. **Zarządzanie członkami przez UI dashboardu, nie skill** (decyzja operatora 24.07): widok „Zespół" — lista z maskami, dodanie z jednorazowym kodem (przycisk kopiuj), unieważnienie z potwierdzeniem. Admin sięga do huba z lokalnego dashboardu przez istniejące proxy `/api/vps/*` (przełącznik local/vps już jest). Skill `puls` może dostać te operacje później jako drugi kanał.
12b. **Mockupy Figma dla IU-3.3** (zbudowane 24.07, plik projektu dashboardu):
   - Ekran „Puls — Zespół": https://www.figma.com/file/LHNwwdO9B0o9Sn82nNrn3W?node-id=128-2
   - Modal „Kod zaproszenia" (stan po dodaniu członka): https://www.figma.com/file/LHNwwdO9B0o9Sn82nNrn3W?node-id=131-2
   - Modal „Unieważnij dostęp" (potwierdzenie): https://www.figma.com/file/LHNwwdO9B0o9Sn82nNrn3W?node-id=131-30
   Konwencje wyciągnięte z istniejących ekranów: bg #0a0a0a, header #121212, karta/tabela #161616 stroke #1d1d1d r14, modal #141414 stroke #2e2e2e r16, input #1c1c1c r9, akcent #fe6f00, danger #ff5c5c, pille h24 r20 fill kolor@13%, fonty Outfit Bold 16-18 (tytuły) / Inter Semi Bold 11.5-13.5 / JetBrains Mono (kody i maski).
13. **Token per członek plaintext w SQLite huba** — spójnie z modelem zaufania repo (sekrety w state plaintext, poziom jak shell RC); API listujące zwraca maski.

## Wymagania twarde operatora (checklist zgodności planu)

1. ✅ `payload` jsonb→TEXT z `JSON.parse` na granicy + test (IU-1.1, mierniki)
2. ✅ Idempotencja API od dnia 1 (IU-1.1/1.2 + test HTTP powtórzonego done)
3. ✅ Rate limit z rytmu systemu, nie z /ask (decyzja #6)
4. ✅ Wersja kontraktu od startu (decyzja #7)
5. ✅ F4 z zębami: kontener OFF + hasło zrewokowane (spalone — jeździło plaintextem) + skan portu 5433 z zewnątrz + wpis do listy rewokacji w NOW (IU-4.2)
6. ✅ Parsery/renderery/testy inbox nietknięte (IU-2.2, mierniki)

## Zależności i pułapki (learned-patterns)

- **BigInt z agregatów `node:sqlite`** — stan współbieżności/liczniki in-memory lub smoke-test typów w inbox-db.
- **Backfill w migrate = sentinel w state** — jeśli inbox-db będzie potrzebował backfillu danych, guard flagą (migrate leci co otwarcie).
- **Granica doby w localtime** — jeśli jakiekolwiek zapytanie „dziś" w inbox-db.
- **Potwierdzaj stan faktyczny CLI/granic bezpieczeństwa** — guard Funnela w IU-3.1 (brak Funnela = fail z instrukcją), skan portu z zewnątrz w IU-4.2.
- **`curl|bash` i tty** — pytanie o Team OS w instalatorze VPS przez istniejące `ask_tty`.
- **Stale env w żyjących procesach** — po zmianie `.env` członka daemon musi być zrestartowany, żeby script-joby dostały nowe `INBOX_*`; komunikat w setupie (wzorzec reloadHint).
- **Testy operatora bez side-effectów** — testy na maszynie operatora nie mogą dotknąć jego produkcyjnego `.env`/vaulta (snapshot przed statefulnymi testami).
- Stan wyjściowy: na branchu jadą też niezacommitowane zmiany z 24.07 (self-heal Skrzynki w `inbox-pull.mjs`, testy `inbox-push.test.mjs`, eksporty archiwum, CLAUDE.md) — scommitować przed startem F1.

## Źródła

- Requirements doc: brak (6 wymagań twardych operatora — sesja 2026-07-24, wpisane wyżej)
- Plan techniczny: brak (format referencyjny: `docs/plans/2026-07-13-001-feat-ask-endpoint-asystent-glosowy-plan.md`)
