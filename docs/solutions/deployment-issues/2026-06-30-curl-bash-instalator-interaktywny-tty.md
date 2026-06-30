---
title: "curl|bash instalator nie czyta odpowiedzi usera — stdin zajęty pipe'em ze skryptem"
date: 2026-06-30
category: deployment-issues
severity: high
stack:
  - Bash
  - PowerShell
  - Node
tags:
  - installer
  - curl-bash
  - tty
  - stdin
  - bootstrap
  - re-run-safety
status: verified
last_verified: 2026-06-30
---

# curl|bash instalator nie czyta odpowiedzi usera — stdin zajęty pipe'em ze skryptem

## Symptomy

- One-liner `curl -fsSL .../install.sh | bash` startuje, ale interaktywne pytania
  (`readline`, `read`) natychmiast dostają EOF / pustą odpowiedź i instalator leci
  przez wszystko z domyślnymi wartościami albo wywala się na pierwszym `read`.
- Lokalnie (`bash install.sh` z repo) wszystko działa — bug widać TYLKO w trybie pipe'a.
- Windows: pod `irm ... | iex` te same pytania nie czytają wpisywanego tekstu.

## Root Cause

W `curl ... | bash` **stdin procesu bash jest pipe'em z treścią skryptu**, nie
klawiaturą. Każde `read`/`readline` (również w `setup.mjs` odpalanym przez `exec`)
dziedziczy ten sam stdin → czyta resztki skryptu albo EOF, nie usera. To nie jest
błąd logiki pytań — to kolizja kanału stdin.

## Rozwiązanie

Przy handoffie do interaktywnego procesu podepnij `/dev/tty` (terminal sterujący),
zamiast dziedziczyć pipe. Fallback gdy `/dev/tty` niedostępne (środowisko nieinteraktywne):

```bash
handoff_to_setup() {
  if [ -r /dev/tty ]; then
    exec "$NODE_BIN" "$REPO_DIR/setup.mjs" < /dev/tty
  else
    warn "Brak /dev/tty — uruchamiam bez interaktywnego stdin."
    exec "$NODE_BIN" "$REPO_DIR/setup.mjs"
  fi
}
```

Na Windows (PowerShell pod `irm|iex`) odpowiednik to czytanie z konsoli (`CONIN$`)
zamiast z odziedziczonego strumienia — wyizolowane za flagą weryfikacji operatora,
bo headless nie da się tego potwierdzić.

Powiązany wzorzec z tej samej sesji — **kontrakt bezpieczeństwa danych przy re-run**
bootstrap-instalatora: świeże repo rozpakowywane do tempa, potem allowlistowane
katalogi (`data/`, `.node/`) przenoszone ze starej instalacji do świeżej PRZED
atomowym swapem. Allowlist (przenoś tylko znane stanowe katalogi), nie blacklist:

```bash
PRESERVE_DIRS=("data" ".node")   # baza SQLite + portable Node
preserve_existing_dirs() {
  local old_dir="$1" fresh_dir="$2"
  [ -d "$old_dir" ] || return 0
  for name in "${PRESERVE_DIRS[@]}"; do
    [ -e "$old_dir/$name" ] || continue
    rm -rf "${fresh_dir:?}/$name"   # ${var:?} — guard, by rm nigdy nie poleciał na /
    mv "$old_dir/$name" "$fresh_dir/$name"
  done
}
```

## Komendy diagnostyczne

```bash
# Powtórz dokładnie ścieżkę produkcyjną — bug NIE pojawia się przy lokalnym uruchomieniu:
curl -fsSL https://.../install.sh | bash

# Test harness: wczytaj tylko funkcje skryptu bez odpalania main (pobierania/instalacji):
CLAUDE_CRON_LIB_ONLY=1 bash -c 'source install.sh; preserve_existing_dirs ...'

# Walidacja składni przed odpaleniem:
bash -n install.sh
```

## Zapobieganie

- Każdy instalator dystrybuowany jako `curl|bash` / `irm|iex`, który zadaje pytania,
  MUSI przy handoffie podpiąć `/dev/tty` (Unix) lub czytać z `CONIN$` (Windows) —
  inaczej interaktywność cicho ginie. Testuj ZAWSZE przez prawdziwy pipe, nie lokalnie.
- Re-run bootstrap-instalatora chroni dane usera przez allowlist stanowych katalogów
  + atomowy swap, nie blacklist. `rm -rf "${var:?}/..."` zawsze z guardem `${var:?}`.
- Wydziel czyste funkcje za flagą (`CLAUDE_CRON_LIB_ONLY=1`), żeby testować logikę
  bootstrap bez efektów ubocznych (pobierania Node, podmiany katalogów).

## Powiązane

- `install.sh`, `install.ps1`, `setup.mjs` (Faza 1 zadania instalacja-jedna-komenda)
- Plan: `docs/plans/2026-06-30-001-feat-instalacja-jedna-komenda-plan.md`

## Kontekst

Projekt claude-cron (Puls): dashboard + portable Node. One-liner pobiera tarball
brancha `main` (bez git): Mac `tar -xz`, Windows `Expand-Archive`. Handoff bootstrap
→ `setup.mjs` (interaktywny konfigurator: vault, hook, Discord). Walidacja:
`node --test` 161/161, `install.test.sh` 4/4, `bash -n` / `node --check` zielone.
GATE 0 Windows i pełny przebieg na czystym Mac/Windows = weryfikacja operatora
(niewykonalne headless).
