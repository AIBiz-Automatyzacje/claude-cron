# Review fazy 2 — Instalatory (IU-2.1, IU-2.2, IU-2.3)

Zadanie: `team-os-onboarding-instalatory`
Branch: `feature/team-os-onboarding-instalatory` (HEAD `b32fa34` — „feat(inbox): onboarding członka skrzynki w instalatorach (faza 2)")
Data review: 2026-07-26

## Severity gate: ZASTRZEŻENIA

Zero P1. Cztery P2 (3 × KOD, 1 × TEST) — faza jest funkcjonalnie kompletna i zielona w obu suitach,
ale wychodzi z niej maszyna, która przy zwykłej ścieżce użycia (członek z VPS-em + laptop, albo re-run
instalatora po padzie) potrafi skończyć z dwoma jobami Skrzynki naraz — dokładnie stan, przed którym
bronią R4/R5. Do tego duplikat porządku bezpieczeństwa onboardingu w dwóch plikach i happy-path-only
pokrycie restartu serwisu.

## Statystyki

| Metryka | Wartość |
|---|---|
| Findingi łącznie (po dedupie i verify) | 26 |
| P1 (KOD/TEST/E2E) | 0 |
| P2 (KOD/TEST/E2E) | 4 |
| P3 (KOD/TEST/E2E) | 20 |
| OPERATOR (poza fix) | 2 |
| Typ KOD | 18 |
| Typ TEST | 6 |
| Typ E2E | 0 |
| Typ OPERATOR | 2 |
| Testy jednostkowe (`npm test`) | 579 PASS / 0 FAIL |
| Testy instalatora (`install-vps.test.sh`) | 119 PASS / 0 FAIL |
| E2E (przeglądarka) | nie odpalone (brak warstwy UI) |

Rozkład po plikach: `scripts/inbox/onboard.mjs` — 9, `scripts/install-vps.sh` — 7,
`scripts/install-vps.test.sh` — 4, `setup.mjs` — 4, `lib/inbox-seed.js` — 1, dokumentacja zadania — 1.

---

## P1 — blokujące

Brak.

---

## P2 — poważne

### P2-1 · KOD · `scripts/install-vps.sh:1685` — rola `client` na VPS-ie członka włącza drugi sync tego samego vaulta (R5)

Granica ról łamie R5 na ścieżce członka z VPS-em: odmowa auto-reply ustawia rolę `client`, a `client`
seeduje job „Team OS — inbox sync" (`lib/inbox-seed.js:96`). Ten sam człowiek ma zwykle laptopa
skonfigurowanego przez `setup.mjs`, który TEŻ zapisuje `client` (`persistInboxRole`) — obie maszyny
widzą ten sam vault przez Obsidian Sync (`WORKSPACE=~/vault` na VPS) i obie regenerują `Skrzynka.md`
co minutę. To dokładnie scenariusz, przed którym ostrzega komentarz w `lib/inbox-seed.js:13-15`
(„dwie maszyny synchronizujące Skrzynkę pod Obsidian Sync gubią odhaczenia `[x]`").

Instalator nie pyta ani nie ostrzega, że ta maszyna zacznie renderować Skrzynkę — jedyne pytanie
dotyczy auto-reply.

**Fix:** albo trzeci wariant („client bez sync" / rola pasywna), albo warn przy roli `client` na VPS-ie,
albo świadoma decyzja zapisana w dokumencie zadania, że VPS członka przejmuje sync od laptopa.

### P2-2 · KOD · `scripts/install-vps.sh:1685` — zmiana roli przy re-runie nie rekoncyliuje zaseedowanego joba

Instalator sam kieruje użytkownika na re-run przy każdej porażce („wklej ponownie komendę instalacji",
`$RESUME_ONE_LINER` w `team_os_warn_onboard_failure`), a przy re-runie pytanie o auto-reply zadawane
jest od nowa. Jeśli odpowiedź się zmieni (pierwszy raz Enter → `client`, drugi raz „t" → `agent`),
`onboard.mjs` nadpisuje `state.inbox_role`, a `lib/inbox-seed.js:93-97` z założenia NIGDY nie robi
`UPDATE` (R9, słusznie) — więc stary job „Team OS — inbox sync" zostaje utworzony i WŁĄCZONY, a obok
powstaje włączony „Team OS — asystent auto-reply". Maszyna kończy z obydwoma jobami naraz, czyli
w stanie, który R4 („auto-reply wyłącznie na `agent`") i R5 („sync na `client`") mają się wzajemnie
wykluczać.

Ten sam hazard został zapisany w fazie 1 jako niezaznaczony Operator checklist, ale faza 2 czyni go
osiągalnym normalną ścieżką instalatora, a nie ręcznym `setState`.

**Fix:** warn w `setup_team_os_member` przy wykrytej zmianie roli (odczyt `state.inbox_role` przed
zapisem) + instrukcja wyłączenia joba niepasującego do nowej roli.

### P2-3 · KOD · `setup.mjs:855` — zduplikowany porządek bezpieczeństwa onboardingu (setup.mjs vs onboard.mjs)

`askInboxInvite` powtarza krok po kroku to samo, co `runOnboard` w `scripts/inbox/onboard.mjs`:
parse → probe → guard `.gitignore` → `writeInboxEnv` → zapis roli, ta sama obsługa `unfixable`/`unknown`.
Do tego bliźniaczy `describeGitignoreRefusal` (`setup.mjs:829`) vs `describeGuardRefusal`
(`onboard.mjs:115`), różniący się jednym słowem, oraz bliźniaczy zestaw 7 testów w `setup.test.mjs`
vs `onboard.test.mjs`.

Komentarz uzasadniający duplikację (`setup.mjs:835`: „`onboard.mjs` to CLI, którego moduł ciągnie
`lib/db` (`node:sqlite`) już przy imporcie") jest **nieprawdziwy** — `setup.mjs` sam robi
`require('./lib/db')` w czterech miejscach (307, 665, 703, 826), więc koszt importu jest zerowy.
Naturalnym domem wspólnej sekwencji jest zresztą `invite.mjs`, który oba pliki i tak importują
i który jest właścicielem `GITIGNORE_PATTERN`.

To nie jest „prosta duplikacja" z reguły 11 — to zduplikowany **porządek bezpieczeństwa**, który przy
kolejnej korekcie (np. przeniesieniu odmowy do wnętrza `writeInboxEnv` — otwarty finding P3 z fazy 1)
rozjedzie się w jednym z dwóch miejsc.

**Fix:** `askInboxInvite` = pytanie + `runOnboard({ code, role: 'client', workspace })` + wypisanie
zwróconego `message` + hint restartu (~50 linii i 7 testów mniej).

### P2-4 · TEST · `scripts/install-vps.sh:1643` — obie gałęzie porażki restartu bez asercji

`team_os_restart_after_onboard` ma dwie gałęzie porażki i żadna nie ma asercji:
(a) `systemctl restart` zwraca ≠ 0 → warn z instrukcją ręcznego restartu,
(b) restart się udał, ale `team_os_wait_for_server` nie doczekał się HTTP 200 → warn „joby skrzynki
mogły nie wstać".

Stub testowy (`write_member_stub`, `install-vps.test.sh:2110-2130`) ma `systemctl()` zawsze kończące
się sukcesem i `curl` zawsze zwracające 200, więc wszystkie trzy testy ścieżki członka idą happy-path
(„Skrzynka zespołowa gotowa"). To sedno learned patternu „zrestartowałem ≠ wstał" — regresja
(np. odwrócony warunek `if team_os_wait_for_server`) dawałaby fałszywe „gotowe" przy martwym daemonie
i przeszłaby suitę.

**Fix (tani):** stub już parametryzuje `HTTP_CODE` (dziś nieużywane) — dodać przypadki `HTTP_CODE=000`
oraz `systemctl` zwracające 1.

---

## P3 — opcjonalne

### Bezpieczeństwo i kontrakty

1. **`scripts/install-vps.sh:1587` (KOD)** — token skrzynki (cały kod zaproszenia
   `puls-inbox:<url>#<token>`) przekazywany do CLI jako ARGUMENT wiersza poleceń: `team_os_onboard_cmd`
   skleja `node scripts/inbox/onboard.mjs --code <kod>`, a `team_os_run_onboard` puszcza to przez
   `run_as_claude` → `su - claude -c "<string z tokenem>"`. Na Linuksie `/proc/<pid>/cmdline` jest
   domyślnie czytelne dla KAŻDEGO konta (brak `hidepid`), więc przez cały czas onboardingu token widać
   w `ps aux` (dwa procesy: `su` jako root i `node` jako `claude`), a process accounting / auditd /
   agenci monitoringu potrafią go trwale zapisać. To przeczy modelowi zagrożeń przyjętemu w tym samym
   feature: `invite.mjs` nadaje `.env` tryb 0600 z uzasadnieniem, że 0644 na współdzielonym VPS oddaje
   sekret każdemu kontu — argv jest **słabsze** niż 0644. To jedyne miejsce w `install-vps.sh`, gdzie
   sekret idzie przez argv (hasła Obsidian/gh/tailscale są wpisywane interaktywnie w swoich narzędziach).
   **Fix:** kod na STDIN (`printf '%s\n' "$code" | run_as_claude "cd %q && node scripts/inbox/onboard.mjs --code-stdin …"`).
   Przekazanie przez zmienną środowiskową w stringu `su -c` NIE pomaga (i tak ląduje w argv `su`).

2. **`scripts/inbox/onboard.mjs:154` (KOD)** — `runOnboard` deklaruje w komentarzu kontrakt „NIGDY nie
   rzuca (wzorzec `notify-push`) — zwraca `{ exitCode, message }`", ale `const guard = ensureIgnored(workspace)`
   stoi POZA `try/catch` (owinięte są tylko `writeEnv` i `setRole`). `ensureEnvIgnored` z `invite.mjs`
   robi realne I/O (`fs.readFileSync(<ws>/.gitignore)`, `fs.writeFileSync` przy `needs_fix`) — EACCES
   (plik/katalog roota w vaulcie, montowanie read-only, ENOSPC) rzuca wyjątek, który wychodzi
   z `runOnboard`, wpada do `main().catch` i kończy proces kodem 1. Kod 1 jest w kontrakcie
   ZAREZERWOWANY dla „CLI się wywróciło", więc bash trafia w gałąź `*)` i mówi „Diagnoza: uruchom CLI
   bez argumentów" zamiast właściwego komunikatu o padzie zapisu (`EXIT.WRITE=6`) — rozłączność kodów,
   która jest sednem IU-2.1, przestaje obowiązywać dokładnie w scenariuszu uprawnień, dla którego
   istnieje kod 6. **Fix:** objąć `ensureIgnored` tym samym `try/catch` i mapować na `EXIT.WRITE`
   (z `redactToken(error.message, parsed.token)`); dołożyć test „ensureIgnored rzuca → EXIT.WRITE,
   zero zapisów" (dziś żaden test tego nie pokrywa, bo guard jest zawsze wstrzykiwany jako czysta funkcja).

3. **`setup.mjs:878` (KOD)** — bliźniaczy problem w ścieżce lokalnej: `ensureIgnored(workspace)`
   (a linijkę niżej `writeInboxEnv`, 887) bez `try/catch`, mimo kontraktu zapisanego w tym samym diffie
   („każda porażka → warn i pominięcie; NIGDY nie przerywa setupu"). `askInboxInvite` jest wołane
   w bloku `try { … } finally { rl.close() }` BEZ `catch` (`setup.mjs:964`), więc rzut z `.gitignore`/`.env`
   (EACCES, read-only, ENOSPC) ucieka do `main().catch(…) → process.exit(1)` (`setup.mjs:1037-1039`) —
   cała lokalna instalacja ginie PRZED konfiguracją powiadomień, autostartem, seedem starter-tasków
   i smoke-testem DB. Zero testów: `setup.test.mjs` wstrzykuje wyłącznie guardy zwracające status
   (`ok`/`fixed`/`unfixable`/`unknown`), nigdy rzucający. Odtworzenie:
   `ensureIgnored: () => { throw new Error('EACCES: permission denied, open .gitignore'); }`.
   Zapis roli jest już poprawnie owinięty `try/catch` — brakuje tego samego dla guardu i zapisu `.env`.

4. **`setup.mjs:873` (KOD)** — `probe.reason` drukowany dosłownie do konsoli setupu, podczas gdy
   bliźniacza ścieżka w `scripts/inbox/onboard.mjs:150` przepuszcza tę samą wartość przez
   `redactToken(result.reason, parsed.token)` z uzasadnieniem „część trybów awarii undici osadza
   w komunikacie pełny URL żądania, a token siedzi w ŚCIEŻCE `/inbox/v1/:token/ping`". Jeśli to
   uzasadnienie jest prawdziwe (a projekt przyjmuje je za prawdziwe — jest na nie test
   `onboard.test.mjs:243`), lokalny instalator wypisuje token na terminal użytkownika, do scrollbacku
   i do wszystkiego, co ten output loguje. To **ten sam finding**, który wisi NIEODHACZONY z review
   fazy 1 (`…-zadania.md:145`) — faza 2 modyfikowała tę funkcję i go nie domknęła.
   **Fix:** wyeksportować `redactToken` z `onboard.mjs` (albo przenieść do `invite.mjs`) i użyć w obu miejscach.

5. **`scripts/inbox/onboard.mjs:185` (KOD)** — `result.user` (string sterowany przez HUB, do którego
   wskazuje wklejony kod zaproszenia) wypisywany surowo do outputu instalatora
   (`[ok] Skrzynka zespołowa połączona jako „${result.user}"`), a ten output leci na terminal sesji
   uruchomionej przez `sudo bash` (to samo `setup.mjs:903`). Kod zaproszenia przychodzi z zewnątrz
   i nikt go nie weryfikuje poza formatem, więc hub kontrolowany przez atakującego może zwrócić w polu
   `user` sekwencje ANSI i znaki nowej linii i podszyć się pod komunikaty instalatora (domalować
   fałszywe „[ok] Zweryfikowano…", wyczyścić ekran po warnie o guardzie). Ani `inbox-client.ping`,
   ani `onboard.mjs` nie sprawdzają typu/dziedziny tego pola. **Fix:** przyciąć do rozsądnej długości
   i odfiltrować znaki sterujące (ta sama dziedzina co `UNSAFE_ENV_VALUE` w `invite.mjs`), albo
   wypisywać sam fakt sukcesu bez nazwy.

6. **`scripts/inbox/onboard.mjs:59` (KOD)** — `FLAGS[eq === -1 ? arg : arg.slice(0, eq)]` odpytuje
   zwykły obiekt literalny bez `Object.hasOwn` i bez null-prototype, więc argument o nazwie
   dziedziczonej z `Object.prototype` (`--toString`, `--valueOf`, `--constructor`) daje truthy `key`
   i przechodzi guard `if (!key)`. Zamiast odrzucenia „Nieznany argument" parser cicho konsumuje kolejny
   element `argv` i zapisuje go pod kluczem-funkcją. Łamie deklarowany w planie kontrakt („argumenty
   pozycyjne odrzucane bez echa wartości", `-plan.md:101`) i regułę „waliduj KAŻDY input na granicy";
   test „kod podany pozycyjnie → odrzucone" (`onboard.test.mjs:88`) tej dziury nie łapie, bo używa
   stringa zaczynającego się od `puls-inbox:`.

### Runtime i niezawodność

7. **`scripts/inbox/onboard.mjs:28` (KOD)** — top-level `require('../../lib/db')` ładuje `node:sqlite`
   przy KAŻDYM wywołaniu CLI, także na ścieżkach, które bazy nigdy nie dotykają (BAD_USAGE, BAD_CODE,
   HUB, GITIGNORE, pad `writeEnv`) — jedyny konsument to `setRoleInState` na ścieżce sukcesu. Poza
   zbędnym kosztem startu łamie to udokumentowaną regułę projektu (CLAUDE.md + learned-patterns: guard
   wersji Node PRZED pierwszym top-level importem `node:sqlite`; `lib/runtime-guard.js` nie jest tu
   wołany) i psuje własny kontrakt kodów wyjścia: na Node < 22.13 albo przy padzie `node:sqlite` proces
   umiera w fazie importu, zanim `main()` cokolwiek obsłuży, więc bash dostaje 1 i wpada w gałąź `*)`,
   której instrukcja diagnostyczna wywróci się identycznie. **Fix:** leniwy `require` wewnątrz
   `setRoleInState` + `runtime-guard` jako pierwszy import.

8. **`scripts/inbox/onboard.mjs:112` (KOD)** — `setRoleInState` → `db.setState` pisze do
   `data/claude-cron.db` z DRUGIEGO procesu, podczas gdy demon Pulsa żyje (na VPS-ie restart następuje
   dopiero PO tym zapisie, więc heartbeat co 60 s i zapisy runów lecą równolegle). `node:sqlite` nie
   ustawia `busy_timeout` — zweryfikowane empirycznie: przy zajętym write-locku `DatabaseSync` rzuca
   `ERR_SQLITE_ERROR` natychmiast, po 0 ms, bez czekania. Kolizja → `EXIT.WRITE` mimo poprawnie
   zapisanego `.env` → instalator NIE restartuje serwisu i pokazuje komunikat o uprawnieniach, a rola
   maszyny zostaje nieustawiona (agent cicho degraduje się do klienta aż do ponownego uruchomienia
   instalatora). Okno jest wąskie (`migrate()` na istniejącej bazie ≈ 0 ms i nie bierze write-locka;
   ryzykowny jest sam UPSERT), stąd P3, ale fix jest jednoliniowy: `PRAGMA busy_timeout` w `lib/db.js`
   `getDb()` — korzysta z niego też `setup.mjs` (`persistInboxRole`/`persistNotifySettings`) na maszynie
   z żywym demonem launchd.

9. **`scripts/inbox/onboard.mjs:207` (KOD)** — entry point robi `console.log(message)` i natychmiast
   `process.exit(exitCode)`. Gdy stdout instalatora jest pipem (typowe: `curl … | bash 2>&1 | tee install.log`),
   zapis na pipe jest w Node asynchroniczny i `process.exit` potrafi uciąć ostatnią linię — a komunikaty
   bash-a odsyłają wprost do niej („szczegóły w komunikacie powyżej"), więc operator zostaje z samym
   kodem wyjścia. **Fix:** `process.exitCode = exitCode` i naturalne wyjście procesu.

10. **`scripts/install-vps.sh:1629` (KOD)** — `EXIT.BAD_USAGE` zlepia dwie różne przyczyny:
    „instalator zawołał CLI źle" (`parseArgs`) oraz „katalog workspace nie istnieje" (`onboard.mjs:198`),
    a komunikat naprawczy w bashu opisuje wyłącznie tę pierwszą („to niezgodność wersji. Zaktualizuj
    kod: `git pull`"). Przy nieistniejącym vaulcie (nieukończony sync Obsidiana, ręcznie zmieniony
    `WORKSPACE`) operator dostanie instrukcję prowadzącą w złą stronę; ratuje go tylko to, że linia CLI
    powyżej mówi prawdę. Rozłączność kodów jest deklarowanym celem tego kontraktu — brakujący kod
    „środowisko" (albo doprecyzowanie warna) domknąłby go.

### Prostota (YAGNI / defensive code)

11. **`scripts/inbox/onboard.mjs:75` (KOD)** — fallback `env.CLAUDE_CRON_WORKSPACE` w `parseArgs` nie ma
    konsumenta. Jedyny wołający (`team_os_onboard_cmd`, `install-vps.sh:1585`) ZAWSZE przekazuje
    `--workspace %q`, a `CLAUDE_CRON_WORKSPACE` jest ustawiane wyłącznie w unicie systemd
    (`install-vps.sh:1241`), nie w środowisku `su - claude` — ścieżka jest w praktyce nieosiągalna.
    Utrzymuje osobną gałąź, osobny komunikat błędu i osobny test. **Prościej:** `--workspace` obowiązkowy.

12. **`scripts/inbox/onboard.mjs:168` (KOD)** — defensive code na scenariusz, który nie może wystąpić
    (anty-pattern #10): `redactToken(error.message, parsed.token)` w gałęziach WRITE. Do `writeEnv`
    token trafia jako wartość, a `upsertDotenvLine` z założenia nigdy nie umieszcza wartości
    w komunikacie (`invite.mjs:95-102`), błędy `fs` niosą wyłącznie ścieżkę; do `setRole`
    (`onboard.mjs:176`) token w ogóle nie jest przekazywany — argumentem jest rola. Redakcja ma realne
    uzasadnienie tylko na ścieżce probe. Ten sam nadmiar w helperze (`onboard.mjs:95`):
    `typeof text !== 'string' ? String(text ?? '')` broni przed nie-stringiem, którego żaden wołający
    nie produkuje.

13. **`lib/inbox-seed.js:104` (KOD)** — eksport bez konsumenta: `ROLE_AGENT` dodany do `module.exports`,
    ale żaden pisarz go nie używa — `onboard.mjs` importuje `ROLE_STATE_KEY` + `isValidRole`,
    `setup.mjs` `ROLE_CLIENT` + `ROLE_STATE_KEY` (grep: jedyne wystąpienia `ROLE_AGENT` to definicja,
    `isValidRole` i seed w tym samym pliku). Uzasadnienie w komentarzu („pisarz mieszka gdzie indziej")
    pokrywa `ROLE_CLIENT` i `isValidRole`; `ROLE_AGENT` rozszerza publiczną powierzchnię modułu na zapas.

### Pokrycie testowe

14. **`scripts/install-vps.test.sh:2086` (TEST)** — brak testu szwu bash↔Node dla kontraktu kodów wyjścia.
    `TEAM_OS_EXIT_BAD_USAGE/BAD_CODE/HUB/GITIGNORE/WRITE` (`install-vps.sh:65-70`) to ręczna kopia `EXIT`
    z `scripts/inbox/onboard.mjs:36-43`, a obie strony testowane są w izolacji: `onboard.test.mjs:303`
    sprawdza tylko rozłączność wartości i brak 1 (nie same liczby), a testy bashowe wstrzykują literały
    `CLI_RC=3/5/1` bez odniesienia do modułu Node. Renumeracja `EXIT` (np. HUB 4→7) przechodzi obie
    suity na zielono, a instalator dobierze zły komunikat naprawczy — dokładnie wzorzec „założenie
    międzymodułowe = test szwu" z `.claude/rules/learned-patterns.md`. Weryfikacja ręczna potwierdza,
    że DZIŚ szew jest spójny (realne wywołanie CLI: brak argumentów → 2, śmieciowy kod → 3, zero
    zapisów), więc to luka regresyjna, nie defekt. **Fix:** test `node:test` asertujący zgodność `EXIT`
    z wartościami `TEAM_OS_EXIT_*` wygrepowanymi z `install-vps.sh`.

15. **`scripts/install-vps.sh:1678` (TEST)** — ostrzeżenie o pustym vaulcie (`team_os_vault_looks_empty`)
    nie ma żadnej asercji pozytywnej — harness sprawdza tylko, że przy vaulcie z notatką warna NIE ma
    (test ścieżki admina), a sama funkcja nie ma unit testu (katalog pusty / katalog z notatką /
    katalog nieistniejący → sonda `find -maxdepth 2`). To jedyne zabezpieczenie przed świadomym
    włączeniem agenta na maszynie bez wiedzy (auto-reply odpowie `NO_ANSWER` na wszystko), a jest
    w pełni testowalne headless w istniejącym sandboxie — odchylenie samo zostało odnotowane
    w `zadania.md`, ale nie domknięte.

16. **`scripts/install-vps.test.sh:2196` (TEST)** — kombinacja „członek wkleja kod zaproszenia
    I zgadza się na auto-reply → rola `agent`", czyli główny scenariusz produktowy fazy (VPS członka
    odpowiadający zespołowi, R1+R4), nie ma testu. Rolę `agent` pokrywa wyłącznie ścieżka admina
    (kod z `TEAM_OS_INVITE_CODE`, pytanie o kod w ogóle nie pada), rolę `client` — ścieżka członka,
    w której na pytanie o auto-reply odpowiada przypadkowo kod zaproszenia. IU-2.2 tłumaczy to
    ograniczeniem harnessu („`ask_tty` czyta zawsze pierwszą linię `TTY_DEVICE`"), ale ograniczenie
    jest usuwalne tym samym wzorcem DI, którym stubowane są `run_as_claude`/`systemctl`: wystarczy
    zastubować `ask_tty` kolejką odpowiedzi.

17. **`scripts/install-vps.test.sh:2226` (TEST)** — `team_os_warn_onboard_failure` ma pięć nazwanych
    gałęzi + default, a testy pokrywają trzy: 3 (BAD_CODE), 5 (GITIGNORE) i 1 (default). Bez asercji
    zostają 4 (HUB), 6 (WRITE) i 2 (BAD_USAGE) — każda niesie inną instrukcję i inne interpolacje
    (`$RESUME_ONE_LINER`, `$CLAUDE_USER`, `$INSTALL_DIR`, `$WORKSPACE`). Literówka w nazwie zmiennej
    albo warn z pustą komendą wznowienia przechodzi suitę niezauważona.

18. **`scripts/install-vps.test.sh:2089` (TEST)** — testy nie asertują ŚCIEŻKI wywoływanego skryptu:
    literał `scripts/inbox/onboard.mjs` nie występuje ani razu w `scripts/install-vps.test.sh`
    (grep = 0 trafień), choć atrapa `node() { printf 'ARG[%s]\n' "$@"; }` drukuje go jako pierwszy
    argument — asercja kosztowałaby jedną linię. Przeniesienie/rename CLI albo literówka
    w `team_os_onboard_cmd` przechodzi obie suity, a na VPS-ie kończy się `Cannot find module` →
    exit 1 → generyczny warn bez wskazania przyczyny.

> Findingi 2 i 3 oraz ich warianty (`onboard.mjs:154` × 2, `setup.mjs:878` × 2) zostały zgłoszone przez
> dwóch niezależnych reviewerów i przeszły verify osobno — opisują ten sam defekt z dwóch perspektyw
> (kontrakt kodów wyjścia vs kontrakt „nigdy nie przerywa"). Fix jest wspólny.

---

## OPERATOR — poza zakresem fixu (warunki środowiskowe)

### O-1 · `scripts/install-vps.sh:1663` — probe admina uderza w świeżo włączony Funnel

Ścieżka admina: `setup_team_os_member` woła `onboard.mjs` kodem `TEAM_OS_INVITE_CODE` utworzonym chwilę
wcześniej, a probe (`probeInviteCode` → `inbox-client.ping`) uderza PUBLICZNYM URL-em Funnela, który
w tym samym runie instalatora dopiero co włączono. Wcześniejsza weryfikacja Funnela to wyłącznie lokalny
`tailscale funnel status` (stan konfiguracji, nie stan serwowania) — pierwszy publiczny handshake TLS /
wydanie certyfikatu potrafi nie być gotowe. Wtedy probe pada po 15 s × 2 próby → `EXIT.HUB` → maszyna
admina NIE zostaje podłączona do własnej skrzynki, a komunikat sugeruje mylnie „hub nie działa albo kod
został unieważniony".

Weryfikacja niewykonalna headless: wymaga realnego VPS-a ze świeżo włączonym Tailscale Funnel.
**Do sprawdzenia przy deployu:** czy admin przechodzi probe za pierwszym razem; jeśli nie — retry/backoff
w tej gałęzi albo warm-up Funnela przed `setup_team_os_hub`.

### O-2 · `…-zadania.md` — Operator checklist IU-2.2 (4 pozycje) nieweryfikowalna headless

Wymaga świeżego VPS-a z realnym systemd, Tailscale Funnel i żywym hubem: (1) pełna instalacja + „N"
na hub + wklejenie kodu zaproszenia → skrzynka działa bez dotykania `.env`, (2) zgoda na auto-reply →
po restarcie job auto-reply istnieje i jest włączony, joba sync nie ma, (3) odmowa → job auto-reply nie
powstaje, (4) instalacja admina → maszyna skonfigurowana kodem z `TEAM_OS_INVITE_CODE` bez ponownego
pytania. **Rekomendacja:** dołożyć piąty krok pokrywający re-run ze zmienioną odpowiedzią o auto-reply
(wypisać `GET /api/jobs`, ręcznie wyłączyć job niepasujący do roli) — to warunek zamknięcia P2-2.

---

## Bookkeeping checkboxów `Weryfikacja:`

Faza 2 miała **8** pozycji `Weryfikacja:` (IU-2.1 × 3, IU-2.2 × 3, IU-2.3 × 2), wszystkie zapisane jako
gołe bullety bez checkboxa. Wszystkie osiem to CLI/Grep — wykonalne headless, więc uruchomione.
Zero browserowych (tester E2E nie odpalał się w tej fazie: brak warstwy UI, 0 checkboxów wymagających
przeglądarki).

| IU | Pozycja | Klasyfikacja | Wynik | Stan |
|---|---|---|---|---|
| IU-2.1 | `node --test scripts/inbox/onboard.test.mjs` | CLI | exit 0, `# tests 23 / # pass 23 / # fail 0` | `[x]` |
| IU-2.1 | `npm test` (pełna suita) | CLI | exit 0, `# tests 579 / # pass 579 / # fail 0` | `[x]` |
| IU-2.1 | Grep: brak logowania `INBOX_TOKEN` / kodu zaproszenia w `onboard.mjs` | Grep | `grep -nE "console\.(log\|error\|warn).*(INBOX_TOKEN\|token\|code)"` → 0 trafień | `[x]` |
| IU-2.2 | `bash scripts/install-vps.test.sh` (0 FAIL, licznik wzrósł) | CLI | exit 0, `Wynik: 119 PASS / 119 total` (przed zmianą 110) | `[x]` |
| IU-2.2 | `npm test` (pełna suita) | CLI | exit 0, 579/579 | `[x]` |
| IU-2.2 | Grep: brak gołego `read ` w nowej funkcji | Grep | `grep -nE "^\s*read " scripts/install-vps.sh` → 0 trafień w całym pliku; 19 wywołań `ask_tty` | `[x]` |
| IU-2.3 | `node --test setup.test.mjs` | CLI | exit 0, `# tests 78 / # pass 78 / # fail 0` | `[x]` |
| IU-2.3 | `npm test` (pełna suita) | CLI | exit 0, 579/579 | `[x]` |

**Podsumowanie:** CLI 6 PASS / 0 FAIL, Grep 2 PASS / 0 FAIL, Manual 0, browserowych 0.
Bookkeeping nie wygenerował żadnego dodatkowego findingu.

**Zmiana strukturalna w pliku zadań:** blok `**Operator checklist:**` z IU-2.2 (4 gołe `- [ ]` bez
prefiksu) przeniesiony do sekcji `## Operator checklist faza 2` w formacie
`- [ ] Operator: … — Operator action: …` — bez prefiksu `Operator:` bootstrap/planner liczyłby te
pozycje jako niedokończone zadania fazy i blokował jej domknięcie, mimo że są to warunki środowiskowe,
a nie praca do wykonania.

---

## Przebieg review

| Etap | Wartosc |
|---|---|
| Pliki w fazie (z tego kodu) | 11 (7) |
| Flagi warstw | ui=false dane=true typowanie=false nowyModul=true |
| Browserowe checkboxy `Weryfikacja:` | 0 |
| Reviewerzy aktywni | security, performance, architecture, spec-compliance, simplicity, test-coverage |
| Reviewerzy pominieci | typescript (domena nieobecna w mapie zmian fazy); e2e (brak warstwy UI i zero browserowych checkboxow Weryfikacja: (0)) |
| Findingi: znalezione -> dedup JS -> dedup semantyczny | 44 -> 44 -> 27 |
| Adversarial verify: weryfikowane / obalone / bez glosow | 10 / 1 / 0 |
