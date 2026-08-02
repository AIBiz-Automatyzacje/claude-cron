# Review — Faza 2 (Instalator, Unit 7)

**Zadanie:** `docs/active/rownolegle-joby` · **Faza:** 2 — Instalator (Unit 7: konfigurowalny katalog instalacji + wykrycie zajętego portu)
**Data:** 2026-07-30
**Pliki objęte review:** `install.sh`, `install.ps1`, `setup.mjs`, `install.test.sh`, `install.ps1.Tests.ps1`, `setup.test.mjs`

## Severity gate

⛔ **BLOKUJE** — znaleziono **1 × P1** (blokujący), **6 × P2**, **11 × P3** (typy KOD/TEST) oraz **2 findingi OPERATOR** (niewykonalne headless, poza listą fix).

| Kategoria | P1 | P2 | P3 |
|---|---|---|---|
| KOD | 1 | 5 | 7 |
| TEST | 0 | 1 | 4 |
| E2E | 0 | 0 | 0 |
| **Razem (liczone do gate'u)** | **1** | **6** | **11** |
| OPERATOR (osobno, nie liczone do gate'u) | — | 2 | — |

**Wniosek:** faza wprowadziła realną regresję bezpieczeństwa danych użytkownika — katalog instalacji stał się **wolnym wejściem usera**, a destrukcyjne ścieżki (`mv` do tmp kasowanego przez `trap`, `Stop-Process -Force` po substringu) nie dostały żadnego guardu. To jest wspólny mianownik P1 i dwóch P2: zmieniono źródło wartości, nie zmieniając założeń kodu, który tę wartość konsumuje.

---

## Findings

### 🔴 P1 — blokujące

#### 1. `install.sh:204` (KOD) — bezwarunkowe `mv` katalogu usera do tmp kasowanego przez `trap … rm -rf`

Katalog instalacji jest teraz WOLNĄ odpowiedzią użytkownika, a `install_fresh_repo` nadal bezwarunkowo robi `mv "$INSTALL_DIR" "$trash"` do katalogu tmp, który `trap 'rm -rf "$tmp_dir"' EXIT` kasuje na końcu przebiegu (`install.ps1:185` + `finally { Remove-Item -Recurse -Force $tmpDir }` — identycznie). Zero guardu, zero potwierdzenia, zero sprawdzenia CZY to w ogóle instalacja Pulsa. `resolve_install_dir` jawnie wspiera `~` → `$HOME` (case `"~") answer="$HOME"`, `install.sh:145`), więc odpowiedź `~`, `~/Documents`, `/Users/x/Projekty` albo literówka we wklejonej ścieżce z Findera powoduje: przeniesienie CAŁEGO tego katalogu do `/var/folders/...` i trwałe `rm -rf` przy wyjściu ze skryptu. `preserve_existing_dirs` ratuje wyłącznie `data/` i `.node/` — reszta ginie bez śladu.

Łamie regułę projektu „Nie uruchamiaj `rm -rf` bez explicit user confirmation" i learned-pattern „`rm -rf "${var:?}/..."` zawsze z guardem".

**Naprawa:** PRZED destrukcyjnym `mv` wymagać, żeby cel nie istniał / był pusty / był rozpoznaną instalacją Pulsa (obecność `server.js` + `data/claude-cron.db` albo `package.json` z `name=claude-cron`); w przeciwnym razie jawne potwierdzenie z `$INSTALL_TTY` albo `fail`. To samo w `Install-FreshRepo` (`install.ps1:172-190`). Dodatkowo odrzucać `$HOME` i korzeń dysku jako katalog instalacji.

---

### 🟠 P2 — ważne

#### 2. `setup.mjs:504` (KOD) — bind-test tylko na `0.0.0.0` nie wykrywa serwera na `127.0.0.1`

`isPortBindable` robi bind-test WYŁĄCZNIE na `0.0.0.0`, a `classifyPortState` na `bindable:true` zwraca FREE bez odpytania `/api/status`. Na macOS (SO_REUSEADDR, semantyka BSD) bind na wildcard UDAJE SIĘ, gdy obcy proces trzyma `127.0.0.1:<port>` — zweryfikowane na tej maszynie: uruchomiony `http.createServer().listen(port,'127.0.0.1')`, a `probeDashboardPort(port)` zwrócił `free`. Skutek: kolizja z typowym dev-serwerem słuchającym tylko na loopbacku jest NIEWYKRYWALNA, setup zapisuje `CLAUDE_CRON_PORT`, wypala port w hooku autostartu i startuje serwer, po czym `http://localhost:<port>` trafia do cudzej aplikacji (bardziej szczegółowy bind wygrywa) — dokładnie scenariusz „cichy sukces z martwym dashboardem", który Unit 7 miał zamknąć (user dostaje tylko miękki warn z `startServerAndOpen`).

**Naprawa:** bindować w probie zarówno `0.0.0.0`, jak i `127.0.0.1` (zajęty = którykolwiek bind pada) i dopiero wtedy klasyfikować przez `/api/status`.

#### 3. `install.ps1:152` (KOD) — `Stop-PulsProcesses` matchuje `CommandLine` substringiem bez granicy ścieżki

`Stop-PulsProcesses` ubija każdy `node.exe`, którego `CommandLine` ZAWIERA (`Contains`, zwykły substring bez granicy ścieżki) katalog instalacji — a ten katalog jest od tej fazy dowolną odpowiedzią użytkownika. Odpowiedź `C:\Users\<user>` albo korzeń dysku sprawia, że filtr matchuje praktycznie każdy proces node tego użytkownika (Claude Code, dev-serwery, inne demony) i wszystkie zostają zabite `Stop-Process -Force` bez pytania. Nawet przy normalnej ścieżce substring matchuje rodzeństwo: `C:\puls` łapie proces z `C:\puls-backup`. Komentarz w kodzie obiecuje „NIE zabijamy cudzych procesow node" — ta gwarancja przestała obowiązywać, gdy `$InstallDir` stał się wejściem usera.

**Naprawa:** porównanie z granicą ścieżki (`$Dir.TrimEnd('\') + '\'`, po normalizacji `[System.IO.Path]::GetFullPath`) plus odmowa działania, gdy `$InstallDir` to katalog domowy albo korzeń dysku (ten sam guard co dla P1).

#### 4. `setup.mjs:111` (KOD) — gałąź `PORT_STATE.OURS` cicho adoptuje CUDZĄ instalację Pulsa

Gałąź `PORT_STATE.OURS` zakłada JEDNĄ instalację na maszynie, a ta sama faza właśnie dodała konfigurowalny katalog instalacji (komentarze `install.sh:29`/`install.ps1:28` wprost wymieniają „druga instancja obok pierwszej"). `/api/status` nie zdradza katalogu instalacji, więc CUDZA (stara/inna) instancja Pulsa jest nieodróżnialna od re-runu tej samej. Zwracana flaga `reused` jest w `main()` wyrzucana (`).port`), więc nic z tej wiedzy nie korzysta.

Failure scenario: user instaluje drugą instancję w `~/puls-test` (albo re-runuje instalator na macOS, gdzie — w przeciwieństwie do `install.ps1` ze `Stop-PulsProcesses` — `install.sh` NIE ubija starego demona; checkbox „Ubijanie procesów filtrem po ścieżce instalacji" odhaczono mając tylko implementację Windows). Port 7777 trzyma stary proces → OURS → `[ok] to re-run, nie kolizja` → `startServerAndOpen` pinguje, widzi „żyje", NIE spawnuje nowego serwera → setup pisze „Gotowe!" i otwiera dashboard STAREJ instalacji ze starym kodem; nowa instalacja nie wstaje nigdy, a hook autostartu wskazuje nowy katalog na tym samym porcie (kolizja przy następnym boocie).

**Naprawa (minimalna):** wykorzystać `reused` — gdy `reused === true`, porównać instalację (np. dodać `repo_dir`/`install_dir` do `/api/status`) albo zapytać usera „czy to ta sama instalacja?" zamiast milcząco adoptować cudzy proces.

#### 5. `setup.mjs:525` (KOD) — `resolveInitialPort` czyta wyłącznie `process.env`, ignorując wartość utrwaloną

`resolveInitialPort` czyta port startowy WYŁĄCZNIE z `process.env.CLAUDE_CRON_PORT`, choć setup sam zapisuje tę wartość do RC/rejestru (`persistEnvVar`, `setup.mjs:1079`) — a learned-pattern 2026-07-07 mówi wprost, że env żyjącego terminala bywa nieświeże.

Scenariusz awarii: poprzedni setup wybrał 8080 (7777 zajęte przez obcy program) i zapisał to w `~/.zshrc`; user re-runuje instalator w starym terminalu bez `source`, obcy program zdążył zniknąć → `resolveInitialPort()` zwraca 7777, `probeDashboardPort(7777)` mówi FREE, setup nadpisuje `CLAUDE_CRON_PORT` na 7777, przepisuje hook i odpala DRUGI serwer, podczas gdy stary daemon dalej słucha na 8080. Dwa demony na tej samej bazie SQLite = dwa schedulery i podwójne odpalanie jobów (wprost sprzeczne z celem tego sprintu), a klasyfikacja „OURS = re-run" nigdy się nie uruchamia, bo pytamy o zły port.

**Naprawa:** gdy `process.env.CLAUDE_CRON_PORT` jest puste, odczytaj wartość utrwaloną (linia z RC — jest już `upsertEnvLine`, albo HKCU na Windowsie) zanim spadniesz do `DEFAULT_DASHBOARD_PORT`.

#### 6. `setup.mjs:517` (KOD) — ścieżka OURS na macOS zostawia stary proces ze STARYM kodem

Ścieżka OURS nie ma żadnej akcji domykającej na macOS: `resolveDashboardPort` zwraca `{reused:true}`, po czym `startServerAndOpen` (`setup.mjs:1156`) widzi żywy ping i nie spawnuje serwera. Tymczasem `install_fresh_repo` (`install.sh:204`) właśnie podmienił katalog instalacji — stary proces biegnie dalej ze STAREGO kodu (na Unixie przeniesienie otwartego katalogu jest legalne), a setup kończy się „🕹️ Gotowe!". Efekt: po aktualizacji user działa na starej wersji, a jedynym sygnałem jest jej brak. `install.ps1` ma na to `Stop-PulsProcesses -Dir $InstallDir` (filtr po ścieżce instalacji, `install.ps1:148`) — `install.sh` nie ma odpowiednika, mimo że plan Unitu 7 wprost odwołuje się do tego wzorca.

**Naprawa:** w `install.sh` dodać `stop_puls_processes <dir>` (pgrep/ps filtrowane po ścieżce instalacji, nigdy po nazwie `node`) wołane w `install_fresh_repo` przed `mv`, plus test analogiczny do `Test-StopPulsIgnoresForeignNode` (obcy proces node nie może zginąć).

#### 7. `install.test.sh:110` (TEST) — dziewięć nowych testów pokrywa wyłącznie ścieżki szczęśliwe

Testy 5-13 pokrywają sanityzację stringa, tyldę, ścieżkę względną, env-override, brak tty i sam Enter. Zero scenariuszy „zła odpowiedź":

- (a) odpowiedź wskazuje istniejący NIEPUSTY katalog niebędący instalacją Pulsa (patrz P1 — dziś taki test by **przeszedł**, bo kod bez mrugnięcia kasuje cudzy katalog),
- (b) odpowiedź `~` / `$HOME`,
- (c) odpowiedź wskazuje istniejący PLIK (wtedy `mv fresh_dir file` pada pod `set -e` z komunikatem systemowym, nie instalatora),
- (d) katalog, którego rodzic jest niezapisywalny.

To samo w `install.ps1.Tests.ps1` (testy 6-8 sprawdzają tylko `Resolve-InstallDir` na poprawnych wejściach).

**Akcja:** dodać do `install.test.sh` test asertujący, że `ask_install_dir`/guard ODRZUCA katalog z obcą zawartością (np. sandbox z plikiem `moje-dane.txt`) i że po odrzuceniu ten plik nadal istnieje po `install_fresh_repo`; symetrycznie `Test-RejectsForeignInstallDir` w `install.ps1.Tests.ps1`.

---

### 🟡 P3 — drobne (nie blokują gate'u)

1. **`setup.mjs:476` (KOD)** — `fetchStatusPayload` buforuje ciało odpowiedzi bez ŻADNEGO limitu (`body += chunk`) i bez globalnego deadline'u; `{ timeout: 1000 }` w `http.get` to timeout BEZCZYNNOŚCI gniazda, więc proces sączący po bajcie co 900 ms nigdy go nie odpali. Funkcja odpytuje port zajęty przez DOWOLNY obcy proces (granica zaufania), wołana do 5× w `resolveDashboardPort` i do 21× w `pingDashboard`/`waitForDashboard`. Fix jak w konwencji repo (`readTextBody`/`inbox-api` cap 64 KB): licz `body.length`, po przekroczeniu `req.destroy()` + `resolve(null)`, oraz twardy `AbortSignal.timeout`/timer na całe żądanie.
2. **`setup.mjs:506` (KOD)** — `isPortBindable` traktuje KAŻDY błąd bindu jednakowo (`probe.once('error', () => resolve(false))`), więc port uprzywilejowany (<1024) — który `parsePortAnswer` przepuszcza od 1 — daje EACCES i zostaje sklasyfikowany jako FOREIGN z komunikatem „Port 80 zajmuje inny program (to nie jest Puls)" i podpowiedzią `lsof`, mimo że portu nikt nie zajmuje. Fix: rozróżnić `error.code` (`EADDRINUSE` vs `EACCES`) albo zawęzić `parsePortAnswer` do 1024-65535 w ścieżce pytania.
3. **`install.sh:101` (KOD)** — `resolve_install_dir` usuwa WSZYSTKIE wystąpienia `"`, `'` i `\`, nie tylko z brzegów. `/Users/x/Kacper's puls` → `/Users/x/Kacpers puls` i instalacja ląduje w złym miejscu. Windowsowy `Resolve-InstallDir` (`install.ps1:62`) trimuje tylko brzegi — rozjazd parytetu, którego testy nie łapią (sprawdzają wyłącznie przypadek ze spacją). Fix: zdejmuj cudzysłowy tylko z początku/końca, backslashe traktuj jako escape.
4. **`setup.mjs:619` (KOD)** — nazwa pliku hooka `'claude-cron-autostart.js'` zaszyta w DWÓCH miejscach (`warnIfHookPortStale` i `writeHook`, `setup.mjs:631`) mimo istnienia stałej `HOOK_MARKER`. Rozjazd literałów nie wywoła błędu — `fs.existsSync` zwróci false i ostrzeżenie o starym porcie zniknie po cichu. Fix: `function hookFilePath(workspace)` użyta w obu.
5. **`setup.mjs:608` (KOD)** — `buildStaleHookPortWarning` broni się przed `typeof hookSource !== 'string'`, choć jedyny wywołujący podaje wynik `fs.readFileSync(..., 'utf-8')`. Defensive code na scenariusz, który nie może wystąpić.
6. **`setup.mjs:221` (KOD)** — domyślna wartość `port = DEFAULT_DASHBOARD_PORT` w `buildHookSource` nie ma wywołującego w produkcji; utrzymuje ją wyłącznie test kształtu API (`setup.test.mjs:1044`), a przy okazji maskowałaby zgubiony argument. Fix: parametr wymagany + usunięcie tego jednego testu (znika testowana funkcjonalność).
7. **`setup.mjs:116` (KOD)** — `parsePortAnswer(await askPort(port), null)` podaje jawnie wartość identyczną z domyślną (`fallback = null`, `setup.mjs:63`); domyślna wartość parametru nie jest nigdzie wykorzystywana. Fix: usuń argument albo domyślną wartość.
8. **`setup.test.mjs:1023` (TEST)** — test „resolveDashboardPort: same zajęte porty → rzuca po wyczerpaniu prób" asertuje `asks > 0 && asks < 50` zamiast dokładnej liczby prób; zmiana `PORT_RESOLVE_ATTEMPTS` z 5 na 1 albo 40 przejdzie bez śladu. Fix: wyeksportować stałą i `assert.equal(asks, PORT_RESOLVE_ATTEMPTS)`.
9. **`setup.mjs:618` (TEST)** — `warnIfHookPortStale` (I/O shell) bez pokrycia; testy dotykają tylko czystego `buildStaleHookPortWarning`. To jedyny mechanizm broniący przed rozjazdem „dashboard vs autostart" na ścieżce odmowy reinstalacji hooka (`setup.mjs:1107`). Fix: eksport z wstrzykiwanym `log` + dwa testy na tmp-workspace.
10. **`install.ps1.Tests.ps1:145` (TEST)** — testy 6-8 pokrywają wyłącznie czyste `Resolve-InstallDir` i `Install-FreshRepo`; `Read-InstallDir` (`install.ps1:79`) — faktyczna ścieżka decyzyjna — nie ma testu, mimo że bash ma symetryczne testy 10 i 12. Fix: `Test-ReadInstallDirRespectsEnv` + `Test-ReadInstallDirFallsBackWithoutInput`.
11. **`install.test.sh:557` (TEST)** — testy `ask_install_dir` mutują globalne `INSTALL_DIR_EXPLICIT` i go nie przywracają (test 10 zostawia 1, testy 11-13 ustawiają 0), przywracają za to `INSTALL_DIR` i `INSTALL_TTY`. Suita przechodzi tylko dzięki kolejności wywołań na dole pliku. Fix: przywracanie `INSTALL_DIR_EXPLICIT=0` w każdym z testów 10-13 (albo wspólny helper setup/teardown).

---

## Findingi OPERATOR (niewykonalne headless — poza listą fix)

| Plik | Opis |
|---|---|
| `install.ps1.Tests.ps1:145` | Trzy nowe testy Pester (6-8: pusta odpowiedź → default, sanityzacja ścieżki z Explorera, instalacja w niestandardowym katalogu) NIE zostały uruchomione — na maszynie deweloperskiej (macOS) nie ma `pwsh`/`powershell`. Windowsowa ścieżka `Read-InstallDir`/`Resolve-InstallDir` oraz interakcja wybranego katalogu z blokadami plików i `Stop-PulsProcesses` pozostają niezweryfikowane wykonaniem. |
| `install.sh:134` | Checkbox „Weryfikacja: przebieg przez prawdziwy pipe (`curl … \| bash` z env-override źródła)" pozostaje nieodhaczony, a to jedyny przebieg sprawdzający realne `/dev/tty` — suita podstawia za nie plik przez `INSTALL_TTY`, więc nie pokrywa ani `has_tty` na prawdziwym terminalu kontrolującym, ani `exec … < /dev/tty` w `handoff_to_setup`, ani pytania o port zadawanego z `setup.mjs` przez readline na stdin przekazanym z instalatora. Learned-pattern: „Testuj ZAWSZE przez prawdziwy pipe, nie lokalne `bash install.sh`". |

---

## Bookkeeping checkboxów Weryfikacja:

- Odznaczone automatycznie (CLI/grep): **2**
- Odznaczone na podstawie Agent 5 E2E: **0** (tester E2E nie odpalił — routing pominął: brak warstwy UI, 0 browserowych checkboxów)
- Pozostawione dla operatora (Manual): **1**
- Niejasne (P3): **0**
- Failujące (P2): **0**

### Szczegóły

- [x] CLI: `bash install.test.sh` przechodzi → PASS (komenda: `bash install.test.sh`, exit 0, `13 PASS / 13 total`)
- [x] CLI: `node --test setup.test.mjs` przechodzi → PASS (komenda: `node --test setup.test.mjs`, exit 0, `# pass 102 / # fail 0`)
- [ ] Manual: `przebieg przez prawdziwy pipe (curl … | bash z env-override źródła)` — wymaga operatora (przeniesione do „Operator checklist faza 2"; zarejestrowane jako finding OPERATOR `install.sh:134`)

Uwaga: pozycja `- [ ] Operator: przebieg instalatora na Windowsie` z Unit 7 nie jest checkboxem `Weryfikacja:` — przeniesiona do „Operator checklist faza 2" bez zmiany stanu.

---

## Przebieg review

| Etap | Wartosc |
|---|---|
| Pliki w fazie (z tego kodu) | 9 (4) |
| Flagi warstw | ui=false dane=true typowanie=false nowyModul=true |
| Browserowe checkboxy `Weryfikacja:` | 0 |
| Reviewerzy aktywni | security, performance, architecture, spec-compliance, simplicity, test-coverage |
| Reviewerzy pominieci | typescript (domena nieobecna w mapie zmian fazy); e2e (brak warstwy UI i zero browserowych checkboxow Weryfikacja: (0)) |
| Findingi: znalezione -> dedup JS -> dedup semantyczny | 54 -> 52 -> 22 |
| Adversarial verify: weryfikowane / obalone / bez glosow | 12 / 2 / 0 |
