# Review fazy 2 — Fix strefy w `detectMissedJobs` + ekstrakcja pure `computeMissedJobs`

**Data:** 2026-06-27
**Faza:** 2 (Unit 2)
**Pliki w zakresie:** `lib/scheduler.js`, `lib/scheduler.test.js`
**Severity gate:** ⚠️ ZASTRZEŻENIA (1× P2, brak P1)

## Podsumowanie

Faza 2 realizuje Unit 2 planu: ekstrakcja pure `computeMissedJobs(jobs, lastActive, now, timezone)` z bugfixem strefy czasowej (R3) oraz pozostawienie `detectMissedJobs` cienkim wrapperem I/O. Pure funkcja jest bardzo dobrze pokryta (14/14 PASS, wszystkie 6 scenariuszy z planu), bug strefy naprawiony — obie ścieżki (`scheduleJob:58` i `detectMissedJobs:116`) używają tej samej strefy `Intl.DateTimeFormat().resolvedOptions().timeZone`.

Po adversarial verify: **1× P2** (luka pokrycia — brak testu wielu jobów w jednym wywołaniu, czyli głównej ścieżki produkcyjnej z `getAllJobs()` jako batch) oraz **8× P3** (puste catchy bez logu, duplikacja literału strefy, brak testów degenerate/boundary, niepokryty wrapper I/O). Brak findingów P1. Wszystkie zachowania zweryfikowane empirycznie jako poprawne — to luki pokrycia/nity, nie defekty KOD.

## Statystyki

- 🔴 [P1-blocking]: 0
- 🟠 [P2-important]: 1 (TEST)
- 🟡 [P3-nit]: 8 (KOD/TEST)
- 📋 OPERATOR (poza fix): 0
- ✅ E2E: 0 passed / 0 failed / 0 skipped (faza czysto backend/pure, brak scenariuszy przeglądarkowych)

## Findingi

### 🟠 P2 — important

1. **lib/scheduler.test.js** (TEST) — Brak testu z WIELOMA jobami w jednym wywołaniu `computeMissedJobs`. Realny caller (`detectMissedJobs`, scheduler.js:117-119) przekazuje całą listę z `getAllJobs()` jako batch, ale KAŻDY z 7 testów `computeMissedJobs` używa jednoelementowej tablicy. Nieprzetestowane: filtrowanie mieszanej listy i zwrócenie WIELU id naraz (np. `[job(id:1,przegapiony), job(id:2,run_on_wake:0), job(id:3,o 9:00 nieprzegapiony)] -> [1]`). Plan Unit 2 takiego scenariusza nie zdefiniował, ale to główna ścieżka produkcyjna funkcji. Zweryfikowane empirycznie: kod działa poprawnie (zwraca `[1]`) — luka pokrycia, nie defekt KOD.

### 🟡 P3 — nity

2. **lib/scheduler.js:102** (KOD) — Pusty `catch {}` przy `new Cron(job.cron_expr)` cicho połyka błąd złego crona bez logowania (§4 reguł projektu). Świadoma decyzja z planu (skip invalid cron, 1:1 z oryginału), nie luka bezpieczeństwa (dane z lokalnej bazy, brak injection/eval). Sugestia: debug-log z `job.id` (nie nazwą/payloadem), by przegapiony job o złym cronie nie znikał bez śladu.
3. **lib/scheduler.js:117,178** (KOD) — Tabela jobs czytana dwukrotnie przy starcie: w `detectMissedJobs()` (linia 117) i ponownie w `start()` (linia 178). Dwa pełne odczyty przy boocie. Wpływ pomijalny (jednorazowo, mała tabela, brak pętli z zapytaniem). Struktura pre-existing — nie zmiana tej fazy. Brak realnego N+1: pure `computeMissedJobs` jest O(n) bez I/O, a `enqueueJob→processQueue` ma guard `queueProcessing` (scheduler.js:13).
4. **lib/scheduler.js:58,116** (KOD) — `Intl.DateTimeFormat().resolvedOptions().timeZone` zduplikowane w dwóch miejscach (`scheduleJob` i `detectMissedJobs`) — ta faza dodała drugie wystąpienie. Spójność strefy to rdzeń R3 (plan, Ryzyka:292), a wartość nie została wyekstrahowana do `const LOCAL_TIMEZONE`. 2 użycia = reguła „abstrakcja przy 2+" spełniona. Dwie literalne kopie utrzymują dokładnie to ryzyko driftu, które fix R3 miał domknąć.
5. **lib/scheduler.js:102-104** (KOD) — Pusty `catch {}` w pure funkcji (tylko komentarz `// Skip invalid cron`). Lokalizacja w pure jest świadoma (pure nie robi I/O/logowania), zachowanie 1:1 z oryginału (pre-existing). Ale literówka w cronie usera nigdy się nie ujawni w ścieżce detekcji. Rozważyć: pure zwraca też listę skipniętych id, wrapper `detectMissedJobs` (warstwa I/O) loguje przez istniejący `console.warn`.
6. **lib/scheduler.js:104** (KOD) — Pusty `catch {}` łapie WSZYSTKIE wyjątki bez logu (§4). Faza dotknęła ten blok (dodała `{ timezone }` i `push`) → w zasięgu review. Ryzyko: realny błąd API Cron inny niż zły `cron_expr` zostanie cicho połknięty. `scheduleJob:64` loguje `err.message` — niespójność. Sugestia: `catch (err) { console.error(\`[scheduler] computeMissedJobs skip job ${job.id}: ${err.message}\`); }`. Zachowanie „skip invalid cron" jest celowe i przetestowane (cron `'garbage'` → `[]`), ale powinno zostawiać ślad.
7. **lib/scheduler.test.js:122** (TEST) — Brak bezpośredniego testu cienkiego wrappera `detectMissedJobs` (I/O: `getState('last_active_at')`, `getAllJobs`, `enqueueJob('wake')`, early-return gdy brak `last_active_at`). Pure pokryta 14/14, ale ścieżka „lastActive puste → return" oraz mapowanie id → `enqueueJob('wake')` bez asercji. Zgodne z założeniem planu (linia 287). Kontrakt `enqueueJob(id,'wake')` vs `scheduleJob enqueueJob(id,'scheduled')` istotny i niezweryfikowany.
8. **lib/scheduler.test.js:99** (TEST) — Granica okna `nextRun === now` nieprzetestowana. `computeMissedJobs` używa ścisłego `<` (scheduler.js:99). Job strzelający DOKŁADNIE o `now` powinien być wykluczony. Testy używają `now=6:03` i `now=6:35` — żadna asercja nie dotyka równości. Empirycznie: `now==fire -> []` (poprawnie). Boundary bez asercji.
9. **lib/scheduler.test.js** (TEST) — Brak testu pustej tablicy jobów oraz `null/undefined cron_expr`. `computeMissedJobs([], ...)` i job z `cron_expr=null/undefined` → catch → `[]` (empirycznie). Plan Unit 2 testował tylko `'garbage'`, nie `null/undefined`. Degenerate inputs nieasercjonowane.
10. **lib/scheduler.js:110** (TEST) — Wrapper `detectMissedJobs` nie jest eksportowany ani testowany. Plan świadomie zdefiniował go jako „cienki wrapper I/O" pokryty pośrednio. Niepokryta gałąź `if (!lastActive) return` oraz mapowanie `missedIds->enqueueJob('wake')`. Akceptowalne per plan, odnotowane jako luka pokrycia integracji wrappera.

## Zgodność ze spec

R3 zaimplementowane poprawnie: pure `computeMissedJobs(jobs, lastActive, now, timezone)` wyekstrahowana, strefa faktycznie przekazywana i używana w obu ścieżkach (test #14 „dwie strefy → różny wynik" dowodzi). Wrapper `detectMissedJobs` pozostał cienki zgodnie z planem. Brak braków krytycznych, brak scope creep, brak błędnie zaimplementowanych wymagań. Latentne: niepokryty wrapper I/O i duplikacja literału strefy — odnotowane jako P3, świadomy tradeoff planu.

## Bookkeeping checkboxów Weryfikacja:

Sekcja fazy 2 (Unit 2) ma 2 checkboxy `Weryfikacja:` (zadania.md:44-45), oba już zaznaczone `[x]` przez execute. Re-walidacja potwierdzająca:

- Odznaczone automatycznie (CLI/grep): 2 (potwierdzone)
- Odznaczone na podstawie Agent 5 E2E: 0
- Pozostawione dla operatora (Manual): 0
- Niejasne (P3): 0
- Failujące (P2): 0

### Szczegóły

- [x] CLI: `node --test lib/scheduler.test.js` → PASS (14/14, exit 0)
- [x] Grep: `grep -n "timezone" lib/scheduler.js` → PASS (linie 58, 88, 95, 116, 119 — strefa w ścieżce detekcji, nie tylko `scheduleJob`)

## Liczniki

| Kategoria | Liczba |
|---|---|
| P1 | 0 |
| P2 | 1 |
| P3 (KOD/TEST/E2E) | 8 |
| OPERATOR | 0 |

## Severity gate

⚠️ **ZASTRZEŻENIA** — 1× P2 (luka pokrycia: brak testu batch wielu jobów na głównej ścieżce produkcyjnej), brak P1. Faza może kontynuować z zastrzeżeniem; P2 do naprawy (dodać test mieszanej listy jobów → wiele zwróconych id). P3 opcjonalne do rozważenia.
