---
title: "Rollback-stos instalatora bash kasuje credentiale OAuth — granica loginów wymaga trybu leave-partial"
date: 2026-07-02
category: deployment-issues
severity: high
stack:
  - Bash
  - Linux (VPS)
  - systemd
tags:
  - installer
  - rollback
  - trap-err
  - oauth
  - leave-partial
  - curl-bash
  - bash-3.2
status: verified
last_verified: 2026-07-02
---

# Rollback-stos instalatora a granica interaktywnych loginów OAuth

## Symptomy

- Instalator VPS (`scripts/install-vps.sh`) z automatycznym rollbackiem (`trap on_err ERR` + stos LIFO) rejestruje na starcie `userdel -r claude`. Gdy błąd wystąpi PO udanym loginie OAuth Claude (`~/.claude/.credentials.json` już istnieje w `/home/claude`), odwinięcie stosu kasuje konto razem ze świeżymi credentialami — user musi powtarzać wszystkie logowania (P2-1 z review fazy 3).
- Pad samego loginu (user przerwał, brak przeglądarki, timeout device flow) traktowany jak zwykły błąd instalacji odwijałby cały stos, mimo że dotychczasowe kroki są poprawne i re-run mógłby je pominąć guardami.
- Objaw pochodny w harnessie (macOS, bash 3.2): weryfikacja pauzy przez `eval "$verify_cmd"` w warunku `if` mimo wszystko odpalała `trap ERR` i odwijała stos — fałszywe rollbacki w testach.

## Root Cause

Rollback-stos i blok interaktywnych loginów mają sprzeczne kontrakty. Rollback zakłada "cofnij wszystko z tego runu", ale po pierwszym udanym loginie OAuth stan przestaje być odtwarzalny automatycznie — credentiale są wynikiem interakcji człowieka, nie skryptu. Wpis `userdel -r` zarejestrowany przed loginami staje się destrukcyjny w momencie przekroczenia tej granicy, a `trap ERR` nie rozróżnia "pad automatu" od "pad interakcji".

## Rozwiązanie

Trzy mechanizmy w `scripts/install-vps.sh` (helpery `HELPERY: ROLLBACK`, ok. L315–417):

1. **Stos z możliwością neutralizacji wpisów** — `push_rollback` / `drop_rollback` (dokładne dopasowanie komendy) / `disable_rollback` / `enable_rollback`:

```bash
ROLLBACK_STACK=()
ROLLBACK_ENABLED=1
push_rollback()    { ROLLBACK_STACK+=("$1"); }
disable_rollback() { ROLLBACK_ENABLED=0; }
enable_rollback()  { ROLLBACK_ENABLED=1; }

# Idiom ${arr[@]+...} — bezpieczna ekspansja pustej tablicy pod set -u (bash 3.2).
drop_rollback() {
  local cmd="$1" entry
  local kept=()
  for entry in ${ROLLBACK_STACK[@]+"${ROLLBACK_STACK[@]}"}; do
    [ "$entry" = "$cmd" ] || kept+=("$entry")
  done
  ROLLBACK_STACK=(${kept[@]+"${kept[@]}"})
}
```

2. **Granica bloku loginów** — na wejściu `login_block()` zdjęcie destrukcyjnego wpisu i wyłączenie rollbacku; na wyjściu ponowne włączenie. Pad loginu (po 3 próbach retry-in-place lub rezygnacji usera) idzie przez `halt_leave_partial`: exit ≠ 0, stan ZOSTAJE, user dostaje one-liner wznowienia (guardy `has_*` pominą zrobione kroki):

```bash
login_block() {
  drop_rollback "userdel -r $CLAUDE_USER"   # credentiale w /home/claude — nie wolno ich cofnąć
  disable_rollback
  # ... 5 pauz run_login, każda za guardem has_* ...
  enable_rollback
}

halt_leave_partial() {
  local desc="$1"
  disable_rollback
  warn "Instalacja ZATRZYMANA na kroku: $desc"
  warn "Wykonane dotąd kroki NIE zostały cofnięte."
  warn "  $RESUME_ONE_LINER"
  exit 1
}
```

3. **Wpisy rollbacku tylko dla stanu z tego runu** — guard-first, potem `push_rollback` (nigdy cofania cudzego stanu: istniejącego usera, unit-pliku, wpisu crona sprzed runu). Symetrycznie: po finalnej weryfikacji serwisów opcjonalne kroki (Funnel, plik-dowód) = `warn`, nie `trap ERR` — pad opcjonalnego dodatku nie może odwijać działającej, zweryfikowanej instalacji.

Pułapki bash przy implementacji:

- `set -Eeuo pipefail` — bez `-E` (errtrace) `trap ERR` NIE działa wewnątrz funkcji.
- `eval` w weryfikacjach odpada: bash 3.2 (macOS, harness) odpala `trap ERR` dla `eval` nawet w kontekście warunku `if`. Dispatcher `run_verify`: goła nazwa funkcji instalatora → wywołanie wprost (child `bash -c` nie widzi funkcji), string → `bash -c`.
- Puste tablice pod `set -u` w bash 3.2 → idiom `${arr[@]+"${arr[@]}"}`.

## Komendy diagnostyczne

```bash
bash -n scripts/install-vps.sh                      # składnia
bash scripts/install-vps.test.sh                    # harness (testy rollbacku i sekwencji main)
grep -n "push_rollback\|drop_rollback\|halt_leave_partial" scripts/install-vps.sh
# Symulacja: czy pad po loginie nie kasuje /home/claude — test rejestratora w harnessie
```

## Zapobieganie

- Projektując instalator z rollbackiem, najpierw wyznacz granicę odtwarzalności: wszystko PRZED interakcją usera (apt, useradd, clone) jest cofalne; wszystko PO pierwszym loginie OAuth — już nie. Rollback kończy się na tej granicy, dalej obowiązuje leave-partial + resume przez guardy.
- Rejestruj wpis rollbacku ZARAZ po akcji mutującej (przed weryfikacją) i TYLKO gdy stan powstał w tym runie.
- Destrukcyjne wpisy (`userdel -r`, `rm -rf`) trzymaj jako dokładne stringi/stałe, żeby `drop_rollback` mógł je zdjąć dopasowaniem — magic stringi w dwóch miejscach się rozjeżdżają.
- Testuj sekwencję `main()` rejestratorem stubów, ale krytyczne funkcje rollbacku dodatkowo testami jednostkowymi z DI (stub w teście sekwencji ≠ przetestowana funkcja).

## Powiązane

- `docs/solutions/deployment-issues/2026-06-30-curl-bash-instalator-interaktywny-tty.md` — handoff `/dev/tty`, allowlista stanowych katalogów, `${var:?}`.
- `docs/solutions/deployment-issues/2026-07-01-instalator-cross-platform-irm-iex-encoding-env-symlink.md` — env-override źródła do testu z brancha.
- Review: `docs/active/instalator-vps-obsidian-puls/review-faza-3.md` (P2-1), `review-faza-4.md` (implementacja granicy), `review-faza-6.md` (konwencja "warn, nie fail" w finale).

## Kontekst

Zadanie `instalator-vps-obsidian-puls` (fazy 1–7): przebudowa `scripts/install-vps.sh` na jeden samowystarczalny plik pod `curl|bash` z 5 pauzami loginów (Claude CLI, gh device flow, Obsidian auth/sync, Tailscale). Harness `scripts/install-vps.test.sh` biega na macOS bash 3.2, docelowy runtime to Ubuntu — stąd podwójne pułapki bashowe. Weryfikacja: harness 89/89 PASS, suite projektu 163/163 PASS.
