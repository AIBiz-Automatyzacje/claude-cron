# Operator checklist — instalator VPS (Puls + Obsidian) ✅ ZALICZONY

> Scalona lista WSZYSTKICH zadań operatora z faz 1–7 + Operator gate całościowy.
> Przebiegi: 2026-07-02/03, VPS Hostinger srv1362522 (Ubuntu 24.04.4, git 2.43).
> **Wynik: wszystkie testy przed merge zaliczone.** Znalezione 3 bugi naprawione z testami regresyjnymi (Notatki).

## Przygotowanie (przed SSH na VPS)

- [x] Branch wypchnięty na origin
- [x] Konto Obsidian + remote vault + hasło E2E; prywatne repo `.claude`; konto Tailscale; telefon z Obsidianem

## Test 1 — Spike-GATE: `su` + `/dev/tty` pod prawdziwym pipe (R2/R6) ✅

- [x] CLI za `su` czyta z klawiatury pod prawdziwym pipe — Claude CLI (OAuth), gh device flow, hasła `ob login`/`ob sync-setup` — potwierdzone wielokrotnie
- [x] ~~Alternatywy runuser/sudo -u~~ — niepotrzebne, `su - … -c` + `/dev/tty` działa na Ubuntu 24.04

## Test 2 — Pełny happy path ✅

- [x] Checklist prerequisites czeka na Enter; 4 pytania czytają z klawiatury
- [x] Walidacja: email `abc` → `[warn] Niepoprawny email … spróbuj jeszcze raz` + retry (2026-07-03)
- [x] Podsumowanie + „Kontynuujemy?"
- [x] Narzędzia: Node 22.23.1, gh, Claude CLI, ob, Tailscale — komplet, `tailscaled` active
- [x] Blok 5 loginów przechodzi w całości (OAuth Claude, gh device flow, ob login, ob sync-setup z E2E, tailscale up)
- [x] `systemctl is-active obsidian-sync claude-cron` → oba active; symlink `~/vault/.claude` → `vault-git/.claude`
- [x] Funnel NA KOŃCU; `t` → URL + `WEBHOOK_BASE_URL` w unicie; podsumowanie PL
- [x] **R11 — nagroda:** notatka „Witaj z VPS" dotarła na telefon przez Sync (2026-07-02)
- [x] **Happy path w JEDNYM podejściu na czystym Ubuntu, zero interwencji** (2026-07-03, po 3 fixach) — rdzeń Operator gate

## Test 3 — Heurystyki na żywych wyjściach ✅ (zweryfikowane u źródła cli.js 0.0.12)

- [x] `ob sync-status` = tylko statyczna konfiguracja → heurystyka przebudowana na journal (`Fully synced` z `ob sync`); potwierdzone na żywo (natychmiastowe „Pierwszy sync zakończony" przy re-runie)
- [x] `parse_funnel_url` — URL zgodny z faktycznym publicznym adresem (curl z internetu)
- [x] Lock: `<vault>/.obsidian/.sync.lock` (źródła) = ścieżka w ExecStartPre
- [x] Git 2.43 ≥ 2.25 (sparse checkout OK)

## Test 4 — Granice bezpieczeństwa ✅ (weryfikowane po KAŻDEJ instalacji)

- [x] Internet → `:7777` timeout; Tailscale → 200; Funnel `/` → 403; `/webhook/test` → 405 odpowiada; `User=claude`
- [x] UFW włączany przez instalator od zera (`Firewall is active and enabled on system startup`, 2026-07-03 — po fixie `fe49e29`)

## Test 5 — Scenariusze błędów i wznowienia ✅

- [x] Złe hasło `ob login` ×1 → `Login failed` + retry-in-place → 2. próba OK (2026-07-03)
- [x] 3× fail → halt leave-partial z komunikatem resume (2026-07-02, sync-setup)
- [x] Re-run wskakuje w brakujący login (detekcja stanu „już gotowe" × zrobione kroki)
- [x] Re-run po PEŁNYM sukcesie → pełny skip wszystkich kroków, git pull zamiast clone, idempotentny Funnel, natychmiastowy sync-check (2026-07-02)

## Test 6 — Cykl `--reset` → re-install ✅ (2026-07-03)

- [x] Plan resetu: dokładna lista usuwanego + „NIE zostanie usunięte" — Funnel wymieniony w OBU listach
- [x] Potwierdzenie wpisaniem `TAK` (Enter = anuluj — pokryte testem 62 harnessu)
- [x] Kolejność: Funnel off → serwisy stop/disable → unit-pliki → sudoers → cron → `userdel -r` (warning o mail spool = nieszkodliwy)
- [x] Po resecie: `tailscale funnel status` → „No serve config"; `id claude` → no such user; unity not found; crontab bez wpisu Pulsa
- [x] Re-install od zera po resecie: detekcja stanu poprawna (Node/Tailscale zostają zgodnie z projektem, reszta od zera), pełna instalacja bez błędów, granice bezpieczeństwa ponownie zweryfikowane z zewnątrz

## Po merge

- [ ] Wycofanie starego repo `obsidian-vps-installer`
- [ ] Test one-linera z `main` (bez env-override) — ścieżka kursanta

## Notatki z przebiegu (2026-07-02/03)

Trzy realne bugi znalezione i naprawione w trakcie (wszystkie z testami regresyjnymi):

1. **Lock dpkg vs unattended-upgrades** (`9d8bd8b`): świeży VPS budzi unattended-upgrades po pierwszym `apt-get update`; nodesource padał na locku. Fix: `APT_CONFIG` z `DPkg::Lock::Timeout=900` (dziedziczony przez skrypty zewnętrzne). Potwierdzone na żywo: `Waiting for cache lock…` → kontynuacja. Przy okazji: `on_err` z pustym stosem rollbacku kończył CICHO — teraz zawsze komunikat + one-liner resume.
2. **Fałszywy pozytyw `has_ob_auth`** (`7c5e3c2`): niezalogowany `ob login </dev/null` kończy się kodem 0 (zawieszony drugi prompt → pusty event loop → cichy exit 0). Guard pomijał KROK 3/5. Fix: rozpoznanie po outputcie `Logged in as`. Bonus: `wait_for_first_sync` przebudowany z `ob sync-status` (tylko statyczna konfiguracja!) na journal serwisu (`Fully synced`).
3. **UFW nigdy nie włączany** (`fe49e29`, KRYTYCZNE): `grep -q "active"` matchuje `Status: inactive` — reguły w uśpionym firewallu, dashboard widoczny z internetu (curl: 200). Fix: kotwica `^Status: active` + weryfikacja stanu faktycznego. Ta sama klasa substring-bugów co pkt 2 — teza review P3 potwierdzona na żywo dwukrotnie.

Obserwacje bez zmian w kodzie: `gh` zapisuje token plain-text (headless, norma); pierwszy sync dużego vaulta > 90 s (timeout-warn zgodnie z projektem); pierwsze żądanie do świeżego hosta Funnela może dostać timeout (zimny start certu TLS); `userdel: claude mail spool not found` przy resecie = nieszkodliwy warning userdel; każdy reimage VPS z panelu tworzy nowy węzeł Tailscale — martwe węzły usuwać w admin console (inaczej URL Funnela dostaje suffix -2/-3).
