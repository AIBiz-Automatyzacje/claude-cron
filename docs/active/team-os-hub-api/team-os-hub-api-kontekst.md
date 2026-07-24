# Team OS Hub-API — kontekst

Branch: `feature/team-os-hub-api`
Ostatnia aktualizacja: 2026-07-24

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
