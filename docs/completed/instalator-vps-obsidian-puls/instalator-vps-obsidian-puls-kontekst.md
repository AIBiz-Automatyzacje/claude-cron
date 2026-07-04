# Kontekst: Połączony instalator VPS (Obsidian + Puls)

Branch: `feature/instalator-vps-obsidian-puls`
Ostatnia aktualizacja: 2026-07-02 (Faza 7 ukończona — implementacja wszystkich IU zakończona; do domknięcia: review fazy 7 + Operator gate)

## Stan implementacji

- **Faza 1 (IU1) — DONE**: `scripts/install-vps.sh` przebudowany na strukturę stałe → helpery → funkcje-komponenty → `main "$@"` za guardem `CLAUDE_CRON_LIB_ONLY`. Powstał harness `scripts/install-vps.test.sh` (14 asercji PASS). `bash -n` czysty, jedyny `read -r` w `ask_tty` (grep-strażnik zielony). Pełny suite projektu 163/163 PASS.
- **Faza 2 (IU2) — DONE**: preflight (`run_preflight`: EUID=0, `is_supported_os` po `/etc/os-release`, `check_internet` na api.github.com), checklist 6 prerequisites z `ask_tty` „[Enter]", komplet guardów `has_*` (w tym rozdzielone `has_ob_auth`/`has_ob_sync`), blok 4 pytań (email/vault/repo/Discord) z walidacją + podsumowanie „Kontynuujemy? [T/n]", auto-wartości (`DEVICE_NAME=vps-$(hostname)`, PORT=7777/`--port`, `detect_timezone` z fallbackiem Europe/Warsaw), tryb `--only-puls` z pytaniem o workspace (`normalize_path`). Harness 25/25 PASS, `read -r` nadal tylko w `ask_tty`, `ask_tty` użyte 17×.
- **Faza 3 (IU3) — DONE**: sekcja narzędzi jako funkcje `install_*` w `main()` PRZED `login_block` (`install_base_packages` z guard-first per binarka + fail-fast weryfikacja, `install_node` z nodesource bez zmian progów, `install_claude_cli` natywnie przez claude.ai/install.sh zamiast npm, `install_ob` pomijane przy `--only-puls` w `main()`, `install_tailscale` przeniesiony z końca skryptu — samo `tailscale up` zostaje do IU4). `push_rollback "userdel -r claude"` i `npm rm -g obsidian-headless` tylko dla stanu utworzonego w tym runie. Cienki `login_block()` (wrapper na `login_claude_cli`) wyznacza granicę FAZY 2/3 dla testu sekwencji. Harness 31/31 PASS (rejestrator wywołań `main()`), grep `@anthropic-ai/claude-code` → 0 linii, suite projektu 163/163 PASS.
- **Faza 4 (IU4) — DONE**: `login_block()` rozpięty na 5 pauz (`login_claude_cli` → `login_gh` → `login_ob` → `login_ob_sync` → `login_tailscale`), każda za swoim guardem `has_*` (resume wskakuje w brakujący login), pauzy 3–4 pomijane przy `--only-puls`. Na wejściu bloku `drop_rollback "userdel -r claude"` (fix P2-1 z review fazy 3) + `disable_rollback`, na wyjściu `enable_rollback`. PAUZA 2 po loginie robi `gh auth setup-git` + `validate_repo_access` (`gh repo view`, retry-in-place z ponownym pytaniem o repo, 3 próby) — także przy resume z guardem gh=zrobione. Wartości usera w komendach `su -c` przez `printf %q`. `setup_tailscale` zredukowany do odczytu TS_IP (interaktywne `tailscale up` = PAUZA 5). Dodane testy 32–46 (w tym testy jednostkowe `install_*` — fix P2-2). Harness 46/46 PASS, suite projektu 163/163 PASS.
- **Faza 5 (IU5) — DONE**: cała bezobsługowa część Obsidian+Puls jako funkcje pod trapem ERR: `configure_obsidian_file_types` (sync-config → weryfikacja `verify_ob_file_types` na `unsupported` w `sync-status`), `setup_vault_git` (sparse checkout `.claude` → `~/vault-git`: `git clone --filter=blob:none --sparse` + `git sparse-checkout set .claude`, guard `.git` → `git pull`, katalog bez `.git` → backup), `link_vault_claude` (`ln -sfn`, idempotentny), `create_obsidian_sync_service` (unit z `Restart=always`, `User=claude`, `ExecStartPre` lock cleanup). Puls: `build_puls_env_lines` wydzielone jako czysta funkcja (WORKSPACE/PORT/PATH, DISCORD warunkowo, bez `WEBHOOK_BASE_URL`). Kolejność twarda w `main()` (sync-config PRZED `enable --now obsidian-sync`, test sekwencji), rollback unit-plików tylko gdy utworzone w tym runie (`SYSTEMD_DIR` jako DI). Harness 61/61 PASS, suite projektu 163/163 PASS.
- **Faza 6 (IU6) — DONE**: sieć + finał przebiegu. UFW jako `configure_firewall` (bez zmian merytorycznych), auto-update ZAWSZE z jedynym opt-outem `--no-auto-update` (`setup_auto_update`: sudoers NOPASSWD + node-guard heredoc + cron **02:00** bez zmiany godziny; `build_cron_cmd` jako czysta funkcja z `printf %q` — fix P3 cytowania `"$VAULT_GIT"`; `--only-puls` → bez segmentu vault-git; cały łańcuch crona logowany do `claude-cron-update.log`), weryfikacja serwisów `systemctl is-active` ×2 + `wait_for_first_sync` (pętla do 90 s, timeout = warn z instrukcją, nie fail), plik-dowód `~/vault/Witaj-z-VPS.md` (PL, pomijany przy `--only-puls`), Funnel jako opcjonalne pytanie `[t/N]` NA KOŃCU (T → `tailscale funnel --bg` → URL z fallbackiem-pytaniem → `add_webhook_env_line` przepisuje unit + daemon-reload + restart; N → nic), podsumowanie PL (`print_summary`: dashboard z adnotacją o lekcji, sekcja webhooków tylko z Funnelem). Rollbacki per-run dla sudoers i wpisu crona (konwencja z review fazy 5), `SUDOERS_DIR` jako DI. Harness 78/78 PASS, suite projektu 163/163 PASS.
- **Faza 7 (IU7) — DONE**: tryb `--reset` + README. Reset: `print_reset_plan` (DOKŁADNA lista usuwanego + jawna lista świadomych NIE-usunięć: Tailscale z instrukcją `tailscale logout`/admin console, UFW z `ufw delete deny <PORT>`, Node/gh/apt) → `confirm_reset` (dosłowne `TAK` przez `ask_tty`, Enter/brak tty = anuluj, exit 0 bez usunięć) → `run_reset` w kolejności: stop/disable serwisów → pliki z `build_reset_paths` (unit-pliki ×2 + sudoers; tablica `RESET_PATHS` zamiast stdout — grep-strażnik zakazuje `read` poza `ask_tty`) → `remove_update_cron` (odwrócony dedup-filter, cudze wpisy roota zostają) → `userdel -r claude` (pad = warn z instrukcją, nie ERR). KAŻDY `rm -rf` scentralizowany w `remove_reset_path` (`${1:?}` fail-fast na pustej ścieżce + guard `[ -e ]`/`[ -L ]` → idempotentny na czystym systemie). Odchylenie od planu: sudoers usuwany razem z unit-plikami (przed cronem) — wspólna lista eliminuje rozjazd wypisane-vs-usunięte. README: nowa sekcja „Krok 1 — Instalacja na VPS" (1.1 prerequisites → 1.7 Tailscale IP: one-liner curl, wariant `wget -qO-`, flagi przez `bash -s --`, `--reset`, env-override do testów z brancha); usunięta nieaktualna tabela pytań starego instalatora, odwołania w sekcjach Mac/Windows przenumerowane na 1.7. Harness 89/89 PASS, suite projektu 163/163 PASS, `bash -n` czysty, `read -r` nadal tylko w `ask_tty`.

## Powiązane pliki

**Do modyfikacji:**
- `scripts/install-vps.sh` — baza przebudowy (578 linii, liniowy). Przetrwają: `is_node_supported()` (L57–74), UFW (L322–349), systemd template Pulsa + ENV_LINES (L275–308), node-guard heredoc (L474–513), sudoers + cron dedup (L453, L521–529), normalizacja ścieżek (L219–224). Do przebudowy: npm→natywny Claude (L137), gołe `read`/`su -c` → `/dev/tty`, struktura → funkcje, brak flag/trap/guardów/obsidian/gh.
- `README.md` — sekcja instalacji VPS (Faza 7).

**Do stworzenia:**
- `scripts/install-vps.test.sh` — harness wg wzorca `install.test.sh` (lib-only + sandbox + pass/problem).

**Wzorce (nie modyfikować):**
- `install.sh` — handoff `/dev/tty` + fallback (L236–244), env-override źródła (L26–30), allowlista (L32–35), guard lib-only (L272).
- `install.test.sh` — wzorzec harnessu bash.
- `scripts/uninstall-macos.sh` — wzorzec uninstalla (flagi, confirm-before-delete, guardy).
- `lib/config.js` — env serwera: `CLAUDE_CRON_PORT`, `CLAUDE_CRON_WORKSPACE`, `DISCORD_WEBHOOK_URL`, `WEBHOOK_BASE_URL`; progi Node `22.13`/`25`. `CLAUDE_CRON_VPS_URL` — NIE ustawiać na VPS.
- `setup.test.mjs` — wzorzec DI-probe dla funkcji detekcyjnych.

## Decyzje techniczne

1. **Jeden samowystarczalny plik** (curl|bash wymaga self-contained); funkcje per komponent + `main()` + guard `CLAUDE_CRON_LIB_ONLY`. Świadomy wyjątek od reguły 300 linii.
2. **`ask_tty()` i `run_login()` jako jedyne źródła interakcji** — zakaz gołego `read -r`; egzekwowane grep-strażnikiem w harnessie.
3. **Rollback jako stos** (`push_rollback` + `trap on_err ERR`), odwijany w odwrotnej kolejności; blok loginów z trapem zdjętym (`disable_rollback`). Loginy: 3× retry-in-place → `halt_leave_partial` (NIGDY rollback). Rollback nie dotyka `data/` ani `/home/claude` sprzed runa.
4. **Guardy `has_*` jako czyste-testowalne funkcje** (DI, exit code przed parsowaniem tekstu). Guard Obsidiana rozbity na DWA: `has_ob_auth` / `has_ob_sync`.
5. **gh device flow zamiast PAT**: `gh auth login` → `gh auth setup-git` (credential helper dla checkoutu i nocnego crona, czysty URL remote) → walidacja `gh repo view` z retry-in-place.
6. **Claude Code natywnie** (`curl claude.ai/install.sh | bash` → `~/.local/bin/claude`) — spójne z PATH w systemd.
7. **Env-override do testów z brancha**: `CLAUDE_CRON_REPO` + `CLAUDE_CRON_REF` (fallback main). Test WYŁĄCZNIE przez prawdziwy pipe.
8. **`--file-types image,audio,video,pdf,unsupported`** — stała (bez pytania); weryfikacja `sync-status`; sync-config PRZED startem serwisu (twarda kolejność).
9. **Funnel = opcjonalne pytanie NA KOŃCU** (Faza 6 spec-u); token webhooka `randomUUID()` = 122 bity, rate-limit w backlogu.
10. **Cron auto-update o 02:00 — NIE zmieniać** (spójność z `MAINTENANCE_WINDOW` 02:00–02:15 i missed-job detection).
11. **Komunikaty user-facing PO POLSKU** (kursant nietechniczny); fix P3 przy okazji: cytowanie `"$VAULT_GIT"` w CRON_CMD.
12. **Flagi przez `bash -s --`** w one-linerze; `--reset` z potwierdzeniem `TAK` + guardy `${var:?}`.

### Decyzje z Fazy 1 (implementacja IU1)

13. **`--only-puls` i `--no-obsidian` → jedna zmienna `FLAG_ONLY_PULS`** — spec produktowy traktuje je jako równoważne (bez flagi = wszystko).
14. **Minimalne podpięcie flag już w IU1**: `--port`/`--tz` zmieniają default pytania interaktywnego (pełne auto-wartości → Faza 2); `--no-auto-update` pomija sekcję crona. `FLAG_DEVICE`/`FLAG_ONLY_PULS`/`FLAG_RESET` tylko parsowane+walidowane — konsumpcja w Fazach 2/5/7.
15. **`git clone --branch "$REF"`** jako nośnik env-override `CLAUDE_CRON_REF` (default `main` = zachowanie jak dziś).
16. **Prompty `[Y/n]` → `[T/n]`** przy PL-unifikacji; logika akceptuje T/t/Y/y (negacja tylko `^[Nn]$`).
17. **Handoff `su - claude -c claude` dostał `< $TTY_DEVICE`** gdy tty czytelne (mechanizm R7; pełny `run_login` dla bloku loginów → Faza 4, po spike-gate).
18. **`set -e` → `set -Eeuo pipefail`** — `errtrace` (`-E`) wymagany, żeby `trap ERR` działał wewnątrz funkcji.

### Decyzje z Fazy 2 (implementacja IU2)

19. **Usunięte interaktywne pytania o port/TZ/workspace w pełnym trybie** (razem z `ask_port` i jego testem — usunięcie testu razem z usuwaną funkcjonalnością): spec R4/FAZA 1 robi z nich auto-wartości (`PORT=7777`/`--port`, TZ autodetekcja `timedatectl` → `Europe/Warsaw`, `WORKSPACE=$CLAUDE_HOME/vault`). `WORKSPACE` w pełnym trybie ustawiany już teraz (formalnie IU5) — po usunięciu pytania `create_systemd_service` nie miałby wartości.
20. **`ask_workspace` (`--only-puls`) nie pyta o utworzenie folderu** — tworzenie przeniesione do automatu `ensure_workspace` PO `useradd` (w momencie pytań FAZY 1 `/home/claude` może nie istnieć); zgodę usera pokrywa podsumowanie + „Kontynuujemy? [T/n]".
21. **`resolve_install_paths` przez `getent passwd` z fallbackiem `/home/claude`** zamiast `eval echo ~user` — konieczność strukturalna (pytania lecą przed `useradd`); efekt uboczny: znika anty-wzorzec `eval` (P3-16 z review), choć sekcja „Do poprawy po review" celowo nie była częścią tej fazy.

### Decyzje z Fazy 3 (implementacja IU3)

22. **`install_base_packages` zamiast jednego bezwarunkowego apt** — instaluje tylko BRAKUJĄCE pakiety (guard-first per binarka, konwencja idempotencji repo); ca-certificates dokładane przy każdym przebiegu apt (brak własnej binarki do guardu), fail-fast weryfikacja git/curl/crontab/gh po instalacji (gh = twardy prerequisit device flow).
23. **Prefix `install_*` zarezerwowany dla narzędzi FAZY 2** — rename `install_dependencies` → `setup_puls_dependencies` (npm deps aplikacji po clone), żeby test sekwencji „wszystkie `install_*` przed `login_block`" był generyczny po nazwach i chronił fazy 4–7 przed regresją.
24. **`login_block()` jako cienki wrapper już w IU3** — granica FAZY 2/3 musi istnieć dla testu sekwencji; pełne 5 pauz przez `run_login` wchodzi w IU4.
25. **Rollback celowo BEZ apt/Claude-native/Tailscale** — odinstalowanie pakietów systemowych na rollbacku groźniejsze niż pozostawienie (re-run idempotentny); na stosie tylko `userdel -r claude` i `npm rm -g obsidian-headless`, oba wyłącznie gdy stan powstał w tym runie.

### Decyzje z Fazy 4 (implementacja IU4)

26. **Handoff `su` + `/dev/tty` jednopunktowy mimo otwartego spike-GATE**: forma `su - … -c` wyłącznie w helperze `login_cmd_as_claude`, redirect `< $TTY_DEVICE` wyłącznie w `run_login` — ewentualna zmiana na `runuser`/`sudo -u` po spike'u operatora jest zmianą w jednym miejscu (decyzja 17 zrealizowana).
27. **Dispatcher `run_verify` zamiast `bash -c` dla wszystkich weryfikacji**: nazwa funkcji instalatora (guardy `has_*`) → wywołanie wprost (funkcje niewidoczne w child bashu), string → `bash -c`. `eval` odrzucony — bash 3.2 (macOS, harness) odpala trap ERR dla `eval` nawet w kontekście warunku `if`, co odwijałoby rollback-stos.
28. **Weryfikacja PAUZY 1 = `has_claude_auth`** (niepusty `~/.claude/.credentials.json`), nie probe `claude -p` — probe kosztuje tokeny usera; rozstrzyga formę odroczoną w planie.
29. **`gh auth setup-git` + `validate_repo_access` wykonywane także przy resume** (guard gh=zrobione) — poprzedni run mógł paść między loginem a tymi krokami; oba nieinteraktywne i idempotentne.
30. **`drop_rollback "userdel -r claude"` na wejściu `login_block`** — po pierwszym loginie OAuth rollback nie ma prawa skasować `~/.claude/.credentials.json` (fix P2-1 review fazy 3, zgodnie z R6 leave-partial).

### Decyzje z Fazy 5 (implementacja IU5)

31. **Sparse checkout rozstrzygnięty: `git clone --filter=blob:none --sparse` + `git sparse-checkout set .claude`** (zamiast `--no-checkout` + jawnego `git checkout <branch>`) — checkout dzieje się sam na DOMYŚLNYM branchu repo usera (main/master, nie zgadujemy nazwy); wymaga git >= 2.25 (Ubuntu 20.04+ OK, do potwierdzenia w przebiegu operatora).
32. **`SYSTEMD_DIR` jako zmienna (DI dla testów)** — testy rollbacku unit-plików bez pisania po `/etc` (wzorzec `TTY_DEVICE`); dodane stałe `OB_SYNC_SERVICE`, `OB_FILE_TYPES`, literal `obsidian-sync` w `print_detected_state` podmieniony na stałą.
33. **Rollback unitów warunkowy per run**: `systemctl disable --now` + `rm` unit-pliku rejestrowane na stosie TYLKO gdy plik powstał w tym runie (guard `[ -f ]` przed zapisem); pady automatów (`ob sync-config`, `git clone`, `systemctl`) idą przez trap ERR i odwijają stos. Weryfikacja file-types failuje przez `fail` (exit 1 bez odwijania stosu) — znane P3-1 z review fazy 1, poza scope IU5.
34. **`MAIN_COMPONENT_FNS` w harnessie rozszerzone o 4 nowe funkcje-komponenty** — rejestrator sekwencji `main()` stubuje komponenty (inaczej testy odpaliłyby realne `su`/`systemctl`); żaden istniejący test niezmodyfikowany.

### Decyzje z Fazy 6 (implementacja IU6)

35. **`add_webhook_env_line` (czysta funkcja przepisująca treść unitu) zamiast `sed -i "/SyslogIdentifier/i …"`** — składnia insert to GNU sed, a harness biega na macOS (BSD sed); bonus: stara linia `WEBHOOK_BASE_URL` usuwana przed wstawieniem = idempotentny re-run z Funnelem bez duplikatów.
36. **`setup_auto_update` bez pytań interaktywnych** — spec FAZA 6 wymaga auto-update ZAWSZE z jedynym opt-outem `--no-auto-update`; ścieżka vault-git na sztywno `$CLAUDE_HOME/vault-git` (ustalona w IU5), przy `--only-puls` segment pomijany.
37. **Cały łańcuch CRON_CMD z redirectem `{ …; } >> claude-cron-update.log 2>&1`** — dotychczasowy kod logował tam wyłącznie node-guard, nie pady pulla; redirect domyka literalny wymóg spec-u („pad pulla logowany").
38. **Rollbacki per-run dla sudoers i wpisu crona** (`push_rollback` PRZED zapisem, tylko gdy stan powstał w tym runie) — plan mówił „jak dziś" (bez rollbacku), ale konwencja z review fazy 5 obowiązuje Unit 6+; `SUDOERS_DIR=/etc/sudoers.d` jako DI dla testów (wzorzec `SYSTEMD_DIR`).
39. **`is_sync_complete` (pętla 90 s) i `parse_funnel_url` to świadome heurystyki** — dokładne stringi wyjść `ob sync-status` i `tailscale funnel status` odroczone w planie; fallbacki: timeout = warn z instrukcją, brak URL = pytanie do usera.

## Odroczone do implementacji

- Spike operatora `su - claude -c "cmd" < /dev/tty` pod prawdziwym pipe (GATE fazy 4 pozostaje otwarty; implementacja jednopunktowa — patrz decyzja 26).
- Dokładne stringi wyjść `ob sync-status`/`gh auth status` (guardy odpornie: exit code first).
- Parsowanie URL z `tailscale funnel status` (fallback: zapytaj usera — zostaje).
- ~~Dokładne komendy sparse checkout~~ — rozstrzygnięte w Fazie 5 (decyzja 31: `clone --filter=blob:none --sparse` + `sparse-checkout set .claude`).

## Zależności

- Pakiety: `obsidian-headless@0.0.12` (npm, bin `ob` — młody, UNLICENSED; guardy na exit code), `gh` (apt Ubuntu; fallback oficjalne repo), nodesource setup_22.x, tailscale.com/install.sh, claude.ai/install.sh.
- Progi Node `>=22.13 <25` w 4 kopiach: install-vps.sh, cron-node-guard heredoc, `package.json` engines, `lib/config.js` — muszą zostać zsynchronizowane.
- Prerequisites kursanta (checklist w preflight): VPS Ubuntu + root, konto Obsidian + vault + remote + hasło e2e, prywatne repo `.claude`, konto GitHub, konto Tailscale.

## Wiedza instytucjonalna (przeczytaj przed pracą)

- `docs/solutions/deployment-issues/2026-06-30-curl-bash-instalator-interaktywny-tty.md` — stdin=pipe pod curl|bash, `/dev/tty` z fallbackiem, `${var:?}`, test przez prawdziwy pipe, lib-only.
- `docs/solutions/deployment-issues/2026-07-01-instalator-cross-platform-irm-iex-encoding-env-symlink.md` — env-override źródła do testu z brancha przed merge.
- `docs/solutions/runtime-errors/2026-06-29-migracja-better-sqlite3-na-node-sqlite.md` — okno Node, porównania na intach, pętla padów przy rozjeździe progów.
- `docs/completed/ulatwienie-instalacji/ulatwienie-instalacji-podsumowanie.md` — cron-guard jako osobny skrypt; znane P3 (cytowanie, duplikacja logiki wersji).
- `docs/completed/instalacja-jedna-komenda/instalacja-jedna-komenda-podsumowanie.md` — kontrakt danych re-run; granica testowalności (loginy = Operator).
- Przewodnik zewnętrzny: `…workspace/Zasoby/Archiwum/Tech/obsidian-headless-vps-guide.md` (sekcje 2b, 3, 4).

## Źródła

- Requirements doc: brak (zastępuje go spec przebiegu po sesji roast)
- Plan techniczny: `docs/plans/2026-07-02-001-feat-instalator-vps-obsidian-puls-plan.md`
- Spec przebiegu (źródło produktowe): `docs/plans/2026-07-01-001-feat-polaczony-instalator-vps-flow.md`
- Kontekst kursu: `docs/plans/archive/MIGRACJA-PULS.md` SEKCJA 10

## Review fazy 1 (2026-07-02)

Raport: `docs/active/instalator-vps-obsidian-puls/review-faza-1.md`. Gate: ⚠️ ZASTRZEŻENIA — 0 × P1, 4 × P2, 19 × P3, 3 × OPERATOR. Wszystkie 3 checkboxy `Weryfikacja:` fazy 1 przeszły automatycznie (bash -n, harness 14/14, grep `read -r` tylko w `ask_tty`).

Kluczowe wnioski:
- **`ask_tty` fallback ma dziurę semantyczną**: `[ -r /dev/tty ]` przechodzi bez kontrolującego terminala (ssh bez `-t`), a `read` pada z ENXIO połkniętym przez `|| __answer=""` — kontrakt „brak defaultu = twardy fail" wymaga probe otwarcia, a testy muszą odwzorowywać semantykę `/dev/tty`, nie nieistniejący plik.
- **Walidacja inputu musi być symetryczna flaga↔prompt**: walidację `--port` dodano w `parse_flags`, ale prompt w `configure_settings` ją omija — przy IU2 walidować WSZYSTKIE pola z `ask_tty` (email/repo/discord/port), nie tylko flagi.
- **Deklaracja planu „egzekwowane testem grep" musi mieć test w harnessie** — ręczne odhaczenie nie chroni faz 2–7 przed regresją gołego `read`.
- **Komunikat resume musi działać w trybie R2** (`curl|bash` — brak lokalnego pliku): instruować ponowne wklejenie one-linera, nie `bash install-vps.sh`.
- Konwencja na kolejne IU: wartości z inputu w komendach cron/rollback/`su -c` zawsze przez `printf %q` lub walidację białych znaków.

## Review fazy 3 (2026-07-02)

Raport: `docs/active/instalator-vps-obsidian-puls/review-faza-3.md`. Gate: ⚠️ ZASTRZEŻENIA — 0 × P1, 2 × P2, 17 × P3, 1 × OPERATOR (scalony z 4 zgłoszeń). Oba automatyzowalne checkboxy `Weryfikacja:` fazy 3 przeszły (harness 31/31 PASS, grep `@anthropic-ai/claude-code` → 0 linii); checkbox [Manual] Unit 3 przeniesiony do „Operator checklist faza 3".

Kluczowe wnioski:
- **Rollback-stos musi być świadomy granicy loginów**: `userdel -r` na stosie po udanym loginie OAuth Claude niszczy `~/.claude/.credentials.json` przy ERR w późniejszych automatach — wpisy rollbacku kasujące dane interaktywne trzeba neutralizować po wejściu w `login_block` (P2-1).
- **Funkcje instalacyjne stubowane w testach sekwencji ≠ przetestowane**: guard-skip / fail-fast / warunkowy rollback `install_ob` wymagają testów jednostkowych z DI, wzorzec już jest w harnessie (P2-2).
- Weryfikuj binarkę tą samą ścieżką co konsument (`run_as_claude`, nie PATH roota) i rejestruj rollback zaraz po akcji mutującej, przed weryfikacją.
- Plan R7 („rollback dla apt") wymaga doprecyzowania zgodnie z decyzją 25, zanim IU5/IU6 zinterpretują go literalnie.

## Review fazy 4 (2026-07-02)

Raport: `docs/active/instalator-vps-obsidian-puls/review-faza-4.md`. Gate: ⚠️ ZASTRZEŻENIA — 0 × P1, 1 × P2, 18 × P3, 1 × OPERATOR (P1, scalony z 6 zgłoszeń). Oba automatyzowalne checkboxy `Weryfikacja:` fazy 4 przeszły (harness 46/46 PASS; grep `su - .*-c` — handoff tty scentralizowany w `run_login`, pozostałe trafienia nieinteraktywne); checkbox [Manual] blok 5 loginów przeniesiony do „Operator checklist faza 4".

Kluczowe wnioski:
- **Granica user-input→shell wymaga testu treści komendy, nie faktu wywołania**: dwuwarstwowe `%q` (`login_cmd_as_claude` + inner `%q` w `login_ob`/`login_ob_sync`/`validate_repo_access`) jest w całości stubowane — regresja usunięcia jednego `%q` przechodzi 46/46, a wartość ze średnikiem/`$()` wykonuje się w shellu usera claude (P2-1; ta sama klasa co P2-2 z f3).
- **OP-1 [P1 OPERATOR] blokuje merge, nie kontynuację faz**: spike su+/dev/tty pod prawdziwym pipe + manualny przebieg 5 pauz na czystym VPS — jedyne otwarte weryfikacje R2/R6; architektura przygotowana jednopunktowo (redirect w `run_login`, forma su w `login_cmd_as_claude`), z zastrzeżeniem gołych `su` poza loginami (clone/npm/cron).
- `run_verify` — dopisać kontrakt dispatchu (goła nazwa funkcji BEZ argumentów vs string BEZ funkcji instalatora) zanim Unit 5/6 wpadną w pułapkę; rc 127 w gałęzi `bash -c` traktować jako błąd instalatora, nie fail weryfikacji.
- Konwencja na Unit 5+: magic stringi rollbacku (`userdel -r`) do wspólnego helpera; kroki automatyczne poza pauzą na poziom `login_block`/`main`, nie wewnątrz funkcji `login_*`.

## Review fazy 5 (2026-07-02)

Raport: `docs/active/instalator-vps-obsidian-puls/review-faza-5.md`. Gate: ⚠️ ZASTRZEŻENIA — 0 × P1, 4 × P2, 16 × P3, 3 × OPERATOR (scalone z 7 zgłoszeń). Oba automatyzowalne checkboxy `Weryfikacja:` fazy 5 przeszły (harness 61/61 PASS; test kolejności sync-config → enable = Test 50 harnessu); checkbox [Manual] Unit 5 przeniesiony do „Operator checklist faza 5".

Kluczowe wnioski:
- **Idempotencja gałęzi re-run wymaga post-conditions, nie tylko guardów**: `.git → git pull` bez sprawdzenia originu (P2-2), bez ponowienia `sparse-checkout set` (P3) i bez fail-fast `[ -d .claude ]` (P2-1) kończy się wiszącym symlinkiem i skillami z niewłaściwego źródła przy raporcie „OK" — resume musi weryfikować STAN końcowy, nie tylko istnienie artefaktu-markera.
- **`systemctl enable --now` ≠ restart**: re-run z nowym unit-plikiem/sync-configiem zostawia działający stary proces (P2-3) — po nadpisaniu unitu zawsze `systemctl restart` (symetria z unitem Pulsa).
- **Guard „cudzego stanu" musi być spójny w obrębie fazy**: `setup_vault_git` backupuje nie-gitowy katalog, `link_vault_claude` wywala cały run w rollback na realnym `~/vault/.claude` (P2-4) — wzorzec backup-mv stosować przy każdej kolizji z istniejącym stanem.
- Konwencja na Unit 6+: nie tłumić stderr+rc zewnętrznych CLI w jednej konstrukcji (`2>/dev/null || true`); `push_rollback` PRZED akcją zapisu (wpisy idempotentne); testy z pełnym stubem `run_as_claude` = test kształtu komendy — dokładać asercje treści (`--file-types …unsupported`) i post-conditions.

## Review fazy 6 (2026-07-02)

Raport: `docs/active/instalator-vps-obsidian-puls/review-faza-6.md`. Gate: ⚠️ ZASTRZEŻENIA — 0 × P1, 3 × P2 (1 KOD + 2 TEST), 14 × P3, 3 × OPERATOR (scalone z 5 zgłoszeń). Oba automatyzowalne checkboxy `Weryfikacja:` fazy 6 przeszły (harness 78/78 PASS; grep godziny crona `0 2 * * *` → L1401); checkbox [Manual] telefon/Funnel przeniesiony do „Operator checklist faza 6".

Kluczowe wnioski:
- **Konwencja finału „warn, nie fail" musi obejmować KAŻDĄ funkcję po weryfikacji**: `set_service_webhook_env` (opcjonalny Funnel na samym końcu) robi niegardowany `systemctl restart` pod trap ERR — pad restartu odwija rollback działającej, zweryfikowanej instalacji, wbrew konwencji ustanowionej w tej samej fazie dla `verify_services`/`create_welcome_note` (P2-1).
- **Test „kształtu" wygenerowanego skryptu ≠ test zachowania**: `cron-node-guard.sh` asertowany tylko grepem treści — brzegi 22.12/22.13/25.0 wymagają URUCHOMIENIA skryptu ze stubem `node` w PATH (P2-2); analogicznie idempotencja `install_update_cron` (re-run, cudze wpisy, rollback tylko własnego stanu) bez testu (P2-3).
- **Heurystyki na odroczonych formatach wyjść (ob sync-status, tailscale funnel status) = obowiązkowy punkt Operator checklist**: substring-match `complete`/`synced` łapie też „incomplete"/„not synced" (fałszywy pozytyw bramki R11) — word boundary + testy adversarialne, a realny format potwierdza operator na żywym VPS (OP-1/OP-2/OP-3).
- Konwencja na Unit 7: dedup/rollback crontaba po unikalnym markerze linii, nie substringu `$SERVICE_NAME` (blast radius na cudze wpisy roota); walidacja user-inputu na granicy (`WEBHOOK_BASE_URL` przez wzorzec `ask_valid`).

## Review fazy 7 (2026-07-02)

Raport: `docs/active/instalator-vps-obsidian-puls/review-faza-7.md`. Gate: ⚠️ ZASTRZEŻENIA — 0 × P1, 1 × P2 (KOD), 11 × P3 (8 KOD + 3 TEST), 1 × OPERATOR (scalone z 4 zgłoszeń). Wszystkie trzy automatyzowalne checkboxy `Weryfikacja:` fazy 7 przeszły (harness 89/89 PASS w tym testy resetu 62–65; grep guardów `rm -rf` → `${…:?}` w `remove_reset_path`; grep nagłówków README). Checkbox [Manual] pełny cykl VPS przeniesiony do „Operator checklist faza 7".

Kluczowe wnioski:
- **Lista „NIE zostanie usunięte" musi obejmować KAŻDY artefakt postawiony przez instalator, nie tylko zasoby współdzielone**: reset pomija Tailscale Funnel (persystentny publiczny endpoint HTTPS na port 7777 zostaje po deinstalacji — P2-1) i globalny pakiet npm `obsidian-headless` (P3) — oba to artefakty Pulsa, żaden nie figuruje na listach print_reset_plan/print_reset_summary wymaganych przez spec R12.
- **Komunikaty ręczne z parametrami bieżącego runu ≠ parametry instalacji**: instrukcja `ufw delete deny $PORT/tcp` bierze PORT z flagi resetu (default 7777), a realny port instalacji jest w `Environment=CLAUDE_CRON_PORT` unit-pliku — czytać stan z artefaktów, nie z flag.
- **Zachowania chroniące (anulowanie resetu bez tty) wymagają dedykowanej asercji**: `confirm_reset` przez `ask_tty` z defaultem `""` poprawnie anuluje przy braku terminala, ale żaden test tego nie przybija — regresja defaultu skasowałaby `/home/claude` z pipe'a bezobsługowo.
