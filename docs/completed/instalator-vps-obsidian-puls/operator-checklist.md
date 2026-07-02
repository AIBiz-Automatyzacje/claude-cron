# Operator checklist — instalator VPS (Puls + Obsidian)

> Scalona lista WSZYSTKICH zadań operatora z faz 1–7 + Operator gate całościowy.
> Wykonanie: świeży VPS Ubuntu/Debian. Wszystkie punkty **przed merge** `feature/instalator-vps-obsidian-puls` → `main`.
> Przebieg: 2026-07-02, VPS Hostinger srv1362522 (Ubuntu 24.04.4, git 2.43). Odznaczaj `[x]`; odchylenia w Notatkach.

## Przygotowanie (przed SSH na VPS)

- [x] Branch wypchnięty na origin: `git push -u origin feature/instalator-vps-obsidian-puls`
- [x] Konto Obsidian + remote vault (Obsidian Sync) + hasło szyfrowania E2E
- [x] Prywatne repo GitHub z katalogiem `.claude` (`AIBiz-Automatyzacje/obsidian-vault-kacper`, zweryfikowane przez gh)
- [x] Konto Tailscale
- [x] Telefon z Obsidianem podpiętym do remote vaulta

One-liner testowy (env-override brancha — używany we WSZYSTKICH przebiegach poniżej):

```bash
curl -fsSL https://raw.githubusercontent.com/AIBiz-Automatyzacje/claude-cron/feature/instalator-vps-obsidian-puls/scripts/install-vps.sh \
  | sudo CLAUDE_CRON_REPO=https://github.com/AIBiz-Automatyzacje/claude-cron.git CLAUDE_CRON_REF=feature/instalator-vps-obsidian-puls bash
```

Reset (ten sam env-override):

```bash
curl -fsSL https://raw.githubusercontent.com/AIBiz-Automatyzacje/claude-cron/feature/instalator-vps-obsidian-puls/scripts/install-vps.sh \
  | sudo CLAUDE_CRON_REPO=https://github.com/AIBiz-Automatyzacje/claude-cron.git CLAUDE_CRON_REF=feature/instalator-vps-obsidian-puls bash -s -- --reset
```

---

## Test 1 — Spike-GATE: `su` + `/dev/tty` pod prawdziwym pipe (rozstrzyga R2/R6) ✅

- [x] CLI za `su` czyta z klawiatury pod prawdziwym pipe — POTWIERDZONE: Claude CLI (OAuth + `/exit`), gh device flow, hasło `ob login`, hasło E2E `ob sync-setup` — wszystkie interaktywne pauzy działały
- [x] ~~Jeśli NIE: zmiana jednopunktowa~~ — nie było potrzeby, forma `su - … -c` z redirectem `/dev/tty` działa na Ubuntu 24.04

## Test 2 — Pełny happy path ✅ (z 3 znalezionymi i naprawionymi bugami)

**Faza pytań (przed instalacją narzędzi):**
- [x] Checklist prerequisites wyświetla 6 pozycji i czeka na Enter
- [x] Blok 4 pytań czyta z klawiatury pod prawdziwym pipe
- [ ] Walidacja: zły email / zły format webhooka → odrzucenie z retry — *nie testowane celowo; do zrobienia przy re-install w Teście 6*
- [x] Podsumowanie odpowiedzi + „Kontynuujemy?" działa

**Narzędzia:**
- [x] Komplet narzędzi obecny — potwierdzone guardami re-run („już gotowe (pominę)" × Node/Claude/gh) i działaniem wszystkich loginów
- [x] `claude` i `ob` dostępne jako user `claude` (loginy 1/3/4 wykonały się przez `su - claude`)
- [x] `tailscaled` active (instalator czekał na daemon i przeszedł)

**Blok 5 loginów:**
- [x] Login 1: OAuth Claude — przeszedł
- [x] Login 2: `gh` device flow — przeszedł (`Logged in as AIBiz-Automatyzacje`)
- [x] Login 3: `ob login` (hasło konta) — przeszedł *(po fixie guardu `has_ob_auth` — patrz Notatki)*
- [x] Login 4: `ob sync-setup` (hasło E2E) — przeszedł
- [x] Login 5: `tailscale up` — przeszedł
- [ ] Subiektywnie: latencja probe'ów guardów akceptowalna — *nie zgłoszono problemu, bez formalnej oceny*

**Po instalacji:**
- [x] `systemctl is-active obsidian-sync claude-cron` → oba `active`
- [x] Symlink `~claude/vault/.claude` → `vault-git/.claude` podpięty (output instalatora)
- [ ] `su - claude -c "git -C ~/vault-git pull"` bez pytania o hasło — *clone przez credential helper zadziałał; jawny pull do potwierdzenia*
- [x] Pytanie o Funnel NA KOŃCU; `t` → Funnel wstał, URL sparsowany, `WEBHOOK_BASE_URL` w unicie
- [x] Podsumowanie PL wypisane (dashboard, webhooki, komendy, security-nota)
- [x] **R11 — nagroda:** notatka „Witaj z VPS" dotarła na telefon przez Sync
- [ ] Pliki `unsupported` (HTML/JSON/CSV) docierają przez Sync — *typ `unsupported` dopisany do konfiguracji ✓; transfer realnego pliku nie-md do potwierdzenia przy okazji*

## Test 3 — Heurystyki na żywych wyjściach ✅ (zweryfikowane u źródła cli.js 0.0.12)

- [x] `ob sync-status` — ZWERYFIKOWANE U ŹRÓDŁA: wypisuje TYLKO statyczną konfigurację → heurystyka przebudowana na journal serwisu (`Fully synced` z `ob sync`); linia `Fully synced` potwierdzona na żywo w journalu VPS
- [x] `parse_funnel_url` — URL z outputu (`https://srv1362522-2.tail4f19b2.ts.net`) zgodny z faktycznym publicznym adresem (zweryfikowany curlem z internetu)
- [x] Ścieżka locka — ZWERYFIKOWANE U ŹRÓDŁA: `<vault>/<configDir>/.sync.lock`, configDir domyślnie `.obsidian` → ExecStartPre czyści właściwy plik
- [x] Git >= 2.25 na realnym Ubuntu 24.04 (2.43.0)

## Test 4 — Granice bezpieczeństwa ✅ (po fixie UFW)

- [x] Z internetu: `curl -m 8 http://76.13.78.4:7777` → timeout ✓ *(PRZED fixem: 200 — patrz Notatki, bug UFW)*
- [x] Przez Tailscale: `curl http://100.117.89.69:7777` → 200 (dashboard prywatnie; UFW nie blokuje tailscale0)
- [x] Funnel: `curl https://<funnel-url>/` → 403
- [x] Funnel: `curl https://<funnel-url>/webhook/test` → 405 `{"error":"Method not allowed"}` (odpowiada)
- [x] `systemctl show claude-cron -p User` → `User=claude`

## Test 5 — Scenariusze błędów i wznowienia (w większości potwierdzone na żywo)

- [x] Pad weryfikacji loginu → retry-in-place — potwierdzone na żywo (sync-setup, 3 próby z pytaniem „Spróbować ponownie?")
- [x] 3× fail → komunikat resume, leave-partial (kroki NIE cofnięte, rollback-stos nietknięty) — potwierdzone na żywo
- [x] Re-run wskakuje w brakujący login — potwierdzone na żywo (detekcja stanu: Claude/gh „już gotowe", wskoczył w KROK 3/5)
- [ ] Zły kod 2FA / złe hasło `ob login` ×1 → retry — *mechanizm run_login potwierdzony wyżej; jawny test złego hasła opcjonalny przy re-install*
- [ ] Re-run po PEŁNYM sukcesie → pełny skip przez guardy, zero zmian stanu

## Test 6 — Cykl `--reset` → re-install

- [ ] `--reset` przez prawdziwy pipe: plan resetu wypisuje DOKŁADNĄ listę usuwanego + listę nie-usuwanego (w tym Funnel)
- [ ] Potwierdzenie wymaga wpisania `TAK` (samo Enter = anuluj)
- [ ] Serwisy stop/disable + daemon-reload przechodzą
- [ ] `userdel -r claude` usuwa konto (lub warn przy żywych procesach — reset kontynuuje)
- [ ] Crontab roota: wpis Pulsa usunięty, cudze wpisy nietknięte
- [ ] Funnel po resecie wyłączony (`tailscale funnel status` — brak forwardu na 7777)
- [ ] Ponowny one-liner → instaluje od zera bez błędów *(przy okazji: test złego emaila w bloku pytań)*

## Po merge

- [ ] Wycofanie starego repo `obsidian-vps-installer`
- [ ] Test one-linera z `main` (bez env-override) — ścieżka kursanta

## Notatki z przebiegu (2026-07-02)

Trzy realne bugi znalezione i naprawione w trakcie (wszystkie z testami regresyjnymi):

1. **Lock dpkg vs unattended-upgrades** (`9d8bd8b`): świeży VPS budzi unattended-upgrades po pierwszym `apt-get update`; nodesource padał na locku. Fix: `APT_CONFIG` z `DPkg::Lock::Timeout=900` (dziedziczony przez skrypty zewnętrzne). Przy okazji: `on_err` z pustym stosem rollbacku kończył CICHO — teraz zawsze komunikat + one-liner resume.
2. **Fałszywy pozytyw `has_ob_auth`** (`7c5e3c2`): niezalogowany `ob login </dev/null` kończy się kodem 0 (zawieszony drugi prompt → pusty event loop → cichy exit 0). Guard pomijał KROK 3/5. Fix: rozpoznanie po outputcie `Logged in as`. Bonus: `wait_for_first_sync` przebudowany z `ob sync-status` (tylko statyczna konfiguracja!) na journal serwisu (`Fully synced`).
3. **UFW nigdy nie włączany** (`fe49e29`, KRYTYCZNE): `grep -q "active"` matchuje `Status: inactive` — reguły lądowały w uśpionym firewallu, dashboard był widoczny z publicznego internetu (potwierdzone curlem: 200). Fix: kotwica `^Status: active` + weryfikacja stanu faktycznego z głośnym warnem. Ta sama klasa substring-bugów co pkt 2 — teza review P3 potwierdzona na żywo dwukrotnie.

Obserwacje bez zmian w kodzie: `gh` zapisuje token plain-text (`~/.config/gh/hosts.yml`, headless bez keyringa — norma); pierwszy sync dużego vaulta > 90 s (timeout-warn zadziałał zgodnie z projektem, `Fully synced` pojawił się później); pierwsze żądanie do Funnela może dostać timeout (zimny start certyfikatu TLS), kolejne działają.
