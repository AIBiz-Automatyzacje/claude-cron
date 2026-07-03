# Review fazy 5 — dokumentacja (Unit 10)

Data: 2026-07-03
Zakres: `README.md`, `CLAUDE.md`, `.claude/templates/e2e-env/.env.e2e.example`, `.gitignore` (kontekst — wzorzec `.env.*`)
Findings po adversarial verify: **6** (wszystkie P3, typ KOD; trzy z nich — #1, #3, #6 — to trzy kąty tego samego problemu: gitignorowany deliverable `.env.e2e.example`)

## Statystyki

- Plików sprawdzonych: 4
- 🔴 [P1-blocking]: 0
- 🟠 [P2-important] (KOD/TEST/E2E): 0
- 🟡 [P3-nit] (KOD/TEST/E2E): 6
- 📋 [OPERATOR] (poza gate, do Operator checklist): 0
- 🌐 [E2E]: 0 passed / 0 failed / 0 skipped (faza 5 to czysta dokumentacja — brak scenariuszy E2E browser)
- ☑️ Weryfikacja: 1 auto (CLI/grep) / 0 E2E / 0 manual / 0 niejasne / 0 failed

## Severity gate

**✅ GOTOWE DO KONTYNUACJI — 6 sugestii P3 do rozważenia.** Zero P1 i zero P2. Bookkeeping nie dodał żadnych P2 (jedyny checkbox Weryfikacji fazy 5 przeszedł: grep PASS + `npm test` 267/267, exit 0). Faza 5 nie zmienia kodu produkcyjnego — findings dotyczą wyłącznie dokumentacji i utrwalenia artefaktu w repo.

## Findings (P1 → P2 → P3)

### 🟡 P3

1. **[KOD] `.gitignore:6`** — Deliverable Unitu 10 — `.claude/templates/e2e-env/.env.e2e.example` (TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID, linie 26-27) — jest gitignorowany wzorcem `.env.*` i NIE jest śledzony w repo (`git ls-files` pokazuje w tym katalogu tylko `README.md`). Zmiana istnieje wyłącznie lokalnie na dysku: świeży clone/inna maszyna nie dostanie szablonu w ogóle, a README szablonu każe robić `cp .claude/templates/e2e-env/.env.e2e.example .env.e2e` z pliku nieobecnego w repo. Cel Unitu 10 („przyszłe sesje agenta znają nowe mechanizmy") jest dla tego artefaktu strukturalnie niespełnialny — bookkeeping to odnotował („zmiana lokalna"), ale nie rozwiązał. Fix: negacja `!.claude/templates/e2e-env/.env.e2e.example` w `.gitignore` + commit pliku (to `.example` bez sekretów, bezpieczny do wersjonowania). *(ten sam problem co #3 i #6 — trzy warianty fixu)*

2. **[KOD] `README.md:334`** — Overclaim bezpieczeństwa w dokumentacji: `README.md:334` („Dashboard i API nigdy nie pokazują pełnych wartości — tylko maskę") i `CLAUDE.md:45` („API zwraca wyłącznie maski") są niezgodne z kodem — `GET /api/settings/notifications` zwraca `telegram.chat_id` W PEŁNEJ formie (`lib/notify-config.js:49`, `buildMaskedNotifySettings`: `chat_id: config.telegramChatId || null`). Chat ID to niska wrażliwość (sam w sobie nie pozwala wysyłać wiadomości), ale twierdzenie „nigdy pełnych wartości" jest fałszywe i buduje błędny model zaufania u czytelnika. Fix dokumentacyjny: doprecyzować „token i webhook maskowane (ostatnie 4 znaki); chat ID widoczny jawnie" — albo maskować chat_id w API (zmiana kodu poza zakresem tej fazy).

3. **[KOD] `.claude/templates/e2e-env/.env.e2e.example:26`** — Deliverable Unit 10 nieutrwalany w repo: wzorzec `.env.*` w `.gitignore` (linia 6) połyka szablon `.env.e2e.example` — dodane TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID istnieją TYLKO lokalnie na tej maszynie; świeży clone / inny kontrybutor / odtworzenie środowiska E2E nie dostanie zaktualizowanego szablonu i flow E2E powiadomień nie będzie miał wzorca konfiguracji. Plik zawiera wyłącznie placeholdery (zweryfikowane — zero realnych wartości), więc jest bezpieczny do commitu; rekomendacja: wyjątek `!.claude/templates/e2e-env/.env.e2e.example` w `.gitignore`. Uwaga: przy dodawaniu wyjątku zweryfikować jeszcze raz zawartość pliku przed commitem (obecnie czysta). *(= #1)*

4. **[KOD] `README.md:135`** — PRE-EXISTING (nie dodane w fazie 5, linie 135/195/265 to kontekst diffu — zgłoszone zamiast dismissowania): publiczny README używa jako przykładu realnego Tailscale IP VPS-a usera (`100.86.100.113`, per pamięć projektu srv1362522). Ekspozycja minimalna — adresy CGNAT `100.64.0.0/10` są nieosiągalne spoza tailnetu usera, a dashboard i tak wymaga członkostwa w tailnecie — ale przykład w publicznej dokumentacji powinien być jawnie fikcyjny (np. `100.100.100.100`), żeby nie ujawniać topologii prywatnej sieci. Do poprawki przy najbliższej edycji README, nie blokuje fazy.

5. **[KOD] `CLAUDE.md:44`** — Wpis „Powiadomienia" w sekcji „Architektura backendu (lib/)" to pojedynczy bullet ~1100 znaków opisujący naraz 5 modułów (discord/telegram/notify-format/notify-config/notify-push) — łamie konwencję sekcji „jeden moduł = jeden bullet" i obniża skanowalność dokumentu agentowego. Merytorycznie treść jest w 100% zgodna z kodem (zweryfikowano: chunki 2000/4096, priorytet state>env i semantyka pustego stringa, `countRecentFailedRuns` wspólny z schedulerem, kontrakt `{ok, reason}` notify-push, maski w API). Sugestia: rozbić na pod-bullety per moduł albo wydzielić 2-3 zdania kluczowych inwariantów, resztę zostawić komentarzom w kodzie.

6. **[KOD] `.claude/templates/e2e-env/.env.e2e.example:26`** — Deliverable Unit 10 „Modyfikuj: `.claude/templates/e2e-env/.env.e2e.example` (TELEGRAM_*)" (plan linia 413) wykonany tylko lokalnie: plik jest gitignorowany (`.gitignore:6`, wzorzec `.env.*`) i nietrackowany, więc dodane TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID nie trafią do repo — świeży clone nie dostanie tej dokumentacji, a trackowany `.claude/templates/e2e-env/README.md` też nie wspomina o zmiennych Telegrama. Sugerowany trwały fix (komplementarny do #1/#3): udokumentować TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID (z notą o dedykowanym bocie testowym) w trackowanym `.claude/templates/e2e-env/README.md`. *(= #1)*

## Zgodność ze spec

- **Unit 10 (IU-10, dokumentacja)**: sekcje README (Telegram + BotFather + auto-detect chat ID, „konfigurujesz raz — lokalnie" + priorytet state>env + nota o re-runie VPS, powiadomienia o failach, podstawowe taski, skill puls) i wzmianki w CLAUDE.md (5 modułów notify, endpointy settings/push-to-vps, starter-jobs, katalog skills/) — zrealizowane i merytorycznie zgodne z kodem (zweryfikowano treść bulletu „Powiadomienia" w 100%). Dwa odchylenia jakościowe: overclaim maskowania chat_id (#2) i deliverable `.env.e2e.example` istniejący tylko lokalnie (#1/#3/#6 — plan linia 413 formalnie „wykonany", ale nieutrwalalny w repo bez wyjątku w `.gitignore`).
- Scope creep: nie stwierdzono (zero zmian w kodzie produkcyjnym).

## Operator checklist (findingi OPERATOR — poza severity gate)

Brak — faza 5 nie wygenerowała findingów typu OPERATOR.

## Bookkeeping checkboxów Weryfikacja:

- Odznaczone automatycznie (CLI/grep): 1
- Odznaczone na podstawie Agent 5 E2E: 0
- Pozostawione dla operatora (Manual): 0
- Niejasne (P3): 0
- Failujące (P2): 0

### Szczegóły

- [x] CLI/Grep: `grep -q TELEGRAM_BOT_TOKEN README.md CLAUDE.md przechodzi; npm test zielony (regresja całości)` → PASS (komendy: `grep -q TELEGRAM_BOT_TOKEN README.md CLAUDE.md` → exit 0; `npm test` → 267/267 PASS, 0 fail, exit 0)

## Liczniki końcowe (po bookkeepingu)

| Severity | KOD/TEST/E2E | OPERATOR |
|---|---|---|
| P1 | 0 | — |
| P2 | 0 | 0 |
| P3 | 6 | 0 |

**Gate: ✅ CZYSTE** (zero P1/P2; same P3 nie blokują).
