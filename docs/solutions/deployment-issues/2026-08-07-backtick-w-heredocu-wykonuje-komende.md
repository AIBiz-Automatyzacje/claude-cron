---
title: "Backtick w komentarzu niequotowanego heredoca wykonuje komendę przy generowaniu pliku"
date: 2026-08-07
category: deployment-issues
severity: high
stack:
  - Bash
  - install-vps.sh
tags:
  - heredoc
  - backtick
  - command-substitution
  - code-generation
  - grep-straznik
status: verified
last_verified: 2026-08-07
---

# Backtick w heredocu `<<GUARD` wykonuje `git pull` z… komentarza

## Symptomy

- Podczas instalacji, między dwoma poprawnymi krokami, pojawia się osierocone
  `fatal: not a git repository (or any of the parent directories): .git`
- W xtrace widać sekwencję: `+ cat` → `++ git pull` → `on_err` ze statusem 128 —
  komenda wykonana **w trakcie rozwijania heredoca**, zanim `cat` cokolwiek zapisał

## Root Cause

Heredoc bez cudzysłowów (`<<GUARD`, nie `<<'GUARD'`) interpoluje `$var`, `$(…)` **i backticki**
w CAŁEJ treści — bash nie wie, że linia `# Odświeżenie data/version.json po nocnym \`git pull\` …`
jest komentarzem przyszłego skryptu; to dla niego zwykły tekst do rozwinięcia. `` `git pull` ``
wykonał się w cwd roota (nie-repo) → exit 128 → `trap ERR` w podpowłoce podstawienia → cichy
rollback (patrz dokument powiązany). Heredoc był niequotowany celowo (interpoluje progi wersji
Node do generowanego skryptu), więc problemem nie jest brak quotowania, tylko **niedozwolony
znak w treści**.

## Rozwiązanie

Commit `c7672b3` — w treści generowanej niequotowanym heredokiem backticki są zakazane;
w komentarzach apostrofy:

```bash
# ŹLE (wykona git pull przy generowaniu):
# Odświeżenie data/version.json po nocnym `git pull` — …

# DOBRZE:
# Odświeżenie data/version.json po nocnym 'git pull' — …
```

Plus grep-strażnik w harnessie, żeby regresja nie wróciła:

```bash
ticks=$(awk '/<<GUARD/,/^GUARD$/' "$INSTALLER" | grep -n '`' || true)
[ -z "$ticks" ] || problem "backtick w heredocu GUARD (wykona się przy generowaniu!)"
```

i test czystego generowania: `write_cron_node_guard` w katalogu BEZ repo gita nie może
wyemitować `fatal` ani zniekształcić komentarza.

## Komendy diagnostyczne

```bash
# Reprodukcja: generuj plik w katalogu bez .git i patrz na stderr/xtrace
bash -c 'export CLAUDE_CRON_LIB_ONLY=1; source scripts/install-vps.sh; set -x; write_cron_node_guard /tmp/g.sh /tmp/g.log' 2>&1 | grep -E "git|fatal"
```

## Zapobieganie

- Generatory plików przez niequotowany heredoc: zero backticków w treści (także w komentarzach!);
  zamierzone podstawienia w treści docelowej escapować `\$(…)`
- Każdy taki heredoc obudować grep-strażnikiem w testach (wzorzec „goły `read` poza ask_tty")
- Polskie komentarze z nazwami komend: apostrofy, nie backticki markdownowe

## Powiązane

- Skutek tego zapalnika: [cichy rollback w podpowłoce](2026-08-07-trap-err-w-podpowloce-cichy-rollback.md)
- Pokrewna klasa (znaki specjalne w skryptach): `2026-07-01-instalator-cross-platform-irm-iex-encoding-env-symlink.md`

## Kontekst

Komentarz doszedł w PR #8 (cron zapisuje version.json) — bug ujawnił się dopiero przy pierwszej
świeżej instalacji VPS po tym mergu (re-runy resume go maskowały innym przebiegiem). Namierzony
przez `BASH_XTRACEFD` na żywej maszynie, zreprodukowany lokalnie w sandboxie.
