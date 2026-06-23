# Code Review — Faza 1 (Fundament: statyka, backend, moduł enumów)

Zadanie: `migracja-puls-rebrand`
Data review: 2026-06-23
Branch: `feature/migracja-puls-rebrand`
Status bramki: **⚠️ ZASTRZEZENIA — same P2, brak P1 blokujacych**

---

## Statystyki

| Kategoria | Liczba |
|---|---|
| 🔴 P1 (blocking, KOD/TEST/E2E) | 0 |
| 🟠 P2 (important, KOD/TEST/E2E) | 7 |
| 🟡 P3 (nit, KOD/TEST/E2E) | 11 |
| 🔧 OPERATOR (niewykonalne headless) | 1 |
| **Razem findings** | **19** |

Severity gate: **ZASTRZEZENIA** (zero P1, są P2 → kontynuacja z zastrzeżeniami, P2 do naprawy przed Fazą 2 tam, gdzie dotyczą uwydatnionego payloadu/scope).

Findings z bookkeepingu (krok 4.7): +1 P2 (Grep FAIL na `--mute`). Uwzględnione w liczniku P2 powyżej? — bookkeeping P2 trzymany jest osobno w sekcji bookkeepingu (nie jest osobnym `finding` w liście, bo to artefakt checkboxa, nie defektu kodu). Patrz sekcja „Bookkeeping checkboxów Weryfikacja:".

---

## Findings — P2 (important)

### P2-1 · KOD · `public/logo-puls.png`
Logo Puls waży 1.2 MB (1202743 B) — nieskompresowany PNG dla loga dashboardu. To 60x większy payload niż favicon (19 KB). Po podpięciu w nagłówku (Faza 2) będzie ładowany przy każdym wejściu na dashboard. Powinien być zoptymalizowany (kompresja PNG / WebP / downscale do realnej rozdzielczości wyświetlania, zwykle logo < 50 KB). Asset skopiowany 1:1 z puls-demo bez optymalizacji.

### P2-2 · KOD · `server.js:64-67`
`serveStatic` czyta plik synchronicznie (`fs.readFileSync`) i wysyła bez nagłówków `Cache-Control`/`ETag`/`Last-Modified`. Dla nowego 1.2 MB `logo-puls.png`: (a) `readFileSync` blokuje event-loop przy KAŻDYM żądaniu, (b) brak cache => przeglądarka re-pobiera logo przy każdym odświeżeniu dashboardu. To istniejący kod serwowania, ale Faza 1 wprowadza duży asset, który go uwydatnia. Dodać `Cache-Control: public, max-age=...` (+ETag) dla assetów statycznych.

### P2-3 · KOD · `lib/db.js:190-196`
`getRecentRunsPerJob` używa `SELECT *` — ciągnie kolumny `stdout/stderr/webhook_payload` dla aż N (do 50) runów per job. Endpoint `/api/runs/recent` zasila tylko sparkline + „ostatni run" (potrzebne: `id, job_id, status, started_at`). Na realnej bazie avg(stdout)=~6.5 KB/run (max 51 KB) → np. 7 runów x 10 jobów x 6.5 KB ~= 450 KB zbędnego payloadu na jeden poll endpointu, który stdout nigdy nie wyświetla. Naruszenie reguły §12 (select konkretnych kolumn). Wybrać jawnie tylko potrzebne kolumny.

### P2-4 · TEST · `server.js:134`
`computeNextRun` zawiera nietrywialną logikę (min-selekcja `next_run` po enabled jobach, porównanie stringów ISO przez `<`, pomijanie disabled i null nextRun), ale nie ma żadnego testu jednostkowego — zadeklarowana lokalnie w `server.js`, nieeksportowana → nietestowalna bez ekstrakcji. Plan przewidział tylko manualny `curl /api/status`. Reguła projektu: każda nowa funkcja = min. 1 happy path + 1 error case. Poprawność opiera się na niejawnym kontrakcie `getNextRun` → `toISOString()`. Rekomendacja: wyciągnąć `computeNextRun` do testowalnego modułu (`lib/`) i pokryć: brak enabled → null, kilka jobów → wybór minimalnego, job z null nextRun pomijany.

### P2-5 · KOD · `lib/config.js:10`
**Naruszenie twardej granicy scope.** Plan §Granice (linia 20) oraz źródło MIGRACJA-PULS.md §327 jawnie listują `lib/config.js` jako „NIE ruszamy". Unit 2/3 zmodyfikował `config.js`, dodając override `const DB_PATH = process.env.CLAUDE_CRON_DB || ...` na potrzeby izolacji bazy w testach. Zachowanie produkcyjne jest zachowane (default path niezmieniony → serwer NIE startuje z pustą bazą), więc realne ryzyko §0 nie zachodzi, ale: (a) plan nie autoryzował tej zmiany w żadnym Unicie Fazy 1, (b) źródło §292 przewidywało izolację testów przez tryb `:memory:` (better-sqlite3), a NIE przez nowy env override w config.js. Deliberate scope creep poza dwa autoryzowane miejsca backendu (server.js + lib/db.js). Wymaga świadomego sign-offu albo przeniesienia izolacji testowej do warstwy testu (`:memory:`/DI) bez dotykania config.js.

### P2-6 · TEST · `server.js:133-146`
`computeNextRun` (nowa funkcja Fazy 1, wymaganie R7 — zasila pole `next` w globalnym statbarze) NIE ma żadnego testu. Plan techniczny (Unit 3) zdefiniował scenariusze tylko dla `getTodayRunStats`, pominął `computeNextRun` mimo że to nowa logika. Nieprzetestowane: wybór min `next_run` spośród enabled jobów, pomijanie disabled, zwrot null gdy żaden job nie ma zaplanowanego runu, spakowanie `{job_name,next_run}`. Funkcja testowalna jako czysta logika (stub `scheduler.getNextRun`). Brak: 1 happy path (min z 2 jobów) + 1 edge (null gdy brak/wszystkie disabled).

### P2-7 · E2E · `server.js:301-307`
Route `GET /api/runs/recent?per_job=N` ma tylko weryfikację [Manual] (curl) — brak automatycznego testu integracyjnego. Krytyczny dla poprawności jest porządek if-ów: route MUSI być dopasowany PRZED ogólnym matcherem `segments[1]==='runs'` (komentarz w kodzie to potwierdza), inaczej zostanie złapany przez `/api/runs` i zwróci zły kształt. Ta regresja routingu nie jest pokryta żadną asercją headless — wymaga wstania serwera HTTP (out of scope dla `node:test` bez harnessu), stąd E2E.

---

## Findings — P3 (nit)

### P3-1 · KOD · `lib/db.js:189`
`getRecentRunsPerJob` używa `SELECT *` na `runs`, więc zwraca też pełne `stdout/stderr/error_msg` dla N runów (cap 50) na job. Endpoint przeznaczony do sparkline + „ostatni run" (R6), gdzie pełne logi zbędne. Zwiększa data-exposure surface i payload. Zalecane: `SELECT id, job_id, status, trigger_type, started_at, finished_at`. Nie krytyczne — endpoint dziedziczy blok X-Forwarded-For (dostęp tylko przez Tailscale), a `/api/runs` robi to samo.

### P3-2 · KOD · `server.js:307`
Endpoint przekazuje surowy `params.get('per_job')` do `db.getRecentRunsPerJob` bez walidacji w warstwie API — walidacja (parseInt+fallback+cap) w warstwie db. Działa poprawnie (normalizuje nie-int/<=0/>cap), projekt nie ma Zod; dla pojedynczego inta manualny parseInt+cap akceptowalny. Obserwacja spójności, nie defekt.

### P3-3 · KOD · `server.js:144-157`
`computeNextRun` iteruje wszystkie joby liniowo per `/api/status`. `scheduler.getNextRun` czyta z in-memory Map (activeJobs) — brak N+1, koszt O(enabled jobs), akceptowalny. Uwaga: `/api/status` jest pollowany cyklicznie i dokłada `getTodayRunStats` (full scan po runs z filtrem `date(localtime)`); `idx_runs_started_at` istnieje, ale `date(started_at,'localtime')` jest nie-sargable → indeks nieużywalny. Mieć na uwadze przy dużej tabeli runs.

### P3-4 · KOD · `lib/db.js:182-194`
`SELECT *` nad podzapytaniem z window function → pomocnicza kolumna `rn` (ROW_NUMBER) wycieka do JSON-a `/api/runs/recent` (zweryfikowane: keys ...,webhook_payload,rn). Sibling `/api/runs` zwraca czyste wiersze bez `rn` → dwa endpointy „run" mają różny kształt wiersza (niespójność kontraktu + wyciek detalu implementacyjnego). Bez szkody funkcjonalnej (frontend ignoruje), ale czyściej: jawne kolumny w outer SELECT albo odfiltrować `rn`. Zgodne z planem (przykład SQL w Unit 2 też ma SELECT *) → nit projektowy, nie odstępstwo od planu.

### P3-5 · KOD · `server.js:303-306`
Route przekazuje surowe `params.get('per_job')` (string|null) wprost do helpera — cała walidacja w warstwie danych, nie na granicy API. Plan Unit 2 zakładał walidację na poziomie route, a §9 mówi „Waliduj KAŻDY input na granicy API". Zachowanie bezpieczne (helper normalizuje, pokryte testami) → uwaga o umiejscowieniu odpowiedzialności. Sibling `/api/runs` robi parseInt w route → drobna niespójność stylu.

### P3-6 · KOD · `server.js:134-146`
`computeNextRun` porównuje `next_run` przez `nextRun < best.next_run` na stringach ISO-8601 (`toISOString()`). Poprawne, bo stałoznakowy UTC z 'Z' → porządek leksykograficzny = chronologiczny. Niejawny kontrakt (zależy od formatu zwracanego przez scheduler); gdyby `getNextRun` zwracał Date/inny format, porównanie cicho pęknie. Wystarczy komentarz lub `new Date()`. Nit, brak realnego buga.

### P3-7 · KOD · `lib/db.js:188`
`getRecentRunsPerJob` — `SELECT *` na zewnętrznym zapytaniu → window-function `rn` wycieka do JSON `/api/runs/recent` (runtime: każdy wiersz ma `rn`:1..N). Detal implementacyjny na granicy API. Dodatkowo zwraca pełne stdout/stderr (do 50 per job) — spójne z `getRuns` (też SELECT *) → nie regresja, ale przy nowym endpoincie sparkline warto było wybrać tylko `id, job_id, status, started_at` i odfiltrować `rn`. Niski priorytet.

### P3-8 · KOD · `lib/db.js:getTodayRunStats`
Niedoprecyzowana w spec decyzja agregacji. R7 / źródło §4.1 (linia 161) definiują tylko „today_success/today_failed" z przykładem `12✓ 1✗` i `date(started_at)=date('now','localtime')`, bez wyspecyfikowania co wchodzi do „failed". Implementacja: failed = status IN ('failed','timeout','killed'), running/queued pomija z obu liczników. Rozsądna interpretacja (spójna z kanonem §4.0), ale nieudokumentowana decyzja wymuszona testem — potwierdzić, że statbar „Dziś" traktuje timeout/killed jako błędy.

### P3-9 · TEST · `lib/db.test.js:168-203`
`getRecentRunsPerJob`: route przekazuje surowy string z query param, ale branch dla wartości NIE-numerycznych ('abc', null) nie ma jawnej asercji. Zweryfikowane ręcznie: 'abc'→7, null→7, '-5'→7 (poprawny fallback). Pośrednio pokryte testem `per_job=0` (ten sam codepath), ale brak jawnego boundary testu dla string-nie-int — realnego inputu z HTTP.

### P3-10 · TEST · `lib/db.test.js:105-118`
Test regresji UTC („run tuż po północy lokalnej liczony jako dziś") zależny od strefy maszyny. W tym środowisku (UTC+2) ćwiczy bug granicy doby, ale w runnerze UTC (offset 0) `localMomentIso(0,0,30)` daje ten sam dzień w UTC i lokalnie → test przeszedłby trywialnie NIE wykrywając regresji localtime→UTC. Brak pinowania TZ (`process.env.TZ`) czyni asercję warunkowo bezużyteczną na CI w UTC. Pozostałe 22 testy pokryte poprawnie (23/23 PASS).

### P3-11 · E2E · `server.js:172-189`
Wzbogacenie `/api/status` o `today_success/today_failed/next` ma tylko weryfikację [Manual] (curl). Plan (Unit 3) dopuszcza zastąpienie integracyjnego `node -e` grepem na obecność kluczy w handlerze. Logika źródłowa (getTodayRunStats, computeNextRun) jest/powinna być testowana jednostkowo, ale fakt że handler faktycznie dokleja te 3 pola do JSON odpowiedzi nie ma asercji headless — kontrakt API niepokryty.

---

## Findings — OPERATOR (niewykonalne headless — Operator checklist)

### OP-1 · OPERATOR · `server.js:174-189`
Parytet surface API w trybie VPS: wzbogacony `/api/status` (today_success/today_failed/next) oraz nowy `/api/runs/recent` działają w trybie proxy VPS dopiero po deployu tego samego kodu na VPS (proxyToVps przekazuje 1:1). Do tego czasu statbar/sparkline w trybie VPS mogą mieć braki (graceful degrade). Weryfikacja parytetu wymaga realnego deploya na VPS — niewykonalna headless w tym review, nie defekt kodu Fazy 1.

---

## Bookkeeping checkboxów Weryfikacja:

Re-parsowano niezaznaczone `- [ ] Weryfikacja:` w Fazie 1 (Unity 1–4). Klasyfikacja i wykonanie:

- Odznaczone automatycznie (CLI/grep): **10**
- Odznaczone na podstawie Agent 5 E2E: 0
- Pozostawione dla operatora (Manual): 0
- Niejasne (P3): 0
- Failujące (P2): **1**

### Szczegóły

- [x] Grep: `test -f public/logo-puls.png && test -f public/favicon.png` → PASS (exit 0)
- [x] Grep: `grep -q '\.modal-overlay\[hidden\]' && grep -q '\.view\.active' public/style.css` → PASS
- [ ] Grep: `grep -q -- '--mute:#7d7d7d' public/style.css` → **FAIL (P2)** — wartość w CSS to `--mute: #7d7d7d;` (ze spacją po dwukropku), grep szuka bez spacji `--mute:#7d7d7d`. Token koloru jest POPRAWNY (#7d7d7d zgodny z demem), failuje tylko literalny wzorzec grep. Fix: poprawić wzorzec checkboxa na `--mute:[[:space:]]*#7d7d7d` albo dopasować formatowanie CSS do braku spacji.
- [x] CLI: `node --test lib/db.test.js` → PASS (11/11, exit 0)
- [x] CLI: `node -e "require('./lib/db').getRecentRunsPerJob"` → PASS (exit 0)
- [x] CLI: `node server.js` startuje i nasłuchuje na 7777 → PASS (curl `/api/status` zwrócił JSON, serwer wstał)
- [x] CLI: `node --test lib/db.test.js` (Unit 3) → PASS (11/11)
- [x] CLI: `node -e "require('./lib/db').getTodayRunStats"` → PASS (exit 0)
- [x] Grep: `/api/status` zwraca `today_success` i `next` (grep handlera w server.js) → PASS (oba klucze obecne w server.js)
- [x] CLI: `node --test public/enum-map.test.js` → PASS (12/12, exit 0)
- [x] CLI: `node -e "...mapStatus('failed').cls==='badge-err'..."` → PASS (exit 0)

Pełny zestaw `node --test`: **23/23 PASS** (db.test.js 11 + enum-map.test.js 12), exit 0.

---

## Decyzja severity gate (po bookkeepingu)

- P1 (blocking): 0
- P2 (important): 7 findings KOD/TEST/E2E + 1 z bookkeepingu (Grep FAIL `--mute`) = realnie 8 pozycji do naprawy/sign-offu
- P3 (nit): 11
- OPERATOR: 1

**⚠️ ZASTRZEZENIA — kontynuacja z zastrzeżeniami.** Brak P1 blokujących. Przed Fazą 2 zalecane domknięcie: P2-5 (scope creep config.js — wymaga sign-offu lub przeniesienia izolacji), P2-4/P2-6 (brak testów `computeNextRun`), P2-1/P2-2 (optymalizacja logo + cache, bo Faza 2 podpina logo w headerze), P2-3 (SELECT kolumn) oraz poprawka wzorca grep `--mute`.
