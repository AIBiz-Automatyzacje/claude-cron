# ============================================
#  CLAUDE-CRON — Deinstalacja autostartu (Windows)
#
#  Nowy layout (Unit 4/5): hook autostartu w {workspace}\.claude\hooks\
#  + wpis w {workspace}\.claude\settings.json pod hooks.UserPromptSubmit.
#  Logika usuwania wpisu jest WSPOLNA z setup.mjs (removeHookFromSettings).
#
#  Confirm-before-delete: portable Node (~50 MB w .node\) NIE jest kasowany
#  bez jawnej flagi -RemoveNode.
#
#  Uzycie:
#    powershell -ExecutionPolicy Bypass -File scripts\uninstall-windows.ps1 [-Workspace <sciezka>] [-RemoveNode]
#    -Workspace: domyslnie $HOME (spojne z domyslna odpowiedzia setupu)
# ============================================

param(
    [string]$Workspace = $HOME,
    [switch]$RemoveNode
)

$ErrorActionPreference = "Stop"

$RepoDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

Write-Host "CLAUDE-CRON — Deinstalacja autostartu" -ForegroundColor Green
Write-Host ""
Write-Host "[info] Workspace: $Workspace"

$HookFile = Join-Path $Workspace ".claude\hooks\claude-cron-autostart.js"
$SettingsFile = Join-Path $Workspace ".claude\settings.json"

# Wybor Node: preferuj portable z .node\, fallback na systemowy.
$NodeBin = $null
$PortableNode = Get-ChildItem -Path (Join-Path $RepoDir ".node") -Filter "node.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
if ($PortableNode) {
    $NodeBin = $PortableNode.FullName
} else {
    $SystemNode = Get-Command node -ErrorAction SilentlyContinue
    if ($SystemNode) { $NodeBin = $SystemNode.Source }
}

# Usun wpis hooka z settings.json przez wspolny helper removeHookFromSettings.
if (Test-Path $SettingsFile) {
    if (-not $NodeBin) {
        Write-Host "[warn] Nie znaleziono Node (ani w .node\, ani w PATH) — pomijam edycje settings.json." -ForegroundColor Yellow
        Write-Host "       Usun recznie wpis 'claude-cron-autostart' z $SettingsFile"
    } else {
        # Sciezki w stalej JS budujemy z JSON, by uniknac problemow z backslashami Windows.
        $SetupModule = (Join-Path $RepoDir "setup.mjs") -replace '\\', '/'
        $Script = @"
import fs from 'node:fs';
import { removeHookFromSettings } from '$SetupModule';
const file = process.argv[1];
const existing = JSON.parse(fs.readFileSync(file, 'utf-8'));
const { settings, removed } = removeHookFromSettings(existing);
fs.writeFileSync(file, JSON.stringify(settings, null, 2), 'utf-8');
console.log(removed ? '[ok] Wpis hooka usuniety z settings.json.' : '[info] Brak wpisu hooka w settings.json — nic do usuniecia.');
"@
        & $NodeBin --input-type=module -e $Script $SettingsFile
    }
} else {
    Write-Host "[info] Brak $SettingsFile — nic do wyczyszczenia."
}

# Usun plik hooka.
if (Test-Path $HookFile) {
    Remove-Item $HookFile -Force
    Write-Host "[ok] Plik hooka usuniety: $HookFile" -ForegroundColor Green
} else {
    Write-Host "[info] Brak pliku hooka — nic do usuniecia."
}

# Portable Node — tylko za jawna zgoda (confirm-before-delete).
$NodeDir = Join-Path $RepoDir ".node"
if ($RemoveNode) {
    if (Test-Path $NodeDir) {
        Remove-Item $NodeDir -Recurse -Force
        Write-Host "[ok] Portable Node usuniety: $NodeDir" -ForegroundColor Green
    } else {
        Write-Host "[info] Brak katalogu .node\ — nic do usuniecia."
    }
} else {
    Write-Host "[info] Portable Node (.node\, ~50 MB) zachowany. Usun go: -RemoveNode"
}

Write-Host ""
Write-Host "Autostart usuniety. Serwer nie wystartuje juz automatycznie." -ForegroundColor Green
Write-Host "   Twoje zadania i dane pozostaja nietkniete."
