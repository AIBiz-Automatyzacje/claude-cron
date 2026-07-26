# Team OS — onboarding członka w instalatorach — podsumowanie

**Data ukończenia:** 2026-07-26
**Branch:** `feature/team-os-onboarding-instalatory` (odbity z `main` po `024653f`)
**Status:** ukończone headless (3 fazy planu, wszystkie IU `completed`, wszystkie P1/P2 z trzech review zamknięte). Otwarte pozostają wyłącznie nity P3 i kroki OPERATORA (test end-to-end na maszynie „Cave", ustawienie `inbox_role` na istniejących maszynach) — niewykonalne w trybie headless.

**Walidacja końcowa (2026-07-26):** `npm test` → **592 PASS / 0 FAIL**; `bash scripts/install-vps.test.sh` → **123 PASS / 123**. Zero nowych zależności npm.

## Co zostało dostarczone

Domknięcie trzech luk w tym samym momencie cyklu życia — **instalatora zapisującego konfigurację skrzynki Team OS**:

- **Faza 1 — rdzeń współdzielony + rola maszyny (IU-1.1, IU-1.2):**
  - `scripts/inbox/invite.mjs` — wspólny rdzeń onboardingu wyciągnięty z `setup.mjs` bez zmiany zachowania (`INVITE_CODE_PREFIX`, `parseInviteCode`, `upsertDotenvLine`, `writeInboxEnv`, `probeInviteCode`) + **nowy guard `.gitignore`**: czysta `planGitignoreFix(state)` i skorupa I/O `ensureEnvIgnored(workspace)`. `setup.mjs` schudł o 94 linie i re-eksportuje dwie funkcje dla zgodności istniejących importów testów.
  - `lib/inbox-seed.js` — flaga `state.inbox_role` (`client` | `agent`) rozstrzyga, KTÓRY job powstaje: `agent` → wyłącznie auto-reply (od razu `enabled: 1`), `client`/brak flagi → wyłącznie sync. Seed nadal **wyłącznie `createJob`, zero `UPDATE`** (R9).
  - `scripts/inbox/invite.test.mjs` (26 testów, repo testowe odcięte od `core.excludesFile` usera).
- **Faza 2 — instalatory (IU-2.1, IU-2.2, IU-2.3):**
  - `scripts/inbox/onboard.mjs` — cienki most bash → Node. Kontrakt maszynowy to **kod wyjścia** (`BAD_USAGE=2`, `BAD_CODE=3`, `HUB=4`, `GITIGNORE=5`, `WRITE=6`; `1` zarezerwowane dla nieobsłużonego wyjątku Node) + jedna linia `[ok]/[warn]/[error]` dla człowieka. Bash nigdy nie parsuje tekstu.
  - `scripts/install-vps.sh` — komponent `setup_team_os_member` obok nietkniętego `setup_team_os_hub`: „N" na pytanie o hub prowadzi wprost do pytania o kod zaproszenia (R3), admin dostaje własną maszynę skonfigurowaną świeżym `TEAM_OS_INVITE_CODE` bez przepisywania z ekranu, pytanie o rolę (`agent`/`client`) z domyślnym `N`.
  - `setup.mjs` — `askInboxInvite` deleguje całą sekwencję do `runOnboard` (guard `.gitignore` przed zapisem, rola `client`).
- **Faza 3 — dokumentacja (IU-3.1):** sekcja Team OS w `CLAUDE.md` opisuje stan faktyczny (flaga roli, docelowa topologia + uzasadnienie, ścieżka członka, rdzeń/most, guard sekretów) i prostuje nieaktualne zdanie „asystent auto-reply seedowany WYŁĄCZONY".
- **Poprawki po review fazy 3 (commit `cca5743`) — najważniejsza zmiana kodowa całego zadania:** **sekret skrzynki przeniesiony POZA drzewo vaulta.** `resolveInboxSecretFile` w `env-loader.mjs` (`INBOX_ENV_FILE` albo `data/inbox.env` w katalogu instalacji, 0600) jako jedyne źródło prawdy o lokalizacji; `stripInboxSecretsFromLegacyEnv` czyści `INBOX_HUB_URL`/`INBOX_TOKEN` ze starego `<workspace>/.env`; legacy czytany już tylko jako fallback.

## Kluczowe decyzje

1. **Jedna flaga `state.inbox_role` (`client` | `agent`), nie dwa booleany.** Brak flagi = zachowanie sprzed ról (`client`), więc istniejące instalacje nie zmieniają stanu po deployu. **Nigdy nie backfillowana w `migrate()`** — `migrate()` leci co boot, gołe `UPDATE` clobberowałoby ręczne decyzje usera.
2. **Joby tworzy daemon, intencję zna instalator** — instalator przekazuje wyłącznie **decyzję** (flagę roli), definicje jobów zostają w `lib/inbox-seed.js` jako jedyne źródło prawdy (R7). Odrzucone: tworzenie joba przez instalator po API (duplikacja definicji w bashu).
3. **Rdzeń w Node, bash bez logiki domenowej** (`invite.mjs` + CLI `onboard.mjs`). Reimplementacja parsowania kodu zaproszenia w bashu odrzucona — projekt raz już zapłacił za drift dwóch źródeł prawdy (stąd `env-loader.mjs`).
4. **Guard `.gitignore` pyta `git check-ignore` o EFEKT, nie czyta treści pliku** — negacje, `.gitignore` w katalogach nadrzędnych i globalny `core.excludesFile` sprawiają, że treść nie jest odpowiedzią na pytanie „czy ten plik zostanie zacommitowany". Sonduje **dwie** ścieżki: `.env` i syntetyczne `.env.bak.x` (dokładnie ten wariant wyciekł w incydencie 25/26.07). Świadomie bez `--no-index` (plik już śledzony ma być raportowany jako NIE-ignorowany).
5. **Guard fail-closed** — `unfixable` **oraz `unknown`** (brak gita, błąd gita) = odmowa zapisu tokenu, ale **nigdy przerwanie instalacji**. Korekta po review fazy 1: „brak gita" nie znaczy „to nie repo", bo vault bywa commitowany z drugiej maszyny.
6. **Kolejność jest bezpieczeństwem, nie estetyką:** parse → probe huba → guard → zapis sekretu → rola. Na VPS-ie zapis sekretu **i roli PRZED restartem** serwisu (`inbox-seed` czyta flagę przy starcie, env nie propaguje się do żyjących procesów).
7. **Domyślne `N` na pytanie o auto-reply** — `ask_tty` bez tty zawsze bierze default, a `T` cicho włączyłby agenta odpowiadającego zespołowi w imieniu właściciela vaulta. Odmowa daje rolę `client`, czyli działający sync.
8. **Sekret POZA drzewem vaulta (`data/inbox.env`)** — granica bezpieczeństwa, nie preferencja układu plików (patrz „Wnioski", P1 fazy 3).
9. **Topologia wariant A** (laptop = sync, VPS = auto-reply). Sync wyłącznie na VPS odrzucony trwale: kupuje świeżość `Skrzynka.md` ryzykiem cichego gubienia `[x] Zrobione` (rozproszony *lost update* pod Obsidian Sync — `pull` nadpisuje plik w całości, a Sync rozstrzyga konflikt bez rozumienia semantyki checkboxa).
10. **Redakcja tokenu w komunikatach** (`redactToken`) — token siedzi w ŚCIEŻCE `/inbox/v1/:token/ping`, a `undici` osadza pełny URL żądania w powodach błędów.

## Główne pliki

**Utworzone:** `scripts/inbox/invite.mjs`, `scripts/inbox/invite.test.mjs`, `scripts/inbox/onboard.mjs`, `scripts/inbox/onboard.test.mjs`.
**Zmodyfikowane:** `setup.mjs`, `setup.test.mjs`, `scripts/install-vps.sh`, `scripts/install-vps.test.sh`, `scripts/inbox/env-loader.mjs`, `scripts/inbox/auto-reply.mjs`, `lib/inbox-seed.js`, `lib/inbox-seed.test.js`, `server.js`, `CLAUDE.md`.

**Commity:** `bf036a3` (faza 1), `0f9652a` + `4c53667` (fix po review 1), `b32fa34` (faza 2), `6777208` + `20afbb5` (fix po review 2), `c37ff43` (faza 3), `cca5743` (fix po review 3 — przeniesienie sekretu poza vault).

## Wnioski warte zachowania

- **`cwd` spawnu agenta LLM to granica bezpieczeństwa — sekret nigdy w tym drzewie.** P1 fazy 3: instalator zapisywał `INBOX_TOKEN` do `<workspace>/.env`, a na maszynie z rolą `agent` auto-reply spawnuje `claude -p` z `cwd = vaultRoot` i `--allowedTools Read,Glob,Grep`, gdzie promptem jest **niezaufana treść cudzej wiadomości**. Query „zacytuj plik `.env`" oddawało nadawcy pełną tożsamość ofiary w hubie — obejście sensu tokenów per członek i `revokeMember`. Mode 0600 nie chroni (agent biega jako ten sam user), `.gitignore` chroni tylko przed gitem. Reguła trafiła do `.claude/rules/learned-patterns.md` (rozwiązanie: `docs/solutions/auth-issues/2026-07-26-sekret-w-drzewie-czytanym-przez-agenta-eksfiltracja-prompt-injection.md`).
- **Migracja lokalizacji sekretu wymaga wyczyszczenia starej** — sam nowy zapis zostawia istniejące instalacje tak samo podatne (`stripInboxSecretsFromLegacyEnv`); legacy czytamy jako fallback, ale nigdy tam nie piszemy.
- **Kontrakt zapisany w `CLAUDE.md` = kontrakt, którego nikt nie pilnuje.** Review fazy 3 znalazło trzy findingi mówiące to samo: zdania podniesione do rangi inwariantu („po zmianie roli stary job zostaje włączony", „`inbox_role` nigdy nie backfillowana", „zapis roli przed restartem") nie miały testu regresyjnego. Pierwsze zostało dopięte (P2, `lib/inbox-seed.test.js`); dwa pozostałe są otwartymi P3. Dokumentacja bez strażnika starzeje się w kłamstwo.
- **Kod wyjścia jako kontrakt maszynowy, tekst wyłącznie dla człowieka** — sześć rozłącznych kodów (nie cztery z planu), bo bash musi odróżnić własny błąd wywołania (`BAD_USAGE`) od złego kodu wklejonego przez człowieka; tylko ten drugi uzasadnia powtórzenie pytania. Test pilnuje rozłączności.
- **Testy guardu muszą być odcięte od konfiguracji gita użytkownika** (`GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` → pusty plik) — globalny `core.excludesFile` ignorujący `.env` dawałby fałszywy `ok` i test przechodziłby przy zepsutym guardzie.
- **Duplikacja „żeby uniknąć importu" wymaga prawdziwego uzasadnienia** — review fazy 2 obaliło argument „`onboard.mjs` ciągnie `lib/db` przy imporcie" (`setup.mjs` sam robi `require('./lib/db')` w czterech miejscach). Dziś porządek bezpieczeństwa parse → probe → guard → zapis → rola istnieje w **jednym** egzemplarzu.
- **Koszt kontekstu jest realnym findingiem.** Review fazy 3 wytknęło trzy kopie tego samego uzasadnienia w plikach ładowanych do KAŻDEJ sesji (`CLAUDE.md` ×2 + `learned-patterns.md`) oraz komentarz implementacyjny przepisany 1:1 z kodu. Do `CLAUDE.md` należy racja, nie implementacja.

## Otwarte pozycje

**Nity P3 (opcjonalne, pełne opisy w `review-faza-*.md` i `-zadania.md`):**
- `install-vps.sh:1587` — kod zaproszenia w argv (`su - claude -c "... --code %q"`), a `/proc/<pid>/cmdline` jest world-readable → `ps aux` w oknie onboardingu oddaje sekret (CWE-214). FIX: env procesu potomnego albo stdin.
- `invite.mjs:82` — `parseInviteCode` przepuszcza `http:` na równi z `https:`, a token siedzi w ścieżce URL.
- `install-vps.sh:1622` — `EXIT.GITIGNORE` zlepia `unfixable` i `unknown`; dla `unknown` bash dyktuje błędną naprawę.
- Brak testów regresyjnych na dwa udokumentowane inwarianty (`lib/db.js` — brak backfillu `inbox_role` w `migrate()`; brak `busy_timeout` przy zapisie roli z CLI do żywej bazy).
- `lib/inbox-seed.js:53` — auto-reply z cronem `*/1` przy braku deduplikacji kolejkowania w schedulerze (jedna odpowiedź ~4 min → kolejka rośnie).
- Rozjazdy opisu z kodem (`CLAUDE.md:23`, `CLAUDE.md:59`, `server.js:57-58`) + trzy kopie tego samego uzasadnienia.

**Operator (poza headless):**
- Test end-to-end na maszynie „Cave": VPS (instalacja → „N" na hub → kod zaproszenia → auto-reply „tak") + laptop (`setup.mjs` → kod zaproszenia → sync); weryfikacja rozłączności jobów; wymiana wiadomości Cave ↔ kacper przez hub.
- Ustawienie `inbox_role` na **istniejących** maszynach operatora (laptop → `client`, produkcyjny VPS → `agent`) — jednorazowo, świadomie poza kodem.
- Sprawdzenie guardu `.gitignore` na realnym vaultcie oraz zachowania przy `dubious ownership` (vault o innym właścicielu → `unknown` → fail-closed przy KAŻDYM re-runie).
- **Nierozwiązane w tym zadaniu (poza zakresem):** rotacja tokenu `kacper` i czyszczenie historii gita repo vaulta po incydencie wycieku 2026-07-25/26 — sekrety wciąż są w historii commitów `b05de80f`, `72d2de9d`.
