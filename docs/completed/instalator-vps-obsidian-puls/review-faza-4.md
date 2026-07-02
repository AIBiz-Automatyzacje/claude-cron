# Code Review — Faza 4: Blok 5 loginów (IU4)

Data: 2026-07-02
Zakres: `scripts/install-vps.sh` (helpery `run_verify`, `run_login`, `login_cmd_as_claude`, `print_pause_header`, funkcje `login_claude_cli`, `login_gh`, `validate_repo_access`, `login_ob`, `login_ob_sync`, `login_tailscale`, `login_block`, redukcja `setup_tailscale`), `scripts/install-vps.test.sh` (testy 36–41).
Findings po adversarial verify + dedup (scribe). Duplikaty scalone: brak testu dwuwarstwowego `%q` ×2 → P2-1; spike/manual operatora ×6 → OP-1; magic string `userdel -r` ×2 → P3 poz. 8; połknięty stderr `gh auth setup-git` ×2 → P3 poz. 13; nity `run_verify` ×3 → P3 poz. 6.

## Statystyki

- 🔴 P1 (blocking, KOD/TEST/E2E): **0**
- 🟠 P2 (important, KOD/TEST/E2E): **1**
- 🟡 P3 (nit, KOD/TEST/E2E): **18** (14 KOD + 4 TEST)
- 📋 OPERATOR (poza fix, do checklisty): **1** (P1, scalony z 6 zgłoszeń)
- 🌐 E2E: 0 passed / 0 failed / 0 skipped (faza bez scenariuszy browser E2E — instalator CLI)
- ☑️ Weryfikacja: 2 auto PASS (CLI + grep) / 1 manual (operator)

**Severity gate: ⚠️ KONTYNUUJ Z ZASTRZEŻENIAMI — 1 problem P2 do naprawy.**
(P1 istnieje wyłącznie w osi OPERATOR — nie blokuje gate'u, ale blokuje uznanie R2/R6 za zweryfikowane przed merge.)

---

## 🟠 P2 (important)

### P2-1 [TEST] `scripts/install-vps.test.sh:994` (kod: `scripts/install-vps.sh:403–405`) — dwuwarstwowe escapowanie `%q` na granicy user-input→shell bez ŻADNEGO testu jednostkowego

Jedyna injection-krytyczna konstrukcja fazy: wewnętrzny `printf %q` dla wartości usera (OB_EMAIL w `login_ob`, VAULT_NAME/DEVICE_NAME w `login_ob_sync`, VAULT_GIT_REPO w `validate_repo_access`) + zewnętrzny `%q` całej komendy w `login_cmd_as_claude` — dwa poziomy parsowania: `bash -c` → `su -c`. Realny łańcuch quotowania nigdy nie jest asertowany: testy 37/38/41 stubują `run_login`/`run_as_claude`, test 40 stubuje samo `login_cmd_as_claude`, i sprawdzają wyłącznie fakt/nazwy wywołań grepem. Regresja typu usunięcie jednego `%q` (wewnętrznego w `login_ob`/`login_ob_sync` albo zewnętrznego w `login_cmd_as_claude`) lub zamiana printf na konkatenację przechodzi 46/46 PASS, a `VAULT_NAME='Moj Vault; rm -rf ~'` albo email z `$(...)` wykona się w shellu usera claude. To ta sama klasa luki co P2-2 z review fazy 3 (nowe funkcje bez unit-testów) — na granicy user-input→shell (odpowiednik walidacji na granicy systemu).

**Fix:** test jednostkowy `login_cmd_as_claude` — dla wartości ze spacją, apostrofem (np. `VAULT_NAME="O'Brien Vault"`), średnikiem i `$()` wynik po dwukrotnym sparsowaniu shellem (`bash -c "$(...)"` z atrapą `su`) oddaje oryginał; analogicznie asercja treści komendy budowanej przez `login_ob`/`login_ob_sync`/`validate_repo_access` (inner `%q`).

---

## 🟡 P3 (nit)

### KOD

1. **`scripts/install-vps.sh:380`** — fallback `run_login` bez TTY: `bash -c "$login_cmd" || true` dziedziczy stdin-pipe `curl|sudo bash` — interaktywny proces logowania (claude/gh/ob) może skonsumować dalsze bajty skryptu ze stdin (udokumentowana pułapka projektu w `docs/solutions`), po czym parent bash czyta uszkodzony strumień. Forma pre-existing z fazy 1, ale faza 4 przepuszcza przez nią 5 pauz — ekspozycja rośnie. W praktyce headless-bez-tty i tak kończy się `halt_leave_partial` po 3 próbach, więc skutek ograniczony. Rozważyć jawny skip pauzy (warn + halt) zamiast odpalania interaktywnego loginu bez klawiatury.
2. **`scripts/install-vps.sh:803`** — `validate_repo_access` odpala `gh repo view` (auth na github.com), ale `normalize_repo` (faza 2) akceptuje dowolny host https (`^https://[A-Za-z0-9.-]+/...`). Kursant z `https://gitlab.com/user/repo` dostaje 3× mylący komunikat „konto gh nie ma uprawnień" i halt, zamiast informacji, że instalator wspiera tylko GitHub. Zawęzić regex do github.com albo dodać dedykowany komunikat.
3. **`scripts/install-vps.sh:764`** — weryfikacja PAUZY 1 przez `has_claude_auth` = `test -s ~/.claude/.credentials.json` — niepusty plik nie dowodzi ważnego logowania (przerwany/wygasły OAuth zostawia niepusty plik). Instalator uzna login za udany, a joby padną dopiero w nocy na VPS. Świadoma, udokumentowana decyzja 28 (probe `claude -p` kosztuje tokeny) — akceptowalny tradeoff, ale ryzyko false-positive nie jest komunikowane kursantowi; wystarczy zdanie w podsumowaniu „jeśli logowanie Claude przerwałeś w połowie, uruchom instalator ponownie".
4. **`scripts/install-vps.sh:428`** — guardy `has_*` spawnują po 1–2 pełne login-shelle `su -` i są wołane do 3× w jednym runie (preflight `print_state_line` + guard pauzy + verify w `run_login`); `has_ob_auth` dodatkowo robi probe sieciowy `ob login </dev/null` przy każdym wywołaniu. Odpowiednik N+1, ale na one-shot instalatorze koszt to ułamki sekundy — brak cache guardów jest prostszy i bezpieczniejszy (stan zmienia się między preflightem a pauzą). Informacyjny, bez rekomendacji zmiany.
5. **`scripts/install-vps.sh:787`** — `login_gh` wykonuje `gh auth setup-git` + `validate_repo_access` (sieciowe `gh repo view`) przy KAŻDYM re-runie, także przy pełnym resume (celowe, udokumentowane — poprzedni run mógł paść między loginem a setup-git). Koszt: 1 round-trip sieciowy per run; skutek uboczny: resume przy niedostępnym GitHubie zatrzyma się (3 próby → `halt_leave_partial`) mimo wcześniejszej udanej walidacji. Akceptowalne — dalsze kroki (clone) i tak wymagają sieci. Informacyjny.
6. **`scripts/install-vps.sh:356–364`** — `run_verify` (scalone z 3 zgłoszeń): (a) gałąź `bash -c "$1"` jest dziś nieosiągalna w produkcji — wszystkie 5 pauz przekazuje gołe nazwy `has_*`, dispatcher zawsze idzie ścieżką `declare -F` (generyczność na zapas, koszt zerowy, komentarz uzasadnia projekt — trap ERR + eval na bash 3.2); (b) kontrakt dispatchu jest niejawny i dwuznaczny: goła nazwa funkcji → wywołanie wprost BEZ argumentów, inny string → child bash BEZ dostępu do funkcji instalatora — verify-string typu `'has_ob_auth && has_ob_sync'` cicho zawsze sfailuje → 3 próby → halt z komunikatem sugerującym problem logowania; (c) literówka w nazwie guardu (np. `has_claud_auth`) daje w child bashu „command not found" (rc 127) nieodróżnialny od negatywnej weryfikacji — mylący 3× fail zamiast głośnego błędu instalatora. Fix: dopisać kontrakt do komentarza (dla Unit 5/6) + w gałęzi `bash -c` traktować rc 127 jako twardy błąd instalatora, nie fail weryfikacji.
7. **`scripts/install-vps.sh:777`** — `login_gh` łamie jednolity kontrakt pauzy (SRP): jako jedyna z 5 funkcji `login_*` wykonuje poza pauzą także kroki automatyczne (`gh auth setup-git` + `validate_repo_access`). Uzasadnienie resume-safety słuszne, ale to samo osiąga się wywołaniem tych kroków na poziomie `login_block` PO `login_gh` — wtedy `login_block` pozostaje kompletną mapą kroków bloku (dziś dopowiada je komentarz „PAUZA 2 (+ setup-git + walidacja repo)"), a funkcje `login_*` mają jednorodną odpowiedzialność guard+pauza.
8. **`scripts/install-vps.sh:730`** — magic string `"userdel -r $CLAUDE_USER"` zduplikowany: `push_rollback` w `ensure_claude_user` (L651) i `drop_rollback` w `login_block` (L730); `drop_rollback` dopasowuje dokładny string, więc dywergencja (np. zmiana cytowania/flaga po jednej stronie) = cichy no-op dropu i powrót regresji P2-1 z review fazy 3 (rollback kasuje credentiale OAuth). Test 36 łapie regresję behawioralnie (używa realnych obu funkcji), ale wspólna stała / helper (np. `userdel_rollback_cmd()`) usunęłaby sprzężenie strukturalnie u źródła.
9. **`scripts/install-vps.sh:798`** — `validate_repo_access` łamie command-query separation: nazwa mówi „walidacja", a funkcja przy retry MUTUJE globalny config `VAULT_GIT_REPO` (`ask_valid` + `normalize_repo`), z którego korzysta później Unit 5 (clone). Zachowanie wymagane przez R5 (retry-in-place) i udokumentowane komentarzem, ale nazwa nie sygnalizuje efektu ubocznego — czytelniej `ensure_repo_access` lub jawny komentarz przy wywołaniu w `login_gh`.
10. **`scripts/install-vps.sh:403`** — deklaracja „JEDYNE miejsce z formą `su - … -c`" w `login_cmd_as_claude` jest prawdziwa tylko z kwalifikatorem „dla loginów": identyczny literał ma `run_as_claude` (L416, przez który biegną WERYFIKACJE tych samych pauz), oraz gołe `su -` w `clone_repo`/`setup_puls_dependencies`/cronie (L867/874/884/1260 — pre-existing P3-10 z review f3, w fazie 4 nieujednolicone). Jeśli spike wykaże problem z `su` także poza interaktywnym tty, zmiana NIE jest jednopunktowa. Doprecyzować komentarz albo przy Unit 5 domknąć ujednolicenie na `run_as_claude`.
11. **`scripts/install-vps.sh:767`** — sztywna numeracja „KROK n/5" w `print_pause_header` rozjeżdża się z trybem `--only-puls`: kursant widzi KROK 1/5 → 2/5 → 5/5 (pauzy 3–4 pominięte), co sugeruje błędny przeskok. Numeracja względem aktywnych pauz albo etykiety bez mianownika („KROK: Logowanie…").
12. **`scripts/install-vps.sh:1120`** — `setup_tailscale` po redukcji w tej fazie tylko odczytuje TS_IP do podsumowania (`tailscale up` przeniesione do `login_tailscale`) — nazwa „setup" łamie 5-sekundową regułę i sugeruje konfigurację, której już tu nie ma. Czytelniej `read_tailscale_ip` (+ aktualizacja wywołania w `main`); zniknęłaby też potrzeba komentarza tłumaczącego rozjazd nazwy z zachowaniem.
13. **`scripts/install-vps.sh:787`** — `run_as_claude "gh auth setup-git" &>/dev/null || halt_leave_partial …` połyka stderr gh — jedyny krok bloku loginów bez żadnej diagnostyki: przy padzie (np. stary gh z apt Ubuntu — ryzyko jawnie wymienione w planie, sekcja Ryzyka; brak scope; uszkodzony config) kursant dostaje tylko generyczny komunikat leave-partial bez przyczyny. Kontrast z resztą pauz, gdzie `run_login` pokazuje output narzędzia; spec (FAZA 3, krok ⚙ setup-git) nie wymaga ciszy. Fix: zostawić stderr widoczny albo zalogować go przed haltem.
14. **`scripts/install-vps.sh:28`** — komunikat leave-partial (`halt_leave_partial` L347) obiecuje per R6 „wklej ponownie tę samą komendę", ale wypisywany `RESUME_ONE_LINER` to zawsze pełny tryb z gałęzi main — nie odzwierciedla flag (`--only-puls`/`--no-obsidian`, brak `bash -s --`) ani env-override `CLAUDE_CRON_REPO`/`REF`. User `--only-puls`, który wklei wypisaną komendę, dostanie przy resume pytania i pauzy Obsidianowe wbrew swojej konfiguracji. Stała pre-existing (fix po review fazy 1), ale dopiero ta faza czyni ją widoczną w realnym flow — naprawić albo zgłosić do IU7 (README/runbook).

### TEST

15. **`scripts/install-vps.test.sh:954`** — brak testu warunku brzegowego/error-case `validate_repo_access`: wyczerpanie 3 prób (repo w kółko niedostępne / `gh repo view` stale fail) → `halt_leave_partial` (install-vps.sh:816) z exit ≠ 0 i nietkniętym rollback-stosem. Test 39 pokrywa wyłącznie ścieżkę sukcesu za 2. podejściem; boundary `LOGIN_MAX_ATTEMPTS` dla tej nowej funkcji fazy 4 niezweryfikowany (reguła: każda nowa funkcja = happy path + error case).
16. **`scripts/install-vps.test.sh:897`** — quoting przez `printf %q` w komendach loginów nie jest nigdzie asertowany — testy 37–41 stubują `run_login`/`run_as_claude` i sprawdzają tylko fakt wywołania, nie treść zbudowanej komendy; nowe helpery `run_verify` i `login_cmd_as_claude` nie mają też bezpośrednich testów jednostkowych (pokrycie wyłącznie pośrednie). Częściowo pokryte przez P2-1 — unikalna reszta po fixie P2-1: bezpośrednie happy/error testy `run_verify` (dispatch funkcja vs string).
17. **`scripts/install-vps.sh:787`** — nietestowana ścieżka błędu w `login_gh`: `gh auth setup-git` fail → `halt_leave_partial` (L787–788). Test 38 stubuje `run_as_claude` na bezwarunkowy sukces, więc nowa gałąź halt przy padzie setup-git (także w scenariuszu resume) nie ma asercji. Mitygacja: sam `halt_leave_partial` jest dobrze pokryty testami 11/19/40.
18. **`scripts/install-vps.sh:390`** — nietestowana gałąź rezygnacji usera w `run_login`: odpowiedź `n` na „Spróbować ponownie? [T/n]" → `halt_leave_partial` przed wyczerpaniem prób. Harness działa bez tty (`ask_tty` zwraca default `T`), więc testy 10/11 pokrywają tylko retry-do-skutku i 3× fail; wstrzyknięty fake-tty z `n` (wzorzec testu 9) zamknąłby lukę.

---

## 📋 OPERATOR (poza fix — warunki środowiskowe)

### OP-1 [P1] Otwarty spike-GATE su+/dev/tty + [Manual] pełny blok 5 loginów na czystym VPS

(scalony z 6 zgłoszeń: `scripts/install-vps.sh:378` P1, `scripts/install-vps.sh:404` P2, plan L275 P2 ×2, `scripts/install-vps.sh:766` P3, plan L275 P3)

Mechanizm krytyczny całej fazy — handoff klawiatury `bash -c "su - claude -c <cli>" < /dev/tty` pod prawdziwym pipe `curl|sudo bash` (`run_login` L377–378 + `login_cmd_as_claude` L403–405) — jest zweryfikowany wyłącznie stubami. Jeśli su/PAM nie przekaże tty, wszystkie 5 pauz loginowych pada. Otwarte pozycje (jawnie odroczone w planie L275 i kontekście, GATE z IU4):

1. **Spike** `su - claude -c "claude" < /dev/tty` pod prawdziwym pipe (Docker/multipass Ubuntu) — rozstrzyga formę redirectu przez granicę su (alternatywy: `runuser`/`sudo -u`). Architektura przygotowana na wynik jednopunktowo (redirect w `run_login`, forma su w `login_cmd_as_claude` — potwierdzone grepem w tym review; zastrzeżenie: P3 poz. 10 — gołe `su` poza loginami).
2. **[Manual] pełny blok 5 loginów** na czystym VPS przez prawdziwy `curl|sudo bash`: OAuth Claude w przeglądarce, gh device flow, `ob login` z 2FA i hasłem E2E, `ob sync-setup`, `tailscale up`; retry po literówce hasła ob, 3× fail → komunikat resume, re-run wskakuje w brakujący login. Przy okazji: realna latencja probe'ów sieciowych guardów (`ob login </dev/null`, `gh auth status`, `gh repo view`).

Niewykonalne headless — wymaga realnego VPS i przeglądarki po stronie operatora. Wynik spike'a musi zapaść **przed uznaniem R2/R6 za zweryfikowane** (przed merge).

---

## Zgodność ze spec

- Wszystkie pozycje IU4 zaimplementowane: 5 pauz za guardami, `disable_rollback`/`enable_rollback` na granicach bloku, `drop_rollback "userdel -r"` (fix P2-1 f3), retry-in-place walidacji repo (R5), pauzy 3–4 pomijane przy `--only-puls`; scenariusze [Unit] planu pokryte testami 36–41 (46/46 PASS).
- GATE spike'a su+/dev/tty świadomie otwarty (plan L275) — zaimplementowano wg decyzji 17 z jednopunktowym szwem zmiany; weryfikacja → OP-1.
- Probe `claude -p` odrzucony na rzecz `test -s credentials.json` — rozstrzygnięcie formy odroczonej w planie, udokumentowane komentarzem (decyzja 28) → P3 poz. 3 (komunikacja ryzyka), nie brak spec-compliance.
- Brak scope creep wykrytego po weryfikacji.

## Bookkeeping checkboxów Weryfikacja:

- Odznaczone automatycznie (CLI/grep): 2
- Odznaczone na podstawie Agent 5 E2E: 0
- Pozostawione dla operatora (Manual): 1
- Niejasne (P3): 0
- Failujące (P2): 0

### Szczegóły

- [x] CLI: `bash scripts/install-vps.test.sh — asercje sekwencji/guardów/retry PASS` → PASS (komenda: `bash scripts/install-vps.test.sh`, wynik: 46 PASS / 46 total, exit 0)
- [x] Grep: `grep -n 'su - .*-c' scripts/install-vps.sh — każda linia z interaktywnym CLI zawiera /dev/tty` → PASS z adnotacją: żadna linia z interaktywnym CLI nie woła `su` bez handoffu tty — redirect jest scentralizowany w `run_login` (`< "$TTY_DEVICE"`, L377–378), a wszystkie pauzy budują komendę przez `login_cmd_as_claude`; pozostałe trafienia grepa (L416, 867, 874, 884, 1260, 1299) to ścieżki NIEinteraktywne (weryfikacje guardów, clone, npm, cron, echo podsumowania)
- [ ] Manual: `Test: [Manual] pełny blok 5 loginów na czystym VPS przez prawdziwy pipe` — wymaga operatora (przeniesione do „Operator checklist faza 4", pokrywa OP-1 pkt 2)

## Severity gate (po bookkeepingu)

Bookkeeping nie dodał nowych P2/P3 (oba automaty PASS).

**⚠️ KONTYNUUJ Z ZASTRZEŻENIAMI — 1 problem P2 do naprawy (P2-1: brak testu jednostkowego dwuwarstwowego `%q` na granicy user-input→shell). Osobno: OP-1 [P1 OPERATOR] — spike su+/dev/tty i manualny przebieg bloku loginów muszą zostać wykonane przez operatora przed merge (nie blokują kontynuacji faz 5–7).**
