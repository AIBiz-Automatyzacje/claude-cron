# Zadania: Połączony instalator VPS (Obsidian + Puls)

Branch: `feature/instalator-vps-obsidian-puls`
Ostatnia aktualizacja: 2026-07-02

> Fazy = IU 1–7 z planu technicznego. `Test:` = scenariusze testowe, `Weryfikacja:` = automatyzowalne kryteria PASS/FAIL (odznaczane przez review), `[Manual]`/Operator = kroki człowieka.

## Faza 1: Szkielet komponentowy (IU1)

- [x] Restrukturyzacja `scripts/install-vps.sh`: stałe → helpery → funkcje-komponenty → `main "$@"` za guardem `CLAUDE_CRON_LIB_ONLY` (istniejące sekcje przenoszone BEZ zmian zachowania)
- [x] Parsowanie flag pętlą `case`: `--only-puls`, `--no-obsidian`, `--reset`, `--port <n>`, `--tz <tz>`, `--device-name <s>`, `--no-auto-update`, `--help`; nieznana → fail; wykluczenia z `--reset`
- [x] Helper `ask_tty VAR "prompt" "default"` — jedyne miejsce z `read`, czyta z `/dev/tty`, fallback (default lub fail przy braku defaultu)
- [x] Helper `run_login "opis" login_cmd verify_cmd` — pętla max 3 prób + `halt_leave_partial` (exit ≠ 0, BEZ rollbacku, komunikat resume)
- [x] Rollback-stos: `push_rollback` + `trap on_err ERR` + `disable_rollback`/`enable_rollback`
- [x] Env-override: `CLAUDE_CRON_REPO` / `CLAUDE_CRON_REF` (fallback jak dziś)
- [x] Ujednolicenie komunikatów user-facing na PL przy przenoszeniu sekcji
- [x] Stwórz `scripts/install-vps.test.sh` (harness: lib-only source, sandbox mktemp + trap EXIT, pass/problem)
- [x] Test: parsowanie flag — `--port 8888` ustawia PORT; nieznana flaga → exit ≠ 0; `--reset` + `--only-puls` → exit ≠ 0
- [x] Test: `ask_tty` bez tty (wstrzyknięta ścieżka) — default → zwraca default; brak defaultu → fail z czytelnym komunikatem
- [x] Test: `run_login` — verify fail 2× + pass 3. → sukces; fail 3× → `halt_leave_partial`, rollback-stos NIE odwinięty
- [x] Test: `push_rollback` + symulowany błąd → cofnięcie w odwrotnej kolejności; `disable_rollback` → błąd nie odwija stosu
- [x] Test: `bash -n scripts/install-vps.sh` przechodzi
- [ ] Weryfikacja: `bash -n scripts/install-vps.sh` — zero błędów składni
- [ ] Weryfikacja: `bash scripts/install-vps.test.sh` — wszystkie asercje PASS
- [ ] Weryfikacja: `grep -n 'read -r' scripts/install-vps.sh` poza definicją `ask_tty` zwraca 0 linii

## Faza 2: Preflight + detekcja stanu + blok 4 pytań (IU2)

- [ ] Preflight: EUID=0, `/etc/os-release` (Debian/Ubuntu), internet (`curl -fsI api.github.com`)
- [ ] Checklist prerequisites (6 pozycji ze spec-u, w tym hasło e2e i konto Tailscale) → `ask_tty` „[Enter = mam wszystko]"
- [ ] Guardy `has_*`: `has_user_claude`, `has_supported_node`, `has_claude_auth`, `has_gh_auth`, `has_ob_auth` + `has_ob_sync` (DWA OSOBNE), `has_service`, `has_tailscale_ip` — exit code first, czyste-testowalne (DI)
- [ ] Blok 4 pytań przez `ask_tty`: email (walidacja `@`), vault (niepuste), repo (`normalize_repo`: format + normalizacja `user/repo`→URL), Discord webhook (puste = pomiń; walidacja prefixu) → podsumowanie → „Kontynuujemy? [T/n]"
- [ ] Auto-wartości: `DEVICE_NAME=vps-$(hostname)`, `PORT=7777`, TZ autodetekcja `timedatectl` → fallback `Europe/Warsaw` (+ override flagami)
- [ ] Tryb `--only-puls`: pomiń pytania Obsidianowe, przywróć pytanie o workspace (z normalizacją ścieżki jak dziś L219–224)
- [ ] Test: `normalize_repo` — `user/repo` → pełny URL; https URL → bez zmian; ssh/śmieci → exit ≠ 0
- [ ] Test: walidacja emaila (brak `@` → ponowne pytanie) i Discord URL (zły prefix → ponowne pytanie)
- [ ] Test: autodetekcja TZ — pusty wynik `timedatectl` (wstrzyknięty) → `Europe/Warsaw`
- [ ] Test: `has_ob_auth` vs `has_ob_sync` — zalogowany-bez-synca daje (0,1); checki NIE sklejone
- [ ] Test: [Manual] checklist prerequisites wyświetla 6 pozycji i czeka na Enter (na prawdziwym pipe)
- [ ] Weryfikacja: `bash scripts/install-vps.test.sh` — nowe asercje PASS
- [ ] Weryfikacja: `grep -c 'ask_tty' scripts/install-vps.sh` ≥ 6 oraz `read -r` nadal tylko w `ask_tty`

## Faza 3: Narzędzia (IU3)

- [ ] `apt-get install -y git curl ca-certificates cron gh` (guard `command -v gh`)
- [ ] Node: sekcja nodesource przeniesiona do funkcji (progi `>=22.13 <25` bez zmian)
- [ ] `useradd -m -s /bin/bash claude` za guardem; `push_rollback "userdel -r claude"` TYLKO gdy user powstał w tym runie
- [ ] Claude Code NATYWNIE: `su - claude -c "curl -fsSL https://claude.ai/install.sh | bash"` → guard `command -v claude`
- [ ] `npm i -g obsidian-headless` (pomijane przy `--only-puls`)
- [ ] Instalacja Tailscale przeniesiona TU (install + czekanie na daemon; `tailscale up` w Fazie 4)
- [ ] Test: kolejność w `main()` — wszystkie `install_*` PRZED `login_block` (rejestrator wywołań)
- [ ] Test: `--only-puls` → kroki obsidianowe nie wywoływane (rejestrator)
- [ ] Test: rollback warunkowy — `has_user_claude`=istnieje → brak `userdel` na stosie
- [ ] Test: [Manual] czysty Ubuntu: `command -v node gh claude ob tailscale` po Fazie 2 spec-u
- [ ] Weryfikacja: `bash scripts/install-vps.test.sh` — asercje sekwencji i guardów PASS
- [ ] Weryfikacja: `grep -n '@anthropic-ai/claude-code' scripts/install-vps.sh` → 0 linii

## Faza 4: Blok 5 loginów (IU4)

- [ ] **GATE (Operator, przed implementacją):** spike `su - claude -c "cmd" < /dev/tty` pod prawdziwym pipe (Docker/multipass Ubuntu) — rozstrzyga formę redirectu (alternatywy: `runuser`/`sudo -u`)
- [ ] `disable_rollback` na wejściu bloku, `enable_rollback` na wyjściu
- [ ] PAUZA 1: login Claude (`su - claude -c "claude"` + `/dev/tty`) → nieinteraktywna weryfikacja
- [ ] PAUZA 2: `gh auth login` (device flow) → `gh auth status`; po sukcesie `gh auth setup-git` + walidacja `gh repo view <REPO>` z retry-in-place (ponowne pytanie o repo przy 404)
- [ ] PAUZA 3: `ob login --email '<EMAIL>'` → weryfikacja `has_ob_auth`
- [ ] PAUZA 4: `ob sync-setup --vault … --path ~/vault --device-name …` → weryfikacja `has_ob_sync`
- [ ] PAUZA 5: `tailscale up` → weryfikacja `tailscale ip -4` niepuste
- [ ] Każda pauza za swoim guardem (resume); pauzy 3–4 pomijane przy `--only-puls`
- [ ] Test: wszystkie guardy=zrobione → zero wywołań loginów (pełny resume)
- [ ] Test: guard gh=brak, reszta=zrobione → wywołana tylko PAUZA 2 (+ setup-git + walidacja repo)
- [ ] Test: walidacja repo — `gh repo view` fail → ponowne pytanie → drugie podejście z nowym repo (atrapy)
- [ ] Test: rollback-stos nietknięty przy `halt_leave_partial` w środku bloku
- [ ] Test: [Manual] pełny blok 5 loginów na czystym VPS przez prawdziwy pipe: pauzy czytają z klawiatury; literówka → retry; 3× fail → komunikat resume; re-run wskakuje w brakujący login
- [ ] Weryfikacja: `bash scripts/install-vps.test.sh` — asercje sekwencji/guardów/retry PASS
- [ ] Weryfikacja: `grep -n 'su - .*-c' scripts/install-vps.sh` — każda linia z interaktywnym CLI zawiera `/dev/tty`

## Faza 5: Obsidian + Puls (IU5)

- [ ] `ob sync-config --path ~/vault --file-types image,audio,video,pdf,unsupported` → weryfikacja `sync-status` zawiera `unsupported` (fail → `fail`, pod trapem)
- [ ] Sparse checkout `.claude` z `<REPO>` → `~/vault-git` (gh credential helper, czysty URL); guard: istniejący `.git` → `git pull`
- [ ] Symlink `ln -sfn ~/vault-git/.claude ~/vault/.claude` (idempotentny)
- [ ] Systemd `obsidian-sync`: `ob sync --continuous`, `Restart=always`, `User=claude`, `ExecStartPre` lock cleanup
- [ ] Puls: sekcje clone/pull + `npm install --production` + `mkdir data/` + systemd `claude-cron` przeniesione do funkcji; `WORKSPACE=~/vault` na sztywno (pytanie tylko w `--only-puls`); TZ z autodetekcji; bez `WEBHOOK_BASE_URL` (Funnel w Fazie 6)
- [ ] Kolejność twarda w `main()`: sync-config → weryfikacja → `enable --now obsidian-sync`
- [ ] Rollback automatów: `systemctl disable --now` + usunięcie unit-plików utworzonych w tym runie
- [ ] Test: budowa ENV_LINES (czysta funkcja) — pełny tryb → WORKSPACE/PORT/PATH; z Discordem → linia DISCORD; bez → brak
- [ ] Test: generacja unitu obsidian-sync (czysta funkcja) — zawiera `Restart=always`, `User=claude`, ścieżkę vault
- [ ] Test: weryfikacja file-types — wyjście bez `unsupported` → fail; z → pass (atrapy)
- [ ] Test: symlink idempotentny — drugi run nie failuje, cel bez zmian
- [ ] Test: [Manual] na VPS: `~/vault/.claude/skills` widoczne przez symlink; oba unity `active`
- [ ] Weryfikacja: `bash scripts/install-vps.test.sh` — asercje ENV_LINES/unitów/file-types PASS
- [ ] Weryfikacja: test kolejności w harnessie — `sync-config` w `main()` PRZED `enable --now obsidian-sync`

## Faza 6: Sieć + finał (IU6)

- [ ] UFW: sekcja bez zmian merytorycznych (allow 22 pierwsze, deny `$PORT`, idempotencja)
- [ ] Auto-update ZAWSZE (opt-out `--no-auto-update`): sudoers NOPASSWD + node-guard heredoc + cron **02:00** (bez zmiany godziny); fix P3: cytowanie `"$VAULT_GIT"` w CRON_CMD; `--only-puls` → bez segmentu vault-git
- [ ] Weryfikacja serwisów: `systemctl is-active` ×2; pętla do 90 s na pierwszy sync
- [ ] Plik-dowód: heredoc → `~/vault/Witaj-z-VPS.md` (treść PL ze spec-u) + komunikat „otwórz Obsidiana na telefonie" (pomijany przy `--only-puls`)
- [ ] Funnel: `ask_tty` „[t/N]" NA KOŃCU; T → `tailscale funnel --bg $PORT` → URL (fallback: zapytaj) → `sed -i` WEBHOOK_BASE_URL + daemon-reload + restart; N → nic
- [ ] Podsumowanie PL: dashboard z adnotacją „po lekcji o Pulsie", webhooki (jeśli Funnel), komendy, security-nota
- [ ] Test: budowa CRON_CMD (czysta funkcja) — ścieżka ze spacją cytowana; `--only-puls` → bez vault-git; `--no-auto-update` → cron nie instalowany
- [ ] Test: treść pliku-dowodu (czysta funkcja) — nagłówek + PL treść; podsumowanie: z Funnel → sekcja webhooków, bez → adnotacja o lekcji
- [ ] Test: Funnel=N → zero wywołań `tailscale funnel` (rejestrator)
- [ ] Test: [Manual] telefon: notatka „Witaj z VPS" dochodzi przez Sync; Funnel=T → `curl https://<funnel-url>/webhook/test` odpowiada (nie timeout)
- [ ] Weryfikacja: `bash scripts/install-vps.test.sh` — asercje CRON_CMD/podsumowania/pliku-dowodu PASS
- [ ] Weryfikacja: `grep -n '0 2 \* \* \*' scripts/install-vps.sh` — godzina crona 02:00 niezmieniona

## Faza 7: `--reset` + README (IU7)

- [ ] `--reset`: wypisz DOKŁADNĄ listę → potwierdzenie wpisaniem `TAK` → kolejność: stop/disable serwisów → unit-pliki → cron root (dedup-filter) → `/etc/sudoers.d/claude-cron` → `userdel -r claude` (komunikat: dane Sync bezpieczne na serwerze Obsidian)
- [ ] KAŻDY `rm -rf` z guardem `${var:?}` i `[ -e ]`
- [ ] Świadome NIE-usuwanie: Tailscale (instrukcja `tailscale logout` + admin console), UFW (instrukcja `ufw delete deny <PORT>`), Node/gh/apt
- [ ] README: sekcja „Instalacja na VPS" — prerequisites (checklist), one-liner, wariant `wget -qO-`, flagi przez `bash -s --`, `--reset`, env-override do testów z brancha
- [ ] Test: `--reset` bez potwierdzenia `TAK` → exit bez żadnego usunięcia (rejestrator)
- [ ] Test: lista usuwanych ścieżek — funkcja budująca listę bez pustych zmiennych (walidacja guardów)
- [ ] Test: `--reset` na czystym systemie (brak artefaktów) → przechodzi bez błędów (idempotentny)
- [ ] Test: [Manual] pełny cykl na VPS: install → `--reset` → re-install od zera
- [ ] Weryfikacja: `bash scripts/install-vps.test.sh` — asercje resetu PASS
- [ ] Weryfikacja: `grep -n 'rm -rf' scripts/install-vps.sh` — każda linia z `${…:?}` lub poprzedzającym guardem
- [ ] Weryfikacja: README zawiera sekcje one-liner/prerequisites/flagi (grep nagłówków)

## Operator gate (całościowy, poza autopilotem)

- [ ] Prawdziwy `curl … | sudo bash` z feature-brancha (env-override `CLAUDE_CRON_REPO`/`CLAUDE_CRON_REF`) na czystym Ubuntu: pełny happy path B1 (4 pytania → 5 loginów → notatka na telefonie)
- [ ] Scenariusz literówki: zły kod 2FA w `ob login` ×1 → retry; ×3 → leave-partial → re-run wznawia od `ob login`
- [ ] Re-run po sukcesie: pełny skip przez guardy, zero zmian stanu
- [ ] `--reset` → re-install od zera

## Źródła

- Plan techniczny: `docs/plans/2026-07-02-001-feat-instalator-vps-obsidian-puls-plan.md`
- Spec przebiegu: `docs/plans/2026-07-01-001-feat-polaczony-instalator-vps-flow.md`
