# Podsumowanie: Instalacja Pulsa jedną komendą (Mac + Windows + VPS)

**Data ukończenia:** 2026-07-01
**Branch:** `feature/one-command-install`
**Status:** Wszystkie 4 Unity ukończone (implementacja + walidacja + testy operatorskie live). Suite `node --test`: 161/161 PASS; `install.test.sh` 4/4 PASS; `install.ps1.Tests.ps1` 4/4 PASS na realnym Win11 + PS 5.1. Pełny przebieg one-linera zweryfikowany LIVE na czystym Macu i czystym Windows. Merge do `main` wykonany (fast-forward `d52d537..6713eff`), one-liner z `main` potwierdzony.

## Co zostało dostarczone

Domknięcie „najłatwiejszej instalacji" na trzech torach: **otwórz terminal → wklej 1 komendę → odpowiedz na pytania → koniec** (serwer sam startuje, przeglądarka sama otwiera dashboard na Mac/Win).

Docelowe komendy:
- **Mac/Linux:** `curl -fsSL https://raw.githubusercontent.com/AIBiz-Automatyzacje/claude-cron/main/install.sh | bash`
- **Windows:** `irm https://raw.githubusercontent.com/AIBiz-Automatyzacje/claude-cron/main/install.ps1 | iex`
- **VPS:** `curl -fsSL https://raw.githubusercontent.com/AIBiz-Automatyzacje/claude-cron/main/scripts/install-vps.sh | sudo bash`

- **Unit 1 — `install.sh` (Mac/Linux) tryb dualny + fix TTY:** detekcja trybu (`setup.mjs` obok = tryb lokalny, inaczej bootstrap), pobranie repo bez `git` (`curl tarball | tar -xz` do tempa → przeniesienie do `~/claude-cron`), fail-fast gdy brak `setup.mjs` po rozpakowaniu, handoff `"$NODE_BIN" setup.mjs < /dev/tty` z fallbackiem bez TTY. Kontrakt danych re-run: allowlist (`data/` + `.node/`), atomowy swap. `rm -rf` utwardzony `${node_base:?}`. Nowy `install.test.sh` (czysty bash, symulacja bootstrap/preserve, 4/4 PASS).
- **Unit 2 — `install.ps1` (Windows) tryb dualny + GATE 0:** GATE 0 zweryfikowany LIVE (Win11 + PS 5.1) — pytania czytają klawiaturę pod `irm|iex`, łatka `CONIN$` NIEpotrzebna. Detekcja trybu przez puste `$PSScriptRoot`, bootstrap `Invoke-WebRequest` + `Expand-Archive`, fail-fast `throw`, kontrakt danych (allowlist, atomowy swap). Nowy `install.ps1.Tests.ps1` (parytet 1:1 z `install.test.sh`, 4/4 PASS).
- **Unit 3 — `setup.mjs` auto-start + auto-open:** po smoke-teście ping 7777 → jeśli down, spawn detached serwer portable Nodem (`--disable-warning`, caffeinate guard darwin), poll do odpowiedzi. ZAWSZE `console.log` z linkiem do dashboardu (siatka bezpieczeństwa). Pure `buildOpenBrowserCommand(platform, url)`: darwin `open`, win32 `Start-Process`/`cmd /c start ""`, inne → `null`. Auto-open best-effort. 3 nowe testy w `setup.test.mjs` (darwin/win32/linux) — zielone.
- **Unit 4 — README trójplatformowe one-linery:** one-linery Mac/Windows/VPS, usunięcie ręcznego startu `.node/...server.js`, korekta „pyta o 2 rzeczy"→4 (workspace/VPS/Discord/autostart), wzmianka o oknie wyboru folderu i o tym, że serwer + przeglądarka startują same.

## Kluczowe decyzje

1. **Tryb dualny przez detekcję `setup.mjs` obok skryptu** — symetrycznie: `install.sh` testuje plik obok, `install.ps1` używa pustego `$PSScriptRoot` pod `irm|iex` jako sygnału bootstrap.
2. **Bootstrap bez `git`** — Mac `tarball` + `tar -xz`; Windows `zip` + `Expand-Archive` (natywniejsze niż tar na Win). Eliminuje odpalenie Xcode CLT na Macu. Fail-fast gdy brak `setup.mjs` po rozpakowaniu.
3. **KONTRAKT bezpieczeństwa danych (najgroźniejsze ryzyko):** re-run one-linera NIE może skasować `data/claude-cron.db`. Rozpakuj świeże repo do tempa → przenieś `data/` + `.node/` ze starej instalacji → atomowy swap. Allowlist, NIE blacklist. Uzasadnienie: config usera (vault, hook, Discord) żyje POZA repo (`{workspace}/.claude/` + shell rc), więc przeżywa re-extract; jedyny stan w repo do ochrony to `data/` + `.node/`. Test „strażnik" `data/SENTINEL` potwierdził na Mac i Windows.
4. **Auto-open tylko Mac/Win, zawsze + link jako siatka bezpieczeństwa.** VPS = robotnik na joby (nie woła `setup.mjs`) → bez auto-open. Bez detekcji DISPLAY/headless.
5. **GATE 0 Windows jako twardy gate, nie założenie** — zweryfikowano PRZED resztą Unitu 2, że stdin pod `irm|iex` czyta klawiaturę. Wynik: działa, łatka `CONIN$` niepotrzebna.
6. **Port 7777 zakładamy wolny** — kolizji nie obsługujemy (świadomie poza scope).
7. **`install.ps1` = czyste ASCII** (rozwiązanie 2026-07-01). PS 5.1 czyta plik bez BOM jako ANSI; BOM łamie `irm|iex` (`﻿#`). Transliteracja znaków strukturalnych (em-dash/strzałka/emoji) na ASCII w ~12 liniach cienkiego bootstrapu; diakrytyki i pełny polski UX zostają w `setup.mjs` (główny UX) i `install.sh` (Mac). Działa na każdej ścieżce (`irm|iex` + `.\install.ps1` + `-File`) i wersji PS (5.1/7).

## Główne pliki

- `install.sh` — tryb dualny, bootstrap `curl tarball | tar -xz`, fix TTY `< /dev/tty`, kontrakt danych (allowlist + atomowy swap).
- `install.ps1` — tryb dualny (puste `$PSScriptRoot`), bootstrap `Expand-Archive`, fail-fast `throw`, kontrakt danych; czyste ASCII (bez BOM).
- `setup.mjs` — auto-start serwera (spawn detached, portable Node), poll, zawsze print link, pure `buildOpenBrowserCommand` (darwin/win32/inne→null), auto-open best-effort.
- `setup.test.mjs` — 3 nowe testy `buildOpenBrowserCommand` (darwin/win32/linux).
- `README.md` — trójplatformowe one-linery, usunięty ręczny start serwera, korekta liczby pytań.
- `install.test.sh` — symulacja bootstrap/preserve (Mac, czysty bash, 4/4 PASS).
- `install.ps1.Tests.ps1` — parytet 1:1 (Windows, 4/4 PASS).
- `scripts/install-vps.sh` — bez zmian (VPS = osobny tor, nie woła `setup.mjs`).

## Wnioski

- **Bootstrap bez `git` = mniej niespodzianek na Macu** — `git clone` odpala Xcode CLT (kilka GB, prompt GUI). Tarball/zip + rozpak wbudowanymi narzędziami (`tar`/`Expand-Archive`) omija to i skraca happy-path do jednej komendy.
- **Kontrakt danych re-run rób allowlistą, nie blacklistą** — świadomie przenosisz TYLKO to, co musi przeżyć (`data/` + `.node/`), reszta = świeże repo. Blacklist („skasuj wszystko oprócz…") jest krucha przy nowych plikach w repo. Test „strażnik" (`data/SENTINEL`) to tania weryfikacja że baza przeżyła.
- **stdin pod `curl|bash` / `irm|iex` to realne ryzyko EOF, nie teoria** — Mac ma `/dev/tty` (z fallbackiem), Windows wymagał twardego GATE 0 na realnej maszynie przed budową reszty. Cichy EOF = setup przelatuje bez zatrzymania i bierze defaulty; objaw łatwy do przeoczenia bez świadomego testu.
- **`.ps1` pod `irm|iex` MUSI być bez BOM, a bez BOM PS 5.1 czyta jako ANSI** — te dwa fakty razem wymuszają czyste ASCII w bootstrapie Windows. Diakrytyki przenieś do plików czytanych jawnym UTF-8 (`setup.mjs`) lub odpalanych inaczej (`install.sh`).
- **`exit` w funkcji wołanej pod `irm|iex` zamyka całą sesję PowerShell** — guard `if ($PSScriptRoot) { exit }`: w trybie bootstrap (puste `$PSScriptRoot`) NIE wołaj `exit`, żeby operator zobaczył link do dashboardu.
- **Persystencja env musi być per-OS** — Unix do shell rc, Windows do User Environment (`[Environment]::SetEnvironmentVariable(...,'User')`). Pisanie do `.zshrc` na Windows to niemy no-op (plik nieczytany).
- **Granica testowalności:** pure helpery (`buildOpenBrowserCommand`, logika preserve/swap) pokryte `node:test` / bash / Pester; pełny przebieg one-linera + GATE 0 + auto-open na realnym GUI → Operator checklist (niewykonalne headless), zdomknięty live na Mac i Windows.

## Otwarte (nieblokujące)

- **Znany drobiazg UX:** okno wyboru folderu (FolderBrowserDialog na Windows) potrafi wyskoczyć ZA terminalem — wygląda jak zawieszenie, trzeba Alt+Tab. Kandydat na hardening (okno topmost).
- **env-override źródła bootstrapu** (`CLAUDE_CRON_TARBALL_URL`/`ZIP_URL` + `TOPDIR`, default `main`) — dodane do testu z brancha przed mergem, zostaje jako feature (forki/mirrory).
- **Port 7777** — kolizja portu świadomie poza scope.

## Źródła

- Plan techniczny: `docs/plans/2026-06-30-001-feat-instalacja-jedna-komenda-plan.md`
- Runbook operatora (Windows GATE 0): `docs/completed/instalacja-jedna-komenda/GATE0-windows-runbook.md`
- Poprzednik (fundament): `docs/completed/ulatwienie-instalacji/`
