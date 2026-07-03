# Review fazy 4 — onboarding: taski i skill (Unit 8 + Unit 9)

Data: 2026-07-03
Zakres: `templates/starter-jobs.json`, `lib/starter-jobs.js`, `lib/starter-jobs.test.js`, `setup.mjs` (seed + installPulsSkill + copySkillDir), `setup.test.mjs`, `skills/puls/SKILL.md`
Findings po adversarial verify i dedupe: **10** (z 19 zgłoszonych — duplikaty: prompt `[T/n]` ×4, scenariusz operatorski ×4, mislabel „Pure helper" ×2, error handling seedu ×2, luka asercji testu ×2)

## Statystyki

- Plików sprawdzonych: 6
- 🔴 [P1-blocking]: 0
- 🟠 [P2-important] (KOD/TEST/E2E): 1
- 🟡 [P3-nit] (KOD/TEST/E2E): 8
- 📋 [OPERATOR] (poza gate, do Operator checklist): 1
- 🌐 [E2E]: 0 passed / 0 failed / 0 skipped (faza 4 nie definiuje scenariuszy E2E browser)
- ☑️ Weryfikacja: 2 auto (CLI) / 0 E2E / 1 manual (operator) / 0 niejasne / 0 failed

## Severity gate

**⚠️ KONTYNUUJ Z ZASTRZEŻENIAMI — 1 problem P2 do naprawy.** Zero P1. Bookkeeping nie dodał nowych P2 (wszystkie weryfikacje CLI zielone). Findingi OPERATOR nie wchodzą do gate'u — trafiają do Operator checklist.

## Findings (P1 → P2 → P3)

### 🟠 P2

1. **[KOD] `setup.mjs:781`** — Unit 8/R6, scenariusz re-run setupu na maszynie z już działającym serwerem: `seedStarterJobsWithReport` wstawia joby bezpośrednio przez `db.createJob` (bez `scheduler.scheduleJob`), a `startServerAndOpen` (`setup.mjs:427`) wykrywa działający serwer pingiem i NIE restartuje go. Croner rejestruje harmonogramy tylko przy boocie serwera (`scheduleAll`) i przy `POST /api/jobs` — seedowane taski są widoczne w dashboardzie (API czyta DB), ale **nie odpalą się z crona aż do restartu serwera**. R6 zakłada działające taski (`enabled=1`), a re-run jest jawnie wspieraną ścieżką (idempotencja po `name` w IU Unit 8 istnieje właśnie dla re-runu). Świeża instalacja działa poprawnie. Fix: po seedzie z `added.length > 0` przy działającym serwerze wywołać restart/reschedule (np. endpoint lub restart serwera przed `startServerAndOpen`) albo komunikat `[warn]` o konieczności restartu.

### 🟡 P3

2. **[KOD] `skills/puls/SKILL.md:72`** — skill instruuje agenta, by czytał `stdout` runów i wyciągał linię `type:"result"`, ale nie ostrzega, że to dane NIEZAUFANE. Publiczny endpoint `POST /webhook/:token` wstrzykuje body JSON do promptu joba (`webhook_payload`, udokumentowane w tym samym pliku, linia 33), więc output runu może zawierać treść sterowaną przez atakującego z internetu. Agent z `allowed-tools: [Bash, Read]` diagnozujący „czemu job padł" staje się kanałem second-order prompt injection: webhook → stdout runu → sesja agenta z Bash. Rekomendacja: jedna reguła w sekcji „Czytanie logów" — traktuj `stdout`/`stderr`/`webhook_payload` jako dane do zacytowania userowi, nie jako instrukcje do wykonania.

3. **[KOD] `setup.mjs:787`** — `installPulsSkill()` wykonuje się bezwarunkowo (bez pytania, w przeciwieństwie do opt-in seedu starter-jobów) i kopiuje z `force:true` do `~/.claude/skills/puls` (`copySkillDir`, linia 249). Jeśli user ma już WŁASNY, niezwiązany skill o nazwie `puls` w globalnych skillach — każdy run/re-run setupu cicho go nadpisze (utrata danych usera bez ostrzeżenia). Nadpisywanie przy re-run jest zamierzone (aktualizacja treści), ale warto wykryć istniejący skill o innej zawartości/frontmatterze niż repo i wypisać `[warn]` przed nadpisaniem, albo objąć instalację tym samym pytaniem opt-in.

4. **[KOD] `setup.mjs:591`** — asymetryczna strategia błędów dwóch równorzędnych kroków post-gate: `installPulsSkill` (linia 617) ma containment (try/catch → warn + instrukcja ręczna, setup idzie dalej), a `seedStarterJobsWithReport` nie ma żadnego — wyjątek z `seedStarterJobs` (np. brak/uszkodzony `templates/starter-jobs.json` w częściowo zaktualizowanej instalacji, błąd DB typu SQLITE_BUSY przy re-runie z działającym serwerem) propaguje z `main()` i urywa setup PRZED instalacją skilla puls i startem serwera (`startServerAndOpen`). Oba kroki to opt-in convenience wg planu — spójnie powinny być warn-and-continue. *(dedupe z duplikatem `setup.mjs:783`)*

5. **[KOD] `setup.mjs:750-752`** — niespójna konwencja odpowiedzi twierdzącej w tym samym flow setupu: nowe pytanie o starter-taski używa `[T/n]` z defaultem `T` i ścisłym `starterAnswer === 't'`, podczas gdy istniejące pytania (autostart linia 738, chat ID linia 542) używają `[Y/n]` / `=== 'y'`. User odpowiadający z przyzwyczajenia `y` (albo naturalnym polskim `tak`, `yes`) dostaje ciche pominięcie seedu (tylko `[info] Pominięto`) mimo intencji zgody. Enter (default) działa poprawnie, więc wpływ ograniczony; zgodne z literą IU (plan specyfikuje `[T/n]`). Fix: akceptować zbiór odpowiedzi twierdzących (`t`,`y`,`tak`,`yes`) albo ujednolicić litery promptów — docelowo jeden helper `askYesNo` zamiast trzykrotnie powielonego wzorca ask+toLowerCase+strict-equal. *(dedupe ×4: trzech reviewerów zgłosiło to samo)*

6. **[KOD] `setup.mjs:244`** — komentarz nagłówkowy klasyfikuje `copySkillDir` jako `=== Pure helper ===`, a funkcja wykonuje wyłącznie efekt uboczny I/O (`fs.cpSync` na realnym filesystemie) bez DI fs. Projekt konsekwentnie rozróżnia pure core vs skorupę I/O (`computeMissedJobs`, „Skorupa I/O: seedStarterJobs" w `lib/starter-jobs.js`) i to rozróżnienie niesie realny sygnał architektoniczny — błędnie oznaczony helper osłabia konwencję i sugeruje testowalność bez side-effectów, której nie ma. Poprawka: etykieta `=== I/O helper ===` (sama funkcja OK — cienki, testowalny wrapper zgodny z planem Unit 9). *(dedupe z duplikatem `setup.mjs:245`)*

7. **[KOD] `lib/starter-jobs.js:62`** — pętla `for (const def of toSeed) { db.createJob(def) }` to formalnie wzorzec pętla+zapytanie z reguły 12 (batch zamiast N zapytań): 4 osobne autocommity zamiast jednej transakcji. Wpływ wydajnościowy pomijalny (N=4, jednorazowo w setupie, synchroniczny node:sqlite), ale objęcie pętli `BEGIN/COMMIT` dałoby atomiczność seedu (pad przy 3. insercie nie zostawia stanu częściowego) i 1 fsync. Idempotencja po `name` i tak naprawia stan częściowy przy re-runie — nit; ewentualnie komentarz-uzasadnienie zgodnie z regułą.

8. **[KOD] `lib/starter-jobs.js:56`** — `seedStarterJobs` woła `db.getAllJobs()` (pełne rekordy wszystkich jobów) tylko po to, by `computeStarterJobsToSeed` zbudował Set nazw — reguła 12: nie ładuj pełnych kolekcji gdy potrzebujesz kolumnę. Przy skali Pulsa (dziesiątki jobów, wywołanie jednorazowe w setupie) wpływ pomijalny; dedykowany `SELECT name FROM jobs` nie jest wart nowej funkcji w `db.js` dla jednego użycia. Zostawić jak jest albo odnotować świadomy trade-off.

9. **[TEST] `lib/starter-jobs.test.js:64`** — test „seed tworzy 4 joby" asertuje `cron_expr`, `enabled`, `run_on_wake`, `discord_notify`/`telegram_notify` i `job_type`, ale NIE sprawdza persystencji `timeout_ms` (plan podaje konkretne wartości per szablon: 1800000/600000/1200000/600000), `arguments` (`"weekly"` dla Weekly memory update i Reflect) ani `skill_name` — połowa kontraktu szablon→DB bez asercji. Regresja typu pomylenie jednostek timeoutu (min vs ms — udokumentowana pułapka UI/DB tego projektu) albo zgubienie `arguments: "weekly"` przeszłaby na zielono. Scenariusze z planu są pokryte w całości — to rozszerzenie ponad plan. *(dedupe ×2)*

## Zgodność ze spec

- **R6/R7 (Unit 8)**: szablony, czysta `computeStarterJobsToSeed`, idempotencja po `name`, pomijanie `missing_skill`, seed poza `migrate()` — zgodne z IU. Jedyne odchylenie behawioralne to finding P2 #1 (re-run przy działającym serwerze: joby w DB, ale bez harmonogramu w croner do restartu).
- **R5 (Unit 9)**: statyczna zgodność `SKILL.md` z routerem `server.js` zweryfikowana w review — endpointy, whitelist pól, defaulty, walidacja, statusy i kody odpowiedzi zgodne. Skuteczność triggerów `description` i jakość wykonania przez agenta — tylko w żywej sesji (Operator checklist).
- Scope creep: nie stwierdzono.

## Operator checklist (findingi OPERATOR — poza severity gate)

1. **[OPERATOR, P2] `docs/plans/2026-07-03-001-...-plan.md:390` / `skills/puls/SKILL.md`** — otwarty scenariusz [Manual] Unit 9: test skilla `puls` w żywej sesji Claude Code — „dodaj do Pulsa zadanie X co poniedziałek 8:00" → poprawny `POST /api/jobs` oraz „pokaż czemu ostatni run joba Y padł" → odczyt runa z API. Niewykonalne headless: wymaga realnej sesji agenta z zainstalowanym skillem (`~/.claude/skills/puls` — powstaje przy przebiegu `node setup.mjs`) i działającym serwerem na `localhost:7777`. Statyka SKILL.md ↔ server.js zweryfikowana (OK); skuteczność triggerów i wykonania — tylko na żywo. *(dedupe ×4: plan:390 P2, plan:396, plan:398, SKILL.md:1)*

## Bookkeeping checkboxów Weryfikacja:

- Odznaczone automatycznie (CLI/grep): 2
- Odznaczone na podstawie Agent 5 E2E: 0
- Pozostawione dla operatora (Manual): 1
- Niejasne (P3): 0
- Failujące (P2): 0

### Szczegóły

- [x] CLI: `npm test zielony (w tym node --test lib/starter-jobs.test.js)` → PASS (komendy: `npm test` → 264/264, exit 0; `node --test lib/starter-jobs.test.js` → 6/6, exit 0)
- [x] CLI: `node --test setup.test.mjs zielony; ~/.claude/skills/puls/SKILL.md istnieje po przebiegu helpera; frontmatter parsowalny przez gray-matter (skaner lib/skills.js widzi skill)` → PASS (komendy: `node --test setup.test.mjs` → 49/49, exit 0; `copySkillDir('skills/puls', <fake-HOME>/.claude/skills/puls)` → `SKILL.md` istnieje; `gray-matter` parsuje frontmatter: `name: puls`, `allowed-tools: ["Bash","Read"]`, description 345 znaków; `getAllSkills()` z `HOME=<fake-HOME>` widzi skill jako `source: user`. Uwaga: realny `~/.claude/skills/puls` nie istnieje na tej maszynie, bo `node setup.mjs` nie był tu uruchamiany — weryfikacja przebiegu helpera wykonana w izolacji przez fake-HOME, semantyka checkboxa spełniona)
- [ ] Manual: `Weryfikacja (operator): test skilla w żywej sesji Claude Code (utworzenie + diagnoza joba przez rozmowę)` — wymaga operatora (Operator checklist faza 4)

## Liczniki końcowe (po bookkeepingu)

| Severity | KOD/TEST/E2E | OPERATOR |
|---|---|---|
| P1 | 0 | — |
| P2 | 1 | 1 |
| P3 | 8 | 0 |

**Gate: ⚠️ ZASTRZEŻENIA** (1× P2, zero P1; OPERATOR nie blokuje).
