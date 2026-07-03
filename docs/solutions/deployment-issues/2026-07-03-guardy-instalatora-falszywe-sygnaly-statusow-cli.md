---
title: "Guardy instalatora VPS ufały fałszywym sygnałom: substring statusu, kod wyjścia CLI, brak locka apt"
date: 2026-07-03
category: deployment-issues
severity: critical
stack:
  - Bash
  - Ubuntu 24.04
  - systemd
  - UFW
  - obsidian-headless
  - apt
tags:
  - installer
  - ufw
  - substring-match
  - exit-code
  - unattended-upgrades
  - dpkg-lock
  - operator-gate
  - false-positive
status: verified
last_verified: 2026-07-03
---

# Guardy instalatora VPS ufały fałszywym sygnałom (3 bugi z Operator gate)

Trzy bugi wykryte podczas Operator gate `scripts/install-vps.sh` na żywym, świeżym VPS
(Hostinger, Ubuntu 24.04). Wspólny root-cause: **guard sprawdzał sygnał zastępczy
(substring, kod wyjścia, zamiar) zamiast stanu faktycznego**. Żaden z bugów nie był
wykrywalny harnessem z atrapami — atrapy modelowały błędne wyobrażenie o zachowaniu
zewnętrznych narzędzi, więc testy „kształtu" przechodziły.

## Symptomy

1. **KRYTYCZNE — dashboard publicznie widoczny**: instalator wypisał
   `✓ Port 7777 zablokowany w UFW`, a `curl http://<publiczne-ip>:7777` z internetu
   zwracał **200**. `ufw status` → `Status: inactive` — reguły dodane, firewall nigdy
   nie włączony.
2. **Pominięty krok logowania**: `✓ Obsidian (ob) już zalogowany — pomijam` na maszynie,
   gdzie nikt się nie logował; chwilę później `ob sync-setup` padał z
   `No account logged in. Run "ob login" first.`
3. **Pad instalacji Node bez słowa od instalatora**: skrypt nodesource kończył się
   `E: Unable to acquire the dpkg frontend lock (held by unattended-upgr)`, po czym
   instalator umierał **cicho** — goły błąd apt i prompt, zero komunikatu/instrukcji resume.

## Root Cause

1. `ufw status | grep -q "active"` **matchuje substring w „inactive"** → gałąź
   `ufw --force enable` nigdy nie wykonana na świeżym VPS (UFW domyślnie nieaktywny).
2. `has_ob_auth` ufał **kodowi wyjścia** `ob login </dev/null`. W trybie nie-TTY prompt
   `ob` czeka na event `end` stdin-a; `end` odpala się raz i zużywa go pierwszy prompt
   (email) — promise drugiego (hasło) nigdy się nie rozwiązuje, event loop Node
   pustoszeje i proces **kończy się kodem 0 bez logowania**.
3. Świeży VPS budzi `unattended-upgrades` po pierwszym `apt-get update` (dziesiątki
   zaległych pakietów z obrazu); ten trzyma locka dpkg wiele minut. Dodatkowo `on_err`
   z pustym stosem rollbacku robił `exit` bez żadnego komunikatu (pad nastąpił przed
   pierwszym `push_rollback`).

## Rozwiązanie

**1. Kotwica na statusie + weryfikacja stanu faktycznego** (`fe49e29`):

```bash
# ŹLE: grep -q "active"        — matchuje też "Status: inactive"
# DOBRZE:
if ! ufw status | grep -q '^Status: active'; then
  ufw --force enable
fi
# ...po konfiguracji potwierdź STAN, nie zamiar:
if ufw status | grep -q '^Status: active'; then
  ok "Port $PORT zablokowany w UFW"
else
  warn "UFW NIE jest aktywny — dashboard na porcie $PORT jest WIDOCZNY z internetu!"
fi
```

**2. Guard po unikalnej frazie outputu, nie kodzie wyjścia** (`7c5e3c2`):

```bash
# Zalogowany `ob login` wypisuje "Logged in as <nazwa> (<email>)";
# niezalogowany pod </dev/null kończy się 0 BEZ tej frazy.
has_ob_auth() {
  local out
  out="$(run_as_claude "ob login </dev/null" 2>/dev/null || true)"
  [[ "$out" == *"Logged in as"* ]]
}
```

Frazę zweryfikowano w **źródłach pakietu** (`npm pack obsidian-headless` + odczyt
`cli.js`), nie zgadywano. Ten sam audyt źródeł wykazał przy okazji, że
`ob sync-status` wypisuje wyłącznie statyczną konfigurację — pętla czekania na
pierwszy sync została przepięta na journal serwisu (linia `Fully synced` z `ob sync`).

**3. Timeout locka dpkg przez `APT_CONFIG` + głośny `on_err`** (`9d8bd8b`):

```bash
# Env dziedziczony przez procesy potomne — obejmuje też apt-get wywoływane
# WEWNĄTRZ zewnętrznych skryptów (nodesource setup_22.x); flaga -o by ich nie objęła.
setup_apt_lock_wait() {
  local conf; conf="$(mktemp)"
  printf 'DPkg::Lock::Timeout "900";\n' > "$conf"
  export APT_CONFIG="$conf"
}
# on_err: przy włączonym rollbacku ZAWSZE komunikat + one-liner resume,
# nawet gdy stos pusty (pad przed pierwszym push_rollback).
```

## Komendy diagnostyczne

```bash
ufw status | head -1                          # dokładny status, nie substring
su - claude -c "ob login </dev/null"; echo $? # exit 0 bez "Logged in as" = NIE zalogowany
fuser -v /var/lib/dpkg/lock-frontend          # kto trzyma locka dpkg
journalctl -u obsidian-sync -o cat | grep 'Fully synced'
curl -m 8 http://<publiczne-ip>:<port>        # granicę bezpieczeństwa testuj Z ZEWNĄTRZ
```

## Zapobieganie

- **Status CLI porównuj z dokładną frazą/kotwicą** (`^Status: active`, `Fully synced`),
  nigdy gołym substringiem (`active`, `synced`, `complete` łapią swoje negacje).
- **Kod wyjścia interaktywnego CLI pod EOF nie jest sygnałem stanu** — Node kończy się 0,
  gdy event loop opustoszeje z wiszącym promise. Guard = unikalna fraza z outputu.
- **Format wyjścia zewnętrznego CLI weryfikuj w jego źródłach** (`npm pack` + grep
  bundla), zamiast zgadywać regexy „na odroczone formaty".
- **Po skonfigurowaniu granicy bezpieczeństwa potwierdź stan faktyczny** (ponowny odczyt
  statusu) i przetestuj ją **z zewnątrz** (curl z innej sieci) — komunikat „✓ zablokowany"
  na podstawie zamiaru to fałszywe poczucie bezpieczeństwa.
- **Każdy skrypt dotykający apt na świeżym VPS** musi zakładać aktywnego
  `unattended-upgrades` (timeout locka, nie fail-fast).
- Ścieżki błędów muszą mówić: `on_err`/`trap` bez komunikatu = user zostaje z gołym
  błędem narzędzia i promptem.

## Powiązane

- `docs/solutions/deployment-issues/2026-07-02-rollback-stos-a-granica-loginow-oauth.md` — architektura rollback/leave-partial tego instalatora
- `docs/solutions/deployment-issues/2026-06-30-curl-bash-instalator-interaktywny-tty.md` — handoff `/dev/tty` pod pipe (spike-GATE potwierdzony w tym samym Operator gate)
- `docs/completed/instalator-vps-obsidian-puls/operator-checklist.md` — pełny przebieg gate'u z notatkami

## Kontekst

Operator gate 2026-07-02/03: pełny cykl `curl | sudo bash` → install → `--reset` →
re-install na żywym VPS. Wszystkie 3 bugi ujawniły się wyłącznie na realnym systemie —
harness (102 testy) miał atrapy `ufw`/`ob` modelujące błędny kontrakt. Po naprawach
atrapy przepisano na kontrakt potwierdzony u źródła + dodano scenariusze adversarialne
(exit 0 bez frazy; `Status: inactive`; „not synced"). obsidian-headless 0.0.12,
Ubuntu 24.04.4, tailscale 1.98.8, gh 2.45.
