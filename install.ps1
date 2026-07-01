# ============================================
#  CLAUDE-CRON - Portable Node bootstrap (Windows)
#
#  Tryb DUALNY (parytet z install.sh dla Mac/Linux):
#   - LOKALNY: skrypt lezy obok setup.mjs (sklonowane repo) ->
#     stawia przenosny Node w .node\ i odpala setup.mjs. Bez pobierania kodu.
#   - BOOTSTRAP (irm|iex): skryptu nie ma na dysku ($PSScriptRoot puste) ->
#     pobiera repo zipem (bez git) do $HOME\claude-cron, zachowuje
#     istniejace data\ i .node\ (re-run NIE kasuje bazy), po czym
#     wchodzi w tryb lokalny w docelowym katalogu.
#
#  Bootstrap NIE zawiera logiki konfiguracyjnej - robi wylacznie
#  portable Node + pobranie kodu. Nie dotyka systemowego Node,
#  PATH ani profilu PowerShell.
# ============================================

$ErrorActionPreference = "Stop"

# Pinowany patch portable Node - najnowszy stabilny 22.x LTS,
# spojny z oknem engines ">=22.13 <25".
$NodeVersion = "22.17.0"

# Bootstrap: zip brancha main (rozpakowuje sie do claude-cron-main\).
# Override przez env (test z brancha przed mergem, forki, mirrory).
$ZipUrl    = if ($env:CLAUDE_CRON_ZIP_URL) { $env:CLAUDE_CRON_ZIP_URL } else { "https://github.com/AIBiz-Automatyzacje/claude-cron/archive/refs/heads/main.zip" }
$ZipTopDir = if ($env:CLAUDE_CRON_ZIP_TOPDIR) { $env:CLAUDE_CRON_ZIP_TOPDIR } else { "claude-cron-main" }

# Docelowy katalog instalacji w trybie bootstrap (override przez env w testach).
$InstallDir = if ($env:INSTALL_DIR) { $env:INSTALL_DIR } else { Join-Path $HOME "claude-cron" }

# Katalogi przenoszone ze starej instalacji do swiezej (allowlist, NIE blacklist).
# data\  = baza SQLite + logi (NIGDY nie kasowac przy re-run).
# .node\ = przenosny Node (oszczedza ponowne pobieranie).
$PreserveDirs = @("data", ".node")

# ============ DETECT ARCH ============

function Get-NodeArch {
    switch ($env:PROCESSOR_ARCHITECTURE) {
        "AMD64" { return "x64" }
        "ARM64" { return "arm64" }
        "x86"   { return "x86" }
        default { throw "Nieobslugiwana architektura: $($env:PROCESSOR_ARCHITECTURE)." }
    }
}

# ============ BOOTSTRAP (irm|iex, bez git) ============

# Przenosi allowlistowane katalogi (data\, .node\) ze starej instalacji
# do swiezo rozpakowanego repo. Robione PRZED podmiana katalogow, zeby
# nie bylo okna, w ktorym baza nie istnieje.
function Move-PreservedDirs {
    param(
        [Parameter(Mandatory = $true)][string] $OldDir,
        [Parameter(Mandatory = $true)][string] $FreshDir
    )
    if (-not (Test-Path -LiteralPath $OldDir)) { return }
    foreach ($name in $PreserveDirs) {
        $src = Join-Path $OldDir $name
        if (Test-Path -LiteralPath $src) {
            $dst = Join-Path $FreshDir $name
            # Swiezy zip nie zawiera data\ ani .node\ (gitignore), ale
            # gdyby zawieral - nie chcemy nadpisac zywych danych usera.
            if (Test-Path -LiteralPath $dst) {
                Remove-Item -LiteralPath $dst -Recurse -Force
            }
            Move-Item -LiteralPath $src -Destination $dst
        }
    }
}

# Pobiera zip brancha, rozpakowuje do tmp i zwraca sciezke do rozpakowanego
# repo. Weryfikuje obecnosc setup.mjs (fail fast, throw).
function Expand-RepoFromZip {
    param([Parameter(Mandatory = $true)][string] $TmpDir)

    $archive = Join-Path $TmpDir "repo.zip"

    Write-Host "[info] Pobieram repo (zip, bez git)..." -ForegroundColor Cyan
    Invoke-WebRequest -Uri $ZipUrl -OutFile $archive -UseBasicParsing

    Write-Host "[info] Rozpakowuje repo..." -ForegroundColor Cyan
    Expand-Archive -Path $archive -DestinationPath $TmpDir -Force

    $freshDir = Join-Path $TmpDir $ZipTopDir
    if (-not (Test-Path -LiteralPath (Join-Path $freshDir "setup.mjs"))) {
        throw "Po rozpakowaniu brak setup.mjs w $freshDir - uszkodzony lub nieoczekiwany zip."
    }
    return $freshDir
}

# Atomowy(-ish) swap: swieze repo -> $InstallDir, stare -> kosz w tmp.
# Najpierw przenosi data\ i .node\ ze starej instalacji do swiezej.
function Install-FreshRepo {
    param(
        [Parameter(Mandatory = $true)][string] $FreshDir,
        [Parameter(Mandatory = $true)][string] $TmpDir
    )

    $parent = Split-Path -Parent $InstallDir
    if ($parent -and -not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }

    if (Test-Path -LiteralPath $InstallDir) {
        Move-PreservedDirs -OldDir $InstallDir -FreshDir $FreshDir
        # Stara instalacja idzie do kosza w tmp (sprzatane przez finally).
        $trash = Join-Path $TmpDir "old-install"
        if (Test-Path -LiteralPath $trash) {
            Remove-Item -LiteralPath $trash -Recurse -Force
        }
        Move-Item -LiteralPath $InstallDir -Destination $trash
    }

    # Swieze repo na miejsce docelowe.
    Move-Item -LiteralPath $FreshDir -Destination $InstallDir
    Write-Host "[ok] Repo gotowe w $InstallDir" -ForegroundColor Green
}

# Pelny przebieg bootstrap -> zwraca $InstallDir jako katalog repo.
function Invoke-Bootstrap {
    Write-Host ""
    Write-Host "CLAUDE-CRON - instalacja jedna komenda" -ForegroundColor Cyan
    Write-Host "========================================"
    Write-Host ""
    Write-Host "  Pobieram repo do $InstallDir (bez git) i konfiguruje." -ForegroundColor DarkGray
    Write-Host ""

    $tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("claude-cron-boot-" + [System.Guid]::NewGuid().ToString())
    New-Item -ItemType Directory -Path $tmpDir | Out-Null
    try {
        $freshDir = Expand-RepoFromZip -TmpDir $tmpDir
        Install-FreshRepo -FreshDir $freshDir -TmpDir $tmpDir
    }
    finally {
        Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue
    }

    return $InstallDir
}

# ============ PORTABLE NODE (w $RepoDir\.node) ============

# Pobiera + weryfikuje + rozpakowuje przenosny Node do $RepoDir\.node,
# jesli jeszcze go tam nie ma. Zwraca sciezke do node.exe.
function Install-PortableNode {
    param([Parameter(Mandatory = $true)][string] $RepoDir)

    $arch     = Get-NodeArch
    $distName = "node-v$NodeVersion-win-$arch"
    $archive  = "$distName.zip"
    $distUrl  = "https://nodejs.org/dist/v$NodeVersion"
    $nodeBase = Join-Path $RepoDir ".node"
    $nodeExe  = Join-Path (Join-Path $nodeBase $distName) "node.exe"

    if (Test-Path -LiteralPath $nodeExe) {
        $installedVer = (& $nodeExe -v 2>$null) -replace '^v', ''
        if ($installedVer -eq $NodeVersion) {
            Write-Host "[ok] Portable Node $NodeVersion juz obecny - pomijam pobieranie." -ForegroundColor Green
            return $nodeExe
        }
    }

    $tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("claude-cron-node-" + [System.Guid]::NewGuid().ToString())
    New-Item -ItemType Directory -Path $tmpDir | Out-Null
    try {
        $archivePath = Join-Path $tmpDir $archive
        $shasumsPath = Join-Path $tmpDir "SHASUMS256.txt"

        Write-Host "[info] Pobieram $archive z nodejs.org/dist..." -ForegroundColor Cyan
        Invoke-WebRequest -Uri "$distUrl/$archive" -OutFile $archivePath -UseBasicParsing

        Write-Host "[info] Pobieram SHASUMS256.txt (weryfikacja integralnosci)..." -ForegroundColor Cyan
        Invoke-WebRequest -Uri "$distUrl/SHASUMS256.txt" -OutFile $shasumsPath -UseBasicParsing

        Write-Host "[info] Weryfikuje sume SHA256..." -ForegroundColor Cyan
        $expectedLine = Get-Content $shasumsPath | Where-Object { $_ -match "\s$([regex]::Escape($archive))$" }
        if (-not $expectedLine) {
            throw "Brak wpisu dla $archive w SHASUMS256.txt."
        }
        $expected = ($expectedLine -split '\s+')[0].ToLower()
        $actual   = (Get-FileHash -Path $archivePath -Algorithm SHA256).Hash.ToLower()
        if ($expected -ne $actual) {
            throw "Suma SHA256 sie nie zgadza! Oczekiwano $expected, otrzymano $actual. Przerywam (archiwum uszkodzone lub podmienione)."
        }
        Write-Host "[ok] Suma SHA256 zgodna." -ForegroundColor Green

        Write-Host "[info] Rozpakowuje do .node\..." -ForegroundColor Cyan
        if (-not (Test-Path -LiteralPath $nodeBase)) {
            New-Item -ItemType Directory -Path $nodeBase | Out-Null
        }
        $distDir = Join-Path $nodeBase $distName
        if (Test-Path -LiteralPath $distDir) {
            Remove-Item -Recurse -Force $distDir
        }
        Expand-Archive -Path $archivePath -DestinationPath $nodeBase -Force

        if (-not (Test-Path -LiteralPath $nodeExe)) {
            throw "Nie znaleziono node.exe po rozpakowaniu: $nodeExe"
        }
        Write-Host "[ok] Portable Node $NodeVersion gotowy: $nodeExe" -ForegroundColor Green
    }
    finally {
        Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue
    }

    return $nodeExe
}

# ============ HANDOFF DO setup.mjs ============

# Pod irm|iex proces node dziedziczy konsole jako stdin (nie potok ze
# skryptem, jak przy curl|bash na Macu), wiec pytania setup.mjs czytaja
# z klawiatury bez przekierowania.
#
# GATE 0 - ZWERYFIKOWANE 2026-07-01 (Windows 11 + PowerShell 5.1): pod irm|iex
# pytania setup.mjs czytaja klawiature, latka CONIN$ okazala sie niepotrzebna.
function Invoke-Setup {
    param(
        [Parameter(Mandatory = $true)][string] $NodeExe,
        [Parameter(Mandatory = $true)][string] $RepoDir
    )
    Write-Host "[info] Przekazuje sterowanie do setup.mjs..." -ForegroundColor Cyan
    & $NodeExe (Join-Path $RepoDir "setup.mjs")
    $code = $LASTEXITCODE
    if ($code -ne 0) { Write-Warning "setup.mjs zakonczyl sie kodem $code." }
    # `exit` TYLKO gdy skrypt uruchomiony z pliku ($PSScriptRoot ustawione: -File / .\install.ps1).
    # Pod irm|iex ($PSScriptRoot puste) `exit` zamkneloby sesje PowerShell operatora,
    # zanim zobaczy wypisany link do dashboardu (siatka bezpieczenstwa).
    if ($PSScriptRoot) { exit $code }
}

# ============ MAIN ============

function Invoke-Main {
    # Tryb LOKALNY gdy skrypt lezy na dysku obok setup.mjs.
    # Pod irm|iex $PSScriptRoot jest puste -> sygnal trybu bootstrap.
    $localRepo = if ($PSScriptRoot) { $PSScriptRoot } else { $null }
    $isLocal   = $localRepo -and (Test-Path -LiteralPath (Join-Path $localRepo "setup.mjs"))

    if ($isLocal) {
        Write-Host ""
        Write-Host "CLAUDE-CRON - Portable Node bootstrap" -ForegroundColor Cyan
        Write-Host "========================================"
        Write-Host ""
        Write-Host "  Stawiam przenosny Node $NodeVersion w .node\ (bez globalnej instalacji)" -ForegroundColor DarkGray
        Write-Host "  i przekazuje dalej do setup.mjs." -ForegroundColor DarkGray
        Write-Host ""
        $repoDir = $localRepo
    }
    else {
        # Tryb BOOTSTRAP - irm|iex bez sklonowanego repo.
        $repoDir = Invoke-Bootstrap
    }

    $nodeExe = Install-PortableNode -RepoDir $repoDir
    Invoke-Setup -NodeExe $nodeExe -RepoDir $repoDir
}

# Test harness moze wczytac tylko funkcje (CLAUDE_CRON_LIB_ONLY=1),
# bez odpalania main (pobierania Node / setup.mjs).
if ($env:CLAUDE_CRON_LIB_ONLY -ne "1") {
    Invoke-Main
}
