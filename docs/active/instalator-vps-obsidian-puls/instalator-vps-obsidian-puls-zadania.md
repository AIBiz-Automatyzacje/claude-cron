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
- [x] Weryfikacja: `bash -n scripts/install-vps.sh` — zero błędów składni
- [x] Weryfikacja: `bash scripts/install-vps.test.sh` — wszystkie asercje PASS
- [x] Weryfikacja: `grep -n 'read -r' scripts/install-vps.sh` poza definicją `ask_tty` zwraca 0 linii

## Do poprawy po review fazy 1

- [x] 🟠 [P2] **scripts/install-vps.sh:445** — interaktywne pytanie o port (`configure_settings`) omija walidację numeryczną dodaną dla `--port`; śmieciowa wartość (np. `abc`) trafia do `ufw deny` (błąd zamaskowany `|| true` → reguła DENY nie powstaje, a summary kłamie „Port zablokowany"), do unitu systemd i do `tailscale funnel`. Fix: odpowiedź z `ask_tty` przez tę samą walidację co `FLAG_PORT` (regex `^[0-9]+$` + zakres 1–65535), fail-fast
- [x] 🟠 [P2] **scripts/install-vps.sh:146** — kontrakt `ask_tty` „brak tty + brak defaultu = twardy fail" nie działa bez kontrolującego terminala (ssh bez `-t`, cron, CI): `[ -r /dev/tty ]` zwraca true, ale `read < /dev/tty` pada z ENXIO, a `|| __answer=""` połyka błąd otwarcia jak EOF → pytanie bez defaultu cicho zwraca pusty string z rc=0. Fix: probe otwarcia przed gałęzią tty (np. `if { : < "$TTY_DEVICE"; } 2>/dev/null`) + rozróżnienie EOF od błędu redirekcji; test z realną semantyką, nie nieistniejącym plikiem
- [x] 🟠 [P2] **scripts/install-vps.sh:201** — `halt_leave_partial` łamie R6 spec-u: komunikat resume instruuje `sudo bash install-vps.sh`, ale w podstawowym trybie R2 (`curl … | sudo bash`) plik nie istnieje lokalnie → „No such file or directory". Fix: komunikat „wklej ponownie tę samą komendę" (one-liner)
- [x] 🟠 [P2] **scripts/install-vps.test.sh:252** — brak grep-strażnika na goły `read` poza `ask_tty` w harnessie, mimo że plan deklaruje „egzekwowany testem grep (IU1)"; fazy 2–7 dopiszą wiele interakcji i regresja przejdzie 14/14. Fix: test w harnessie — grep po definicjach poza `ask_tty` zwraca 0 linii
- [ ] 🟡 [P3] 19 pozycji P3 (KOD/TEST) — pełna lista z fixami w `docs/active/instalator-vps-obsidian-puls/review-faza-1.md` (m.in.: `fail()` nie odwija rollback-stosu; range-check portu 1–65535 w `parse_flags`; niecytowany `$vault_git` w cronie roota; sed-insert `WEBHOOK_BASE_URL` bez walidacji; webhook Discord plaintext w unit 0644; `--reset` nieskonsumowany = pełna instalacja; braki pokrycia `--port abc` / flag / gałęzi `n` w `run_login`)

## Operator checklist faza 1

- [ ] Operator: weryfikacja realnych granic bezpieczeństwa (ufw DENY blokuje port z internetu, dashboard tylko przez Tailscale, Funnel wystawia tylko `/webhook/*`, unit działa jako user `claude`) — Operator action: pełny przebieg `curl … | sudo bash` na czystym VPS Debian/Ubuntu z kontem Tailscale (env-override `CLAUDE_CRON_REPO`/`CLAUDE_CRON_REF` z feature-brancha); z zewnątrz `curl http://<publiczne-ip>:7777` → timeout/refused, przez Tailscale → 200, `curl https://<funnel-url>/` → 403, `/webhook/test` → odpowiada, `systemctl show claude-cron -p User` → `claude`
- [ ] Operator: spike handoffu `su - claude -c "claude" < /dev/tty` pod prawdziwym pipe (mechanizm R2/R7, decyzja #17) — Operator action: w Docker/multipass Ubuntu uruchom skrypt testowy przez `curl | sudo bash` i sprawdź, czy interaktywny CLI za `su` czyta z klawiatury; rozstrzygnij formę redirectu (alternatywy `runuser`/`sudo -u`) PRZED implementacją Fazy 4 (to jest GATE z planu IU4)
- [ ] Operator: zachowanie `ask_tty`/`run_login` pod prawdziwym `curl | sudo bash` (stdin=pipe, realny `/dev/tty`, granica su/PAM na Ubuntu) — Operator action: na czystym VPS odpal one-liner z env-override brancha; potwierdź: pytania czytają z klawiatury, literówka w loginie → retry, 3× fail → komunikat resume, re-run wznawia od brakującego kroku; wykonać przed merge

## Faza 2: Preflight + detekcja stanu + blok 4 pytań (IU2)

- [x] Preflight: EUID=0, `/etc/os-release` (Debian/Ubuntu), internet (`curl -fsI api.github.com`)
- [x] Checklist prerequisites (6 pozycji ze spec-u, w tym hasło e2e i konto Tailscale) → `ask_tty` „[Enter = mam wszystko]"
- [x] Guardy `has_*`: `has_user_claude`, `has_supported_node`, `has_claude_auth`, `has_gh_auth`, `has_ob_auth` + `has_ob_sync` (DWA OSOBNE), `has_service`, `has_tailscale_ip` — exit code first, czyste-testowalne (DI)
- [x] Blok 4 pytań przez `ask_tty`: email (walidacja `@`), vault (niepuste), repo (`normalize_repo`: format + normalizacja `user/repo`→URL), Discord webhook (puste = pomiń; walidacja prefixu) → podsumowanie → „Kontynuujemy? [T/n]"
- [x] Auto-wartości: `DEVICE_NAME=vps-$(hostname)`, `PORT=7777`, TZ autodetekcja `timedatectl` → fallback `Europe/Warsaw` (+ override flagami)
- [x] Tryb `--only-puls`: pomiń pytania Obsidianowe, przywróć pytanie o workspace (z normalizacją ścieżki jak dziś L219–224) — uwaga: tworzenie folderu przeniesione do `ensure_workspace` PO `useradd` (pytania lecą przed powstaniem `/home/claude`)
- [x] Test: `normalize_repo` — `user/repo` → pełny URL; https URL → bez zmian; ssh/śmieci → exit ≠ 0
- [x] Test: walidacja emaila (brak `@` → ponowne pytanie) i Discord URL (zły prefix → ponowne pytanie)
- [x] Test: autodetekcja TZ — pusty wynik `timedatectl` (wstrzyknięty) → `Europe/Warsaw`
- [x] Test: `has_ob_auth` vs `has_ob_sync` — zalogowany-bez-synca daje (0,1); checki NIE sklejone
- [ ] Test: [Manual] checklist prerequisites wyświetla 6 pozycji i czeka na Enter (na prawdziwym pipe) — wymaga operatora (checklist)
- [x] Weryfikacja: `bash scripts/install-vps.test.sh` — nowe asercje PASS (25/25 PASS, review fazy 2)
- [x] Weryfikacja: `grep -c 'ask_tty' scripts/install-vps.sh` ≥ 6 oraz `read -r` nadal tylko w `ask_tty` (17 wystąpień; jedyne `read -r` w L172 wewnątrz `ask_tty`)

## Do poprawy po review fazy 2

- [x] 🟠 [P2] **scripts/install-vps.sh:769** — `ensure_workspace` wykonuje `chown claude:claude "$WORKSPACE"` BEZWARUNKOWO (regresja: w fazie 1 chown tylko przy tworzeniu katalogu), a w `--only-puls` WORKSPACE pochodzi z `ask_workspace` bez ŻADNEGO walidatora (goły `ask_tty` zamiast `ask_valid`) — user może podać `/`, `/etc` albo katalog innego serwisu i root po cichu zmieni jego ownership. Fix: chown tylko dla świeżo utworzonego katalogu (lub po jawnym potwierdzeniu przejęcia istniejącego) + walidator ścieżki (absolutna, poza katalogami systemowymi) w `ask_workspace`
- [ ] 🟡 [P3] 23 pozycje P3 (KOD 18 / TEST 4 / E2E 1) — pełna lista z fixami w `docs/active/instalator-vps-obsidian-puls/review-faza-2.md` (m.in.: stale WORKSPACE po `resolve_install_paths`; brak walidacji `--tz`/`--device-name`; `normalize_repo` akceptuje dowolny host; niecytowany `Environment=` w unicie vs spacje w ścieżce; `echo -e` na userowym inpucie w podsumowaniu; `confirm_config` bez tty i z `^[Nn]$`-only; martwy fallback `detect_timezone` vs `apply_timezone` bez guardu; brak testów `resolve_install_paths`/`resolve_auto_values` i retry-then-success `ask_valid`)

## Operator checklist faza 2

- [ ] Operator: pełny przebieg FAZY 0+1 na realnym VPS — checklist prerequisites (6 pozycji, Enter przez `/dev/tty`), detekcja stanu z prawdziwymi `su`/`gh`/`ob`/`tailscale`/`getent`/`timedatectl`, blok 4 pytań + podsumowanie + „Kontynuujemy?" (domyka otwarty checkbox [Manual] fazy 2) — Operator action: czysty Debian/Ubuntu VPS (lub kontener z rootem), prawdziwy `curl … | sudo bash` z env-override `CLAUDE_CRON_REPO`/`CLAUDE_CRON_REF` z feature-brancha; potwierdź: checklist czeka na Enter, pytania czytają z klawiatury, walidacja odrzuca zły email/webhook z retry, re-run pokazuje wykryty stan; przy okazji rozstrzygnij przekazanie `/dev/tty` przez granicę `su` (pokrywa się ze spike'iem z Operator checklist fazy 1, GATE Fazy 4)

## Faza 3: Narzędzia (IU3)

- [x] `apt-get install -y git curl ca-certificates cron gh` (guard `command -v gh`) — zaimplementowane jako `install_base_packages`: guard-first per binarka (instaluje tylko brakujące), ca-certificates przy każdym przebiegu apt, fail-fast weryfikacja git/curl/crontab/gh po instalacji
- [x] Node: sekcja nodesource przeniesiona do funkcji `install_node` (progi `>=22.13 <25` bez zmian)
- [x] `useradd -m -s /bin/bash claude` za guardem; `push_rollback "userdel -r claude"` TYLKO gdy user powstał w tym runie
- [x] Claude Code NATYWNIE: `su - claude -c "curl -fsSL https://claude.ai/install.sh | bash"` → guard `command -v claude`
- [x] `npm i -g obsidian-headless` (pomijane przy `--only-puls`; decyzja o pominięciu w `main()`, nie wewnątrz funkcji) + rollback `npm rm -g obsidian-headless` gdy zainstalowany w tym runie
- [x] Instalacja Tailscale przeniesiona TU (`install_tailscale`: install + czekanie na daemon; `tailscale up` w Fazie 4)
- [x] Test: kolejność w `main()` — wszystkie `install_*` PRZED `login_block` (rejestrator wywołań)
- [x] Test: `--only-puls` → kroki obsidianowe nie wywoływane (rejestrator)
- [x] Test: rollback warunkowy — `has_user_claude`=istnieje → brak `userdel` na stosie
- [ ] Test: [Manual] czysty Ubuntu: `command -v node gh claude ob tailscale` po Fazie 2 spec-u — wymaga operatora (checklist)
- [x] Weryfikacja: `bash scripts/install-vps.test.sh` — asercje sekwencji i guardów PASS (31/31 PASS, review fazy 3)
- [x] Weryfikacja: `grep -n '@anthropic-ai/claude-code' scripts/install-vps.sh` → 0 linii (potwierdzone, review fazy 3)

## Do poprawy po review fazy 3

- [x] 🟠 [P2] **scripts/install-vps.sh:615** — rollback `userdel -r claude` pozostaje na stosie i aktywny PO bloku loginów (rollback wyłącza tylko `halt_leave_partial`). Na świeżej instalacji każdy ERR w późniejszych krokach automatycznych (`clone_repo` fail, `npm install` fail) odwija stos i wykonuje `userdel -r`, kasując `/home/claude` wraz z `~/.claude/.credentials.json` — niszczy świeżo wykonany interaktywny login OAuth Claude (sprzeczne z R6 leave-partial i decyzją 25). Fix: przed `userdel` w rollbacku sprawdzić brak credentiali (albo zdejmować/neutralizować wpis `userdel` po udanym loginie / po wejściu w `login_block`), ewentualnie `userdel` bez `-r` gdy credentials istnieją
- [x] 🟠 [P2] **scripts/install-vps.test.sh:595** — nowe funkcje fazy 3 (`install_base_packages`, `install_claude_cli`, `install_ob`, `install_tailscale`) nie mają ŻADNYCH testów jednostkowych własnego zachowania — w testach sekwencji (29–31) są w całości stubowane. Dodać per funkcja: happy path guard-skip (narzędzie już obecne → zero wywołań apt/npm/curl), error case fail-fast (weryfikacja po instalacji pada → fail) oraz test warunkowego rollbacku `install_ob` (`push_rollback "npm rm -g obsidian-headless"` TYLKO gdy zainstalowano w tym runie — symetrycznie do testu 31 dla `userdel`). Wzorzec DI do stubowania granicy systemu już istnieje (testy 23, 28, 31)
- [ ] 🟡 [P3] 17 pozycji P3 (KOD 13 / TEST 4, po scaleniu duplikatów) — pełna lista z fixami w `docs/active/instalator-vps-obsidian-puls/review-faza-3.md` (m.in.: pin wersji `obsidian-headless` + root lifecycle scripts; `install_ob` weryfikuje `ob` w PATH roota zamiast `run_as_claude`; `push_rollback` po weryfikacji zamiast po akcji mutującej; `install_tailscale` bez warn po timeout pętli + bezwarunkowy `sleep 2`; brak pipefail w `curl|bash` pod `su`; shadowing `local install_node`; duplikacja listy binarek; dwa szwy per-user (`run_as_claude` vs gołe `su`); test 29 tylko po konwencji nazw + brak asercji kolejności wewnątrz fazy; `MAIN_COMPONENT_FNS` bez asercji kompletności; doprecyzowanie R7 w planie)

## Operator checklist faza 3

- [ ] Operator: czysty Ubuntu VPS — po Fazie 2 spec-u komplet narzędzi obecny: `command -v node gh claude ob tailscale` (jedyna weryfikacja realnych zewnętrznych instalatorów: apt/universe `gh`, nodesource `setup_22.x`, `claude.ai/install.sh` jako user claude przez `su` z PATH `~/.local/bin`, `tailscale.com/install.sh` + start daemona, `npm -g obsidian-headless`; domyka otwarty checkbox [Manual] fazy 3) — Operator action: czysty Ubuntu VPS/kontener z rootem i siecią, prawdziwy `curl … | sudo bash` z env-override `CLAUDE_CRON_REPO`/`CLAUDE_CRON_REF` z feature-brancha; po dojściu instalatora do bloku loginów sprawdź `command -v node gh claude ob tailscale` (claude i ob także jako `su - claude -c "command -v claude ob"`) oraz `systemctl is-active tailscaled`; pokrywa się częściowo z Operator gate całościowym

## Faza 4: Blok 5 loginów (IU4)

- [ ] **GATE (Operator, przed implementacją):** spike `su - claude -c "cmd" < /dev/tty` pod prawdziwym pipe (Docker/multipass Ubuntu) — rozstrzyga formę redirectu (alternatywy: `runuser`/`sudo -u`); zaimplementowano wg decyzji 17 (handoff w `run_login`, forma `su` w jednym helperze `login_cmd_as_claude` — zmiana po spike'u jednopunktowa)
- [x] `disable_rollback` na wejściu bloku, `enable_rollback` na wyjściu (plus `drop_rollback "userdel -r claude"` z fazy 3 na wejściu)
- [x] PAUZA 1: login Claude (`login_cmd_as_claude "claude"` przez `run_login` + `$TTY_DEVICE`) → nieinteraktywna weryfikacja `has_claude_auth` (plik credentiali; probe `claude -p` odrzucony — koszt tokenów)
- [x] PAUZA 2: `gh auth login --web` (device flow) → weryfikacja `has_gh_auth`; po sukcesie (także przy resume z guardem) `gh auth setup-git` + walidacja `gh repo view` (`validate_repo_access`) z retry-in-place (ponowne pytanie o repo przy 404, pętla 3 prób)
- [x] PAUZA 3: `ob login --email <EMAIL przez printf %q>` → weryfikacja `has_ob_auth`
- [x] PAUZA 4: `ob sync-setup --vault … --path ~/vault --device-name …` (vault/device przez `%q`) → weryfikacja `has_ob_sync`
- [x] PAUZA 5: `tailscale up` (root, bez `su`) → weryfikacja `has_tailscale_ip`
- [x] Każda pauza za swoim guardem (resume); pauzy 3–4 pomijane przy `--only-puls`
- [x] Test: wszystkie guardy=zrobione → zero wywołań loginów (pełny resume; test 37)
- [x] Test: guard gh=brak, reszta=zrobione → wywołana tylko PAUZA 2 (+ setup-git + walidacja repo; test 38)
- [x] Test: walidacja repo — `gh repo view` fail → ponowne pytanie → drugie podejście z nowym repo (atrapy; test 39)
- [x] Test: rollback-stos nietknięty przy `halt_leave_partial` w środku bloku (test 40; bonus test 41: pauzy ob pomijane przy `--only-puls`)
- [ ] Test: [Manual] pełny blok 5 loginów na czystym VPS przez prawdziwy pipe: pauzy czytają z klawiatury; literówka → retry; 3× fail → komunikat resume; re-run wskakuje w brakujący login — wymaga operatora (checklist)
- [x] Weryfikacja: `bash scripts/install-vps.test.sh` — asercje sekwencji/guardów/retry PASS (46/46 PASS, review fazy 4)
- [x] Weryfikacja: `grep -n 'su - .*-c' scripts/install-vps.sh` — każda linia z interaktywnym CLI zawiera `/dev/tty` (PASS z adnotacją: handoff tty scentralizowany w `run_login` L377–378, wszystkie pauzy przez `login_cmd_as_claude`; pozostałe trafienia grepa to ścieżki nieinteraktywne — review fazy 4)

## Do poprawy po review fazy 4

- [x] 🟠 [P2] **scripts/install-vps.test.sh:994** (kod: `scripts/install-vps.sh:403–405`) — dwuwarstwowe escapowanie `%q` (wewnętrzny `printf %q` dla OB_EMAIL/VAULT_NAME/DEVICE_NAME/repo + zewnętrzny `%q` w `login_cmd_as_claude`; dwa poziomy parsowania `bash -c` → `su -c`) — jedyna injection-krytyczna konstrukcja fazy — nie ma ŻADNEGO testu jednostkowego: testy 37–41 stubują `run_login`/`run_as_claude`/`login_cmd_as_claude` i asertują tylko fakt wywołań. Regresja typu usunięcie jednego `%q` przechodzi 46/46 PASS, a `VAULT_NAME='Moj Vault; rm -rf ~'` albo email z `$(...)` wykona się w shellu usera claude. Fix: test jednostkowy `login_cmd_as_claude` — wartości ze spacją, apostrofem (np. `O'Brien Vault`), średnikiem i `$()` po dwukrotnym sparsowaniu shellem oddają oryginał; analogicznie asercja treści komend budowanych przez `login_ob`/`login_ob_sync`/`validate_repo_access` (inner `%q`)
- [ ] 🟡 [P3] 18 pozycji P3 (KOD 14 / TEST 4, po scaleniu duplikatów) — pełna lista z fixami w `docs/active/instalator-vps-obsidian-puls/review-faza-4.md` (m.in.: fallback `run_login` bez tty dziedziczy stdin-pipe; `validate_repo_access` vs host spoza GitHuba → mylący komunikat; false-positive `has_claude_auth` niekomunikowany kursantowi; kontrakt dispatchu `run_verify` + rc 127 nieodróżnialny od negatywnej weryfikacji; magic string `userdel -r` w dwóch miejscach; CQS `validate_repo_access` mutuje VAULT_GIT_REPO; połknięty stderr `gh auth setup-git`; `RESUME_ONE_LINER` bez flag; numeracja KROK n/5 vs `--only-puls`; nazwa `setup_tailscale` po redukcji; braki testów: wyczerpanie 3 prób `validate_repo_access`, fail setup-git → halt, gałąź rezygnacji `n` w `run_login`, bezpośrednie testy `run_verify`)

## Operator checklist faza 4

- [ ] Operator: spike-GATE su+/dev/tty (mechanizm krytyczny fazy 4, decyzja 17; zamyka też GATE z nagłówka fazy) — czy `bash -c "su - claude -c <cli>" < /dev/tty` przekazuje klawiaturę interaktywnemu CLI pod prawdziwym pipe — Operator action: w Docker/multipass Ubuntu uruchom skrypt przez prawdziwy `curl … | sudo bash` (env-override `CLAUDE_CRON_REPO`/`CLAUDE_CRON_REF` z feature-brancha) i potwierdź, że CLI za `su` czyta z klawiatury; jeśli su/PAM nie przekazuje tty → zmiana jednopunktowa na `runuser`/`sudo -u` w `login_cmd_as_claude` (L403–405) i/lub redirect w `run_login` (L377–378); wynik MUSI zapaść przed uznaniem R2/R6 za zweryfikowane (przed merge)
- [ ] Operator: [Manual] pełny blok 5 loginów na czystym VPS (domyka otwarty checkbox [Manual] fazy 4) — Operator action: czysty Ubuntu VPS, prawdziwy `curl … | sudo bash` z env-override brancha; przejdź 5 pauz z przeglądarką (OAuth Claude, gh device flow, `ob login` z 2FA i hasłem E2E, `ob sync-setup`, `tailscale up`); potwierdź: literówka hasła ob → retry-in-place, 3× fail → komunikat resume (leave-partial, rollback-stos nietknięty), re-run wskakuje w brakujący login (guardy pomijają zrobione); przy okazji oceń realną latencję probe'ów sieciowych guardów (`ob login </dev/null`, `gh auth status`, `gh repo view`)

## Faza 5: Obsidian + Puls (IU5)

- [x] `ob sync-config --path ~/vault --file-types image,audio,video,pdf,unsupported` → weryfikacja `sync-status` zawiera `unsupported` (fail → `fail`, pod trapem)
- [x] Sparse checkout `.claude` z `<REPO>` → `~/vault-git` (gh credential helper, czysty URL); guard: istniejący `.git` → `git pull` (rozstrzygnięcie: `git clone --filter=blob:none --sparse` + `git sparse-checkout set .claude` — checkout na domyślnym branchu repo usera; wymaga git >= 2.25)
- [x] Symlink `ln -sfn ~/vault-git/.claude ~/vault/.claude` (idempotentny)
- [x] Systemd `obsidian-sync`: `ob sync --continuous`, `Restart=always`, `User=claude`, `ExecStartPre` lock cleanup
- [x] Puls: sekcje clone/pull + `npm install --production` + `mkdir data/` + systemd `claude-cron` przeniesione do funkcji; `WORKSPACE=~/vault` na sztywno (pytanie tylko w `--only-puls`); TZ z autodetekcji; bez `WEBHOOK_BASE_URL` (Funnel w Fazie 6) — zrealizowane w fazach 1–2; w IU5 dołożono `build_puls_env_lines` (czysta funkcja) + asercję braku `WEBHOOK_BASE_URL` w treści unitu
- [x] Kolejność twarda w `main()`: sync-config → weryfikacja → `enable --now obsidian-sync`
- [x] Rollback automatów: `systemctl disable --now` + usunięcie unit-plików utworzonych w tym runie
- [x] Test: budowa ENV_LINES (czysta funkcja) — pełny tryb → WORKSPACE/PORT/PATH; z Discordem → linia DISCORD; bez → brak (test 50)
- [x] Test: generacja unitu obsidian-sync (czysta funkcja) — zawiera `Restart=always`, `User=claude`, ścieżkę vault (test 51)
- [x] Test: weryfikacja file-types — wyjście bez `unsupported` → fail; z → pass (atrapy) (testy 52–54)
- [x] Test: symlink idempotentny — drugi run nie failuje, cel bez zmian (test 55)
- [ ] Test: [Manual] na VPS: `~/vault/.claude/skills` widoczne przez symlink; oba unity `active` — wymaga operatora (checklist)
- [x] Weryfikacja: `bash scripts/install-vps.test.sh` — asercje ENV_LINES/unitów/file-types PASS (61/61 PASS, review fazy 5)
- [x] Weryfikacja: test kolejności w harnessie — `sync-config` w `main()` PRZED `enable --now obsidian-sync` (Test 50 harnessu L1324, PASS — review fazy 5)

## Do poprawy po review fazy 5

- [x] 🟠 [P2] **scripts/install-vps.sh:922** — brak post-condition po `setup_vault_git`: `git sparse-checkout set .claude` przechodzi nawet gdy repo NIE zawiera `.claude` (git nie waliduje ścieżki), a gałąź guardu `.git` → `git pull --ff-only` (L915) nigdy nie ponawia sparse-checkout — `ln -sfn` (L931) tworzy WISZĄCY symlink, instalator raportuje sukces, skille nigdy nie docierają do vaulta (cichy ubytek). Fix: fail-fast `[ -d "$vault_git/.claude" ] || fail …` na końcu `setup_vault_git` + test z atrapą git tworzącą/nietworzącą `.claude`
- [x] 🟠 [P2] **scripts/install-vps.sh:915** — guard re-run `setup_vault_git` (`.git` → `git pull --ff-only`) nie sprawdza, czy origin istniejącego `~/vault-git` zgadza się z aktualnym `VAULT_GIT_REPO` (collect_config pyta o repo przy każdym pełnym runie, `validate_repo_access` może je nadpisać w retry) — instalator waliduje dostęp do NOWEGO repo, po czym po cichu pulluje STARE; katalog `.claude` (skille wykonywane z `--dangerously-skip-permissions`) pochodzi z innego źródła niż operator skonfigurował, bez ostrzeżenia. Fix: w gałęzi pull porównać `git -C vault-git remote get-url origin` z `VAULT_GIT_REPO` (mismatch → warn/backup + re-clone); testowalne w harnessie (stub `run_as_claude`)
- [x] 🟠 [P2] **scripts/install-vps.sh:974** — re-run staleness serwisu obsidian-sync: `systemctl enable --now` nie restartuje już działającego serwisu — przy re-runie nowy sync-config (czytany przy starcie procesu sync) i nadpisany unit-plik (tylko `daemon-reload`) nie wchodzą w życie do ręcznego restartu, mimo że instalator raportuje OK; unit Pulsa robi `systemctl restart` (L1208) — asymetria. Fix: `systemctl restart` gdy serwis już działa (lub zawsze po zapisie unitu) + test re-run z rejestratorem `systemctl`
- [x] 🟠 [P2] **scripts/install-vps.sh:931** — `link_vault_claude` bez guardu „cudzego stanu": gdy `~/vault/.claude` istnieje jako REALNY katalog (pozostałość po starym instalatorze / ręcznej instalacji wg MIGRACJA-PULS SEKCJA 10), `ln -sfn` failuje („cannot overwrite directory") → trap ERR → rollback całego runu; sąsiednia `setup_vault_git` obsługuje ten przypadek wzorcem backup-mv — niespójność w obrębie fazy. Fix: przed `ln` guard `[ -d … ] && [ ! -L … ]` → backup mv (jak vault-git), z testem
- [ ] 🟡 [P3] 16 pozycji P3 (KOD 11 / TEST 5, po scaleniu duplikatów) — pełna lista z fixami w `docs/active/instalator-vps-obsidian-puls/review-faza-5.md` (m.in.: gałąź pull bez ponowienia `sparse-checkout set`; połknięty stderr/rc `ob sync-status`; substring-match `File types:.*unsupported` → fałszywy PASS; `Restart=always` bez StartLimit = wieczna pętla restartów; niecytowane `$ob_path`/`$vault_path` w Exec*; `push_rollback` po zapisie unitu (ENOSPC); nadpisanie cudzego unitu bez backupu; duplikacja wzorca install-unit ×2; magic literal `~/vault` ×3; DISCORD_WEBHOOK_URL w unicie 644 + brak escapowania `%`/`"` dla Environment=; testy: brak post-condition w test_setup_vault_git_guard, brak asercji `--file-types …unsupported`, brak testu re-run restart serwisu, brak error-case bez `ob` w PATH, rozjazd numeracji testów doc↔harness)

## Operator checklist faza 5

- [ ] Operator: pełna weryfikacja fazy Obsidian+Puls na realnym VPS (domyka otwarty checkbox [Manual] Unit 5, plan L314) — Operator action: na VPS z systemd i zalogowanym kontem Obsidian Sync (po bloku loginów) potwierdź: `systemctl is-active obsidian-sync claude-cron` → oba `active`, `ls -la ~claude/vault/.claude` → symlink na `~claude/vault-git/.claude` i widoczne `skills/`, sparse checkout prywatnego repo działa przez credential helper gh (`git -C ~claude/vault-git pull`), a pliki typu `unsupported` (HTML/JSON/CSV) docierają przez Obsidian Sync na komputer/telefon
- [ ] Operator: kontrakt realnego `ob sync-config --file-types` / `ob sync-status` (odroczone pytanie nr 2 planu; w testach oba końce są atrapami) — Operator action: na VPS z kontem Obsidian uruchom `su - claude -c "ob sync-status --path ~/vault"` i porównaj format linii `File types:` z założeniem `verify_ob_file_types` (substring `unsupported`); przy odchyleniu formatu obsidian-headless@0.0.12 zgłoś do poprawy parsera PRZED merge
- [ ] Operator: pozostałe założenia z przewodnika niepotwierdzone headless — Operator action: przy przebiegu z pkt 1 sprawdź, czy ścieżka locka `.obsidian/.sync.lock` w ExecStartPre odpowiada realnie tworzonemu plikowi locka `ob sync` oraz czy sparse checkout prywatnego repo przez gh credential helper nie pyta o hasło (odroczone pytanie nr 4 planu)

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
