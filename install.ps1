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

# Bootstrap: skad bierzemy kod. Zip adresujemy po SHA commita (rozstrzyganym PRZED
# pobraniem), nie po nazwie galezi - URL z nazwa galezi jest cache'owany po stronie
# GitHuba i nie mowi, CO faktycznie rozpakowalismy. Override URL-a przez env
# (test z brancha przed mergem, forki, mirrory) pomija rozstrzyganie.
$RepoSlug  = if ($env:CLAUDE_CRON_REPO_SLUG) { $env:CLAUDE_CRON_REPO_SLUG } else { "AIBiz-Automatyzacje/claude-cron" }
$RepoRef   = if ($env:CLAUDE_CRON_REF) { $env:CLAUDE_CRON_REF } else { "main" }
$ZipUrl    = if ($env:CLAUDE_CRON_ZIP_URL) { $env:CLAUDE_CRON_ZIP_URL } else { "" }
$ZipTopDir = if ($env:CLAUDE_CRON_ZIP_TOPDIR) { $env:CLAUDE_CRON_ZIP_TOPDIR } else { "" }

# Rewizja faktycznie pobranego kodu - przekazywana do setup.mjs, ktory zapisuje ja
# do data\version.json (widoczne w /api/status). Pusta = nieznana.
$InstallRevision = if ($env:CLAUDE_CRON_INSTALL_REVISION) { $env:CLAUDE_CRON_INSTALL_REVISION } else { "" }
$InstallSource   = if ($env:CLAUDE_CRON_INSTALL_SOURCE) { $env:CLAUDE_CRON_INSTALL_SOURCE } else { "zip" }

# Docelowy katalog instalacji w trybie bootstrap. Env-override (testy, automatyzacja,
# druga instancja obok pierwszej) wygrywa i POMIJA pytanie - inaczej nieinteraktywny
# przebieg z jawnie podanym katalogiem i tak pytalby o niego uzytkownika.
$InstallDirDefault = Join-Path $HOME "claude-cron"
$InstallDir = if ($env:INSTALL_DIR) { $env:INSTALL_DIR } else { $InstallDirDefault }

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

# ============ KATALOG INSTALACJI ============

# Czysta zamiana odpowiedzi uzytkownika na sciezke instalacji (parytet z resolve_install_dir
# w install.sh). Puste (sam Enter) -> katalog domyslny. Explorer wkleja sciezki w cudzyslowach,
# a "~" nie jest przez PowerShell rozwijane w wartosci z Read-Host - bez tego powstalby
# katalog o nazwie "~". Sciezka wzgledna -> absolutna, bo cwd instalatora bywa przypadkowy.
function Resolve-InstallDir {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyString()][string] $Answer,
        [Parameter(Mandatory = $true)][string] $Fallback,
        [string] $Base = $PWD.Path
    )
    $value = $Answer.Trim().Trim('"').Trim("'").Trim()
    if ([string]::IsNullOrWhiteSpace($value)) { return $Fallback }

    if ($value -eq "~") { return $HOME }
    if ($value.StartsWith("~")) {
        return (Join-Path $HOME $value.Substring(1).TrimStart('\', '/'))
    }
    if (-not [System.IO.Path]::IsPathRooted($value)) {
        return (Join-Path $Base $value)
    }
    return $value
}

# Pytanie o katalog instalacji (tylko tryb bootstrap). Pod irm|iex konsola jest stdin-em
# procesu (zweryfikowane 2026-07-01 na Windows 11 + PS 5.1), wiec Read-Host czyta klawiature.
# Gdy stdin jest przekierowany (CI, potok), Read-Host oddaje pusty string albo rzuca -
# obie drogi konczy sie katalogiem domyslnym, nigdy zawieszeniem instalatora.
function Read-InstallDir {
    if ($env:INSTALL_DIR) {
        Write-Host "[info] Katalog instalacji z env INSTALL_DIR: $InstallDir" -ForegroundColor Cyan
        return $InstallDir
    }
    $answer = ""
    try {
        $answer = Read-Host "Katalog instalacji [$InstallDirDefault]"
    }
    catch {
        Write-Host "[warn] Brak interaktywnego wejscia - instaluje w katalogu domyslnym." -ForegroundColor Yellow
    }
    $resolved = Resolve-InstallDir -Answer $answer -Fallback $InstallDirDefault
    Write-Host "[ok] Katalog instalacji: $resolved" -ForegroundColor Green
    return $resolved
}

# Czy katalog wyglada na instalacje Pulsa (kod + stan). Rozpoznajemy po ARTEFAKTACH,
# nie po nazwie katalogu: nazwa jest wolna odpowiedzia usera, a decyzja "wolno to
# skasowac" musi wisiec na zawartosci.
function Test-PulsInstallDir {
    param([Parameter(Mandatory = $true)][string] $Dir)

    $pkg = Join-Path $Dir "package.json"
    if ((Test-Path -LiteralPath $pkg -PathType Leaf) -and
        ((Get-Content -Raw -LiteralPath $pkg -ErrorAction SilentlyContinue) -match '"name"\s*:\s*"claude-cron"')) {
        return $true
    }
    # Instalacja bootstrapowa: kod serwera + katalog stanu (data\) albo portable Node (.node\).
    $server = Join-Path $Dir "server.js"
    if ((Test-Path -LiteralPath $server -PathType Leaf) -and
        ((Test-Path -LiteralPath (Join-Path $Dir "data") -PathType Container) -or
         (Test-Path -LiteralPath (Join-Path $Dir ".node") -PathType Container))) {
        return $true
    }
    return $false
}

# Katalog domowy i korzen dysku sa POZA zasiegiem instalatora: Install-FreshRepo podmienia
# katalog w calosci, a Stop-PulsProcesses ubija procesy spod tej sciezki - obie operacje
# na $HOME albo C:\ to katastrofa.
function Test-ForbiddenInstallDir {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string] $Dir)

    if ([string]::IsNullOrWhiteSpace($Dir)) { return $true }
    try {
        $full = [System.IO.Path]::GetFullPath($Dir).TrimEnd('\')
    }
    catch {
        return $true  # nieparsowalna sciezka - fail-closed
    }
    if ($full -eq ([System.IO.Path]::GetFullPath($HOME).TrimEnd('\'))) { return $true }
    if ($full -eq ([System.IO.Path]::GetPathRoot($full).TrimEnd('\'))) { return $true }
    return $false
}

# Klasyfikacja celu instalacji (parytet z classify_install_target w install.sh):
#   forbidden | file | empty | puls | foreign
function Get-InstallTargetKind {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string] $Dir)

    if (Test-ForbiddenInstallDir -Dir $Dir) { return "forbidden" }
    if (Test-Path -LiteralPath $Dir -PathType Leaf) { return "file" }
    if (-not (Test-Path -LiteralPath $Dir -PathType Container)) { return "empty" }

    $items = @(Get-ChildItem -LiteralPath $Dir -Force -ErrorAction SilentlyContinue)
    if ($items.Count -eq 0) { return "empty" }
    if (Test-PulsInstallDir -Dir $Dir) { return "puls" }
    return "foreign"
}

# Guard PRZED destrukcyjnym Move-Item: kosz lezy w katalogu tmp kasowanym w finally,
# wiec pomylka w odpowiedzi o katalog (korzen dysku, katalog dokumentow, literowka we
# wklejonej sciezce) trwale kasowalaby dane usera - Move-PreservedDirs ratuje wylacznie
# data\ i .node\. Fail-closed: obca zawartosc podmieniamy WYLACZNIE po jawnym "t";
# brak interaktywnego wejscia = odmowa, nie domyslna zgoda.
#
# -Answer to szew testowy (podzial jak Read-InstallDir/Resolve-InstallDir: odczyt osobno,
# decyzja osobno). Bez niego sciezka produkcyjna czyta klawiature jak dotad; z nim suita
# sprawdza WSZYSTKIE trzy warianty odpowiedzi bez czlowieka przy terminalu. Rozroznienie
# "podano" od "podano pusty" idzie przez PSBoundParameters, bo [string] nie ma $null.
function Confirm-InstallDirReplaceable {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyString()][string] $Dir,
        [AllowEmptyString()][string] $Answer
    )

    $kind = Get-InstallTargetKind -Dir $Dir
    if ($kind -eq "empty" -or $kind -eq "puls") { return }

    if ($kind -eq "forbidden") {
        throw "Katalog instalacji '$Dir' to katalog domowy albo korzen dysku - instalacja podmienia ten katalog w calosci. Podaj podkatalog, np. $(Join-Path $HOME 'claude-cron')."
    }
    if ($kind -eq "file") {
        throw "Sciezka instalacji '$Dir' wskazuje plik, nie katalog. Podaj sciezke katalogu."
    }

    Write-Host "[warn] Katalog '$Dir' nie jest pusty i NIE wyglada na instalacje Pulsa." -ForegroundColor Yellow
    Write-Host "[warn] Instalacja podmienia go w calosci - zachowane zostana tylko data\ i .node\." -ForegroundColor Yellow

    $reply = ""
    $canAsk = $true
    if ($PSBoundParameters.ContainsKey("Answer")) {
        $reply = $Answer
    }
    else {
        try {
            $reply = Read-Host "Skasowac zawartosc $Dir i zainstalowac tam Pulsa? [t/N]"
        }
        catch {
            $canAsk = $false  # host bez konsoli / przekierowany stdin - nie ma kogo zapytac
        }
    }

    # "Nie ma jak zapytac" i "user wcisnal Enter" to DWA rozne stany (parytet z install.sh:
    # has_tty -> osobny fail, pusty Enter -> "Przerwane na zyczenie"). Sklejenie ich radzi
    # userowi siedzacemu przy terminalu "uruchom instalator interaktywnie", czyli zrobic to,
    # co wlasnie robi - a przy braku konsoli gubi jedyna dzialajaca droge wyjscia.
    if (-not $canAsk) {
        throw "Brak interaktywnego wejscia, zeby potwierdzic skasowanie zawartosci '$Dir'. Podaj pusty katalog przez INSTALL_DIR albo uruchom instalator interaktywnie."
    }
    if ($reply.Trim().ToLower() -notin @("t", "tak", "y", "yes")) {
        throw "Przerwane na zyczenie - zawartosc '$Dir' nietknieta. Uruchom instalator ponownie i podaj inny katalog."
    }
    Write-Host "[ok] Potwierdzono podmiane katalogu $Dir." -ForegroundColor Green
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

# Pyta API GitHuba o SHA commita wskazywanego przez galaz. Zwraca "" gdy sie nie uda -
# brak sieci / limit API nie moze wywrocic instalacji, zejdziemy na URL po nazwie galezi.
function Get-RefSha {
    param(
        [Parameter(Mandatory = $true)][string] $Slug,
        [Parameter(Mandatory = $true)][string] $Ref
    )
    try {
        $resp = Invoke-RestMethod -Uri "https://api.github.com/repos/$Slug/commits/$Ref" -UseBasicParsing
        if ($resp.sha -match '^[0-9a-f]{40}$') { return $resp.sha }
        return ""
    }
    catch {
        return ""
    }
}

# Ustala URL zipa, nazwe katalogu po rozpakowaniu i rewizje do zapisania.
# Ustawia zmienne skryptowe $ZipUrl / $ZipTopDir / $InstallRevision.
function Resolve-ZipSource {
    if ($ZipUrl) {
        # Jawny override: nie zgadujemy rewizji, ufamy temu, co podal wolajacy.
        if (-not $ZipTopDir) { $script:ZipTopDir = "claude-cron-$RepoRef" }
        return
    }

    Write-Host "[info] Ustalam rewizje galezi $RepoRef..." -ForegroundColor Cyan
    $sha = Get-RefSha -Slug $RepoSlug -Ref $RepoRef
    if ($sha) {
        $script:ZipUrl          = "https://github.com/$RepoSlug/archive/$sha.zip"
        $script:ZipTopDir       = "claude-cron-$sha"
        $script:InstallRevision = $sha
        Write-Host "[ok] Rewizja: $sha" -ForegroundColor Green
    }
    else {
        Write-Warning "Nie ustalilem rewizji - pobieram po nazwie galezi (wersja instalacji: unknown)."
        $script:ZipUrl    = "https://github.com/$RepoSlug/archive/refs/heads/$RepoRef.zip"
        $script:ZipTopDir = "claude-cron-$RepoRef"
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

# Zatrzymuje daemona Pulsa dzialajacego Z TEGO katalogu instalacji.
# Windows nie pozwala przeniesc ani skasowac pliku, ktory ma otwarty uchwyt - zywy
# serwer trzyma data\claude-cron.db, wiec re-run instalatora padal na Move-Item
# ("Proces nie moze uzyskac dostepu do pliku..."). Na Unixie problemu nie ma (przenoszenie
# otwartego pliku jest legalne), dlatego install.sh tego nie potrzebuje.
# Filtr po CommandLine z GRANICA SCIEZKI (znormalizowany katalog + '\') - NIE zabijamy
# cudzych procesow node. Goly Contains lapal rodzenstwo ("C:\puls" trafialo w proces
# z "C:\puls-backup"), a przy odpowiedzi usera w rodzaju katalogu domowego - kazdy proces
# node tego uzytkownika. Katalog domowy i korzen dysku sa odrzucane wprost (fail-closed).
# Daemon wstaje z powrotem po instalacji (hook autostartu / Task Scheduler).
function Get-PulsProcessPathPrefix {
    param([Parameter(Mandatory = $true)][string] $Dir)
    return ([System.IO.Path]::GetFullPath($Dir).TrimEnd('\') + '\')
}

# Czyste dopasowanie linii polecen do prefiksu sciezki instalacji - wydzielone, zeby
# test sprawdzal ZACHOWANIE filtra, a nie powtarzal wyrazenia z Where-Object.
# Porownanie MUSI byc case-insensitive: sciezki Windows nie rozrozniaja wielkosci liter,
# wiec daemon zapisany jako "C:\Puls\..." przezywal filtr zbudowany z "C:\puls\" i
# blokowal pliki -> Move-Item padal na "Proces nie moze uzyskac dostepu do pliku".
function Test-PulsProcessPath {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyString()][AllowNull()][string] $CommandLine,
        [Parameter(Mandatory = $true)][string] $Prefix
    )
    if ([string]::IsNullOrEmpty($CommandLine)) { return $false }
    return $CommandLine.IndexOf($Prefix, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Stop-PulsProcesses {
    param([Parameter(Mandatory = $true)][string] $Dir)

    if (Test-ForbiddenInstallDir -Dir $Dir) {
        Write-Host "[warn] Pomijam zatrzymywanie procesow: '$Dir' to katalog domowy albo korzen dysku." -ForegroundColor Yellow
        return
    }
    $prefix = Get-PulsProcessPathPrefix -Dir $Dir

    $procs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { Test-PulsProcessPath -CommandLine $_.CommandLine -Prefix $prefix })
    if ($procs.Count -eq 0) { return }

    foreach ($p in $procs) {
        Write-Host "[info] Zatrzymuje daemona Pulsa (PID $($p.ProcessId)) - trzyma pliki instalacji." -ForegroundColor Cyan
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
    # Windows zwalnia uchwyty asynchronicznie po zabiciu procesu.
    Start-Sleep -Seconds 2
}

# Atomowy(-ish) swap: swieze repo -> $InstallDir, stare -> kosz w tmp.
# Najpierw przenosi data\ i .node\ ze starej instalacji do swiezej.
function Install-FreshRepo {
    param(
        [Parameter(Mandatory = $true)][string] $FreshDir,
        [Parameter(Mandatory = $true)][string] $TmpDir
    )

    # Guard PRZED jakakolwiek zmiana na dysku - katalog to wolna odpowiedz usera.
    Confirm-InstallDirReplaceable -Dir $InstallDir

    $parent = Split-Path -Parent $InstallDir
    if ($parent -and -not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }

    if (Test-Path -LiteralPath $InstallDir) {
        # PRZED jakimkolwiek ruchem na plikach - inaczej Move-Item padnie na zablokowanej bazie.
        Stop-PulsProcesses -Dir $InstallDir
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

    # Katalog PRZED pobraniem czegokolwiek - Install-FreshRepo i Stop-PulsProcesses
    # dostaja juz docelowa sciezke (filtr procesow idzie po sciezce instalacji).
    $script:InstallDir = Read-InstallDir

    Write-Host ""
    Write-Host "  Pobieram repo do $InstallDir (bez git) i konfiguruje." -ForegroundColor DarkGray
    Write-Host ""

    $tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("claude-cron-boot-" + [System.Guid]::NewGuid().ToString())
    New-Item -ItemType Directory -Path $tmpDir | Out-Null
    try {
        Resolve-ZipSource
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

# ============ ZALEZNOSCI (node_modules przez portable npm) ============

# Instaluje zaleznosci produkcyjne przez npm z portable Node (nie systemowego -
# bootstrap nie dotyka PATH). Bootstrap NIE przenosi node_modules ze starej
# instalacji, wiec swiezy katalog zawsze wymaga instalacji. Portable Node musi
# byc w PATH, bo install-script koffi (cnoke) spawnuje `node`.
function Install-Dependencies {
    param(
        [Parameter(Mandatory = $true)][string] $NodeExe,
        [Parameter(Mandatory = $true)][string] $RepoDir
    )
    $nodeDir = Split-Path -Parent $NodeExe
    $npmCli  = Join-Path $nodeDir "node_modules\npm\bin\npm-cli.js"
    if (-not (Test-Path -LiteralPath $npmCli)) {
        throw "Nie znaleziono npm w portable Node: $npmCli"
    }

    Write-Host "[info] Instaluje zaleznosci (npm install)..." -ForegroundColor Cyan
    $oldPath = $env:PATH
    $oldLocation = Get-Location
    try {
        $env:PATH = "$nodeDir;$env:PATH"
        Set-Location $RepoDir
        & $NodeExe $npmCli install --omit=dev --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) {
            throw "npm install zakonczyl sie kodem $LASTEXITCODE."
        }
    }
    finally {
        Set-Location $oldLocation
        $env:PATH = $oldPath
    }
    Write-Host "[ok] Zaleznosci zainstalowane." -ForegroundColor Green
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
    # Rewizja jedzie env-em: setup.mjs zapisuje ja do data\version.json JUZ PO swapie
    # katalogow - inaczej plik trafilby do katalogu, ktory za chwile ladowal w koszu.
    # W trybie lokalnym nic nie ustawiamy i setup siega po `git rev-parse`.
    if ($InstallRevision) {
        $env:CLAUDE_CRON_INSTALL_REVISION = $InstallRevision
        $env:CLAUDE_CRON_INSTALL_SOURCE   = $InstallSource
    }
    # --disable-warning=ExperimentalWarning: setup.mjs czyta lib/db (node:sqlite),
    # a ostrzezenie o eksperymentalnym module wypadloby POMIEDZY pytaniami setupu -
    # dla kursanta nieodroznialne od bledu. Ta sama flaga co w package.json.
    & $NodeExe "--disable-warning=ExperimentalWarning" (Join-Path $RepoDir "setup.mjs")
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
    Install-Dependencies -NodeExe $nodeExe -RepoDir $repoDir
    Invoke-Setup -NodeExe $nodeExe -RepoDir $repoDir
}

# Test harness moze wczytac tylko funkcje (CLAUDE_CRON_LIB_ONLY=1),
# bez odpalania main (pobierania Node / setup.mjs).
if ($env:CLAUDE_CRON_LIB_ONLY -ne "1") {
    Invoke-Main
}
