# Review Fazy 5 — Aktualizacja i dystrybucja (U11, U12)

**Data:** 2026-08-05
**Zakres:** `lib/updater.js`, `lib/updater.test.js`, `server.js` (`GET/POST /api/update`), `public/app.js`, `public/render-helpers.js`, `public/render-helpers.test.js`, `public/index.html`, `public/style.css`, `install.ps1`, plik zadań + plan; U12 = zmiany w OSOBNYM repo `aibiz-plugin` (niezacommitowane, poza diffem tej fazy).
**Severity gate:** ⛔ **BLOKUJE** — 3 findingi P1.

## Statystyki

| Kategoria | P1 | P2 | P3 | Razem |
|---|---|---|---|---|
| KOD | 3 | 2 | 12 | 17 |
| TEST | 0 | 3 | 2 | 5 |
| E2E | 0 | 0 | 0 | 0 |
| **Do naprawy (KOD/TEST/E2E)** | **3** | **5** | **14** | **22** |
| OPERATOR (poza fix, warunki środowiskowe) | 0 | 4 | 5 | 9 |
| **Łącznie** | 3 | 9 | 19 | **31** |

**E2E:** passed 0 / failed 0 / skipped 0 (faza bez scenariuszy browserowych; wszystkie sprawdzenia end-to-end updatera wymagają realnej maszyny → Operator checklist).

## Ocena zbiorcza

Faza dostarczyła wszystkie artefakty z IU (nowy moduł `lib/updater.js` + testy, endpointy `/api/update`, pasek w panelu, tryb nieinteraktywny `install.ps1`), ale **ścieżka happy-path nie domyka się na żadnej z dwóch platform**:

- **macOS** — po udanym `git pull` nikt nie zapisuje `data/version.json`, więc `/api/status` raportuje starą rewizję → panel po 6 minutach mówi „Aktualizacja nie powiodła się" mimo sukcesu, a `GET /api/update` w kółko oferuje tę samą aktualizację. Dodatkowo skrypt tylko **ubija** daemona, licząc na launchd/hook, których ta instalacja nie ma wpiętych — scheduler zostaje martwy na czas nieokreślony.
- **Windows** — spawn PowerShella z `cwd` = katalog instalacji blokuje własny katalog, którego `install.ps1` musi potem przenieść (`Install-FreshRepo`), czyli aktualizacja przerywa się **po** ubiciu daemona.

To odwrócenie celu R10: feature powstał, żeby diagnostyka nie kłamała o stanie, a dziś sukces raportuje jako porażkę (Mac) albo zostawia maszynę bez Pulsa (obie platformy).

Warstwa testowa jest zielona (21/21, 952/952), ale asertuje wyłącznie **kształt komend** — dokładnie learned pattern `2026-07-03` / `2026-07-28`: testy czystych funkcji obu stron przechodzą przy złamanym zachowaniu systemowym. Brak też pokrycia szwu `server.js` ↔ `updater` dla najgroźniejszego endpointu API (zdalne pobranie kodu + restart daemona), a nowe gałęzie `install.ps1` (`$NonInteractive`, `Invoke-UpdateFinish`) nie mają testów mimo istniejącej suity Pester ze szwem testowym.

U12 jest **poza zasięgiem tego review** — zmiany leżą niezacommitowane w repozytorium `aibiz-plugin`, a push jest zabramkowany wyjaśnieniem cudzych zmian w `hooks/`.

---

## Findingi

### 🔴 P1 — blokujące

#### P1-1 · KOD · `lib/updater.js:168`
Ścieżka macOS NIGDY nie aktualizuje `data/version.json`. `buildMacUpdateCommand` to `sleep 1; cd <repo> && git pull --ff-only && kill <pid>` — a jedynymi miejscami piszącymi plik wersji są `setup.mjs`, `install.ps1` (`Invoke-UpdateFinish`) i `install-vps.sh` (grep `writeVersionFile`). Skutki po UDANEJ aktualizacji na Macu: (1) `/api/status` zwraca STARĄ rewizję, więc `pollUpdateProgress` (`public/app.js:456`) nigdy nie trafi `revisionsMatch(revision, updateWatch.target)` i po 6 min panel mówi „Aktualizacja nie powiodła się — Puls nie wrócił z nową wersją" mimo sukcesu; (2) `GET /api/update` w kółko raportuje `available`, więc user klika kolejny raz. To dokładnie ta klasa fałszywej diagnostyki, którą faza miała zamknąć (kontrakt czterowartościowy: „nie kłam o stanie"), tylko odwrócona — sukces zgłoszony jako porażka.
**Akcja:** dopisz do skryptu maca zapis wersji PRZED `kill`, np. `&& node -e "require('./lib/version').writeVersionFile({revision:process.env.R,source:'git'})"` z `R=$(git rev-parse HEAD)` po pullu (parytet z `install.ps1:552-565`), i dopiero potem `kill`.

#### P1-2 · KOD · `lib/updater.js:475`
Na Macu updater ubija daemona licząc na to, że „launchd/hook autostartu podnosi serwer", ale ŻADEN z tych mechanizmów nie gwarantuje powrotu: `lib/platform.js` (`installMac`) nie jest wpięty w żadną ścieżkę usera (udokumentowane w `CLAUDE.md` i w `docs/completed/rownolegle-joby` — jedyny import `lib/platform` to `server.js` po `getStatus()`), a hook Claude Code odpala się dopiero przy zdarzeniu sesji Claude Code. Po kliknięciu „Zaktualizuj Pulsa" na czystym Macu (bez otwartej sesji CC) scheduler zostaje UBITY na czas nieokreślony — joby nie lecą, inbox sync nie chodzi, panel nie odpowiada, a jedyny sygnał to komunikat o niepowodzeniu po 6 minutach.
**Akcja:** skrypt maca musi sam wznowić serwer po pullu (spawn `node --disable-warning=ExperimentalWarning server.js` z portable Node, detached, po `kill` z krótką pauzą), zamiast polegać na zewnętrznym mechanizmie, którego ta instalacja nie ma.

#### P1-3 · KOD · `lib/updater.js:243`
Windows: `startUpdate` spawnuje PowerShella z `cwd: repoDir` (= katalog instalacji, `PROJECT_ROOT`). Na Windowsie katalog będący bieżącym katalogiem roboczym ŻYJĄCEGO procesu jest zablokowany — a ten sam proces wykonuje potem `Install-FreshRepo`, które robi `Move-Item -LiteralPath $InstallDir -Destination $trash` (`install.ps1:395`). Ruch własnego cwd padnie z „Proces nie moze uzyskac dostepu do pliku", czyli aktualizacja przerywa się PO `Stop-PulsProcesses` (daemon już ubity, Task Scheduler jest ONLOGON) → maszyna zostaje bez Pulsa do następnego logowania. To dokładnie learned pattern `2026-07-28` („instalator podmieniający katalog aplikacji MUSI najpierw zwolnić uchwyty"), cytowany w komentarzu tej samej funkcji. Testy tego nie łapią: `lib/updater.test.js:789` asertuje `detached`/`stdio`, ale nie `cwd`.
**Akcja:** dla `win32` spawnować z `cwd` poza katalogiem instalacji (np. `os.tmpdir()`) + asercja w teście.

---

### 🟠 P2 — ważne

#### P2-1 · KOD · `server.js:343`
`POST /api/update` nie ma serwerowego guardu „aktualizacja już trwa" — jedyna blokada to `if (updateWatch) return` w przeglądarce (`public/app.js:426`). Odświeżenie strony gubi `updateWatch`, a `GET /api/update` nadal zwraca `available` (na Macu ZAWSZE, patrz P1-1), więc przycisk wraca i drugi klik odpala DRUGI odczepiony instalator. Na Windowsie dwa równoległe `install.ps1` robią jednocześnie `Stop-PulsProcesses` + `Move-Item` katalogu instalacji (`Install-FreshRepo`, `install.ps1:369`) — wyścig na podmianie katalogu z bazą, czyli realna szansa na rozjechaną instalację.
**Akcja:** flaga `updateInProgress` w `lib/updater.js` (ustawiana w `startUpdate`, in-memory, wzorzec liczników z `ask.js`) i 409 z drugiego POST-a.

#### P2-2 · KOD · `lib/updater.js:179`
Ścieżka Windows przekazuje 40-znakowy SHA jako `CLAUDE_CRON_REF`, więc `install.ps1` (`Resolve-ZipSource`, `install.ps1:275`) robi DRUGIE zapytanie do `api.github.com` (`Get-RefSha`) na ten sam commit — a przy wyczerpanym limicie 60/h (panel już zużył co najmniej dwa: GET i POST `/api/update`) wpada w fallback i buduje URL `archive/refs/heads/<SHA>.zip`, czyli gałąź o nazwie SHA, która nie istnieje → 404 i aktualizacja pada.
**Akcja:** w `buildWindowsUpdateCommand` ustaw jawny override, który pomija rozstrzyganie i zapewnia zapis wersji: `$env:CLAUDE_CRON_ZIP_URL='https://github.com/<slug>/archive/<sha>.zip'`, `$env:CLAUDE_CRON_ZIP_TOPDIR='claude-cron-<sha>'`, `$env:CLAUDE_CRON_INSTALL_REVISION='<sha>'` (bez tego ostatniego `Invoke-UpdateFinish`, `install.ps1:552`, w ogóle nie zapisze `data/version.json` na ścieżce z overridem URL-a i panel wpadnie w tę samą pętlę co na Macu).

#### P2-3 · TEST · `install.ps1:225`
Nowe gałęzie trybu nieinteraktywnego (`$NonInteractive` w `Read-InstallDir:100`, `Confirm-InstallDirReplaceable:205` oraz cała funkcja `Invoke-UpdateFinish:546`) nie mają ani jednego testu, mimo że projekt ma dla tych DOKŁADNIE funkcji suitę Pester ze szwem testowym (`install.ps1.Tests.ps1:226/238/251` wołają `Confirm-InstallDirReplaceable -Answer`). To kod decydujący, czy aktualizacja skasuje obcy katalog i czy w ogóle zapisze wersję.
**Akcja:** dopisz w `install.ps1.Tests.ps1`: (a) `$NonInteractive=1` + brak `INSTALL_DIR` → `Read-InstallDir` rzuca; (b) `$NonInteractive=1` + katalog „foreign" → `Confirm-InstallDirReplaceable` rzuca (fail-closed, zero `Read-Host`); (c) katalog „puls" → przechodzi bez pytania.

#### P2-4 · TEST · `lib/updater.test.js:724`
Testy maca sprawdzają WYŁĄCZNIE kształt komendy (`git pull --ff-only`, `kill <pid>`, cytowanie katalogu) i nie asertują ani jednego elementu kontraktu, po który cały feature powstał: „po udanej aktualizacji panel wie o nowej wersji" (zapis `data/version.json`) oraz „serwer wraca". To realizacja learned-patternu `2026-07-03`/`2026-07-28`: testy czystych funkcji obu stron przechodzą przy złamanym zachowaniu systemowym — 21/21 zielonych przy ścieżce maca, która w happy-path zawsze raportuje porażkę.
**Akcja:** asercje na zapis wersji i wznowienie serwera w skrypcie maca (po naprawie P1) + test szwu `POST /api/update` → `startUpdate` z wstrzykniętym `io` (bez realnego spawnu), wzorzec `server.runs.test.js`.

#### P2-5 · TEST · `lib/updater.test.js:1`
Zero pokrycia szwu `server.js` ↔ `updater` dla `GET/POST /api/update`, mimo że to najgroźniejszy endpoint API (zdalne pobranie kodu + restart daemona). Niepokryte kontrakty: 409 gdy `can_update:false` (kliknięcie w wyścigu z zakończoną aktualizacją), 500 gdy `startUpdate` zwróci `{ok:false}` (Mac bez `.git`, Linux), oraz — deklarowany w komentarzu jako sedno bezpieczeństwa — „rewizja ze ŚWIEŻEGO sprawdzenia po stronie serwera, NIGDY z body". Regresja, w której ktoś zacznie czytać `body.revision`, przechodzi dziś CAŁĄ suitę. Uzasadnienie odchylenia („GET biłby w prawdziwe API GitHuba") jest skutkiem braku DI: `server.js:336/344` woła `updater.checkForUpdate()` bez argumentów.
**Akcja:** hak wstrzykiwania jak `db.setDbPath`/`setClaudeBin` (`setFetchImpl`/`setUpdaterIo`) + test HTTP w duchu `lib/ask.http.test.js` na 409/500/„revision z serwera, nie z body".

---

### 🟡 P3 — drobne

1. **KOD · `server.js:335`** — `GET /api/update` bez cache'u, rate limitu i guardu cross-origin, przy globalnym `Access-Control-Allow-Origin: *` (`server.js:784`) i CSRF-guardzie obejmującym tylko metody != GET/HEAD (`server.js:234`). Dowolna odwiedzona strona ODCZYTUJE rewizję + `installed_at` + `source` (fingerprint maszyny) i przy każdym żądaniu wymusza wyjście do `api.github.com`: pętla w JS (a) wyczerpuje limit 60/h dla IP usera → feature na godzinę w `check_failed`, (b) generuje nieograniczoną liczbę połączeń wychodzących z demona (każde do 10 s). Ten sam wzorzec był P1 dla `spawnSync` w `/api/status` w review Fazy 4. Fix: cache wyniku `checkForUpdate()` z TTL ~15 min + odrzucanie cross-origin także dla tego GET-a.
2. **KOD · `lib/updater.js:168`** — deklarowany kontrakt „rewizja ze świeżego sprawdzenia po stronie serwera" NIE jest egzekwowany na macOS: serwer weryfikuje SHA czoła `AIBiz-Automatyzacje/claude-cron@main`, po czym odpala `git pull --ff-only`, który zaciąga to, co wskazuje `origin` i AKTUALNIE wymeldowana gałąź. Na maszynie dewelopera klik zaktualizuje feature branch; przy przejętym `origin` demon wykona cudzy kod mimo „zweryfikowanej" rewizji. Fix: `git fetch origin <sha> && git merge --ff-only <sha>` (SHA z `info.remote_revision`, już zwalidowany regexem), a przy `git rev-parse HEAD` != SHA nie zabijaj serwera i zwróć błąd.
3. **KOD · `public/app.js:476`** — `finishUpdateWatch` zakłada, że `updateWatch` nie jest nullem, a `pollUpdateProgress` biegnie z `setInterval` co 5 s bez guardu na nakładanie: pierwszy tick czyści `updateWatch`, kolejny (wznowiony po `await`) rzuca `TypeError` na `clearInterval(updateWatch.timer)` — unhandled rejection bez żadnego `console.*`. Fix: `if (!updateWatch) return;` na wejściu + ponowne sprawdzenie po awaicie.
4. **KOD · `public/render-helpers.js:325`** — komentarz obiecuje parytet z `revisionsMatch`/`MIN_REVISION_PREFIX` z `lib/updater.js`, ale front pomija normalizację (`trim().toLowerCase()`, `lib/updater.js:349`). Rewizja z `data/version.json` przechodzi tylko przez `pickString` (`lib/version.js:29`) — wielkie litery albo spacja dają `revisionsMatch(...)===false`, czyli komunikat o niepowodzeniu po udanej aktualizacji. Fix: normalizuj oba argumenty w `revisionsMatch`/`shortRevision`.
5. **KOD · `public/app.js:433`** — przy odpowiedzi błędnej `startPulsUpdate` robi `updateInfo = { ...(updateInfo||{}), ...body, ... }`, a serwer w gałęzi 409 zwraca CAŁY obiekt statusu (`{...info, started:false}`, `server.js:344`), więc `status` może przyjść jako `'current'` → `updateBarView` chowa pasek i komunikat „Nie udało się uruchomić aktualizacji" nigdy się nie pokazuje: klik kończy się CISZĄ. Fix: ustaw jawny stan (`status:'done'`, `can_update:false`, `message: body.error || …`) zamiast rozlewać `body`.
6. **KOD · `public/app.js:458`** — `fetch('/api/status')` w `pollUpdateProgress` bez timeoutu i `AbortController`, przy `setInterval` co 5 s przez 6 min: gdy serwer przyjmuje TCP, ale nie odpowiada, narasta do ~72 wiszących żądań do jednego originu (limit 6 połączeń/host zapycha też polling panelu co 3 s). Fix: `{ signal: AbortSignal.timeout(4000) }`.
7. **KOD · `public/index.html:944`** — pasek aktualizacji dostaje klasę `vps-addr` wyłącznie po to, żeby złapać override `.vps-addr[hidden]{display:none}` (`public/style.css:156`) — nazwa kłamie o przeznaczeniu elementu, a każdy przyszły pasek powtórzy sztuczkę. Fix: `.statbar[hidden], .stat[hidden] { display: none; }` (albo klasa `.subbar`) i zdjęcie `vps-addr` z `#update-bar`.
8. **KOD · `public/app.js:886`** — `finally { btn.disabled = false; }` odblokowuje przycisk również po SUKCESIE startu aktualizacji; jedyną barierą zostaje stan renderu (`updateBarView` + `if (updateWatch) return`) zamiast stanu akcji. Fix: przenieść do gałęzi błędu.
9. **KOD · `lib/updater.js:566`** — publiczne API modułu ma 12 symboli przy jednym realnym konsumencie (`checkForUpdate`, `startUpdate`); `REPO_SLUG`, `REPO_REF`, `normalizeRevision`, `MIN_REVISION_PREFIX`, `buildMacUpdateCommand` bez wywołania poza testami — ten sam finding zamknięto dla `lib/version.js` w review Fazy 1. Fix: usunąć nadmiarowe eksporty.
10. **KOD · `lib/updater.js:246`** — `if (child && typeof child.on === 'function')` / `typeof child.unref === 'function'`: gałęzie niemożliwe (`spawn` zawsze zwraca `ChildProcess`, atrapa `io` też ma obie metody), a defensywa maskowałaby realny błąd wstrzyknięcia cichym pominięciem handlera `'error'`. Fix: gołe `child.on('error', …)` i `child.unref()`.
11. **KOD · `lib/updater.js:67`** — `buildUpdateStatus` przyjmuje wstrzykiwane `now = new Date()` wyłącznie dla pola `checked_at`, którego nikt nie czyta i którego żaden test nie podaje. Fix: usunąć parametr (albo pole).
12. **KOD · `lib/updater.js:551`** — aktualizacja niediagnozowalna po fakcie: `stdio:'ignore'`, a obie komendy nie zapisują niczego na dysk; pad `git pull` na konflikcie lub fail-closed `install.ps1` zostawia wyłącznie generyczny komunikat po 6 min. Fix: przekierowanie do `data/update.log` (mac: `>> data/update.log 2>&1`; Windows: `*> data\update.log` / `Start-Transcript`) i wzmianka o pliku w komunikacie timeoutu (`public/app.js:905`).
13. **TEST · `public/render-helpers.test.js:534`** — brak pokrycia stanu `'done'` ustawianego przez `finishUpdateWatch` (`public/app.js:479`) — jedynego stanu, w którym pasek ma ZOSTAĆ widoczny bez przycisku i który nie pochodzi z serwera. Regresja „hidden = status !== 'available'" przeszłaby suitę. Fix: test `updateBarView({status:'done', can_update:false, message:'Zaktualizowano…'})` → `hidden:false`, `buttonHidden:true`.
14. **TEST · `lib/updater.test.js:789`** — `startUpdate` przetestowany wyłącznie dla `platform:'darwin'`; ścieżka Windows (jedyna, w której `hasGit:false` NIE blokuje startu i spawnowany jest `powershell`) nie przechodzi przez `startUpdate` w żadnym teście. Fix: test `startUpdate({platform:'win32', io: fakeIo({hasGit:false})})` → `kind==='windows'`, `command==='powershell'`, `windowsHide===true`.

---

## Zgodność ze spec

- **U11** — wszystkie artefakty IU obecne (`lib/updater.js`, `lib/updater.test.js`, endpointy, UI, tryb nieinteraktywny `install.ps1`). **Odchylenia udokumentowane w pliku zadań:** `CLAUDE_CRON_NONINTERACTIVE=1` pomija `setup.mjs`; czyste helpery frontu w `public/render-helpers.js`. **Odchylenia NIEudokumentowane (defekty):** kontrakt „po udanej aktualizacji panel wie o nowej wersji" nie działa na Macu (P1-1), „serwer wraca sam" nie jest zagwarantowane na Macu (P1-2), ścieżka Windows przerywa się na własnym `cwd` (P1-3). Deklarowany w komentarzu kontrakt bezpieczeństwa („rewizja z serwera, klient nie decyduje") nie jest egzekwowany na macOS (P3-2) ani pokryty testem (P2-5).
- **U12** — **niezweryfikowalne w tym repozytorium**: artefakty (`skills/onboard/SKILL.md`, `skills/onboard/templates/skrzynka.css`) leżą niezacommitowane w osobnym repo `aibiz-plugin`, więc diff Fazy 5 nie zawiera ani jednej linii tych zmian. Odhaczenie ✅ opiera się wyłącznie o `npm test` renderera, który nie dotyka pluginu. Wszystkie scenariusze U12 są [Manual] i wymagają pushu + `Update marketplace` + `/reload-plugins`, a push jest zabramkowany wyjaśnieniem cudzych zmian w `hooks/` (`D hooks/frontmatter-validate.sh`, `M hooks/hooks.json`) — usunięty hook walidacji frontmattera to zmiana o charakterze bezpieczeństwa/jakości w cudzym repo i musi zostać wyjaśniona z autorem PRZED pushem. Do czasu pushu `THEME_FIX_COMMAND` (`scripts/consistency-check.mjs:31`) świadomie podaje kroki ręczne — sygnał u odbiorcy pozostaje niepełny.
- **Pliki testowe z planu** — obecne: `lib/updater.test.js`, `public/render-helpers.test.js` (rozszerzony). Brak testu szwu HTTP dla `/api/update` (P2-5) i brak testów nowych gałęzi `install.ps1` mimo istniejącej suity Pester (P2-3).

---

## Bookkeeping checkboxów Weryfikacja:

- Odznaczone automatycznie (CLI/grep): **0** (wszystkie 3 checkboxy `Weryfikacja:` fazy 5 były już `[x]` po `/dev-docs-execute` — `node --test lib/updater.test.js` 21/21, `npm test` 952/952 ×2)
- Odznaczone na podstawie Agent 5 E2E: **0**
- Pozostawione dla operatora (Manual): **12** (3 pozycje „Operator checklist" U11 + 9 pozycji U12) — przeniesione do sekcji `## Operator checklist faza 5` w pliku zadań
- Niejasne (P3): **0**
- Failujące (P2): **0**

### Szczegóły

- [x] CLI: `node --test lib/updater.test.js` przechodzi → PASS (21/21) — odznaczone w fazie wykonania
- [x] CLI: `npm test` przechodzi w całości (U11) → PASS (952/952) — odznaczone w fazie wykonania
- [x] CLI: `npm test` przechodzi w całości (U12, regresja renderera) → PASS (952/952) — odznaczone w fazie wykonania
- [ ] Manual: „Windows: aktualizacja przy działającym daemonie → `data\` i `.node\` nietknięte, serwer wraca" — wymaga operatora (checklist)
- [ ] Manual: „Mac: aktualizacja → proces wraca sam, wersja w panelu nowa" — wymaga operatora (checklist)
- [ ] Manual: **Sprawdzenie M2** wg szablonu, na Macu i na CAVE — wymaga operatora (checklist)
- [ ] Manual: 9 pozycji „Operator checklist" U12 (push pluginu, `/reload-plugins`, pełna runda testowa) — wymaga operatora (checklist)

**Uwaga:** oba scenariusze [Manual] U11 są jedynymi sprawdzeniami, które wyłapałyby P1-1 i P1-2 — nie odhaczaj ich na podstawie zielonego `npm test`. Wykonać PO naprawie P1.

Severity gate po bookkeepingu: bez zmian — ⛔ **BLOKUJE** (P1-1, P1-2, P1-3).

---

## Przebieg review

| Etap | Wartosc |
|---|---|
| Pliki w fazie (z tego kodu) | 11 (6) |
| Flagi warstw | ui=true dane=true typowanie=false nowyModul=true |
| Browserowe checkboxy `Weryfikacja:` | 0 |
| Reviewerzy aktywni | security, performance, architecture, spec-compliance, simplicity, test-coverage, e2e |
| Reviewerzy pominieci | typescript (domena nieobecna w mapie zmian fazy) |
| Findingi: znalezione -> dedup JS -> dedup semantyczny | 59 -> 59 -> 33 |
| Adversarial verify: weryfikowane / obalone / bez glosow | 18 / 2 / 0 |
