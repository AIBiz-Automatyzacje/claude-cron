# Code Review — Faza 2: Preflight + detekcja stanu + blok 4 pytań (IU2)

Data: 2026-07-02
Branch: `feature/instalator-vps-obsidian-puls`
Zakres: `scripts/install-vps.sh` (preflight, guardy `has_*`, walidatory, `collect_config`, `resolve_install_paths`, `ensure_workspace`), `scripts/install-vps.test.sh` (testy 16–25)
Źródło findings: multi-agent review + adversarial verify (dedup wykonany przez scribe — surowa lista zawierała powtórzenia tych samych defektów zgłoszone przez różnych reviewerów; zliczane są pozycje PO deduplikacji).

## Statystyki

| Metryka | Wartość |
|---|---|
| 🔴 P1 (blocking) | 0 |
| 🟠 P2 (important) | 1 |
| 🟡 P3 (nit) — KOD/TEST/E2E | 23 (KOD 18, TEST 4, E2E 1) |
| 📋 OPERATOR (poza fix) | 1 |
| Testy harnessu | 25/25 PASS |
| ☑️ Weryfikacja: | 2 auto-PASS / 0 FAIL / 1 manual (operator) |

**Severity gate: ⚠️ KONTYNUUJ Z ZASTRZEŻENIAMI — 1 problem P2 do naprawy** (zero P1; P3/OPERATOR nie blokują).

---

## 🟠 P2 (important)

### P2-1 [KOD] `scripts/install-vps.sh:769` — bezwarunkowy `chown` w `ensure_workspace` + brak walidatora w `ask_workspace`

`ensure_workspace` wykonuje `chown claude:claude "$WORKSPACE"` BEZWARUNKOWO (w fazie 1 chown był tylko w gałęzi tworzenia nowego katalogu — regresja przywilejów). W trybie `--only-puls` WORKSPACE pochodzi z `ask_workspace`, które NIE ma żadnego walidatora (goły `ask_tty` zamiast `ask_valid` — złamanie własnej reguły symetrii walidacji z tej fazy): user może podać `/`, `/etc`, ścieżkę względną albo istniejący katalog innego serwisu (np. `/srv/app`), a root po cichu zmieni jego ownership na `claude`. Powiązany aspekt (z osi spec): plan Unit 2 mówił „pytanie o workspace jak dziś" — a „jak dziś" obejmowało potwierdzenie „Folder nie istnieje. Utworzyć? [T/n]"; teraz `mkdir -p` materializuje literówkę bez pytania.

**Fix:** chown tylko dla świeżo utworzonego katalogu (lub po jawnym potwierdzeniu przejęcia istniejącego) + walidator ścieżki (absolutna, poza katalogami systemowymi) w `ask_workspace`; rozważ przywrócenie potwierdzenia utworzenia w `--only-puls`.

---

## 🟡 P3 (nit) — KOD

1. **`install-vps.sh:738`** — WORKSPACE liczony w `collect_config` PRZED `useradd` (z założenia `/home/claude`); `ensure_claude_user` przelicza przez `resolve_install_paths` tylko CLAUDE_HOME/INSTALL_DIR — WORKSPACE zostaje stale. Gdy realny home odbiega od `/home/claude` (np. `HOME=` w `/etc/default/useradd` — scenariusz, który komentarz w kodzie sam przyznaje), `ensure_workspace` i unit systemd dostają błędną ścieżkę, a `has_ob_sync` i przyszły ob sync działają na realnym `~/vault`. Fix: przeliczać WORKSPACE (i pochodne CLAUDE_HOME) po `resolve_install_paths`.
2. **`install-vps.sh:129`** — flaga `--tz` bez ŻADNEJ walidacji (asymetria z `--port`, wbrew regule symetrii flaga↔prompt z tej fazy). Literówka `Europa/Warszawa` przechodzi cały blok pytań i pada dopiero w `apply_timezone` → ERR-trap po zebraniu configu. Fix: walidacja w `parse_flags`/`resolve_auto_values` (`timedatectl list-timezones | grep -qx` z fallbackiem regex Region/City).
3. **`install-vps.sh:651`** — `--device-name` / `vps-$(hostname)` bez walidacji formatu; wartość ze spacjami/quotem/kodami ANSI trafi w Fazie 5 do komendy rejestracji Sync przez `run_as_claude` (string do `su -c`). Fix: `is_valid_device_name` (`^[A-Za-z0-9._-]+$`) + sanityzacja hostname w `resolve_auto_values`; brak testu invalid input dla `--tz`/`--device-name` (kontrast: `--port` ma test 16).
4. **`install-vps.sh:243`** — `normalize_repo` akceptuje https na DOWOLNYM hoście, mimo że prompt, komunikat błędu i flow (gh auth, `gh repo view`, clone) zakładają github.com. `https://gitlab.com/user/repo` przechodzi walidację formatu i wykłada się głęboko w Fazie 4 — łamie fail-fast, który ta faza wprowadza. Fix: zawęzić host do github.com (lub świadomie udokumentować inne hosty).
5. **`install-vps.sh:782`** — `Environment=CLAUDE_CRON_WORKSPACE=$WORKSPACE` w unicie bez cudzysłowów łamie się dla ścieżki ze spacją (systemd traktuje spację jako separator VAR=VAL), a faza 2 właśnie UTRWALA wsparcie spacji testem 25 (`/tmp/moj vault` → PASS). Sink pre-existing, ale nowy test legitymizuje input, który go psuje. Fix: `Environment="CLAUDE_CRON_WORKSPACE=$WORKSPACE"` albo odrzucanie spacji w walidatorze workspace.
6. **`install-vps.sh:684`** — `print_config_summary` drukuje userowy input przez `echo -e` — sekwencje backslash/ANSI w OB_EMAIL/VAULT_NAME/WORKSPACE interpretowane przez terminal (terminal-escape injection); wpisany `\033[2J` wyczyści ekran zamiast pokazać się w podsumowaniu, które user ma świadomie potwierdzić. Fix: `printf '%s'`.
7. **`install-vps.sh:222`** — walidatory `is_valid_email`/`is_nonempty` przepuszczają `' ` $`, mimo że komentarz L219–220 deklaruje ochronę wartości idących do komend/unitów. Email/nazwa vaulta z pojedynczym cudzysłowem wyłamie się z cytowania `su -c "ob login --email '<EMAIL>'"` w Unit 4. Latentny defekt + brak testu boundary na znaki specjalne.
8. **`install-vps.sh:705`** — `confirm_config` używa `ask_tty` z defaultem „T" — bez kontrolującego terminala fallback przyjmuje default i instalacja rusza BEZ potwierdzenia; w `--only-puls` wszystkie pytania mają defaulty, więc cały config przechodzi bez jednej świadomej odpowiedzi. Rozszerzenie znanej dziury P2-2 z fazy 1 na NOWY punkt zgody — fix P2-2 ma objąć też `confirm_config` i `show_prerequisites_checklist`.
9. **`install-vps.sh:708`** — `confirm_config` przerywa tylko przy dokładnym `^[Nn]$` — „nie", „no", „nope" traktowane jak zgoda. Invalid input = kontynuacja; brak testu `confirm_config` (n → exit 0, śmieciowa odpowiedź → zachowanie zdefiniowane).
10. **`install-vps.sh:751`** — niespójny kontrakt: `detect_timezone` broni się przed brakiem `timedatectl` (fallback Europe/Warsaw, komentarz „kontener/minimalny obraz"), ale `apply_timezone` woła `timedatectl set-timezone` bez guardu — w tym samym środowisku pada (127) i ERR-trap odpala rollback krok dalej; fallback to de facto martwy defensywny kod. Fix: guard `command -v timedatectl` w `apply_timezone` (ok + skip) albo usunięcie komentarza o kontenerach.
11. **`install-vps.sh:228`** — `is_valid_discord_webhook` akceptuje wyłącznie `https://discord.com/api/webhooks/` — legalne legacy URL-e `https://discordapp.com/...` (Discord nadal je honoruje) dostają 3× warn i fail. Fix: `^https://discord(app)?\.com/api/webhooks/[^[:space:]]+$`.
12. **`install-vps.sh:398`** — duplikacja magic path vaulta: `has_ob_sync` hardcoduje `~/vault`, `collect_config` (L738) niezależnie ustawia `WORKSPACE="$CLAUDE_HOME/vault"`. Dwa źródła prawdy — rozjazd = detekcja stanu kłamie przy re-run. Fix: stała `VAULT_DIR_NAME=vault` użyta w obu miejscach.
13. **`install-vps.sh:477`** — magic string `obsidian-sync` inline w `print_detected_state`, podczas gdy serwis Pulsa ma stałą `SERVICE_NAME` (L30); nazwa wróci w Fazie 5 (tworzenie unitu) — ryzyko dryfu. Fix: stała `OBSIDIAN_SYNC_SERVICE`.
14. **`install-vps.sh:373`** — wzorzec N+1 na spawnach `su -`: ~7 pełnych login-shelli (`has_claude_auth` 2×, `has_ob_auth` 2×, `has_ob_sync` 2×, `has_gh_auth` 1×) na jeden preflight, każdy z sesją PAM i sourcingiem profilu. Checki per guard skleić do jednego `run_as_claude` (`command -v ob >/dev/null && ob login </dev/null`) — koszt sub-sekundowy (nit), ale liczba podwoi się, gdy Fazy 3–5 użyją tych samych guardów.
15. **`install-vps.sh:714`** — komentarz nad `collect_config` deklaruje inwariant „cały typowany config w JEDNYM bloku", ale `main()` go jeszcze nie spełnia (`ensure_node` L523, `setup_tailscale` L888, funnel L909, auto-update L959 wciąż pytają w trakcie). Stan przejściowy do IU3–IU5 — doprecyzować komentarz („docelowo, domykane w IU3–IU5") i pilnować inwariantu w review Unitu 3.
16. **`install-vps.sh:459`** — `print_detected_state` obiecuje „już gotowe (pominę)", ale guardy `has_claude_auth`/`has_gh_auth`/`has_tailscale_ip` są konsumowane WYŁĄCZNIE przez wyświetlanie — `main()` woła `login_claude_cli`/`setup_tailscale` bezwarunkowo. Świadomy stan przejściowy (podpięcie = Units 3–5), ale do tego czasu komunikat resume (R13) kłamie — pilnować, by Unit 3/4 domknęły „(pominę)" dla KAŻDEJ pozycji.
17. **`install-vps.sh:435`** — niespójne nazewnictwo booleanów w warstwie preflight: `is_supported_os`/`has_*` trzymają konwencję prefixów, ale `check_internet` też zwraca boolean (→ `has_internet`/`is_online`); obok `check_root` (który NIE jest booleanem — sam faila) trzy różne kontrakty pod jednym prefiksem `check_`.
18. **`install-vps.sh:764`** — `ensure_workspace` robi `mkdir -p` bez potwierdzenia „Folder nie istnieje. Utworzyć? [T/n]" (które „jak dziś" z planu Unit 2 obejmowało) — literówka w ścieżce z `--only-puls` jest cicho materializowana. Decyzja 20 w kontekst.md uzasadnia usunięcie pytania dla trybu pełnego (auto `~/vault`), nie adresuje `--only-puls` z ręczną ścieżką. (Aspekt chown ujęty w P2-1.)

## 🟡 P3 (nit) — TEST

19. **`install-vps.test.sh:378`** — asercja retry w `test_ask_valid_email`/`test_ask_valid_discord` (L378, L412) to `warn_count -ge 2` — nie pinuje kontraktu `ASK_MAX_ATTEMPTS=3`; regresja obniżająca limit do 2 przejdzie zielono. Wstrzyknięty tty oddaje deterministycznie tę samą odpowiedź, więc powinno być `-eq 3` (lub `-eq $ASK_MAX_ATTEMPTS`).
20. **`install-vps.sh:564`** — brak testu jednostkowego `resolve_install_paths` (getent → fallback `/home/claude`; testowalny headless przez PATH-stub) i `resolve_auto_values` (priorytet FLAG_DEVICE nad `vps-<hostname>`, FLAG_TZ nad autodetekcją). Jedyne nowe funkcje fazy bez pokrycia — reguła „każda nowa funkcja publiczna ma test"; logika fallbacku istotna dla findingu P3-1 (stale WORKSPACE).
21. **`install-vps.test.sh:358`** — brak scenariusza retry-then-success dla `ask_valid` (zła odpowiedź → poprawiona przyjęta w 2. próbie). Harness wstrzykuje TTY jako zwykły plik, a `ask_tty` re-otwiera go przy każdym read (L172), więc zawsze oddaje tę samą pierwszą linię — testowane tylko wszystkie-złe→fail i od-razu-dobra→pass. FIFO/licznik-plik umożliwiłby sekwencję różnych odpowiedzi.
22. **`install-vps.test.sh:289`** — boundary `normalize_repo` nietestowane: (a) `user/repo.git` — działa, ale bez asercji; (b) `user/..` przechodzi walidację i produkuje `https://github.com/user/...git`; (c) niespójność: `user/repo` dostaje sufiks `.git`, https-URL bez `.git` zostaje bez.

## 🟡 P3 (nit) — E2E

23. **`docs/plans/2026-07-02-001-...-plan.md:182`** — otwarty checkbox [Manual] (checklist prerequisites na prawdziwym pipe) jest częściowo wykonalny headless jeszcze przed VPS: kontener debian/ubuntu jako root, `curl|bash` (lub `cat | bash`) z wstrzykniętym `CLAUDE_CRON_TTY_DEVICE` i env-override REPO/REF — pokrywa `run_preflight` + `collect_config` bez realnego deploya. Warto domknąć zanim IU3+ zacznie faktycznie instalować pakiety.

---

## Zgodność ze spec (oś Spec — wybrane)

- **Odchylenie od planu Unit 2** (`--only-puls` workspace): plan mówił „pytanie o workspace jak dziś" — utracone potwierdzenie tworzenia folderu + dodany bezwarunkowy chown → ujęte w P2-1 i P3-18.
- **Inwariant „config w jednym bloku"** zadeklarowany komentarzem, jeszcze niespełniony przez `main()` — świadomy stan przejściowy, ale komentarz kłamie (P3-15).
- **Obietnica resume „(pominę)"** (R13) niedomknięta do Units 3–5 (P3-16).
- Pozostałe wymagania IU2 (preflight, guardy rozdzielone `has_ob_auth`/`has_ob_sync`, blok 4 pytań z walidacją, auto-wartości, normalize_repo/path) — zaimplementowane zgodnie z planem, scenariusze testowe planu wykonane (25/25 PASS).

## 📋 OPERATOR (poza fix — warunki środowiskowe)

- **`scripts/install-vps.sh:461` / plan:182** — pełny przebieg FAZY 0+1 (checklist prerequisites z Enter przez `/dev/tty`, detekcja stanu z prawdziwymi `su`/`gh`/`ob`/`tailscale`/`getent`/`timedatectl`, blok pytań + potwierdzenie) jest weryfikowalny tylko na realnym Debian/Ubuntu VPS przez prawdziwy `curl | sudo bash` — headless harness testuje wyłącznie czyste funkcje przez wstrzyknięty `TTY_DEVICE`. Odpowiada otwartemu checkboxowi [Manual] fazy 2; przy okazji operator powinien rozstrzygnąć odroczone pytanie o przekazanie `/dev/tty` przez granicę `su` (guardy `run_as_claude`, handoff loginów — pokrywa się ze spike'iem z Operator checklist fazy 1).

---

## Bookkeeping checkboxów Weryfikacja:

- Odznaczone automatycznie (CLI/grep): 2
- Odznaczone na podstawie Agent 5 E2E: 0
- Pozostawione dla operatora (Manual): 1
- Niejasne (P3): 0
- Failujące (P2): 0

### Szczegóły

- [x] CLI: `bash scripts/install-vps.test.sh — nowe asercje PASS` → PASS (komenda: `bash scripts/install-vps.test.sh`, wynik 25 PASS / 25 total, exit 0)
- [x] Grep: `grep -c 'ask_tty' scripts/install-vps.sh ≥ 6 oraz read -r nadal tylko w ask_tty` → PASS (`ask_tty` ×17; jedyne `read -r` w L172 wewnątrz `ask_tty`, potwierdzone też grep-strażnikiem harnessu)
- [ ] Manual: `Test: [Manual] checklist prerequisites wyświetla 6 pozycji i czeka na Enter (na prawdziwym pipe)` — wymaga operatora (→ Operator checklist faza 2; częściowe pokrycie headless możliwe wg P3-23)

## E2E

Faza 2 nie ma scenariuszy E2E browser. Jedyny scenariusz end-to-end (prawdziwy pipe `curl | sudo bash`) — **skipped** (niewykonalny headless, przeniesiony do Operator checklist).

- passed: 0 / failed: 0 / skipped: 1

## Decyzja severity gate (finalna, po bookkeepingu)

⚠️ **KONTYNUUJ Z ZASTRZEŻENIAMI — 1 problem P2 do naprawy** (P2-1: bezwarunkowy chown + brak walidatora workspace w `--only-puls`). Zero P1. 23 × P3 do rozważenia, 1 pozycja Operator checklist.
