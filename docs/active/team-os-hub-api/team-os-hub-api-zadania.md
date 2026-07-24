# Team OS Hub-API — zadania

Branch: `feature/team-os-hub-api`
Ostatnia aktualizacja: 2026-07-24

## Faza 0 — przygotowanie

- [ ] Commit zastanych zmian z 24.07 (self-heal Skrzynki, testy inbox-push, eksporty archiwum, CLAUDE.md) — osobny commit PRZED startem F1

## Faza 1 — Hub: dane + API + server.js (XL)

### IU-1.1 `lib/inbox-db.js` (M)
- [ ] `lib/inbox-db.js`: otwarcie `data/inbox.db` (ścieżka z configu, `setInboxDbPath` dla testów), idempotentne migracje, smoke-test typów agregatów
- [ ] Tabele: `inbox` (id TEXT uuid, thread_id, from_user, to_user, type, title, content, payload TEXT-JSON, status, created_at/updated_at ISO w kodzie), `members` (name UNIQUE, token, created_at)
- [ ] Operacje: `pullForUser` (+ pending→delivered), `markDone` (idempotentny; task+Zrobione = transakcja reply+done), `claimQuery` (atomowy UPDATE...RETURNING), `sendMessage`, CRUD członków
- [ ] Granica JSON: `payload` obiektem powyżej tej warstwy (parse/stringify TYLKO tu)
- [ ] Test: roundtrip `payload {auto_reply:true}` — zapis i odczyt zwraca obiekt, nie string (wymaganie twarde #1)
- [ ] Test: `markDone` powtórzony na rekordzie `done` → `already_done`, zero nowych wierszy reply (wymaganie twarde #2)
- [ ] Test: `claimQuery` dwa wywołania → drugi dostaje null (atomowość)
- [ ] Test: happy + error case dla każdej operacji publicznej

### IU-1.2 `lib/inbox-api.js` (L)
- [ ] `matchInboxToken` (`/inbox/v1/:token/<akcja>`) — bliźniak webhook.js, testy happy+error
- [ ] Autoryzacja: `timingSafeEqual` po wszystkich tokenach członków; kody dla intruzów bez szczegółów (403/404/405/413)
- [ ] Rate limit 60 req/min per token — stała nazwana z komentarzem wyliczenia (rytm: sync 2–4 + auto-reply 2 req/min + retry, ×10); NIE 10/min z /ask (wymaganie twarde #3)
- [ ] Cap body 64 KB przed autoryzacją (wzorzec readTextBody z /ask), walidacja inputów na granicy (enum type/action, długości)
- [ ] Endpointy: `ping`, `pull` (payload jako obiekt w JSON odpowiedzi), `done` (zwraca pełną nitkę do archiwum), `send`, `claim-query`
- [ ] Pole `v:1` w każdej odpowiedzi; nieznana wersja ścieżki → 404 (wymaganie twarde #4)
- [ ] Test: autoryzacja (zły token 403, dobry przechodzi), rate limit (61. request w minucie odcięty), walidacja (nieznany type odrzucony)

### IU-1.3 `server.js` + testy HTTP (M)
- [ ] Matcher inbox w kolejności: webhook → ask → **inbox** → guard XFF → api/static + aktualizacja komentarza-kontraktu
- [ ] Prywatne `/api/inbox/members` (ZA guardem XFF): GET lista (tokeny maskowane), POST dodanie (pełny token + kod zaproszenia jednorazowo w odpowiedzi), DELETE odwołanie
- [ ] Test HTTP (żywy proces, wzorzec ask.http.test.js): inbox działa z nagłówkiem XFF; `/api/inbox/members` z XFF → 403
- [ ] Test HTTP: powtórzony `done` → `already_done`, bez duplikatu reply
- [ ] Test HTTP: `pull` zwraca `payload.auto_reply === true` jako boolean w obiekcie
- [ ] Weryfikacja: pełna suita `npm test` zielona

## Faza 2 — Klienci (M)

### IU-2.1 `scripts/inbox/inbox-client.mjs` (S)
- [ ] Wrapper fetch: `INBOX_HUB_URL`+`INBOX_TOKEN`, timeout (AbortController), 1 retry na timeout/5xx, czytelne błędy konfiguracji
- [ ] Weryfikacja `v:1` w odpowiedzi — mismatch = czytelny błąd „zaktualizuj Pulsa"
- [ ] Test: happy + error (timeout, zła wersja, brak konfiguracji)

### IU-2.2 Przepięcie skryptów (M)
- [ ] `inbox-pull.mjs`: pg → client.pull; `me` z odpowiedzi huba (pole `user`)
- [ ] `inbox-push.mjs`: pg → client.done; OUT transakcje i sprawdzanie done (robi hub); archiwum z nitki zwróconej przez `done`
- [ ] `auto-reply.mjs`: pg → client.claimQuery + client.send; OUT własny claim przez UPDATE
- [ ] Weryfikacja: parsery, renderery, self-heal i ich testy BEZ zmian — `git diff` czysty na testach warstwy plików (wymaganie twarde #6)

### IU-2.3 Konfiguracja (S)
- [ ] `env-loader.mjs`: `INBOX_HUB_URL`+`INBOX_TOKEN`; OUT `INBOX_DB_URL`/`INBOX_USER`; OUT hardcoded fallback `Documents/kacper_trzepiecinski_workspace`
- [ ] `inbox-seed.js`: warunek konfiguracji = HUB_URL && TOKEN
- [ ] Test: env-loader happy + error po zmianach; inbox-seed `not_configured` bez nowych zmiennych
- [ ] Weryfikacja: pełna suita zielona

## Faza 3 — Onboarding (L)

### IU-3.1 `install-vps.sh` — komponent „Team OS hub" (M)
- [ ] Pytanie w pełnym trybie (przez `ask_tty`, domyślnie **n**)
- [ ] Dodanie członka-admina przez API lokalnego serwera (curl 127.0.0.1:7777); idempotentny re-run
- [ ] Guard: brak skonfigurowanego Funnela = fail z instrukcją (nie cichy sukces); kod zaproszenia w podsumowaniu instalacji
- [ ] Test: `install-vps.test.sh` — pytanie, guard Funnela, idempotencja

### IU-3.2 `setup.mjs` — blok kodu zaproszenia (M)
- [ ] Pytanie „Masz kod zaproszenia do skrzynki zespołowej? (puste = pomiń)" po pytaniu o VPS
- [ ] `parseInviteCode` (`puls-inbox:<url>#<token>`) — czysta funkcja
- [ ] Probe `GET /ping` przed zapisem; pad → warn i pominięcie, nigdy fail setupu
- [ ] Zapis `INBOX_HUB_URL`/`INBOX_TOKEN` do `.env` workspace'u + hint o restarcie daemona (stale env)
- [ ] Test: `setup.test.mjs` — parseInviteCode happy+error, probe-fail nie wywala setupu
- [ ] Weryfikacja: pełna suita + testy instalatorów zielone

## Faza 4 — Migracja + decommission + docs (M)

### IU-4.1 Migracja danych (S)
- [ ] `scripts/inbox/migrate-pg-to-hub.mjs`: otwarte wątki (`status != 'done'`) ze starego Postgresa → hub (z zachowaniem thread_id/created_at)
- [ ] Wykonanie migracji + ręczne przepięcie `.env` operatora i Kamila
- [ ] Weryfikacja: skrzynka end-to-end po hubie (wysłanie, odpowiedź, odhaczenie, archiwum, auto-reply)

### IU-4.2 Decommission (S) — wymaganie twarde #5
- [ ] Kontener Postgresa na 62.72.33.171 zgaszony
- [ ] Hasło z `INBOX_DB_URL` zrewokowane (spalone — jeździło plaintextem po publicznym internecie)
- [ ] Weryfikacja: skan z zewnątrz — port 5433 nie odpowiada (`nc -zv` z innej sieci)
- [ ] Wpis hasła do listy rewokacji w notatce NOW operatora

### IU-4.3 Sprzątanie + docs (S)
- [ ] OUT: `pg` z `package.json`+lock, `schema.sql`, `migrate-pg-to-hub.mjs`
- [ ] CLAUDE.md: sekcja Team OS (hub, kontrakt matcherów z inbox, odrzucona opcja minimalna jako decyzja)
- [ ] Weryfikacja: `npm install --omit=dev` na czysto + pełna suita zielona
