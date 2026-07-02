# Kontekst: Połączony instalator VPS (Obsidian + Puls)

Branch: `feature/instalator-vps-obsidian-puls`
Ostatnia aktualizacja: 2026-07-02 (Faza 1 ukończona)

## Stan implementacji

- **Faza 1 (IU1) — DONE**: `scripts/install-vps.sh` przebudowany na strukturę stałe → helpery → funkcje-komponenty → `main "$@"` za guardem `CLAUDE_CRON_LIB_ONLY`. Powstał harness `scripts/install-vps.test.sh` (14 asercji PASS). `bash -n` czysty, jedyny `read -r` w `ask_tty` (grep-strażnik zielony). Pełny suite projektu 163/163 PASS.
- Fazy 2–7: do zrobienia.

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

## Odroczone do implementacji

- Forma przekazania `/dev/tty` przez granicę `su` (spike-gate przed Fazą 4; alternatywy `runuser`/`sudo -u`).
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
