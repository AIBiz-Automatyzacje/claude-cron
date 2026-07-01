---
title: "Instalator cross-platform (irm|iex + curl|bash): kodowanie PS5.1, persystencja env, guard exit, symlink entry-point"
date: 2026-07-01
category: deployment-issues
severity: high
stack:
  - PowerShell
  - Node.js
  - Bash
tags:
  - installer
  - powershell
  - encoding
  - bom
  - env-persistence
  - entry-point-guard
  - symlink
  - macos
  - windows
status: verified
last_verified: 2026-07-01
---

# Instalator cross-platform (irm|iex + curl|bash): 5 pułapek wykrytych na realnych maszynach

Sesja testów operatorskich (Windows 11 + PowerShell 5.1, oraz macOS) na instalatorze
"jedna komenda" (`irm .../install.ps1 | iex` na Win, `curl .../install.sh | bash` na Mac,
handoff do `setup.mjs`) wykryła i naprawiła pięć niezależnych pułapek. Żadna nie manifestuje
się przy lokalnym uruchomieniu — wszystkie wychodzą dopiero na prawdziwej ścieżce dystrybucji.

## Symptomy

1. **PS 5.1 łamie parser skryptu**: `.\install.ps1` / `-File` / `Get-Content` na PowerShell 5.1
   czyta skrypt UTF-8 **bez BOM** jako ANSI (Windows-1250) — diakrytyki w komentarzach/stringach
   rozjeżdżają cudzysłowy i `ParserError`. Jednocześnie `irm|iex` **wymaga braku BOM** (BOM w
   strumieniu = błąd składni). Nie da się zadowolić obu ścieżek jednym kodowaniem gdy w pliku są diakrytyki.
2. **Env „zapisany" ale nieczytany na Windows**: setup pisał `export VAR=...` do `~/.zshrc`
   (ścieżka uniksowa). Na Windows plik nie jest czytany przez żaden shell — po restarcie zmiennej brak.
3. **`exit` zamyka całą sesję PowerShell operatora**: pod `irm|iex` skrypt biegnie w bieżącej
   sesji; `exit $code` w handoffie zamykał okno PowerShell, zanim operator zobaczył wypisany
   link do dashboardu.
4. **Entry-point guard nie odpala `main()` na macOS**: `path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)`
   zwraca `false`, bo `/var` to symlink do `/private/var` — proces uruchomiony spod `/var/folders/...`
   ma inną (niznormalizowaną) ścieżkę niż `import.meta.url`. Setup „nic nie robił".
5. **Test przed mergem pobierał `main` (stary kod)**: one-liner z `main` nie testował kodu z brancha.

## Root Cause

1. Konflikt kodowań: `irm|iex` (pipe do parsera) i `-File`/`Get-Content` (odczyt z dysku) na PS 5.1
   mają rozbieżne domyślne założenia co do BOM/ANSI. Diakrytyki w pliku ładowanym oboma ścieżkami
   są nie do pogodzenia bez jawnego `-Encoding UTF8` (którego nie da się wstrzyknąć w `irm|iex`).
2. Persystencja env była napisana tylko pod uniksowy model (RC shell), bez gałęzi win32.
3. `irm|iex` nie tworzy osobnego procesu skryptu — `exit` działa na sesję hosta.
4. macOS firmware-owe symlinki (`/var`, `/tmp`, `/etc` → `/private/*`) sprawiają, że dwie ścieżki
   wskazujące ten sam plik nie są string-równe bez `realpath`.

## Rozwiązanie

**(1) Skrypt `.ps1` ładowany przez `iex` = czyste ASCII.** Transliteruj diakrytyki w cienkim
bootstrapie do ASCII. Pełny polski zostawiaj tylko w plikach ładowanych JAWNYM odczytem
UTF-8 (`setup.mjs` uruchamiany przez `node`, `install.sh` na Mac). Dzięki temu skrypt parsuje
się identycznie pod `irm|iex`, `.\install.ps1` i `-File`, na PS 5.1 i PS7.

**(2) Persystencja env per platforma** — na Windows do User Environment (rejestr `HKCU\Environment`),
NIE do pliku RC:

```javascript
function persistEnvVar(varName, value, comment) {
  if (process.platform === 'win32') {
    // [Environment]::SetEnvironmentVariable(name, value, 'User') → widoczne w NOWYCH procesach
    persistUserEnvWin32(varName, value);
    process.env[varName] = value;              // ta sesja widzi od razu (autostart serwera)
    return 'środowisku użytkownika Windows (otwórz nowy terminal)';
  }
  const rcFile = resolveShellRc();             // Unix: .zshrc / .bashrc
  fs.writeFileSync(rcFile, upsertEnvLine(...), 'utf-8');
  process.env[varName] = value;
  return rcFile;
}
```

Escape wartości pojedynczymi cudzysłowami PS (`'' `= literalny `'`), żeby backslashe ścieżek
(`C:\Users\...`) zostały dosłowne.

**(3) `exit` tylko z pliku, nie pod `irm|iex`** — guard na `$PSScriptRoot` (puste pod pipe):

```powershell
& $NodeExe (Join-Path $RepoDir "setup.mjs")
$code = $LASTEXITCODE
# $PSScriptRoot ustawione TYLKO gdy uruchomione z pliku (-File / .\install.ps1).
# Pod irm|iex jest puste → exit zamknąłby sesję operatora zanim zobaczy link.
if ($PSScriptRoot) { exit $code }
```

**(4) `realpathSync` po OBU stronach entry-point guard** (Node):

```javascript
const invokedRealPath = process.argv[1] ? fs.realpathSync(process.argv[1]) : '';
if (invokedRealPath && invokedRealPath === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main().catch(...);
}
```

**(5) Test z brancha przed mergem** — env-override źródła bootstrapu, żeby one-liner ciągnął
kod z brancha zamiast `main`:

```powershell
$env:CLAUDE_CRON_ZIP_URL='https://github.com/.../archive/refs/heads/feature/xxx.zip'
$env:CLAUDE_CRON_ZIP_TOPDIR='claude-cron-feature-xxx'   # nazwa top-dir w zipie brancha
irm https://raw.githubusercontent.com/.../feature/xxx/install.ps1 | iex
```

Analogicznie `CLAUDE_CRON_TARBALL_URL` + `TOPDIR` dla `install.sh` (Mac). Instalator czyta te
zmienne z fallbackiem na `main`, więc produkcyjny one-liner zostaje bez env.

## Komendy diagnostyczne

```bash
# PS parse pod domyślnym kodowaniem (symuluje .\install.ps1 na PS5.1) — musi być PARSE OK
pwsh -NoProfile -Command "[void][System.Management.Automation.PSParser]::Tokenize((Get-Content -Raw install.ps1),[ref]$null)"

# Wykryj non-ASCII w skrypcie ładowanym przez iex (powinno być puste)
grep -nP '[^\x00-\x7F]' install.ps1

# Weryfikacja env na Windows (nowy proces, nie bieżący)
powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('VAR','User')"

# Sprawdź czy entry-point guard nie ucierpi na symlinkach macOS
node -e "const fs=require('fs');console.log(fs.realpathSync('/var'))"   # → /private/var
```

## Zapobieganie

- Skrypt ładowany przez `iex`/`irm` trzymaj w ASCII; diakrytyki tylko w plikach czytanych
  jawnym `-Encoding UTF8`/`node`. BOM łamie `iex`, brak BOM łamie `-File` na PS5.1 — ASCII omija oba.
- Persystencję env pisz per platforma: Windows → `[Environment]::SetEnvironmentVariable(...,'User')`;
  Unix → RC shell. Nigdy nie zakładaj `.zshrc` na Windows.
- Pod `irm|iex` NIE wywołuj `exit` bez guardu — zamyka sesję hosta. Guarduj na `$PSScriptRoot`.
- Entry-point guard w Node: `realpathSync` po OBU stronach porównania — macOS symlinkuje `/var`,`/tmp`,`/etc`.
- ZAWSZE testuj instalator prawdziwym `curl|bash` / `irm|iex`, z env-override na źródło brancha
  PRZED mergem. Lokalne `bash install.sh` / `.\install.ps1` ukrywają połowę tych bugów.

## Powiązane

- `docs/solutions/deployment-issues/2026-06-30-curl-bash-instalator-interaktywny-tty.md` — TTY/stdin
  w interaktywnym instalatorze `curl|bash` (komplementarne: tamten o czytaniu klawiatury, ten o
  kodowaniu/env/entry-point).

## Kontekst

Repo claude-cron, branch `feature/one-command-install`. Testy na Windows 11 + PowerShell 5.1
oraz macOS (Darwin). Pliki: `install.ps1` (bootstrap Windows), `install.sh` (Mac), `setup.mjs`
(wspólny handoff/UX). Wszystkie pięć fixów zweryfikowanych live 2026-07-01, one-liner z `main`
potwierdzony po fast-forward merge.
