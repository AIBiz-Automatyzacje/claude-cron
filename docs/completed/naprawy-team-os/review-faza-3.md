# Review fazy 3 — Format Skrzynki i archiwum

**Zadanie:** naprawy-team-os
**Faza:** 3 (U6 — merge frontmattera, U7 — archiwum bez duplikatów, U8 — job kontroli spójności)
**Data:** 2026-08-05
**Severity gate:** ⛔ **BLOKUJE** — 1 problem P1

## Statystyki

| Metryka | Wartość |
|---|---|
| Findingi łącznie (po dedupie i verify) | 26 |
| 🔴 P1 (blocking, KOD/TEST/E2E) | 1 |
| 🟠 P2 (important, KOD/TEST/E2E) | 2 |
| 🟡 P3 (nit, KOD/TEST/E2E) | 21 |
| 🔧 OPERATOR (poza fix, warunki środowiskowe) | 2 |
| E2E: passed / failed / skipped | 0 / 0 / 0 |
| Checkboxy `Weryfikacja:` fazy 3 | 6 (6 PASS, 0 FAIL) |

**Decyzja:** ⛔ WYMAGA POPRAWEK — znaleziono 1 problem P1 blokujący kontynuację (utrata cudzej nitki w archiwum przez niezaufany marker w treści wiadomości).

---

## 🔴 P1 — blokujące

### 1. `scripts/inbox/inbox-push.mjs:120` — marker wątku matchowany substringiem na niezaufanej treści (KOD)

Marker wątku wyszukiwany SUBSTRINGIEM w dowolnej linii calloutu (`line.startsWith('>') && line.includes(marker)`), a treść wiadomości renderowana jest do archiwum DOSŁOWNIE (`renderArchiveThread:92-93`). Treść wiadomości pochodzi od innego członka zespołu przez hub = wejście NIEZAUFANE.

**Scenariusz awarii:** Marcin wysyła wiadomość, której linia treści brzmi `%% thread:cccccccc-cccc-4ccc-8ccc-cccccccccccc %%` (uuid cudzego wątku, widoczny w archiwum). Trafia do archiwum jako `>   %% thread:cccc... %%`. Gdy prawdziwy wątek `cccc...` jest domykany po raz drugi, `replaceArchiveThreadBlock` trafia w linię WEWNĄTRZ obcego bloku, rozszerza granice po ciągłości `>` i podmienia CAŁY obcy blok treścią wątku `cccc...` — zarchiwizowana nitka osoby trzeciej znika bezpowrotnie, a właściwy blok i tak zostaje zduplikowany.

**Naprawa w tej fazie:** escapować `%%` w renderowanej treści (`(m.content||'').replaceAll('%%','%​%')`) ORAZ matchować marker przez równość całej linii (`line.trim() === '> ' + marker`), nie `includes`; dołożyć test z wiadomością zawierającą cudzy marker.

---

## 🟠 P2 — ważne

### 2. `scripts/consistency-check.mjs:31` — job zaleca komendę naprawczą, która nie istnieje (KOD)

Job jest seedowany z `enabled: 1` (`templates/starter-jobs.json:43`) i codziennie o 9:00 wystawia zadanie z komendą naprawczą `/onboard --refresh-theme`, ale ten tryb NIE ISTNIEJE — checkbox U8 świadomie przeniesiony do U12 (Faza 5), a grep po zainstalowanym pluginie (`~/.claude/plugins/cache/aibiz/aibiz/32a789438618`) nie znajduje żadnego wystąpienia `refresh-theme`.

**Scenariusz awarii:** user z rozjechanym snippetem dostaje zadanie „naprawa to jedna komenda", wpisuje `/onboard --refresh-theme`, komenda nie istnieje → zadanie zamykane bez naprawy, czyli dokładnie ten „naganiacz", którego zabrania komentarz w nagłówku pliku.

**Naprawa:** `"enabled": 0` w szablonie do czasu U12 albo `THEME_FIX_COMMAND` opisujące kroki ręczne (skopiuj snippet z `<plugin>/skills/onboard/templates/skrzynka.css` do `<vault>/.obsidian/snippets/`).

### 3. `scripts/consistency-check.mjs:314` — entry-point guard łamie learned-pattern `fileURLToPath` (KOD)

Entry-point guard używa `realpathSync(new URL(import.meta.url).pathname)` zamiast `fileURLToPath(import.meta.url)` — łamie regułę z `.claude/rules/learned-patterns.md` („realpathSync po OBU stronach" z `fileURLToPath`) i wzorzec wszystkich pozostałych entry-pointów repo (`scripts/inbox/close.mjs:116`, `scripts/inbox/onboard.mjs:111`, `scripts/inbox/migrate-pg-to-hub.mjs:174`, `setup.mjs:1420`).

`URL.pathname` zwraca ścieżkę PERCENT-ENCODED (katalog instalacji jest wolnym wejściem usera — spacje i diakrytyki są udokumentowanym przypadkiem) oraz `/C:/...` na Windowsie.

**Skutek:** `realpathSync` rzuca, wchodzi fallback na porównanie URL-i, a gdy i ono się rozjedzie, `main()` nie startuje — job kończy się kodem 0, Puls raportuje sukces, a kontrola spójności nigdy nie biegnie.

**Naprawa:** `fileURLToPath` po obu stronach.

---

## 🟡 P3 — drobne

### KOD

4. **`scripts/consistency-check.mjs:607`** — brak szablonu motywu ⇒ early return `no_template` PRZED `detectDrifts`, więc kontrola wersji (druga kontrola z IU U8) nigdy nie biegnie na maszynie bez pluginu zespołowego (VPS, świeża instalacja). R13 brzmi „rozjazd wyglądu **i wersji** jest zgłaszany jako zadanie". Dwie kontrole sprzężone bez powodu; test `scripts/consistency-check.test.mjs:876` betonuje regresję. Fix: liczyć drift wersji zawsze, brak szablonu pomija wyłącznie kontrolę motywu.
5. **`scripts/consistency-check.mjs:169`** — `resolveThemeTemplate` ma parametr `override` domyślnie z `process.env.PULS_THEME_TEMPLATE` — zmiennej nieustawianej NIGDZIE w repo, nieopisanej w CLAUDE.md ani w instalatorach, wyłączanej jawnie przez oba testy. Konfiguracja bez konsumenta; wymusza `return (await readFileOrNull(override)) === null ? null : override;` — pełny odczyt pliku jako sonda istnienia. Usuń parametr i tę gałąź.
6. **`scripts/consistency-check.mjs:171`** — plik szablonu czytany w całości dwa razy przy każdym przebiegu i raz wyłącznie jako sonda istnienia (`resolveThemeTemplate` vs `runConsistencyCheck:259`); ta sama sonda w pętli po pluginach (187, 197); `freeTaskPath:232` czyta pełną treść do 100 plików, żeby stwierdzić czy istnieją. Fix: `fs.access` jako sonda, `resolveThemeTemplate` zwraca `{ path, content }`.
7. **`scripts/consistency-check.mjs:89`** — `formatDate` liczy `termin`/`utworzone` z `date.toISOString().slice(0,10)` (UTC), choć vault i Dashboard operują w dobie lokalnej (learned-pattern „granicę doby licz w localtime"). Run `run_on_wake` o 00:30 lokalnie dostanie wczorajszy `termin` → „Zaległe" vs „Dzisiaj" w Dashboardzie. Fix: `date.toLocaleDateString('sv-SE')` + test.
8. **`scripts/consistency-check.mjs:64`** — struktura rozjazdu miesza języki: `{ id, opis, komenda }` wobec konwencji `.claude/rules/coding-rules.md §7` (angielskie identyfikatory, polskie komentarze). Fix: `description` / `command` w `detectDrifts`, `renderTaskFile` i testach.
9. **`scripts/consistency-check.mjs:394`** — `DASHBOARD_RELATIVE = 'Zadania/Dashboard.md'` na sztywno, podczas gdy skrypty inbox rozstrzygają nazwę przez `resolveDashboardPath`/`INBOX_TODO_PATH`. Na vaultcie sprzed zmiany nazwy wpis „natychmiastowej widoczności" cicho nie zostanie dopisany.
10. **`scripts/consistency-check.mjs:484`** — `dashboardEntryLine` i `VERSION_FIX_COMMAND` są `export`owane, a poza modułem nikt ich nie używa. Zdejmij `export`.
11. **`scripts/inbox/inbox-push.mjs:124`** — granice podmienianego bloku wyznacza ciągłość linii `>` w obie strony, bez zatrzymania na początku sąsiedniego calloutu (`> [!`). Usunięcie pustej linii między wpisami ⇒ podmiana wchłonie i skasuje sąsiedni blok. Ogranicz pętlę warunkiem `!lines[start-1].startsWith('> [!')`.
12. **`scripts/inbox/inbox-push.mjs:107`** — gdy `threadIdOf(thread)` zwróci `null`, blok dostaje literalny `> %% thread:null %%`, a `replaceArchiveThreadBlock` dla `threadId === null` zawsze zwraca `null` — takie bloki mnożą się przy każdym domknięciu. Fix: dokładać linię markera warunkowo.
13. **`scripts/inbox/inbox-pull.mjs:938`** — `splitTopLevelEntries` zbiera linie kontynuacji pod scenariusz, którego nie ma (`SKRZYNKA_TEMPLATE` ma wyłącznie klucze jednoliniowe, kontynuacje po stronie usera są wcięte i nie łapie ich regex klucza). Uprość do dwóch przebiegów po liniach (−~10 LOC, bez zmiany zachowania pokrytego testami).
14. **`lib/starter-jobs.js:44`** — `loadStarterJobDefs` rozwija względny `command` do ścieżki ABSOLUTNEJ w momencie seedu i wartość zostaje zamrożona w wierszu `jobs` (seed nigdy nie robi UPDATE). Wzorzec `lib/inbox-seed.js` składa ścieżkę przy KAŻDYM starcie właśnie dlatego, że katalog instalacji bywa przenoszony. Po przeniesieniu instalacji job pada codziennie, bez samonaprawy. Fix: `command` względny w DB, rozwijanie w `lib/executor.js:433` + test.
15. **`lib/starter-jobs.js:44`** — `loadStarterJobDefs(repoRoot = path.join(__dirname, '..'))` — parametr nie jest przekazywany przez żadnego wywołującego (punkt rozszerzalności bez użycia). Usuń i licz bazę ze stałej modułu, jak sąsiedni `TEMPLATES_FILE`.
16. **`setup.mjs:1366`** — pytanie instalatora wciąż brzmi „Dodać zestaw podstawowych tasków (memory update, reflect, skill scout)?", a „T" seeduje teraz także „Puls — kontrola spójności" — job piszący pliki do vaulta (`Zadania/w_trakcie/`, `Zadania/Dashboard.md`). Zgoda usera nie pokrywa tego, co powstaje. Fix: dopisać „kontrola spójności" do treści pytania.

### TEST

17. **`lib/starter-jobs.test.js:80`** — osłabienie asercji w istniejącym teście (anty-pattern #2): z pętli po wszystkich jobach usunięto `assert.equal(job.telegram_notify, 0)` i `assert.equal(job.job_type, 'claude')`, żeby przeszedł nowy script-job. 4 joby claude straciły kontrolę typu i flagi powiadomień. Fix: asercje warunkowo w pętli (`if (job.name !== 'Puls — kontrola spójności') {...}`).
18. **`scripts/inbox/inbox-pull.test.mjs:130`** — `mergeFrontmatter` ma 5 testów wymaganych planem, ale dwie własne gałęzie obronne fazy są bez pokrycia, mimo że nota fazy deklaruje je jako przetestowane: guard niedomkniętego frontmattera (`inbox-pull.mjs:254`) oraz gałąź kontynuacji w `splitTopLevelEntries` (`inbox-pull.mjs:236`). Zachowanie zweryfikowane ręcznie jako poprawne — czysty dług testowy, 2 asercje.
19. **`scripts/inbox/inbox-push.test.mjs:82`** — nowa ścieżka upsertu nie ma testu na wrogi input: wszystkie przypadki używają treści bez `%%`. Brakuje testu z `content` zawierającym `%% thread:<inny-id> %%` i asercji, że archiwizacja tamtego wątku NIE rusza cudzego bloku (bezpośrednie pokrycie P1 #1).
20. **`scripts/inbox/inbox-push.mjs:159`** — upsert zamienił atomowy `fs.appendFile` na read-modify-write CAŁEGO pliku miesiąca (odczyt 147, zapis 160), a ten sam plik pisze druga ścieżka domknięcia (`close.mjs`) i Obsidian Sync — w oknie odczyt→zapis cudza zmiana ginie bez śladu. Brak też testu na sąsiadujące bloki bez separatora. Akcja: test „dwa bloki bez pustej linii → podmiana rusza tylko własny"; przy zapisie porównaj treść ze snapshotem sprzed zapisu (albo tmp+rename) i powtórz cykl przy różnicy.
21. **`scripts/consistency-check.test.mjs:774`** — ścieżka `version-unknown` pokryta tylko na poziomie czystej `detectDrifts`; żaden test nie sprawdza, że `runConsistencyCheck` przy zgodnym snippecie i wersji `unknown` tworzy zadanie zawierające `VERSION_FIX_COMMAND`. To jedyny drift, który realnie wystąpi na świeżej maszynie.
22. **`scripts/consistency-check.test.mjs:809`** — brak testu I/O na gałąź „brak pliku Dashboard.md" (`consistency-check.mjs:287`, `dashboard === null`), choć nota fazy stawia to jako wymaganie. `makeWorkspace` ZAWSZE tworzy Dashboard.md. Akcja: opcja `dashboard: null` + test.
23. **`scripts/consistency-check.test.mjs:894`** — `resolveThemeTemplate` ma testy na „znaleziony" i „brak `installed_plugins.json`", ale nie na uszkodzony manifest — gałąź dopisana świadomie w audycie error-handlingu (`consistency-check.mjs:182`). Akcja: test z niepoprawnym JSON-em → `null` + przechwycenie `console.error`.
24. **`scripts/consistency-check.test.mjs:818`** — brak testu na oba rozjazdy naraz (theme-drift + version-unknown), a to najczęstszy stan świeżej/starej instalacji (smoke-run dał `Rozjazd (theme-drift, version-unknown)` i JEDNO zadanie). Pętla po `drifts` w `renderTaskFile` nie jest asertowana.

---

## 🔧 Findingi OPERATOR (poza zakresem fix — warunki środowiskowe)

25. **`templates/starter-jobs.json:38`** — job „Puls — kontrola spójności" powstaje wyłącznie przez seed w `setup.mjs` (idempotencja po `name`), więc na maszynach JUŻ zainstalowanych nie pojawi się, dopóki operator nie odpali ponownie instalatora/`setup.mjs` i nie odpowie „T" na pytanie o taski startowe; na VPS starter-jobs nie są seedowane w ogóle. Dodatkowo na tej maszynie `data/version.json` nie istnieje (instalacja z repo dev), więc kontrola będzie raportować `version-unknown` do czasu przebiegu instalatora. Weryfikacja realnego przebiegu o 09:00 i realnego rozjazdu snippetu w vaultcie jest niewykonalna headless.

26. **`scripts/consistency-check.mjs:420`** — na maszynie usera snippet `<vault>/.obsidian/snippets/skrzynka.css` jest NOWSZY niż szablon w zainstalowanym pluginie (`~/.claude/plugins/cache/aibiz/aibiz/32a789438618/skills/onboard/templates/skrzynka.css`) — vault ma poprawki, których szablon nie ma (ukryty `inline-title`, `border-top: none` dla AnuPpuccin, centrowanie ptaszka, `font-size: 11px`). Detekcja jest bezkierunkowa, więc pierwszy przebieg joba od razu wystawi zadanie „napraw motyw", a naprawa (gdy `--refresh-theme` powstanie w U12) nadpisze vault STARSZYM CSS-em, cofając wygląd. Dodatkowo `data/version.json` nie istnieje w tej instalacji → drugi drift `version-unknown`. Wymaga zsynchronizowania szablonu w repo pluginu (i re-instalacji Pulsa) PRZED włączeniem joba.

---

## Bookkeeping checkboxów Weryfikacja:

- Odznaczone automatycznie (CLI/grep): **6**
- Odznaczone na podstawie Agent 5 E2E: 0
- Pozostawione dla operatora (Manual): 0
- Niejasne (P3): 0
- Failujące (P2): 0

### Szczegóły

- [x] CLI: `node --test scripts/inbox/inbox-pull.test.mjs` przechodzi → PASS (13/13, exit 0)
- [x] CLI: `npm test` przechodzi w całości (U6) → PASS (895/895, exit 0)
- [x] CLI: `node --test scripts/inbox/inbox-push.test.mjs` przechodzi → PASS (11/11, exit 0)
- [x] CLI: `npm test` przechodzi w całości (U7) → PASS (895/895, exit 0)
- [x] CLI: `node --test scripts/consistency-check.test.mjs` przechodzi → PASS (17/17, exit 0)
- [x] CLI: `npm test` przechodzi w całości (U8) → PASS (895/895, exit 0)

Bookkeeping nie wprowadził nowych findingów — severity gate pozostaje **BLOKUJE** (1× P1).

---

## Przebieg review

| Etap | Wartosc |
|---|---|
| Pliki w fazie (z tego kodu) | 13 (9) |
| Flagi warstw | ui=true dane=true typowanie=false nowyModul=true |
| Browserowe checkboxy `Weryfikacja:` | 0 |
| Reviewerzy aktywni | security, performance, architecture, spec-compliance, simplicity, test-coverage, e2e |
| Reviewerzy pominieci | typescript (domena nieobecna w mapie zmian fazy) |
| Findingi: znalezione -> dedup JS -> dedup semantyczny | 43 -> 43 -> 27 |
| Adversarial verify: weryfikowane / obalone / bez glosow | 10 / 1 / 0 |
