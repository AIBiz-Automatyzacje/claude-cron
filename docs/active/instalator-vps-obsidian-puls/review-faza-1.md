# Review fazy 1 — Szkielet komponentowy (IU1)

Data: 2026-07-02
Zakres: `scripts/install-vps.sh` (restrukturyzacja + flagi + ask_tty + run_login + rollback), `scripts/install-vps.test.sh` (harness 14 asercji)
Findings po adversarial verify, zdeduplikowane przez scribe (30 surowych → 26 finalnych; scalenia opisane przy pozycjach).

## Severity gate

⚠️ **KONTYNUUJ Z ZASTRZEŻENIAMI** — 4 problemy P2 do naprawy (0 × P1).

## Statystyki

| Kategoria | Liczba |
|---|---|
| 🔴 P1 (blocking) | 0 |
| 🟠 P2 (important) | 4 (3 KOD, 1 TEST) |
| 🟡 P3 (nit) | 19 (17 KOD, 2 TEST) |
| 🧑‍🔧 OPERATOR (poza fix, checklist) | 3 |
| 🌐 E2E | 0 passed / 0 failed / 0 skipped (brak scenariuszy E2E browser w tej fazie) |
| ☑️ Weryfikacja: bookkeeping | 3 auto-PASS / 0 FAIL / 0 manual / 0 niejasne |

---

## 🟠 P2 (important)

### P2-1 [KOD] `scripts/install-vps.sh:445` — interaktywne pytanie o port omija walidację

Interaktywne pytanie o port (`configure_settings`) omija walidację numeryczną, którą ta faza dodała dla flagi `--port` (`parse_flags`, linia 129). Niepoprawna wartość (np. `7777x`, `abc`) trafia do `ufw deny "$PORT/tcp"` — błąd ufw jest zamaskowany `|| true`, więc reguła DENY NIE powstaje, a instalator i `print_summary` kłamliwie raportują „Port zablokowany w UFW (dostęp tylko przez Tailscale)". Ta sama śmieciowa wartość ląduje w `Environment=CLAUDE_CRON_PORT` unitu systemd i w `tailscale funnel --bg`.

**Fix:** przepuść odpowiedź z `ask_tty` przez tę samą walidację co `FLAG_PORT` (regex `^[0-9]+$` + zakres 1–65535), fail-fast przy złym inpucie.

> Scalono z duplikatem P3 [KOD] `:444` (asymetria walidacji flaga vs prompt — ta sama wada). Jeśli walidacja bloku pytań jest planowana w IU2 — dopisać port do listy walidowanych pól (plan wymienia tylko email/repo/discord).

### P2-2 [KOD] `scripts/install-vps.sh:146` — kontrakt ask_tty „brak tty + brak defaultu = twardy fail" nie działa bez kontrolującego terminala

Potwierdzone eksperymentalnie: `/dev/tty` ma prawa `rw-rw-rw`, więc `[ -r "$TTY_DEVICE" ]` zwraca true, ale `read < /dev/tty` pada z ENXIO („Device not configured"), a `|| __answer=""` (linia 149) połyka błąd otwarcia tak samo jak EOF. Efekt: pytanie BEZ defaultu cicho zwraca pusty string z rc=0 zamiast fail, a pytania z defaultem cicho przyjmują default bez ścieżki warn. Scenariusz: `ssh root@vps 'curl ... | bash'` (bez `-t`) → instalacja leci na ślepo z pustymi/domyślnymi odpowiedziami zamiast czystego zatrzymania. Test 8 przechodzi tylko dlatego, że symuluje brak tty NIEISTNIEJĄCYM plikiem, co nie odwzorowuje semantyki `/dev/tty`.

**Fix:** probe otwarcia przed gałęzią tty (np. `if { : < "$TTY_DEVICE"; } 2>/dev/null`) i rozróżnienie EOF od błędu redirekcji.

### P2-3 [KOD] `scripts/install-vps.sh:201` — komunikat resume w halt_leave_partial łamie R6 spec-u

`halt_leave_partial` łamie R6 spec-u („po 3 failach leave-partial + komunikat »wklej tę samą komendę«"): komunikat resume instruuje `sudo bash install-vps.sh`, ale w podstawowym trybie dostarczenia (R2: one-liner `curl … | sudo bash`) plik `install-vps.sh` nie istnieje lokalnie — kursant nietechniczny po wyczerpaniu 3 prób loginu dostaje komendę kończącą się „No such file or directory" zamiast działającej instrukcji ponownego wklejenia one-linera.

### P2-4 [TEST] `scripts/install-vps.test.sh:252` — brak grep-strażnika na goły `read` mimo deklaracji planu

Plan (Kluczowe decyzje: „Zakaz gołego `read -r` poza helperem — egzekwowany testem grep (patrz IU1)"; L76) i kontekst (decyzja 2) deklarują istnienie testu regresyjnego w harnessie — a harness go nie zawiera; weryfikacja `grep -n 'read -r'` odhaczona `[x]` była jednorazowa ręczna. IU2–IU6 dodadzą wiele promptów i handoffów; bez testu nic nie wyłapie regresji gołego `read` (pod `curl|bash` dostaje EOF i cicho psuje instalator) — przejdzie testy 14/14 bez wykrycia.

**Fix:** dodać test: grep po definicjach poza `ask_tty` zwraca 0 linii.

> Scalono z drugim identycznym P2 oraz P3 (ten sam plik:linia, ta sama wada). Stan bieżący zweryfikowany w bookkeepingu: jedyny `read -r` jest w `ask_tty` (linia 149) — reguła dziś spełniona, brakuje jedynie automatycznej egzekucji.

---

## 🟡 P3 (nit)

### KOD

1. **`scripts/install-vps.sh:74`** — `fail()` robi gołe `exit 1`, którego `trap ERR` (`on_err`) NIE łapie — każdy `fail()` po zarejestrowaniu kroków na `ROLLBACK_STACK` zakończy instalator BEZ odwinięcia stosu, mimo `ROLLBACK_ENABLED=1`. Rollback zadziała tylko dla nieprzechwyconych błędów komend. Fix: `fail()` powinien jawnie wołać logikę odwijania (lub `trap EXIT` z guardem statusu).
2. **`scripts/install-vps.sh:483`** — Discord webhook URL (de facto credential) zapisywany plaintext w world-readable (0644) `/etc/systemd/system/claude-cron.service` — każdy lokalny user VPS może go odczytać. Skoro plik jest przebudowywany: przenieś sekrety do `EnvironmentFile=` z chmod 600 root:root (dotyczy też `WEBHOOK_BASE_URL`).
3. **`scripts/install-vps.sh:632`** — `setup_funnel` wstawia `WEBHOOK_BASE_URL` z `ask_tty` (zero walidacji) przez `sed -i "/SyslogIdentifier/i Environment=..."` do unit-file roota; GNU sed interpretuje `\n` w insercie — spreparowana odpowiedź może dopisać dyrektywy unitu (np. drugie `User=`), a literówka psuje unit. Zwaliduj prefix `https://` + dozwolone znaki hostname przed zapisem.
4. **`scripts/install-vps.sh:732`** — niecytowany `$vault_git` (input z `ask_tty`) interpolowany do komendy w crontabie ROOTA (`su - claude -c "cd $vault_git && git pull ..."`) — ścieżka ze spacją/metaznakami = zepsuty/niebezpieczny wpis cron roota o 2:00. Do tego `on_err` (L187) wykonuje `ROLLBACK_STACK` przez `bash -c` jako root — ta sama klasa problemu, gdy w kolejnych IU wejdą tam ścieżki z inputu. Konwencja: wartości z inputu zawsze przez `printf %q` przy budowaniu komend cron/rollback. Dodatkowo znane P3 z planu nienaprawione mimo przenoszenia kodu: logika okna wersji Node zduplikowana między `is_node_supported` (bash) a heredokiem `cron-node-guard.sh`. *(scalono 2 findingi :732)*
5. **`scripts/install-vps.sh:302`** — odpowiednik N+1: trzy niezależne `apt-get update -qq` (`ensure_git`:302, `ensure_cron`:310, `configure_firewall`:528) — na świeżym VPS 3 pełne odświeżenia indeksów (~10–30 s każde) zamiast jednego batcha. Plan Unit 3 restrukturyzuje sekcje apt — zaadresować tam.
6. **`scripts/install-vps.sh:336`** — brak guardu idempotencji: `npm install -g @anthropic-ai/claude-code` bezwarunkowo przy każdym runie, a re-run jest jawnie wspieranym scenariuszem. Dodać guard `command -v claude` (wzorzec jak `ensure_git`/`ensure_cron`); Unit 3 zmienia instalację na natywną, wzorzec pozostaje.
7. **`scripts/install-vps.sh:383`** — `git clone --branch $REF $REPO` bez `--depth 1` pobiera pełną historię; auto-update robi tylko `git pull`, shallow wystarcza.
8. **`scripts/install-vps.sh:383`** — zmienne bez cytowania w stringach wykonywanych przez `su -c`: `clone_repo` (`git clone --branch $REF $REPO $INSTALL_DIR`) i `cron_cmd` (L732). REF/REPO to env-override operatora (niskie ryzyko), ale `vault_git` to input usera na granicy — cytować wewnątrz stringa lub walidować brak białych znaków.
9. **`scripts/install-vps.sh:513`** — stałe `sleep 2` po `systemctl restart` (513) i po pętli pollingu tailscaled (570); przy wolniejszym starcie 2 s daje fałszywy warn „Serwis nie wystartował". Krótka pętla pollingu `is-active` z timeoutem (wzorzec już użyty dla tailscaled L564–569).
10. **`scripts/install-vps.sh:791`** — `--reset`/`FLAG_RESET` parsowany i walidowany, ale nieskonsumowany w `main()` — `--reset` wykonuje dziś PEŁNĄ instalację (odwrócona semantyka destrukcyjnej flagi). Odroczenie do IU7 udokumentowane (kontekst, decyzja 14), ale do tego czasu bezpieczniej failować komunikatem „deinstalacja jeszcze niezaimplementowana". *(scalono duplikat :100)*
11. **`scripts/install-vps.sh:361`** — duplikacja wzorca handoffu TTY: identyczny blok `if [ -r "$TTY_DEVICE" ] ...` w `run_login` (L217–221) i `login_claude_cli` (L361–365). Przejściowe (decyzja 17: przejście na `run_login` w Fazie 4), ale przy IU4 skonsolidować do jednego helpera.
12. **`scripts/install-vps.sh:330`** — `ensure_claude_user` ukrycie ustawia globale `CLAUDE_HOME` i `INSTALL_DIR`, od których zależy 7 późniejszych komponentów — ukryty kontrakt kolejności niewidoczny z `main()` ani z nazwy. Minimalna poprawka: komentarz + wydzielenie `resolve_install_paths()` wołanego jawnie w `main()`.
13. **`scripts/install-vps.sh:287`** — `ensure_node`: instalacja Node zduplikowana w obu gałęziach if/else — wyciągnąć `install_node_22()`. W gałęzi „niewspierany Node" brak re-weryfikacji `is_node_supported` po doinstalowaniu — jeśli nodesource nie nadpisze aktywnego node, instalator wypisze ok, a serwis padnie na runtime-guard.
14. **`scripts/install-vps.sh:129`** — walidacja `--port` sprawdza tylko `^[0-9]+$`; potwierdzono `--port 0` i `--port 999999` przechodzą i popłyną do ufw/systemd. Dodać range-check 1..65535 w `parse_flags`.
15. **`scripts/install-vps.sh:151`** — komunikat fallbacku `ask_tty` skleja prompt z defaultem: „przyjmuję wartość domyślną: Port serwera [7777]: 7777" — mylący log headless. Rozdzielić prompt i wartość.
16. **`scripts/install-vps.sh:330`** — home przez `eval echo "~$CLAUDE_USER"` — anty-wzorzec eval na interpolowanym stringu; równie prosty odpowiednik: `getent passwd "$CLAUDE_USER" | cut -d: -f6`.
17. **`scripts/install-vps.sh:87`** — `usage()` obiecuje niezaimplementowane zachowania: `--tz` opisany jako „autodetekcja" (kod defaultuje wyłącznie do Europe/Warsaw; autodetekcja to IU2), `--device-name` parsowany i całkowicie ignorowany (cichy no-op). Decyzja #14 dokumentuje odroczenie, ale help nie zaznacza częściowej nieaktywności opcji.

### TEST

18. **`scripts/install-vps.test.sh:42`** — walidacja portu testowana tylko na ścieżce flagi; brak asercji, że wartość portu z `ask_tty` w `configure_settings` przechodzi walidację (obecnie nie przechodzi żadnej — P2-1). Po naprawie dodać test error-case: wstrzyknięty tty-plik z niepoprawnym portem → exit ≠ 0 / ponowne pytanie.
19. **`scripts/install-vps.test.sh:100`** — braki pokrycia ponad scenariusze planu (wszystkie z planu pokryte): (1) `--port abc` nienumeryczny → exit ≠ 0 (nowy regex L129–131 bez error-case — reguła „nowa funkcja = happy + error case"), (2) `--only-puls`/`--no-obsidian`/`--no-auto-update`/`--tz`/`--device-name` — żaden happy path ustawiania zmiennych nietestowany, (3) ścieżka `run_login`: odpowiedź `n` na „Spróbować ponownie? [T/n]" → `halt_leave_partial` przed wyczerpaniem prób (L230–232, odrębna gałąź bez pokrycia). *(scalono duplikat :86)*

---

## 🧑‍🔧 Findingi OPERATOR (niewykonalne headless — checklist, nie fix)

1. **`scripts/install-vps.sh:791`** — weryfikacja realnych granic bezpieczeństwa fazy (ufw DENY faktycznie blokuje port z internetu, dashboard wyłącznie przez Tailscale, Funnel wystawia tylko `/webhook/*`, unit startuje jako user `claude`) wymaga prawdziwego przebiegu `curl | sudo bash` na czystym VPS Debian/Ubuntu z kontem Tailscale. Testy jednostkowe pokrywają tylko szkielet.
2. **`scripts/install-vps.sh:362`** — handoff `su - claude -c "claude" < $TTY_DEVICE` (mechanizm R2/R7, decyzja #17) niemożliwy do weryfikacji headless — plan oznacza granicę `su` + `/dev/tty` pod prawdziwym pipe jako odroczoną: spike w Docker/multipass PRZED rozpięciem na 5 loginów (przed Fazą 4).
3. **`scripts/install-vps.sh:142`** — zachowanie `ask_tty`/`run_login`/handoffu pod prawdziwym `curl|sudo bash` (stdin=pipe, realny `/dev/tty`, granica su/PAM na Ubuntu) niewykonalne headless na macOS — harness symuluje tty plikiem. Pokryte Operator gate; pozycja otwarta, do wykonania przed merge.

---

## Zgodność ze spec

Oś Spec trzymana osobno od osi Standards (nie scalać):

- **P2-3 (`:201`)** — złamany R6 spec-u: komunikat resume po leave-partial nie działa w podstawowym trybie dostarczenia R2 (`curl | sudo bash`).
- **P2-4 (`:252`)** — deklaracja planu „egzekwowany testem grep (IU1)" niezrealizowana w harnessie (weryfikacja tylko ręczna).
- **P3-17 (`:87`)** — `usage()` obiecuje zachowania odroczone do IU2/późniejszych faz (`--tz` autodetekcja, `--device-name` no-op) — rozjazd help vs implementacja, świadome odroczenie z decyzji #14, ale nieoznaczone w helpie.
- **P3-10 (`:791`)** — `--reset` odwrócona semantyka do czasu IU7 (świadome odroczenie, decyzja 14).
- Poza powyższymi: scope fazy 1 (restrukturyzacja, flagi, ask_tty, run_login, rollback-stos, env-override, PL komunikaty, harness) zrealizowany zgodnie z planem — wszystkie scenariusze testowe z planu pokryte (14/14 PASS).

## Wyniki E2E

Brak scenariuszy E2E browser w tej fazie (instalator CLI, brak UI). passed: 0, failed: 0, skipped: 0.

## Bookkeeping checkboxów Weryfikacja:

- Odznaczone automatycznie (CLI/grep): 3
- Odznaczone na podstawie Agent 5 E2E: 0
- Pozostawione dla operatora (Manual): 0
- Niejasne (P3): 0
- Failujące (P2): 0

### Szczegóły

- [x] CLI: `bash -n scripts/install-vps.sh` — zero błędów składni → PASS (exit 0)
- [x] CLI: `bash scripts/install-vps.test.sh` — wszystkie asercje PASS → PASS (14 PASS / 14 total, exit 0)
- [x] Grep: `grep -n 'read -r' scripts/install-vps.sh` poza definicją `ask_tty` zwraca 0 linii → PASS (jedyne trafienie: L149 wewnątrz `ask_tty`, definicja L142–155)

Bookkeeping nie dodał nowych P2/P3 — severity gate bez zmian: **⚠️ ZASTRZEŻENIA (4 × P2)**.

## Liczniki końcowe

- P1: 0
- P2: 4 (KOD/TEST)
- P3: 19 (KOD/TEST)
- OPERATOR: 3 (poza fix — Operator checklist faza 1 w pliku zadań)
