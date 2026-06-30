---
title: "feat: Instalacja Pulsa jedną komendą (curl|bash bootstrap + auto-start + auto-open przeglądarki)"
type: feat
status: active
date: 2026-06-30
origin: docs/plans/2026-06-29-001-feat-ulatwienie-instalacji-plan.md
design_md: null          # pure-infra: bootstrap shell + setup.mjs + README; brak UI
figma_spec: null
figma_screens: {}
---

# feat: Instalacja Pulsa jedną komendą

## Przegląd

Domknięcie wizji „najłatwiejszej instalacji": **otwórz Terminal → wklej 1 komendę → odpowiedz na
pytania → koniec** (serwer sam startuje, przeglądarka sama się otwiera). Buduje na zakończonym
zadaniu `ulatwienie-instalacji` (portable Node + `node:sqlite` + `setup.mjs` + folder-picker —
już na `main`).

Docelowa komenda (Mac):
```
curl -fsSL https://raw.githubusercontent.com/AIBiz-Automatyzacje/claude-cron/main/install.sh | bash
```

Pełny przebieg usera: wkleja komendę → wyskakuje okno wyboru folderu (klika vault) → parę Enterów
(VPS/Discord opcjonalne) → `Y` autostart → **serwer sam się odpala** → **przeglądarka sama otwiera
`localhost:7777`**. Zero `git`, zero `cd`, zero ręcznego startu, zero „otwórz przeglądarkę".

## Ujęcie problemu

Audyt obecnego flow (z sesji) wykazał dopieszczony środek (`install.sh` + folder-picker) i poszarpane
brzegi:
- **Wejście (🔴):** `git clone` na świeżym Macu odpala instalację Xcode Command Line Tools (dialog +
  setki MB), README nie ostrzega. Plus ręczne `cd`/`clone` = ~5-6 komend zamiast jednej.
- **Wyjście (🔴):** ręczny start serwera brzydką, wersjonowaną ścieżką
  `.node/node-v22.17.0-darwin-arm64/bin/node server.js` (Intel musi podmienić arch; podbicie wersji
  Node psuje README) + ręczne „otwórz localhost:7777".

## Śledzenie wymagań

- **R1.** `install.sh` uruchomiony przez `curl|bash` (brak repo obok) sam pobiera repo **bez `git`**
  (tarball przez `curl|tar`) do `~/claude-cron` i kontynuuje. Uruchomiony z już sklonowanego repo →
  działa po staremu (tryb dualny).
- **R2.** Pytania interaktywne działają pod `curl|bash` (fix TTY — stdin z `/dev/tty`).
- **R3.** Po konfiguracji `setup.mjs` sam startuje serwer (portable Node + flaga) — koniec ręcznego kroku.
- **R4.** Po wystaniu serwera `setup.mjs` sam otwiera dashboard w domyślnej przeglądarce; fallback =
  wypisanie URL gdy brak GUI.
- **R5.** README: Mac flow zastąpiony one-linerem; korekta „2 pytania"→4; wzmianka o oknie wyboru folderu.

## Granice scope'u

- **Claude Code zostaje warunkiem wstępnym** — `setup.mjs` wykrywa brak `claude` i kieruje (login
  interaktywny, niemożliwy do automatyzacji). Bez zmian.
- **VPS/Tailscale to osobny tor** (`install-vps.sh`) — one-liner dotyczy lokalnego Mac/Win.
- **Windows:** analogiczny `install.ps1` + `Start-Process` — w tym planie skupiamy się na Mac; Win
  domknąć tym samym wzorcem (osobny IU lub follow-up, jeśli czas).
- **Nie zmieniamy** logiki DB/scheduler/hooka (poza dodaniem auto-startu i auto-open w setup.mjs).

## Kontekst i research (ZWERYFIKOWANE w sesji — nie badać ponownie)

- **Repo PUBLIC** (`gh repo view` → `isPrivate:false`). `raw.githubusercontent.com/.../main/install.sh`
  i tarball `github.com/.../archive/refs/heads/main.tar.gz` → **HTTP 200 anonimowo**.
- **`curl` + `tar` wbudowane w macOS** (`/usr/bin/curl`, `/usr/bin/tar`) → repo bez `git`, bez brew.
- **Pułapka `curl|bash` + stdin:** pod potokiem stdin to skrypt, nie klawiatura → readline w
  `setup.mjs` dostałby EOF. Fix kanoniczny: uruchom node z `< /dev/tty`. Folder-picker (osascript) i
  tak działa bez stdin.
- **Auto-open przeglądarki:** macOS `open <url>` (wbudowane), Windows `Start-Process <url>`, Linux `xdg-open`.
- **Auto-start:** wzorzec już istnieje w hooku (`setup.mjs` generuje spawn portable Node + flaga +
  caffeinate darwin) — reuse do startu serwera na końcu setupu.
- Stan obecny (na `main`): `install.sh` (bootstrap portable Node 22.17.0 + SHASUMS256 → `exec node setup.mjs`),
  `setup.mjs` (pytania, folder-picker `buildFolderPickerCommand`/`parseFolderPickerResult`, hook,
  smoke-test), `setup.test.mjs` (wzorzec testów pure helperów z DI na spawn).

## Kluczowe decyzje techniczne

- **Tryb dualny `install.sh` przez detekcję obecności `setup.mjs` obok skryptu.** Pod `curl|bash`
  skrypt nie ma repo wokół → bootstrap: `curl tarball | tar -xz` do `~/claude-cron`, `cd`, dalej jak teraz.
- **Lokalizacja instalacji domyślnie `~/claude-cron`.** Jeśli istnieje → update (ponowne rozpakowanie/
  zachowanie `.node` i `data/`) zamiast duplikatu. (Dokładna strategia update — odroczone do implementacji.)
- **Fix TTY:** zamiast `exec "$NODE_BIN" setup.mjs` → uruchom `"$NODE_BIN" setup.mjs < /dev/tty`
  (gdy `/dev/tty` dostępne; inaczej zwykłe uruchomienie — fallback dla środowisk bez TTY).
- **Auto-start + auto-open jako kroki w `setup.mjs`** (nie w shellu) — `setup.mjs` zna `nodeBin` i ma
  wzorzec spawn; po smoke-teście: ping 7777 → jeśli down, spawn detached serwer; potem poll do
  odpowiedzi → `open`/`Start-Process` URL. Pure helper `buildOpenBrowserCommand(platform, url)`
  testowalny jak `buildFolderPickerCommand`.

## Otwarte pytania

### Rozwiązane podczas planowania
- Repo public, curl/tar dostępne, TTY-fix konieczny — wszystko zweryfikowane (wyżej).
- Lokalizacja: `~/claude-cron`. Auto-start: tak. Auto-open: tak.

### Odroczone do implementacji
- Strategia update gdy `~/claude-cron` już istnieje (re-extract vs zachowanie `data/`/`.node/`).
- Czas pollowania serwera przed `open` (np. retry ~10s) i zachowanie gdy serwer nie wstał.
- Czy domknąć Windows (`install.ps1` + `Start-Process`) w tym samym zadaniu czy follow-up.

## Implementation Units

- [ ] **Unit 1: `install.sh` tryb dualny — bootstrap przez curl|tar (bez git) + fix TTY**

**Cel:** `curl|bash` pobiera repo bez `git` do `~/claude-cron` i odpala setup z działającym stdin.
**Wymagania:** R1, R2 · **Zależności:** brak · **Delegate:** feature-builder-data
**Skills in play:** supabase-dev-guidelines, security, sentry-integration

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

**Weryfikacja:**
- `bash -n install.sh` przechodzi.
- `grep -n "/dev/tty\|archive/refs/heads/main.tar.gz\|setup.mjs" install.sh` pokazuje fix TTY + bootstrap.

**Operator checklist:**
- [ ] Operator odpala one-liner na czystym Macu (lub w temp) i potwierdza pełny przebieg.

---

- [ ] **Unit 2: `setup.mjs` — auto-start serwera + auto-open przeglądarki**

**Cel:** Po konfiguracji serwer startuje sam i otwiera się dashboard — zero ręcznych kroków po pytaniach.
**Wymagania:** R3, R4 · **Zależności:** Unit 1 (działa też samodzielnie z lokalnego repo) · **Delegate:** feature-builder-data
**Skills in play:** supabase-dev-guidelines, security, sentry-integration

**Pliki:**
- Modyfikuj: `setup.mjs` (po smoke-teście: ping 7777 → jeśli down, spawn detached serwer portable
  Nodem + `--disable-warning`; poll do odpowiedzi; potem `buildOpenBrowserCommand` + spawn; fallback = print URL)
- Test (unit): `setup.test.mjs`

**Podejście:**
- Reuse wzorca spawn z generatora hooka (`detectPortableNodeBin`/nodeBin, cwd=REPO_DIR, detached, unref, caffeinate darwin).
- Pure `buildOpenBrowserCommand(platform, url)` → `{cmd,args}`: darwin `open`, win32 `cmd /c start ""`, linux `xdg-open`; null dla nieobsługiwanych.

**Scenariusze testowe:**
- [Unit] `buildOpenBrowserCommand('darwin','http://localhost:7777')` → cmd `open` z URL.
- [Unit] `buildOpenBrowserCommand('win32', url)` → `Start-Process`/`cmd start` z URL.
- [Unit] `buildOpenBrowserCommand('linux', url)` → `xdg-open`; platforma nieobsługiwana → null (error case).

**Weryfikacja:**
- `node --test setup.test.mjs` przechodzi (nowe testy zielone).
- `node --check setup.mjs` ok; `grep -n "buildOpenBrowserCommand\|open\|Start-Process" setup.mjs` pokazuje auto-open.

**Operator checklist:**
- [ ] Po one-linerze serwer działa i przeglądarka sama otwiera `localhost:7777` (Mac).

---

- [ ] **Unit 3: README — one-liner zamiast 6 kroków + korekty**

**Cel:** Dokumentacja odzwierciedla flow „1 komenda".
**Wymagania:** R5 · **Zależności:** Unit 1, Unit 2 · **Delegate:** feature-builder-data
**Skills in play:** supabase-dev-guidelines, security, sentry-integration

**Pliki:**
- Modyfikuj: `README.md` (sekcja Mac: zastąp kroki 2-6 jednym one-linerem; usuń ręczny start
  `.node/...server.js`; popraw „pyta o 2 rzeczy"→4: workspace/VPS/Discord/autostart; wspomnij okno
  wyboru folderu zamiast „przeciągnij z Findera"; dopisz że serwer i przeglądarka startują same)

**Scenariusze testowe:**
- [Manual] Czytelnik na czystym Macu przechodzi instalację samym one-linerem.

**Weryfikacja:**
- `grep -n "raw.githubusercontent.*install.sh" README.md` pokazuje one-liner.
- `grep -n "node-v22.17.0-darwin-arm64/bin/node server.js" README.md` zwraca pusto (brzydki ręczny krok usunięty).

## Ryzyka i zależności

- **`curl|bash` wykonuje kod z internetu** — świadomie akceptowane (standard branżowy); README ma już
  sekcję trust/„obejrzyj skrypt najpierw" + weryfikację SHASUMS256 portable Node. Zostawić/wzmocnić.
- **TTY:** w nietypowych terminalach/CI `/dev/tty` może nie istnieć → fallback bez TTY (pytania mogą
  dostać defaulty). Akceptowalne dla ścieżki desktopowej.
- **Update istniejącego `~/claude-cron`:** uważać na nadpisanie `data/claude-cron.db` (baza usera!) —
  bootstrap NIE może skasować `data/`. Krytyczne; pokryć w implementacji (zachować `data/` i `.node/`).
- **Windows:** dla parytetu potrzebny `install.ps1` w trybie dualnym + `Start-Process` — w scope lub follow-up.

## Plan testów

- `bash -n install.sh`, `node --check setup.mjs`, `node --test` (cały suite + nowe testy pure helperów).
- **Symulacja bootstrap bez ruszania repo dev:** pobrać tarball do katalogu tymczasowego i odpalić
  zmodyfikowany `install.sh` w trybie bootstrap z `INSTALL_DIR` wskazującym na temp (nie `~/claude-cron`),
  zweryfikować rozpakowanie + obecność `setup.mjs`, posprzątać.
- Build na branchu `feature/one-command-install`; merge do `main` dopiero po teście (one-liner pobiera
  `main`, więc zmiany muszą tam trafić, by działał „na produkcji").

## Wznowienie po wyczyszczeniu sesji

1. Stan wyjściowy: `ulatwienie-instalacji` ukończone i na `main` (portable Node + node:sqlite +
   folder-picker). VPS i Mac usera już działają na nowym kodzie.
2. Ten plan = next step. Uruchom `/dev-docs` na tym pliku → potem `/dev-autopilot-wf` na
   `docs/active/instalacja-jedna-komenda` (git: branch `feature/one-command-install`, zwaliduj przed odpaleniem).
3. User dał GO koncepcyjnie; do potwierdzenia przed mergem: strategia update `~/claude-cron`
   (NIE kasować `data/`), oraz czy domykać Windows w tym samym zadaniu.

## Źródła i referencje

- **Plan-rodzic (ukończony):** docs/plans/2026-06-29-001-feat-ulatwienie-instalacji-plan.md
  (archiwum: docs/completed/ulatwienie-instalacji/).
- Kod: `install.sh`, `setup.mjs`, `setup.test.mjs`, `README.md` (sekcja Mac), `scripts/install-vps.sh` (osobny tor).
- Zweryfikowane fakty środowiskowe w treści (repo public, curl/tar, TTY, open/Start-Process).
