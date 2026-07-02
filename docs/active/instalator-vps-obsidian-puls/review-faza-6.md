# Code Review — Faza 6: Sieć + finał (IU6)

Data: 2026-07-02
Zakres: `scripts/install-vps.sh` (funkcje `parse_funnel_url`, `add_webhook_env_line`, `set_service_webhook_env`, `setup_funnel`, `build_cron_cmd`, `write_update_sudoers`, `write_cron_node_guard`, `install_update_cron`, `setup_auto_update`, `check_service_active`, `is_sync_complete`, `wait_for_first_sync`, `verify_services`, `build_welcome_note`, `create_welcome_note`, `print_summary`, sekwencja finału w `main()`), `scripts/install-vps.test.sh` (testy 52–58, harness 78 asercji).
Findings po adversarial verify + dedup (scribe). Duplikaty scalone: niegardowany `systemctl restart` w `set_service_webhook_env` pod trap ERR ×3 → P2-1; brak testu idempotencji `install_update_cron` ×2 (P2+P3, ta sama linia) → P2-3; substring-match `incomplete`/`not synced` w `is_sync_complete` ×4 (sh:1517/1530/1531 ×2) → P3 poz. 1; walidacja ręcznego `WEBHOOK_BASE_URL` ×3 (sh:1371) → P3 poz. 2; dedup crontaba po substringu `$SERVICE_NAME` ×3 (sh:1487) → P3 poz. 3; cichy no-op `add_webhook_env_line` bez `SyslogIdentifier` ×2 (sh:1318/1319) → P3 poz. 9; scenariusz [Manual] IU6 ×2 (zadania:161 + plan:353) → OP-2; nieudokumentowane formaty wyjść `tailscale funnel status`/`ob sync-status` ×2 (sh:1310) → OP-3.

## Statystyki

- 🔴 P1 (blocking, KOD/TEST/E2E): **0**
- 🟠 P2 (important, KOD/TEST/E2E): **3** (1 KOD + 2 TEST)
- 🟡 P3 (nit, KOD/TEST/E2E): **14** (10 KOD + 4 TEST)
- 📋 OPERATOR (poza fix, do checklisty): **3** (2 × P2 + 1 × P3, scalone z 5 zgłoszeń)
- 🌐 E2E: 0 passed / 0 failed / 0 skipped (faza bez scenariuszy browser E2E — instalator CLI)
- ☑️ Weryfikacja: 2 auto PASS (harness CLI + grep) / 1 manual (operator)

**Severity gate: ⚠️ KONTYNUUJ Z ZASTRZEŻENIAMI — 3 problemy P2 do naprawy.**

---

## 🟠 P2 (important)

### P2-1 [KOD] `scripts/install-vps.sh:1332` — `set_service_webhook_env`: niegardowany `systemctl daemon-reload`/`restart` pod trap ERR na SAMYM KOŃCU przebiegu — pad restartu odwija rollback działającej instalacji

`set_service_webhook_env` wykonuje `systemctl daemon-reload` i `systemctl restart` bez żadnego guardu pod `set -Eeuo pipefail` + `trap on_err ERR`. Scenariusz: kursant odpowiada T na Funnel NA SAMYM KOŃCU przebiegu, restart serwisu pada (serwer nie wstaje w oknie systemd, chwilowo zajęty port, śmieciowy URL z fallbacku `ask_tty` w `Environment=`) → trap ERR odwija CAŁY stos rollbacku: unit-pliki obu serwisów z tego runu, sudoers, cron auto-update — niszcząc w pełni działającą, zweryfikowaną instalację sekundę po komunikacie „wszystko działa". To wprost sprzeczne z konwencją ustanowioną w TEJ SAMEJ fazie dla `verify_services`/`create_welcome_note` (komentarze: „ERR odwinąłby rollback działającej instalacji" → warn, nie fail) i ze spec „Właściwości przekrojowe" (rollback ma sens, gdy pad = zepsuty stan; tu stan działa, plik-dowód już dotarł). Dodatkowo zapis unitu jest nieatomowy (`printf '%s\n' "$updated" > "$service_file"` bez temp+mv) — pad w połowie zapisu zostawia okaleczony unit.

**Fix:** blok Funnela w konwencji warn-not-fail — `if ! systemctl restart "$SERVICE_NAME"; then warn … (instrukcja ręcznego restartu, jak `check_service_active`); fi` — albo `disable_rollback` wokół `setup_funnel`; zapis unitu przez temp+`mv` (atomowość).

### P2-2 [TEST] `scripts/install-vps.test.sh:1634` — wygenerowany `cron-node-guard.sh` nigdy nie jest WYKONYWANY — logika brzegowa guardu nieprzetestowana behawioralnie

Asercje testu to wyłącznie grep treści skryptu (`MIN_NODE_MAJOR=22`, `MIN_NODE_MINOR=13`) — test „kształtu", który przejdzie nawet gdy porównanie major/minor się zepsuje (np. odwrócony warunek `-ge`/`-gt`). Nieprzetestowane granice (install-vps.sh:1444–1464): Node 22.12 → exit 1, 22.13 → exit 0, 24.x → exit 0, 25.0 → exit 1 (granica wykluczająca MAX), brak node / puste `node -v` → exit 1. Guard jest samodzielnym skryptem w sandboxie — wystarczy stub `node() { echo v22.12.0; }` (PATH-shim w sandboxie) i uruchomienie pliku. Regresja = nocny restart serwisu na niekompatybilnym Node → pad wszystkich jobów, czyli dokładnie scenariusz, przed którym guard ma chronić.

**Fix:** testy behawioralne uruchamiające wygenerowany skrypt z atrapą `node` w PATH dla 5 przypadków brzegowych (22.12 / 22.13 / 24.x / 25.0 / brak node).

### P2-3 [TEST] `scripts/install-vps.test.sh:1594` — brak testu idempotencji `install_update_cron` (re-run = rdzeniowy kontrakt instalatora)

Mapa fazy deklaruje „dedup po SERVICE_NAME, rollback crontaba" jako deliverable, ale test 53 uruchamia `setup_auto_update` tylko RAZ na pustym cronfile. Nieprzetestowane: (1) re-run → dokładnie jedna linia Pulsa w crontabie (dedup `grep -v`), (2) cudze wpisy crontaba roota zachowane po re-runie, (3) rollback crontaba rejestrowany TYLKO gdy wpisu nie było przed runem (wpis sprzed runa = cudzy stan, rollback nie może go skasować — kontrakt „nigdy cudzego stanu"). Analogiczny wzorzec re-run + brak duplikatu jest testowany dla unitu Funnela (test 56, `env_count=1`), ale nie dla crontaba. Regresja dedupu = zdublowane nocne update'y lub skasowanie cudzych cronów roota.

**Fix:** test re-run `install_update_cron` z atrapą `crontab` (cronfile z cudzym wpisem + wpisem Pulsa): po 2 runach 1 linia Pulsa, cudzy wpis nietknięty, rollback nierejestrowany gdy wpis istniał.

---

## 🟡 P3 (nit)

### KOD

1. **`scripts/install-vps.sh:1531`** — `is_sync_complete` matchuje substring bez granic słowa: `grep -qiE 'synced|up.to.date|complete'` daje sukces także dla „sync incomplete" i „not synced yet" (potwierdzone empirycznie). Komentarz deklaruje odporność na stany w toku („'syncing' celowo NIE matchuje"), ale „incomplete"/„not synced" to dokładnie takie stany i przechodzą jako sukces — `wait_for_first_sync` ogłasza „Pierwszy sync zakończony" przy niezakończonym/nieudanym syncu (fałszywy pozytyw w bramce R11: kursant słyszy „działa", notatka-dowód nie dojdzie na telefon). Fix: negatywny lookahead niedostępny w ERE, ale wystarczy `(^|[^a-z])(synced|up.to.date|complete)` albo jawny filtr negatywny `grep -qivE 'incomplete|not.synced'` przed matchem pozytywnym; do testu 57 dodać przypadki adversarialne (scalone ×4).
2. **`scripts/install-vps.sh:1371`** — ręcznie wpisany przez `ask_tty` `WEBHOOK_BASE_URL` trafia do unitu systemd (`set_service_webhook_env` → `add_webhook_env_line`) bez ŻADNEJ walidacji granicy inputu: brak wymogu prefiksu `https://`, brak przycięcia końcowego slasha (`parse_funnel_url` go przycina — niespójność daje podwójny slash w URL webhooków), spacja rozbija `Environment=` na dwa przypisania, backslashe interpretuje `awk -v` (escape processing). Znany P3 z backlogu fazy 1 („sed-insert WEBHOOK_BASE_URL bez walidacji") — faza 6 przepisała ten kod nie domykając walidacji; w połączeniu z P2-1 śmieciowy URL może eskalować do rollbacku całej instalacji. Fix: walidator `^https://[^[:space:]]+$` + `sed 's|/$||'` z retry (wzorzec `ask_valid` z fazy 2) (scalone ×3).
3. **`scripts/install-vps.sh:1487`** — dedup i rollback crontaba (L1484) filtrują po gołym substringu `$SERVICE_NAME` („claude-cron"): `grep -v "$SERVICE_NAME"` kasuje KAŻDĄ linię crontaba roota zawierającą ten substring — także cudzy wpis operatora typu `0 3 * * * tar czf /backup/claude-cron.tgz …` czy odwołanie do `/home/claude/claude-cron/scripts/backup.sh`. Wzorzec odziedziczony („jak dziś"), ale funkcja przepisana w tej fazie, a filtr dodany też do akcji rollbacku — blast radius rośnie. Fix: match po unikalnym markerze (komentarz-tag `# claude-cron-auto-update` na końcu linii) albo po pełnej sygnaturze komendy (`guard_script`) (scalone ×3).
4. **`scripts/install-vps.sh:1408`** — `write_update_sudoers` nadaje userowi claude NOPASSWD `systemctl restart claude-cron`, ale żaden element łańcucha auto-update z tego nie korzysta — cron roota restartuje serwis bezpośrednio jako root, `print_summary` też nie instruuje `sudo systemctl`. Nieużywany grant dla konta, na którym działa agent AI z `--dangerously-skip-permissions` (może passwordless restartować serwis = ubijać własne joby) — narusza minimum privileges. Spec mówi „sudoers NOPASSWD (jak dziś)", więc świadoma decyzja do podjęcia: usunąć grant albo udokumentować realne użycie.
5. **`scripts/install-vps.sh:1539`** — pętla `wait_for_first_sync` ma wzorzec check→sleep→exit: po ostatnim nieudanym odpytaniu wykonuje jeszcze jeden zbędny `sleep 5` przed warn (user czeka ~95 s zamiast 90), ostatnie realne sprawdzenie pada w ~85. sekundzie okna (sync kończący się w ostatnich 5 s nigdy nie zostanie wykryty), a `waited` liczy tylko sleepy, nie czas `su -`+`ob sync-status` — wall-clock przekracza obiecane „do 90 s". Fix: sleep tylko gdy zostało okno (lub sleep→check z finalnym checkiem po pętli).
6. **`scripts/install-vps.sh:1540`** — `wait_for_first_sync` nie odróżnia trwałego błędu komendy (rc≠0 — ob padnięty, zła ścieżka vaulta) od stanu „jeszcze syncuje": przy permanentnym failu pętla odpytuje pełne 90 s (18 kosztownych spawnów login-shella `su -`), warn mylnie sugeruje „duży vault", a przechwycone `status_out` (stderr) jest wyrzucane. Fix: przerwanie po N kolejnych rc≠0 + ostatni output w warn (diagnostyka zamiast martwego czekania).
7. **`scripts/install-vps.sh:1544`** — kohezja `verify_services`: `check_service_active` zawsze kończy się rc=0 (ok/warn bez sygnału zwrotnego), więc `verify_services` odpala `wait_for_first_sync` nawet gdy obsidian-sync jest NIEaktywny — pali pełne okno `SYNC_WAIT_MAX_SECONDS=90` s i kończy mylącym warn „przy dużym vaulcie to normalne", choć sync nie ma prawa się zakończyć. Fix: `check_service_active` zwraca status (bez zmiany semantyki warn-nie-fail), `verify_services` pomija pętlę przy padniętym serwisie.
8. **`scripts/install-vps.sh:1329`** — dwa źródła prawdy dla ścieżki unit-pliku Pulsa: `create_systemd_service` ustawia global `SERVICE_FILE="$SYSTEMD_DIR/${SERVICE_NAME}.service"` (L1216), a `set_service_webhook_env` rekonstruuje tę samą ścieżkę lokalnie. Dziś spójne, ale przyszła zmiana jednego miejsca cicho rozjedzie drugie — wynieść do jednej stałej/funkcji albo konsekwentnie używać globala.
9. **`scripts/install-vps.sh:1318`** — `add_webhook_env_line` bez guardu na unit bez linii `SyslogIdentifier`: `grep -v` usuwa starą linię `WEBHOOK_BASE_URL`, awk nie wstawia nowej (pattern nie matchuje) — funkcja jest cichym no-opem (może wręcz ZGUBIĆ istniejący env), a `set_service_webhook_env` i tak robi daemon-reload+restart i raportuje „ok WEBHOOK_BASE_URL ustawiony". Scenariusz: operator ręcznie zmodyfikował unit / unit ze starszej instalacji nieprzepisany w tym runie → webhooki cicho nie działają mimo komunikatu sukcesu. Ekspozycja niska (unit normalnie przepisywany co run). Fix: post-check `grep -q '^Environment=WEBHOOK_BASE_URL=' <<<"$updated"` → warn/fallback append do `[Service]` (scalone ×2).
10. **`scripts/install-vps.sh:1393`** — `build_cron_cmd` deklarowana w komentarzu jako „czysta funkcja", ale czyta globale `$CLAUDE_USER` i `$SERVICE_NAME` (ukryta zależność; pozostałe argumenty idą jawnie). Dodatkowo `%` w ścieżce to udokumentowane, ale nieguardowane ograniczenie — crontab traktuje `%` jako koniec komendy/newline, więc instalacja z `%` w CLAUDE_HOME/INSTALL_DIR cicho produkuje zepsutą linię crona. Fix: przekazać oba jako parametry + tani fail-fast `case "$vault_git$install_dir" in *%*) fail …` zamiast komentarza.

### TEST

11. **`scripts/install-vps.test.sh:1765`** — test 57 pokrywa tylko happy-path `is_sync_complete` („syncing" vs „synced"/„up to date") — brak asercji negatywnych dla „incomplete"/„not synced" (dziura z P3 poz. 1 przeszłaby niezauważona). Analogicznie brak testu `add_webhook_env_line` dla unitu BEZ `SyslogIdentifier` (ciche zgubienie env, P3 poz. 9). Reguła: każda funkcja = happy path + error case.
12. **`scripts/install-vps.test.sh:1703`** — test 56 (`setup_funnel`) pokrywa tylko N i czysty T. Nieprzetestowane gałęzie fallback (install-vps.sh:1351–1377): (1) `tailscale funnel status` bez URL → `parse_funnel_url` pusty → `ask_tty` pyta o URL ręcznie, (2) user nie podaje URL → warn + return 0 BEZ wywołania `set_service_webhook_env` (asercja: unit bez linii `WEBHOOK_BASE_URL`, zero restartu — regresja mogłaby wpisać pusty `Environment=WEBHOOK_BASE_URL=` do unitu), (3) brak binarki tailscale → warn + skip.
13. **`scripts/install-vps.test.sh:1797`** — `verify_services` testowany wyłącznie ze stubem `systemctl() { return 0; }` (oba serwisy active). Brak error-case dla `check_service_active` (install-vps.sh:1516–1523): serwis nieaktywny → warn z instrukcją journalctl, rc 0, BEZ wyzwolenia trap ERR. Komentarz w kodzie wprost mówi, że fail tutaj odwinąłby rollback działającej instalacji — dokładnie ta ryzykowna ścieżka jest bez testu regresyjnego (np. przypadkowe wyniesienie `systemctl` poza `if` pod `set -e` przeszłoby suite).
14. **`scripts/install-vps.test.sh:1762`** — `wait_for_first_sync` (install-vps.sh:1536–1550): brak testu, gdy `ob sync-status` kończy się rc≠0 (młody pakiet, format/API może się zmieniać — ryzyko wskazane w planie) — pętla ma kontynuować polling zamiast wywalić się pod `set -e`; stub `run_as_claude` w teście zawsze zwraca rc 0. Dodatkowo `is_sync_complete` testuje „syncing"/„synced"/„up to date", ale nie trzeci wzorzec „complete" z regexa (install-vps.sh:1531).

---

## 📋 OPERATOR (poza fix — do checklisty operatora)

### OP-1 [P2] `scripts/install-vps.sh:1530` — heurystyka `is_sync_complete` oparta na niezweryfikowanych stringach wyjścia `ob sync-status`

Regex `synced|up.to.date|complete` pisany pod format jawnie odroczony w planie (komentarz w kodzie to przyznaje). Jeśli realne wyjście `ob` nigdy nie matchuje, KAŻDA instalacja płaci pełny koszt okna: ~90 s + 18 spawnów `su - claude -c 'ob …'` + fałszywy warn „sync jeszcze trwa", mimo że sync dawno się zakończył. Weryfikacja wymaga żywego VPS z kontem Obsidian Sync — niewykonalna headless. **Operator action:** po pierwszym syncu na realnym VPS uruchomić `su - claude -c "ob sync-status --path ~/vault"` i potwierdzić realny string statusu ukończenia; przy odchyleniu poprawić regex PRZED merge.

### OP-2 [P2] `docs/active/instalator-vps-obsidian-puls/instalator-vps-obsidian-puls-zadania.md:161` — scenariusz [Manual] IU6: rdzeń R11 („nagroda na telefonie") + kontrakt Funnela

Rdzeń R11 i kontrakt Funnela weryfikowalne wyłącznie na realnym VPS — testy jednostkowe biegają na atrapach `ob sync-status`/`tailscale funnel status` (format obu wyjść jawnie odroczony w planie, scenariusz [Manual] Unit 6 planu L353 pozostaje niewykonany). Pokrywa jedyne realne E2E fazy 6. **Operator action:** na realnym VPS (Ubuntu, konto Obsidian Sync, tailnet z zatwierdzeniem Funnela w admin console): (1) notatka „Witaj z VPS" dochodzi przez Sync na telefon; (2) Funnel=T → `curl https://<funnel-url>/webhook/test` odpowiada (nie timeout); (3) przy okazji porównać realne wyjścia `ob sync-status` i `tailscale funnel status` z heurystykami `is_sync_complete`/`parse_funnel_url`. Do Operator gate przed mergem (scalone ×2: zadania:161 + plan:353).

### OP-3 [P3] `scripts/install-vps.sh:1310` — `parse_funnel_url` i `is_sync_complete` pisane pod nieudokumentowane formaty wyjść realnych narzędzi

Formaty `tailscale funnel status` i `ob sync-status` (młody pakiet obsidian-headless) nieudokumentowane/odroczone — plan sam odracza potwierdzenie do checklisty operatora. **Operator action:** przy przebiegu z OP-2 sprawdzić, czy pierwszy URL https z `tailscale funnel status` to faktycznie publiczny URL Funnela (a nie np. adres proxy) oraz czy heurystyka synca rozpoznaje realny status zakończenia (scalone ×2).

---

## Zgodność ze spec

- Wszystkie pozycje IU6 zaimplementowane: UFW bez zmian merytorycznych, auto-update ZAWSZE z opt-outem `--no-auto-update` (sudoers + node-guard + cron 02:00, `printf %q` w czystej `build_cron_cmd`, `--only-puls` bez segmentu vault-git), weryfikacja serwisów (`systemctl is-active` ×2 + pętla 90 s `wait_for_first_sync`, timeout = warn), plik-dowód `~/vault/Witaj-z-VPS.md` (pomijany przy `--only-puls`), Funnel NA KOŃCU (T → funnel --bg → URL → wpis do unitu przez przepisanie treści + daemon-reload + restart; N → nic), podsumowanie PL. Scenariusze [Unit] planu pokryte (harness 78/78 PASS, testy 52–58).
- Odchylenia jakościowe od intencji spec-u: konwencja „finał nie odwija rollbacku działającej instalacji" złamana w JEDNYM miejscu — `set_service_webhook_env` (P2-1); heurystyka bramki R11 przepuszcza stany negatywne (P3 poz. 1); walidacja granicy user-input niedomknięta mimo backlogu fazy 1 (P3 poz. 2).
- Scenariusz [Manual] Unit 6 świadomie otwarty → OP-1/OP-2/OP-3 (gate operatora, nie defekt kodu).
- Brak scope creep wykrytego po weryfikacji.

---

## Bookkeeping checkboxów Weryfikacja:

- Odznaczone automatycznie (CLI/grep): 2
- Odznaczone na podstawie Agent 5 E2E: 0
- Pozostawione dla operatora (Manual): 1
- Niejasne (P3): 0
- Failujące (P2): 0

### Szczegóły
- [x] CLI: `bash scripts/install-vps.test.sh — asercje CRON_CMD/podsumowania/pliku-dowodu PASS` → PASS (komenda: `bash scripts/install-vps.test.sh`, wynik 78/78 PASS, w tym testy `build_cron_cmd` / `setup_auto_update` / `build_welcome_note` / `print_summary` / `setup_funnel` / `is_sync_complete` / `wait_for_first_sync` / sekwencji finału `main()`)
- [x] Grep: `grep -n '0 2 \* \* \*' scripts/install-vps.sh — godzina crona 02:00 niezmieniona` → PASS (trafienie: L1401 `printf '0 2 * * * su - %s -c %q && systemctl restart %s\n'`)
- [ ] Manual: `Test: [Manual] telefon: notatka „Witaj z VPS" dochodzi przez Sync; Funnel=T → curl https://<funnel-url>/webhook/test odpowiada` — wymaga operatora (przeniesione do „Operator checklist faza 6", OP-2)

Bookkeeping nie dodał nowych P2/P3 — severity gate bez zmian: **⚠️ KONTYNUUJ Z ZASTRZEŻENIAMI (3 × P2)**.
