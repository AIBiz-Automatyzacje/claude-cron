---
title: "feat: Team OS — onboarding członka w instalatorach"
type: feat
status: active
date: 2026-07-26
origin: null
design_md: null
figma_spec: null
figma_screens: {}
---

# Team OS — onboarding członka w instalatorach

Branch: `feature/team-os-onboarding-instalatory` (odbity z `main` po `024653f`)
Ostatnia aktualizacja: 2026-07-26 (faza 2 zaimplementowana — IU-2.1, IU-2.2, IU-2.3)

## Podsumowanie wykonawcze

Onboarding członka zespołu z własnym VPS-em kończy się dziś **ręczną edycją `.env`** — nieakceptowalne dla nietechnicznego użytkownika, który ma wkleić jedną komendę. Instalator VPS zna wyłącznie tryb admina (stawianie huba); po odpowiedzi „nie" temat skrzynki się urywa.

Zadanie domyka trzy luki w jednym przebiegu, bo wszystkie dotyczą tego samego momentu — instalatora zapisującego konfigurację skrzynki:

1. **Ścieżka członka w `install-vps.sh`** — pytanie o kod zaproszenia, probe, zapis `.env`, restart. Plus: admin dostaje swoją maszynę skonfigurowaną jako klient **automatycznie** (instalator już trzyma świeżo utworzony kod w zmiennej).
2. **Rola maszyny w `state`** — jedna flaga `inbox_role` (`client` | `agent`) rozstrzyga, co `inbox-seed` seeduje: laptop dostaje sync, VPS dostaje auto-reply włączony po pytaniu. Koniec z mylącym wyłączonym jobem na laptopie.
3. **Guard `.gitignore` przed zapisem sekretu** — instalator weryfikuje przez `git check-ignore`, że `.env` nie trafi do repo; naprawia wzorcem `.env*` albo fail-closed pomija zapis z instrukcją.

Spoiwem jest **współdzielony moduł `scripts/inbox/invite.mjs`** (parse + probe + zapis + guard) używany przez oba instalatory — bash woła go przez cienkie CLI `scripts/inbox/onboard.mjs`, zamiast reimplementować logikę w shellu.

## Śledzenie wymagań

- **R1.** Członek z VPS-em konfiguruje skrzynkę **bez ręcznej edycji plików** — wyłącznie odpowiadając na pytania instalatora.
- **R2.** Osoba pracująca solo może pominąć skrzynkę (puste = pomiń) i instalacja leci dalej; zły kod = warn, nie fail.
- **R3.** Odpowiedź „nie" na pytanie o hub **nie kończy** tematu skrzynki — prowadzi do ścieżki członka.
- **R4.** Auto-reply jest tworzony **wyłącznie** na maszynie oznaczonej jako `agent` i od razu **włączony**; na `client` nie powstaje w ogóle.
- **R5.** Sync jest włączony na `client`; na `agent` nie jest włączany.
- **R6.** Instalator **przed** zapisem tokenu weryfikuje przez `git check-ignore`, że `.env` nie zostanie zacommitowany; naprawa wzorcem `.env*`.
- **R7.** Definicje jobów pozostają wyłącznie w `lib/inbox-seed.js` — zero duplikacji w bashu.
- **R8.** Logika kodu zaproszenia ma **jedno** źródło prawdy, wspólne dla `setup.mjs` i instalatora VPS.
- **R9.** `inbox-seed` nadal nigdy nie robi `UPDATE` — ręczne wyłączenia jobów przeżywają restart.

## Granice scope'u

- Nie ruszamy transportu ani kontraktu API huba (`/inbox/v1/*`).
- Nie ruszamy parserów, rendererów ani kontraktu push↔pull w vaultcie.
- Nie zmieniamy zachowania `pull` (nadpisywanie zamiast scalania zostaje).
- Nie dotykamy rotacji tokenów, historii gita vaulta ani Postgresa w Coolify.
- Bez UI — dashboard bez zmian (widok „Zespół" pozostaje kanałem admina).

## Kontekst i research

### Relevantny kod i wzorce

- `setup.mjs:215-250` — `INVITE_CODE_PREFIX` + `parseInviteCode` (czysta, testowana; rozdzielanie po ostatnim `#`, walidacja protokołu http/https).
- `setup.mjs:257+` — `upsertDotenvLine` (format env-loader, bez `export`, idempotentny).
- `setup.mjs:866-873` — `writeInboxEnv` (upsert `INBOX_HUB_URL`/`INBOX_TOKEN` do `<workspace>/.env`).
- `setup.mjs:881-898` — `probeInviteCode` (reużywa `client.ping()`, mutuje `process.env` tylko na czas probe i przywraca w `finally`, nigdy nie rzuca — wzorzec `notify-push`).
- `setup.mjs:904-930` — `askInboxInvite` (kolejność: parse → probe → zapis → hint restartu).
- `scripts/install-vps.sh:1497-1562` — `setup_team_os_hub`: `ask_tty` z domyślnym N, `team_os_wait_for_server`, idempotencja po `name`, rozstrzyganie na **kodzie HTTP** (nie exit-code curl), `TEAM_OS_INVITE_CODE`/`TEAM_OS_ADMIN_NAME` do podsumowania.
- `scripts/install-vps.sh:189` `ask_tty`, `:228` `ask_valid`, `:1437` `is_valid_member_name` — helpery pytań.
- `scripts/install-vps.sh:1231` — `Environment=CLAUDE_CRON_WORKSPACE=%s` w unicie (workspace = `~/vault`).
- `lib/inbox-seed.js` — `inboxSyncJobDef`/`assistantJobDef`, snapshot+restore `process.env` wokół `loadEnv`, zwrot `'seeded' | 'exists' | 'not_configured'`, nigdy nie rzuca.
- `lib/db.js:369-374` — `getState`/`setState` (eksportowane).
- `scripts/install-vps.test.sh` — harness: lib-only source (`CLAUDE_CRON_LIB_ONLY=1`), sandbox `mktemp`, każdy scenariusz w świeżym subshellu, liczniki PASS/FAIL.
- `setup.test.mjs:504+` — istniejące testy `parseInviteCode` (importują z `setup.mjs`).

### Wiedza instytucjonalna

- `docs/solutions/deployment-issues/2026-07-03-guardy-instalatora-falszywe-sygnaly-statusow-cli.md` — **stan zewnętrznego narzędzia czytaj z dokładnej frazy i potwierdzaj stan faktyczny**. Bezpośrednio dyktuje użycie `git check-ignore` (pytanie o efekt) zamiast parsowania `.gitignore` (pytanie o treść) oraz **ponowną weryfikację po naprawie**.
- `docs/solutions/deployment-issues/2026-07-02-rollback-stos-a-granica-loginow-oauth.md` — opcjonalne kroki finału to **warn, nie `trap ERR`**; pad nie może odwinąć zweryfikowanej instalacji. Nowa ścieżka członka jest w tej samej strefie co `setup_team_os_hub`.
- `docs/solutions/deployment-issues/2026-06-30-curl-bash-instalator-interaktywny-tty.md` — pytania w `curl|bash` wymagają `/dev/tty`; nowe pytania **muszą** iść przez istniejący `ask_tty`, nie gołe `read`.
- `docs/solutions/auth-issues/2026-07-24-cors-acao-wildcard-wyciek-tokenu-guard-xff-nie-chroni.md` — granice bezpieczeństwa są **ortogonalne** i przy niepewności działa się **fail-closed**. Stąd decyzja: guard `.gitignore`, którego nie da się naprawić → **pomiń zapis sekretu**, nie zapisuj „bo i tak".
- `docs/solutions/runtime-errors/2026-06-27-backfill-w-migrate-clobberuje-opt-outy.md` — stan w `state` czyta się przy starcie; **nie wolno** nadpisywać decyzji użytkownika przy każdym boocie. Flaga `inbox_role` jest **czytana** przez seed, ustawiana wyłącznie przez instalator.
- `docs/solutions/deployment-issues/2026-07-07-stale-env-vps-url-hook-respawn-serwera.md` — zmiana env nie propaguje się do żyjących procesów. Stąd wymóg **restartu daemona po zapisie `.env`** (script-joby dziedziczą env daemona).

### Referencje zewnętrzne

Pominięte świadomie — zadanie operuje wyłącznie na wewnętrznych wzorcach repo (instalatory, seed, `state`), brak nowych zależności i nieznanych API. Jedyny element zewnętrzny (`git check-ignore`) jest stabilnym, udokumentowanym poleceniem gita o semantyce exit-code.

## Kluczowe decyzje techniczne

- **Jedna flaga roli `inbox_role` (`client` | `agent`) zamiast dwóch flag boolean.** Wymagania R4 i R5 są dwiema stronami tej samej decyzji („czym jest ta maszyna"), więc modelujemy je jednym polem o rozłącznych wartościach, a nie parą niezależnych przełączników, które mogą wpaść w niespójny stan (`sync=off` + `auto_reply=off`). Brak flagi = zachowanie dzisiejsze (`client`: sync włączony, auto-reply nieobecny) — bezpieczny domyślny, chroni instalacje konfigurowane ręcznie przed „cichą śmiercią Skrzynki".
- **Współdzielony moduł `scripts/inbox/invite.mjs`, nie import z `setup.mjs`.** `onboard.mjs` importujący `setup.mjs` odwracałby warstwy (skrypt roboczy ciągnie interaktywny instalator) i wciągał `readline`/`os` do procesu CLI. Ekstrakcja to ten sam ruch, który projekt wykonał już przy `env-loader.mjs`. `setup.mjs` **re-eksportuje** `parseInviteCode`, żeby istniejące testy i importy nie ucierpiały (R8 bez psucia działającego flow).
- **Cienkie CLI `scripts/inbox/onboard.mjs` jako most bash → Node.** Bash przekazuje kod zaproszenia i rolę, dostaje z powrotem kod wyjścia + jednolinijkowy komunikat. Zero logiki domenowej w shellu (R8), zero duplikacji definicji jobów (R7).
- **Guard `.gitignore` przez `git check-ignore`, z ponowną weryfikacją po naprawie.** Treść `.gitignore` nie jest odpowiedzią na pytanie „czy plik zostanie zacommitowany" — reguły negacji, pliki w katalogach nadrzędnych i `core.excludesFile` sprawiają, że tylko git zna prawdę. Naprawa dopisuje `.env*` do `<workspace>/.gitignore`, po czym **pyta gita ponownie**.
- **Fail-closed przy nienaprawialnym guardzie.** Jeśli po naprawie `.env` nadal nie jest ignorowany (np. wyraźna reguła negacji), **nie zapisujemy tokenu** — instalacja leci dalej z głośną instrukcją. Zapis sekretu do katalogu, który go opublikuje, jest gorszy niż brak skonfigurowanej skrzynki: pierwsze jest nieodwracalne (historia gita), drugie to jedno pytanie przy ponownym uruchomieniu.
- **Admin konfiguruje swoją maszynę automatycznie.** Po utworzeniu członka-admina instalator ma świeży kod zaproszenia w `TEAM_OS_INVITE_CODE` — używa go od razu do konfiguracji tej maszyny jako klienta. Eliminuje dokładnie ten ręczny krok, który operator wykonał dziś na produkcji.
- **Auto-reply pyta się na obu ścieżkach VPS (admin i członek), nigdy w `setup.mjs`.** Laptop z definicji nie jest `agent`.

## Otwarte pytania

### Rozwiązane podczas planowania

- **Gdzie helper: osobny plik czy tryb `setup.mjs`?** → osobny moduł `invite.mjs` (rdzeń) + `onboard.mjs` (CLI). Tryb w `setup.mjs` wymagałby rozgałęzienia `main()` przed interaktywnymi pytaniami i mieszał odpowiedzialności instalatora z narzędziem wołanym maszynowo.
- **Jak instalator (bash) ustawia flagę w bazie?** → przez `onboard.mjs`, który woła `db.setState`. Odrzucone: nowy endpoint HTTP (zbędna powierzchnia publiczna dla operacji lokalnej) oraz zapis do env (flaga musi przeżyć restart i nie zależeć od powłoki).
- **Kolejność operacji na VPS?** → zapis `.env` + ustawienie flagi **przed** restartem daemona; `inbox-seed` czyta flagę dopiero przy starcie, więc odwrotna kolejność dałaby seed bez auto-reply aż do kolejnego restartu.
- **Czy `setup_team_os_hub` przepisać na dispatcher?** → nie; dodajemy odrębne `setup_team_os_member`, a `main()` woła je warunkowo. Istniejące testy `setup_team_os_hub` zostają nietknięte, nowa funkcja jest niezależnie testowalna w harnessie lib-only.
- **Czy `.gitignore` naprawiać w katalogu workspace'u czy repo roota?** → w `<workspace>/.gitignore`. `gitignore` działa per katalog, więc wzorzec tam położony pokrywa `.env*` w workspace niezależnie od tego, czy workspace jest rootem repo, czy podkatalogiem.

### Odroczone do implementacji

- ~~**Dokładna sygnatura CLI `onboard.mjs`**~~ — **rozstrzygnięte w IU-2.1**: nazwane flagi (`--code`, `--role`, `--workspace`, obie formy: ze spacją i z `=`), argumenty pozycyjne odrzucane bez echa wartości (mogłaby nią być tożsamość). Wyjście: kod wyjścia jako kontrakt maszynowy (`EXIT` 0/2/3/4/5/6, `1` zarezerwowane dla nieobsłużonego wyjątku) + jedna linia `[ok]/[warn]/[error]` dla człowieka, nigdy do parsowania przez shell.
- **Czy `probeInviteCode` po ekstrakcji zachowa mutację `process.env`** — być może czystsze będzie przekazanie konfiguracji do `inbox-client` jawnie; decyzja po zobaczeniu, czy klient da się o to poprosić bez zmiany jego kontraktu (klient czyta env **w momencie wywołania** — to udokumentowany wzorzec, którego nie chcemy łamać).
- **Zachowanie dla maszyny „tylko VPS, bez laptopa"** — przy roli `agent` sync nie jest włączany, więc taki użytkownik nie ma renderowanej Skrzynki. Przy założeniu współdzielonego vaulta to poprawne; jeśli w praktyce pojawi się osoba bez laptopa, potrzebna będzie trzecia rola (`standalone`: sync + auto-reply). Nie budujemy jej na zapas.
- ~~**Czy ostrzegać, gdy vault na VPS wygląda na pusty**~~ — **rozstrzygnięte w IU-2.2: tak**, `team_os_vault_looks_empty` (sonda `find -maxdepth 2 -name '*.md' -print -quit`, nie inwentaryzacja) wypisuje `warn` **przed** pytaniem o auto-reply, żeby decyzja zapadała ze świadomością, że agent bez wiedzy odpowie `NO_ANSWER`.

## Fazy wdrożenia

### Faza 1 — Rdzeń współdzielony + rola maszyny (M) — ✅ ukończona

> **Stan po implementacji:** oba IU completed, `npm test` 533/533 zielone. Scenariusze testowe z `-zadania.md` pokryte (26 testów w `invite.test.mjs`, 8 w `inbox-seed.test.js`), z jednym odchyleniem konstrukcyjnym: scenariusz „reguła negacji → po dopisaniu wzorca nadal nie ignorowany" rozbito na dwa testy, bo samą negacją nie da się dojść do ścieżki ponownej weryfikacji (dopisany na końcu `.env*` wygrywa z wcześniejszym `!.env`) — ścieżkę tę pokrywa test z plikiem śledzonym w indeksie. Szczegóły odchyleń: `-zadania.md`, sekcje IU-1.1 / IU-1.2.

**IU-1.1 `scripts/inbox/invite.mjs` — wspólny rdzeń kodu zaproszenia + guard `.gitignore` (M)** — ✅
Ekstrakcja `parseInviteCode`, `upsertDotenvLine`, `writeInboxEnv`, `probeInviteCode` z `setup.mjs` do dedykowanego modułu; `setup.mjs` importuje i **re-eksportuje** `parseInviteCode`/`upsertDotenvLine` dla zgodności z istniejącymi testami. Nowa czysta funkcja guardu: decyzja o stanie `.gitignore` (`ok` / `naprawiono` / `nienaprawialne`) oddzielona od I/O gita, żeby dała się przetestować bez tworzenia repo. Cienka skorupa I/O woła `git check-ignore` (rozstrzyganie na exit-code), dopisuje wzorzec `.env*` i **weryfikuje ponownie**.

**IU-1.2 `lib/inbox-seed.js` — rola maszyny steruje seedem (S)** — ✅
Odczyt `state.inbox_role`: `agent` → seeduj **tylko** auto-reply z `enabled: 1`; `client` lub brak flagi → seeduj **tylko** sync (auto-reply nie powstaje). Aktualizacja komentarza dokumentującego odwróconą decyzję („seedowany wyłączony" → „tworzony tylko na maszynie-agencie, od razu włączony"). Zachowana właściwość: **wyłącznie `createJob` gdy brak, nigdy `UPDATE`** (R9) oraz snapshot+restore `process.env` wokół `loadEnv`.

### Faza 2 — Instalatory (L) — ✅ ukończona

> **Stan po implementacji:** trzy IU completed, `npm test` **579/579** zielone, `bash scripts/install-vps.test.sh` **119 PASS / 0 FAIL** (licznik wzrósł ze 110). Scenariusze testowe z `-zadania.md` pokryte: 23 testy w `onboard.test.mjs` (IU-2.1), 9 nowych w `install-vps.test.sh` (IU-2.2), rozszerzone `setup.test.mjs` (IU-2.3). Odchylenia: kontrakt kodów wyjścia rozszerzony o `BAD_USAGE=2` i `WRITE=6`, obsłużony piąty status guardu `unknown` (fail-closed), pytanie o auto-reply z domyślnym `N`. Szczegóły: `-zadania.md`, sekcje IU-2.1 / IU-2.2 / IU-2.3.

**IU-2.1 `scripts/inbox/onboard.mjs` — CLI dla instalatora VPS (S)** — ✅
Most bash → Node: przyjmuje kod zaproszenia i rolę, wykonuje łańcuch guard `.gitignore` → parse → probe → zapis `.env` → `setState('inbox_role', ...)`. Kod wyjścia i jednolinijkowy komunikat jako kontrakt dla shella; rozłączne kody dla „zły format", „hub nieosiągalny", „gitignore nienaprawialny" — bash rozstrzyga na nich komunikaty dla użytkownika (nie zgaduje z tekstu).

**IU-2.2 `install-vps.sh` — ścieżka członka + autokonfiguracja admina + pytanie o auto-reply (L)** — ✅
Nowa funkcja `setup_team_os_member`: pytanie o kod zaproszenia (`ask_tty`, puste = pomiń — R2), wywołanie `onboard.mjs`, restart serwisu po sukcesie. Wołana z `main()` gdy ścieżka admina nie skonfigurowała tej maszyny (R3). W ścieżce admina: użycie świeżego `TEAM_OS_INVITE_CODE` do konfiguracji tej maszyny bez ponownego wklejania. Na obu ścieżkach pytanie „Czy ten serwer ma automatycznie odpowiadać na pytania zespołu?" → rola `agent`. Pad na każdym kroku = `warn` + kontynuacja (strefa opcjonalnych kroków finału — nigdy `trap ERR`).

**IU-2.3 `setup.mjs` — guard `.gitignore` w ścieżce lokalnej + rola `client` (S)** — ✅
`askInboxInvite` woła guard **przed** `writeInboxEnv` (R6); przy wyniku „nienaprawialne" pomija zapis z czytelną instrukcją i nie przerywa setupu. Po udanym zapisie ustawia `state.inbox_role = 'client'`. Kolejność parse → probe → guard → zapis zachowana (probe waliduje kod, zanim dotkniemy plików).

### Faza 3 — Dokumentacja (S) — ✅ ukończona

> **Stan po implementacji:** IU-3.1 completed, zmieniony wyłącznie `CLAUDE.md` (zero zmian w kodzie, zero nowych zależności). Walidacja: `npm test` **584/584** zielone, `bash scripts/install-vps.test.sh` **123 PASS / 0 FAIL**. Weryfikacja greppem: `inbox_role` obecne w `CLAUDE.md`, nieaktualne zdanie o auto-reply „seedowanym WYŁĄCZONYM" nie występuje. Odchylenie: zakres opisu szerszy niż lista w „Podejście" (dopisany `invite.mjs`/`onboard.mjs` i podział komponentów Team OS w instalatorze VPS) — szczegóły w `-zadania.md`, sekcja IU-3.1.

**IU-3.1 Aktualizacja `CLAUDE.md` (S)** — ✅
Sekcja Team OS: opis roli maszyny i flagi `inbox_role`, docelowa topologia (sync = laptop, auto-reply = VPS) wraz z uzasadnieniem wyścigu Obsidian Sync, ścieżka członka w instalatorze VPS, guard `.gitignore` jako część kontraktu zapisu sekretów. Sprostowanie zapisu o auto-reply seedowanym wyłączonym.

## Wpływ systemowy

- **Graf interakcji:** `install-vps.sh` → `onboard.mjs` → (`invite.mjs`, `lib/db.js`) → restart systemd → `server.js` start → `inbox-seed` → `db.createJob`. Nowe ogniwo bash→Node jest jedynym miejscem przekazania decyzji użytkownika do runtime'u.
- **Propagacja błędów:** każda porażka w strefie Team OS to `warn` + kontynuacja instalacji; twardy fail zarezerwowany dla sytuacji, w której zapis sekretu byłby niebezpieczny (wtedy pomijamy zapis, nie przerywamy instalacji).
- **Ryzyka cyklu życia stanu:** flaga w `state` musi być zapisana **przed** restartem daemona; zapis do `.env` bez restartu nie propaguje się do script-jobów (udokumentowana pułapka stale env).
- **Parytet surface API:** `install.ps1` (Windows) **nie** dostaje ścieżki członka w tym zadaniu — lokalny onboarding idzie przez `setup.mjs`, wspólny dla wszystkich platform; guard `.gitignore` z IU-2.3 obejmuje więc również Windows.
- **Pokrycie integracyjne:** testy jednostkowe guardu i seeda nie dowiodą, że bash faktycznie woła CLI z poprawnym cytowaniem — stąd scenariusze w `install-vps.test.sh` sprawdzające sekwencję wywołań przez rejestrator (wzorzec istniejący w harnessie).

## Ryzyka i zależności

| Ryzyko | Mitygacja |
|---|---|
| Ekstrakcja z `setup.mjs` psuje działający onboarding lokalny | Re-eksport symboli + istniejące testy `setup.test.mjs` (44 dopasowania na `parseInviteCode`/`upsertDotenvLine`/`askInboxInvite`) jako siatka bezpieczeństwa; zero zmian zachowania, wyłącznie przeniesienie |
| `git check-ignore` niedostępny (brak gita na VPS) lub workspace poza repo | Traktować jako „nie jest repo" → guard przepuszcza (nie ma czego publikować); rozstrzygać na exit-code, nie na treści komunikatu |
| Cytowanie kodu zaproszenia w bashu (znaki `#`, `:`, `/`) | Przekazanie przez argument z `%q` (wzorzec obecny w instalatorze); test w harnessie na kodzie ze znakami specjalnymi |
| Flaga ustawiona, ale daemon nie zrestartowany → auto-reply nie powstaje | Restart jako część kroku, po nim weryfikacja stanu faktycznego (nie założenie, że wstał) — wzorzec `team_os_wait_for_server` |
| Równoległy zapis do `claude-cron.db` (CLI + żyjący daemon) | Pojedynczy `setState` w krótkiej transakcji; SQLite serializuje zapisy. Ryzyko realne dopiero przy długich transakcjach — tu ich nie ma |
| Zmiana seeda cofa ręczne decyzje użytkownika na istniejących instalacjach | Zachowany kontrakt „tylko `createJob` gdy brak, nigdy `UPDATE`" (R9) + brak flagi = zachowanie dzisiejsze; istniejące instalacje z wyłączonym auto-reply nie zmieniają stanu |

## Dokumentacja / Notatki operacyjne

- `CLAUDE.md` — sekcja Team OS (IU-3.1).
- Test end-to-end na realnej maszynie (Cave) jest **krokiem operatora** — brak `.env.e2e` w projekcie, a instalator VPS z natury wymaga świeżego serwera. Scenariusze w `Operator checklist` w `-zadania.md`.
- Po wdrożeniu: istniejące instalacje (produkcyjny VPS operatora + laptop) nie mają flagi `inbox_role`. VPS ma dziś auto-reply włączony ręcznie i sync wyłączony ręcznie — stan zgodny z docelowym, ale bez flagi. Ustawienie flagi na istniejących maszynach = jednorazowy krok operatora (opisany w checkliście), nie migracja w kodzie (backfill w `migrate()` clobberowałby decyzje — udokumentowana pułapka).

## Źródła

- Requirements doc: brak — `/dev-brainstorm` nie był uruchamiany. Zakres powstał z realnego wdrożenia drugiej maszyny („Cave") i incydentu wycieku sekretów 2026-07-25/26; ustalenia produktowe są zapisane w `-kontekst.md` (sekcje „Skąd to zadanie", „Docelowa topologia", „Świadomie odrzucone").
- Plan techniczny: brak osobnego pliku w `docs/plans/` — Implementation Units (IU-1.1 … IU-3.1) żyją bezpośrednio w tym planie oraz w `-zadania.md` wraz ze scenariuszami testowymi i kryteriami weryfikacji.

## Referencje

- Kontekst zadania: `docs/active/team-os-onboarding-instalatory/team-os-onboarding-instalatory-kontekst.md`
- Poprzednie zadanie (wzorzec i geneza): `docs/completed/team-os-hub-api/`
- Wiedza instytucjonalna: `docs/solutions/deployment-issues/2026-07-03-guardy-instalatora-falszywe-sygnaly-statusow-cli.md`, `docs/solutions/deployment-issues/2026-07-02-rollback-stos-a-granica-loginow-oauth.md`, `docs/solutions/auth-issues/2026-07-24-cors-acao-wildcard-wyciek-tokenu-guard-xff-nie-chroni.md`, `docs/solutions/runtime-errors/2026-06-27-backfill-w-migrate-clobberuje-opt-outy.md`
