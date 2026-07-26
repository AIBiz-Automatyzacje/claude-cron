# Team OS — onboarding członka w instalatorach — kontekst

Branch: `feature/team-os-onboarding-instalatory` (odbity z `main` po `024653f`)
Ostatnia aktualizacja: 2026-07-26 (faza 3 zaimplementowana — dokumentacja; wszystkie fazy planu zamknięte)

## Postęp implementacji

### Faza 1 — ✅ ukończona (IU-1.1, IU-1.2)

**Co powstało:**
- `scripts/inbox/invite.mjs` — wspólny rdzeń: `INVITE_CODE_PREFIX`, `parseInviteCode`, `upsertDotenvLine`, `writeInboxEnv`, `probeInviteCode` (przeniesione bez zmiany zachowania z `setup.mjs`) + nowy guard `.gitignore`: czysta `planGitignoreFix(state)` i skorupa I/O `ensureEnvIgnored(workspace)`.
- `scripts/inbox/invite.test.mjs` — 26 testów; `setup.mjs` schudł o 94 linie i re-eksportuje `parseInviteCode`/`upsertDotenvLine` (istniejące importy `setup.test.mjs` nietknięte, 71/71 zielone).
- `lib/inbox-seed.js` — flaga roli `state.inbox_role` steruje tym, KTÓRY job powstaje; auto-reply na roli `agent` seedowany **włączony**.

**Decyzje podjęte w trakcie implementacji (poza planem):**
- **Guard sonduje dwie ścieżki: `.env` i `.env.bak.x`.** Plan mówił „czy `.env` jest ignorowany" — to za mało, bo dokładnie wariant z sufiksem wyciekł w incydencie 25/26.07. Druga sonda to nazwa syntetyczna (`git check-ignore` nie wymaga istnienia pliku) — pytamy o EFEKT wzorca `.env*`, nie o konkretny plik.
- **Świadomie bez `--no-index`** w `git check-ignore`: plik już śledzony w indeksie ma być raportowany jako NIE-ignorowany, bo dopisanie wzorca go nie odśledzi. To fail-closed — lepiej pominąć zapis tokenu niż zapisać go do śledzonego pliku.
- **`unfixable` gdy wzorzec już jest w pliku, a git nadal nie ignoruje** — dopisanie drugiej kopii nic nie zmieni, a duplikowałoby linię przy każdym re-runie.
- **`INVITE_CODE_PREFIX` nie jest już eksportem `setup.mjs`** — właścicielem jest `invite.mjs`; `server.js` (hub) trzyma własną stałą CommonJS, bo jest po drugiej stronie granicy modułów. Dwie stałe w dwóch systemach modułów pozostają związane komentarzem, nie importem (świadomie — `server.js` nie może `import`ować ESM synchronicznie).
- **Status `seedInboxSyncJob` sufiksowany** (`seeded:sync` / `exists:auto-reply` / …) zamiast dwóch pól obiektu — jedyny konsument to log startowy `server.js`, więc obiekt byłby ceremonią. Wymusiło to 3-liniową zmianę w `server.js` (poza listą plików IU-1.2), bez której log startowy cicho by zniknął.
- **Testy guardu izolowane od konfiguracji gita użytkownika** (`GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` → pusty plik): globalny `core.excludesFile` ignorujący `.env` dawałby fałszywy `ok` i test przechodziłby przy zepsutym guardzie.

**Do świadomej weryfikacji w fazie 2:** `ensureEnvIgnored` istnieje, ale nie jest jeszcze przez nikogo wołany — wpięcie idzie w IU-2.1 (`onboard.mjs`) i IU-2.3 (`setup.mjs`). ✅ **Zamknięte w fazie 2**: guard wołany przez oba instalatory, w obu fail-closed dla `unfixable` i `unknown`.

### Faza 2 — ✅ ukończona (IU-2.1, IU-2.2, IU-2.3)

**Co powstało:**
- `scripts/inbox/onboard.mjs` (214 linii) + `scripts/inbox/onboard.test.mjs` (23 testy) — CLI-most bash → Node. Wejście: `--code`, `--role`, `--workspace`; wyjście: **kod wyjścia** jako kontrakt maszynowy + jedna linia dla człowieka.
- `scripts/install-vps.sh` (+142 linie) — komponent `setup_team_os_member` wołany z `main()` **po** hubie: admin dostaje swoją maszynę skonfigurowaną świeżym `TEAM_OS_INVITE_CODE` bez ponownego pytania, każdy inny wkleja kod zaproszenia (puste = pomiń). `scripts/install-vps.test.sh` 110 → **119 PASS / 0 FAIL**.
- `setup.mjs` — `askInboxInvite` z guardem `.gitignore` między probe a zapisem i zapisem `state.inbox_role = 'client'`.
- `lib/inbox-seed.js` — eksport słownika roli (`ROLE_AGENT`, `ROLE_CLIENT`, `isValidRole`); logika seedowania nietknięta.

**Decyzje podjęte w trakcie implementacji (poza planem):**
- **Sześć kodów wyjścia zamiast czterech.** Doszły `BAD_USAGE=2` (instalator zawołał CLI źle: brak argumentu, zła rola, brak workspace) i `WRITE=6` (pad zapisu `.env`/roli). Bez nich bash nie odróżnia własnego błędu wywołania od złego kodu wklejonego przez człowieka, a tylko ten drugi uzasadnia powtórzenie pytania. Kod `1` zarezerwowany dla nieobsłużonego wyjątku Node — test pilnuje rozłączności.
- **Pytanie o auto-reply z domyślnym `N`.** `ask_tty` bez tty bierze default, a `T` cicho włączyłby agenta odpowiadającego zespołowi w imieniu właściciela vaulta. Odmowa daje rolę `client`, czyli działający sync — R1 spełnione nawet przy samym Enterze.
- **Status guardu `unknown` = odmowa zapisu** w obu instalatorach (fail-closed). To konsekwencja naprawy P2 z fazy 1: „brak gita" nie znaczy „to nie repo", bo vault bywa commitowany z drugiej maszyny.
- **Redakcja tokenu w komunikatach** (`redactToken`): część trybów awarii `undici` osadza pełny URL żądania w `reason`, a token siedzi w ŚCIEŻCE `/inbox/v1/:token/ping` — surowy tekst oddałby sekret każdemu, kto zobaczy log instalacji.
- **Onboarding odpalany jako user `claude`, nie root** — `.env` ma należeć do właściciela vaulta, a `data/claude-cron.db` (tam ląduje rola) do usera daemona; plik przejęty przez roota wywróciłby zapisy schedulera przy najbliższym starcie.
- **`askInboxInvite` przyjmuje trzeci, opcjonalny argument `deps`** (`ensureIgnored`, `setRole`) — guard i DB sięgają do świata zewnętrznego; istniejące wywołania dwuargumentowe działają bez zmian.
- ~~**Duplikacja dwóch stringów komunikatu odmowy guardu** (`describeGuardRefusal` w `onboard.mjs` ↔ `describeGitignoreRefusal` w `setup.mjs`) zamiast importu~~ — **cofnięte po review fazy 2 (P2-3)**: uzasadnienie („`onboard.mjs` ciągnie `lib/db` przy imporcie") było nieprawdziwe, bo `setup.mjs` sam robi `require('./lib/db')` w czterech miejscach. `askInboxInvite` deleguje dziś całą sekwencję do `runOnboard` — porządek bezpieczeństwa parse → probe → guard → zapis → rola istnieje w **jednym** egzemplarzu.

**Poprawki po review fazy 2 (commit `20afbb5`):**
- **P2-1** — `setup_team_os_member` ostrzega, gdy VPS członka kończy w roli `client`: ta maszyna zacznie renderować `Skrzynka.md`, a drugi synchronizator pod Obsidian Sync gubi odhaczenia `[x]`.
- **P2-2** — `runOnboard` czyta **poprzednią** rolę PRZED zapisem i przy zmianie wskazuje job z poprzedniej instalacji do ręcznego wyłączenia (seed nigdy nie robi `UPDATE` — R9, więc sam się nie posprząta).
- **P2-3** — koniec drugiego egzemplarza porządku bezpieczeństwa w `setup.mjs` (patrz wyżej).
- **P2-4** — testy obu gałęzi porażki restartu (`systemctl` ≠ 0 oraz HTTP 000): stub parametryzuje `SYSTEMCTL_RC` i `HTTP_CODE`; `install-vps.test.sh` 119 → **123 PASS**.

### Faza 3 — ✅ ukończona (IU-3.1)

**Co powstało:** wyłącznie aktualizacja `CLAUDE.md` (zero zmian w kodzie, zero nowych zależności). Opisane: flaga `state.inbox_role` (`client` | `agent`, brak flagi = `client`, ustawiana tylko przez instalatory, **nigdy** backfillowana w `migrate()`), docelowa topologia (sync = maszyna człowieka, auto-reply = maszyna 24/7) wraz z uzasadnieniem rozproszonego *lost update* pod Obsidian Sync, ścieżka członka w `install-vps.sh` (odpowiedź „t" na pytanie o hub stawia WŁASNY hub), rdzeń `invite.mjs` + most `onboard.mjs` (kontrakt kodów wyjścia, redakcja tokenu), guard `.gitignore` jako część kontraktu zapisu sekretów (`git check-ignore` na EFEKT, sonda `.env` + `.env.bak.x`, fail-closed przy `unfixable`/`unknown`).

**Sprostowane:** zdanie „asystent auto-reply **seedowany WYŁĄCZONY**" — nieaktualne od fazy 1. Dziś seed jest **rozłączny wg roli**: `agent` → tylko auto-reply (od razu włączony), `client`/brak flagi → tylko sync.

**Odchylenie:** zakres opisu szerszy niż lista w „Podejście" planu — dopisane akapity o `invite.mjs`/`onboard.mjs` i o dwóch niezależnych komponentach Team OS w instalatorze VPS. Bez nich opis samej flagi wisiałby w próżni (czytelnik nie wie, skąd rola się bierze).

**Walidacja fazy:** `npm test` **584/584** zielone, `bash scripts/install-vps.test.sh` **123 PASS / 0 FAIL**. Grep w `CLAUDE.md`: `inbox_role` obecne, nieaktualne zdanie o auto-reply nie występuje.

## Skąd to zadanie

Faza 3 zadania `team-os-hub-api` dostarczyła onboarding **admina** (instalator VPS stawia hub i drukuje kod zaproszenia) oraz onboarding **członka na laptopie** (`setup.mjs` pyta o kod zaproszenia). Przy pierwszym realnym wdrożeniu drugiej osoby (maszyna „Cave") wyszło, że ta ścieżka ma dziurę: **członek z własnym VPS-em nie ma jak skonfigurować skrzynki inaczej niż ręczną edycją `.env`**.

Operator wykonał to dziś ręcznie na produkcyjnym VPS-ie (dopisanie `INBOX_HUB_URL` + `INBOX_TOKEN` do `/home/claude/vault/.env`, restart, włączenie auto-reply z dashboardu). Zadanie polega na tym, żeby tego kroku **nigdy więcej nie musiał robić człowiek** — bo docelowy użytkownik jest nietechniczny i ma wkleić jedną komendę.

Drugi wątek: podczas tej samej sesji doszło do **realnego wycieku sekretów** do prywatnego repo vaulta (szczegóły niżej). Instalator zapisuje token do `.env` w katalogu, który u operatora jest repozytorium gitowym z automatycznym commitem — i nikt tego nie sprawdzał. To domyka się w tym samym zadaniu, bo dotyczy tego samego momentu (zapis sekretu przez instalator).

## Stan obecny

### Co działa dobrze (nie ruszać)

- **`setup.mjs` → `askInboxInvite`** (linia ~904): pyta „Masz kod zaproszenia do skrzynki zespołowej? (puste = pomiń)", parsuje czystą funkcją `parseInviteCode`, **waliduje probe'em na żywym hubie zanim cokolwiek zapisze**, zapisuje przez `writeInboxEnv` (upsert — nie nadpisuje innych kluczy). Każda porażka → warn i pominięcie, nigdy fail setupu. Ten łańcuch jest wzorcowy i zostaje.
- **`parseInviteCode`** — czysta funkcja z pełnymi testami w `setup.test.mjs` (happy path, trim, złe formaty). Format `puls-inbox:<url>#<token>`, rozdzielanie po OSTATNIM `#`.
- **`inbox-seed.js` nigdy nie robi `UPDATE`** — tworzy joby tylko gdy ich brak (`if (!existing.some(...)) db.createJob(...)`). Dzięki temu ręczne wyłączenia jobów przeżywają restart daemona. Ta właściwość jest krytyczna i musi zostać.

### Trzy luki

**Luka 1 — `install-vps.sh` nie ma ścieżki członka.**
Funkcja `setup_team_os_hub` (~1497) obsługuje **wyłącznie tryb admina**: pyta „Postawić hub skrzynki Team OS na tym serwerze? (tylko admin zespołu) [t/N]" (domyślnie N), a przy odpowiedzi N robi `return 0` i temat skrzynki się kończy. Nie ma gdzie wkleić kodu zaproszenia. Konsekwencje:
- członek z VPS-em musi ręcznie edytować `.env` (obecny stan — nieakceptowalny),
- co gorsza: intuicyjna odpowiedź „t" na pytanie o hub postawiłaby **drugi, niezależny hub** — dwie skrzynki, które nigdy się nie zobaczą.

Dodatkowo: nawet **admin** po utworzeniu członka-admina nie ma swojej maszyny skonfigurowanej jako klient — instalator drukuje kod zaproszenia i na tym kończy, mimo że trzyma ten kod w zmiennej i mógłby od razu skonfigurować lokalny `.env`.

**Luka 2 — auto-reply seeduje się wyłączony na każdej maszynie.**
`assistantJobDef` ma `enabled: 0` z komentarzem „Seedowany WYŁĄCZONY — włączenie asystenta to świadoma decyzja per maszyna (panel Pulsa), nie skutek instalacji". W praktyce daje to półprodukt: użytkownik przeszedł instalację, a funkcja nie działa, dopóki nie znajdzie właściwego przełącznika w dashboardzie. Jednocześnie **na laptopie ten wyłączony job tylko myli** — nie powinno go tam być w ogóle.

Sedno problemu technicznego: **joby tworzy daemon (`inbox-seed` przy starcie), a intencję użytkownika zna instalator**, który już dawno się zakończył. `inbox-seed` widzi wyłącznie „skrzynka skonfigurowana" i nie ma pojęcia, czy stoi na VPS-ie, czy na laptopie.

**Luka 3 — żaden instalator nie sprawdza, czy `.env` nie trafi do repo.**
Zdarzenie z 2026-07-25/26 (udokumentowane): vault operatora jest repo gitowym z automatycznym jobem „vault backup" commitującym wszystko nieignorowane. `.gitignore` zawierał wpis `.env`, który dopasowuje **wyłącznie dokładną nazwę pliku**. Kopie `.env.bak.<timestamp>` (z kompletem 35 sekretów: klucze API, hasło Postgresa, token skrzynki) **nie były ignorowane** → zostały zacommitowane i wypchnięte na prywatne repo GitHub (commity `b05de80f`, `72d2de9d`). Naprawione doraźnie (`git rm`, wzorzec `.env*`), ale historia gita nadal je zawiera.

Wniosek systemowy: **instalator zapisuje sekret do katalogu użytkownika i nie weryfikuje, czy ten katalog go nie opublikuje.** Wzorzec `.env` jest niewystarczający — musi być `.env*`. Weryfikacja musi iść przez `git check-ignore` (stan faktyczny), nie przez czytanie treści `.gitignore` — bo reguły negacji, `.gitignore` w katalogach nadrzędnych i globalny `core.excludesFile` sprawiają, że treść pliku nie jest odpowiedzią na pytanie „czy ten plik zostanie zacommitowany".

## Docelowa topologia (wariant A — zatwierdzona przez operatora)

| Maszyna | Sync | Auto-reply |
|---|---|---|
| Laptop (Obsidian, człowiek) | ✅ włączony | ❌ nie seedowany w ogóle |
| VPS (24/7) | ❌ nie włączany | ✅ włączony po pytaniu |

**Uzasadnienie sync na laptopie:** `Skrzynka.md` nie jest tylko wyświetlana — użytkownik ją **edytuje** (odhacza `[x] Zrobione`), a `pull` nadpisuje ją w całości. Gdy zapisuje maszyna A, a edytuje człowiek na maszynie B (vaulty spięte Obsidian Sync), powstaje rozproszony *lost update*: VPS czyta plik sprzed propagacji ptaszka, regeneruje go ze stanu huba, a Obsidian Sync rozstrzyga konflikt na poziomie pliku (nie rozumie semantyki checkboxa) → **odhaczenie znika bez żadnego sygnału**. Projekt rozwiązał już ten wyścig lokalnie (`inbox-sync.mjs` robi push→pull w jednym procesie); Obsidian Sync przywraca go w wersji rozproszonej, której jednoprocesowość nie załatwia.

**Uzasadnienie auto-reply na VPS:** 24/7 jest potrzebne dla **zobowiązań wobec innych** (ktoś pyta w nocy — agent odpowiada). Auto-reply czyta pytania **prosto z huba** (`claimQuery`), nie z `Skrzynka.md`, więc nie zależy od syncu. Renderowanie własnej skrzynki 24/7 nie daje nic, bo przy zamkniętym laptopie nikt jej nie czyta, a wiadomości i tak czekają na hubie (to on jest źródłem prawdy).

## Świadomie odrzucone (nie wracamy)

- **Sync na obu maszynach** — dwa niezależne procesy nadpisujące co minutę ten sam plik pod Obsidian Sync = fabryka plików konfliktowych.
- **Sync wyłącznie na VPS** — kusi (Skrzynka zawsze aktualna, Obsidian Sync dostarcza ją natychmiast, działa też na telefonie), ale kupuje to ryzykiem cichego gubienia `[x] Zrobione`. Awaria przez nieaktualność jest widoczna i samonaprawialna; awaria przez cofnięcie akcji użytkownika podkopuje zaufanie do narzędzia. Wariant do ewentualnego powrotu **dopiero po** uszczelnieniu `pull` (scalanie zamiast nadpisywania) — poza zakresem.
- **Wykrywanie roli maszyny po platformie** (Linux = VPS) — zgadywanie; myli system operacyjny z rolą. Ktoś na linuksowym desktopie dostałby auto-reply, którego nie chciał.
- **Reimplementacja parsowania kodu zaproszenia w bashu** — drift dwóch źródeł prawdy. Projekt już raz za to zapłacił (stąd powstał wspólny `env-loader.mjs`).
- **Tworzenie joba auto-reply przez instalator bezpośrednio przez API** — zduplikowałoby definicję joba (ścieżka, cron, timeouty, flagi) w bashu. Definicje zostają w `inbox-seed.js` jako jedyne źródło prawdy; instalator przekazuje wyłącznie **decyzję**.

## Założenia

- **VPS członka ma kopię vaulta** (u operatora: Obsidian Sync; instalator VPS ma też ścieżkę vault-git). Nie wpływa na mechanikę instalatora — zmienia wyłącznie jakość odpowiedzi auto-reply, bo agent czerpie wiedzę z plików vaulta. Bez vaulta auto-reply będzie zwracał `NO_ANSWER` z braku wiedzy.
- Repo jest już rozpakowane w momencie, gdy instalator VPS dochodzi do fazy Team OS (po `setup_funnel`) — więc może wołać helper Node z repo.
- Node w wersji ≥22.13 jest dostępny (portable Node z instalacji) — helper korzysta z tego samego runtime'u co reszta.

## Poza zakresem

Rotacja tokenu `kacper`, czyszczenie historii gita repo vaulta, decommission Postgresa w Coolify, coalescing rutynowych jobów (kolejka blokowana przez długie joby), uszczelnienie `pull` (scalanie zamiast nadpisywania).

## Powiązane pliki

| Plik | Rola w zadaniu | Weryfikacja stanu 2026-07-26 |
|---|---|---|
| `setup.mjs` | źródło ekstrakcji (IU-1.1) + guard `.gitignore` i rola `client` w `askInboxInvite` (IU-2.3) | **zmieniony** (fazy 1 i 2) |
| `setup.test.mjs` | siatka bezpieczeństwa ekstrakcji + testy guardu/roli w `askInboxInvite` (78 testów w pliku) | **zmieniony** (fazy 1 i 2) |
| `scripts/inbox/invite.mjs` | wspólny rdzeń kodu zaproszenia + guard `.gitignore` (IU-1.1) | **utworzony** (faza 1) |
| `scripts/inbox/invite.test.mjs` | 26 testów rdzenia i guardu (repo testowe odcięte od `core.excludesFile` usera) | **utworzony** (faza 1) |
| `scripts/inbox/onboard.mjs` | cienkie CLI, most bash → Node; kontrakt `EXIT` (IU-2.1) | **utworzony** (faza 2) |
| `scripts/inbox/onboard.test.mjs` | 23 testy CLI: `parseArgs`, wszystkie wyniki `runOnboard`, redakcja tokenu, entry-point guard | **utworzony** (faza 2) |
| `scripts/inbox/env-loader.mjs` | wzorzec wspólnego modułu wyciągniętego, by zabić drift między skryptami | istnieje |
| `lib/inbox-seed.js` | rola maszyny steruje seedem (IU-1.2); `ROLE_STATE_KEY`, `assistantJobDef` z `enabled: 1`, nadal zero `UPDATE` | **zmieniony** (faza 1) |
| `lib/inbox-seed.test.js` | testy seeda rozszerzone o role + dowód R9 | **zmieniony** (faza 1) |
| `server.js` | mapa `SEEDED_JOB_NAMES` w logu startowym — konsument sufiksowanego statusu seedu (odchylenie IU-1.2) | **zmieniony** (faza 1) |
| `lib/db.js` | `getState`:369, `setState`:374 — nośnik flagi `inbox_role` | potwierdzone |
| `lib/notify-push.js` | wzorzec kontraktu `{ok, reason}` — nigdy nie wywraca wołającego | istnieje |
| `scripts/install-vps.sh` | `setup_team_os_member` + helpery `team_os_*` obok nietkniętego `setup_team_os_hub` (IU-2.2) | **zmieniony** (faza 2) |
| `scripts/install-vps.test.sh` | harness lib-only (`CLAUDE_CRON_LIB_ONLY=1`), sandbox `mktemp`, rejestrator wywołań; 123 PASS | **zmieniony** (faza 2 + fix po review) |
| `CLAUDE.md` | sprostowanie zapisu o auto-reply + opis roli maszyny, topologii, ścieżki członka i guardu `.gitignore` (IU-3.1) | **zmieniony** (faza 3) |

## Decyzje techniczne i zależności

Pełne uzasadnienia siedzą w `-plan.md`; tu skrót, żeby ten plik był samowystarczalny po resecie kontekstu:

- **Jedna flaga roli `inbox_role` (`client` | `agent`)** w tabeli `state`, nie dwie flagi boolean. Brak flagi = zachowanie dzisiejsze (`client`), więc istniejące instalacje nie zmieniają stanu.
- **Rdzeń w `scripts/inbox/invite.mjs`, CLI w `scripts/inbox/onboard.mjs`** — bash nie dostaje ani linii logiki domenowej; `setup.mjs` re-eksportuje `parseInviteCode`/`upsertDotenvLine` dla zgodności z testami.
- **Guard `.gitignore` przez `git check-ignore`** (exit-code, nie treść pliku), z ponowną weryfikacją po dopisaniu `.env*`; przy `unfixable` **fail-closed** — pomijamy zapis tokenu, nie przerywamy instalacji.
- **Kolejność na VPS:** zapis `.env` + `setState('inbox_role', …)` **przed** restartem daemona (`inbox-seed` czyta flagę dopiero przy starcie; env nie propaguje się do żyjących procesów).
- **Kolejność wewnątrz onboardingu:** parse → probe → guard → zapis → rola. Probe waliduje kod zanim dotkniemy plików, guard tuż przed zapisem, rola tylko po udanym zapisie.
- **Zależności między IU:** IU-1.1 i IU-1.2 są równoległe; IU-2.1 wymaga obu; IU-2.2 wymaga IU-2.1; IU-2.3 wymaga IU-1.1 + IU-1.2; IU-3.1 na końcu.
- **Zależności zewnętrzne:** zero nowych paczek npm. Jedyny nowy element zewnętrzny to `git check-ignore` (stabilna semantyka exit-code). ~~Brak gita traktujemy jak „nie repo" → guard przepuszcza.~~ **Skorygowane po review fazy 1 (P2)**: brak gita / błąd gita → status `unknown` → guard **odmawia zapisu** (fail-closed), bo vault bywa commitowany z drugiej maszyny; „poza repo" rozpoznawane osobno przez `git rev-parse --git-dir`.

## Źródła

- Requirements doc: brak — zakres ustalony w sesji operacyjnej (wdrożenie maszyny „Cave" + incydent wycieku sekretów 2026-07-25/26), ustalenia produktowe zapisane w tym pliku.
- Plan techniczny: brak osobnego pliku w `docs/plans/` — Implementation Units żyją w `team-os-onboarding-instalatory-plan.md` i `team-os-onboarding-instalatory-zadania.md`.
- Poprzednie zadanie (wzorzec i geneza): `docs/completed/team-os-hub-api/`
