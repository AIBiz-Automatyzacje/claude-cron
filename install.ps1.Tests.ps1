# Skryptowe testy install.ps1 - symulują bootstrap/preserve-swap bez sieci.
# Ładujemy install.ps1 w trybie lib-only (CLAUDE_CRON_LIB_ONLY=1), żeby
# dostać same funkcje bez odpalania Invoke-Main (pobierania Node / setup.mjs).
#
# Uruchom (Windows, PowerShell 5.1+ / pwsh 7+):
#   powershell -NoProfile -File install.ps1.Tests.ps1
# Albo przez Pester, jeśli zainstalowany:
#   Invoke-Pester install.ps1.Tests.ps1
#
# Parytet z install.test.sh (Mac/Linux).

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Pass = 0
$Fail = 0

function Test-Pass { param([string] $Msg) Write-Host "  [PASS] $Msg"; $script:Pass++ }
function Test-Problem { param([string] $Msg) Write-Host "  [FAIL] $Msg"; $script:Fail++ }

# === Arrange: izolowana piaskownica + załadowanie funkcji ===
$Sandbox = Join-Path ([System.IO.Path]::GetTempPath()) ("claude-cron-test-" + [System.Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $Sandbox | Out-Null

try {
    # INSTALL_DIR celuje w piaskownicę, NIE w $HOME\claude-cron.
    $env:INSTALL_DIR = Join-Path $Sandbox "claude-cron"
    $env:CLAUDE_CRON_LIB_ONLY = "1"
    # install.ps1 jest UTF-8 bez BOM (BOM łamałby irm|iex). Dot-source plikowy na
    # PowerShell 5.1 czytałby go jako ANSI (misread diakrytyków) -> ładujemy przez
    # jawny odczyt UTF-8 (ReadAllText domyślnie UTF-8) i dot-source scriptbloku.
    . ([ScriptBlock]::Create([System.IO.File]::ReadAllText((Join-Path $ScriptDir "install.ps1"))))

    # --- Test 1: Move-PreservedDirs przenosi data\ i .node\ ---
    function Test-PreserveMovesDataAndNode {
        $old   = Join-Path $Sandbox "t1-old"
        $fresh = Join-Path $Sandbox "t1-fresh"
        New-Item -ItemType Directory -Path (Join-Path $old "data") -Force | Out-Null
        New-Item -ItemType Directory -Path (Join-Path $old ".node\bin") -Force | Out-Null
        New-Item -ItemType Directory -Path $fresh -Force | Out-Null
        Set-Content -Path (Join-Path $old "data\claude-cron.db") -Value "sentinel-db"
        Set-Content -Path (Join-Path $old ".node\bin\node.exe") -Value "node-bin"

        Move-PreservedDirs -OldDir $old -FreshDir $fresh

        $db = Join-Path $fresh "data\claude-cron.db"
        $node = Join-Path $fresh ".node\bin\node.exe"
        if ((Test-Path -LiteralPath $db) -and ((Get-Content -Raw $db).Trim() -eq "sentinel-db") -and (Test-Path -LiteralPath $node)) {
            Test-Pass "Move-PreservedDirs przenosi data\ i .node\ do świeżego repo"
        } else {
            Test-Problem "Move-PreservedDirs NIE przeniósł data\ lub .node\"
        }
    }

    # --- Test 2: Move-PreservedDirs to no-op gdy stara instalacja nie istnieje ---
    function Test-PreserveNoopWhenNoOld {
        $fresh = Join-Path $Sandbox "t2-fresh"
        New-Item -ItemType Directory -Path $fresh -Force | Out-Null
        try {
            Move-PreservedDirs -OldDir (Join-Path $Sandbox "does-not-exist") -FreshDir $fresh
            Test-Pass "Move-PreservedDirs to no-op gdy brak starej instalacji"
        } catch {
            Test-Problem "Move-PreservedDirs rzucił błąd przy braku starej instalacji: $_"
        }
    }

    # --- Test 5: Stop-PulsProcesses nie rusza cudzych procesow node ---
    # Regresja z 28.07 (Windows): re-run instalatora padal na Move-Item, bo zywy daemon
    # trzymal data\claude-cron.db. Fix zabija node'y TEGO katalogu instalacji - filtr po
    # CommandLine musi byc scisly, inaczej instalator ubija cudze aplikacje Node.
    function Test-StopPulsIgnoresForeignNode {
        # Proces spoza katalogu instalacji: sam fakt, ze to node.exe, nie moze wystarczyc.
        $foreign = Start-Process -FilePath "node" -ArgumentList "-e", "setTimeout(()=>{},30000)" -PassThru -WindowStyle Hidden -ErrorAction SilentlyContinue
        if (-not $foreign) {
            Test-Pass "Stop-PulsProcesses: pominieto (brak node w PATH)"
            return
        }
        try {
            Stop-PulsProcesses -Dir (Join-Path $Sandbox "nieistniejaca-instalacja")
            Start-Sleep -Milliseconds 500
            if (-not $foreign.HasExited) {
                Test-Pass "Stop-PulsProcesses nie rusza node'a spoza katalogu instalacji"
            } else {
                Test-Problem "Stop-PulsProcesses ubil obcy proces node"
            }
        } finally {
            if (-not $foreign.HasExited) { Stop-Process -Id $foreign.Id -Force -ErrorAction SilentlyContinue }
        }
    }

    # --- Test 3: KONTRAKT DANYCH - re-run z plikiem-strażnikiem nie kasuje data\ ---
    function Test-RerunPreservesSentinel {
        # Symulacja istniejącej instalacji w $InstallDir z plikiem-strażnikiem.
        New-Item -ItemType Directory -Path (Join-Path $InstallDir "data") -Force | Out-Null
        New-Item -ItemType Directory -Path (Join-Path $InstallDir ".node\bin") -Force | Out-Null
        Set-Content -Path (Join-Path $InstallDir "data\SENTINEL") -Value "guard"
        Set-Content -Path (Join-Path $InstallDir "server.js") -Value "old-code"
        Set-Content -Path (Join-Path $InstallDir ".node\bin\node.exe") -Value "node"

        # Świeże "rozpakowane repo" (jak z zipa) - nowy kod, BEZ data\.
        $fresh = Join-Path $Sandbox "t3-fresh"
        $tmp   = Join-Path $Sandbox "t3-tmp"
        New-Item -ItemType Directory -Path $fresh -Force | Out-Null
        New-Item -ItemType Directory -Path $tmp -Force | Out-Null
        Set-Content -Path (Join-Path $fresh "server.js") -Value "new-code"
        Set-Content -Path (Join-Path $fresh "setup.mjs") -Value "x"

        Install-FreshRepo -FreshDir $fresh -TmpDir $tmp

        $sentinel = Join-Path $InstallDir "data\SENTINEL"
        $node     = Join-Path $InstallDir ".node\bin\node.exe"
        $code     = Join-Path $InstallDir "server.js"
        $okSentinel = (Test-Path -LiteralPath $sentinel) -and ((Get-Content -Raw $sentinel).Trim() -eq "guard")
        $okNode     = Test-Path -LiteralPath $node
        $okCode     = (Get-Content -Raw $code).Trim() -eq "new-code"

        if ($okSentinel -and $okNode -and $okCode) {
            Test-Pass "re-run: data\SENTINEL i .node\ zachowane, kod nadpisany (kontrakt danych)"
        } else {
            Test-Problem "re-run ZŁAMAŁ kontrakt: sentinel=$okSentinel node=$okNode code=$okCode"
        }
    }

    # --- Test 4: install na czysto (brak istniejącej instalacji) ---
    function Test-FreshInstallWhenNoExisting {
        $target = Join-Path $Sandbox "t4-install\claude-cron"
        $script:InstallDir = $target # nadpisanie lokalne dla tego testu
        $fresh = Join-Path $Sandbox "t4-fresh"
        $tmp   = Join-Path $Sandbox "t4-tmp"
        New-Item -ItemType Directory -Path $fresh -Force | Out-Null
        New-Item -ItemType Directory -Path $tmp -Force | Out-Null
        Set-Content -Path (Join-Path $fresh "server.js") -Value "code"
        Set-Content -Path (Join-Path $fresh "setup.mjs") -Value "x"

        Install-FreshRepo -FreshDir $fresh -TmpDir $tmp

        if ((Test-Path -LiteralPath (Join-Path $target "setup.mjs")) -and (Test-Path -LiteralPath (Join-Path $target "server.js"))) {
            Test-Pass "czysta instalacja: repo wylądowało w InstallDir"
        } else {
            Test-Problem "czysta instalacja NIE umieściła repo w InstallDir"
        }
        $script:InstallDir = Join-Path $Sandbox "claude-cron" # przywróć
    }

    # --- Test 6: pusta odpowiedź na pytanie o katalog → wartość domyślna ---
    function Test-ResolveInstallDirEmptyAnswer {
        $fallback = Join-Path $HOME "claude-cron"
        $result = Resolve-InstallDir -Answer "" -Fallback $fallback
        $blank  = Resolve-InstallDir -Answer "   " -Fallback $fallback
        if ($result -eq $fallback -and $blank -eq $fallback) {
            Test-Pass "Resolve-InstallDir: sam Enter → domyślny katalog"
        } else {
            Test-Problem "Resolve-InstallDir: pusta odpowiedź dała '$result' / '$blank'"
        }
    }

    # --- Test 7: cudzysłowy z Explorera, ~ i ścieżka względna → absolutna ścieżka ---
    function Test-ResolveInstallDirSanitizes {
        $fallback = Join-Path $HOME "claude-cron"
        $quoted   = Resolve-InstallDir -Answer '  "C:\moje pulsy\instancja"  ' -Fallback $fallback
        $tilde    = Resolve-InstallDir -Answer "~\puls" -Fallback $fallback
        $relative = Resolve-InstallDir -Answer "puls" -Fallback $fallback -Base "C:\base"

        $okQuoted   = $quoted -eq "C:\moje pulsy\instancja"
        $okTilde    = $tilde -eq (Join-Path $HOME "puls")
        $okRelative = $relative -eq (Join-Path "C:\base" "puls")
        if ($okQuoted -and $okTilde -and $okRelative) {
            Test-Pass "Resolve-InstallDir: czyści cudzysłowy, rozwija ~ i ścieżkę względną"
        } else {
            Test-Problem "Resolve-InstallDir: quoted='$quoted' tilde='$tilde' relative='$relative'"
        }
    }

    # --- Test 8: instalacja w NIESTANDARDOWYM katalogu (odpowiedź usera → realny install) ---
    function Test-CustomInstallDirReceivesRepo {
        $answer = Join-Path $Sandbox "moje pulsy\instancja"
        $script:InstallDir = Resolve-InstallDir -Answer $answer -Fallback (Join-Path $HOME "claude-cron")
        $fresh = Join-Path $Sandbox "t8-fresh"
        $tmp   = Join-Path $Sandbox "t8-tmp"
        New-Item -ItemType Directory -Path $fresh -Force | Out-Null
        New-Item -ItemType Directory -Path $tmp -Force | Out-Null
        Set-Content -Path (Join-Path $fresh "server.js") -Value "code"
        Set-Content -Path (Join-Path $fresh "setup.mjs") -Value "x"

        Install-FreshRepo -FreshDir $fresh -TmpDir $tmp

        # Invoke-Setup odpala dokładnie "$RepoDir\setup.mjs" (RepoDir = InstallDir) —
        # obecność tego pliku to warunek startu instalacji w wybranym katalogu.
        if ((Test-Path -LiteralPath (Join-Path $answer "setup.mjs")) -and (Test-Path -LiteralPath (Join-Path $answer "server.js"))) {
            Test-Pass "niestandardowy katalog: repo (z setup.mjs do handoffu) wylądowało w wybranej ścieżce"
        } else {
            Test-Problem "niestandardowy katalog: brak repo w '$answer'"
        }
        $script:InstallDir = Join-Path $Sandbox "claude-cron" # przywróć
    }

    # --- Test 9: GUARD - obcy katalog NIE zostaje skasowany ---
    # Katalog instalacji jest wolną odpowiedzią usera, a stara zawartość leci do kosza
    # w tmp kasowanego w finally. Literówka we wklejonej ścieżce nie może kosztować danych.
    function Test-RejectsForeignInstallDir {
        $target = Join-Path $Sandbox "obcy-katalog"
        New-Item -ItemType Directory -Path $target -Force | Out-Null
        Set-Content -Path (Join-Path $target "moje-dane.txt") -Value "prywatne"
        $script:InstallDir = $target
        $fresh = Join-Path $Sandbox "t9-fresh"
        $tmp   = Join-Path $Sandbox "t9-tmp"
        New-Item -ItemType Directory -Path $fresh -Force | Out-Null
        New-Item -ItemType Directory -Path $tmp -Force | Out-Null
        Set-Content -Path (Join-Path $fresh "server.js") -Value "code"
        Set-Content -Path (Join-Path $fresh "setup.mjs") -Value "x"

        $threw = $false
        try {
            # Bez interaktywnego potwierdzenia guard MUSI odmówić (fail-closed).
            Confirm-InstallDirReplaceable -Dir $target
        } catch {
            $threw = $true
        }

        $dataAlive = (Test-Path -LiteralPath (Join-Path $target "moje-dane.txt")) -and
                     ((Get-Content -Raw (Join-Path $target "moje-dane.txt")).Trim() -eq "prywatne")
        $notInstalled = -not (Test-Path -LiteralPath (Join-Path $target "setup.mjs"))
        if ($threw -and $dataAlive -and $notInstalled) {
            Test-Pass "guard: obcy katalog odrzucony - dane usera nietkniete"
        } else {
            Test-Problem "guard: obcy katalog NIE zostal ochroniony (threw=$threw dane=$dataAlive)"
        }
        $script:InstallDir = Join-Path $Sandbox "claude-cron" # przywroc
    }

    # --- Test 10: klasyfikacja celu instalacji (parytet z classify_install_target) ---
    function Test-InstallTargetKinds {
        $empty = Join-Path $Sandbox "t10-pusty"
        $puls  = Join-Path $Sandbox "t10-puls"
        $file  = Join-Path $Sandbox "t10-plik.txt"
        New-Item -ItemType Directory -Path $empty -Force | Out-Null
        New-Item -ItemType Directory -Path (Join-Path $puls "data") -Force | Out-Null
        Set-Content -Path (Join-Path $puls "server.js") -Value "code"
        Set-Content -Path $file -Value "to plik"

        $okHome    = (Get-InstallTargetKind -Dir $HOME) -eq "forbidden"
        $okRoot    = (Get-InstallTargetKind -Dir ([System.IO.Path]::GetPathRoot($Sandbox))) -eq "forbidden"
        $okEmpty   = (Get-InstallTargetKind -Dir $empty) -eq "empty"
        $okMissing = (Get-InstallTargetKind -Dir (Join-Path $Sandbox "nie-ma-mnie")) -eq "empty"
        $okPuls    = (Get-InstallTargetKind -Dir $puls) -eq "puls"
        $okFile    = (Get-InstallTargetKind -Dir $file) -eq "file"

        if ($okHome -and $okRoot -and $okEmpty -and $okMissing -and $okPuls -and $okFile) {
            Test-Pass "Get-InstallTargetKind: HOME/korzen=forbidden, pusty=empty, instalacja=puls, plik=file"
        } else {
            Test-Problem "Get-InstallTargetKind: home=$okHome root=$okRoot empty=$okEmpty missing=$okMissing puls=$okPuls file=$okFile"
        }
    }

    # --- Test 11: filtr procesow ma GRANICE sciezki (C:\puls nie lapie C:\puls-backup) ---
    # Test wola Test-PulsProcessPath zamiast powtarzac wyrazenie z Where-Object: kopia
    # wyrazenia w tescie przechodzila nawet wtedy, gdy filtr w kodzie byl zepsuty.
    function Test-StopPulsPathBoundary {
        $prefix  = Get-PulsProcessPathPrefix -Dir "C:\puls"
        $own     = "C:\puls\.node\node-v22.17.0-win-x64\node.exe server.js"
        $sibling = "C:\puls-backup\.node\node-v22.17.0-win-x64\node.exe server.js"

        $okPrefix  = $prefix -eq "C:\puls\"
        $okOwn     = Test-PulsProcessPath -CommandLine $own -Prefix $prefix
        $okSibling = -not (Test-PulsProcessPath -CommandLine $sibling -Prefix $prefix)
        $okEmpty   = -not (Test-PulsProcessPath -CommandLine "" -Prefix $prefix)

        if ($okPrefix -and $okOwn -and $okSibling -and $okEmpty) {
            Test-Pass "Stop-PulsProcesses: filtr z granica sciezki nie lapie katalogu-rodzenstwa"
        } else {
            Test-Problem "Stop-PulsProcesses: prefix=$okPrefix own=$okOwn rodzenstwo=$okSibling pusty=$okEmpty"
        }
    }

    # --- Test 11b: filtr procesow jest NIECZULY na wielkosc liter ---
    # Sciezki Windows nie rozrozniaja wielkosci liter, a String.Contains porownuje
    # ordinalnie: daemon zapisany jako "C:\Puls\..." przezywal filtr z "C:\puls\",
    # trzymal pliki i Move-Item padal przy podmianie katalogu.
    function Test-StopPulsCaseInsensitive {
        $prefix = Get-PulsProcessPathPrefix -Dir "C:\puls"
        $upper  = "C:\PULS\.node\node-v22.17.0-win-x64\node.exe server.js"
        $mixed  = "c:\Puls\.node\node-v22.17.0-win-x64\node.exe server.js"
        # Granica sciezki musi dzialac RAZEM z ignorowaniem wielkosci liter.
        $sibling = "C:\PULS-backup\.node\node-v22.17.0-win-x64\node.exe server.js"

        $okUpper   = Test-PulsProcessPath -CommandLine $upper -Prefix $prefix
        $okMixed   = Test-PulsProcessPath -CommandLine $mixed -Prefix $prefix
        $okSibling = -not (Test-PulsProcessPath -CommandLine $sibling -Prefix $prefix)

        if ($okUpper -and $okMixed -and $okSibling) {
            Test-Pass "Stop-PulsProcesses: filtr lapie sciezke o innej wielkosci liter, nie lapie rodzenstwa"
        } else {
            Test-Problem "Stop-PulsProcesses case: upper=$okUpper mixed=$okMixed rodzenstwo=$okSibling"
        }
    }

    Write-Host "== install.ps1 - testy bootstrap/preserve =="
    Test-PreserveMovesDataAndNode
    Test-PreserveNoopWhenNoOld
    Test-RerunPreservesSentinel
    Test-FreshInstallWhenNoExisting
    Test-StopPulsIgnoresForeignNode
    Test-ResolveInstallDirEmptyAnswer
    Test-ResolveInstallDirSanitizes
    Test-CustomInstallDirReceivesRepo
    Test-RejectsForeignInstallDir
    Test-InstallTargetKinds
    Test-StopPulsPathBoundary
    Test-StopPulsCaseInsensitive

    Write-Host ""
    Write-Host "Wynik: $Pass PASS / $($Pass + $Fail) total"
    if ($Fail -ne 0) { exit 1 }
}
finally {
    Remove-Item -Recurse -Force $Sandbox -ErrorAction SilentlyContinue
    Remove-Item Env:\INSTALL_DIR -ErrorAction SilentlyContinue
    Remove-Item Env:\CLAUDE_CRON_LIB_ONLY -ErrorAction SilentlyContinue
}
