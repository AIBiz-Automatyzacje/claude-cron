# Kontekst: Połączony instalator VPS (Obsidian + Puls)

Branch: `feature/instalator-vps-obsidian-puls`
Ostatnia aktualizacja: 2026-07-02 (Faza 4 ukończona)

## Stan implementacji

- **Faza 1 (IU1) — DONE**: `scripts/install-vps.sh` przebudowany na strukturę stałe → helpery → funkcje-komponenty → `main "$@"` za guardem `CLAUDE_CRON_LIB_ONLY`. Powstał harness `scripts/install-vps.test.sh` (14 asercji PASS). `bash -n` czysty, jedyny `read -r` w `ask_tty` (grep-strażnik zielony). Pełny suite projektu 163/163 PASS.
- **Faza 2 (IU2) — DONE**: preflight (`run_preflight`: EUID=0, `is_supported_os` po `/etc/os-release`, `check_internet` na api.github.com), checklist 6 prerequisites z `ask_tty` „[Enter]", komplet guardów `has_*` (w tym rozdzielone `has_ob_auth`/`has_ob_sync`), blok 4 pytań (email/vault/repo/Discord) z walidacją + podsumowanie „Kontynuujemy? [T/n]", auto-wartości (`DEVICE_NAME=vps-$(hostname)`, PORT=7777/`--port`, `detect_timezone` z fallbackiem Europe/Warsaw), tryb `--only-puls` z pytaniem o workspace (`normalize_path`). Harness 25/25 PASS, `read -r` nadal tylko w `ask_tty`, `ask_tty` użyte 17×.
- **Faza 3 (IU3) — DONE**: sekcja narzędzi jako funkcje `install_*` w `main()` PRZED `login_block` (`install_base_packages` z guard-first per binarka + fail-fast weryfikacja, `install_node` z nodesource bez zmian progów, `install_claude_cli` natywnie przez claude.ai/install.sh zamiast npm, `install_ob` pomijane przy `--only-puls` w `main()`, `install_tailscale` przeniesiony z końca skryptu — samo `tailscale up` zostaje do IU4). `push_rollback "userdel -r claude"` i `npm rm -g obsidian-headless` tylko dla stanu utworzonego w tym runie. Cienki `login_block()` (wrapper na `login_claude_cli`) wyznacza granicę FAZY 2/3 dla testu sekwencji. Harness 31/31 PASS (rejestrator wywołań `main()`), grep `@anthropic-ai/claude-code` → 0 linii, suite projektu 163/163 PASS.
- **Faza 4 (IU4) — DONE**: `login_block()` rozpięty na 5 pauz (`login_claude_cli` → `login_gh` → `login_ob` → `login_ob_sync` → `login_tailscale`), każda za swoim guardem `has_*` (resume wskakuje w brakujący login), pauzy 3–4 pomijane przy `--only-puls`. Na wejściu bloku `drop_rollback "userdel -r claude"` (fix P2-1 z review fazy 3) + `disable_rollback`, na wyjściu `enable_rollback`. PAUZA 2 po loginie robi `gh auth setup-git` + `validate_repo_access` (`gh repo view`, retry-in-place z ponownym pytaniem o repo, 3 próby) — także przy resume z guardem gh=zrobione. Wartości usera w komendach `su -c` przez `printf %q`. `setup_tailscale` zredukowany do odczytu TS_IP (interaktywne `tailscale up` = PAUZA 5). Dodane testy 32–46 (w tym testy jednostkowe `install_*` — fix P2-2). Harness 46/46 PASS, suite projektu 163/163 PASS.
- Fazy 5–7: do zrobienia.

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

## Odroczone do implementacji

- Spike operatora `su - claude -c "cmd" < /dev/tty` pod prawdziwym pipe (GATE fazy 4 pozostaje otwarty; implementacja jednopunktowa — patrz decyzja 26).
- Dokładne stringi wyjść `ob sync-status`/`gh auth status` (guardy odpornie: exit code first).
- Parsowanie URL z `tailscale funnel status` (fallback: zapytaj usera — zostaje).
- Dokładne komendy sparse checkout (`--filter=blob:none --sparse` vs `--depth 1` + `sparse-checkout set`).

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
- Kontekst kursu: `docs/MIGRACJA-PULS.md` SEKCJA 10

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
