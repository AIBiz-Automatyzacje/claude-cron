# Kontekst: Instalacja Pulsa jedną komendą

**Branch:** `feature/one-command-install`
**Ostatnia aktualizacja:** 2026-06-30

## Powiązane pliki

| Plik | Rola | Zmiana w zadaniu |
|------|------|------------------|
| `install.sh` | Bootstrap portable Node Mac/Linux → handoff `setup.mjs` | **Unit 1:** tryb dualny (curl\|tar bez git) + fix TTY `< /dev/tty` + kontrakt re-run |
| `install.ps1` | Bootstrap portable Node Windows → handoff `setup.mjs` | **Unit 2:** tryb dualny (irm + Expand-Archive bez git) + GATE 0 stdin + kontrakt re-run |
| `setup.mjs` | Gruby konfigurator (pytania, folder-picker, hook, smoke-test) | **Unit 3:** auto-start serwera + `buildOpenBrowserCommand` (Mac/Win) + zawsze print link |
| `setup.test.mjs` | Testy pure helperów (DI na spawn) | **Unit 3:** testy `buildOpenBrowserCommand` (darwin/win32/inne→null) |
| `README.md` | Instrukcja instalacji | **Unit 4:** trójplatformowe one-linery, usunięcie ręcznego startu |
| `scripts/install-vps.sh` | Samodzielny instalator VPS (systemd, root) | **Bez zmian** — VPS = osobny tor, nie woła setup.mjs |

## Decyzje techniczne

1. **Tryb dualny przez detekcję `setup.mjs` obok skryptu** — symetrycznie w `install.sh` (test pliku
   obok) i `install.ps1` (puste `$PSScriptRoot` pod `irm|iex` = sygnał bootstrap).
2. **Bootstrap bez git:** Mac tarball `archive/refs/heads/main.tar.gz` + `tar -xz`; Windows
   `archive/refs/heads/main.zip` + `Expand-Archive` (natywniejsze niż tar na Win). Fail-fast jeśli brak `setup.mjs` po rozpakowaniu.
3. **Lokalizacja:** `~/claude-cron` (Mac) / `$HOME\claude-cron` (Windows).
4. **KONTRAKT bezpieczeństwa danych (re-run):** rozpakuj świeże repo do tempa → przenieś `data/` +
   `.node/` ze starej instalacji → atomowy swap. Allowlist (`data/`, `.node/`), nie blacklist.
   Uzasadnienie z kodu (`setup.mjs` 301-396): config usera (vault, hook, Discord) żyje POZA repo
   (`{workspace}/.claude/` + shell rc) → przeżywa re-extract. Jedyny stan w repo do ochrony: `data/` + `.node/`.
5. **Fix TTY Mac:** `"$NODE_BIN" setup.mjs < /dev/tty` (gdy dostępne; fallback bez TTY).
6. **stdin Windows = GATE 0:** weryfikacja PRZED resztą Unitu 2; domyślnie bez zmian, łatka „czytaj z konsoli" jeśli EOF.
7. **Auto-open tylko Mac/Win:** `buildOpenBrowserCommand` → darwin `open`, win32 `Start-Process`/`cmd /c start ""`,
   każda inna platforma → `null`. ZAWSZE `console.log` z linkiem; auto-open best-effort. Bez detekcji DISPLAY/headless.
8. **VPS = robotnik na joby**, nie dashboard. Dashboard ogląda się wizualnie z Mac/Win. VPS nie woła setup.mjs → bez auto-open.
9. **Port 7777 zakładamy wolny** — kolizji nie obsługujemy (poza scope).

## Zależności

- **Zewnętrzne (zweryfikowane):** repo PUBLIC (HTTP 200 anonimowo dla raw + tarball/zip); `curl`+`tar`
  wbudowane macOS; `Invoke-WebRequest`+`Expand-Archive` wbudowane PowerShell 5.1+ (Win10/11).
- **Warunek wstępny:** Claude Code (`claude` w PATH) — `setup.mjs` wykrywa brak i kieruje. Bez zmian.
- **Kolejność:** Unit 1 ∥ Unit 2 → Unit 3 → Unit 4. Merge do `main` po teście (one-liner pobiera `main`).
- **Operator (niewykonalne headless):** test pełnego przebiegu na czystym Mac i czystym Windows; GATE 0 Windows.

## Źródła
- Requirements doc: brak (`docs/brainstorms/` nie istnieje)
- Plan techniczny: `docs/plans/2026-06-30-001-feat-instalacja-jedna-komenda-plan.md`
</content>
