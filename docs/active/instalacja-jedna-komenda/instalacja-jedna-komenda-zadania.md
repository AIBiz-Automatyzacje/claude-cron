# Zadania: Instalacja Pulsa jedną komendą

**Branch:** `feature/one-command-install`
**Ostatnia aktualizacja:** 2026-06-30

Legenda: zwykły checkbox = implementacja · `Test:` = scenariusz testowy · `Weryfikacja:` = kryterium weryfikacji.

---

## Unit 1 — `install.sh` (Mac/Linux) tryb dualny + fix TTY · M

- [ ] Modyfikuj `install.sh`: detekcja trybu (`setup.mjs` obok skryptu? lokalny : bootstrap)
- [ ] Bootstrap: `curl -fsSL <tarball> | tar -xz` do tmp → przenieś do `~/claude-cron` → `cd`
- [ ] Fail-fast: zweryfikuj że `setup.mjs` istnieje po rozpakowaniu
- [ ] Uruchom `"$NODE_BIN" setup.mjs < /dev/tty` z fallbackiem bez TTY
- [ ] Kontrakt danych: przy istniejącym `~/claude-cron` zachowaj `data/` + `.node/` (allowlist, atomowy swap)
- [ ] Test: `bash -n install.sh` bez błędów
- [ ] Test: `curl|bash` na czystym katalogu → repo w `~/claude-cron`, setup startuje, pytania czytają z klawiatury
- [ ] Test: uruchomienie z już sklonowanego repo → tryb lokalny, bez pobierania tarballa
- [ ] Test: [KONTRAKT DANYCH] re-run one-linera z plikiem `data/SENTINEL` → po update plik istnieje, baza nietknięta, `.node/` zachowany
- [ ] Weryfikacja: `bash -n install.sh` przechodzi
- [ ] Weryfikacja: `grep -n "/dev/tty\|archive/refs/heads/main.tar.gz\|setup.mjs" install.sh` pokazuje fix TTY + bootstrap
- [ ] Operator: odpalenie one-linera na czystym Macu (lub w temp) — potwierdzenie pełnego przebiegu

---

## Unit 2 — `install.ps1` (Windows) tryb dualny + GATE 0 · L

- [ ] **⛔ GATE 0 (PIERWSZY KROK):** na realnym Windows zweryfikuj, że pytania `setup.mjs` czytają wpisywany tekst pod `irm|iex`
- [ ] GATE 0: jeśli pisanie NIE działa (EOF/auto-defaulty) → dodaj łatkę „czytaj wprost z konsoli" PRZED budową bootstrapu
- [ ] Modyfikuj `install.ps1`: detekcja trybu (`Test-Path $PSScriptRoot\setup.mjs` / puste `$PSScriptRoot` = bootstrap)
- [ ] Bootstrap: `Invoke-WebRequest <zip> -OutFile tmp.zip` → `Expand-Archive` do tmp → przenieś `claude-cron-main\*` do `$HOME\claude-cron`
- [ ] Fail-fast (`throw`): zweryfikuj że `setup.mjs` istnieje po rozpakowaniu
- [ ] Handoff `& $NodeExe setup.mjs`
- [ ] Kontrakt danych: przy istniejącym `$HOME\claude-cron` zachowaj `data\` + `.node\` (allowlist, atomowy swap)
- [ ] Test: parse PowerShell — `powershell -NoProfile -Command "$null = [ScriptBlock]::Create((Get-Content -Raw install.ps1))"` bez błędów
- [ ] Test: `irm|iex` na czystym Windows → repo w `$HOME\claude-cron`, setup startuje, pytania czytają z klawiatury (happy path)
- [ ] Test: uruchomienie z już sklonowanego repo → tryb lokalny, bez pobierania zip (skrypt na dysku)
- [ ] Test: [KONTRAKT DANYCH] re-run one-linera z plikiem `data\SENTINEL` → po update plik istnieje, baza nietknięta, `.node\` zachowany
- [ ] Weryfikacja: parse PowerShell przechodzi bez błędów
- [ ] Weryfikacja: `grep -n "archive/refs/heads/main.zip\|Expand-Archive\|setup.mjs\|PSScriptRoot" install.ps1` pokazuje bootstrap + detekcję trybu
- [ ] Operator: odpalenie one-linera na czystym Windows — potwierdzenie pełnego przebiegu (pytania + auto-start + auto-open)

---

## Unit 3 — `setup.mjs` auto-start + auto-open (Mac/Win) · M

- [ ] Modyfikuj `setup.mjs`: po smoke-teście ping 7777 → jeśli down, spawn detached serwer portable Nodem + `--disable-warning`
- [ ] Poll do odpowiedzi serwera
- [ ] ZAWSZE `console.log` z linkiem do dashboardu (siatka bezpieczeństwa)
- [ ] Pure `buildOpenBrowserCommand(platform, url)`: darwin `open`, win32 `Start-Process`/`cmd /c start ""`, inne → `null`
- [ ] Auto-open best-effort (spawn) na Mac/Win; padło → nic nie robimy, link już wypisany
- [ ] Reuse wzorca spawn z generatora hooka (detached, unref, caffeinate guard darwin)
- [ ] Test: `buildOpenBrowserCommand('darwin','http://localhost:7777')` → cmd `open` z URL (happy path)
- [ ] Test: `buildOpenBrowserCommand('win32', url)` → `Start-Process`/`cmd start` z URL
- [ ] Test: `buildOpenBrowserCommand('linux', url)` → `null` (error case — caller nie crashuje, link wypisany)
- [ ] Weryfikacja: `node --test setup.test.mjs` przechodzi (nowe testy zielone)
- [ ] Weryfikacja: `node --check setup.mjs` ok; `grep -n "buildOpenBrowserCommand\|open\|Start-Process" setup.mjs` pokazuje auto-open Mac/Win + wypisanie linku
- [ ] Operator: po one-linerze serwer działa i przeglądarka sama otwiera `localhost:7777` (Mac i Windows); link też widoczny w terminalu

---

## Unit 4 — README trójplatformowe one-linery · S

- [ ] Sekcja Mac: zastąp kroki 2-6 one-linerem `curl ... install.sh | bash`
- [ ] Sekcja Windows: one-liner `irm ... install.ps1 | iex`
- [ ] Sekcja VPS: udokumentuj one-liner `curl ... install-vps.sh | sudo bash`
- [ ] Usuń ręczny start `.node/...server.js` (oba desktopy)
- [ ] Popraw „pyta o 2 rzeczy"→4 (workspace/VPS/Discord/autostart)
- [ ] Wspomnij okno wyboru folderu (Mac osascript / Windows FolderBrowserDialog)
- [ ] Dopisz że serwer i przeglądarka startują same (desktop)
- [ ] Test: czytelnik na czystym Macu przechodzi instalację samym one-linerem
- [ ] Test: czytelnik na czystym Windows przechodzi instalację samym one-linerem
- [ ] Weryfikacja: `grep -n "raw.githubusercontent.*install.sh" README.md` pokazuje one-liner Mac
- [ ] Weryfikacja: `grep -n "raw.githubusercontent.*install.ps1" README.md` pokazuje one-liner Windows
- [ ] Weryfikacja: `grep -n "install-vps.sh" README.md` pokazuje one-liner VPS
- [ ] Weryfikacja: `grep -n "node-v22.17.0-darwin-arm64/bin/node server.js" README.md` zwraca pusto (brzydki krok usunięty)

---

## Plan testów (całość)

- [ ] `bash -n install.sh`, parse `install.ps1`, `node --check setup.mjs`, `node --test` (cały suite + nowe testy)
- [ ] Symulacja bootstrap Mac: tarball do temp, `INSTALL_DIR` na temp (nie `~/claude-cron`), weryfikacja rozpakowania + `setup.mjs`, sprzątanie
- [ ] Symulacja bootstrap Windows: zip do temp, `Expand-Archive`, weryfikacja `setup.mjs`, sprzątanie
- [ ] Merge do `main` dopiero po teście na realnych maszynach (one-liner pobiera `main`)
</content>
