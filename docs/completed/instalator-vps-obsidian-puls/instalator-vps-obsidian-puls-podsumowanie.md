# Podsumowanie: Połączony instalator VPS (Obsidian + Puls)

**Data ukończenia:** 2026-07-02
**Branch:** `feature/instalator-vps-obsidian-puls`
**Plan techniczny:** `docs/plans/2026-07-02-001-feat-instalator-vps-obsidian-puls-plan.md`
**Spec przebiegu (źródło produktowe):** `docs/plans/2026-07-01-001-feat-polaczony-instalator-vps-flow.md`

## Co zostało dostarczone

Przebudowa `scripts/install-vps.sh` (578 linii liniowego skryptu) w komponentowy, idempotentny instalator `curl … | sudo bash` dla kursantów (lekcja B1): Obsidian Sync (headless `ob`) + Puls + Tailscale na czystym Ubuntu VPS. 7 faz (IU1–IU7):

1. **Szkielet komponentowy** — stałe → helpery → funkcje-komponenty → `main "$@"` za guardem `CLAUDE_CRON_LIB_ONLY`; flagi (`--only-puls`, `--reset`, `--port`, `--tz`, `--device-name`, `--no-auto-update`); `ask_tty` (jedyne miejsce z `read`, `/dev/tty`); `run_login` (3× retry → `halt_leave_partial`); rollback-stos (`push_rollback` + `trap on_err ERR`); env-override `CLAUDE_CRON_REPO`/`CLAUDE_CRON_REF`.
2. **Preflight + detekcja stanu + blok 4 pytań** — checklist 6 prerequisites, guardy `has_*` (resume), pytania email/vault/repo/Discord z walidacją, auto-wartości (PORT/TZ/DEVICE_NAME/WORKSPACE).
3. **Narzędzia** — `install_*` (apt guard-first, nodesource 22.x, Claude CLI natywnie przez claude.ai/install.sh zamiast npm, `gh`, `obsidian-headless`, tailscale) przed `login_block`, test sekwencji po prefiksie nazw.
4. **Blok 5 loginów** — pauzy Claude → gh (device flow + `gh auth setup-git` + `validate_repo_access`) → `ob login` → `ob sync-setup` → `tailscale up`; handoff `su - claude -c … < /dev/tty` jednopunktowy (`login_cmd_as_claude` + redirect w `run_login`); `drop_rollback "userdel -r claude"` na wejściu (leave-partial chroni credenciale OAuth).
5. **Obsidian + Puls** — sync-config file-types (z `unsupported`) PRZED startem serwisu, sparse checkout `.claude` (`clone --filter=blob:none --sparse`), symlink `~/vault/.claude`, unit `obsidian-sync`, env Pulsa jako czysta funkcja.
6. **Sieć + finał** — UFW, auto-update cron 02:00 (opt-out `--no-auto-update`), weryfikacja serwisów + `wait_for_first_sync` (timeout = warn, nie fail), notatka-dowód `Witaj-z-VPS.md`, opcjonalny Funnel na końcu, podsumowanie PL.
7. **`--reset` + README** — plan resetu z jawną listą NIE-usunięć, potwierdzenie dosłownym `TAK`, `rm -rf` scentralizowany w `remove_reset_path` z guardem `${1:?}`; README sekcja „Krok 1 — Instalacja na VPS" (1.1–1.7).

Plus: `scripts/install-vps.test.sh` — harness 89 asercji (lib-only source, sandbox mktemp, rejestrator sekwencji `main()`, DI: `SYSTEMD_DIR`/`SUDOERS_DIR`/`TTY_DEVICE`) + grep-strażnicy (`read -r` tylko w `ask_tty`, guardy `rm -rf`).

## Kluczowe decyzje

- **Jeden samowystarczalny plik** (wymóg curl|bash) — świadomy wyjątek od reguły 300 linii; testowalność przez guard lib-only + DI.
- **`ask_tty`/`run_login` jako jedyne źródła interakcji** — egzekwowane grep-strażnikiem w harnessie, nie konwencją.
- **Rollback jako stos z granicą loginów**: automaty przed loginami → pełny rollback; od pierwszego loginu OAuth → leave-partial (NIGDY rollback, `drop_rollback "userdel -r claude"`), komunikat resume; re-run wskakuje w brakujący krok przez guardy `has_*`.
- **Rollback celowo BEZ apt/Claude-native/Tailscale** — odinstalowanie pakietów systemowych groźniejsze niż pozostawienie (re-run idempotentny).
- **gh device flow zamiast PAT** (`gh auth setup-git` = credential helper dla checkoutu i nocnego crona).
- **Claude Code natywnie** (`~/.local/bin/claude`), spójne z PATH w systemd; weryfikacja loginu przez `~/.claude/.credentials.json`, nie probe `claude -p` (koszt tokenów).
- **Dispatcher `run_verify`**: nazwa funkcji → wywołanie wprost, string → `bash -c`; `eval` odrzucony (bash 3.2 odpala trap ERR dla `eval` nawet w warunku `if`).
- **`add_webhook_env_line` jako czysta funkcja zamiast `sed -i "/…/i"`** — insert to GNU sed, harness biega na macOS (BSD sed).
- **Heurystyki na odroczonych formatach wyjść** (`is_sync_complete`, `parse_funnel_url`) z fallbackami warn/pytanie — realne formaty potwierdza Operator gate.
- **Wartości usera w `su -c`/cron zawsze przez `printf %q`**; dedup crontaba po markerze, nie substringu.

## Główne pliki

- `scripts/install-vps.sh` — przebudowany instalator (komponentowy, ~1600 linii)
- `scripts/install-vps.test.sh` — nowy harness (89 asercji PASS)
- `README.md` — nowa sekcja „Krok 1 — Instalacja na VPS" (1.1–1.7), przenumerowane odwołania Mac/Windows

## Stan na moment archiwizacji

- Wszystkie 7 faz: execute + review + fix DONE (0 otwartych P1/P2). Harness 89/89 PASS, suite projektu 163/163 PASS, `bash -n` czysty.
- **Otwarte pozostają (świadomie, poza gate'em autopilota):**
  - Backlog P3 per faza (11–23 pozycji, pełne listy z fixami w `review-faza-{1..7}.md`).
  - **Operator gate przed merge** (manualne, realny VPS): pełny happy path `curl | sudo bash` z env-override brancha; spike su+`/dev/tty` pod prawdziwym pipe (GATE R2/R6/R7); blok 5 loginów z retry/resume; granice bezpieczeństwa (ufw/Tailscale/Funnel); realne formaty `ob sync-status`/`tailscale funnel status` vs heurystyki; pełny cykl install → `--reset` → re-install.

## Wyciągnięte wnioski

- **Rollback-stos musi być świadomy granicy loginów** — wpis kasujący dane interaktywne (`userdel -r`) po udanym loginie OAuth niszczy credenciale przy ERR w późniejszych automatach; udokumentowane w `docs/solutions/deployment-issues/2026-07-02-rollback-stos-a-granica-loginow-oauth.md`.
- **Idempotencja re-run wymaga post-conditions, nie tylko guardów** — resume musi weryfikować STAN końcowy (origin, sparse-checkout, `[ -d .claude ]`), nie istnienie artefaktu-markera; po nadpisaniu unitu `systemctl restart`, nie `enable --now`.
- **Stubowane w testach sekwencji ≠ przetestowane** — granica user-input→shell wymaga testów TREŚCI komendy (dwuwarstwowe `%q`), a generowane skrypty (cron-node-guard) testów URUCHOMIENIA ze stubem, nie grepa treści.
- **Heurystyki substring na tekstach CLI = fałszywe pozytywy** (`complete` łapie `incomplete`) — word boundary + testy adversarialne + obowiązkowy punkt Operator checklist na żywym formacie.
- **Lista „NIE zostanie usunięte" resetu musi obejmować KAŻDY artefakt instalatora** (Funnel, globalny npm), a komunikaty ręczne czytać parametry z artefaktów instalacji (unit-plik), nie z flag bieżącego runu.
- **Deklaracja planu „egzekwowane testem" musi mieć test w harnessie** — grep-strażnik zamiast ręcznego odhaczenia chroni kolejne fazy przed regresją.
