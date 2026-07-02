# Code Review — Faza 3: Narzędzia (IU3)

Data: 2026-07-02
Zakres: `scripts/install-vps.sh` (funkcje `install_base_packages`, `install_node`, `ensure_claude_user`, `install_claude_cli`, `install_ob`, `install_tailscale`, sekwencja `main()`), `scripts/install-vps.test.sh` (testy 29–31).
Findings po adversarial verify + dedup (scribe). Duplikaty scalone (npm pin ×2, ask_tty w install_node ×2, MAIN_COMPONENT_FNS ×3, tailscale sleep/warn ×2, scenariusz operatorski Unit 3 ×4).

## Statystyki

- 🔴 P1 (blocking): **0**
- 🟠 P2 (important, KOD/TEST/E2E): **2**
- 🟡 P3 (nit, KOD/TEST/E2E): **17**
- 📋 OPERATOR (poza fix, do checklisty): **1** (P2, scalony z 4 zgłoszeń)
- 🌐 E2E: 0 passed / 0 failed / 0 skipped (faza bez scenariuszy browser E2E)
- ☑️ Weryfikacja: 2 auto PASS / 1 manual (operator)

**Severity gate: ⚠️ KONTYNUUJ Z ZASTRZEŻENIAMI — 2 problemy P2 do naprawy.**

---

## 🟠 P2 (important)

### P2-1 [KOD] `scripts/install-vps.sh:615` — rollback `userdel -r claude` aktywny PO bloku loginów kasuje credentials OAuth Claude

Rollback `userdel -r claude` pozostaje na stosie i aktywny PO bloku loginów (rollback wyłącza wyłącznie `halt_leave_partial`; `login_claude_cli` kończy się `return 0` przy `ROLLBACK_ENABLED=1`). Na świeżej instalacji (user utworzony w tym runie — standardowa ścieżka) każdy ERR w późniejszych krokach automatycznych (`clone_repo`: git clone fail przez zły REF/chwilowy brak sieci; `setup_puls_dependencies`: npm install fail) odwija stos i wykonuje `userdel -r`, kasując `/home/claude` wraz z `~/.claude/.credentials.json` — niszczy świeżo wykonany interaktywny login OAuth Claude. Sprzeczne z filozofią leave-partial (R6: „re-run wskakuje w brakujący login" — a login znika) i z decyzją 25 („rollback celowo bez Claude/Tailscale" — `userdel -r` de facto cofa login Claude).

**Fix:** przed `userdel` w rollbacku sprawdzić brak credentiali (albo zdejmować/neutralizować wpis `userdel` po udanym loginie / po wejściu w `login_block`), ewentualnie `userdel` bez `-r` gdy credentials istnieją.

### P2-2 [TEST] `scripts/install-vps.test.sh:595` — nowe funkcje fazy 3 bez ŻADNYCH testów jednostkowych własnego zachowania

`install_base_packages`, `install_claude_cli`, `install_ob`, `install_tailscale` w testach sekwencji (29–31) są w całości stubowane — zero testów własnego zachowania. Brakuje: happy path guard-skip (narzędzie już obecne → zero wywołań apt/npm/curl), error case fail-fast (weryfikacja po instalacji pada → fail) oraz testu warunkowego rollbacku `install_ob` (`push_rollback "npm rm -g obsidian-headless"` TYLKO gdy zainstalowano w tym runie — logika symetryczna do `userdel` z testu 31, podkreślana w decyzjach fazy, a nietestowana). Reguła projektu: każda nowa funkcja = min. 1 happy + 1 error test. Wzorzec DI do stubowania granicy systemu już istnieje w harnessie (testy 23, 28, 31). Przykład regresji, która przejdzie 31/31 PASS: usunięcie guardu `command -v ob` w `install_ob` → rollback `npm rm` ląduje na stosie mimo że `ob` był zainstalowany przed runem i fail późniejszego kroku kasuje CUDZĄ instalację.

---

## 🟡 P3 (nit)

### KOD

1. **`scripts/install-vps.sh:646`** — `npm install -g obsidian-headless` bez przypięcia wersji, wykonywane jako root. Każdy run pobiera latest z npm, lifecycle scripts pakietu wykonują się z uprawnieniami roota (supply chain: kompromitacja pakietu = root RCE). Kontekst zadania wskazuje `obsidian-headless@0.0.12` (młody pakiet 0.0.x, UNLICENSED) — kolejny run na innym VPS może dostać niekompatybilną nowszą 0.0.x i wywalić guardy `has_ob_auth`/`has_ob_sync` albo blok loginów IU4. Reguła projektu: „Pinuj wersje". Fix: `obsidian-headless@X.Y.Z`, podbijanie świadome; opcjonalnie `--ignore-scripts`. Zgodne z planem IU3 (plan też nie pinuje) — nit, nie odstępstwo od spec-u.
2. **`scripts/install-vps.sh:632`** — `install_claude_cli` (`curl … claude.ai/install.sh | bash` jako user claude) i `install_tailscale` (`curl … tailscale.com/install.sh | sh` jako ROOT, L663, kod przeniesiony 1:1) wykonują zdalne skrypty bez weryfikacji integralności (checksum/signature), podczas gdy instalatory tego projektu weryfikują SHA256 przenośnego Node. Mitygacje: TLS + oficjalne endpointy vendorów, Claude jako nieuprzywilejowany user, wzorzec nakazany planem IU3. Do świadomej akceptacji ryzyka w kontekście/decyzjach (częściowo w decyzji 24–25); przyszłe wzmocnienie: apt repo Tailscale zamiast install.sh.
3. **`scripts/install-vps.sh:632`** — wewnętrzny `curl -fsSL … | bash` w `install_claude_cli` wykonuje się w shellu `su` BEZ pipefail — fail curla (sieć/404) daje bash-owi pusty stdin i exit 0; błąd łapie dopiero generyczny fail po `command -v claude`, gubiąc przyczynę (sieć vs instalator). Fix: `set -o pipefail;` w stringu komendy.
4. **`scripts/install-vps.sh:640`** — `install_ob`: guard i weryfikacja sprawdzają `command -v ob` w PATH ROOTA, a konsumentem binarki jest user claude (`has_ob_auth` robi `run_as_claude "command -v ob"`). Przy nietypowym npm-prefixie roota (np. nvm w `/root/.nvm`) weryfikacja przejdzie, a blok loginów IU4 (`ob login`) polegnie na braku binarki. Fix: weryfikuj tą samą ścieżką co konsument — `run_as_claude`, jak w `install_claude_cli`.
5. **`scripts/install-vps.sh:649`** — `install_ob` rejestruje `push_rollback "npm rm -g obsidian-headless"` dopiero PO weryfikacji `command -v ob`. Jeśli npm install częściowo się powiedzie, a weryfikacja sfailuje, trap rollback wykona się BEZ sprzątnięcia częściowej instalacji (osierocony pakiet globalny). Wzorzec „rollback zaraz po akcji mutującej" (jak `push_rollback` po `useradd` w `ensure_claude_user`) — push przed weryfikacją.
6. **`scripts/install-vps.sh:657–673`** — `install_tailscale`: (a) po wyczerpaniu 10 prób pętli czekania na tailscaled funkcja idzie dalej i drukuje `ok "Tailscale zainstalowany"` bez żadnego warn — martwy daemon to cichy stan, który ujawni się dopiero przy `tailscale up`/`tailscale ip` (IU4) mylącym błędem; (b) bezwarunkowy `sleep 2` po pętli — 2 s stracone także gdy daemon aktywny w pierwszej iteracji. Fix: przenieść sleep/weryfikację `systemctl is-active` do warunku, warn przy timeout. Kod przeniesiony verbatim, ale teraz karmi blok loginów.
7. **`scripts/install-vps.sh:578`** — `install_node`: `ask_tty "Zainstalować Node.js 22 LTS?"` to pauza interaktywna w środku fazy narzędzi — sprzeczna z komentarzem `collect_config` (L835: „FAZA 1: cały typowany config w JEDNYM bloku — potem instalacja leci sama aż do bloku loginów") i z celem IU3 (re-run bez pauz przed loginami). Plan sankcjonuje („zachowanie bez zmian") — dług do IU4+: pytanie do bloku FAZY 1 albo auto-instalacja z warn.
8. **`scripts/install-vps.sh:577`** — po rename `ensure_node`→`install_node` zmienna lokalna `local install_node=""` (odpowiedź `ask_tty`) shadowuje nazwę własnej funkcji. Bash trzyma zmienne i funkcje w osobnych przestrzeniach, więc działa, ale łamie 5-sekundową regułę czytelności — prefix `do_install`, spójnie z `do_login`/`do_ts` w sąsiednich funkcjach.
9. **`scripts/install-vps.sh:561`** — lista binarek `git curl crontab gh` zduplikowana w `install_base_packages`: raz w bloku guardów (L546–549), raz w pętli weryfikacji (L561). Nowy pakiet bazowy = edycja dwóch miejsc, łatwo o rozjazd. Fix: jedna lokalna tablica binarka→pakiet.
10. **`scripts/install-vps.sh:379`** — niespójna granica per-user: komentarz deklaruje `run_as_claude` jako „jedyny szew DI guardów per-user", ale faza 3 używa go też poza guardami (`install_claude_cli`), podczas gdy `setup_puls_dependencies` (L744), `clone_repo` (L727/734) i `login_claude_cli` (L713/715) wołają gołe `su - "$CLAUDE_USER" -c`. Dwa równoległe szwy: testy stubujące `run_as_claude` pokrywają `install_claude_cli`, ale nie clone/npm. Fix: ujednolicić na `run_as_claude` (poza handoffem z `/dev/tty`) i zaktualizować komentarz.
11. **`scripts/install-vps.sh:686`** — nazewnictwo: `login_block` to fraza rzeczownikowa vs czasownikowe pozostałe komponenty main() (`install_`/`setup_`/`ensure_`/…). Spójniej `run_login_block`. Nazwa jest celowym markerem granicy dla testu sekwencji — zmiana wymaga aktualizacji testu 29 i komentarzy.
12. **`scripts/install-vps.sh:988`** — nieosiągalna gałąź defensywna w `setup_tailscale`: `warn "Tailscale niezainstalowany — pomijam łączenie"` nigdy się nie wykona, bo main() zawsze wcześniej woła `install_tailscale`, które fail-fastuje przy braku binarki. Martwy kod defensywny — zniknie przy IU4 (tailscale up → blok loginów), usunąć wtedy.
13. **`scripts/install-vps.sh:634`** — rozjazd litery spec z implementacją: R7 planu wymienia apt wśród automatów objętych rollbackiem, a implementacja celowo NIE rejestruje rollbacku dla apt/Claude-native/Tailscale — tylko `userdel` i `npm rm -g` (decyzja 25, uzasadniona). Odstępstwo świadome, ale plan (R7) nieuaktualniony — dopisać doprecyzowanie, żeby IU5/IU6 (clone/systemd) nie interpretowały R7 literalnie wbrew decyzji.

### TEST

14. **`scripts/install-vps.test.sh:667`** — brak testu warunkowej rejestracji rollbacku `install_ob` — mapa zmian i komentarz w kodzie deklarują „rollback npm rm tylko gdy zainstalowano w tym runie", test 31 pokrywa analogiczny warunek tylko dla `userdel`/`ensure_claude_user`. Test analogiczny do t.31: stub `command -v ob` → obecny ⇒ stos pusty; brak ⇒ `npm rm -g obsidian-headless` na stosie dopiero po udanej weryfikacji. Scenariusz nie był wymagany w planie IU3, stąd P3 (szczegółowy podpunkt P2-2).
15. **`scripts/install-vps.test.sh:613`** — test sekwencji (t.29) egzekwuje granicę „narzędzia przed login_block" wyłącznie po konwencji nazw `install_*` — instalacja pakietu w funkcji o innej nazwie (dziś realnie: ufw w `configure_firewall` po `login_block`) przechodzi niezauważona. Dodać asercję komplementarną (grep: `apt-get install`/`npm install -g` tylko w funkcjach `install_*`), inaczej inwariant nie jest chroniony przed regresją w fazach 4–7.
16. **`scripts/install-vps.test.sh:611`** — test 29 NIE sprawdza zależności kolejności WEWNĄTRZ fazy narzędzi: `ensure_claude_user` przed `install_claude_cli` (`run_as_claude` robi `su - claude` — bez usera instalacja pada), `install_base_packages` (curl) przed `install_claude_cli`/`install_tailscale`, `install_node` (npm) przed `install_ob`. Refaktor przestawiający wywołania w main() przechodzi 31/31 PASS, a instalator pada dopiero na czystym VPS. Fix: asercje kolejności względem pozycji w strumieniu CALL.
17. **`scripts/install-vps.test.sh:595`** — `MAIN_COMPONENT_FNS` to ręcznie utrzymywany duplikat listy komponentów main() bez asercji kompletności. Nowy komponent dodany do main() (IU4/IU5) bez wpisu na listę wykona w teście rejestratora PRAWDZIWE ciało funkcji (side-effecty: apt-get/systemctl/useradd na maszynie dewelopera, zanim test głośno padnie pod `set -e`) i/lub test przejdzie mimo dziury w sekwencji. Fix: asercja porównująca listę stubów z funkcjami wołanymi w ciele main() (np. `declare -f main | grep` po prefixach) albo stub-catchall z fail na niezastubowaną funkcję.

> Nota dedup: 17 pozycji P3 (13 KOD + 4 TEST) po scaleniu duplikatów z wejścia (npm pin ×2 → poz. 1; tailscale sleep/warn ×2 → poz. 6; ask_tty w install_node ×2 → poz. 7; MAIN_COMPONENT_FNS ×3 → poz. 17).

---

## 📋 OPERATOR (poza fix — warunki środowiskowe)

### OP-1 [P2] Otwarty scenariusz [Manual] Unit 3: czysty Ubuntu VPS — komplet narzędzi po Fazie 2

(scalony z 4 zgłoszeń: `scripts/install-vps.sh:545`, plan L220, plan checkbox, `*-zadania.md:77`)

Po Fazie 2 spec-u wszystkie narzędzia obecne: `command -v node gh claude ob tailscale`. To JEDYNA weryfikacja realnych ścieżek zewnętrznych instalatorów, których harness nie dotyka: apt/universe z `gh` na Ubuntu, nodesource `setup_22.x`, `claude.ai/install.sh` wykonywany jako user claude przez `su` (+ potwierdzenie, że PATH `~/.local/bin` działa w `su - claude -c`), `tailscale.com/install.sh` + start daemona (pokrywa finding o czekaniu na tailscaled), `npm -g obsidian-headless`. Niewykonalne headless — wymaga realnego VPS/kontenera z rootem i siecią; pokrywa się częściowo z Operator gate całościowym (`curl | sudo bash` z env-override brancha).

---

## Zgodność ze spec

- Wszystkie pozycje IU3 zaimplementowane, 3 scenariusze [Unit] z planu pokryte 1:1 (testy 29–31).
- Świadome odstępstwo od litery R7 (rollback apt) — udokumentowane decyzją 25, ale plan nieuaktualniony → P3 poz. 12.
- `npm install -g obsidian-headless` bez pinu zgodne z planem (plan też nie pinuje) → P3 poz. 1, nie brak spec-compliance.
- Brak scope creep wykrytego po weryfikacji.

## Bookkeeping checkboxów Weryfikacja:

- Odznaczone automatycznie (CLI/grep): 2
- Odznaczone na podstawie Agent 5 E2E: 0
- Pozostawione dla operatora (Manual): 1
- Niejasne (P3): 0
- Failujące (P2): 0

### Szczegóły

- [x] CLI: `bash scripts/install-vps.test.sh — asercje sekwencji i guardów PASS` → PASS (komenda: `bash scripts/install-vps.test.sh`, wynik: 31 PASS / 31 total, exit 0)
- [x] Grep: `grep -n '@anthropic-ai/claude-code' scripts/install-vps.sh → 0 linii` → PASS (grep zwrócił 0 linii)
- [ ] Manual: `Test: [Manual] czysty Ubuntu: command -v node gh claude ob tailscale po Fazie 2 spec-u` — wymaga operatora (przeniesione do „Operator checklist faza 3", pokrywa OP-1)

## Severity gate (po bookkeepingu)

Bookkeeping nie dodał nowych P2/P3 (oba automaty PASS).

**⚠️ KONTYNUUJ Z ZASTRZEŻENIAMI — 2 problemy P2 do naprawy (P2-1 rollback userdel po loginach, P2-2 brak testów jednostkowych funkcji fazy 3).**
