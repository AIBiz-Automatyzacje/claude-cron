# Team OS Hub-API — podsumowanie

**Data ukończenia:** 2026-07-24
**Branch:** `feature/team-os-hub-api`
**Status:** ukończone headless (4 fazy). Pozostałe otwarte pozycje to wyłącznie kroki OPERATORA (migracja danych, decommission Postgresa) i opcjonalne nity P3 — niewykonalne w trybie headless.

## Co zostało dostarczone

Przepięcie Team OS — Skrzynki z architektury współdzielonego Postgresa na model **hub-and-spoke po HTTPS** (Funnel-URL + token per członek):

- **Faza 1 — Hub (dane + API + server.js):** `lib/inbox-db.js` (warstwa SQLite `data/inbox.db`, granica JSON, idempotentny `markDone`, atomowy `claimQuery` przez `UPDATE...RETURNING`), `lib/inbox-api.js` (handler `/inbox/v1/:token/*`, rate limit 60/min per token, `timingSafeEqual`, cap body 64 KB, pole `v:1`), wpięcie w `server.js` (matcher w kontrakcie webhook→ask→**inbox**→guard XFF→api/static, prywatne `/api/inbox/members` za guardem XFF + guard cross-origin CSRF).
- **Faza 2 — Klienci:** `scripts/inbox/inbox-client.mjs` (wrapper fetch, timeout 15 s, 1 retry na timeout/5xx z wyjątkiem nieidempotentnego `send`, weryfikacja `v:1`); przepięcie `inbox-pull.mjs`/`inbox-push.mjs`/`auto-reply.mjs` z `pg` na klienta; `env-loader.mjs` na `INBOX_HUB_URL`+`INBOX_TOKEN`. Parsery/renderery/self-heal i ich testy nietknięte (wymaganie twarde #6).
- **Faza 3 — Onboarding:** komponent `setup_team_os_hub` w `install-vps.sh` (guard Funnela, idempotencja, kod zaproszenia w podsumowaniu), blok kodu zaproszenia w `setup.mjs` (`parseInviteCode` + probe `/ping`, snapshot+restore env), widok „Zespół" w dashboardzie (`public/` — lista członków, dodanie z jednorazowym kodem, unieważnienie).
- **Faza 4 — Migracja + docs:** `scripts/inbox/migrate-pg-to-hub.mjs` (jednorazowy skrypt migracji otwartych wątków pg→hub, surowy `INSERT OR IGNORE`, DI, idempotencja po PK); sekcja Team OS w CLAUDE.md przepisana na hub-and-spoke.

Pełna suita `npm test`: **503/503 zielone**; `install-vps.test.sh`: **110/110**. Zero nowych zależności npm.

## Kluczowe decyzje

1. **Hub-and-spoke po HTTPS zamiast wspólnej bazy** — każdy członek ma własny tailnet; bezpośredni dostęp do bazy wymagałby wspólnego tailnetu (RCE) albo ręcznych ACL. Funnel-URL + token działa z dowolnej sieci. Opcja minimalna (Postgres + TLS + role) odrzucona świadomie.
2. **SQLite `data/inbox.db`** (osobny plik obok `claude-cron.db`) — do bazy sięga tylko proces serwera; `node:sqlite` już jest fundamentem.
3. **Granica JSON w `inbox-db.js`** — `payload` jako obiekt wszędzie powyżej tej warstwy (parse/stringify tylko tu).
4. **Idempotencja + atomowość na hubie, nie w klientach** — retry po timeoutach Funnela nie może zdublować „Zrobione ✅"; claim auto-reply jednym `UPDATE...RETURNING`.
5. **Rate limit 60/min per token** — wyliczony z rytmu systemu (sync 2–4 + auto-reply 2 req/min + retry, ×10), NIE skopiowany z `/ask` (10/min utnie normalną pracę).
6. **Wersjonowanie od startu** — ścieżka `/inbox/v1/` + pole `v:1` w każdej odpowiedzi; klient weryfikuje, hub i lokalne Pulsy aktualizują się niezależnie.
7. **`user` z tokenu, nie z env** — hub jest źródłem tożsamości; `INBOX_USER` znika.
8. **Zarządzanie członkami przez UI dashboardu, nie skill** — admin sięga do huba z lokalnego dashboardu przez istniejące proxy `/api/vps/*`.
9. **`send` bez retry** (regresja P2 fazy 2) — `sendMessage` generuje świeży `randomUUID()` bez klucza dedup, więc retry na timeout/5xx po commicie INSERTa dublowałby wiadomość.

## Główne pliki

Utworzone: `lib/inbox-db.js`, `lib/inbox-api.js`, `scripts/inbox/inbox-client.mjs`, `scripts/inbox/migrate-pg-to-hub.mjs` (+ testy).
Zmodyfikowane: `server.js`, `scripts/inbox/inbox-pull.mjs`, `inbox-push.mjs`, `auto-reply.mjs`, `env-loader.mjs`, `lib/inbox-seed.js`, `lib/config.js`, `scripts/install-vps.sh`, `setup.mjs`, `public/app.js`, `public/render-helpers.js`, `public/index.html`, `CLAUDE.md`.

## Wnioski warte zachowania

- **Retry stosuj tylko do idempotentnych operacji** — wrapper klienta ponawia timeout/5xx, ale `send` przekazuje `retry:false`, bo hub nie ma klucza dedup. Idempotency należy do warstwy huba (`markDone`/`claimQuery`), nie klienta.
- **Migracja z zachowaniem tożsamości omija warstwę API** — `handleSend` wymusza `from_user` z tokenu i generuje świeże `created_at`/`id`, więc skrypt migracji wstawia surowym `INSERT OR IGNORE` wprost do bazy (świadomy udokumentowany wyjątek od reguły „granica JSON tylko w inbox-db", bo skrypt jest throwaway).
- **Attribute-context XSS** — `esc()` nie escapuje cudzysłowów; nazwa członka wstawiana do `aria-label="..."` wymaga dedykowanego `escAttr` (naprawione w fazie 3).
- **Whitelist nazw z Unicode** — walidacja imion (`is_valid_member_name` w install-vps.sh) musi dopuszczać polskie diakrytyki; ASCII-only przerywało instalację i gubiło jednorazowy kod zaproszenia.
- **Regresja auto-close** — dawny „Auto-close 1" (moje wysłane `query` → `done` gdy ktoś odpisał) zniknął, bo hub `pullForUser` go nie realizuje; kandydat do dodania po stronie huba jako świadoma decyzja (dotyka kontraktu warstwy F1).
- **GATED cleanup** — usunięcie `pg`/`schema.sql`/`migrate-pg-to-hub.mjs` (IU-4.3) ma sens dopiero PO zweryfikowanej migracji i decommissionie; skrypt migracji wciąż importuje `pg`.

## Otwarte pozycje (OPERATOR — poza headless)

- Wykonanie migracji danych pg→hub na VPS-ie huba (`migrate-pg-to-hub.mjs`).
- Decommission Postgresa 62.72.33.171: kontener OFF + rewokacja hasła (spalone, plaintext po publicznym necie) + skan portu 5433 z zewnątrz + wpis do listy rewokacji.
- IU-4.3 cleanup (`pg`/`schema.sql`/skrypt migracji) + `npm install --omit=dev` na czysto — gated na powyższe.
- Opcjonalne nity P3 (głównie na throwaway skrypcie migracji) — udokumentowane w `team-os-hub-api-zadania.md`.
