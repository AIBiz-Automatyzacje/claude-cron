# Plan: Połączony instalator VPS (Obsidian + Puls) — jedna komenda

Branch: `feature/instalator-vps-obsidian-puls`
Ostatnia aktualizacja: 2026-07-02

## Podsumowanie wykonawcze

Przebudowa `scripts/install-vps.sh` (dziś: liniowy skrypt 578 linii, tylko Puls) w komponentowy instalator, który jedną komendą `curl … | sudo bash` stawia na świeżym Ubuntu VPS całość dla kursanta lekcji „B1 — Asystent w chmurze": narzędzia (Node 22, gh, Claude Code natywnie, ob, Tailscale) → blok 4 pytań → blok 5 loginów → Obsidian Sync + sparse checkout `.claude` + symlink → 2 usługi systemd → UFW → auto-update cron → plik-dowód `Witaj-z-VPS.md` widoczny na telefonie. Po merge repo `obsidian-vps-installer` do wycofania.

## Cele i zakres

**Cele** (wymagania R1–R13 w planie technicznym):
1. Monolit UX: bez flag = wszystko; flagi `--only-puls`/`--no-obsidian`/`--reset`/`--port`/`--tz`/`--device-name`/`--no-auto-update` dla świadomych.
2. One-liner `curl|sudo bash`: KAŻDY `read` i handoff interaktywny przez `/dev/tty` z fallbackiem.
3. gh device flow zamiast GitHub PAT (`gh auth login` → `setup-git` → walidacja `gh repo view` z retry).
4. Blok 5 loginów w jednym ciągu (Claude → gh → `ob login --email` → `ob sync-setup` → `tailscale up`); 3 próby retry-in-place; leave-partial zamiast rollbacku; rollback (`trap ERR`) tylko dla automatów.
5. Idempotencja = resume: re-run tej samej komendy dokłada tylko brakujące.
6. Finał: weryfikacja serwisów → plik-dowód → opcjonalny Funnel NA KOŃCU → podsumowanie PL.

**Poza zakresem:** runtime (`server.js`, `lib/*`), hardening bezpieczeństwa (backlog), Telegram (osobne zadanie), `install.sh`/`install.ps1` (macOS/Windows), wycofanie repo `obsidian-vps-installer` (czynność operatora po merge).

## Fazy wdrożenia

Fazy = Implementation Units 1–7 z planu technicznego (1:1, kolejność = zależności).

### Faza 1: Szkielet komponentowy (IU1) — nakład: L
Restrukturyzacja do funkcji + `main()` za guardem lib-only; flagi CLI; helpery `ask_tty`/`run_login`/rollback-stos; env-override `CLAUDE_CRON_REPO`/`CLAUDE_CRON_REF`; harness `scripts/install-vps.test.sh`.
**Kryteria akceptacji:** `bash -n` czysty; wszystkie asercje harnessu PASS; zero gołych `read -r` poza `ask_tty` (grep-strażnik); zachowanie istniejących sekcji bez zmian merytorycznych.

### Faza 2: Preflight + detekcja stanu + blok 4 pytań (IU2) — nakład: M
Root/OS/internet; checklist prerequisites (6 pozycji, Enter); guardy `has_*` (Obsidian: DWA osobne checki login/sync); 4 pytania (email → `ob login --email`, vault, repo z `normalize_repo`, Discord) + podsumowanie; auto-wartości (device `vps-$(hostname)`, port 7777, TZ autodetekcja→`Europe/Warsaw`).
**Kryteria akceptacji:** asercje `normalize_repo`/walidacji/TZ/guardów PASS; `--only-puls` przywraca pytanie o workspace.

### Faza 3: Narzędzia — Faza 2 spec-u (IU3) — nakład: M
`apt: git curl ca-certificates cron gh`; Node nodesource (bez zmian progów `>=22.13 <25`); `useradd claude` z warunkowym rollbackiem; **Claude Code NATYWNIE** (`~/.local/bin/claude`, koniec z npm-globalem); `npm i -g obsidian-headless`; instalacja Tailscale przeniesiona TU z końca skryptu.
**Kryteria akceptacji:** wszystkie `install_*` przed `login_block` (test sekwencji); `@anthropic-ai/claude-code` nieobecny w skrypcie (grep=0); rollback tylko dla akcji tego runa.

### Faza 4: Blok 5 loginów (IU4) — nakład: L
`disable_rollback` → 5 pauz przez `run_login` (każda za guardem, natychmiastowa weryfikacja, 3 próby) → `enable_rollback`. Po gh: `gh auth setup-git` + walidacja repo z retry-in-place. Leave-partial z komunikatem resume.
**GATE przed implementacją:** spike `su - claude -c "cmd" < /dev/tty` pod prawdziwym pipe (Docker/multipass) — rozstrzyga odroczoną formę redirectu.
**Kryteria akceptacji:** asercje sekwencji/resume/retry PASS; każdy `su -c` z interaktywnym CLI ma `/dev/tty` (grep); rollback-stos nietknięty przy leave-partial.

### Faza 5: Obsidian + Puls — Faza 4 spec-u (IU5) — nakład: L
`ob sync-config --file-types image,audio,video,pdf,unsupported` + weryfikacja `sync-status` PRZED startem serwisu (kolejność twarda); sparse checkout `.claude` → `~/vault-git` (gh credential helper, czysty URL); symlink `ln -sfn`; systemd `obsidian-sync` (Restart=always, lock cleanup); Puls: clone + `npm install --production` + systemd `claude-cron` (WORKSPACE=`~/vault`, env spójny z `lib/config.js`).
**Kryteria akceptacji:** asercje ENV_LINES/unitów/file-types PASS; `sync-config` przed `enable --now obsidian-sync` w `main()`.

### Faza 6: Sieć + finał — Fazy 5-6 spec-u (IU6) — nakład: M
UFW (allow 22, deny PORT); auto-update ZAWSZE o 02:00 (opt-out flagą; fix P3: cytowanie `"$VAULT_GIT"` w CRON_CMD; pull vault-git przez gh helper); weryfikacja serwisów (90 s na pierwszy sync); plik-dowód `Witaj-z-VPS.md` + komunikat „otwórz Obsidiana na telefonie"; Funnel jako opcjonalne pytanie NA KOŃCU; podsumowanie PL z adnotacją o dashboardzie („po lekcji o Pulsie").
**Kryteria akceptacji:** asercje CRON_CMD/pliku-dowodu/podsumowania PASS; godzina crona 02:00 niezmieniona (spójność z `MAINTENANCE_WINDOW`).

### Faza 7: `--reset` + README (IU7) — nakład: M
Uninstall VPS z potwierdzeniem (wpisz `TAK`): serwisy → unit-pliki → cron → sudoers → `userdel -r claude`; każdy `rm -rf` z guardem `${var:?}`; świadome NIE-usuwanie Tailscale/UFW/apt (instrukcje w komunikacie). README: sekcja instalacji VPS (one-liner, wariant wget, flagi przez `bash -s --`, prerequisites, env-override do testów).
**Kryteria akceptacji:** asercje resetu PASS (brak potwierdzenia = zero usunięć; idempotentny na czystym systemie); README zawiera wymagane sekcje.

## Ocena ryzyka i strategie mitygacji

| Ryzyko | Mitygacja |
|---|---|
| `su` + `/dev/tty` pod pipe nie przekazuje tty | Spike PRZED Fazą 4 (gate); alternatywy: `runuser`/`sudo -u` |
| `ob` (`obsidian-headless@0.0.12`) — młody pakiet, zmienne formaty wyjść | Guardy na exit code, parsowanie tekstu jako ostatnia deska |
| Rozjazd progów Node przy przenoszeniu sekcji | Pilnować `>=22.13 <25` w 4 kopiach (install, cron-guard, engines, config.js) |
| `gh` z apt Ubuntu za stary | Guard wersji + fallback: oficjalne repo apt GitHub CLI |
| Wielkość pliku ~1100+ linii | Funkcje-komponenty, testy czystych funkcji, `bash -n` w harnessie |
| Re-run kasuje dane | Kontrakt: `data/` nietykalne; `git pull` zamiast re-clone; `userdel -r` tylko w `--reset` po potwierdzeniu |

## Mierniki sukcesu

- Kursant na czystym Ubuntu VPS: 1 komenda → 4 pytania → 5 loginów → notatka „Witaj z VPS" na telefonie (Operator gate).
- Literówka w haśle NIE niszczy instalacji (retry → leave-partial → resume tą samą komendą).
- Re-run po sukcesie: zero zmian stanu (pełny skip przez guardy).
- `bash scripts/install-vps.test.sh` — 100% PASS; `npm test` bez regresji.

## Zależności

- Prywatne repo `.claude` kursanta + konto GitHub/Obsidian/Tailscale (prerequisites usera — instalator tylko sprawdza checklistą).
- Pakiety zewnętrzne: `obsidian-headless` (npm), `gh` (apt), nodesource, tailscale install.sh, claude.ai/install.sh.
- Testy pełnego przebiegu wymagają prawdziwego VPS/VM (Operator gate — poza autopilotem).

## Szacunki czasowe

Fazy 1–7: L+M+M+L+L+M+M — realnie 3–5 sesji roboczych z gate'ami operatorskimi po Fazie 4 i na końcu.

## Źródła

- Requirements doc: brak (zastępuje go spec przebiegu po sesji roast)
- Plan techniczny: `docs/plans/2026-07-02-001-feat-instalator-vps-obsidian-puls-plan.md`
- Spec przebiegu (źródło produktowe): `docs/plans/2026-07-01-001-feat-polaczony-instalator-vps-flow.md`
