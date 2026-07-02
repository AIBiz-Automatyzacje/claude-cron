# Operator checklist — instalator VPS (Puls + Obsidian)

> Scalona lista WSZYSTKICH zadań operatora z faz 1–7 + Operator gate całościowy.
> Wykonanie: świeży VPS Ubuntu/Debian. Wszystkie punkty **przed merge** `feature/instalator-vps-obsidian-puls` → `main`.
> Odznaczaj `[x]` po każdym potwierdzonym punkcie; przy odchyleniu dopisz obserwację pod punktem.

## Przygotowanie (przed SSH na VPS)

- [ ] Branch wypchnięty na origin: `git push -u origin feature/instalator-vps-obsidian-puls` (bez tego `curl` z raw.githubusercontent nie zadziała)
- [ ] Konto Obsidian + remote vault (Obsidian Sync) + hasło szyfrowania E2E (inne niż hasło konta)
- [ ] Prywatne repo GitHub z katalogiem `.claude` (skille)
- [ ] Konto Tailscale + w admin console włączona możliwość Funnela dla tailnetu
- [ ] Telefon z Obsidianem podpiętym do tego samego remote vaulta (do testu R11 „Witaj z VPS")

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

## Test 1 — Spike-GATE: `su` + `/dev/tty` pod prawdziwym pipe (rozstrzyga R2/R6)

Krytyczny mechanizm bloku loginów: czy interaktywny CLI odpalony przez `su - claude -c "…" < /dev/tty` czyta z klawiatury, gdy sam skrypt leci przez pipe (`curl | sudo bash`).

- [ ] Na VPS odpal one-liner testowy i dojdź do PIERWSZEJ pauzy loginu (OAuth Claude) — CLI za `su` reaguje na klawiaturę (strzałki/Enter/wklejenie kodu)
- [ ] Jeśli NIE: zmiana jednopunktowa — forma `su` w helperze `login_cmd_as_claude`, redirect w `run_login` (alternatywy: `runuser`, `sudo -u`); poprawka PRZED dalszymi testami

## Test 2 — Pełny happy path (jeden przebieg, domyka checklisty faz 1–5)

Odpal one-liner testowy na czystym VPS i potwierdzaj po kolei:

**Faza pytań (przed instalacją narzędzi):**
- [ ] Checklist prerequisites wyświetla 6 pozycji i czeka na Enter (czyta z klawiatury, nie leci dalej samo)
- [ ] Blok 4 pytań (email Obsidian, nazwa vaulta, repo `.claude`, Discord webhook) czyta z klawiatury
- [ ] Walidacja: zły email / zły format webhooka → odrzucenie z retry (nie crash, nie akceptacja)
- [ ] Podsumowanie odpowiedzi + pytanie „Kontynuujemy?" działa

**Narzędzia (po bloku instalacji, przed loginami):**
- [ ] `command -v node gh claude ob tailscale` — komplet obecny
- [ ] `su - claude -c "command -v claude ob"` — dostępne też jako user `claude`
- [ ] `systemctl is-active tailscaled` → `active`

**Blok 5 loginów:**
- [ ] Login 1: OAuth Claude (przeglądarka) — przechodzi
- [ ] Login 2: `gh` device flow — przechodzi
- [ ] Login 3: `ob login` (2FA + hasło E2E) — przechodzi *(scenariusz literówki → Test 3)*
- [ ] Login 4: `ob sync-setup` — przechodzi
- [ ] Login 5: `tailscale up` — przechodzi
- [ ] Subiektywnie: latencja probe'ów guardów między krokami (`ob login </dev/null`, `gh auth status`, `gh repo view`) akceptowalna

**Po instalacji:**
- [ ] `systemctl is-active obsidian-sync claude-cron` → oba `active`
- [ ] `ls -la ~claude/vault/.claude` → symlink na `~claude/vault-git/.claude`, w środku widoczne `skills/`
- [ ] `su - claude -c "git -C ~/vault-git pull"` — sparse checkout przez credential helper gh, BEZ pytania o hasło
- [ ] Pytanie o Funnel pojawia się NA KOŃCU; wybierz `T` (potrzebne do Testu 5)
- [ ] Podsumowanie PL wypisane (dashboard, webhooki, komendy, security-nota)
- [ ] **R11 — nagroda:** notatka „Witaj z VPS" pojawia się w Obsidianie na telefonie (przez Sync)
- [ ] Pliki `unsupported` (HTML/JSON/CSV) docierają przez Sync na komputer/telefon

## Test 3 — Heurystyki na żywych wyjściach (formaty odroczone w planie)

Przy przebiegu z Testu 2:

- [ ] `su - claude -c "ob sync-status --path ~/vault"` — porównaj wyjście z regexem `is_sync_complete` w `scripts/install-vps.sh` (`synced|up.to.date|complete`); odchylenie → popraw regex (uwaga na fałszywe pozytywy typu „incomplete"/„not synced")
- [ ] `tailscale funnel status` — URL wyciągnięty przez `parse_funnel_url` (pierwszy https) = faktyczny publiczny URL z admin console (nie adres proxy)
- [ ] Ścieżka locka w ExecStartPre unitu `obsidian-sync` (`.obsidian/.sync.lock`) odpowiada plikowi locka realnie tworzonemu przez `ob sync`
- [ ] Git na VPS ma >= 2.25 (`git --version`) — wymaganie sparse checkout potwierdzone na realnym Ubuntu

## Test 4 — Granice bezpieczeństwa

- [ ] Z internetu (spoza tailnetu): `curl -m 5 http://<publiczne-ip>:7777` → timeout/refused (UFW deny działa)
- [ ] Przez Tailscale: `curl http://<tailscale-ip>:7777` → 200 (dashboard dostępny prywatnie)
- [ ] Funnel: `curl https://<funnel-url>/` → 403 (dashboard zablokowany publicznie)
- [ ] Funnel: `curl https://<funnel-url>/webhook/test` → odpowiada (nie timeout, nie 403)
- [ ] `systemctl show claude-cron -p User` → `User=claude` (nie root)

## Test 5 — Scenariusze błędów i wznowienia

Wymaga drugiego przebiegu (po `--reset` z Testu 6) albo wykonania w trakcie Testu 2 przy loginie `ob login`:

- [ ] Zły kod 2FA w `ob login` ×1 → retry-in-place (bez wywalenia instalatora)
- [ ] Zły kod ×3 → komunikat resume; instalator kończy w trybie leave-partial (rollback-stos NIE odwija zainstalowanych narzędzi)
- [ ] Re-run one-linera → wskakuje bezpośrednio w brakujący login (guardy pomijają zrobione kroki)
- [ ] Re-run po PEŁNYM sukcesie → pełny skip przez guardy, zero zmian stanu, wykryty stan wypisany

## Test 6 — Cykl `--reset` → re-install

- [ ] `--reset` przez prawdziwy pipe: plan resetu wypisuje DOKŁADNĄ listę usuwanego + listę nie-usuwanego
- [ ] Potwierdzenie wymaga wpisania `TAK` z klawiatury (samo Enter = anuluj, nic nie usunięte)
- [ ] Serwisy stop/disable + daemon-reload przechodzą
- [ ] `userdel -r claude` usuwa konto (lub warn z instrukcją przy żywych procesach — reset kontynuuje, nie wywala się)
- [ ] Crontab roota: wpis Pulsa usunięty, CUDZE wpisy nietknięte
- [ ] Funnel po resecie: sprawdź `tailscale funnel status` — czy publiczny URL nadal forwarduje na 7777 (fix P2 fazy 7 miał go wyłączać — potwierdź na żywo)
- [ ] Ponowny one-liner → instaluje od zera bez błędów (pełny cykl domknięty)

## Po merge

- [ ] Wycofanie starego repo `obsidian-vps-installer` (archiwizacja/README z przekierowaniem)
- [ ] Test one-linera z `main` (bez env-override) — ścieżka, którą dostaje kursant

## Notatki z przebiegu

_(miejsce na obserwacje operatora — realne wyjścia `ob sync-status`, `tailscale funnel status`, czasy, odchylenia)_
