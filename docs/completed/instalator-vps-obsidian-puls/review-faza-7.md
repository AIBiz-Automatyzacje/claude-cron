# Code Review — Faza 7: `--reset` + README (IU7)

Data: 2026-07-02
Zakres: `scripts/install-vps.sh` (ścieżka `--reset`: `parse_flags`, `build_reset_paths`, `remove_reset_path`, `print_reset_plan`, `confirm_reset`, `reset_services`, `remove_update_cron`, `remove_claude_user`, `print_reset_summary`, `run_reset`), `scripts/install-vps.test.sh` (testy 62–65, harness 89 asercji), `README.md` (sekcja „Instalacja na VPS", kroki 1.1–1.7).
Findings po adversarial verify + dedup (scribe). Duplikaty scalone: Funnel nie wyłączany/nie wymieniany przy resecie ×2 (sh:1816 + sh:1713) → P2-1; scenariusz [Manual] pełny cykl `--reset` → re-install na prawdziwym VPS ×4 (sh:1816 ×2 + plan:391 ×2) → OP-1; instrukcja `ufw delete deny $PORT/tcp` z portem bieżącego runu ×2 (sh:1717 ×2) → P3 KOD poz. 1; brak testu `--reset` bez tty ×2 (test.sh:1993 + test.sh:1992) → P3 TEST poz. 9.

## Statystyki

- 🔴 P1 (blocking, KOD/TEST/E2E): **0**
- 🟠 P2 (important, KOD/TEST/E2E): **1** (1 KOD)
- 🟡 P3 (nit, KOD/TEST/E2E): **11** (8 KOD + 3 TEST)
- 📋 OPERATOR (poza fix, do checklisty): **1** (P2, scalone z 4 zgłoszeń)
- 🌐 E2E: 0 passed / 0 failed / 0 skipped (faza bez scenariuszy browser E2E — instalator CLI)
- ☑️ Weryfikacja: 3 auto PASS (harness CLI + 2× grep) / 0 fail

**Severity gate: ⚠️ KONTYNUUJ Z ZASTRZEŻENIAMI — 1 problem P2 do naprawy.**

---

## 🟠 P2 (important)

### P2-1 [KOD] `scripts/install-vps.sh:1713` — reset nie domyka Tailscale Funnel: publiczny endpoint HTTPS zostaje aktywny po deinstalacji i nie figuruje na liście „NIE zostanie usunięte"

`setup_funnel` włącza `tailscale funnel --bg $PORT` — konfiguracja jest **persystentna** (przeżywa reboot), a `run_reset` (L1816) ani jej nie wyłącza, ani nie wymienia w sekcji „NIE zostanie usunięte" (`print_reset_plan` L1713 / `print_reset_summary` L1802 instruują tylko o `tailscale logout` i UFW). Funnel NIE jest „współdzielony z systemem" jak Node/UFW/apt — to artefakt Pulsa postawiony przez instalator. Kursant, który zostawi Tailscale do innych celów (domyślna ścieżka wg komunikatu — nie wykona `tailscale logout`, bo chce zachować tailnet), ma po deinstalacji nadal aktywny publiczny URL `https://<host>.ts.net` forwardujący ruch z internetu na port 7777; cokolwiek później zbinduje ten port, będzie publicznie wystawione bez jego wiedzy. Spec R12/plan wymaga DOKŁADNEJ listy usuwanego + jawnej listy świadomie nie-usuwanego z instrukcjami ręcznymi — Funnel nie jest w żadnej z nich.

**Fix (minimum):** best-effort wyłączenie w `run_reset` — `tailscale funnel --bg off`/`tailscale funnel off` z guardem `command -v tailscale` i `|| true`; dodatkowo jawna pozycja o Funnelu w `print_reset_plan` i `print_reset_summary` (obie listy). Alternatywa minimalna: sama pozycja na listach z komendą ręczną (`tailscale funnel reset` / `tailscale funnel --https=443 off`).

---

## 🟡 P3 (nit)

### KOD

1. **`scripts/install-vps.sh:1717`** — `print_reset_plan` i `print_reset_summary` (L1802) podają instrukcję `ufw delete deny $PORT/tcp`, gdzie PORT = flaga z bieżącego wywołania lub domyślne 7777. Instalacja z `--port 8888` + późniejszy reset bez flagi → kursant dostaje komendę z błędnym portem 7777 i reguła DENY 8888 zostaje na zawsze (kierunek bezpieczny — deny — więc tylko nieścisłość dokumentacyjna). Realny port jest odczytywalny z `Environment=CLAUDE_CRON_PORT` w unit-pliku `claude-cron.service` (istnieje jeszcze w momencie `print_reset_plan`). Spec IU7 mówi tylko „wypisz `ufw delete deny <PORT>`", więc to doprecyzowanie, nie brak. Fix: odczyt portu z unitu przed wypisaniem instrukcji albo dopisek „jeśli zmieniałeś port, podstaw swój" (scalone ×2).
2. **`scripts/install-vps.sh:165`** — niespójny guard kolizji flag w `parse_flags`: `--reset` odrzuca tylko `--only-puls`/`--no-obsidian`, a `--no-auto-update`, `--tz` i `--device-name` są przy `--reset` cicho akceptowane i ignorowane (`--port` jest sensowny — trafia do komunikatu `ufw delete deny $PORT/tcp`). Zasada „osobna ścieżka — flagi zakresu instalacji nie mają sensu" z komentarza jest wyegzekwowana tylko dla jednej flagi; fail-fast dla pozostałych flag instalacyjnych byłby spójniejszy.
3. **`scripts/install-vps.sh:1737`** — nazewnictwo: `reset_services` brzmi jak restart/przywrócenie serwisów, a funkcja robi stop + disable (reguła 5 sekund, coding-rules §7/§11). Czytelniej: `stop_and_disable_services` lub `reset_stop_services` — nazwa opisująca CO robi, nie fazę w której żyje.
4. **`scripts/install-vps.sh:1822`** — `build_reset_paths` wywoływane dwukrotnie w jednym przebiegu resetu: raz wewnątrz `print_reset_plan` (L1699), raz w `run_reset` przed pętlą usuwania (L1822). Idempotentne i bezpieczne, ale wzorzec „jedno źródło prawdy" sugeruje jedno wypełnienie na początku `run_reset` (przed `print_reset_plan`) — `print_reset_plan` czytałby gotową tablicę zamiast ją odbudowywać, co usuwa ukrytą zależność „kto ostatni zbudował listę".
5. **`scripts/install-vps.sh:1743`** — `reset_services` drukuje `ok "Serwis $svc zatrzymany i wyłączony"` bezwarunkowo po `systemctl disable --now ... || true` — gdy disable padnie (serwis zamaskowany, systemd w degraded state), komunikat kłamie, a żywy proces usera claude wywali później `userdel -r` (obsłużone warn-em, więc skutek ograniczony). Nit: warunkowy komunikat ok/warn zależnie od kodu powrotu systemctl.
6. **`scripts/install-vps.sh:1768`** — `remove_update_cron` filtruje crontab roota nieakotwiczonym substringiem `grep -v "$SERVICE_NAME"` — usunie także CUDZY wpis roota, który jedynie WSPOMINA „claude-cron" (np. własny backup kursanta `0 3 * * * tar czf ... /home/claude/claude-cron/data`). Zachowanie jest jawnie zapowiedziane w `print_reset_plan` („linie z claude-cron") i lustrzane do dedup-filtra `install_update_cron`, więc świadomy trade-off — nit do rozważenia: match po pełnym `CRON_CMD` zamiast nazwy serwisu (pokrewny P3 poz. 3 z review fazy 6).
7. **`scripts/install-vps.sh:1768`** — `remove_update_cron`: `printf ... | grep -v "$SERVICE_NAME" | crontab - || true` — `|| true` na całym pipeline (uzasadnione dla rc=1 z grep przy pustym wyniku) połyka też realny błąd samego `crontab -`, po czym funkcja i tak drukuje `ok "Wpis auto-update usunięty"` (fałszywy sukces). Bezpieczniejsza forma: `{ grep -v ... || true; } | crontab -` — wtedy pad crontaba nie jest maskowany. Nit, bo `crontab -` jako root praktycznie nie pada.
8. **`scripts/install-vps.sh:1697`** — reset nie usuwa i NIE wymienia w jawnej liście „NIE zostanie usunięte" globalnego pakietu npm `obsidian-headless` (bin `ob`), który instalator stawia jako root (L703; install ma nawet rollback `npm rm -g obsidian-headless`). `print_reset_plan` wymienia tylko Tailscale/UFW/Node/gh/apt — `obsidian-headless` nie jest współdzielony z systemem, więc po `--reset` zostaje sierota, a kursant o niej nie wie. Łamie zasadę planu IU7: „DOKŁADNA lista do usunięcia + jawna lista NIE-usuwanego" (pokrewne P2-1 — ta sama luka kompletności list, mniejszy skutek).

### TEST

9. **`scripts/install-vps.test.sh:1993`** — test 62 pokrywa odpowiedź ≠ TAK z działającego tty, ale brak testu najgroźniejszej ścieżki: `confirm_reset` BEZ dostępnego terminala (`curl | bash` w cron/CI/ssh bez `-t`). Kod jest poprawny (`ask_tty` z defaultem `""` → answer `""` ≠ TAK → anulowanie), ale zachowanie chroniące przed bezobsługowym skasowaniem `/home/claude` nie jest przybite asercją — regresja (np. zmiana defaultu na „TAK" albo usunięcie defaultu → fail zamiast anulowania) przeszłaby niezauważona. Przy udokumentowanej pułapce curl|bash/tty projektu dedykowany test dowodziłby, że przypadkowy pipe nie skasuje `/home/claude` ani nie zawiesi skryptu. Fix: wariant testu 62 z `TTY_DEVICE` wskazującym nieistniejącą ścieżkę, asercja rc=0 + „anulowany" + pusty log rejestratora (scalone ×2).
10. **`scripts/install-vps.test.sh:2127`** — test 65 deklaruje weryfikację kolejności „serwisy → pliki → cron → userdel", ale mock `crontab` (L2127–2132) nie zapisuje wywołań do `$log` — asertowane jest tylko „systemctl disable pierwszy" i „userdel ostatni" + efekty na plikach/cronfile. Pozycja kroku cron względem plików i userdel nie jest faktycznie sprawdzana; regresja przestawiająca `remove_update_cron` za `remove_claude_user` przeszłaby test. Nit: dopisać echo do logu w mocku crontab i asercję pozycji.
11. **`scripts/install-vps.sh:1780`** — nietestowana gałąź padu userdel w `remove_claude_user`: gdy `userdel -r` zawiedzie (np. proces usera claude jeszcze żyje — jedyny realistyczny scenariusz „konkurencji" dla resetu), kod ma dać warn z instrukcją ręczną i kontynuować do `print_reset_summary` z rc 0 (nie ERR). Testy 62–65 pokrywają tylko sukces userdel i brak usera; brak asercji, że fail userdel nie przerywa resetu pod `trap on_err ERR`.

---

## 📋 OPERATOR (poza fix — do checklisty operatora)

### OP-1 [P2] `docs/plans/2026-07-02-001-feat-instalator-vps-obsidian-puls-plan.md:391` — scenariusz [Manual] IU7: pełny cykl install → `--reset` → re-install od zera na prawdziwym VPS

Weryfikacja pełnego przebiegu `--reset` na prawdziwym Ubuntu VPS (prawdziwy `curl | sudo bash -s -- --reset` → `userdel -r` z ewentualnymi żywymi procesami usera claude, `systemctl disable --now` + daemon-reload po skasowaniu unitów, crontab roota → re-install od zera) jest niewykonalna headless — testy 62–65 mockują systemctl/userdel/crontab (rejestrator wywołań pokrywa sekwencję, nie zachowanie realnych narzędzi). Pozycja jest już ujęta w Operator gate planu i pliku zadań („`--reset` → re-install od zera") — do odhaczenia przez operatora przed merge. Scalone z 4 zgłoszeń (sh:1816 ×2, plan:391 ×2).

---

## Zgodność ze spec

- IU7 zrealizowane: dokładna lista usuwanego, potwierdzenie `TAK`, kolejność stop/disable → pliki → cron → userdel, guardy `${var:?}` na każdym `rm -rf`, README z one-linerem/prerequisites/flagami/`--reset`.
- **Braki względem litery spec „jawna lista NIE-usuwanego":** lista pomija dwa artefakty postawione przez instalator — Tailscale Funnel (P2-1) i globalny pakiet npm `obsidian-headless` (P3 poz. 8). Pozostałe pozycje (Tailscale logout, UFW, Node/gh/apt) zgodne.
- Scope creep: brak.

---

## Bookkeeping checkboxów Weryfikacja:

- Odznaczone automatycznie (CLI/grep): 3
- Odznaczone na podstawie Agent 5 E2E: 0
- Pozostawione dla operatora (Manual): 0 (checkbox `[Manual] pełny cykl na VPS` to pozycja testowa fazy, nie `Weryfikacja:` — ujęta jako OP-1 i w Operator gate)
- Niejasne (P3): 0
- Failujące (P2): 0

### Szczegóły

- [x] CLI: `bash scripts/install-vps.test.sh — asercje resetu PASS` → PASS (komenda: `bash scripts/install-vps.test.sh`, wynik: 89 PASS / 89 total, exit 0; w tym testy resetu 62–65)
- [x] Grep: `grep -n 'rm -rf' scripts/install-vps.sh — każda linia z ${…:?} lub poprzedzającym guardem` → PASS (L1682/L1684: `${1:?}` + `${path:?}` w `remove_reset_path`; L990 to template unitu systemd `ExecStartPre` spoza ścieżki resetu — ścieżka konkretyzowana przy budowie unitu, nie runtime'owy `rm` skryptu)
- [x] Grep: `README zawiera sekcje one-liner/prerequisites/flagi` → PASS (L28 „Krok 1 — Instalacja na VPS", L32 „1.1 — Prerequisites", L53 „1.3 — Odpal instalator (one-liner)", L83 „1.4 — Flagi")
