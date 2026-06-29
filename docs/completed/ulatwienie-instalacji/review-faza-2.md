# Code Review — Faza 2: Smart setup lokalny (Mac/Win) + sprzątanie

**Data:** 2026-06-29
**Branch:** `feature/ulatwienie-instalacji`
**Zakres:** Unit 4 (portable Node bootstrap `install.sh`/`install.ps1`), Unit 5 (wspólny `setup.mjs`), Unit 6 (sprzątanie skryptów + uninstall), Unit 7 (README)

## Severity gate

**BLOKUJE** — 1× P1, 4× P2, wiele P3 (+ findingi OPERATOR). Jeden bloker (regresja funkcjonalna VPS/env) musi zostać naprawiony przed domknięciem fazy.

## Statystyki

| Severity | KOD | TEST | E2E | OPERATOR | Razem |
|---|---|---|---|---|---|
| P1 | 1 | 0 | 0 | — | 1 |
| P2 | 2 | 2 | 0 | — | 4 |
| P3 | 8 | 4 | 0 | 7 | 19 |

- Bookkeeping Weryfikacja: 11 checkboxów Fazy 2 (CLI/grep) — 10 PASS, 1 FAIL (`grep -rn install-macos.sh\|install-windows.ps1` nie zwraca pusto — referencje w docs/historycznych; szczegóły niżej).
- E2E: 0 passed / 0 failed / 0 skipped (faza dotyczy bootstrapu/instalatora/CLI — brak scenariuszy przeglądarkowych).

---

## Findings (P1 → P2 → P3)

### P1 — blocker

**[P1][KOD] setup.mjs:245-259 (main/ask) — UNDER-IMPLEMENTATION / regresja funkcjonalna vs stary setup.sh**
Stary `setup.sh` miał KROK 1/4 „Połączenie z VPS" (ustawiał `export CLAUDE_CRON_VPS_URL` w SHELL_RC, setup.sh:77-116) oraz KROK 2/4 persystował `export CLAUDE_CRON_WORKSPACE` (setup.sh:152-160). Nowy `setup.mjs` pyta o workspace, ale NIGDZIE go nie persystuje jako env (`CLAUDE_CRON_WORKSPACE` nie jest zapisywany — używany tylko do umieszczenia pliku hooka) i w ogóle nie pyta o VPS / nie ustawia `CLAUDE_CRON_VPS_URL`. Zweryfikowane: `grep -ni "vps\|discord\|CLAUDE_CRON_WORKSPACE\|SHELL_RC\|export " setup.mjs` daje wyłącznie nagłówek komentarza (linia 7) — zero kodu env. Te zmienne są realnie konsumowane: `server.js:131` proxy do VPS zwraca 503 „VPS not configured (set CLAUDE_CRON_VPS_URL)", `lib/config.js:14,21` (WORKSPACE_DIR/VPS_API_URL), `scripts/inbox/inbox-pull.mjs:34` i `inbox-push.mjs:28-29`. Ponieważ stary `setup.sh` jest teraz osierocony (patrz P2 niżej), po świeżej instalacji przez `install.sh`→`setup.mjs` lokalny dashboard nie ma skonfigurowanego połączenia z VPS, a workspace dla inbox/config spada na `process.cwd()` zamiast wybranego folderu. To kluczowa funkcja produktu (dashboard = „proxy do VPS", setup.sh:6). Plan Unit 5 cytuje migrację „logiki z setup.sh:162-270" (tylko hook+settings), więc env/VPS wypadły poza cytowany zakres — ale efektem jest utrata działającej ścieżki konfiguracji bez zamiennika.

### P2 — important

**[P2][KOD] setup.mjs:231-237 (registerHook) — pusty catch nadpisuje uszkodzony settings.json (utrata konfiguracji)**
Gdy istniejący `{workspace}/.claude/settings.json` jest niepustym, ale niepoprawnym składniowo JSON-em, blok `catch { existing = {} }` (linia 234-236) cicho resetuje stan do pustego obiektu, po czym `fs.writeFileSync` (linia 241) NADPISUJE cały plik settings.json — tracąc istniejące permissions, inne hooki, env, konfiguracje usera. To realna utrata konfiguracji przy ponownym uruchomieniu setupu na zepsutym/niepełnym pliku (ręczna edycja, przerwany zapis). Narusza regułę projektu „NIGDY pusty catch {} — zawsze loguj albo re-throw". Kontrast: `removeHookFromSettings` (uninstall) używa gołego `JSON.parse` (rzuca głośno), więc nie nadpisuje cicho. Powinno: fail-fast z czytelnym komunikatem (nie nadpisuj), albo backup pliku przed zapisem, albo przynajmniej log ostrzegający że plik był nieparsowalny i został zresetowany.

**[P2][KOD] setup.sh, setup-windows.ps1 (nieusunięte) — dwie konkurencyjne / sprzeczne ścieżki instalacji (narusza R10)**
Plan Unit 5 mówi wprost: „Modyfikuj/zastąp: logika z setup.sh:162-270 i setup-windows.ps1:190-315 migruje do setup.mjs (shell zostaje cienki w Unit 4)". Commit deklaruje „README bez setup.sh/setup-windows.ps1". Faktycznie te pliki nadal istnieją w korzeniu repo (zweryfikowane: `ls -la setup.sh setup-windows.ps1` → oba obecne), nie są referowane przez README ani package.json (osierocone — `grep setup.sh README.md package.json` exit=1), i zawierają STARY, BUGOWANY hook wołający gołe `spawn('node', ['server.js'])` (setup.sh:202, setup-windows.ps1:225) — dokładnie defekt, który całe to zadanie naprawia (R7). Pozostawienie ich = mylące dla usera/utrzymania (ktoś może odpalić `setup.sh` i dostać zepsuty bare-node hook nadpisujący poprawny). Unit 6 wylistował do usunięcia tylko `scripts/install-macos.sh` i `scripts/install-windows.ps1` — root `setup.sh`/`setup-windows.ps1` nie zostały ani usunięte, ani zmodyfikowane. Dodatkowo `MIGRACJA-PULS.md:282` nadal odnosi się do `setup-windows.ps1`. Cel R10 („Koniec dwóch konkurencyjnych ścieżek instalacji") niespełniony.

**[P2][TEST] setup.test.mjs — brak testów dla isClaudeInstalled(probe) (rdzeń R9)**
Brak testów dla eksportowanej funkcji `isClaudeInstalled(probe)` z setup.mjs:172. To rdzeń wymagania R9 (warunek wstępny Claude Code + handoff). Funkcja jest DI-friendly (przyjmuje wstrzykiwalny `probe`), więc testowalna bez mockowania procesu — wystarczy probe zwracający `{status:0}` (happy: Claude obecny → true) i `{status:1}` (error case: brak Claude → false). Plan (Unit 5, Notatka wykonawcza) explicite wymaga test-first dla pure helperów; tu helper jest, asercji brak. Wymagany min. 1 happy + 1 error case.

**[P2][TEST] setup.test.mjs — brak testów dla detectPortableNodeBin(execPath, platform, repoDir, arch) (logika R7)**
Brak testów dla eksportowanej funkcji `detectPortableNodeBin` z setup.mjs:163. Implementuje logikę R7 (wybór binarki node wypalanej w hooku): gałąź `execPath` wskazuje na `.node/` (zwraca execPath) vs fallback (buduje ścieżkę przez `resolveNodeBinPath`). Dwie ścieżki warunkowe, żadna nie ma pokrycia. Pure funkcja, w pełni testowalna przez argumenty — min. 1 test gałęzi execPath-match + 1 test gałęzi fallback. Gałąź fallback jest najbardziej zawodna (patrz P3 o braku walidacji arch).

### P3 — nit

**[P3][KOD] setup.mjs:7,13 — nagłówek over-promise (VPS, Discord)**
Nagłówek modułu deklaruje zadanie „2. Pytania konfiguracyjne (VPS, workspace, autostart, Discord)", a `main()` pyta WYŁĄCZNIE o workspace i autostart — brak jakiegokolwiek pytania o VPS i o Discord. Wprowadza w błąd co do faktycznego zakresu konfiguracji (powiązane z P1 o utracie konfiguracji VPS). Albo zaimplementować pytania VPS/Discord, albo sprostować komentarz do realnego zakresu (rule 7: dokumentacja opisuje CO faktycznie robi kod).

**[P3][KOD] setup.mjs:234 — pusty catch przy JSON.parse settings.json (bez logu)**
`catch { existing = {} }` połyka błąd bez logowania, niezgodnie z regułą „NIGDY pusty catch — zawsze loguj albo re-throw". (Powiązane z P2 — to ten sam blok; tu odnotowane jako osobny aspekt: nawet jeśli decyzja o nadpisaniu zostanie, minimum to zalogowanie ostrzeżenia że settings.json był nieparsowalny.)

**[P3][KOD] setup.mjs:197-204 (runSmokeTest) — smoke-test materializuje PRODUKCYJNĄ bazę**
`runSmokeTest()` woła `db.getDb()` bez DI ścieżki, więc tworzy i migruje PRODUKCYJNĄ bazę (DB_PATH z config.js) jako efekt uboczny instalacji — na czystej maszynie setup zakłada katalog `data/` i plik `.db` tylko po to, by sprawdzić typy agregatu. Plan (Unit 5) mówił „wywołaj smoke-test typów (Unit 2) raz" — intencja była weryfikacja typów, nie inicjalizacja produkcyjnego stanu w trakcie setupu. Skutek jest idempotentny i nieszkodliwy (ten sam plik użyje server.js), ale miesza odpowiedzialności. Rozważyć smoke-test na `:memory:` przez `setDbPath()`.

**[P3][KOD] setup.mjs:37-47,163-169 — detectPortableNodeBin fallback bez walidacji arch / guardu istnienia**
`resolveNodeBinPath` waliduje platform (rzuca dla nieobsługiwanej), ale `arch` jest przyjmowany bez walidacji i wklejany prosto w nazwę dist. `process.arch` może zwrócić wartości spoza zbioru obsługiwanego przez bootstrap (np. `ia32`/`ppc64`), a `install.ps1` dopuszcza `x86` którego `install.sh` nie zna. `detectPortableNodeBin` w ścieżce fallback (gdy execPath nie zawiera `.node`) zbuduje ścieżkę do nieistniejącej binarki bez guardu istnienia — hook autostartu dostanie martwą ścieżkę node, błąd ujawni się dopiero przy starcie serwera w detached procesie (stdio: 'ignore' → niemy fail). W praktyce execPath zwykle wskazuje na `.node` (portable Node odpalił setup.mjs), ryzyko niskie. Rozważ walidację arch w zbiorze `{arm64,x64}` (+ x86 dla win) symetrycznie do walidacji platform.

**[P3][KOD] setup.mjs:130 (http.get timeout) — poprawnie zabezpieczone**
`http.get` z opcją `{ timeout: 1000 }` ustawia timeout na bezczynność socketu, NIE twardy deadline całego żądania. Tu obsłużone poprawnie przez `req.on('timeout', () => req.destroy())`, więc działa. Bez znaczenia dla wydajności; odnotowane jako poprawnie zabezpieczone — bez akcji.

**[P3][KOD] install.sh:115 (verify_checksum grep) — wzorzec poprawny**
`grep ' ${ARCHIVE}$'` po pełnym SHASUMS256.txt — plik ma ~kilkaset linii, grep liniowy O(n) trywialny i jednorazowy. Brak problemu wydajności; dopasowanie po sufiksie nazwy archiwum poprawne (kotwica `$`). Bez akcji.

**[P3][KOD] scripts/uninstall-macos.sh:58 / scripts/uninstall-windows.ps1 — JSON.parse bez try/catch**
Inline JS w uninstall robi `JSON.parse(readFileSync(settings.json))` bez try/catch. Uszkodzony settings.json przerwie uninstall nieobsłużonym wyjątkiem w środku procedury (po tym jak część kroków mogła się już wykonać). Mniej groźne niż w setup (uninstall jest operator-run i fail-loud jest tu akceptowalny — nic nie nadpisuje cicho), ale warto owinąć w czytelny komunikat „settings.json uszkodzony — usuń wpis ręcznie" zamiast surowego stack trace. Reuse `removeHookFromSettings` między setup a uninstall jest poprawny architektonicznie (jedno źródło prawdy).

**[P3][TEST] setup.test.mjs — rozbieżność liczby testów (commit 20 vs faktyczne 17)**
Komunikat commita deklaruje „20 nowych w setup.test.mjs" i „Suite: 141 PASS", ale plik zawiera 17 testów (zweryfikowane: `node --test setup.test.mjs` → tests 17 / pass 17). Rozbieżność (20 vs 17) to bookkeeping/raportowanie, nie defekt zachowania. Same testy pokrywają pure helpery (resolveNodeBinPath per platforma+arch, idempotencja merge/remove, buildHookSource) zgodnie z planem; brak testu nieobsługiwanej platformy/arch dla detectPortableNodeBin (powiązane z P2 TEST + P3 arch).

#### OPERATOR (niewykonalne headless — do operator-checklist, NIE blokują gate'u)

**[P3][OPERATOR] install.sh / install.ps1 — bootstrap portable Node nieweryfikowalny headless**
Bootstrap portable Node (pobieranie z nodejs.org/dist, weryfikacja SHASUMS256, detekcja platform+arch, rozpakowanie, handoff do setup.mjs) nie ma i nie może mieć testów headless — wymaga realnego pobrania archiwum i wykonania na czystym Mac/Win. Plan klasyfikuje te scenariusze jako [Manual] + Operator checklist (Unit 4). `bash -n install.sh` przechodzi (składnia OK). Weryfikacja faktyczna = operator na czystym środowisku.

**[P3][OPERATOR] install.sh:106-132 — integralność opiera się tylko na SHASUMS256 (bez GPG)**
Integralność portable Node opiera się wyłącznie na SHASUMS256.txt pobranym tym samym kanałem HTTPS co archiwum (bez weryfikacji podpisu GPG SHASUMS256.txt.sig publikowanego przez Node.js). Atakujący kontrolujący kanał/mirror mógłby podmienić jednocześnie archiwum i sumy. Plan jawnie zakładał SHASUMS256 jako „tani guard", więc to świadome ograniczenie scope, nie defekt — weryfikacja realnego flow (i ew. dodanie GPG) wymaga realnego środowiska sieciowego/operatora.

**[P3][OPERATOR] install.ps1:71,74 (Invoke-WebRequest -UseBasicParsing) — poprawnie zoptymalizowane**
Pobieranie archiwum Node (~30 MB) przez Invoke-WebRequest bez -UseBasicParsing bywa wolne (parser DOM); tu poprawnie użyto -UseBasicParsing. Realna przepustowość zależy od sieci i jest mierzalna tylko na realnej maszynie Windows. Odnotowane jako poprawnie zoptymalizowane.

**[P3][OPERATOR] setup.mjs:120-158 — hook autostartu (detached server.js) wymaga realnej sesji Claude Code**
Generowany hook autostartu (`buildHookSource`) jest rejestrowany w settings.json jako komenda wykonywana automatycznie przy KAŻDYM UserPromptSubmit w workspace i spawnuje detached server.js z portable Node. Wstrzyknięcie nodeBinPath/repoDir przez `JSON.stringify` jest poprawnie zescapowane, ścieżki pochodzą ze źródeł zaufanych (process.execPath/import.meta.url), więc brak code-injection. Faktyczne zachowanie autostartu (czy detached serwer wstaje bez fnm/nvm na PATH) wymaga realnej sesji Claude Code na Mac/Win.

**[P3][OPERATOR] docs/plans/2026-06-29-001-feat-ulatwienie-instalacji-plan.md:321 — scenariusz brak `claude` w PATH**
Scenariusz [Manual]: brak `claude` w PATH → setup zatrzymuje się z handoff-komunikatem i niczego nie instaluje. `isClaudeInstalled` używa `defaultClaudeProbe` (which/where) — pełna weryfikacja wymaga realnego środowiska z/bez Claude CLI w PATH. Rdzeń (`isClaudeInstalled` z wstrzykniętym probe) jest unit-testowalny i powinien mieć test (patrz P2 TEST), ale efekt `process.exit(1)` + komunikat handoffu to weryfikacja operatorska.

**[P3][OPERATOR] README.md:30-31,83-84 — niejednoznaczność nazwy install.sh (Claude CLI vs repo)**
Notka trust o curl|bash referuje `https://claude.ai/install.sh` / `install.ps1` jako przykład inspekcji skryptu — to URL instalatora samego Claude Code (prerequisite R9), a repo własny `install.sh` uruchamiany jest po sklonowaniu przez `bash install.sh` (Krok 4). Reużycie tej samej nazwy `install.sh` w obu kontekstach jest dwuznaczne. Plan świadomie odroczył „mechanikę one-linera". Drobna niejasność dokumentacji do potwierdzenia przez operatora przy realnym przejściu README, nie defekt kodu.

**[P3][OPERATOR] scripts/uninstall-macos.sh / scripts/uninstall-windows.ps1 — integracja shell→node→FS [Manual]**
Ścieżka uninstall (usunięcie wpisu hooka przez wspólny `removeHookFromSettings`, usunięcie pliku hooka, confirm-before-delete `.node/` za flagą `--remove-node`/`-RemoveNode`) wykonuje I/O na realnym FS workspace i odpala node z `--input-type=module`. Czysty rdzeń (`removeHookFromSettings`) JEST pokryty unit-testami w setup.test.mjs; integracja shell→node→FS jest [Manual] (Unit 6) i wymaga operatora po realnej instalacji. Pokrycie rdzenia wystarczające.

---

## Zgodność ze spec

- **R6/R8 (Unit 4):** zrealizowane (static-OK). `install.sh`/`install.ps1` pobierają portable Node z nodejs.org/dist, weryfikują SHASUMS256, handoff do setup.mjs. `bash -n` przechodzi. Faktyczne pobranie = Operator checklist.
- **R7 (Unit 5):** zrealizowane częściowo. Hook z absolutną ścieżką portable Node + flagą `--disable-warning` poprawny i testowany (17 PASS). Gap: `detectPortableNodeBin` (gałąź fallback, R7) bez testu (P2 TEST); arch bez walidacji (P3).
- **R8 env (Unit 5):** NIEZREALIZOWANE — `CLAUDE_CRON_WORKSPACE` nie persystowany, `CLAUDE_CRON_VPS_URL` w ogóle nie pytany (P1). Regresja vs setup.sh.
- **R9 (Unit 5):** zrealizowane (handoff przy braku claude), ale rdzeń `isClaudeInstalled` bez testu (P2 TEST).
- **R10 (Unit 6/7):** zrealizowane częściowo. `scripts/install-macos.sh`/`install-windows.ps1` usunięte, package.json przepięty, README pod nowy flow, uninstall pod nowy layout. Gap: root `setup.sh`/`setup-windows.ps1` NIEUSUNIĘTE (P2 KOD) — cel „koniec dwóch ścieżek" niespełniony.
- **Scope creep:** brak. Zmiany mieszczą się w R6-R10 (raczej under-implementation niż over-implementation).

---

## Bookkeeping checkboxów Weryfikacja:

- Odznaczone automatycznie (CLI/grep): 10
- Odznaczone na podstawie E2E: 0
- Pozostawione dla operatora (Manual / Test [Manual]): Unit 4/5/6/7 Test [Manual] — to Testy, nie checkboxy Weryfikacja:
- Niejasne (P3): 0
- Failujące (P2 bookkeeping): 1 — `grep -rn install-macos.sh\|install-windows.ps1 .` zwraca dopasowania (docs/plans, MIGRACJA-PULS.md, kontekst zadania). Checkbox zakładał „zwraca pusto". To referencje historyczne/dokumentacyjne (plan, ustalenia, MIGRACJA-PULS, sam plik zadań) — żaden żywy skrypt/package.json nie woła usuniętych plików. Klasyfikacja: NIE blokujący P1/P2 zachowania (pliki realnie usunięte, package.json przepięty), ale checkbox literalnie FAIL → odnotowany. Pozostawiony niezaznaczony z adnotacją.

### Szczegóły

- [x] CLI: `bash -n install.sh` → PASS (exit 0)
- [x] Grep: `grep -n "SHASUMS256\|nodejs.org/dist" install.sh install.ps1` → PASS (oficjalne źródło + weryfikacja sumy w obu)
- [x] Grep: `grep -n "setup.mjs" install.sh install.ps1` → PASS (handoff `exec`/`&` w obu)
- [x] CLI: `node --test setup.test.mjs` → PASS (tests 17 / pass 17, exit 0)
- [x] Grep: `grep -n "node.exe\|bin/node\|disable-warning" setup.mjs` → PASS (absolutna ścieżka + flaga)
- [x] Grep: `grep -n "claude" setup.mjs` → PASS (detekcja warunku wstępnego + handoff message)
- [x] CLI: `test ! -f scripts/install-macos.sh && test ! -f scripts/install-windows.ps1` → PASS (oba usunięte)
- [x] Grep: `grep -n "install.sh\|install.ps1" package.json` → PASS (install:mac/win przepięte)
- [ ] Grep: `grep -rn "install-macos.sh\|install-windows.ps1" .` (poza historią git) → FAIL (referencje w docs/plans, MIGRACJA-PULS.md, kontekst, sam plik zadań — żaden żywy skrypt/package.json; pliki realnie usunięte)
- [x] Grep: `grep -in "build tools\|better-sqlite3" README.md` → PASS (pusto, exit 1 = brak dopasowania = oczekiwane)
- [x] Grep: `grep -n "install.sh\|install.ps1\|.node" README.md` → PASS (nowy flow obecny)
</content>
</invoke>
