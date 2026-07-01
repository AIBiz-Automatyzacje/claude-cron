# Runbook operatora — Windows GATE 0 (i dalsze testy)

Wszystkie komendy do wklejenia w **PowerShell na Windows**. Kopiuj całe bloki.
Odpalaj po kolei. Po sekcji **GATE 0** zatrzymaj się i wróć z wynikiem PASS/FAIL.

Środowisko docelowe: **Windows 10/11 + Windows PowerShell 5.1** (wbudowany `powershell.exe`).
Sprawdź wersję:

```powershell
$PSVersionTable.PSVersion
```

---

## GATE 0 — czy pytania setup.mjs przyjmują klawiaturę pod `irm|iex`?

**Ryzyko:** pod `irm|iex` stdin może być zamknięty (EOF). Wtedy `setup.mjs`
NIE crashuje — cicho bierze wartości domyślne. Objaw: setup przelatuje bez
zatrzymania na żadnym pytaniu.

### Krok 1 — izolowany probe (szybki, ~2 min)

Odtwarza dokładnie warunek: string podany potokiem do `iex`, który spawnuje `node`
z `readline`. **Każda komenda to JEDNA linia** — wklejaj pojedynczo (żadnych here-stringów).

Zapisz probe do pliku tymczasowego (jedna linia):

```powershell
Set-Content -Path "$env:TEMP\gate0-probe.js" -Encoding ascii -Value 'const rl=require(''readline'').createInterface({input:process.stdin,output:process.stdout});rl.question(''Wpisz cokolwiek i Enter: '',a=>{console.log(''>>> NODE ODCZYTAL: [''+a+'']'');rl.close();});'
```

Zlokalizuj Node i odpal probe przez potok do `iex` (jedna linia):

```powershell
$node=(Get-Command node -EA SilentlyContinue).Source; if(-not $node){$node=(Get-ChildItem "$HOME\claude-cron\.node" -Recurse -Filter node.exe -EA SilentlyContinue | Select-Object -First 1).FullName}; "& `"$node`" `"$env:TEMP\gate0-probe.js`"" | iex
```

**Interpretacja Kroku 1:**
- ✅ **PASS** — terminal się zatrzymuje i czeka; wpisujesz `abc`, Enter → `>>> NODE ODCZYTAL: [abc]`
- ❌ **FAIL** — bez pauzy od razu leci `>>> NODE ODCZYTAL: []` (pusto = EOF)

> Jeśli `$node` puste (brak Node globalnie i brak instalacji) — pomiń Krok 1,
> zrób od razu Krok 2 (pełny one-liner sam postawi portable Node).

### Krok 2 — pełny, realny test one-linera (definitywny)

```powershell
irm https://raw.githubusercontent.com/AIBiz-Automatyzacje/claude-cron/main/install.ps1 | iex
```

Obserwuj:
1. Pobranie repo (zip + Expand-Archive) do `$HOME\claude-cron`.
2. Postawienie portable Node w `.node\`.
3. Handoff do `setup.mjs` → **tu zaczyna się GATE 0**.
4. Może wyskoczyć **okno wyboru folderu** — wybierz workspace (to GUI, nie testuje stdin).
5. **Pytania tekstowe** (to jest test):
   - `Tailscale IP VPS-a (puste = tryb tylko lokalny):`
   - `Discord webhook URL (puste = pomiń):`
   - `Zainstalować autostart? [Y/n]:`

**Test właściwy:** przy pytaniu o Discord **wpisz** `test123` i Enter.
- ✅ **PASS** — setup czekał na Enter; po zakończeniu widać, że wartość została zapisana.
- ❌ **FAIL** — setup nie zatrzymał się na żadnym pytaniu, przeleciał wszystko naraz.

### ⛔ STOP — wróć z wynikiem

Napisz mi wynik **Kroku 1** i **Kroku 2** (PASS/FAIL + co użyłeś: PS 5.1/7, Terminal/conhost).
- **PASS** → odhaczam GATE 0, robisz sekcję „Po GATE 0" niżej.
- **FAIL** → dołączam łatkę `CONIN$` do `install.ps1` i dostajesz poprawioną wersję do retestu.

---

## Po GATE 0 (dopiero gdy GATE 0 = PASS)

Uruchamiaj z katalogu repo: `cd $HOME\claude-cron`

### Parse PowerShell (składnia bez błędów)

```powershell
$null = [ScriptBlock]::Create((Get-Content -Raw .\install.ps1)); "Parse OK"
```

Oczekiwane: wypisze `Parse OK`, bez czerwonych błędów.

### Suite testów install.ps1 (parytet z install.test.sh, bez sieci)

```powershell
powershell -NoProfile -File .\install.ps1.Tests.ps1
```

Oczekiwane: `[PASS]` przy każdym teście i podsumowanie bez `[FAIL]`.

### Grep detekcji trybu + bootstrapu (kontrola treści)

```powershell
Select-String -Path .\install.ps1 -Pattern 'archive/refs/heads/main.zip','Expand-Archive','setup.mjs','PSScriptRoot'
```

Oczekiwane: trafienia dla wszystkich czterech wzorców.

---

## Sprzątanie (opcjonalnie, dla czystego retestu)

```powershell
Remove-Item "$env:TEMP\gate0-probe.js" -ErrorAction SilentlyContinue
# UWAGA: poniższe kasuje CAŁĄ instalację (łącznie z data\ i .node\). Rób tylko na czystym teście.
# Remove-Item "$HOME\claude-cron" -Recurse -Force
```
