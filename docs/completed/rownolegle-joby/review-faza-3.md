# Review fazy 3 — Autostart na Macu (Unit 8)

**Data:** 2026-07-30
**Zakres:** `lib/platform.js`, `lib/platform.test.js` (+ dokumentacja fazy)
**Gate:** ⚠️ **ZASTRZEŻENIA** — 0×P1, 3×P2, 14×P3 (+2 findingi OPERATOR poza gate'em)

---

## Statystyki

| Metryka | Wartość |
|---|---|
| Findingi łącznie (po dedupie i verify) | 19 |
| P1 (blocking, KOD/TEST/E2E) | 0 |
| P2 (important, KOD/TEST/E2E) | 3 |
| P3 (nit, KOD/TEST/E2E) | 14 |
| OPERATOR (poza gate'em, warunki środowiskowe) | 2 |
| E2E | passed 0 / failed 0 / skipped 0 (brak warstwy UI — tester pominięty) |
| Bookkeeping `Weryfikacja:` — odznaczone CLI | 2 |
| Bookkeeping `Weryfikacja:` — nowe P2 | 0 |

Rozkład po typie: KOD 10, TEST 7, OPERATOR 2, E2E 0.

---

## P1 — blokujące

Brak. Żaden finding nie przeszedł adversarial verify jako blokujący.

---

## P2 — ważne

### 🟠 [P2] KOD — `lib/platform.js:169`
Cel Unitu 8 („panel przestaje kłamić, a instalowany plist faktycznie wstaje") jest nieosiągalny żadną ścieżką usera: `installMac()`/`install()` nie ma ANI JEDNEGO wywołania w kodzie produkcyjnym (grep po repo: `lib/platform` importuje wyłącznie `server.js:13`, i tylko po `getStatus()` w `/api/status`; `install.sh`/`install.ps1` nigdzie nie wołają `launchctl`; realny autostart z `setup.mjs:1197` to hook Claude Code `claude-cron-autostart.js`, nie launchd). Dodatkowo `public/app.js`/`index.html` nie renderują pola `autostart` w ogóle. Efekt: cała naprawa generatora plista, sprzątanie legacy i nowy `buildMacStatus` to dziś kod martwy dla usera, a `/api/status.autostart` po instalacji oficjalnym instalatorem nadal raportuje `installed:false` (panel „kłamie" dalej, tylko w drugą stronę — autostart JEST, ale hookowy).

**Akcja:** albo wpiąć `platform.install()` w ścieżkę autostartu (`setup.mjs` / endpoint `POST /api/autostart`) i pokazać `autostart` na dashboardzie, albo jawnie zapisać w planie/kontekście, że Unit 8 przygotowuje moduł, a wpięcie idzie w osobnym Unicie — bo w obecnym kształcie checkbox operatora „panel pokazuje zainstalowany" nie ma jak przejść.

### 🟠 [P2] TEST — `lib/platform.test.js:1`
Nowe funkcje z I/O — `installMac()` (kolejność: mkdir logów → unload własnej etykiety → sprzątanie legacy → zapis plista → load), `removeLegacyAgents()`, `unloadAgent()`, `readLaunchctlList()` — nie mają ANI JEDNEGO testu (26 testów pokrywa wyłącznie czyste generatory i parsery). Checkbox `rownolegle-joby-zadania.md:247` odhaczono z uzasadnieniem „`installMac()` unloaduje i kasuje stary plist przed load", a przetestowana jest tylko połowa czytająca (`buildMacStatus`); reguła projektu wymaga dla każdej nowej funkcji min. 1 happy path + 1 error case, a learned-pattern 2026-07-28 ostrzega, że testy czystych funkcji przechodzą przy złamanym zachowaniu systemowym.

**Akcja:** wydzielić czysty plan sprzątania (np. `planLegacyCleanup(labels, existsFn)` zwracający listę do unload/unlink) albo wstrzyknąć runner (`runLaunchctl`) do `installMac()` i pokryć: (a) unload leci PRZED zapisem plista i przed `load`, (b) nieudany unload nie kasuje pliku, (c) katalog logów powstaje przed `load`.

### 🟠 [P2] TEST — `lib/platform.test.js:210`
Test `buildMacStatus: etykieta statusu = etykieta z PLIST_PATH (jedna stała)` jest nieprzenośny — asertuje `path.basename(platform.PLIST_PATH)`, a `PLIST_PATH` to `''` na każdej platformie != darwin (`lib/platform.js:14`). Zweryfikowane empirycznie: `node --require <preload ustawiający process.platform='linux'> --test lib/platform.test.js` → 25 pass / 1 fail (dokładnie ten test); na macOS 26/26. Repo działa produkcyjnie na Linuksie (VPS), więc `npm test` odpalony tam daje FAŁSZYWY czerwony wynik i podkopuje zaufanie do suity (a nowy plik testowy jest jedynym pokryciem tego modułu).

**Akcja:** asertować kontrakt niezależnie od platformy — `assert.ok(platform.PLIST_PATH === '' || path.basename(platform.PLIST_PATH) === `${platform.PLIST_LABEL}.plist`)` — albo dodać `{ skip: process.platform !== 'darwin' }` i osobną asercję, że `PLIST_LABEL` jest tą samą stałą, którą raportuje `buildMacStatus`.

---

## P3 — drobne (nie blokują gate'u)

### 🟡 [P3] TEST — `lib/platform.test.js:50`
Brak testu cytowania powłokowego (`shellQuote`) — jedynej bariery między wolnym katalogiem instalacji (Faza 2) a komendą `/bin/sh -c`, którą launchd odpala przy każdym boocie. FIXTURE używa wyłącznie czystej ścieżki `/Users/tester/claude-cron`, więc ani apostrof, ani spacja w ścieżce nie są pokryte; test `buildPlist: escapuje znaki XML` pokrywa tylko `escapeXml` na wartościach env, nie interakcję shellQuote→escapeXml w komendzie. Realny scenariusz: instalacja w `/Users/o'brien/claude-cron` albo `INSTALL_DIR` z env-override w `curl|bash` — pojedyncza regresja w `shellQuote` (np. zamiana na goły backtick/interpolację) przechodzi całą suitę i daje albo martwy agent, albo wykonanie dowolnej komendy przy każdym starcie systemu. **Akcja:** test `buildPlist` z `repoDir: "/Users/te'ster/A B"` i asercją na dokładny wynik cytowania (analogicznie dla `nodeBin`).

### 🟡 [P3] TEST — `lib/platform.test.js:203`
Scenariusz planu `[Unit] getStatus() rozpoznaje agenta po etykiecie, którą instaluje installMac()` odhaczony testem, który wywołuje WYŁĄCZNIE czystą `buildMacStatus(...)` z ręcznie podanym `legacyAgents`. Szew `getStatus() → buildMacStatus` nie ma ani jednej asercji: nikt nie sprawdza, że `getStatus()` w ogóle przekazuje `LEGACY_PLIST_LABELS` ani `plistExists` dla legacy (`lib/platform.js:244-254`). Usunięcie mapowania `legacyAgents` w `getStatus` zostawia całą suitę na zielono — klasa błędu z learned-pattern 2026-07-03 („gdy moduł A zakłada, że B coś zrobi — napisz test szwu"). **Akcja:** opcjonalne wstrzyknięcie I/O (`getStatus({ readList = readLaunchctlList, exists = fs.existsSync } = {})`) + test: output launchctl z samą etykietą legacy + `exists` true dla legacy plist → `{installed:true, legacy:true, label:'com.claude-cron.daemon'}`.

### 🟡 [P3] KOD — `lib/platform.js:239`
`uninstallMac()` został z `execSync(\`launchctl unload "${PLIST_PATH}"\`)` — interpolacja ścieżki do stringa powłoki — podczas gdy cała reszta funkcji macOS w tym pliku przeszła w tej fazie na `execFileSync` z tablicą argumentów (`load`, `unload`, `list`), a kontekst fazy deklaruje tę zmianę jako regułę. `PLIST_PATH` pochodzi z `HOME`, więc dziś to hardening, nie dziura, ale zostawia w module jedno miejsce łamiące własną konwencję. **Akcja:** `execFileSync('launchctl', ['unload', PLIST_PATH], { stdio: 'inherit' })`.

### 🟡 [P3] KOD — `lib/platform.js:98`
`resolvePortableNodeBin` akceptuje `process.execPath` na podstawie substringu `includes(\`${path.sep}.node${path.sep}\`)` — bez granicy katalogu, więc Node z `.node/` INNEJ instalacji zostanie wypalony w pliście tej instalacji (po Fazie 2 dwie instalacje na maszynie są realne; usunięcie tamtego katalogu zabija ten daemon przy boocie bez czytelnego powodu). Ten sam antywzorzec „substring zamiast granicy ścieżki", który review Fazy 2 zgłosiło dla `install.ps1`. **Akcja:** `execPath.startsWith(path.join(repoDir, '.node') + path.sep)`.

### 🟡 [P3] KOD — `lib/platform.js:21`
Plist jest jedynym artefaktem tej fazy trwale zapisującym środowisko na dysk (`fs.writeFileSync(PLIST_PATH, ...)` bez `mode` → 0644, czytelny dla innych lokalnych użytkowników), a blok `EnvironmentVariables` powstaje z whitelisty `PLIST_ENV_KEYS`. Dziś whitelista jest czysta (PATH/HOME/WORKSPACE/VPS_URL — zero sekretów), ale nic w kodzie tego nie utrwala: dopisanie `TELEGRAM_BOT_TOKEN`/`ASK_SECRET`/`DISCORD_WEBHOOK_URL` (kuszące, bo launchd nie widzi shell RC, a `ASK_TOKEN`/`ASK_SECRET` czytane są WYŁĄCZNIE z env — `config.js:56`) zamieni plist w plaintextowy magazyn sekretów. **Akcja:** komentarz-guard przy `PLIST_ENV_KEYS` („NIGDY sekrety — plist leży w `~/Library/LaunchAgents`; konfiguracja powiadomień idzie przez state w DB") + zapis z `{ mode: 0o600 }`.

### 🟡 [P3] KOD — `lib/platform.js:244`
`getStatus()` przy każdym `GET /api/status` spawnuje SYNCHRONICZNIE `launchctl list` (`readLaunchctlList`, `platform.js:193`) — dashboard poluje co 3 s (`public/app.js:1605`), razy liczba otwartych kart. Zmierzone: 3,3 ms blokady event-loopu i 18,8 KB / 539 linii outputu na wywołanie (stara wersja z `| grep` była wolniejsza — 5,6 ms — więc to nie regres, ale koszt zostaje), a wynik ląduje w polu, którego żaden kod w `public/` nie renderuje. Dodatkowo wywołanie idzie BEZ `timeout`: gdy launchctl się zaklinuje, jednowątkowy daemon blokuje się bezterminowo na ścieżce żądania. **Akcja:** (1) `timeout: 2000` w `execFileSync`, (2) memoizacja `buildMacStatus` z TTL ~5 s unieważniana w `installMac()`/`uninstallMac()`.

### 🟡 [P3] TEST — `lib/platform.test.js:157`
Trzy testy `resolvePortableNodeBin` tworzą katalogi przez `fs.mkdtempSync(os.tmpdir())`, a sprzątają je dopiero OSTATNIĄ linią ciała testu (`fs.rmSync(repoDir, ...)`). Pierwsza nieudana asercja rzuca przed `rmSync`, więc każdy czerwony przebieg zostawia w `/var/folders/.../platform-node-*` katalog z podrobionymi binarkami `bin/node`. **Akcja:** `test('...', (t) => {...})` + `t.after(() => fs.rmSync(repoDir, { recursive: true, force: true }))` zaraz po `mkdtempSync`.

### 🟡 [P3] KOD — `lib/platform.js:105`
Fallback `installed[installed.length - 1]` po `.sort()` z `readNodeDistDirs()` sortuje leksykograficznie, więc `node-v22.9.0` wypada PO `node-v22.17.0` — przy dwóch dystach bez pinowanego wybierze starszą wersję, a Node < 22.13 wywala runtime-guard (`node:sqlite`). Komentarz (linie 100-101) mówi dodatkowo o „pierwszym alfabetycznie", podczas gdy kod bierze ostatni. **Akcja:** porównanie numeryczne (parse `node-v(\d+)\.(\d+)\.(\d+)` + sort po krotce) i poprawka komentarza.

### 🟡 [P3] TEST — `lib/platform.js:18`
`PINNED_NODE_VERSION = '22.17.0'` to trzecia kopia pinu (`install.sh:22`, `setup.mjs:37`), a CLAUDE.md wymaga ich spójności — dziś nic tego nie pilnuje, więc podbicie wersji w instalatorze przechodzi cicho. **Akcja:** test w `lib/platform.test.js` czytający `install.sh` (regex `NODE_VERSION="([\d.]+)"`) i `setup.mjs` (`export const NODE_VERSION = '...'`) i asertujący równość z `PINNED_NODE_VERSION`.

### 🟡 [P3] KOD — `lib/platform.js:143`
`buildMacStatus()` jest reklamowany jako czysta funkcja z wstrzykiwanym wejściem, ale etykietę kanoniczną czyta z modułowej stałej `PLIST_LABEL`, podczas gdy `legacyAgents` dostaje parametrem — asymetryczne DI, przez które nie da się przetestować scenariusza rozjazdu etykiet (a to był pierwotny bug modułu). **Akcja:** parametr `label = PLIST_LABEL` w destrukturyzowanym obiekcie, używany w obu gałęziach i w returnie.

### 🟡 [P3] KOD — `lib/platform.js:143`
YAGNI: cała gałąź legacy w `buildMacStatus` nie ma konsumenta. `getStatus()` trafia wyłącznie do `/api/status` (`server.js:339`), a `public/app.js` w ogóle nie czyta pola `autostart` (grep „autostart" w `public/` = 0 trafień) — więc pola `label`/`legacy`, parametr `legacyAgents` (domyślne `[]` używane tylko przez testy) i pętla po `LEGACY_PLIST_LABELS` nie zmieniają niczego, co user widzi. Plan wymagał „migracja ALBO czytelna informacja" — migrację realizuje już `removeLegacyAgents()` w `installMac()`. **Akcja:** usunąć parametr `legacyAgents` i pola `label`/`legacy` (kontrakt wraca do `{installed, running, platform}`), usunąć mapowanie w `getStatus()` (`lib/platform.js:249-252`) i test `lib/platform.test.js:676`; `LEGACY_PLIST_LABELS` + `removeLegacyAgents()` zostają. *(Uwaga: sprzeczne z P3 „asymetryczne DI" powyżej i z P3 o teście szwu — rozstrzygnąć JEDNĄ decyzją: albo gałąź legacy dostaje konsumenta w UI, albo znika w całości.)*

### 🟡 [P3] KOD — `lib/platform.js:127`
Martwe pole w kontrakcie: `parseLaunchctlList` zwraca `pid`, którego nie czyta żaden konsument — jedyny wołający (`buildMacStatus`) używa wyłącznie `found`/`running`, a `pid` żyje tylko w asercjach `deepStrictEqual` w testach. **Akcja:** usunąć `pid` z trzech returnów (`lib/platform.js:128, 133-135`) i z asercji `lib/platform.test.js:603-636`.

### 🟡 [P3] KOD — `lib/platform.js:23`
Parametr bez użycia: `macLogFile(home = HOME)` — oba wywołania (linie 164 i 174) nie przekazują argumentu, żaden test też nie. Parametryzacja „na przyszłość". **Akcja:** `function macLogFile()` z `HOME` bezpośrednio.

### 🟡 [P3] KOD — `lib/platform.js:104`
Redundantne gałęzie: `resolvePortableNodeBin` buduje tę samą ścieżkę `path.join(nodeBase, pinnedDist, 'bin', 'node')` w dwóch miejscach (linia 104 „pinowany istnieje" i 107 „fallback"), przez co trzy `return` opisują dwa przypadki. **Akcja:** jeden wybór katalogu + jeden `return`.

---

## Findingi OPERATOR (poza gate'em)

Warunki środowiskowe — nie idą do fix, trafiają do sekcji `## Operator checklist faza 3` w pliku zadań.

### 🟠 OPERATOR — `docs/active/rownolegle-joby/rownolegle-joby-zadania.md` (checkbox Unitu 8)
Checkbox operatora („`launchctl list | grep claude-cron` pokazuje agenta, panel „zainstalowany", daemon przeżywa reboot") jest niewykonalny headless — wymaga realnego `launchctl load` w sesji GUI i restartu Maca. Nikt jeszcze nie odpalił nowego plista; testy pokrywają wyłącznie czyste funkcje. **UWAGA:** na tej maszynie autostartem jest RĘCZNY agent `com.claude-cron.daemon` (PID 8290, wskazuje na `/Users/kacper_trzepiecinski/Documents/Kodowanie/claude-cron`), a pierwszy `installMac()` go odepnie i BEZPOWROTNIE skasuje plik — kopia zapasowa przed testem jest warunkiem odwracalności.

### 🟠 OPERATOR — `lib/platform.js:221`
Na maszynie usera realnie leży ręcznie postawiony, DZIAŁAJĄCY agent `com.claude-cron.daemon` (z 23.07 — kontekst fazy wskazuje go jako wzorzec). Pierwsze uruchomienie nowego `installMac()` ubije go i skasuje plist, zastępując świeżo wygenerowanym plistem, którego nikt jeszcze nie wczytał pod launchd. Ryzyka nie da się zamknąć headless: jeśli nowy plist nie wstanie (TCC, ścieżka portable Node, uprawnienia), user zostaje BEZ autostartu, który przed instalacją działał.

---

## Odchylenia od planu

- **Unit 8 nie ma konsumenta.** Plan zakładał, że po fazie „panel przestaje kłamić" — a `installMac()` nie jest wołany z żadnej ścieżki usera i `public/` nie renderuje pola `autostart`. To najpoważniejsze odchylenie (P2 KOD `lib/platform.js:169`): kod jest poprawny, ale dla usera niewidoczny i nieosiągalny.
- **Scenariusze testowe z planu odhaczone testami czystych funkcji.** `[Unit] getStatus() rozpoznaje agenta po etykiecie` pokryto asercją na `buildMacStatus`, nie na `getStatus` — szew bez asercji (P3 `lib/platform.test.js:203`).
- **Checkbox „`installMac()` unloaduje i kasuje stary plist przed load"** odhaczony bez testu ścieżki I/O (P2 TEST `lib/platform.test.js:1`).

---

## Bookkeeping checkboxów Weryfikacja:

- Odznaczone automatycznie (CLI/grep): **2**
- Odznaczone na podstawie Agent 5 E2E: **0** (tester E2E nie odpalił w tej fazie — routing pominął: brak warstwy UI, 0 browserowych checkboxów)
- Pozostawione dla operatora (Manual): **1**
- Niejasne (P3): **0**
- Failujące (P2): **0**

### Szczegóły

- [x] CLI: `node --test lib/platform.test.js` przechodzi → PASS (exit 0; 26 tests, 26 pass, 0 fail)
- [x] CLI: `npm test` przechodzi w całości → PASS (exit 0; 772 tests, 772 pass, 0 fail, 10,9 s)
- [ ] Manual: „po instalacji `launchctl list | grep claude-cron` pokazuje agenta, panel „zainstalowany", daemon przeżywa reboot" — wymaga operatora (przeniesione do `## Operator checklist faza 3`; wymaga sesji GUI, realnego `launchctl load` i restartu Maca)

Bookkeeping nie dołożył żadnego nowego P2 ani P3 — severity gate z sekcji „Statystyki" pozostaje bez zmian.

---

## Przebieg review

| Etap | Wartosc |
|---|---|
| Pliki w fazie (z tego kodu) | 5 (2) |
| Flagi warstw | ui=false dane=true typowanie=false nowyModul=true |
| Browserowe checkboxy `Weryfikacja:` | 0 |
| Reviewerzy aktywni | security, performance, architecture, spec-compliance, simplicity, test-coverage |
| Reviewerzy pominieci | typescript (domena nieobecna w mapie zmian fazy); e2e (brak warstwy UI i zero browserowych checkboxow Weryfikacja: (0)) |
| Findingi: znalezione -> dedup JS -> dedup semantyczny | 45 -> 44 -> 23 |
| Adversarial verify: weryfikowane / obalone / bez glosow | 11 / 4 / 0 |
