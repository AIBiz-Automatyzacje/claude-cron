# Review fazy 4 — Opóźnienie startu po wybudzeniu (Unit 9)

**Data:** 2026-07-30
**Zakres:** `lib/scheduler.js`, `lib/scheduler.test.js` (+ dokumentacja fazy)
**Gate:** 🔴 **BLOKUJE** — 1×P1, 2×P2, 9×P3 (0 findingów OPERATOR)

---

## Statystyki

| Metryka | Wartość |
|---|---|
| Findingi łącznie (po dedupie i verify) | 12 |
| P1 (blocking, KOD/TEST/E2E) | 1 |
| P2 (important, KOD/TEST/E2E) | 2 |
| P3 (nit, KOD/TEST/E2E) | 9 |
| OPERATOR (poza gate'em, warunki środowiskowe) | 0 |
| E2E | passed 0 / failed 0 / skipped 0 (brak warstwy UI — tester pominięty) |
| Bookkeeping `Weryfikacja:` — odznaczone CLI | 2 |
| Bookkeeping `Weryfikacja:` — nowe P2 | 0 |

Rozkład po typie: KOD 8, TEST 4, OPERATOR 0, E2E 0.

---

## P1 — blokujące

### 🔴 [P1] KOD — `lib/scheduler.js:528`

Próg detekcji snu jest **RÓWNY** okresowi heartbeatu, więc KAŻDE normalne tyknięcie jest brane za wybudzenie i zamraża kolejkę. `isWakeGap(lastHeartbeatAt, now)` używa domyślnego `executor.SLEEP_GAP_MS = 60_000` (`lib/executor.js:102`), a `startHeartbeat` tyka `setInterval(..., HEARTBEAT_INTERVAL_MS = 60_000)` (`lib/config.js:44`). Timery libuv gwarantują „nie wcześniej niż", więc realny gap to **zawsze** 60_00x ms.

Zmierzone na bezczynnym procesie (odtworzenie 1:1 pętli heartbeatu, node 22, macOS):

```
tick 1: gap=60003 isWakeGap(>60000)=true
tick 2: gap=60002 isWakeGap(>60000)=true
```

2/2 tyknięć przekracza próg; przy krótszym okresie 10/12. Repro na produkcyjnym module: `t.mock.timers.setTime(Date.now()+2); t.mock.timers.tick(60_000)` → `getWakeDetectedAt() === 60002` zamiast `null`, plus log „[scheduler] wybudzenie po 60 s przerwy — karencja 45 s".

**Skutek:** co ~60 s `markWakeDetected(now)`, więc `processQueue` odracza start WSZYSTKICH runów o 45 s z każdych 60 s — runy startują tylko w ~15-sekundowym oknie na minutę, opóźnione do 45 s. To łamie **R1** (krótki job nie może czekać) na całym systemie, opóźnia „Team OS — inbox sync" (co 1 min) oraz retry, i zalewa log daemona fałszywym alarmem „wybudzenie" co minutę — mylący sygnał diagnostyczny dla operatora.

Testy tego nie łapią, bo `t.mock.timers.tick(60_000)` daje gap **dokładnie** 60000 — wartość nieosiągalną na realnym event loopie.

**Akcja:** dla ścieżki heartbeatu użyć progu **ostro większego** od okresu tyknięcia, np. stała `WAKE_GAP_MS = HEARTBEAT_INTERVAL_MS + executor.SLEEP_GAP_MS` (120 s) przekazana **jawnie** do `isWakeGap` w `startHeartbeat` (w executorze `SLEEP_GAP_MS` działa tylko dlatego, że tam tick to 5 s = 12× zapasu). Ta sama poprawka domyka słabszy wariant w `detectWakeFromDowntime` (P3 poniżej).

---

## P2 — ważne

### 🟠 [P2] TEST — `lib/scheduler.test.js:892`

Test szwu heartbeat→karencja („zwykłe tyknięcie NIE jest wybudzeniem") przechodzi **wyłącznie** dzięki idealnie deterministycznemu zegarowi mocka: `t.mock.timers.tick(60_000)` przesuwa `Date` dokładnie o 60000 ms, czyli daje gap **równy** progowi (`gap > sleepGapMs` = false). Na realnym event loopie ta wartość nie występuje (zmierzone 60002–60003 ms), więc test jest zielony przy złamanym zachowaniu produkcyjnym — dokładnie wzorzec z `learned-patterns.md` („testy obu stron przechodzą przy złamanym zachowaniu systemowym").

**Akcja:** przed tyknięciem dodać realistyczny jitter — `t.mock.timers.setTime(Date.now() + 2); t.mock.timers.tick(60_000);` — i asercję `assert.equal(scheduler.getWakeDetectedAt(), null, 'tyknięcie spóźnione o kilka ms NIE jest wybudzeniem')`. To guard regresji dla P1; bez niego poprawka progu nie ma pokrycia.

### 🟠 [P2] KOD — `lib/scheduler.js:402`

Karencja włącza się **dopiero** w callbacku heartbeatu (linia 528), a produkcyjne joby o krótkim cronie mogą wyprzedzić ten callback po pobudce. Po wybudzeniu libuv odpala zaległe timery w kolejności ich due-time: dla joba `* * * * *` („Team OS — inbox sync" — istnieje w produkcji, script-job co 1 min, `telegram_notify=1`) due-time crona wypada na najbliższej granicy minuty po zaśnięciu, czyli **typowo wcześniej** niż kolejne tyknięcie heartbeatu. Wtedy `enqueueJob` → `processQueue` → `startEligibleRuns` biegnie synchronicznie, `wakeDetectedAt` jest jeszcze `null`, run startuje **bez karencji** i pada na `ENOTFOUND` — dokładnie symptom **R11**, dla joba, który generuje go najczęściej. Karencja zadziała dopiero dla kolejnych runów.

**Akcja (bez łamania R1: żadnego `await` ani zapytania do DB na normalnej ścieżce):** w `processQueue`, tuż po `const now = Date.now()`, dołożyć:

```js
if (isWakeGap(lastHeartbeatAt, now)) { markWakeDetected(now); lastHeartbeatAt = now; }
```

Detekcja przestaje zależeć od kolejności timerów, bo pętla sama sprawdza lukę wall-clock (ten sam próg, zero nowej abstrakcji). Uwaga: wdrażać **razem z P1** — z dzisiejszym progiem ten guard tylko rozszerzyłby fałszywą detekcję na pętlę kolejki.

---

## P3 — drobne (nie blokują gate'u)

### 🟡 [P3] KOD — `lib/scheduler.js:556`
`detectWakeFromDowntime` porównuje `now - Date.parse(last_active_at)` z tym samym progiem 60 s, ale znacznik `last_active_at` jest zapisywany tylko co 60 s — w chwili zatrzymania daemona jest przestarzały o 0–60 s (średnio 30 s). Zwykły restart serwisu (redeploy, zmiana configu) trafia więc w karencję zawsze, gdy staleness + downtime > 60 s: przy 10 s downtime'u to ~17 % restartów, przy 30 s ~50 %, przy 60 s+ zawsze. Zweryfikowane wprost: `db.setState('last_active_at', now-65_000)` + `scheduler.start()` → `[scheduler] start po 65 s przerwy — karencja 45 s`, `shouldDeferAfterWake === true`. To łamie kontrakt zadeklarowany w tej samej fazie (test „krótka przerwa (zwykły restart serwisu) NIE włącza karencji"), który przechodzi tylko dlatego, że ustawia znacznik idealnie świeży (now-5 s) — sytuacja nieosiągalna przy granulacji 60 s. **Akcja:** użyć progu uwzględniającego granulację znacznika (`isWakeGap(lastMs, now, executor.SLEEP_GAP_MS + HEARTBEAT_INTERVAL_MS)`) i dołożyć test graniczny z `last_active_at = now - 65_000` asertujący BRAK karencji.

### 🟡 [P3] TEST — `lib/scheduler.test.js:404`
Brak testu na guard `hasPendingRuns` (`lib/scheduler.js:364`, decyzja #6 w kontekście: „przy pustej kolejce pętla ma się domknąć, a nie trzymać `queueProcessing` przez pół minuty"). Usunięcie tego warunku nie wywali dziś ani jednego testu — pętla trzymałaby flagę `queueProcessing` przez pełne 45 s po każdym wybudzeniu, a `stop()` tego nie przerywa. **Akcja:** obok testu karencji dopisać: `scheduler.markWakeDetected(Date.now())` + ZERO runów w kolejce → zmierzyć `Date.now()` wokół `await scheduler.processQueue()` i asertować rozwiązanie w < 1000 ms (oraz `t.after(() => scheduler.markWakeDetected(null))`).

### 🟡 [P3] KOD — `lib/scheduler.js:1`
`lib/scheduler.js` urósł do **655 linii** przy limicie 300 z `.claude/rules/coding-rules.md` (po Fazie 1 było 426, Faza 4 dołożyła +141). Kontekst fazy przyznaje dług, ale szew jest już wyraźny i wyjęcie go nie dotyka pętli kolejki. **Akcja:** przenieść blok „karencja po wybudzeniu" do nowego `lib/scheduler-wake.js` (`WAKE_GRACE_MS`, `isWakeGap`, `wakeGraceRemainingMs`, `shouldDeferAfterWake`, `markWakeDetected`/`getWakeDetectedAt`, `delayPromise`, `detectWakeFromDowntime` + `start/stopHeartbeat`) i re-eksportować ze `scheduler.js` dla zgodności istniejących importów i testów; `scheduler.js` schodzi wtedy do ~480 linii, a nowy moduł dostaje własny plik testowy.

### 🟡 [P3] KOD — `lib/scheduler.js:544`
`stopHeartbeat()` zeruje `lastHeartbeatAt`, ale `wakeDetectedAt` zostaje ustawione po zatrzymaniu schedulera — stan asymetryczny. Po sekwencji `stop()` → `start()` w tym samym procesie (testy, ponowna inicjalizacja) karencja z poprzedniego cyklu żyje dalej, mimo że `start()` i tak sam rozstrzyga wybudzenie przez `detectWakeFromDowntime`. Dlatego każdy test w tej fazie musi ręcznie wołać `scheduler.markWakeDetected(null)` w Arrange i w `t.after`. **Akcja:** dopisać `wakeDetectedAt = null;` obok `lastHeartbeatAt = null;` w `stopHeartbeat()` — stan wybudzenia należy do cyklu życia heartbeatu, który go produkuje.

### 🟡 [P3] KOD — `lib/scheduler.js:344`
N+1 w pętli drain: `startEligibleRuns` woła `db.getRecentSuccessDurations(jobId, 10)` osobno dla KAŻDEGO joba z kolejki i z aktywnych runów, i robi to przy każdej iteracji pętli (przy każdym dzwonku — zwolnienie slotu, `enqueueJob`, webhook, a od tej fazy również wygaśnięcie karencji). Każde zapytanie to `WHERE job_id=? AND status='success' ORDER BY id DESC LIMIT 10` po `idx_runs_job_id`, więc dla joba routine trzymającego dobę runów (inbox sync co minutę ≈ 1440 wierszy) to skan + sort na wywołanie, mnożony przez liczbę jobów. **Akcja** zgodna z własnym learned-patternem projektu („Top N per grupa = window function"): dodać `db.getRecentSuccessDurationsForJobs(jobIds, limit)` z `ROW_NUMBER() OVER (PARTITION BY job_id ORDER BY id DESC)` + filtr `rn <= limit` i jednym wywołaniem zbudować `durationsByJob`.

### 🟡 [P3] KOD — `docs/active/rownolegle-joby/rownolegle-joby-kontekst.md:453`
Zapis długu podaje nieaktualny rozmiar pliku: „`lib/scheduler.js` urósł do ~560 linii", a `wc -l lib/scheduler.js` na HEAD daje **655** (limit z coding-rules = 300). Skoro to jedyny ślad tego długu przed decyzją o wydzieleniu modułu „wake", liczba powinna być prawdziwa. **Akcja:** poprawić „~560" na 655. *(Finding zgłoszony jako `:75`; faktyczna lokalizacja to linia 453.)*

### 🟡 [P3] KOD — `lib/scheduler.js:176`
Martwe guardy defensywne na scenariusz, który nie może wystąpić i który i tak jest obsłużony przez samą arytmetykę. W `isWakeGap` (l. 176) `Number.isFinite(gap) && gap > sleepGapMs` — dla `gap = NaN` porównanie `NaN > x` jest już `false`, więc człon `Number.isFinite` nie zmienia wyniku; jedyny wołający z zewnętrznym wejściem (`detectWakeFromDowntime`, l. 556) ma własny `Number.isFinite(lastMs)` przed wywołaniem. Analogicznie w `wakeGraceRemainingMs` (l. 185) `!Number.isFinite(since)` — dla `NaN` dalsze `since < 0` i `since < graceMs` są `false`, więc funkcja i bez tego zwraca 0. Żaden test nie pokrywa tych gałęzi. **Akcja:** usunąć `Number.isFinite(gap) &&` z l. 176 i `!Number.isFinite(since) ||` z l. 185 (zostawić `Number.isFinite(lastMs)` w `detectWakeFromDowntime` jako jedyną, realną walidację `Date.parse`).

### 🟡 [P3] TEST — `lib/scheduler.test.js:404`
Testowany jest wyłącznie run stojący w kolejce PRZED wejściem w pętlę drain; brak przypadku „run zakolejkowany W TRAKCIE karencji", czyli tej ścieżki, dla której timer karencji jest własnym bodźcem (decyzja #6). **Akcja:** w teście karencji odpalić `scheduler.processQueue()` z PUSTĄ kolejką po `markWakeDetected(Date.now() - (WAKE_GRACE_MS - 400))`, potem `db.createRun(...)` + `scheduler.enqueueJob(job.id, 'scheduled')` w oknie karencji i asertować `status === 'success'` oraz `started_at - t0 >= remainingMs - 50`.

### 🟡 [P3] TEST — `lib/scheduler.test.js:453`
Brak testu invalid input dla `detectWakeFromDowntime`: guard `Number.isFinite(lastMs)` (`lib/scheduler.js:556`) chroni przed śmieciowym `last_active_at` (`Date.parse` → `NaN`), ale żaden test go nie dotyka — usunięcie guardu przechodzi na zielono. **Akcja:** dopisać test `db.setState('last_active_at', 'nie-data'); scheduler.markWakeDetected(null); scheduler.start(); assert.equal(scheduler.getWakeDetectedAt(), null)` z tym samym `t.after` co sąsiednie testy `start()`.

---

## Odchylenia od planu

- **Checkbox „Wykrycie wybudzenia z luki w heartbeacie (wzorzec progu: `executor.js:20-31`, `SLEEP_GAP_MS`)" odhaczony, ale wzorzec przeniesiono niepoprawnie.** W executorze `SLEEP_GAP_MS` działa, bo tamtejszy tick to 5 s (12× zapasu); w schedulerze tick to 60 s = dokładnie próg, więc mechanizm odpala się na każdym tyknięciu (P1). Sam próg przeniesiono, warunek jego poprawności — nie.
- **Checkbox „Test: zwykły ruch kolejki (bez wybudzenia) nie jest opóźniany o ani jeden tick" jest zielony przy złamanym zachowaniu produkcyjnym** — mock timers dają gap równy progowi, wartość nieosiągalną na realnym event loopie (P2 TEST).
- **Karencja obejmuje wszystkie joby, ale wpina się tylko w heartbeat.** Rozstrzygnięcie „karencja dla wszystkich jobów, sztywne czekanie" zapisano i zaimplementowano, natomiast detekcja siedzi poza pętlą kolejki, więc pierwszy run po pobudce (typowo `* * * * *`) ją omija (P2 KOD).
- **Dług rozmiaru pliku rośnie i jest udokumentowany błędną liczbą** — 655 linii vs zapis „~560" w kontekście fazy (P3).

---

## Bookkeeping checkboxów Weryfikacja:

- Odznaczone automatycznie (CLI/grep): **2**
- Odznaczone na podstawie Agent 5 E2E: **0** (tester E2E nie odpalił w tej fazie — routing pominął: brak warstwy UI, 0 browserowych checkboxów `Weryfikacja:`)
- Pozostawione dla operatora (Manual): **0**
- Niejasne (P3): **0**
- Failujące (P2): **0**

### Szczegóły

- [x] CLI: `node --test lib/scheduler.test.js` przechodzi → PASS (exit 0; 51 tests, 51 pass, 0 fail, 11,2 s)
- [x] CLI: `npm test` przechodzi w całości → PASS (exit 0; 790 tests, 790 pass, 0 fail, 11,3 s)

Bookkeeping nie dołożył żadnego nowego P2 ani P3 — severity gate z sekcji „Statystyki" pozostaje bez zmian.

> **Uwaga:** zielona suita **nie** jest dowodem poprawności tej fazy — P1 i P2 TEST opisują dokładnie klasę błędu, którą ta suita przepuszcza (mock timers dają gap równy progowi, nieosiągalny w produkcji).

---

## Przebieg review

| Etap | Wartosc |
|---|---|
| Pliki w fazie (z tego kodu) | 5 (2) |
| Flagi warstw | ui=false dane=true typowanie=false nowyModul=false |
| Browserowe checkboxy `Weryfikacja:` | 0 |
| Reviewerzy aktywni | security, performance, spec-compliance, simplicity, test-coverage |
| Reviewerzy pominieci | architecture (domena nieobecna w mapie zmian fazy); typescript (domena nieobecna w mapie zmian fazy); e2e (brak warstwy UI i zero browserowych checkboxow Weryfikacja: (0)) |
| Findingi: znalezione -> dedup JS -> dedup semantyczny | 28 -> 28 -> 13 |
| Adversarial verify: weryfikowane / obalone / bez glosow | 6 / 1 / 0 |
