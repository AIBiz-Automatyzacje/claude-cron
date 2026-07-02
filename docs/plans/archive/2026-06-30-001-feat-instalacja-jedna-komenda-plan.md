---
title: "feat: Instalacja Pulsa jedną komendą — Mac + Windows + VPS (bootstrap + auto-start + auto-open)"
type: feat
status: active
date: 2026-06-30
origin: docs/plans/2026-06-29-001-feat-ulatwienie-instalacji-plan.md
design_md: null          # pure-infra: bootstrap shell/ps1 + setup.mjs + README; brak UI
figma_spec: null
figma_screens: {}
---

# feat: Instalacja Pulsa jedną komendą (trójplatformowo)

## Przegląd

Domknięcie wizji „najłatwiejszej instalacji" na **wszystkich trzech torach** (Mac, Windows, VPS):
**otwórz terminal → wklej 1 komendę → odpowiedz na pytania → koniec** (serwer sam startuje,
przeglądarka sama się otwiera tam, gdzie jest GUI). Buduje na zakończonym zadaniu
`ulatwienie-instalacji` (portable Node + `node:sqlite` + `setup.mjs` + folder-picker — już na `main`).

Docelowe komendy:

**Mac/Linux:**
```
curl -fsSL https://raw.githubusercontent.com/AIBiz-Automatyzacje/claude-cron/main/install.sh | bash
```

**Windows (PowerShell):**
```
irm https://raw.githubusercontent.com/AIBiz-Automatyzacje/claude-cron/main/install.ps1 | iex
```

**VPS (Debian/Ubuntu, jako root):**
```
curl -fsSL https://raw.githubusercontent.com/AIBiz-Automatyzacje/claude-cron/main/scripts/install-vps.sh | sudo bash
```

Pełny przebieg usera (desktop): wkleja komendę → wyskakuje okno wyboru folderu (klika vault) → parę
Enterów (VPS/Discord opcjonalne) → `Y` autostart → **serwer sam się odpala** → **przeglądarka sama
otwiera `localhost:7777`** (plus link zawsze wypisany na wszelki wypadek). Zero `git`, zero `cd`,
zero ręcznego startu. VPS to osobny tor (robotnik na joby) — instalator VPS nie otwiera dashboardu.

## Ujęcie problemu

Audyt obecnego flow wykazał dopieszczony środek (`install.sh`/`install.ps1` + folder-picker) i poszarpane brzegi:
- **Wejście (🔴):** `git clone` na świeżym Macu odpala instalację Xcode Command Line Tools (dialog +
  setki MB), README nie ostrzega. Na Windows analogicznie wymaga ręcznego `git`. Plus ręczne
  `cd`/`clone` = ~5-6 komend zamiast jednej — na obu desktopach.
- **Wyjście (🔴):** ręczny start serwera brzydką, wersjonowaną ścieżką
  (`.node/node-v22.17.0-darwin-arm64/bin/node server.js` / `.node\node-v22.17.0-win-x64\node.exe server.js`)
  + ręczne „otwórz localhost:7777". Identyczny ból na Mac i Windows.

## Śledzenie wymagań

- **R1.** `install.sh` (Mac/Linux) uruchomiony przez `curl|bash` (brak repo obok) sam pobiera repo
  **bez `git`** (tarball przez `curl|tar`) do `~/claude-cron` i kontynuuje. Uruchomiony z już
  sklonowanego repo → działa po staremu (tryb dualny).
- **R2.** Pytania interaktywne działają pod `curl|bash` (fix TTY — stdin z `/dev/tty`).
- **R3.** `install.ps1` (Windows) uruchomiony przez `irm|iex` (brak repo obok) sam pobiera repo
  **bez `git`** (zip przez `Invoke-WebRequest` + `Expand-Archive`) do `$HOME\claude-cron` i
  kontynuuje. Uruchomiony z już sklonowanego repo → tryb lokalny (jak dziś). Pytania interaktywne
  działają pod `irm|iex`.
- **R4.** Po konfiguracji `setup.mjs` sam startuje serwer (portable Node + flaga) — koniec ręcznego
  kroku. Działa identycznie na Mac/Windows/Linux (kod współdzielony).
- **R5.** Po wystaniu serwera `setup.mjs` (uruchamiany TYLKO na Mac/Win) otwiera dashboard w domyślnej
  przeglądarce (`open` / `Start-Process`) **oraz zawsze wypisuje link** jako siatkę bezpieczeństwa.
  VPS go nie dotyczy — tam instancja to robotnik (joby przez systemd), nikt nie ogląda dashboardu.
- **R6.** README: oba one-linery (Mac + Windows) zamiast 6 kroków; VPS jako one-liner; korekta
  „2 pytania"→4; wzmianka o oknie wyboru folderu; usunięcie ręcznego startu serwera.

## Granice scope'u

- **Claude Code zostaje warunkiem wstępnym** — `setup.mjs` wykrywa brak `claude` i kieruje (login
  interaktywny, niemożliwy do automatyzacji). Bez zmian.
- **Windows = pełny parytet z Makiem** (w scope tego planu): dualny `install.ps1` + auto-start +
  auto-open. Współdzielony `setup.mjs` daje auto-start/auto-open Windowsowi niemal za darmo
  (gałąź `win32` w `resolveNodeBinPath`/`buildFolderPickerCommand` już istnieje).
- **VPS = robotnik, nie dashboard.** Instancja VPS istnieje tylko po to, by joby chodziły 24/7
  (systemd, root). Dashboard ogląda się wizualnie z Mac/Win — nie z VPS. `install-vps.sh` zostaje
  osobnym torem, **NIE przepisujemy go na dualny** i **nie woła `setup.mjs`** (już dziś tak jest).
  W scope dla VPS tylko **jedno**: udokumentowanie one-linera VPS w README. Auto-start/auto-open
  serwera dotyczy WYŁĄCZNIE Mac/Win. Pełna automatyzacja Tailscale/systemd = osobne zadanie, jeśli kiedyś potrzebne.
- **Nie zmieniamy** logiki DB/scheduler/hooka (poza dodaniem auto-startu i auto-open w setup.mjs).
- **Port 7777 zakładamy wolny** — świadome założenie. Nie obsługujemy kolizji (inny program / druga
  instancja na 7777). Logika auto-startu = „ping 7777 → jeśli nie odpowiada, odpal serwer"; jeśli coś
  obcego już słucha na 7777, akceptujemy że tego nie wykryjemy. Poza scope.

## Kontekst i research (ZWERYFIKOWANE w sesji — nie badać ponownie)

- **Repo PUBLIC** (`gh repo view` → `isPrivate:false`). `raw.githubusercontent.com/.../main/install.sh`
  (i `install.ps1`) oraz tarball `github.com/.../archive/refs/heads/main.tar.gz` → **HTTP 200 anonimowo**.
- **`curl` + `tar` wbudowane w macOS** (`/usr/bin/curl`, `/usr/bin/tar`) → repo bez `git`, bez brew.
- **Windows: `Invoke-WebRequest` (`irm`) + `Expand-Archive` wbudowane** w PowerShell 5.1+ (każdy
  Win10/11). GitHub serwuje też zip źródeł: `github.com/.../archive/refs/heads/main.zip` (rozpakowuje
  się do `claude-cron-main\`). Używamy zip + `Expand-Archive`, nie tar — natywniejsze na Windows.
- **Pułapka `curl|bash` + stdin (Mac):** pod potokiem stdin to skrypt, nie klawiatura → readline w
  `setup.mjs` dostałby EOF. Fix kanoniczny: uruchom node z `< /dev/tty`. Folder-picker (osascript) i
  tak działa bez stdin.
- **`irm|iex` + stdin (Windows) — DO ZWERYFIKOWANIA w implementacji:** przy `irm URL | iex` potok
  karmi *tekstem skryptu* polecenie `iex`; proces node uruchamiany przez `install.ps1`
  (`& $NodeExe setup.mjs`) dziedziczy konsolę jako stdin, **nie** potok — więc readline
  prawdopodobnie działa bez dodatkowego fixu. Zweryfikować empirycznie; gdyby jednak EOF —
  uruchomić node z jawnym przekierowaniem z konsoli. Folder-picker (PowerShell FolderBrowserDialog) działa bez stdin.
- **Auto-open przeglądarki (tylko Mac/Win):** macOS `open <url>` (wbudowane), Windows `Start-Process <url>`.
  Linux/headless pomijamy — VPS nie woła `setup.mjs`, a dashboard ogląda się z Mac/Win.
- **Auto-start:** wzorzec już istnieje w hooku (`setup.mjs` generuje spawn portable Node + flaga +
  caffeinate guard darwin) — reuse do startu serwera na końcu setupu, cross-platform.
- Stan obecny (na `main`):
  - `install.sh` (Mac/Linux) i `install.ps1` (Windows) — **bliźniacze cienkie bootstrapy** portable
    Node 22.17.0 + weryfikacja SHASUMS256 → handoff do `setup.mjs`. Oba dziś działają tylko z repo obok (brak trybu dualnego).
  - `setup.mjs` — **już cross-platform**: `resolveNodeBinPath` (win32/darwin/linux),
    `buildFolderPickerCommand` (darwin osascript / win32 PowerShell / null=fallback tekstowy),
    `detectPortableNodeBin`, generator hooka spawnujący detached serwer. Pytania, smoke-test.
  - `setup.test.mjs` (wzorzec testów pure helperów z DI na spawn).
  - `scripts/install-vps.sh` — samodzielny instalator VPS (systemd, root, `git clone`, Node z apt w oknie 22.13–<25).

## Kluczowe decyzje techniczne

- **Tryb dualny przez detekcję obecności `setup.mjs` obok skryptu — symetrycznie w `install.sh` i `install.ps1`.**
  Brak repo wokół → bootstrap: Mac `curl tarball | tar -xz`, Windows `Invoke-WebRequest zip` +
  `Expand-Archive`, do `~/claude-cron` / `$HOME\claude-cron`, potem dalej jak teraz.
- **Lokalizacja instalacji domyślnie `~/claude-cron` (Mac) / `$HOME\claude-cron` (Windows).** Jeśli
  istnieje → update zamiast duplikatu. **Strategia update = twardy kontrakt bezpieczeństwa danych (niżej), NIE detal implementacyjny.**
- **KONTRAKT UPDATE (re-run one-linera na istniejącej instalacji) — preserve-copy, atomowo:**
  Re-run one-linera to JEDYNA ścieżka update dla instalacji bez gita (bootstrap nie kopiuje `.git`),
  więc bootstrap MUSI obsłużyć istniejący katalog bezpiecznie:
  1. Rozpakuj świeże repo do tempa.
  2. **Przenieś `data/` i `.node/` ze starej instalacji do świeżej** PRZED podmianą (zero okna, w którym baza nie istnieje).
  3. Atomowy swap katalogów (świeży → docelowy, stary → kosz/temp).
  4. **Allowlist, nie blacklist:** zachowujemy jawnie wymienione `data/` + `.node/`; reszta to kod do nadpisania.
     Zweryfikowane w kodzie (`setup.mjs` 301-396): config usera (vault path, hook, Discord webhook) żyje
     **POZA** repo — w `{workspace}/.claude/` i w shell rc (`.zshrc`/`.bashrc`) — więc przeżywa re-extract
     automatycznie; jedyny stan w repo do ochrony to `data/` (baza) + `.node/` (portable Node). Preserve-lista krótka i pewna.
  5. Tryb lokalny (repo z `.git`) → bez zmian, update przez `git pull` jak dziś (one-liner go nie dotyczy).
- **Fix TTY (Mac):** zamiast `exec "$NODE_BIN" setup.mjs` → `"$NODE_BIN" setup.mjs < /dev/tty`
  (gdy `/dev/tty` dostępne; inaczej zwykłe uruchomienie — fallback dla środowisk bez TTY).
- **stdin Windows:** domyślnie bez zmian (`& $NodeExe setup.mjs`) — zweryfikować że readline czyta z
  konsoli pod `irm|iex`; dopiero gdyby EOF, dodać jawne przekierowanie.
- **Auto-start + auto-open jako kroki w `setup.mjs`** (nie w shellu, tylko Mac/Win) — `setup.mjs` zna
  `nodeBin` i ma wzorzec spawn; po smoke-teście: ping 7777 → jeśli down, spawn detached serwer; potem
  poll do odpowiedzi → **zawsze wypisz link** + `buildOpenBrowserCommand(platform, url)` → spawn (best-effort).
  Auto-open padło? Nic złego — user ma wypisany link. Pure helper `buildOpenBrowserCommand` testowalny
  jak `buildFolderPickerCommand`.

## Otwarte pytania

### Rozwiązane podczas planowania
- Repo public, curl/tar (Mac) i irm/Expand-Archive (Windows) dostępne, TTY-fix Mac konieczny — zweryfikowane.
- Lokalizacja: `~/claude-cron` / `$HOME\claude-cron`. Auto-start: tak. Auto-open: tak (Mac/Win; zawsze + link).
- Windows w scope (pełny parytet). VPS = robotnik, w scope tylko one-liner w README (zero zmian w setup.mjs dla VPS).

### Odroczone do implementacji
- Czas pollowania serwera przed open/print (np. retry ~10s) i zachowanie gdy serwer nie wstał.

(Weryfikacja pisania na Windows pod `irm|iex` NIE jest już odroczona — to GATE 0 Unitu 2, twardy pierwszy krok.)

## Implementation Units

- [x] **Unit 1: `install.sh` (Mac/Linux) tryb dualny — bootstrap przez curl|tar (bez git) + fix TTY** *(impl + testy headless: `bash -n` ✅, `install.test.sh` 4/4 ✅, grep ✅; operator pending)*

**Cel:** `curl|bash` pobiera repo bez `git` do `~/claude-cron` i odpala setup z działającym stdin.
**Wymagania:** R1, R2 · **Zależności:** brak · **Delegate:** feature-builder-data
**Skills in play:** security

**Pliki:**
- Modyfikuj: `install.sh` (detekcja trybu: `setup.mjs` obok skryptu? lokalny : bootstrap; bootstrap =
  `curl -fsSL <tarball> | tar -xz` do tmp → przenieś do `~/claude-cron` → `cd`; uruchom
  `"$NODE_BIN" setup.mjs < /dev/tty` z fallbackiem bez TTY)

**Podejście:**
- Tarball: `https://github.com/AIBiz-Automatyzacje/claude-cron/archive/refs/heads/main.tar.gz`
  (rozpakowuje się do `claude-cron-main/`). Zweryfikuj że `setup.mjs` istnieje po rozpakowaniu (fail fast).
- Tryb lokalny (repo obok) — bez zmian względem dziś.

**Scenariusze testowe:**
- [Unit/skrypt] `bash -n install.sh` bez błędów.
- [Manual] `curl|bash` na czystym katalogu → repo w `~/claude-cron`, setup startuje, pytania czytają z klawiatury.
- [Manual] Uruchomienie z już sklonowanego repo → tryb lokalny, bez pobierania tarballa.
- [Manual — KONTRAKT DANYCH] Re-run one-linera na istniejącej instalacji z plikiem-strażnikiem w
  `data/SENTINEL` → po update plik nadal istnieje, baza nietknięta, `.node/` zachowany (error case: ochrona przed kasowaniem bazy).

**Weryfikacja:**
- `bash -n install.sh` przechodzi.
- `grep -n "/dev/tty\|archive/refs/heads/main.tar.gz\|setup.mjs" install.sh` pokazuje fix TTY + bootstrap.

**Operator checklist:**
- [ ] Operator odpala one-liner na czystym Macu (lub w temp) i potwierdza pełny przebieg.

---

- [ ] **Unit 2: `install.ps1` (Windows) tryb dualny — bootstrap przez irm|Expand-Archive (bez git)** *(impl gotowa; PARTIAL — GATE 0 + parse-check + Pester wymagają realnego Windows, do operatora; headless zastępczo: nawiasy 40/40, grep ✅, referencyjny `install.test.sh` 4/4 ✅)*

**Cel:** `irm|iex` pobiera repo bez `git` do `$HOME\claude-cron` i odpala setup z działającymi pytaniami — parytet z Unitem 1.
**Wymagania:** R3 · **Zależności:** brak (równoległy do Unit 1) · **Delegate:** feature-builder-data
**Skills in play:** security

**⛔ GATE 0 (PIERWSZY KROK, przed budową reszty Unitu):** na realnej maszynie Windows zweryfikuj, że
pytania `setup.mjs` czytają wpisywany tekst pod `irm|iex` (analogia macowego problemu z „przejętą"
klawiaturą). Jeśli pisanie NIE działa (EOF/auto-defaulty) → najpierw dodaj łatkę „czytaj wprost z
konsoli" (odpowiednik `< /dev/tty` z Maca), dopiero potem buduj bootstrap/Expand-Archive. Nie
wdrażamy Windowsa na założeniu „prawdopodobnie działa".

**Pliki:**
- Modyfikuj: `install.ps1` (detekcja trybu: `Test-Path (Join-Path $PSScriptRoot setup.mjs)` → lokalny :
  bootstrap; bootstrap = `Invoke-WebRequest <zip> -OutFile tmp.zip` → `Expand-Archive` do tmp →
  przenieś `claude-cron-main\*` do `$HOME\claude-cron` → kontynuuj; handoff `& $NodeExe setup.mjs`)

**Podejście:**
- Zip: `https://github.com/AIBiz-Automatyzacje/claude-cron/archive/refs/heads/main.zip`
  (rozpakowuje się do `claude-cron-main\`). Zweryfikuj że `setup.mjs` istnieje po rozpakowaniu (fail fast, `throw`).
- Pod `irm|iex` `$PSScriptRoot` jest puste → użyj tego jako sygnału trybu bootstrap (brak skryptu na dysku = pobierz repo).
- stdin: rozstrzygane w GATE 0 (wyżej) — domyślnie bez zmian, ale weryfikacja pisania PRZED resztą; łatka jeśli EOF.
- Tryb lokalny (repo obok, `$PSScriptRoot` ustawione) — bez zmian względem dziś.

**Scenariusze testowe:**
- [Unit/skrypt] `powershell -NoProfile -Command "$null = [ScriptBlock]::Create((Get-Content -Raw install.ps1))"` (parse bez błędów; lub `Invoke-ScriptAnalyzer` jeśli dostępny).
- [Manual] `irm|iex` na czystym Windows → repo w `$HOME\claude-cron`, setup startuje, pytania czytają z klawiatury (happy path).
- [Manual] Uruchomienie z już sklonowanego repo → tryb lokalny, bez pobierania zip (error/edge case: skrypt na dysku).
- [Manual — KONTRAKT DANYCH] Re-run one-linera na istniejącej instalacji z plikiem-strażnikiem w
  `data\SENTINEL` → po update plik nadal istnieje, baza nietknięta, `.node\` zachowany (error case: ochrona przed kasowaniem bazy).

**Weryfikacja:**
- Parse PowerShell przechodzi bez błędów.
- `grep -n "archive/refs/heads/main.zip\|Expand-Archive\|setup.mjs\|PSScriptRoot" install.ps1` pokazuje bootstrap + detekcję trybu.

**Operator checklist:**
- [ ] Operator odpala one-liner na czystym Windows i potwierdza pełny przebieg (pytania + auto-start + auto-open).

---

- [x] **Unit 3: `setup.mjs` — auto-start serwera + auto-open przeglądarki (Mac/Win)** *(impl + testy: `node --test` 161/161 ✅, `node --check` ✅, grep ✅; operator pending)*

**Cel:** Po konfiguracji serwer startuje sam, ZAWSZE wypisuje link do dashboardu, a na Mac/Win dodatkowo
sam otwiera przeglądarkę (best-effort). VPS nie dotyczy — nie woła `setup.mjs`.
**Wymagania:** R4, R5 · **Zależności:** działa samodzielnie z lokalnego repo; korzysta z Unit 1/2 w trybie one-liner · **Delegate:** feature-builder-data
**Skills in play:** security

**Pliki:**
- Modyfikuj: `setup.mjs` (po smoke-teście: ping 7777 → jeśli down, spawn detached serwer portable
  Nodem + `--disable-warning`; poll do odpowiedzi; **zawsze `console.log` z linkiem**; potem
  `buildOpenBrowserCommand` → spawn best-effort; auto-open padło → nic nie robimy, link już jest)
- Test (unit): `setup.test.mjs`

**Podejście:**
- Reuse wzorca spawn z generatora hooka (`detectPortableNodeBin`/nodeBin, cwd=REPO_DIR, detached, unref, caffeinate guard darwin).
- Pure `buildOpenBrowserCommand(platform, url)` → `{cmd,args}`: darwin `open`, win32 `Start-Process`/`cmd /c start ""`;
  **null dla każdej innej platformy** (linux/headless) → caller nie spawnuje, polega na wypisanym linku. Bez detekcji DISPLAY/headless.

**Scenariusze testowe:**
- [Unit] `buildOpenBrowserCommand('darwin','http://localhost:7777')` → cmd `open` z URL (happy path).
- [Unit] `buildOpenBrowserCommand('win32', url)` → `Start-Process`/`cmd start` z URL.
- [Unit] `buildOpenBrowserCommand('linux', url)` → `null` (error case — caller nie crashuje, link wypisany).

**Weryfikacja:**
- `node --test setup.test.mjs` przechodzi (nowe testy zielone).
- `node --check setup.mjs` ok; `grep -n "buildOpenBrowserCommand\|open\|Start-Process" setup.mjs` pokazuje auto-open Mac/Win + wypisanie linku.

**Operator checklist:**
- [ ] Po one-linerze serwer działa i przeglądarka sama otwiera `localhost:7777` (Mac i Windows); link też widoczny w terminalu.

---

- [x] **Unit 4: README — trójplatformowe one-linery + korekty** *(impl + grep-weryfikacje ✅, „brzydki krok" usunięty; manualne przejścia czytelnika do operatora)*

**Cel:** Dokumentacja odzwierciedla flow „1 komenda" na każdym torze.
**Wymagania:** R6 · **Zależności:** Unit 1, 2, 3 · **Delegate:** feature-builder-data
**Skills in play:** security

**Pliki:**
- Modyfikuj: `README.md`:
  - Sekcja Mac: zastąp kroki 2-6 jednym one-linerem `curl ... install.sh | bash`.
  - Sekcja Windows: one-liner `irm ... install.ps1 | iex` zamiast ręcznych kroków.
  - Sekcja VPS: udokumentuj one-liner `curl ... install-vps.sh | sudo bash`.
  - Usuń ręczny start `.node/...server.js` (oba desktopy).
  - Popraw „pyta o 2 rzeczy"→4: workspace/VPS/Discord/autostart.
  - Wspomnij okno wyboru folderu (Mac osascript / Windows FolderBrowserDialog) zamiast „przeciągnij z Findera".
  - Dopisz że serwer i przeglądarka startują same (desktop); na VPS setup wypisuje URL.

**Scenariusze testowe:**
- [Manual] Czytelnik na czystym Macu przechodzi instalację samym one-linerem.
- [Manual] Czytelnik na czystym Windows przechodzi instalację samym one-linerem.

**Weryfikacja:**
- `grep -n "raw.githubusercontent.*install.sh" README.md` pokazuje one-liner Mac.
- `grep -n "raw.githubusercontent.*install.ps1" README.md` pokazuje one-liner Windows.
- `grep -n "install-vps.sh" README.md` pokazuje one-liner VPS.
- `grep -n "node-v22.17.0-darwin-arm64/bin/node server.js" README.md` zwraca pusto (brzydki ręczny krok usunięty).

## Ryzyka i zależności

- **`curl|bash` / `irm|iex` wykonuje kod z internetu** — świadomie akceptowane (standard branżowy);
  README ma już sekcję trust/„obejrzyj skrypt najpierw" + weryfikację SHASUMS256 portable Node. Zostawić/wzmocnić dla obu komend.
- **TTY (Mac):** w nietypowych terminalach/CI `/dev/tty` może nie istnieć → fallback bez TTY. Akceptowalne dla ścieżki desktopowej.
- **stdin (Windows):** ryzyko że pod `irm|iex` readline dostanie EOF — pokryć weryfikacją empiryczną w Unit 2; jeśli wystąpi, dodać przekierowanie z konsoli.
- **Update istniejącego katalogu (`~/claude-cron` / `$HOME\claude-cron`) — POKRYTE KONTRAKTEM (Decyzje techniczne):**
  re-run one-linera NIE może skasować `data/claude-cron.db` (baza usera!). Preserve-copy: przenieś `data/`+`.node/`
  do świeżego repo przed atomowym swapem; allowlist, nie blacklist. Najgroźniejsze ryzyko planu — dlatego ma
  jawny scenariusz testowy (re-run z plikiem-strażnikiem w `data/`), nie „pokryć w implementacji".
- **VPS:** świadomie zostaje osobnym torem (systemd/root, robotnik na joby) — nie woła `setup.mjs`,
  nie ma auto-open. Jedyny styk z tym planem to wpis one-linera w README (Unit 4).

## Plan testów

- `bash -n install.sh`, parse `install.ps1`, `node --check setup.mjs`, `node --test` (cały suite + nowe testy pure helperów).
- **Symulacja bootstrap bez ruszania repo dev (Mac):** pobrać tarball do katalogu tymczasowego i
  odpalić zmodyfikowany `install.sh` w trybie bootstrap z `INSTALL_DIR` na temp (nie `~/claude-cron`),
  zweryfikować rozpakowanie + obecność `setup.mjs`, posprzątać.
- **Symulacja bootstrap (Windows):** analogicznie pobrać zip do temp, `Expand-Archive`, zweryfikować `setup.mjs`, posprzątać.
- Build na branchu `feature/one-command-install`; merge do `main` dopiero po teście (one-liner pobiera
  `main`, więc zmiany muszą tam trafić, by działał „na produkcji").

## Wznowienie po wyczyszczeniu sesji

1. Stan wyjściowy: `ulatwienie-instalacji` ukończone i na `main` (portable Node + node:sqlite +
   folder-picker). VPS i Mac usera już działają na nowym kodzie. `install.ps1` istnieje jako bliźniak `install.sh` (cienki bootstrap).
2. Ten plan = next step, **trójplatformowy** (Mac + Windows pełny parytet, VPS lekko). Uruchom
   `/dev-docs` na tym pliku → potem `/dev-autopilot-wf` na `docs/active/instalacja-jedna-komenda`
   (git: branch `feature/one-command-install`, zwaliduj przed odpaleniem).
3. User dał GO: Windows w scope (pełny parytet), VPS = robotnik (tylko one-liner w README, zero zmian w setup.mjs). Do
   potwierdzenia przed mergem: strategia update katalogu (NIE kasować `data/`) na obu desktopach.

## Źródła i referencje

- **Plan-rodzic (ukończony):** docs/plans/2026-06-29-001-feat-ulatwienie-instalacji-plan.md
  (archiwum: docs/completed/ulatwienie-instalacji/).
- Kod: `install.sh` (Mac/Linux), `install.ps1` (Windows), `setup.mjs` (cross-platform helpers),
  `setup.test.mjs`, `README.md`, `scripts/install-vps.sh` (osobny tor VPS).
- Zweryfikowane fakty środowiskowe w treści (repo public, curl/tar, irm/Expand-Archive, TTY, open/Start-Process).
</content>
</invoke>
