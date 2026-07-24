# Team OS Hub-API — migracja skrzynki z publicznego Postgresa na hub przez Tailscale Funnel

Branch: `feature/team-os-hub-api`
Ostatnia aktualizacja: 2026-07-24 (Faza 3 zrealizowana — implementacja)

## Podsumowanie wykonawcze

Skrzynka Team OS jeździ dziś po **publicznym Postgresie** (`62.72.33.171:5433`): wszyscy członkowie łączą się jako superuser `postgres`, jednym wspólnym hasłem, bez TLS (node-postgres domyślnie plaintext). Działało na MVP we dwóch, nie skaluje się na zespół ani o osobę i nie da się nikomu odebrać dostępu bez rotacji hasła u wszystkich.

Docelowo: **hub-and-spoke po HTTPS**. VPS admina zostaje hubem — tabela `inbox` przenosi się do SQLite obok `claude-cron.db`, a serwer Pulsa wystawia tokenowe endpointy `/inbox/v1/:token/*` przez **Tailscale Funnel** (infrastruktura już istnieje: `setup_funnel` w instalatorze VPS, wzorce publicznych endpointów w `/webhook/*` i `/ask/*`). Klienci (`scripts/inbox/`) zamieniają `pg.Client` na `fetch` do huba. Członek zespołu NIE potrzebuje Tailscale ani własnego VPS-a — dostaje **kod zaproszenia** (Funnel-URL + token) i wkleja go w setupie.

Efekt uboczny na plus: z projektu znika zależność `pg`, `schema.sql` i cały nigdy-niezbudowany plan „instalator stawia Postgresa".

## Analiza obecnego stanu

- **Transport**: 3 skrypty ESM (`inbox-push.mjs`, `inbox-pull.mjs`, `auto-reply.mjs`) łączą się bezpośrednio z Postgresem (~19 wywołań `pg`), konfiguracja przez `INBOX_DB_URL` + `INBOX_USER` z `.env` workspace'u (`env-loader.mjs`).
- **Idempotencja i transakcje siedzą w klientach**: push sprawdza `status='done'` przed akcją, transakcja `reply+done` (`BEGIN/COMMIT/ROLLBACK`) w kliencie; atomowy claim auto-reply przez `payload.auto_reply_attempted` w kliencie. Przy wielu klientach + retry to prosi się o wyścigi.
- **Warstwa plików (vault)**: parsery (`extractInboxSection`, `parseCheckedCallouts`), renderery (`renderThreadCallout`, `renderDelegatedCallout`, `renderArchiveThread`), self-heal Skrzynki (`SKRZYNKA_TEMPLATE`, `ensureSkrzynkaFile`) — **transport ich nie dotyka**; pełne pokrycie testami zostaje nietknięte.
- **`payload` jest `jsonb`** — pg zwraca go jako obiekt JS; renderer rozpoznaje wiadomość agenta po `m.payload?.auto_reply === true`.
- **Wzorce do skopiowania w repo**: `webhook.js` (matcher tokenu z URL, 23 linie), `ask.js` (bramki auth → rate limit, `timingSafeEqual`, kody błędów bez szczegółów dla intruzów, cap na body), `ask.http.test.js` (testy HTTP na żywym procesie z `CLAUDE_CRON_DB_PATH`/`CLAUDE_CRON_CLAUDE_BIN`), `db.js` (leniwe otwarcie, idempotentne migracje, `setDbPath(':memory:')`, smoke-test BigInt).
- **Instalator VPS ma już Funnel** (`setup_funnel`, `parse_funnel_url`, idempotentny re-run) i strukturę komponentową z guardami `has_*`.

## Proponowany stan docelowy

### Architektura

```
Członek A (lokalny Puls)──┐
Członek B (lokalny Puls)──┼── HTTPS (Funnel) ──> VPS admina: server.js ──> data/inbox.db (SQLite)
Admin     (lokalny Puls)──┘        /inbox/v1/:token/*
```

- **Hub** = Puls na VPS-ie admina. Jedyny proces piszący do `data/inbox.db` (osobny plik — dane zespołowe nie mieszają się z jobami; kasowanie/backup niezależny od `claude-cron.db`).
- **Tożsamość**: token per członek (długi hex z `crypto.randomBytes`), tabela `members` na hubie. Hub wyprowadza `user` z tokenu — klient NIE deklaruje, kim jest (koniec z `INBOX_USER` w env). Odwołanie dostępu = skasowanie jednego tokenu.
- **Idempotencja i atomowość przechodzą na hub**: transakcja `reply+done`, sprawdzenie `status='done'`, claim auto-reply — wszystko po stronie serwera. Klienci robią głupie `fetch` i mogą bezpiecznie retryować.

### Kontrakt API `/inbox/v1/` (wersjonowany od startu — wymaganie twarde #4)

Wszystkie odpowiedzi JSON zawierają pole `v: 1`. Nieznana ścieżka wersji → 404 bez szczegółów. Autoryzacja: token w URL, porównanie `timingSafeEqual` przeciwko wszystkim tokenom członków (mała kardynalność), kody błędów dla intruzów bez szczegółów (403/404/405/413), cap na body 64 KB (wzorzec `/ask`).

| Metoda i ścieżka | Rola | Semantyka |
|---|---|---|
| `GET /inbox/v1/:token/ping` | probe setupu | `{v:1, user, hub:'puls'}` — walidacja kodu zaproszenia |
| `POST /inbox/v1/:token/pull` | inbox-pull | Zwraca wątki dla członka (otrzymane pending/delivered + delegowane otwarte), oznacza `pending→delivered`. `payload` w odpowiedzi to **obiekt** (hub robi `JSON.parse` — wymaganie twarde #1) |
| `POST /inbox/v1/:token/done` | inbox-push | Body `{id, action:'Zrobione'\|'Zapoznane'}`. Hub: walidacja `to_user`==członek, **idempotentnie** (rekord już `done` → `{v:1, result:'already_done'}`, zero skutków — wymaganie twarde #2), dla task+Zrobione transakcja `INSERT reply + UPDATE done` w SQLite. Odpowiedź zawiera pełną nitkę wątku → klient renderuje archiwum lokalnie |
| `POST /inbox/v1/:token/send` | delegowanie + auto-reply | Body `{thread_id?, to_user, type, title, content, payload?}` — INSERT wiadomości; `from_user` z tokenu |
| `POST /inbox/v1/:token/claim-query` | auto-reply | **Atomowy** claim jednego niepodjętego query (`UPDATE ... SET payload.auto_reply_attempted` w jednej instrukcji z RETURNING) albo `{v:1, query:null}` — koniec wyścigu dwóch klientów o tę samą wiadomość |

**Rate limit per token** (wymaganie twarde #3, NIE kopiować 10/min z `/ask`): rytm systemu to sync co 1 min (pull+push = 2-4 req/min) + auto-reply (2 req/min) + retry po timeoutach Funnela. Limit **60 req/min per token** (stała nazwana, z komentarzem wyliczenia) — ~10× normalny rytm, nadal ciasno dla intruza.

### Kolejność matcherów w `server.js` (kontrakt bezpieczeństwa)

`webhook → ask → inbox → guard XFF → api/static`. Inbox MUSI stać przed guardem XFF (ruch z Funnela ma `X-Forwarded-For` — inaczej 403 i skrzynka martwa), a przed api/static jak reszta publicznych. Aktualizacja komentarza-kontraktu w `server.js` i CLAUDE.md.

### Kod zaproszenia

Format: `puls-inbox:<funnel-url>#<token>` (jeden string do wklejenia; parsowalny czystą funkcją z testami). Generowany na VPS-ie (instalator/API), wklejany w `setup.mjs` członka. Setup robi probe `/ping`, zapisuje `INBOX_HUB_URL` + `INBOX_TOKEN` do `.env` workspace'u.

## Świadomie odrzucona opcja minimalna (decyzja, nie wracamy)

**„Zostawiamy Postgres, dodajemy TLS + role per user"** — tańsza (bez zmian transportu w klientach), ale odrzucona, bo:
1. zostawia connection stringi Postgresa w onboardingu osób nietechnicznych (największy punkt tarcia),
2. nie daje odwoływalnych tokenów per osoba w modelu, którym umiemy zarządzać z Pulsa (role pg = administracja bazą poza naszym narzędziem),
3. utrzymuje publiczny port bazy (TLS szyfruje, ale powierzchnia ataku = pełny protokół Postgresa, nie 5 endpointów z rate limitem),
4. utrzymuje zależność `pg` i osobny silnik bazy do instalowania/backupowania na VPS-ie.

Odrzucono także: wspólny tailnet zespołu (dashboard Pulsa bez autoryzacji = RCE między członkami) i Tailscale node-sharing (wymaga ręcznych ACL-i w konsoli — poza zasięgiem nietechnicznych; domyślnie wystawia członkom port 7777 huba).

## Fazy wdrożenia

### Faza 1 — Hub: dane + API + wpięcie w server.js (XL) ✅ zrealizowana (npm test 433/433; mierniki 1–2 spełnione)

**IU-1.1 `lib/inbox-db.js` + testy (M)**
Warstwa SQLite dla `data/inbox.db` (ścieżka z configu, override `setInboxDbPath` dla testów — wzorzec `db.setDbPath`). Schemat: tabela `inbox` (odwzorowanie z `schema.sql`: `id` TEXT z `crypto.randomUUID()`, `payload` TEXT z JSON-em, `created_at/updated_at` ISO — `updated_at` ustawiane w kodzie, nie triggerem), tabela `members` (`name` UNIQUE, `token`, `created_at`). Idempotentne migracje przy otwarciu (wzorzec `db.migrate`), smoke-test typów agregatów (pułapka BigInt z learned-patterns). **Granica JSON: `payload` wchodzi/wychodzi z tej warstwy jako obiekt** — `JSON.parse/stringify` tylko tutaj, nigdzie wyżej. Operacje: CRUD wiadomości, `pullForUser` (z oznaczeniem delivered), `markDone` (idempotentny, transakcja reply+done dla task), `claimQuery` (atomowy UPDATE...RETURNING), CRUD członków.

**IU-1.2 `lib/inbox-api.js` + testy (L)**
Handler HTTP nad inbox-db: `matchInboxToken` (bliźniak `webhook.js`, parsuje `/inbox/v1/:token/<akcja>`), autoryzacja `timingSafeEqual` po wszystkich tokenach, rate limit 60/min per token (in-memory, wzorzec `/ask` — świadomie zero agregatów SQL), cap body 64 KB, walidacja inputów na granicy (typy, długości, enum `type`/`action`), format odpowiedzi z `v:1`. Endpointy: ping, pull, done, send, claim-query. Kody dla intruzów bez szczegółów.

**IU-1.3 Wpięcie w `server.js` + testy HTTP na żywym procesie (M)**
Matcher inbox w kontrakcie kolejności (webhook → ask → **inbox** → guard XFF → api/static) + aktualizacja komentarza-kontraktu. Endpoint administracyjny **prywatny** (za guardem XFF): `GET/POST/DELETE /api/inbox/members` — lista (tokeny maskowane: configured + ostatnie 4 znaki, wzorzec settings powiadomień), dodanie członka (zwraca pełny token + gotowy kod zaproszenia JEDNORAZOWO w odpowiedzi), odwołanie. Testy wzorcem `ask.http.test.js`: autoryzacja, kolejność matcherów (inbox działa z XFF, dashboard nie), idempotencja done przez HTTP, rate limit.

### Faza 2 — Klienci: przepięcie transportu (M) ✅ zrealizowana (npm test 465/465; miernik 1 spełniony — testy parserów/rendererów bez modyfikacji, `git diff` czysty na `*-pull/push/auto-reply.test.mjs`)

**IU-2.1 `scripts/inbox/inbox-client.mjs` + testy (S)**
Wrapper `fetch` do huba: baza z `INBOX_HUB_URL`, token z `INBOX_TOKEN`, timeout per request (AbortController), 1 retry na timeout/5xx (API jest idempotentne — bezpieczne), czytelne błędy konfiguracji. Weryfikacja `v:1` w odpowiedzi — mismatch = czytelny błąd „zaktualizuj Pulsa".

**IU-2.2 Przepięcie `inbox-pull` / `inbox-push` / `auto-reply` (M)**
Wymiana ~19 wywołań `pg` na `inbox-client`. Z klientów ZNIKA: `BEGIN/COMMIT/ROLLBACK`, sprawdzanie `status='done'`, claim przez własny UPDATE — hub to robi. `me` w renderze z odpowiedzi `pull` (pole `user`), nie z env. Archiwum: `done` zwraca nitkę → `appendToArchive` bez zmian. **Parsery, renderery, self-heal i ich testy — zero zmian** (wymaganie twarde #6).

**IU-2.3 `env-loader.mjs` + `inbox-seed.js` (S)**
Nowa konfiguracja: `INBOX_HUB_URL` + `INBOX_TOKEN` (stare `INBOX_DB_URL`/`INBOX_USER` przestają być czytane — czysta wymiana, bez okresu podwójnego wsparcia; migrujemy siebie i Kamila ręcznie w F4). **Usunięcie hardcoded fallbacku** `Documents/kacper_trzepiecinski_workspace` — workspace wyłącznie z `CLAUDE_CRON_WORKSPACE`/`INBOX_ENV_FILE`. `inbox-seed`: warunek konfiguracji = `INBOX_HUB_URL && INBOX_TOKEN`.

### Faza 3 — Onboarding w instalatorach (L) ✅ zrealizowana (npm test 492/492; install-vps.test.sh 110/110; miernik 3 spełniony — onboarding członka = jeden kod zaproszenia w setupie)

**IU-3.1 Komponent „Team OS hub" w `install-vps.sh` + testy (M)**
Pytanie w pełnym trybie (domyślnie **n** — hub stawia tylko admin zespołu): init `data/inbox.db` robi serwer przy pierwszym żądaniu (migracje leniwe — instalator NIE dłubie w SQLite), instalator dodaje członka-admina przez API lokalnego serwera (`curl` do `127.0.0.1:7777/api/inbox/members`), składa kod zaproszenia z Funnel-URL (guard: hub bez skonfigurowanego Funnela = fail z instrukcją, nie cichy sukces — learned pattern „potwierdzaj stan faktyczny") i drukuje go w podsumowaniu. Idempotentny re-run (członek istnieje → nie duplikuj). Testy w `install-vps.test.sh`.

**IU-3.2 Blok Team OS w `setup.mjs` + testy (M)**
Po pytaniu o VPS: „Masz kod zaproszenia do skrzynki zespołowej? (puste = pomiń)". Czysta funkcja `parseInviteCode` (format `puls-inbox:<url>#<token>`) + probe `GET /ping` (walidacja zanim cokolwiek zapiszemy; pad → czytelny komunikat i pominięcie, nigdy fail setupu — wzorzec notify-push). Zapis `INBOX_HUB_URL`/`INBOX_TOKEN` do `.env` workspace'u. Pliki vaulta: NIE tworzymy w setupie — self-heal `ensureSkrzynkaFile` w pull załatwia to przy pierwszym runie joba (dopisać do kontekstu, że to celowe). Testy w `setup.test.mjs` (parseInviteCode happy+error, probe-fail nie wywala setupu).

**IU-3.3 Dashboard: widok „Zespół" — zarządzanie członkami (M)**
Prosta sekcja w dashboardzie (vanilla JS, `public/app.js` + czyste helpery renderujące w `render-helpers.js` z testami): lista członków (imię, token zamaskowany, data dodania), formularz „dodaj członka" (imię → po utworzeniu kod zaproszenia pokazany **jednorazowo** z przyciskiem kopiuj + ostrzeżenie, że drugi raz się nie pojawi), przycisk „unieważnij" z potwierdzeniem. Widok operuje na `/api/inbox/members` huba — admin zarządza z lokalnego dashboardu przez **istniejące proxy `/api/vps/*`** (hub = VPS admina; przełącznik local/vps już jest w UI) albo bezpośrednio na dashboardzie VPS przez Tailscale; oba za guardem XFF. Zero pełnych tokenów w stanie frontendowym poza momentem utworzenia. Skill `puls` może dostać te same operacje później — UI jest kanałem pierwszorzędnym.

### Faza 4 — Migracja danych + decommission + docs (M)

**IU-4.1 Migracja danych (S)**
Jednorazowy skrypt `scripts/inbox/migrate-pg-to-hub.mjs` (poza seedowanymi jobami): czyta stary Postgres (`pg` jeszcze w dependencies na czas F4), przenosi **otwarte** wątki (`status != 'done'`) przez API huba (`send` z zachowaniem `thread_id`/`created_at` — endpoint send przyjmuje opcjonalne pola tylko z tokenem admina) albo bezpośrednio do SQLite na VPS-ie — decyzja w F4 wg prostoty. Zamknięte wątki żyją w archiwach vaultów — nie migrujemy.

**IU-4.2 Decommission z zębami (S) — wymaganie twarde #5**
Po zweryfikowanej migracji: (a) zgasić kontener Postgresa na `62.72.33.171`, (b) **zrewokować hasło** z obecnego connection stringa (jeździło plaintextem po publicznym internecie — traktowane jako spalone) — rotacja/usunięcie usera nawet jeśli kontener wraca do innych celów, (c) **zweryfikować skanem z zewnątrz**, że port 5433 nie odpowiada (`nc -zv`/nmap z innej sieci — learned pattern „test z zewnątrz po konfiguracji granicy bezpieczeństwa"), (d) dopisać hasło do listy rewokacji w notatce NOW w vaultcie operatora.

**IU-4.3 Sprzątanie + docs (S)**
Usunięcie `pg` z `package.json` (+ `package-lock.json`), usunięcie `schema.sql` i `migrate-pg-to-hub.mjs` (jednorazowy — po wykonaniu), aktualizacja CLAUDE.md (sekcja Team OS: architektura hub, kontrakt matcherów z inbox, decyzja o odrzuconej opcji minimalnej), README jeśli wspomina Team OS.

## Ocena ryzyka i mitygacje

| Ryzyko | Mitygacja |
|---|---|
| Funnel niedostępny / timeout → sync failuje | Klient: 1 retry (API idempotentne); job `routine=1` tłumi sukcesy, alarmuje po wyczerpaniu retry — istniejący mechanizm. Skrzynka jest offline-friendly (polling), zaległości nadrobi następny run |
| Wyciek tokenu członka | Odwołanie jednego tokenu przez `/api/inbox/members` (prywatne, Tailscale-only). Token nie daje nic poza skrzynką |
| Regresja `payload` (jsonb→TEXT) | Granica JSON wyłącznie w `inbox-db.js`; test twardy: roundtrip `{auto_reply:true}` przez API zwraca obiekt; istniejący test bąbla 🤖 w `inbox-pull.test.mjs` jako bezpiecznik końcowy |
| Duplikat „Zrobione ✅" przy retry | Idempotencja na hubie (rekord `done` → `already_done`, zero skutków) + test HTTP powtórzonego `done` |
| Drift wersji hub vs klienci | `/inbox/v1/` + pole `v:1` + klient weryfikuje i komunikuje mismatch czytelnie |
| SQLite przy współbieżnych żądaniach | Jeden proces serwera, `node:sqlite` synchroniczny — żądania naturalnie zserializowane; rytm 1-min per członek to znikome obciążenie |
| Hub = SPOF skrzynki | Zaakceptowane świadomie (jak LiveSync); joby członków failują miękko i alarmują |
| Przerwa w działaniu skrzynki podczas migracji | Okno migracji krótkie (F4 w jednej sesji); klienci przed przepięciem `.env` dalej działają na starym Postgresie — przełączenie per maszyna po migracji danych |

## Mierniki sukcesu

1. Pełna suita testów zielona; testy parserów/rendererów inbox **bez modyfikacji**.
2. Test HTTP: powtórzony `done` nie tworzy duplikatu reply; `payload.auto_reply` wraca jako obiekt; inbox działa z nagłówkiem XFF, dashboard z XFF dostaje 403.
3. Onboarding członka = wklejenie jednego kodu zaproszenia w setupie (zero connection stringów, zero Tailscale).
4. `pg` nieobecne w `package.json`; port 5433 nie odpowiada ze skanu z zewnątrz; stare hasło zrewokowane.
5. Skrzynka Ty↔Kamil działa end-to-end po hubie (wysłanie, odpowiedź, odhaczenie, archiwum, auto-reply).

## Zasoby i zależności

- Zero nowych zależności npm (fetch/crypto/node:sqlite wbudowane; `pg` znika w F4).
- Wymagany działający Funnel na VPS-ie huba (już skonfigurowany przez instalator; guard w IU-3.1).
- Dostęp do starego Postgresa na czas F4 (connection string w `.env` operatora).

## Szacunki

Jak zadanie `/ask` +30–40% (doszedł widok członków w dashboardzie): **4 fazy z review** (workflow `/dev-docs-execute` → `/dev-docs-review` per faza). F1 ≈ połowa całości (XL), F2 (M), F3 (L — w tym UI), F4 (M).

## Źródła

- Requirements doc: brak (wymagania zebrane w sesji planującej — 6 wymagań twardych operatora wpisanych do faz powyżej)
- Plan techniczny: brak (architektura zaprojektowana w tej sesji; format referencyjny: `docs/plans/2026-07-13-001-feat-ask-endpoint-asystent-glosowy-plan.md`)
