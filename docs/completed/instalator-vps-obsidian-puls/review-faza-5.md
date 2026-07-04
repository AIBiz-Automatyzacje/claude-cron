# Code Review — Faza 5: Obsidian + Puls (IU5)

Data: 2026-07-02
Zakres: `scripts/install-vps.sh` (funkcje `configure_obsidian_file_types`, `verify_ob_file_types`, `setup_vault_git`, `link_vault_claude`, `build_obsidian_sync_unit`, `create_obsidian_sync_service`, `build_puls_env_lines`, `create_systemd_service`, kolejność w `main()`), `scripts/install-vps.test.sh` (nowe testy fazy 5, harness 61 asercji).
Findings po adversarial verify + dedup (scribe). Duplikaty scalone: połknięty stderr/rc `ob sync-status` ×3 → P3 poz. 2; rozjazd numeracji testów ×3 (test.sh:1158 ×2 + plan L325) → P3 poz. 16; nadpisanie cudzego unitu bez backupu ×2 (sh:969 + sh:1177) → P3 poz. 7; zbiorczy finding IU5/R13 (sh:915) rozdzielony na P2-2 (origin mismatch) i P3 poz. 1 (sparse-checkout w gałęzi pull); `link_vault_claude` cudzy katalog ×2 (P2+P3) → P2-4; zgłoszenia operatorskie ×7 → OP-1/OP-2/OP-3.

## Statystyki

- 🔴 P1 (blocking, KOD/TEST/E2E): **0**
- 🟠 P2 (important, KOD/TEST/E2E): **4** (4 KOD)
- 🟡 P3 (nit, KOD/TEST/E2E): **16** (11 KOD + 5 TEST)
- 📋 OPERATOR (poza fix, do checklisty): **3** (2 × P2 + 1 × P3, scalone z 7 zgłoszeń)
- 🌐 E2E: 0 passed / 0 failed / 0 skipped (faza bez scenariuszy browser E2E — instalator CLI)
- ☑️ Weryfikacja: 2 auto PASS (harness CLI ×2) / 1 manual (operator)

**Severity gate: ⚠️ KONTYNUUJ Z ZASTRZEŻENIAMI — 4 problemy P2 do naprawy.**

---

## 🟠 P2 (important)

### P2-1 [KOD] `scripts/install-vps.sh:922` — brak post-condition po `setup_vault_git`: sukces instalatora z wiszącym symlinkiem `.claude` (skille nigdy nie docierają)

`git sparse-checkout set .claude` przechodzi nawet gdy repo NIE zawiera katalogu `.claude` (git nie waliduje istnienia ścieżki), a gałąź guardu `.git` → `git pull --ff-only` (L915) nigdy nie ponawia sparse-checkout. Scenariusz A: repo usera bez `.claude` → katalog się nie materializuje, `ln -sfn` (L931) tworzy WISZĄCY symlink, instalator raportuje sukces — skille nigdy nie docierają do vaulta (cichy ubytek, dokładnie klasa błędu, przed którą broni `verify_ob_file_types`). Scenariusz B: run 1 pada między clone a `sparse-checkout set` (vault-git z `.git` zostaje, brak rollbacku dla clone), run 2 idzie ścieżką pull i też kończy z wiszącym symlinkiem.

**Fix:** fail-fast `[ -d "$vault_git/.claude" ] || fail …` na końcu `setup_vault_git` (reguła fail-fast + kontrakt R8). Test z atrapą git tworzącą/nietworzącą `.claude` (patrz P3 poz. 12).

### P2-2 [KOD] `scripts/install-vps.sh:915` — guard re-run `setup_vault_git` nie porównuje origin istniejącego `~/vault-git` z aktualnym `VAULT_GIT_REPO`

Gałąź re-run (`.git` → `git pull --ff-only`) nie sprawdza, czy origin istniejącego `~/vault-git` zgadza się z aktualnym `VAULT_GIT_REPO`. `collect_config` pyta o repo przy każdym pełnym runie, a `validate_repo_access` może je nadpisać w retry — instalator waliduje dostęp do NOWEGO repo, po czym po cichu pulluje STARE i raportuje ok. Skutek bezpieczeństwa: katalog `.claude` (skille wykonywane przez agenta z `--dangerously-skip-permissions`) pochodzi z innego źródła niż operator skonfigurował, bez żadnego ostrzeżenia.

**Fix:** w gałęzi pull porównać `git -C vault-git remote get-url origin` z `VAULT_GIT_REPO` (mismatch → warn/backup + re-clone). Testowalne w harnessie (stub `run_as_claude`).

### P2-3 [KOD] `scripts/install-vps.sh:974` — re-run staleness serwisu obsidian-sync: `systemctl enable --now` nie restartuje działającego serwisu

Przy ponownym uruchomieniu instalatora `configure_obsidian_file_types` aplikuje nowy sync-config (czytany — wg komentarza w kodzie — przy starcie procesu sync), a nadpisany unit-plik dostaje tylko `daemon-reload`, ale działający proces `ob sync` nigdy nie zostaje zrestartowany. Twarda kolejność „sync-config PRZED enable --now" działa tylko przy pierwszym runie; przy re-runie zmiana file-types/ścieżek unitu nie wchodzi w życie (okno bez plików `unsupported` trwa do ręcznego restartu), mimo że instalator raportuje OK. Unit Pulsa robi `systemctl restart` (L1208) — asymetria.

**Fix:** `systemctl restart` gdy serwis już działa (lub zawsze po zapisie unitu). Test re-run z rejestratorem `systemctl` (patrz P3 poz. 14).

### P2-4 [KOD] `scripts/install-vps.sh:931` — `link_vault_claude` bez guardu „cudzego stanu": realny katalog `~/vault/.claude` wywala cały run w rollback

Gdy `~/vault/.claude` istnieje jako REALNY katalog (np. pozostałość po starym obsidian-vps-installer albo ręcznej instalacji wg `docs/plans/archive/MIGRACJA-PULS.md` SEKCJA 10), `ln -sfn` kończy się błędem „cannot overwrite directory" → trap ERR → rollback całego runu (unitów). Sąsiednia `setup_vault_git` obsługuje dokładnie ten przypadek wzorcem backup-mv (katalog bez `.git` → kopia zapasowa) — niespójność wzorca w obrębie tej samej fazy; spec R8 wymaga tylko idempotencji symlinku, ale kontrakt wobec „cudzego stanu" jest niespójny.

**Fix:** przed `ln` guard `[ -d … ] && [ ! -L … ]` → backup mv (jak vault-git), z testem.

---

## 🟡 P3 (nit)

### KOD

1. **`scripts/install-vps.sh:915`** — gałąź re-run `setup_vault_git` (`.git` → `git pull --ff-only`) nie ponawia `git sparse-checkout set .claude`. Jeśli pierwszy run padnie między `git clone --sparse` a `sparse-checkout set` (obie komendy w jednym `run_as_claude` przez `&&`), katalog `.git` już istnieje i każdy kolejny run robi wyłącznie pull — `.claude` nigdy się nie zmaterializuje (IU5/R13: idempotencja = resume). Idempotentny fix: `git sparse-checkout set .claude` także w gałęzi pull (operacja tania, no-op gdy już ustawione). Po fixie P2-1 scenariusz przestaje być cichy, ale resume nadal nie wychodzi z dołka bez tego fixu.
2. **`scripts/install-vps.sh:896`** — `status_out="$(run_as_claude "ob sync-status …" 2>/dev/null || true)"` tłumi zarówno stderr, jak i kod wyjścia sync-status (scalone z 3 zgłoszeń). Gdy sync-status sam pada (wygasła sesja ob, brak vaulta pod `~/vault`, brak sync-setup po leave-partial), user dostaje mylący komunikat „linia File types: nie zawiera unsupported" zamiast prawdziwej przyczyny — narusza regułę „nie suppressuj błędów", diagnostyka fail-fast (R8) traci sygnał źródłowy. Fix: rozróżnić rc != 0 (osobny fail z przechwyconym stderr) od „wyjście OK, ale bez unsupported".
3. **`scripts/install-vps.sh:883`** — `verify_ob_file_types`: substring-match `grep 'File types:.*unsupported'` może dać fałszywy PASS na wyjściu typu `File types: image, audio (unsupported: off)` — a to guard chroniący przed cichym ubytkiem danych (raporty nie-media zostają na VPS). Format wyjścia młodego pakietu obsidian-headless może się zmieniać (skrypt sam to przyznaje w komentarzach guardów exit-code-first). Rozważyć dopasowanie `unsupported` jako elementu listy po `File types:` (granice słowa/przecinki), nie dowolne wystąpienie w linii.
4. **`scripts/install-vps.sh:952`** — unit obsidian-sync: `Restart=always` + `RestartSec=5` bez `StartLimitIntervalSec`/`StartLimitBurst`. Domyślny limiter systemd (5 startów / 10 s) przy RestartSec=5 nigdy się nie aktywuje, więc trwały crash `ob sync` (np. wygasła sesja Obsidian) daje wieczną pętlę restartów co 5 s na VPS 24/7 — stały koszt CPU i zaśmiecanie journala (plus `ExecStartPre rm -rf` przy każdym cyklu), a awaria jest maskowana zamiast widocznego stanu `failed`. Rozważyć np. `StartLimitIntervalSec=300` + `StartLimitBurst=10` albo większy RestartSec.
5. **`scripts/install-vps.sh:951`** — niecytowane interpolacje `$ob_path`/`$vault_path` w liniach ExecStart/ExecStartPre unitu (L950–951): CLAUDE_HOME pochodzi z getent (dowolny home), spacja w ścieżce cicho łamie word-splitting systemd. systemd wspiera cudzysłowy w Exec* — `ExecStart=$ob_path sync --path "$vault_path" --continuous` domyka to bez kosztu. Ten sam wzorzec w unicie Pulsa (L1188) jest pre-existing, ale nowa funkcja mogła być od razu poprawna.
6. **`scripts/install-vps.sh:971`** — `push_rollback` rejestrowany PO zapisie unit-pliku (L969–971, analogicznie L1181–1203 dla Pulsa): jeśli redirect `build_obsidian_sync_unit > "$unit_file"` padnie w połowie (ENOSPC), ERR trap odpala rollback BEZ wpisu dla częściowo utworzonego pliku — zostaje wrak unitu, którego kolejny run uzna za „cudzy" (unit_existed=1) i już nigdy nie zarejestruje do rollbacku. `rm -f` + `daemon-reload` są idempotentne, więc `push_rollback` można bezpiecznie przenieść PRZED zapis.
7. **`scripts/install-vps.sh:969`** (+ analogicznie `create_systemd_service` L1177+) — kontrakt rollbacku chroni tylko przed SKASOWANIEM cudzego unitu, nie przed jego NADPISANIEM: przy `unit_existed=1` istniejący (cudzy/wcześniejszy) plik jest nadpisywany `cat >` w miejscu bez kopii zapasowej — rollback słusznie go nie usuwa (kontrakt per-run), ale oryginalna treść ginie bezpowrotnie; sfailowany re-run z inną konfiguracją (np. inny PORT) zostawia zmodyfikowany unit, którego rollback nie przywróci. Kontrast do wzorca backupu nie-gitowego katalogu w `setup_vault_git` (mv `*.backup.timestamp`). Praktyczne ryzyko małe (kolejny udany run wygeneruje docelową treść) — świadoma luka warta komentarza lub backupu treści przed nadpisaniem.
8. **`scripts/install-vps.sh:960`** — duplikacja wzorca `[ -f unit ] && unit_existed=1 → zapis → warunkowy push_rollback (disable --now + rm + daemon-reload)` w `create_obsidian_sync_service` i `create_systemd_service` — są już 2 użycia (próg abstrakcji wg reguł projektu). Kandydat na helper np. `install_unit_file <nazwa> <treść-na-stdin>`, hermetyzujący kontrakt rollbacku w jednym miejscu; przy trzecim unicie ekstrakcja stanie się obowiązkowa. Zgodnie z filozofią Duplication > Complexity — nie blokuje.
9. **`scripts/install-vps.sh:891`** — magic literal `~/vault` powtórzony 3× w `configure_obsidian_file_types` (sync-config, sync-status, komunikat fail), podczas gdy sąsiednie funkcje fazy używają `"$CLAUDE_HOME/vault"` (`setup_vault_git`, `link_vault_claude`, `create_obsidian_sync_service`). Ścieżka vaulta to de facto stała kontraktowa fazy (spójna też z `has_ob_sync` i WORKSPACE pełnego trybu) — wyciągnięcie do nazwanej zmiennej dałoby jedno źródło prawdy i usunęło rozjazd konwencji w nowym kodzie.
10. **`scripts/install-vps.sh:1164`** — `build_puls_env_lines`/`create_systemd_service`: DISCORD_WEBHOOK_URL (sekret umożliwiający pisanie na kanał Discord) zapisywany w `Environment=` unitu `/etc/systemd/system/claude-cron.service` tworzonego `cat >` jako root z umask 022 → plik world-readable 644 (odczyt też przez `systemctl show -p Environment`). Wpływ praktyczny niski (VPS single-tenant, serwis usera claude i tak dostaje env), wzorzec pre-existing, ale przenoszony w tej fazie do `build_puls_env_lines`. Zalecenie: `EnvironmentFile=` z chmod 600 zamiast inline `Environment=`.
11. **`scripts/install-vps.sh:1164`** — wartość DISCORD_URL nie jest escapowana dla składni `Environment=` systemd: znak `%` to specyfikator systemd (wymaga `%%`), a `"` psuje cytowanie linii. Walidator `is_valid_discord_webhook` (`[^[:space:]]+`) przepuszcza oba znaki, więc taka wartość zostałaby po cichu zniekształcona w env serwisu (powiadomienia Discord przestaną działać bez błędu instalatora). Nit: praktyczne webhooki Discorda to `[A-Za-z0-9_-]`, ale walidator tego nie wymusza — najprościej zawęzić regex walidatora.

### TEST

12. **`scripts/install-vps.test.sh:1279`** — `test_setup_vault_git_guard` stubuje `run_as_claude` w całości (echo do loga) i asertuje wyłącznie TREŚĆ komendy — brak asercji post-condition (istnienie `vault-git/.claude` po „clone"). Regresja z P2-1 (wiszący symlink) jest niewykrywalna tym testem; ta sama klasa co P2-1 z review fazy 4 (dwuwarstwowe stubowanie = test kształtu komendy, nie zachowania). Po dodaniu post-condition w kodzie dopisać test z atrapą git tworzącą/nietworzącą `.claude`.
13. **`scripts/install-vps.test.sh:1201`** — test `configure_obsidian_file_types` asertuje w logu stubu tylko substring `sync-config` (kolejność), ale nigdy nie sprawdza, że do komendy trafia `--file-types …unsupported` — wartość stałej OB_FILE_TYPES jest w 100% zastubowana. Regresja usuwająca `unsupported` ze stałej przejdzie 61/61 (wykryje ją dopiero runtime fail-fast na realnym VPS). Ta sama klasa co P2-1 z review fazy 4. Fix tani: jedna asercja `[[ $(sed -n 1p log) == *'--file-types'*'unsupported'* ]]`.
14. **`scripts/install-vps.test.sh:1155`** — brak testu re-run dla `create_obsidian_sync_service` z już istniejącym unitem i aktywnym serwisem: test 61 pokrywa warunkowy rollback, ale żaden test nie asertuje, że po nadpisaniu unit-pliku działający serwis zostaje zrestartowany (scenariusz z P2-3). Rejestrator wywołań `systemctl` w sandboxie (wzorzec już używany w harnessie) wykryłby tę regresję.
15. **`scripts/install-vps.test.sh:1356`** — brak testu error-case dla `create_obsidian_sync_service`, gdy `ob` nieobecne w PATH (jedyna jawna gałąź fail tej funkcji, install-vps.sh:964–965, nietestowana — test zawsze stubuje ob w PATH). Reguła projektu: każda nowa funkcja = min. 1 happy path + 1 error case. Fix: wariant testu bez stubu ob w PATH → asercja fail + brak zapisu unit-pliku.
16. **`scripts/install-vps.test.sh:1158`** (scalone z 3 zgłoszeń, w tym plan L325) — rozjazd numeracji testów w cross-referencjach: komentarze w harnessie numerują nowe testy 45–51 (nagłówki funkcji), a plan i zadania mapują je jako „test 50: build_puls_env_lines", „testy 52–54", „test 55" (liczone po pass-asercjach harnessu, 61 total). Nawigacja doc→test po numerze prowadzi do złego testu. Ujednolicić (najodporniej: w planie odwoływać się nazwą funkcji testowej, nie numerem).

---

## 📋 OPERATOR (poza fix — warunki środowiskowe)

### OP-1 [P2] Otwarty [Manual] Unit 5 — pełna weryfikacja fazy Obsidian+Puls na realnym VPS

(scalony z 4 zgłoszeń: `scripts/install-vps.sh:1479` P2+P3, plan L334 P2, plan L314 P3)

Scenariusz [Manual] Unitu 5 (plan L314) pozostaje otwarty i jest niewykonalny headless: na realnym VPS z systemd i zalogowanym kontem Obsidian Sync potwierdzić, że (1) oba unity (`obsidian-sync`, `claude-cron`) są `active` (enable --now, ExecStartPre lock cleanup, Restart=always), (2) `~/vault/.claude/skills` widoczne przez symlink, (3) sparse checkout prywatnego repo działa przez credential helper gh, (4) pliki typu `unsupported` (raporty HTML/JSON/CSV) faktycznie docierają przez Obsidian Sync na komputer/telefon. Wymaga prawdziwego serwera, konta Obsidian Sync i urządzeń klienckich.

### OP-2 [P2] Kontrakt realnego `ob sync-config` / `ob sync-status` — założenie formatu wyjścia niepotwierdzone na żywo

(scalony z 2 zgłoszeń: `scripts/install-vps.sh:885` P2, część `scripts/install-vps.sh:884` P3; odroczone pytanie nr 2 planu)

Cały kontrakt `configure_obsidian_file_types` opiera się na założeniu formatu wyjścia realnego `ob sync-status` (linia `File types:` zawierająca `unsupported`) oraz semantyce `ob sync-config --file-types` — w testach oba końce są atrapami (`verify_ob_file_types` parsuje tekst, nie exit code; format wyjścia młodego pakietu obsidian-headless@0.0.12 może odbiegać od atrap z przewodnika). Do domknięcia przez operatora na VPS z prawdziwym kontem Obsidian, nie przez fix kodu.

### OP-3 [P3] Pozostałe założenia z przewodnika niepotwierdzone headless

(reszta `scripts/install-vps.sh:884`)

(1) ścieżka locka `.obsidian/.sync.lock` w ExecStartPre — wzór z przewodnika, niepotwierdzony na żywo; (2) sparse checkout prywatnego repo przez gh credential helper (odroczone pytanie nr 4 planu). Weryfikowalne wyłącznie przy przebiegu OP-1.

---

## Zgodność ze spec

- Wszystkie pozycje IU5 zaimplementowane: sync-config + weryfikacja `unsupported` pod trapem, sparse checkout `.claude` z guardem re-run, idempotentny symlink, unit obsidian-sync (`Restart=always`, `User=claude`, ExecStartPre lock cleanup), `build_puls_env_lines` bez `WEBHOOK_BASE_URL`, twarda kolejność sync-config → weryfikacja → `enable --now` w `main()`, rollback automatów warunkowy per-run; scenariusze [Unit] planu pokryte (harness 61/61 PASS).
- Odchylenia jakościowe od intencji spec-u (nie braki funkcji): kontrakt R13 „idempotencja = resume" ma dziury w `setup_vault_git` (P2-1, P2-2, P3 poz. 1) i w re-runie serwisu (P2-3); kontrakt R8 wobec „cudzego stanu" niespójny między `setup_vault_git` a `link_vault_claude` (P2-4).
- Scenariusz [Manual] Unit 5 świadomie otwarty → OP-1/OP-2/OP-3 (gate operatora, nie defekt kodu).
- Brak scope creep wykrytego po weryfikacji.

---

## Bookkeeping checkboxów Weryfikacja:

- Odznaczone automatycznie (CLI/grep): 2
- Odznaczone na podstawie Agent 5 E2E: 0
- Pozostawione dla operatora (Manual): 1
- Niejasne (P3): 0
- Failujące (P2): 0

### Szczegóły
- [x] CLI: `bash scripts/install-vps.test.sh — asercje ENV_LINES/unitów/file-types PASS` → PASS (komenda: `bash scripts/install-vps.test.sh`, wynik 61/61 PASS, w tym testy build_puls_env_lines / build_obsidian_sync_unit / verify_ob_file_types / configure_obsidian_file_types)
- [x] CLI: `test kolejności w harnessie — sync-config w main() PRZED enable --now obsidian-sync` → PASS (Test 50 harnessu, L1324: `main(): configure_obsidian_file_types PRZED create_obsidian_sync_service (+ vault-git/symlink obecne)`)
- [ ] Manual: `Test: [Manual] na VPS: ~/vault/.claude/skills widoczne przez symlink; oba unity active` — wymaga operatora (przeniesione do „Operator checklist faza 5", OP-1)

Bookkeeping nie dodał nowych P2/P3 — severity gate bez zmian: **⚠️ KONTYNUUJ Z ZASTRZEŻENIAMI (4 × P2)**.
