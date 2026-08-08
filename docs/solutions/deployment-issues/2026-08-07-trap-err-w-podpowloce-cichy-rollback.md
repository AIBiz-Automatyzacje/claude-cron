---
title: "trap ERR odziedziczony przez podpowłokę wykonuje rollback bezgłośnie, a rodzic instalatora idzie dalej"
date: 2026-08-07
category: deployment-issues
severity: critical
stack:
  - Bash
  - systemd
  - install-vps.sh
tags:
  - trap-err
  - set-e
  - subshell
  - rollback
  - command-substitution
  - stderr
status: verified
last_verified: 2026-08-07
---

# trap ERR w podpowłoce = cichy rollback przy żywym rodzicu

## Symptomy

- Instalacja VPS „przechodzi" kolejne kroki, po czym pada daleko za miejscem realnej awarii:
  `install-vps.sh: line 1417: /etc/systemd/system/claude-cron.service: No such file or directory`
- `verify_services` raportuje oba serwisy „NIE działa", choć chwilę wcześniej instalator wypisał „✓ Serwis działa"
- W journalu systemd oba serwisy dostają czysty `systemctl stop` **w kolejności LIFO stosu rollbacku**
  (sekundę–dwie po starcie), bez żadnego śladu w transkrypcie instalatora
- Końcowy (widoczny) rollback wykonuje kroki, które „nie mają czego cofnąć" (`npm rm` → „up to date")

## Root Cause

`set -E` dziedziczy `trap ERR` do podpowłok — także do podstawień komend `$(…)`. Gdy komenda
wewnątrz podstawienia padła, `on_err` wykonał się **w podpowłoce**: komendy rollbacku (systemctl
stop/disable, `rm` unitów, `npm rm`) zmieniły REALNY stan maszyny, ale komunikaty poszły na
stdout — **przechwycony przez `$(…)`** — więc w terminalu nie pojawiło się nic. `exit` zakończył
tylko podpowłokę; rodzic kontynuował z **nietkniętą kopią stosu** (tablice nie propagują się
z podpowłoki) i padł dopiero na brakującym pliku unitu, odpalając drugi, tym razem widoczny
rollback pełnego stosu.

## Rozwiązanie

Dwa niezależne bezpieczniki w `on_err` (commit `99ba244`):

```bash
on_err() {
  local status=$?
  trap - ERR
  # 1) Podpowłoka NIGDY nie odwija stosu — tylko wychodzi ze statusem.
  #    Decyzję podejmuje trap rodzica.
  if [ "${BASH_SUBSHELL:-0}" -gt 0 ]; then
    exit "$status"
  fi
  if [ "$ROLLBACK_ENABLED" != "1" ]; then
    exit "$status"
  fi
  # 2) Cały raport rollbacku na STDERR — widoczny nawet przy przechwyconym stdout.
  {
    warn "Instalacja przerwana błędem (kod $status)."
    # ... odwijanie stosu ...
  } >&2
  exit "$status"
}
```

`BASH_SUBSHELL` (dostępny od bash 3.0) jest lepszy niż `BASHPID` (dopiero bash 4.0 — macOS ma 3.2).

## Komendy diagnostyczne

```bash
# Kto i kiedy zatrzymał serwisy — kolejność LIFO stosu zdradza rollback:
journalctl --no-pager | grep -E "Stopping|Stopped|Reloading requested"

# Reprodukcja z instrumentacją bez zaśmiecania stderr (kody logowań!):
sudo bash -c 'exec 9>/root/install-trace.log; export BASH_XTRACEFD=9; bash -x ./install-vps.sh'
```

## Zapobieganie

- Każdy `trap ERR` wykonujący akcje mutujące MUSI mieć guard na podpowłokę
- Komunikaty awaryjne zawsze na stderr — stdout bywa przechwycony
- Testy harnessa: `test_rollback_not_in_subshell` (stos nietknięty po `$(on_err)`),
  `test_rollback_output_on_stderr`

## Powiązane

- Zapalnik tego incydentu: [backtick w heredocu](2026-08-07-backtick-w-heredocu-wykonuje-komende.md)
- Wcześniejsze wzorce rollbacku: `2026-07-02-rollback-stos-a-granica-loginow-oauth.md`

## Kontekst

Incydent `srv1362522` 07.08.2026 (runda końcowa testów Team OS): pierwsza świeża instalacja
po PR #8 — serwisy stanęły o 12:44:15–16, instalator padł przy Funnelu, rollback końcowy
odwinął stos „drugi raz". Fix zweryfikowany pełną reinstalacją od zera (format maszyny).
