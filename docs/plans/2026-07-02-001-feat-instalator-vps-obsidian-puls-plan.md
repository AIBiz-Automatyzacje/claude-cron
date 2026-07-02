---
title: "feat: Połączony instalator VPS (Obsidian + Puls) — jedna komenda"
type: feat
status: active
date: 2026-07-02
origin: docs/plans/2026-07-01-001-feat-polaczony-instalator-vps-flow.md
design_md: null
figma_spec: null
figma_screens: {}
---

# feat: Połączony instalator VPS (Obsidian + Puls) — jedna komenda

## Przegląd

Przebudowa `scripts/install-vps.sh` (dziś: liniowy skrypt 578 linii, tylko Puls) w komponentowy instalator, który jedną komendą `curl … | sudo bash` stawia na świeżym Ubuntu VPS całość: narzędzia (Node 22, gh, Claude Code natywnie, ob, Tailscale) → blok 4 pytań → blok 5 loginów → Obsidian Sync + sparse checkout `.claude` + symlink → 2 usługi systemd → UFW → auto-update cron → plik-dowód w vault. Po merge repo `obsidian-vps-installer` do wycofania.

## Ujęcie problemu

Kursant (mało techniczny, lekcja „B1 — Asystent w chmurze") przechodzi dziś **dwa osobne instalatory** pokrywające się w ~60% (dublowany login Claude, dwa przebiegi, ręczny GitHub PAT). Cel: jedna komenda, 4 pytania, 5 logowań w jednym bloku, nagroda widoczna na telefonie. Pełny spec przebiegu i decyzje produktowe: dokument źródłowy (po sesji roast 2026-07-02).

## Śledzenie wymagań

Z dokumentu źródłowego (sekcje: Decyzja produktowa, Dostarczenie, Prerequisites, FAZY 0–6, Właściwości przekrojowe):

- R1. **Monolit UX**: bez flag = wszystko (Obsidian + Puls); flagi `--only-puls`/`--no-obsidian` dla forków; struktura kodu = funkcje per komponent + GUARD-y.
- R2. **One-liner `curl|sudo bash`**: KAŻDY `read` i KAŻDY handoff interaktywny (`claude`/`gh`/`ob`/`tailscale`) przez `/dev/tty` z fallbackiem; test wyłącznie przez prawdziwy pipe.
- R3. **Preflight**: root/OS/internet + checklist prerequisites (Enter) + detekcja stanu (guard Obsidiana rozbity na DWA checki: login / sync-setup).
- R4. **Faza 1 = 4 pytania**: email Obsidian, nazwa vaulta, repo `.claude` (walidacja formatu; dostępu — po gh login), Discord webhook (puste = pomiń). Reszta auto/default/flaga (`--port`, `--tz`, `--device-name vps-$(hostname)`, `--no-auto-update`).
- R5. **gh device flow zamiast PAT**: `gh auth login` → `gh auth setup-git` → walidacja `gh repo view` z retry-in-place; sparse checkout i nocny cron z czystym URL-em (zero tokenu w remote).
- R6. **Blok 5 loginów w jednym ciągu** (Claude → gh → `ob login --email` → `ob sync-setup` → `tailscale up`), każdy weryfikowany natychmiast, **3 próby retry-in-place, NIGDY rollback**; po 3 failach leave-partial + komunikat „wklej tę samą komendę".
- R7. **Rollback (`trap ERR`) TYLKO dla automatów** (apt, useradd, clone, systemd) — blok loginów poza zasięgiem trapu.
- R8. **Obsidian**: `ob sync-config --file-types image,audio,video,pdf,unsupported` + weryfikacja przez `sync-status`, TWARDA kolejność przed startem service; sparse checkout `.claude` → `~/vault-git`; symlink `~/vault/.claude`; systemd `obsidian-sync` (Restart=always, lock cleanup).
- R9. **Puls**: clone + `npm install --production` + systemd `claude-cron` (WORKSPACE=`~/vault`, PORT=7777, TZ autodetect, [DISCORD]) — spójny z `lib/config.js`.
- R10. **Sieć/auto-update**: UFW allow 22 / deny 7777; auto-update cron 02:00 zawsze (sudoers NOPASSWD, node-guard, pull vault-git przez gh credential helper).
- R11. **Finał**: weryfikacja serwisów (do 90 s na pierwszy sync) → plik-dowód `Witaj-z-VPS.md` → opcjonalne pytanie o Funnel NA KOŃCU → podsumowanie (dashboard z adnotacją „po lekcji o Pulsie").
- R12. **`--reset`**: usuwa services, usera, vault, vault-git, sudoers, cron — z potwierdzeniem, guardy `${var:?}`.
- R13. **Idempotencja = resume**: re-run tej samej komendy dokłada tylko brakujące (mechanizm powrotu po leave-partial i padzie SSH).

## Granice scope'u

- **Nie ruszamy runtime'u** (`server.js`, `lib/*`) — merge dotyczy instalatora. Wyjątek: brak.
- **Hardening bezpieczeństwa** (CORS/CSRF, rate-limit webhooka, check UFW+XFF) — osobny backlog (źródło: sekcja „Ocena zabezpieczenia").
- **Telegram** — osobne zadanie (wymaga `lib/telegram.js`); w instalatorze tylko: sekcja powiadomień jako osobna funkcja pod przyszłą wstawkę.
- **Wycofanie repo `obsidian-vps-installer`** — czynność po merge, poza kodem tego repo (nota operacyjna).
- **`install.sh` / `install.ps1` (macOS/Windows)** — bez zmian.

## Kontekst i research

### Relevantny kod i wzorce

- `scripts/install-vps.sh` — baza. **Przetrwają ~bez zmian**: `is_node_supported()` (L57–74), UFW (L322–349), template systemd Pulsa + `ENV_LINES` (L275–308), node-guard heredoc (L474–513), sudoers + cron dedup (L453, L521–529), normalizacja ścieżek z `read` (L219–224). **Do przebudowy**: L137 `npm i -g @anthropic-ai/claude-code` → natywny `curl claude.ai/install.sh | bash`; wszystkie gołe `read`/`su -c` → `/dev/tty`; struktura liniowa → funkcje per komponent; brak flag/trap/guardów/obsidian/gh.
- `install.sh` (macOS bootstrap) — wzorce do przeniesienia: handoff `/dev/tty` z fallbackiem (L236–244), env-override źródła do testów (L26–30), allowlista stanowych katalogów (L32–35), guard lib-only `CLAUDE_CRON_LIB_ONLY` (L272).
- `install.test.sh` — wzorzec testów bash: `CLAUDE_CRON_LIB_ONLY=1 source`, sandbox `mktemp -d` + `trap EXIT`, ręczne `pass()`/`problem()`, testy czystych funkcji.
- `scripts/uninstall-macos.sh` — wzorzec uninstalla: flagi pętlą `case`, confirm-before-delete, guardy `[ -d ]` przed `rm -rf`, dane usera nietknięte bez jawnej flagi.
- `lib/config.js` — env czytane przez serwer: `CLAUDE_CRON_PORT`, `CLAUDE_CRON_WORKSPACE`, `DISCORD_WEBHOOK_URL`, `WEBHOOK_BASE_URL`; progi `MIN_NODE_VERSION='22.13'` / `MAX_NODE_VERSION='25'`. `CLAUDE_CRON_VPS_URL` — NIE ustawiać na VPS.
- Konwencje: snake_case czasownikowe (`is_*` predykaty), `set -euo pipefail`, kolory + `info/ok/warn/fail/ask`, komunikaty do usera PO POLSKU (kursant nietechniczny; dziś mieszane — ujednolicić przy przebudowie).

### Wiedza instytucjonalna

- `docs/solutions/deployment-issues/2026-06-30-curl-bash-instalator-interaktywny-tty.md` — stdin pod `curl|bash` = pipe, każdy `read`/handoff dostaje EOF; `/dev/tty` z fallbackiem; `rm -rf "${var:?}/…"`; testuj przez prawdziwy pipe; czyste funkcje za flagą lib-only; `bash -n` przed odpaleniem.
- `docs/solutions/deployment-issues/2026-07-01-instalator-cross-platform-irm-iex-encoding-env-symlink.md` — env-override źródła (URL + ref) do testu z feature-brancha PRZED mergem.
- `docs/solutions/runtime-errors/2026-06-29-migracja-better-sqlite3-na-node-sqlite.md` — okno Node `>=22.13 <25` egzekwowane w KAŻDEJ kopii (install, cron-guard, engines, config.js); porównania na intach MAJOR/MINOR, nie float.
- `docs/completed/ulatwienie-instalacji/ulatwienie-instalacji-podsumowanie.md` — cron-guard jako osobny skrypt (cron roota = czysty shell); **znane P3 do naprawy przy okazji**: niecytowany `$VAULT_GIT` w `CRON_CMD`, duplikacja logiki porównania wersji bash↔heredoc.
- `docs/completed/instalacja-jedna-komenda/instalacja-jedna-komenda-podsumowanie.md` — kontrakt danych re-run (`data/` przeżywa ZAWSZE); granica testowalności: interaktywne loginy = Operator checklist, nie testy automatyczne.
- Okno maintenance `02:00–02:15` (`MAINTENANCE_WINDOW` w config.js) — cron auto-update MUSI zostać przy 02:00 (spójność z missed-job detection).

### Referencje zewnętrzne

- `ob` CLI zweryfikowane w tej sesji (README `obsidian-headless@0.0.12`): `ob login [--email] [--password] [--mfa]` — opcje interaktywne gdy pominięte; `ob sync-setup --vault --path --device-name`; `ob sync-config --path --file-types`; `ob sync-status`.
- Przewodnik: `…workspace/Zasoby/Archiwum/Tech/obsidian-headless-vps-guide.md` (sekcja 3: file-types; sekcja 4: systemd obsidian-sync).

## Kluczowe decyzje techniczne

- **Jeden samowystarczalny plik `scripts/install-vps.sh`** (nie bootstrap+moduły): `curl|bash` wymaga self-contained; struktura = funkcje per komponent + `main()` + guard lib-only (testowalność bez side-effectów). Świadomy wyjątek od reguły „plik > 300 linii" — jak dotychczasowe instalatory; skrypt urośnie do ~1000–1200 linii.
- **Helpery TTY jako pojedyncze źródło prawdy**: `ask_tty()` (prompt+read z `/dev/tty`) i `run_login()` (handoff interaktywny + weryfikacja + pętla 3 prób). Zakaz gołego `read -r` poza helperem — egzekwowany testem grep (patrz IU1).
- **Rollback jako stos**: automaty rejestrują akcje cofające w tablicy `ROLLBACK_STACK`; `trap ERR` odwija w odwrotnej kolejności. Blok loginów wykonywany z trapem zdjętym (`trap - ERR`) — loginy mają własną semantykę (retry → leave-partial). Rollback NIE dotyka `data/` ani `/home/claude` z loginami.
- **Guardy detekcji stanu jako czyste-testowalne funkcje** z wstrzykiwanym wykonaniem (wzorzec DI z `setup.test.mjs`/`is_node_supported`): każdy guard to `has_*()` zwracający 0/1, decyzje `main()` na ich podstawie.
- **Env-override do testów z brancha**: `CLAUDE_CRON_REPO` + `CLAUDE_CRON_REF` (fallback: repo/main jak dziś) — umożliwia prawdziwy `curl|sudo bash` z feature-brancha przed merge.
- **Komunikaty do usera po polsku** — ujednolicenie (dziś mieszane); nazwy sekcji/komentarze mogą zostać EN/PL wg konwencji repo.
- **Flagi przez `bash -s --`**: one-liner z flagami = `curl … | sudo bash -s -- --only-puls` (do README).
- **`--file-types` bez pytania**: stała `image,audio,video,pdf,unsupported` (domknięte z przewodnikiem).
- **Timezone**: autodetekcja `timedatectl show --property=Timezone`, fallback `Europe/Warsaw`, override `--tz`.

## Otwarte pytania

### Rozwiązane podczas planowania

- Dostarczenie: one-liner + `/dev/tty` wszędzie + Ubuntu (spec, sesja roast).
- Semantyka błędów loginów: 3× retry-in-place, leave-partial, rollback tylko automaty (spec).
- Kształt kodu: jeden plik + funkcje + lib-only guard (powyżej).
- Auth repo: gh device flow + credential helper (spec).

### Odroczone do implementacji

- **Dokładna forma przekazania `/dev/tty` przez granicę `su`** (`su - user -c "cmd" < /dev/tty` vs redirect wewnątrz `-c`) — zależy od zachowania `su`/PAM na Ubuntu; rozstrzygnąć na prawdziwym pipe (Operator gate).
- **Dokładne stringi wyjść `ob sync-status` / `gh auth status`** do parsowania w guardach — poznawalne dopiero na żywym narzędziu; guardy pisać odpornie (exit code przed parsowaniem tekstu).
- **Parsowanie URL z `tailscale funnel status`** — obecny `grep -oP` (L416) kruchy; fallback „zapytaj usera" zostaje, ale format wyjścia sprawdzić na żywo.
- **Dokładne komendy sparse checkout** (`git clone --filter=blob:none --sparse` vs `--depth 1` + `sparse-checkout set`) — wybór po próbie na prywatnym repo z gh credential helper.

## Implementation Units

Kolejność = zależności. IU2–IU6 mapują się 1:1 na FAZY 0–6 spec-u; IU1 daje szkielet, na którym reszta wisi.

- [x] **Unit 1: Szkielet komponentowy — funkcje, flagi, TTY, trap/rollback, harness testowy**

**Cel:** Przekształcenie liniowego skryptu w strukturę: stałe → helpery (log/tty/retry/rollback) → funkcje-komponenty → `main "$@"` za guardem lib-only. Parsowanie flag. Fundament pod wszystkie kolejne IU.

**Wymagania:** R1, R2, R7 (mechanizmy), R13 (mechanizm)

**Zależności:** Brak

**Pliki:**
- Modyfikuj: `scripts/install-vps.sh` (restrukturyzacja; istniejące sekcje przenoszone do funkcji BEZ zmian zachowania w tym IU)
- Stwórz: `scripts/install-vps.test.sh` (harness wg wzorca `install.test.sh`: lib-only + sandbox + pass/problem)
- Test (unit): `scripts/install-vps.test.sh`

**Delegate to:** claude (catch-all — praca bash/systemd, poza matrycą UI/data builderów)

**Skills in play:** — (brak skilli frameworkowych; obowiązują `.claude/rules/*` i wzorce z `docs/solutions/`)

**Podejście:**
- `main()` + `if [ "${CLAUDE_CRON_LIB_ONLY:-0}" != "1" ]; then main "$@"; fi` (wzorzec `install.sh:272`).
- Flagi pętlą `case`: `--only-puls`, `--no-obsidian`, `--reset`, `--port <n>`, `--tz <tz>`, `--device-name <s>`, `--no-auto-update`, `--help`; nieznana flaga → `fail`. `--only-puls` i `--no-obsidian` wzajemnie wykluczające z `--reset`.
- `ask_tty VAR "prompt" "default"` — jedyne miejsce z `read`; czyta z `/dev/tty` gdy `[ -r /dev/tty ]`, inaczej fallback: przyjmij default lub `fail` przy pytaniu bez defaultu (z komunikatem o braku terminala).
- `run_login "opis" login_cmd verify_cmd` — pętla max 3 prób: handoff przez `/dev/tty` → weryfikacja → fail: „Spróbuj ponownie? [T/n]"; po 3 → `halt_leave_partial` (czyste zatrzymanie z komunikatem resume, exit ≠ 0, BEZ rollbacku).
- Rollback: `push_rollback "cmd"` + `trap on_err ERR`; `on_err` odwija stos w odwrotnej kolejności i wypisuje co cofnął. `disable_rollback`/`enable_rollback` wokół bloku loginów.
- Env-override: `REPO="${CLAUDE_CRON_REPO:-<default>}"`, `REF="${CLAUDE_CRON_REF:-main}"`.
- Komunikaty user-facing PL (ujednolicenie przy przenoszeniu sekcji).

**Wzorce do naśladowania:**
- `install.sh` L236–244 (handoff `/dev/tty` + fallback), L26–35 (env-override, allowlist), L272 (guard lib-only)
- `scripts/uninstall-macos.sh` L24–30 (parsowanie flag)
- `install.test.sh` (harness: sandbox, pass/problem, source lib-only)

**Scenariusze testowe:**
- [x] [Unit] parsowanie flag: `--port 8888` ustawia PORT; nieznana flaga → exit ≠ 0; `--reset` + `--only-puls` → exit ≠ 0
- [x] [Unit] `ask_tty` bez `/dev/tty` (symulacja: funkcja z wstrzykniętą ścieżką tty): pytanie z defaultem → zwraca default; pytanie bez defaultu → fail z czytelnym komunikatem
- [x] [Unit] `run_login` z wstrzykniętym `verify_cmd` failującym 2× i przechodzącym za 3. → sukces; failującym 3× → wywołuje `halt_leave_partial` (exit ≠ 0), NIE odwija rollback-stosu
- [x] [Unit] `push_rollback` + symulowany błąd → akcje cofnięte w odwrotnej kolejności; `disable_rollback` → błąd w bloku NIE odwija stosu
- [x] [Unit] `bash -n scripts/install-vps.sh` przechodzi

**Weryfikacja:**
- [x] `bash -n scripts/install-vps.sh` — zero błędów składni
- [x] `bash scripts/install-vps.test.sh` — wszystkie asercje PASS (14/14)
- [x] `grep -n 'read -r' scripts/install-vps.sh` poza definicją `ask_tty` zwraca 0 linii (żadnego gołego `read` w przebiegu)

---

- [x] **Unit 2: FAZA 0 + FAZA 1 — preflight, checklist, detekcja stanu, blok 4 pytań**

**Cel:** Wejście instalatora: sanity-checki, checklist prerequisites, guardy detekcji stanu (baza idempotencji/resume), zebranie całego typowanego configu w jednym bloku.

**Wymagania:** R3, R4, R13

**Zależności:** Unit 1

**Pliki:**
- Modyfikuj: `scripts/install-vps.sh`
- Test (unit): `scripts/install-vps.test.sh`

**Delegate to:** claude (catch-all)

**Skills in play:** —

**Podejście:**
- Preflight: EUID=0, `/etc/os-release` (Debian/Ubuntu), internet (`curl -fsI api.github.com`). Checklist prerequisites (6 pozycji ze spec-u, w tym hasło e2e vaulta i konto Tailscale) → `ask_tty` „[Enter = mam wszystko]".
- Guardy jako funkcje `has_user_claude`, `has_supported_node` (reuse `is_node_supported`), `has_claude_auth`, `has_gh_auth` (`gh auth status`, exit code), `has_ob_auth` i `has_ob_sync` (**dwa OSOBNE checki** — `ob login` bez argumentów pokazuje konto vs `ob sync-status --path ~/vault`), `has_service <name>`, `has_tailscale_ip`. Wszystkie odporne: najpierw `command -v`, potem exit code, dopiero potem parsowanie.
- Blok pytań (wszystkie przez `ask_tty`): email (niepuste, walidacja `@`), vault (niepuste), repo (normalizacja `user/repo` → pełny URL, walidacja FORMATU regexem; funkcja czysta `normalize_repo`), Discord webhook (puste = pomiń; walidacja prefixu `https://discord.com/api/webhooks/` gdy niepuste). Podsumowanie → „Kontynuujemy? [T/n]".
- Auto-wartości: `DEVICE_NAME="${FLAG_DEVICE:-vps-$(hostname)}"`, `PORT="${FLAG_PORT:-7777}"`, `TZ_VAL="${FLAG_TZ:-$(timedatectl …)}"` fallback `Europe/Warsaw`.
- W trybie `--only-puls`: pomiń pytania Obsidianowe, wraca pytanie o workspace (jak dziś, z normalizacją ścieżki L219–224).

**Wzorce do naśladowania:**
- `install-vps.sh` L219–224 (normalizacja inputu ścieżki), L57–74 (`is_node_supported`)
- `setup.test.mjs` (DI-probe dla funkcji detekcyjnych)

**Scenariusze testowe:**
- [x] [Unit] `normalize_repo`: `user/repo` → `https://github.com/user/repo.git`; pełny URL https → bez zmian; URL ssh / śmieci → exit ≠ 0
- [x] [Unit] walidacja emaila: brak `@` → ponowne pytanie; walidacja Discord URL: zły prefix → ponowne pytanie
- [x] [Unit] autodetekcja TZ: pusty wynik `timedatectl` (wstrzyknięty) → `Europe/Warsaw`
- [x] [Unit] `has_ob_auth` vs `has_ob_sync`: wstrzyknięte wyjścia — zalogowany-bez-synca daje (0,1) — dwa checki NIE sklejone
- [ ] [Manual] checklist prerequisites wyświetla 6 pozycji i czeka na Enter (ogląd na prawdziwym pipe)

**Weryfikacja:**
- [x] `bash scripts/install-vps.test.sh` — nowe asercje PASS (25/25)
- [x] `grep -c 'ask_tty' scripts/install-vps.sh` ≥ 6 (4 pytania + checklist + podsumowanie) i `grep 'read -r' …` nadal tylko w `ask_tty` (17 użyć; jedyny `read -r` w `ask_tty`)

---

- [ ] **Unit 3: FAZA 2 — narzędzia (apt+gh, Node, user, Claude NATYWNIE, ob, Tailscale)**

**Cel:** Wszystkie narzędzia zainstalowane przed jakimkolwiek loginem; zmiana instalacji Claude z npm na natywną; Tailscale przeniesiony z końca skryptu do fundamentu.

**Wymagania:** R1 (guardy), R5 (gh obecny), R6 (prerequisity bloku loginów)

**Zależności:** Unit 1 (rollback/guardy), Unit 2 (decyzje z flag)

**Pliki:**
- Modyfikuj: `scripts/install-vps.sh`
- Test (unit): `scripts/install-vps.test.sh`

**Delegate to:** claude (catch-all)

**Skills in play:** —

**Podejście:**
- `apt-get install -y git curl ca-certificates cron gh` (gh jest w Ubuntu universe; guard `command -v gh`).
- Node: istniejąca sekcja (nodesource setup_22.x + `is_node_supported`) przeniesiona do funkcji, zachowanie bez zmian.
- `useradd -m -s /bin/bash claude` za guardem `has_user_claude`; `push_rollback "userdel -r claude"` TYLKO gdy user powstał w tym runie (nigdy nie cofaj cudzego stanu).
- Claude Code NATYWNIE: `su - claude -c "curl -fsSL https://claude.ai/install.sh | bash"` → `~/.local/bin/claude` (przewodnik headless sekcja 2b; spójne z PATH w systemd). Guard: `su - claude -c "command -v claude"`.
- `npm i -g obsidian-headless` (bin `ob`); pomijane przy `--only-puls`.
- Tailscale: istniejąca sekcja instalacji (L358–371, curl install.sh + czekanie na daemon) przeniesiona TU z Fazy 5; sam `tailscale up` idzie do IU4.
- Rollback automatów: rejestrowane tylko akcje tego runa (guard-first, potem push_rollback).

**Wzorce do naśladowania:**
- `install-vps.sh` L49–95 (Node), L121–129 (useradd), L358–371 (tailscale install + wait)
- Przewodnik headless sekcja 2b (natywna instalacja Claude)

**Scenariusze testowe:**
- [Unit] kolejność wywołań w `main()` (introspekcja listy funkcji / test sekwencji): wszystkie `install_*` PRZED `login_block` (żadne narzędzie nie instaluje się po pierwszej pauzie)
- [Unit] `--only-puls` → funkcje `install_ob`/kroki obsidianowe nie wywoływane (wstrzyknięty rejestrator wywołań)
- [Unit] rollback rejestrowany warunkowo: guard `has_user_claude`=0 (istnieje) → brak `userdel` na stosie
- [Manual] czysty Ubuntu VPS: wszystkie narzędzia obecne po Fazie 2 (`command -v node gh claude ob tailscale`)

**Weryfikacja:**
- `bash scripts/install-vps.test.sh` — asercje sekwencji i guardów PASS
- `grep -n '@anthropic-ai/claude-code' scripts/install-vps.sh` → 0 linii (npm-instalacja Claude usunięta)

---

- [ ] **Unit 4: FAZA 3 — blok 5 loginów (retry, weryfikacje, gh setup-git, walidacja repo)**

**Cel:** Jedyna strefa interaktywna: 5 pauz pod rząd, każda przez `run_login` (3 próby, natychmiastowa weryfikacja), leave-partial przy wyczerpaniu prób; auth gita dla checkoutu i crona.

**Wymagania:** R5, R6, R7 (trap zdjęty), R13 (guardy pomijają zrobione)

**Zależności:** Unit 1 (`run_login`, `disable_rollback`), Unit 2 (guardy, config), Unit 3 (narzędzia)

**Pliki:**
- Modyfikuj: `scripts/install-vps.sh`
- Test (unit): `scripts/install-vps.test.sh`

**Delegate to:** claude (catch-all)

**Skills in play:** —

**Podejście:**
- `disable_rollback` na wejściu bloku, `enable_rollback` na wyjściu.
- PAUZA 1: `su - claude -c "claude"` < `/dev/tty`; weryfikacja: nieinteraktywny probe (np. `claude -p` krótki / plik credentials) — dokładna forma odroczona do implementacji.
- PAUZA 2: `su - claude -c "gh auth login …"` (device flow); weryfikacja `gh auth status`; po sukcesie `gh auth setup-git` + **walidacja repo**: `gh repo view <REPO>` — 404/brak dostępu → komunikat + ponowne pytanie o repo (`ask_tty`) w pętli 3 prób (retry-in-place obejmuje tu i login, i poprawkę repo).
- PAUZA 3: `su - claude -c "ob login --email '<EMAIL>'"` (samo hasło + 2FA); weryfikacja przez `has_ob_auth`.
- PAUZA 4: `su - claude -c "ob sync-setup --vault … --path ~/vault --device-name …"`; weryfikacja `has_ob_sync`.
- PAUZA 5: `tailscale up` (root); weryfikacja `tailscale ip -4` niepuste.
- Każda pauza za swoim guardem (resume wskakuje w brakującą). Kolejność stała: Claude → gh → ob → sync → tailscale.
- Pauzy 3–4 pomijane przy `--only-puls`.

**Notatka wykonawcza:** Przetestuj granicę `su` + `/dev/tty` na prawdziwym pipe NAJPIERW (spike w Docker/multipass), zanim rozepniesz na 5 loginów — to najbardziej ryzykowny mechanizm IU.

**Wzorce do naśladowania:**
- `install-vps.sh` L141–162 (obecny handoff login Claude — do owinięcia w `run_login` + `/dev/tty`)
- `docs/solutions/deployment-issues/2026-06-30-…tty.md` (handoff + fallback)

**Scenariusze testowe:**
- [Unit] sekwencja bloku: przy wszystkich guardach=zrobione → zero wywołań loginów (pełny resume)
- [Unit] guard gh=brak, reszta=zrobione → wywołana tylko PAUZA 2 (+ setup-git + walidacja repo)
- [Unit] walidacja repo: `gh repo view` fail → ponowne pytanie o repo → drugie podejście z nowym repo (wstrzyknięte atrapy)
- [Unit] rollback-stos nietknięty przy `halt_leave_partial` w środku bloku
- [Manual] pełny blok 5 loginów na czystym VPS przez prawdziwy `curl|sudo bash` — każda pauza czyta z klawiatury, literówka w haśle ob → retry działa, 3× fail → komunikat resume, re-run wskakuje w brakujący login

**Weryfikacja:**
- `bash scripts/install-vps.test.sh` — asercje sekwencji/guardów/retry PASS
- `grep -n 'su - .*-c' scripts/install-vps.sh` — każda linia z interaktywnym CLI (claude/gh/ob bez `-p`/`--email`-only) zawiera `/dev/tty`

**Operator checklist:**
- [ ] Spike: `su - claude -c "claude" < /dev/tty` działa pod prawdziwym pipe (Docker/multipass Ubuntu) — rozstrzyga odroczoną formę redirectu

---

- [ ] **Unit 5: FAZA 4 — Obsidian (sync-config, sparse checkout, symlink, systemd) + Puls (repo, systemd)**

**Cel:** Cała bezobsługowa część: konfiguracja file-types PRZED startem serwisu, `.claude` przez git + symlink, dwie usługi systemd.

**Wymagania:** R8, R9

**Zależności:** Unit 4 (auth Claude/gh/ob istnieje)

**Pliki:**
- Modyfikuj: `scripts/install-vps.sh`
- Test (unit): `scripts/install-vps.test.sh`

**Delegate to:** claude (catch-all)

**Skills in play:** —

**Podejście:**
- `ob sync-config --path ~/vault --file-types image,audio,video,pdf,unsupported` → weryfikacja: `ob sync-status` zawiera `unsupported` w linii `File types:`; fail → `fail` z instrukcją (to automat — pod trapem).
- Sparse checkout `.claude` z `<REPO>` → `~/vault-git` (auth: credential helper gh, czysty URL; dokładne komendy git odroczone). Guard: katalog z `.git` → `git pull`.
- Symlink `ln -sfn ~/vault-git/.claude ~/vault/.claude` (idempotentny; `-n` bo cel to katalog).
- Systemd `obsidian-sync`: `ExecStart=<ob> sync --path <vault> --continuous`, `Restart=always`, `User=claude`, `ExecStartPre` czyszczący lock sync (wzór: przewodnik sekcja 4); heredoc jak unit Pulsa.
- Puls: istniejące sekcje 6–9 (clone/pull, `npm install --production`, `mkdir data/` + chown, systemd unit z `ENV_LINES`) przeniesione do funkcji; `WORKSPACE=$CLAUDE_HOME/vault` na sztywno przy pełnym trybie (pytanie tylko w `--only-puls`); TZ z autodetekcji; `WEBHOOK_BASE_URL` NIE ustawiany tu (Funnel w IU6).
- Kolejność twarda w `main()`: `sync-config` → weryfikacja → dopiero `systemctl enable --now obsidian-sync`.
- Cały IU pod trapem ERR (automaty; rollback: `systemctl disable --now` + usunięcie unit-plików utworzonych w tym runie).

**Wzorce do naśladowania:**
- `install-vps.sh` L164–188 (clone/pull + backup non-git), L269–320 (systemd heredoc + ENV_LINES + PATH)
- Przewodnik headless sekcja 4 (unit obsidian-sync, lock cleanup)
- `docs/MIGRACJA-PULS.md` SEKCJA 10 (symlink `.claude`, dwukierunkowość)

**Scenariusze testowe:**
- [Unit] budowa ENV_LINES (funkcja czysta): pełny tryb → `CLAUDE_CRON_WORKSPACE=…/vault`, PORT, PATH z `~/.local/bin`; z Discordem → linia `DISCORD_WEBHOOK_URL`; bez → brak linii
- [Unit] generacja unitu obsidian-sync (funkcja czysta zwracająca treść): zawiera `Restart=always`, `User=claude`, ścieżkę vault
- [Unit] weryfikacja file-types: wstrzyknięte wyjście `sync-status` bez `unsupported` → fail; z → pass
- [Unit] symlink idempotentny: drugi run nie failuje, cel bez zmian
- [Manual] na VPS: `~/vault/.claude/skills` widoczne przez symlink; oba unity `active`

**Weryfikacja:**
- `bash scripts/install-vps.test.sh` — asercje ENV_LINES/unitów/file-types PASS
- `grep -n 'sync-config' scripts/install-vps.sh` występuje w `main()` PRZED `enable --now obsidian-sync` (test kolejności w harnessie)

---

- [ ] **Unit 6: FAZA 5 + 6 — UFW, auto-update, weryfikacja, plik-dowód, Funnel opt-in, podsumowanie**

**Cel:** Zamknięcie przebiegu: sieć bez interakcji, cron 02:00 zawsze, dowód działania na telefonie, opcjonalny Funnel NA KOŃCU, podsumowanie PL.

**Wymagania:** R10, R11

**Zależności:** Unit 5 (serwisy istnieją)

**Pliki:**
- Modyfikuj: `scripts/install-vps.sh`
- Test (unit): `scripts/install-vps.test.sh`

**Delegate to:** claude (catch-all)

**Skills in play:** —

**Podejście:**
- UFW: istniejąca sekcja bez zmian merytorycznych (allow 22 pierwsze, deny `$PORT`, idempotencja).
- Auto-update ZAWSZE (opt-out `--no-auto-update`): sudoers NOPASSWD (jak dziś), node-guard heredoc (jak dziś), cron 02:00 (**NIE zmieniać godziny** — spójność z `MAINTENANCE_WINDOW`). **Fix P3**: cytowanie `"$VAULT_GIT"`/ścieżek w `CRON_CMD`; pull vault-git działa przez gh credential helper (auth z IU4); pad pulla logowany (jak dziś do `claude-cron-update.log`). Przy `--only-puls` bez vault-git w cronie.
- Weryfikacja: `systemctl is-active` obu serwisów; pętla do 90 s na pierwszy sync (`ob sync-status`).
- Plik-dowód: `su - claude` → heredoc do `~/vault/Witaj-z-VPS.md` (treść PL ze spec-u) + komunikat „Otwórz Obsidiana na telefonie…". Pomijany przy `--only-puls`.
- Funnel: `ask_tty` „[t/N]" NA KOŃCU; T → `tailscale funnel --bg $PORT` → parsowanie URL (fallback: zapytaj) → wstrzyknięcie `WEBHOOK_BASE_URL` do unitu (istniejący `sed -i` przed `SyslogIdentifier`) + `daemon-reload` + restart; N → nic.
- Podsumowanie PL: dashboard `http://<TS_IP>:<PORT>` z adnotacją „otworzysz po zainstalowaniu Tailscale na komputerze — lekcja o Pulsie", webhooki (jeśli Funnel), komendy serwisowe, security-nota.

**Wzorce do naśladowania:**
- `install-vps.sh` L322–349 (UFW), L437–533 (auto-update/sudoers/guard/dedup), L401–435 (Funnel + sed), L535–578 (summary box)

**Scenariusze testowe:**
- [Unit] budowa `CRON_CMD` (funkcja czysta): ścieżka ze spacją poprawnie cytowana; `--only-puls` → bez segmentu vault-git; `--no-auto-update` → cron w ogóle nie instalowany
- [Unit] treść pliku-dowodu (funkcja czysta): zawiera nagłówek i PL treść; generacja podsumowania: z Funnel → sekcja webhooków, bez → adnotacja o lekcji
- [Unit] Funnel=N → zero wywołań `tailscale funnel` (rejestrator)
- [Manual] telefon: notatka „Witaj z VPS" dochodzi przez Sync; Funnel=T → `curl https://<funnel-url>/webhook/test` zwraca odpowiedź serwera (nie timeout)

**Weryfikacja:**
- `bash scripts/install-vps.test.sh` — asercje CRON_CMD/podsumowania/pliku-dowodu PASS
- `grep -n '0 2 \* \* \*' scripts/install-vps.sh` — godzina crona niezmieniona (02:00)

---

- [ ] **Unit 7: Tryb `--reset` + README/runbook one-linera**

**Cel:** Brakujący VPS-uninstall (z potwierdzeniem) + dokumentacja komendy instalacji dla kursanta i testera.

**Wymagania:** R12, R2 (dokumentacja wariantu wget + `bash -s --`)

**Zależności:** Unit 1 (flagi), Unit 5/6 (wiedza co usuwać)

**Pliki:**
- Modyfikuj: `scripts/install-vps.sh`
- Modyfikuj: `README.md` (sekcja instalacji VPS: one-liner curl + wariant wget + flagi + prerequisites)
- Test (unit): `scripts/install-vps.test.sh`

**Delegate to:** claude (catch-all)

**Skills in play:** —

**Podejście:**
- `--reset`: wypisz DOKŁADNĄ listę do usunięcia → `ask_tty` potwierdzenie (wpisz `TAK`, nie samo Enter) → kolejność: stop/disable obu serwisów → unit-pliki → cron root (dedup-filter jak dziś) → `/etc/sudoers.d/claude-cron` → `userdel -r claude` (kasuje vault lokalny, vault-git, auth Claude/gh/ob — dane Sync bezpieczne na serwerze Obsidian; zaznacz w komunikacie). KAŻDY `rm -rf` z guardem `${var:?}` i `[ -e ]`.
- Świadome NIE-usuwanie: Tailscale (urządzenie zostaje w tailnecie — wypisz instrukcję `tailscale logout` + usunięcie z admin console), UFW (reguły zostają — wypisz `ufw delete deny <PORT>`), Node/gh/pakiety apt (współdzielone z systemem).
- README: blok „Instalacja na VPS" — prerequisites (checklist ze spec-u), one-liner, wariant `wget -qO-`, przykład flag `curl … | sudo bash -s -- --only-puls`, `--reset`, env-override do testów z brancha.

**Wzorce do naśladowania:**
- `scripts/uninstall-macos.sh` (confirm-before-delete, guardy, dane poza scope)
- `install-vps.sh` L524–529 (dedup crona — odwrócić do usunięcia)

**Scenariusze testowe:**
- [Unit] `--reset` bez potwierdzenia `TAK` → exit bez żadnego usunięcia (rejestrator wywołań)
- [Unit] lista usuwanych ścieżek: każda przechodzi walidację guardu `${var:?}` (test funkcji budującej listę — brak pustych zmiennych)
- [Unit] `--reset` przy nieistniejących artefaktach (świeży system) → przechodzi bez błędów (idempotentny)
- [Manual] pełny cykl na VPS: install → `--reset` → re-install działa od zera

**Weryfikacja:**
- `bash scripts/install-vps.test.sh` — asercje resetu PASS
- `grep -n 'rm -rf' scripts/install-vps.sh` — każda linia zawiera `${…:?}` lub poprzedzający guard `[ -e/-d ]` (kontrola wzrokowa w review + grep count)
- README zawiera sekcje: one-liner, prerequisites, flagi (grep nagłówków)

## Wpływ systemowy

- **Graf interakcji:** instalator → systemd (2 unity), cron roota, sudoers, UFW, `~/.gitconfig`/credential store usera claude (gh), pliki vault. Runtime Pulsa nietknięty; jedyny punkt styku to env w unicie (`lib/config.js` — lista zmiennych zweryfikowana).
- **Propagacja błędów:** automaty → trap ERR → rollback stosu + czytelny raport; loginy → retry → leave-partial + instrukcja resume. Nocny cron: pad pulla logowany, restart wstrzymany tylko przez node-guard (jak dziś).
- **Ryzyka cyklu życia stanu:** re-run nie może dotknąć `data/claude-cron.db` (kontrakt danych — guard `git pull` zamiast re-clone); rollback nie może kasować `/home/claude` gdy user istniał przed runem; `userdel -r` tylko w `--reset` po potwierdzeniu.
- **Parytet surface API:** brak zmian w API serwera. Progi Node w 4 kopiach (install, cron-guard, engines, config.js) — bez zmian wartości, pilnować przy przenoszeniu sekcji.
- **Pokrycie integracyjne:** pełny przebieg one-linera z 5 loginami jest niewykonalny headless — pokrycie: testy czystych funkcji + testy sekwencji z rejestratorem wywołań + Operator gate na prawdziwym VPS (poniżej).

## Ryzyka i zależności

- **`su` + `/dev/tty` pod pipe** — mechanizm krytyczny dla całego bloku loginów; spike PRZED implementacją IU4 (Operator checklist IU4). Jeśli `su` nie przekaże tty → alternatywa `runuser`/`sudo -u` do rozstrzygnięcia w implementacji.
- **`ob` (`obsidian-headless@0.0.12`) — młody pakiet, UNLICENSED**: formaty wyjść (`sync-status`) mogą się zmieniać; guardy pisać na exit code, parsowanie tekstu jako ostatnia deska.
- **Rozjazd progów Node** przy przenoszeniu sekcji do funkcji — pilnować `>=22.13 <25` we wszystkich kopiach (udokumentowana pętla padów).
- **`gh` z apt Ubuntu bywa stary** — device flow działa od dawna, ale jeśli okaże się za stary na `setup-git`, fallback: oficjalne repo apt GitHub CLI (decyzja w implementacji, za guardem wersji).
- **Wielkość pliku** (~1100+ linii bash) — mitygacja: sekcje-funkcje z twardym porządkiem w `main()`, testy czystych funkcji, `bash -n` w harnessie.

## Dokumentacja / Notatki operacyjne

- README: sekcja instalacji VPS (IU7).
- Po merge: wycofanie `AIBiz-Automatyzacje/obsidian-vps-installer` (archiwizacja repo + nota w README tamtego repo) — czynność operatora, poza tym repo.
- Aktualizacja `docs/MIGRACJA-PULS.md` SEKCJA 10 (status: zrealizowane) — przy `/dev-docs-complete`.
- Po wdrożeniu: `/dev-compound` na nowe tereny (ob headless, gh device flow w instalatorze, trap-ERR-rollback vs leave-partial) — zidentyfikowane luki w wiedzy instytucjonalnej.

## Operator gate (całościowy, poza autopilotem)

- [ ] Prawdziwy `curl … | sudo bash` z feature-brancha (env-override `CLAUDE_CRON_REPO`/`CLAUDE_CRON_REF`) na czystym Ubuntu VPS: pełny happy path B1 (4 pytania → 5 loginów → notatka na telefonie)
- [ ] Scenariusz literówki: zły kod 2FA w `ob login` ×1 → retry działa; ×3 → leave-partial → re-run wznawia od `ob login`
- [ ] Re-run po sukcesie: wszystkie guardy = pomiń, przebieg kończy się bez zmian stanu
- [ ] `--reset` → re-install od zera

## Źródła i referencje

- **Dokument źródłowy:** [docs/plans/2026-07-01-001-feat-polaczony-instalator-vps-flow.md](docs/plans/2026-07-01-001-feat-polaczony-instalator-vps-flow.md) (spec przebiegu po sesji roast 2026-07-02)
- Powiązany kod: `scripts/install-vps.sh`, `install.sh`, `install.test.sh`, `scripts/uninstall-macos.sh`, `lib/config.js`
- Wiedza instytucjonalna: `docs/solutions/deployment-issues/2026-06-30-curl-bash-instalator-interaktywny-tty.md`, `docs/solutions/deployment-issues/2026-07-01-instalator-cross-platform-irm-iex-encoding-env-symlink.md`, `docs/solutions/runtime-errors/2026-06-29-migracja-better-sqlite3-na-node-sqlite.md`, `docs/completed/ulatwienie-instalacji/…`, `docs/completed/instalacja-jedna-komenda/…`
- Zewnętrzne: przewodnik `…workspace/Zasoby/Archiwum/Tech/obsidian-headless-vps-guide.md`; README `obsidian-headless@0.0.12`; kontekst kursu: `docs/MIGRACJA-PULS.md` SEKCJA 10
