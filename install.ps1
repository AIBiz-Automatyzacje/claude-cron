# ============================================
#  CLAUDE-CRON — Portable Node bootstrap (Windows)
#
#  Cienki bootstrap: stawia pinowany, przenośny Node
#  w .node\ (z weryfikacją sumy SHASUMS256) i przekazuje
#  sterowanie do setup.mjs. Bootstrap NIE zawiera logiki
#  konfiguracyjnej — robi wyłącznie portable Node.
#
#  Nie dotyka systemowego Node, PATH ani profilu PowerShell.
# ============================================

$ErrorActionPreference = "Stop"

# Pinowany patch portable Node — najnowszy stabilny 22.x LTS,
# spójny z oknem engines ">=22.13 <25".
$NodeVersion = "22.17.0"

# Repo = katalog, w którym leży ten skrypt
$RepoDir  = $PSScriptRoot
$NodeBase = Join-Path $RepoDir ".node"

Write-Host ""
Write-Host "🕹️  CLAUDE-CRON — Portable Node bootstrap" -ForegroundColor Cyan
Write-Host "========================================"
Write-Host ""
Write-Host "  Stawiam przenośny Node $NodeVersion w .node\ (bez globalnej instalacji)" -ForegroundColor DarkGray
Write-Host "  i przekazuję dalej do setup.mjs." -ForegroundColor DarkGray
Write-Host ""

# ============ DETECT ARCH ============

function Get-NodeArch {
    switch ($env:PROCESSOR_ARCHITECTURE) {
        "AMD64" { return "x64" }
        "ARM64" { return "arm64" }
        "x86"   { return "x86" }
        default { throw "Nieobsługiwana architektura: $($env:PROCESSOR_ARCHITECTURE)." }
    }
}

$Arch = Get-NodeArch

# node-v<ver>-win-<arch>.zip  (np. node-v22.17.0-win-x64.zip)
$DistName    = "node-v$NodeVersion-win-$Arch"
$Archive     = "$DistName.zip"
$DistBaseUrl = "https://nodejs.org/dist/v$NodeVersion"
$NodeExe     = Join-Path (Join-Path $NodeBase $DistName) "node.exe"

# ============ DETECT-AND-TOUCH-ONLY-MISSING ============

if (Test-Path $NodeExe) {
    $InstalledVer = (& $NodeExe -v 2>$null) -replace '^v', ''
    if ($InstalledVer -eq $NodeVersion) {
        Write-Host "[ok] Portable Node $NodeVersion już obecny — pomijam pobieranie." -ForegroundColor Green
        Write-Host "[info] Przekazuję sterowanie do setup.mjs..." -ForegroundColor Cyan
        & $NodeExe (Join-Path $RepoDir "setup.mjs")
        exit $LASTEXITCODE
    }
}

# ============ DOWNLOAD ARCHIVE + CHECKSUMS ============

$TmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("claude-cron-node-" + [System.Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $TmpDir | Out-Null

try {
    $ArchivePath  = Join-Path $TmpDir $Archive
    $ShasumsPath  = Join-Path $TmpDir "SHASUMS256.txt"

    Write-Host "[info] Pobieram $Archive z nodejs.org/dist..." -ForegroundColor Cyan
    Invoke-WebRequest -Uri "$DistBaseUrl/$Archive" -OutFile $ArchivePath -UseBasicParsing

    Write-Host "[info] Pobieram SHASUMS256.txt (weryfikacja integralności)..." -ForegroundColor Cyan
    Invoke-WebRequest -Uri "$DistBaseUrl/SHASUMS256.txt" -OutFile $ShasumsPath -UseBasicParsing

    # ============ VERIFY SHASUMS256 ============

    Write-Host "[info] Weryfikuję sumę SHA256..." -ForegroundColor Cyan

    # Linia z SHASUMS256.txt: "<sha256>  node-v...-win-<arch>.zip"
    $ExpectedLine = Get-Content $ShasumsPath | Where-Object { $_ -match "\s$([regex]::Escape($Archive))$" }
    if (-not $ExpectedLine) {
        throw "Brak wpisu dla $Archive w SHASUMS256.txt."
    }
    $Expected = ($ExpectedLine -split '\s+')[0].ToLower()
    $Actual   = (Get-FileHash -Path $ArchivePath -Algorithm SHA256).Hash.ToLower()

    if ($Expected -ne $Actual) {
        throw "Suma SHA256 się nie zgadza! Oczekiwano $Expected, otrzymano $Actual. Przerywam (archiwum uszkodzone lub podmienione)."
    }
    Write-Host "[ok] Suma SHA256 zgodna." -ForegroundColor Green

    # ============ EXTRACT TO .node\ ============

    Write-Host "[info] Rozpakowuję do .node\..." -ForegroundColor Cyan
    if (-not (Test-Path $NodeBase)) {
        New-Item -ItemType Directory -Path $NodeBase | Out-Null
    }
    # Czyścimy ewentualną starą wersję pod tą samą nazwą dist (idempotencja)
    $DistDir = Join-Path $NodeBase $DistName
    if (Test-Path $DistDir) {
        Remove-Item -Recurse -Force $DistDir
    }
    Expand-Archive -Path $ArchivePath -DestinationPath $NodeBase -Force

    if (-not (Test-Path $NodeExe)) {
        throw "Nie znaleziono node.exe po rozpakowaniu: $NodeExe"
    }
    Write-Host "[ok] Portable Node $NodeVersion gotowy: $NodeExe" -ForegroundColor Green
}
finally {
    Remove-Item -Recurse -Force $TmpDir -ErrorAction SilentlyContinue
}

# ============ HANDOFF DO setup.mjs ============

Write-Host "[info] Przekazuję sterowanie do setup.mjs..." -ForegroundColor Cyan
& $NodeExe (Join-Path $RepoDir "setup.mjs")
exit $LASTEXITCODE
