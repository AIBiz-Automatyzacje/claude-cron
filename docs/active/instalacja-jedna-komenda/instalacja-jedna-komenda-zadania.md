# Zadania: Instalacja Pulsa jedną komendą

**Branch:** `feature/one-command-install`
**Ostatnia aktualizacja:** 2026-06-30

Legenda: zwykły checkbox = implementacja · `Test:` = scenariusz testowy · `Weryfikacja:` = kryterium weryfikacji.

---

## Unit 1 — `install.sh` (Mac/Linux) tryb dualny + fix TTY · M

- [x] Modyfikuj `install.sh`: detekcja trybu (`setup.mjs` obok skryptu? lokalny : bootstrap)
- [x] Bootstrap: `curl -fsSL <tarball> | tar -xz` do tmp → przenieś do `~/claude-cron` → `cd`
- [x] Fail-fast: zweryfikuj że `setup.mjs` istnieje po rozpakowaniu
- [x] Uruchom `"$NODE_BIN" setup.mjs < /dev/tty` z fallbackiem bez TTY
- [x] Kontrakt danych: przy istniejącym `~/claude-cron` zachowaj `data/` + `.node/` (allowlist, atomowy swap)
- [x] Test: `bash -n install.sh` bez błędów
- [x] Test: `curl|bash` na czystym katalogu → repo w `~/claude-cron`, setup startuje, pytania czytają z klawiatury (symulacja skryptowa `install.test.sh`)
- [x] Test: uruchomienie z już sklonowanego repo → tryb lokalny, bez pobierania tarballa
- [x] Test: [KONTRAKT DANYCH] re-run one-linera z plikiem `data/SENTINEL` → po update plik istnieje, baza nietknięta, `.node/` zachowany
- [x] Weryfikacja: `bash -n install.sh` przechodzi
- [x] Weryfikacja: `grep -n "/dev/tty\|archive/refs/heads/main.tar.gz\|setup.mjs" install.sh` pokazuje fix TTY + bootstrap
- [x] Operator: odpalenie one-linera na czystym Macu (lub w temp) — ✅ 2026-07-01: pełny przebieg w sandboxie (curl|tar, portable Node, folder picker osascript, pytania z `/dev/tty` czekały i czytały klawiaturę, link, auto-open)

---

## Unit 2 — `install.ps1` (Windows) tryb dualny + GATE 0 · L

- [x] **⛔ GATE 0 (PIERWSZY KROK):** na realnym Windows zweryfikuj, że pytania `setup.mjs` czytają wpisywany tekst pod `irm|iex` — ✅ ZWERYFIKOWANE 2026-07-01 (Win11 + PS 5.1): pytania czekają i czytają klawiaturę
- [x] GATE 0: jeśli pisanie NIE działa → łatka „czytaj z konsoli" — N/A: stdin działa, łatka `CONIN$` NIEpotrzebna
- [x] Modyfikuj `install.ps1`: detekcja trybu (`Test-Path $PSScriptRoot\setup.mjs` / puste `$PSScriptRoot` = bootstrap)
- [x] Bootstrap: `Invoke-WebRequest <zip> -OutFile tmp.zip` → `Expand-Archive` do tmp → przenieś `claude-cron-main\*` do `$HOME\claude-cron`
- [x] Fail-fast (`throw`): zweryfikuj że `setup.mjs` istnieje po rozpakowaniu
- [x] Handoff `& $NodeExe setup.mjs`
- [x] Kontrakt danych: przy istniejącym `$HOME\claude-cron` zachowaj `data\` + `.node\` (allowlist, atomowy swap)
- [x] Test: parse PowerShell — ✅ 2026-07-01 `PARSE OK` (`Get-Content -Raw -Encoding UTF8` — plik jest UTF-8 bez BOM)
- [x] Test: `irm|iex` na czystym Windows → repo w `$HOME\claude-cron`, setup startuje, pytania czytają z klawiatury (happy path) — ✅ 2026-07-01 (test z brancha przez env-override)
- [x] Test: [SUITE] `install.ps1.Tests.ps1` (preserve/swap, parytet 1:1) — ✅ 2026-07-01 `4 PASS / 4`. Tryb lokalny PS 5.1 NAPRAWIONY (`install.ps1` = czyste ASCII): `PARSE OK` pod DOMYŚLNYM kodowaniem (bez `-Encoding UTF8`)
- [x] Test: [KONTRAKT DANYCH] re-run z `data\SENTINEL` → plik istnieje, baza nietknięta, `.node\` zachowany — ✅ 2026-07-01 (suite PASS + potwierdzone live: „Node już obecny - pomijam pobieranie")
- [x] Weryfikacja: parse PowerShell przechodzi bez błędów — ✅ 2026-07-01 `PARSE OK`
- [x] Weryfikacja: `grep -n "archive/refs/heads/main.zip\|Expand-Archive\|setup.mjs\|PSScriptRoot" install.ps1` pokazuje bootstrap + detekcję trybu
- [x] Operator: odpalenie one-linera na czystym Windows — ✅ 2026-07-01: pełny przebieg (pytania + auto-start + auto-open + link + okno zostaje otwarte)

---

## Unit 3 — `setup.mjs` auto-start + auto-open (Mac/Win) · M

- [x] Modyfikuj `setup.mjs`: po smoke-teście ping 7777 → jeśli down, spawn detached serwer portable Nodem + `--disable-warning`
- [x] Poll do odpowiedzi serwera
- [x] ZAWSZE `console.log` z linkiem do dashboardu (siatka bezpieczeństwa)
- [x] Pure `buildOpenBrowserCommand(platform, url)`: darwin `open`, win32 `Start-Process`/`cmd /c start ""`, inne → `null`
- [x] Auto-open best-effort (spawn) na Mac/Win; padło → nic nie robimy, link już wypisany
- [x] Reuse wzorca spawn z generatora hooka (detached, unref, caffeinate guard darwin)
- [x] Test: `buildOpenBrowserCommand('darwin','http://localhost:7777')` → cmd `open` z URL (happy path)
- [x] Test: `buildOpenBrowserCommand('win32', url)` → `Start-Process`/`cmd start` z URL
- [x] Test: `buildOpenBrowserCommand('linux', url)` → `null` (error case — caller nie crashuje, link wypisany)
- [x] Weryfikacja: `node --test setup.test.mjs` przechodzi (nowe testy zielone)
- [x] Weryfikacja: `node --check setup.mjs` ok; `grep -n "buildOpenBrowserCommand\|open\|Start-Process" setup.mjs` pokazuje auto-open Mac/Win + wypisanie linku
- [x] Operator: po one-linerze serwer działa i przeglądarka sama otwiera `localhost:7777` (Mac i Windows); link też widoczny w terminalu — ✅ 2026-07-01 Windows + Mac (oba: serwer + auto-open + link)

---

## Unit 4 — README trójplatformowe one-linery · S

- [x] Sekcja Mac: zastąp kroki 2-6 one-linerem `curl ... install.sh | bash`
- [x] Sekcja Windows: one-liner `irm ... install.ps1 | iex`
- [x] Sekcja VPS: udokumentuj one-liner `curl ... install-vps.sh | sudo bash`
- [x] Usuń ręczny start `.node/...server.js` (oba desktopy)
- [x] Popraw „pyta o 2 rzeczy"→4 (workspace/VPS/Discord/autostart)
- [x] Wspomnij okno wyboru folderu (Mac osascript / Windows FolderBrowserDialog)
- [x] Dopisz że serwer i przeglądarka startują same (desktop)
- [x] Test: czytelnik na czystym Macu przechodzi instalację samym one-linerem — ✅ 2026-07-01 (operator: pełny przebieg z brancha przez env-override)
- [x] Test: czytelnik na czystym Windows przechodzi instalację samym one-linerem — ✅ 2026-07-01 (operator: pełny przebieg z brancha)
- [x] Weryfikacja: `grep -n "raw.githubusercontent.*install.sh" README.md` pokazuje one-liner Mac
- [x] Weryfikacja: `grep -n "raw.githubusercontent.*install.ps1" README.md` pokazuje one-liner Windows
- [x] Weryfikacja: `grep -n "install-vps.sh" README.md` pokazuje one-liner VPS
- [x] Weryfikacja: `grep -n "node-v22.17.0-darwin-arm64/bin/node server.js" README.md` zwraca pusto (brzydki krok usunięty)

---

## Plan testów (całość)

- [x] `bash -n install.sh`, `node --check setup.mjs`, `node --test` (cały suite + nowe testy — 161/161 PASS); parse `install.ps1` → OPERATOR/Windows (brak pwsh na macOS)
- [x] Symulacja bootstrap Mac: tarball do temp, `INSTALL_DIR` na temp (nie `~/claude-cron`), weryfikacja rozpakowania + `setup.mjs`, sprzątanie (`install.test.sh` 4/4 PASS)
- [x] Symulacja bootstrap Windows: zip do temp, `Expand-Archive`, weryfikacja `setup.mjs`, sprzątanie — ✅ 2026-07-01 `install.ps1.Tests.ps1` 4/4 PASS na realnym Win11 + PS 5.1
- [ ] Merge do `main` dopiero po teście na realnych maszynach (one-liner pobiera `main`) — Windows ✅; Mac ⏳ (opcjonalnie szybki test w temp)

---

## Dziennik testów Windows (2026-07-01) — dodatkowa praca poza pierwotnymi 4 Unitami

Testy operatorskie na realnym Win11 + PowerShell 5.1 wykryły i naprawiły (wszystko na branchu, zweryfikowane live):

1. **env-override źródła bootstrapu** (`CLAUDE_CRON_TARBALL_URL`/`ZIP_URL` + `TOPDIR`, default `main`) — umożliwia test z brancha PRZED mergem bez ruszania `main`. Zostaje jako feature (forki/mirrory).
2. **Fix: `exit` w `Invoke-Setup` zamykał sesję PowerShell pod `irm|iex`** → guard `if ($PSScriptRoot) { exit }`; operator widzi link do dashboardu.
3. **Fix kodowania `.ps1`**: PS 5.1 czyta plik bez BOM jako ANSI. `install.ps1` MUSI być bez BOM (BOM łamie `irm|iex` → `﻿#`), więc znaki strukturalne → ASCII (em-dash/strzałka/emoji), diakrytyki zostają. `install.ps1.Tests.ps1` → BOM + ładuje `install.ps1` przez jawny odczyt UTF-8.
4. **Fix: persystencja env pisała do `.zshrc` na Windows** (nieczytany) → win32 do User Environment (`[Environment]::SetEnvironmentVariable(...,'User')`), Unix bez zmian. Zweryfikowane w rejestrze.
5. **Kosmetyka**: komunikaty bez zahardkodowanego „main"/„Mac".

**Decyzja ROZWIĄZANA (2026-07-01):** wybrano (a) — `install.ps1` przetransliterowany na **czyste ASCII**. Działa na każdej ścieżce (`irm|iex` + `.\install.ps1` + `-File`) i wersji PS (5.1/7). Diakrytyki zniknęły tylko z ~12 linii cienkiego bootstrapu; `setup.mjs` (główny UX) i `install.sh` (Mac) zachowują pełny polski. Zweryfikowane live: `PARSE OK` pod domyślnym kodowaniem + suite 4/4.

**Znany drobiazg UX (nie blokuje):** okno wyboru folderu (FolderBrowserDialog) potrafi wyskoczyć ZA terminalem — wygląda jak zawieszenie, trzeba Alt+Tab. Kandydat na hardening (okno topmost).
</content>
