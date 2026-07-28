---
title: "Windows: re-run instalatora pada na zablokowanej bazie; raw.githubusercontent serwuje stary plik"
date: 2026-07-28
category: deployment-issues
severity: high
stack:
  - PowerShell
  - Windows
  - GitHub
tags:
  - instalator
  - windows
  - file-lock
  - cdn-cache
  - re-run
status: verified
last_verified: 2026-07-28
---

# Re-run instalatora na Windowsie: zablokowane pliki i cache CDN

Dwa niezależne problemy, które w praktyce występują razem — pierwszy blokuje aktualizację, drugi sprawia, że poprawka pierwszego nie dociera.

## Problem 1: Move-Item pada na pliku trzymanym przez daemona

### Symptomy

```
[info] Pobieram repo (zip, bez git)...
[info] Rozpakowuje repo...
Move-Item : Proces nie może uzyskać dostępu do pliku, ponieważ jest on używany przez inny proces.
    + CategoryInfo : WriteError: (claude-cron.db:FileInfo) [Move-Item], IOException
```

Instalacja przerywa się **przed** podmianą katalogów. Stara instalacja zostaje nietknięta (`Move-PreservedDirs` leci przed swapem), ale aktualizacja jest niewykonalna bez ręcznego ubicia procesu.

### Root Cause

Windows nie pozwala przenieść ani skasować pliku z otwartym uchwytem. Działający daemon trzyma `data\claude-cron.db`, a instalator przenosi cały katalog `data\` do świeżo rozpakowanego repo.

**Żaden instalator nie zatrzymywał daemona.** Na Unixie to uchodzi bezkarnie — przenoszenie otwartego pliku jest legalne (inode żyje dalej), więc `install.sh` nigdy tego nie potrzebował i problem nie ujawnił się na macOS ani Linuksie.

### Rozwiązanie

```powershell
# Filtr po CommandLine zawierajacym katalog instalacji - NIE zabijamy cudzych procesow node.
function Stop-PulsProcesses {
    param([Parameter(Mandatory = $true)][string] $Dir)

    $procs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine.Contains($Dir) })
    if ($procs.Count -eq 0) { return }

    foreach ($p in $procs) {
        Write-Host "[info] Zatrzymuje daemona Pulsa (PID $($p.ProcessId)) - trzyma pliki instalacji." -ForegroundColor Cyan
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 2   # Windows zwalnia uchwyty asynchronicznie
}
```

Wywołanie **przed** `Move-PreservedDirs`, wewnątrz `Install-FreshRepo`. Daemon wstaje po instalacji (hook autostartu / Task Scheduler).

Najbardziej ryzykowna część to filtr: błąd w nim ubija cudze aplikacje Node. Dlatego test Pester uruchamia obcy proces `node` i sprawdza, że przeżywa:

```powershell
$foreign = Start-Process -FilePath "node" -ArgumentList "-e", "setTimeout(()=>{},30000)" -PassThru -WindowStyle Hidden
Stop-PulsProcesses -Dir (Join-Path $Sandbox "nieistniejaca-instalacja")
if (-not $foreign.HasExited) { Test-Pass "nie rusza node'a spoza katalogu instalacji" }
```

## Problem 2: raw.githubusercontent.com serwuje starą wersję

### Symptomy

Po `git push` instalator pobrany przez `irm` **nadal nie ma poprawki** — ten sam błąd, brak nowych komunikatów.

```bash
curl -s ".../feature/BRANCH/install.ps1" | grep -c "Stop-PulsProcesses"   # 0 — stara wersja
grep -c "Stop-PulsProcesses" install.ps1                                  # 2 — fix jest lokalnie
```

### Root Cause

`raw.githubusercontent.com` cachuje treść per URL przez kilka minut. Adres z **nazwą gałęzi** wskazuje na ruchomy wskaźnik, więc CDN może zwracać poprzednią zawartość. „Wypchnięte" ≠ „pobierze się nowe".

Mylący trop: numer linii w komunikacie błędu (`At line:67`) może się zgadzać w obu wersjach, jeśli poprawkę dodano niżej w pliku — nie nadaje się do rozstrzygnięcia, którą wersję pobrał użytkownik.

### Rozwiązanie

Adresuj po **SHA commita** — jest niezmienny, więc CDN nie ma czego cachować:

```powershell
$env:CLAUDE_CRON_ZIP_URL="https://github.com/OWNER/REPO/archive/<SHA>.zip"
$env:CLAUDE_CRON_ZIP_TOPDIR="claude-cron-<SHA>"        # topdir zawiera pełny SHA
irm https://raw.githubusercontent.com/OWNER/REPO/<SHA>/install.ps1 | iex
```

Uwaga: `ZIP_TOPDIR` musi odpowiadać nazwie katalogu w archiwum — dla ZIP-a po SHA to `<repo>-<pełny-SHA>`, nie `<repo>-<branch>`.

## Komendy diagnostyczne

```bash
# Czy CDN serwuje już nowy plik (przed wysłaniem komendy użytkownikowi)
curl -s "https://raw.githubusercontent.com/OWNER/REPO/BRANCH/install.ps1" | grep -c "NOWA_FUNKCJA"

# Topdir w archiwum po SHA
curl -sSL -o t.zip "https://github.com/OWNER/REPO/archive/<SHA>.zip" && unzip -l t.zip | sed -n '4p'
```

```powershell
# Kto trzyma pliki instalacji (przed ubiciem — do wglądu)
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like "*claude-cron*" } | Select-Object ProcessId, CommandLine
```

Potwierdzenie, że działa poprawiona wersja: w outpucie pojawia się `[info] Zatrzymuje daemona Pulsa (PID …)` przed rozpakowaniem.

## Zapobieganie

- Instalator, który podmienia katalog aplikacji, musi najpierw zatrzymać jej procesy — na Windowsie to warunek konieczny, nie uprzejmość.
- Ubijanie procesów filtruj po ścieżce instalacji, nigdy po samej nazwie binarki, i pokryj to testem z obcym procesem.
- Testując instalator z gałęzi, adresuj pliki po SHA commita i **zweryfikuj zawartość zdalnego pliku** przed podaniem komendy drugiej osobie.
- Różnice semantyki systemu plików (otwarty plik: Unix pozwala przenieść, Windows nie) sprawiają, że suita na jednym systemie nie mówi nic o drugim.

## Powiązane

- `docs/solutions/deployment-issues/2026-07-01-instalator-cross-platform-irm-iex-encoding-env-symlink.md` — inne pułapki `irm | iex` (ASCII, BOM, entry-point guard)
- `docs/solutions/deployment-issues/2026-07-07-stale-env-vps-url-hook-respawn-serwera.md` — pokrewny wzorzec: stan w żyjącym procesie vs stan na dysku

## Kontekst

Windows 11, PowerShell 5.1, instalacja z gałęzi przez `irm | iex` z override'ami `CLAUDE_CRON_ZIP_URL`/`CLAUDE_CRON_ZIP_TOPDIR`. Po fiksie re-run przeszedł czysto, katalogi stanowe (`data\`, `.node\`) przetrwały podmianę — token skrzynki i historia jobów zachowane, starter-taski zgłosiły `job o tej nazwie już istnieje`.

Suita Pester (`install.ps1.Tests.ps1`) jest jedyną, której nie da się uruchomić na macOS — wymaga przebiegu na Windowsie. Po tej zmianie: 5/5 PASS.
