# Review Fazy 1 — Równoległość

**Zadanie:** `docs/active/rownolegle-joby` · **Faza:** 1 (Unity 1-6)
**Data:** 2026-07-30 · **Branch:** `feature/rownolegle-joby`

---

## Werdykt

⚠️ **KONTYNUUJ Z ZASTRZEŻENIAMI** — 0 problemów P1, **5 problemów P2** do naprawy, 17 P3 do rozważenia,
4 pozycje dla operatora (poza zakresem fix).

| Metryka | Wartość |
|---|---|
| Severity gate | **ZASTRZEZENIA** |
| P1 (blocking, KOD/TEST/E2E) | 0 |
| P2 (important, KOD/TEST/E2E) | 5 |
| P3 (nit, KOD/TEST/E2E) | 17 |
| OPERATOR (poza fix) | 4 |
| E2E: passed / failed / skipped | 1 / 1 / 3 |
| Bookkeeping `Weryfikacja:` — PASS / FAIL / SKIP | 8 / 0 / 1 |

**Streszczenie w jednym zdaniu:** rdzeń równoległości działa i cała suita (707 testów) jest zielona,
ale pętla drain ma trzy defekty żywotności/współbieżności (livelock po odrzuconej obietnicy, slot
nieoddawany na `'exit'`, brak dzwonka po zmianie limitu z dashboardu), a nowe endpointy mutujące nie
mają guardu cross-origin.

---

## Findingi

### 🔴 P1 — blokujące

Brak.

---

### 🟠 P2 — ważne

#### P2-1 · KOD · `server.js:295`

Nowe endpointy MUTUJĄCE bez guardu cross-origin przy globalnym `Access-Control-Allow-Origin: *`.
Serwer ustawia ACAO `*` + `Allow-Methods: GET,POST,PUT,DELETE,OPTIONS` + `Allow-Headers: Content-Type`
i odpowiada 204 na preflight (`server.js:708-715`), więc dowolna strona odwiedzona przez usera może
zrobić `fetch('http://localhost:7777/api/settings/concurrency', {method:'PUT', …})` (preflight
przechodzi) oraz `fetch('http://localhost:7777/api/runs/<id>/kill', {method:'POST'})` (simple request,
bez preflightu) i ODCZYTAĆ odpowiedź. Efekt: obca strona podmienia limit współbieżności tej maszyny
(1 = zdławienie schedulera, 10 = szybsze wypalenie okna planu Claude) i ubija biegnące runy usera.
Guard XFF tego nie łapie — żądanie z przeglądarki idzie BEZ `X-Forwarded-For` (dokładnie learned
pattern `docs/solutions/auth-issues/2026-07-24`). Notatka wykonawcza #7 uzasadnia brak guardu tym, że
„endpoint nie zwraca sekretu" — to zamyka wektor ODCZYTU sekretu, ale nie wektor ZAPISU cross-origin.

**Akcja:** wołać `isCrossOriginRequest(req)` → 403 na gałęzi `PUT /api/settings/concurrency`
(`server.js:302`) oraz na `POST /api/runs/:id/kill` (`server.js:464`) i `POST /api/runs/current/kill`
(`server.js:452`), analogicznie do `/api/inbox/members` (`server.js:502`). Bezpieczne dla proxy:
`proxyToVps` wysyła wyłącznie `Content-Type`, więc żądanie przez `/api/vps/*` dociera do VPS bez
`Origin` i guard je przepuszcza. Ta sama luka dotyczy istniejących `POST/PUT /api/jobs` (tam skutek
jest poważniejszy: job `claude` z dowolnym promptem + `--dangerously-skip-permissions` = RCE), więc
docelowo guard powinien objąć wszystkie metody mutujące w `handleApi`.

#### P2-2 · KOD · `lib/scheduler.js:198`

**Livelock pętli drain, gdy `executor.executeRun()` odrzuci obietnicę.** `startRun` łapie błąd,
loguje i usuwa wpis z `inFlight`, ale NIE zmienia statusu runu — run zostaje `queued`, więc następna
iteracja `startEligibleRuns` pickuje go ponownie, bez backoffu. Zweryfikowane empirycznie (podmiana
`executor.executeRun` na `() => Promise.reject(...)`, baza `:memory:`): `processQueue()` nigdy się nie
rozwiązuje, log leci w kółko („[scheduler] run #1 zakończony błędem: boom"), a ponieważ wszystkie
obietnice w `Promise.race([...running, waitForNewWork()])` są już rozstrzygnięte, pętla nie oddaje
kontroli do fazy timerów — `setTimeout(3000)` NIE odpalił przez 20 s. To znaczy: zatrzymany heartbeat,
cron i HTTP serwera, czyli zamrożony demon zamiast jednego padniętego runu. Wyzwalacz: dowolny wyjątek
z `db.getJob`/`db.updateRun` w `executeRun` (np. SQLITE_BUSY/IO na `data/claude-cron.db`) albo
synchroniczny throw ze `spawn()` w ścieżce script — czyli droga, która przed tą fazą kończyła się
głośnym padem (`await` w pętli), a dziś kończy się cichym zwisem.

**Akcja:** w `catch` oznaczyć run jako `failed` (albo `queued` + opóźnienie) tak, by opuścił kolejkę,
i dołożyć test „executeRun rzuca → run kończy jako `failed`, `processQueue()` rozwiązuje się,
`executeRun` wołany raz".

#### P2-3 · KOD · `lib/scheduler.js:191`

**Zwolnienie wpisu na `'exit'` z karencją NIE przekłada się na slot pickera.** `mergeActiveRuns(executor.getActiveRuns(), inFlight)`
bierze SUMĘ, a `inFlight` czyści się dopiero w `finally` po `await executor.executeRun(run)`
(`scheduler.js:207`), czyli dopiero na `'close'`. Zweryfikowane empirycznie: `max_concurrent=1`, job
skryptowy odpalający wnuka dziedziczącego stdio i kończący się natychmiast —
`executor.getActiveRuns().length === 0` już po 2 s (`EXIT_RELEASE_GRACE_MS` działa), ale kolejny run
wystartował dopiero po 12,2 s, gdy zdechł wnuk i przyszło `'close'`. Ścieżka `claude` nie ma
ratunkowego timera znanego z `executeScriptRun` (`executor.js:455`), więc gdy `'close'` nie przyjdzie
NIGDY, promise nie rozwiąże się, slot przepada na stałe, a `processQueue` nie rozwiąże się i
`queueProcessing` zostaje `true` aż do restartu — dokładnie ten „cichszy objaw" (ciche zmniejszenie
limitu współbieżności), przed którym ostrzega `docs/solutions/2026-07-14` i checkbox Unit 2.

**Akcja:** domknąć wpis `inFlight` tym samym mechanizmem co w executorze (sygnał/wyścig zwolnienia
z executora zamiast czekania wyłącznie na `executeRun`), a okno retry-checku, dla którego powstała
suma, pokryć osobnym licznikiem.

#### P2-4 · E2E · `server.js:307`

**Zapis „Ile zadań naraz" z dashboardu NIE budzi drainu kolejki** — podniesienie limitu nie startuje
czekających runów aż do następnego dzwonka. `PUT /api/settings/concurrency` robi wyłącznie
`db.setState(...)` i zwraca JSON; nie woła `scheduler.processQueue()`, a pętla drain czeka na
`Promise.race([...aktywne runy, waitForNewWork()])` i nie ma żadnego okresowego re-picku. Odtworzone
na żywo: przy 1 biegnącym runie i 1 runie w kolejce `PUT {max_concurrent:3}` (potwierdzone GET-em:
`{"max_concurrent":3}`) NIE uruchomił runu z kolejki — trzy sondy `/api/status` co 5 s dawały
`n_running=1, queue=1`; dopiero `POST /api/jobs/2/trigger` (dzwonek z `enqueueJob`) spowodował
`n_running=2`. User podnosi limit widząc „Kolejka 1" i nic się nie dzieje aż do zakończenia któregoś
runu (przy timeout 10 min to nawet kilkanaście minut ciszy) — czyli dokładnie ten objaw, przed którym
broni dzwonek (komentarz w `scheduler.js:150`). Komentarz w `server.js:302` i `scheduler.js:233`
obiecuje „zmiana z dashboardu działa bez restartu daemona" — działa, ale nie od razu.

**Akcja:** w handlerze PUT po `db.setState(scheduler.MAX_CONCURRENT_STATE_KEY, ...)` (`server.js:307`)
dołożyć ten sam wzorzec co `enqueueJob` (`scheduler.js:272`):
`scheduler.processQueue().catch((err) => console.error('[scheduler] processQueue:', err.message));`
przed `return json(...)`. Test: przy zajętym slocie i runie w kolejce PUT z wyższym limitem startuje
run bez dodatkowego enqueue.

#### P2-5 · TEST · `lib/scheduler.test.js:584`

**Test opisany jako „(odbiór R1)" nie sprawdza tego, co R1 gwarantuje.** Joby `r1-long` i `r1-short`
powstają bez ani jednego udanego runu, więc `classifyJob` klasyfikuje OBA jako `'long'` (fail-safe),
a przy domyślnym `max_concurrent=3` budżet długich wynosi 2 — krótki run startuje dzięki wolnemu
slotowi, nie dzięki slotowi rezerwowemu. Test przechodzi także przy zepsutej klasyfikacji i rezerwie
(mierzy wyłącznie dzwonek). W efekcie szew `db.getRecentSuccessDurations` → `classifyJob` →
`pickEligibleRuns` (`scheduler.js:214-240`) nie ma ŻADNEGO pokrycia integracyjnego — złe kluczowanie
`durationsByJob` przeszłoby przez wszystkie zielone testy czystych funkcji, co jest wprost zakazane
przez learned-pattern 2026-07-03.

**Akcja:** dopisać test drainu z `max_concurrent=2`, jobem krótkim mającym realną historię udanych
runów ~1 s i jobem długim bez historii — krótki musi wystartować, drugi długi zostać `queued`.

---

### 🟡 P3 — nity

| # | Typ | Plik | Skrót |
|---|---|---|---|
| P3-1 | KOD | `lib/inbox-seed.js:45` | `lock_group:'dashboard'` nie zadziała na istniejących instalacjach (tylko `createJob`) |
| P3-2 | KOD | `lib/scheduler.js:225` | N+1 query w pętli drain — `getRecentSuccessDurations` per job, per iteracja |
| P3-3 | KOD | `lib/executor.js:313` | Bufor stdout bez limitu ×`max_concurrent` — ryzyko OOM na VPS 1 GB |
| P3-4 | KOD | `lib/scheduler.js:1` | 452 linie / 3 odpowiedzialności — wydzielić `lib/queue-picker.js` |
| P3-5 | KOD | `lib/db.js:366` | `getQueueWaitStats` bez call-site'u — metryka odbioru sprintu nieodczytywalna |
| P3-6 | E2E | `…-zadania.md:110` | Trzy scenariusze `[E2E]` Unit 5 nieodegrane (DOM, `killRun`, round-trip pól) |
| P3-7 | TEST | `lib/scheduler.test.js:484` | Wyłączność (`lock_group`/`skill_name`/`command`) bez testu na żywej pętli drain |
| P3-8 | KOD | `lib/db.js:341` | `getRunningRuns()` `SELECT *` → `webhook_payload`/`stdout` w `/api/status` i 409 |
| P3-9 | KOD | `server.js:464` | Run zwolniony po `'exit'` — kill zwraca `false`, wiersz wisi do total timeoutu |
| P3-10 | KOD | `lib/db.js:341` | `SELECT *` = ~64 KB/s payloadu do przeglądarki co 3 s (duplikat perspektywy P3-8) |
| P3-11 | KOD | `server.js:442` | `GET /api/runs/current` wciąż `getCurrentRun()` — dwie definicje „pierwszego biegnącego" |
| P3-12 | KOD | `lib/scheduler.js:448` | Martwe eksporty `FAST_THRESHOLD_MS`, `DEFAULT_MAX_CONCURRENT` |
| P3-13 | KOD | `lib/executor.js:27` | Martwe pole `startedAt` w `activeRuns`/`getActiveRuns()` |
| P3-14 | KOD | `lib/scheduler.js:102` | Podwójna sanityzacja limitu (`readMaxConcurrent` + `pickEligibleRuns`) |
| P3-15 | KOD | `lib/executor.js:538` | `getCurrentRunId` eksportowany jako shim bez żadnego call-site'u |
| P3-16 | KOD | `lib/scheduler.js:54` | `resolveMaxConcurrent` bez sufitu — `state.max_concurrent=999` → 999 agentów |
| P3-17 | TEST | `lib/scheduler.js:126` | Gałąź runu osieroconego (job skasowany) bez testu |

**Szczegóły wybranych P3:**

- **P3-1 (`lib/inbox-seed.js:45`)** — ochrona R5 dla znanej kolizji `Zadania/Dashboard.md` nie zadziała
  na ŻADNEJ istniejącej instalacji: `lock_group` jest w definicji używanej wyłącznie przy `createJob`
  (świadomie zero `UPDATE`), a na każdej maszynie job „Team OS — inbox sync" już istnieje → kolumna
  `NULL`. Jednocześnie po deployu `max_concurrent=3` włącza równoległość od pierwszego bootu, więc
  sync (pull przepisuje blok bannera w całości) może biec równolegle z `/daily` piszącym ten sam plik.
  Akcja: albo jednorazowy backfill w `migrate()` owinięty sentinelem w `state` (wzorzec
  `wake_backfill_done`), albo jawny krok `Operator:` „ustawić `lock_group=dashboard` na istniejącym
  jobie sync na Macu i VPS".
- **P3-2 (`lib/scheduler.js:225`)** — `startEligibleRuns` odpala `db.getRecentSuccessDurations(jobId, 10)`
  osobnym zapytaniem dla KAŻDEGO unikalnego joba, w KAŻDEJ iteracji `while` (po każdym runie i każdym
  dzwonku; dzwoni każdy `enqueueJob`, webhook, trigger). Próbki pobierane także dla jobów, których
  picker nie dotknie (`break` na `used >= limit`). Burst `detectMissedJobs` = N dzwonków × N zapytań.
  W repo jest gotowy wzorzec: `getRecentRunsPerJob` (`lib/db.js:256`, `ROW_NUMBER() OVER (PARTITION BY job_id …)`).
  Akcja: `getRecentSuccessDurationsByJob(jobIds, limit)` wołane RAZ + memoizacja w obrębie `processQueue`.
- **P3-3 (`lib/executor.js:313`)** — `stdout += chunk.toString()` akumuluje CAŁE wyjście, a przycięcie
  do `MAX_LOG_SIZE` (50 KB) następuje dopiero przy finalizacji. Przed tą fazą globalny slot gwarantował
  jeden bufor; teraz do 10. Akcja: przycinać przyrostowo w handlerze `data`
  (`if (stdout.length > MAX_LOG_SIZE * 4) stdout = stdout.slice(-MAX_LOG_SIZE * 2)`), to samo dla `stderr`.
- **P3-16 (`lib/scheduler.js:54`)** — sprawdzone: `db.setState('max_concurrent','999')` →
  `readMaxConcurrent() === 999`. `MAX_CONCURRENT_CEILING = 10` pilnuje wyłącznie wejścia z API.
  Akcja: `Math.min(parsed, MAX_CONCURRENT_CEILING)` + asercja w istniejącym teście.

---

## Odchylenia od planu

1. **`lib/scheduler.js` przekroczył limit 300 linii** (452) — kontekst fazy sam to odnotowuje w sekcji
   „Dług do domknięcia". Zgłoszone jako P3-4, bo naruszenie powstało w TEJ fazie.
2. **Trzy `Test: [E2E]` z Unit 5 (linie 110-112) nieodegrane** — pokrycie zastępcze (helpery
   `render-helpers.test.js` + `server.runs.test.js`) jest zielone, ale nie dotyka DOM-u ani
   `onclick="killRun(...)"`.
3. **`getQueueWaitStats` bez konsumenta** — plan sprintu czyni tę wartość podstawową metryką odbioru
   (R8), a dziś nie da się jej odczytać z dashboardu, API ani skilla `/puls` (P3-5).

---

## Zgodność ze spec

| Wymaganie planu | Stan |
|---|---|
| R1 — krótki dokolejkowany w trakcie długiego kończy się przed nim | ✅ w produkcji, ⚠️ test odbiorczy nie mierzy rezerwy (P2-5) |
| R5 — wyłączność `lock_group` chroni `Zadania/Dashboard.md` | ⚠️ działa w kodzie, ale nie na istniejących instalacjach (P3-1) |
| R7 — shimy `isRunning`/`getCurrentRunId`/`killCurrent` | ✅ (`getCurrentRunId` bez konsumenta — P3-15) |
| R8 — metryka oczekiwania w kolejce | ⚠️ policzalna tylko z `node -e` (P3-5) |
| R9 — retry przy równoległym drainie | ✅ test zielony |
| Kontrakt kolejności matcherów `server.js` | ✅ zweryfikowany gerpem: webhook (719) → ask (730) → inbox (735) → guard XFF (745) → api (751) |
| „640 istniejących testów bez modyfikacji" | ✅ `npm test` → 707 pass / 0 fail |

---

## Bookkeeping checkboxów Weryfikacja:

- Odznaczone automatycznie (CLI/grep): **8**
- Odznaczone na podstawie Agent 5 E2E: **0**
- Pozostawione dla operatora (Manual/E2E SKIP): **1**
- Niejasne (P3): **0**
- Failujące (P2): **0**

### Szczegóły

- [x] CLI: `node --test lib/db.test.js` przechodzi bez błędów → PASS (44 pass / 0 fail, exit 0)
- [x] CLI: `npm test` przechodzi w całości (Unit 1) → PASS (707 pass / 0 fail, exit 0)
- [x] CLI: `node --test lib/executor.test.js` przechodzi → PASS (27 pass / 0 fail, exit 0)
- [x] CLI: `npm test` przechodzi w całości (Unit 2) → PASS
- [x] CLI: `node --test lib/scheduler.test.js` przechodzi → PASS (39 pass / 0 fail, exit 0)
- [x] CLI: `npm test` przechodzi w całości (Unit 3) → PASS
- [x] CLI: `npm test` przechodzi w całości (Unit 4) → PASS
- [x] Grep: kolejność matcherów w `server.js` → PASS (`grep -n` → webhook 719 < ask 730 < inbox 735 < guard XFF 745 < handleApi 751; `/api/settings/concurrency` w `handleApi:295`)
- [x] CLI: `npm test` przechodzi (helpery frontu, Unit 5) → PASS
- [ ] E2E: scenariusz przez `/agent-browser` — dwa wiersze aktywnych runów + „Zatrzymaj" — **(SKIP — dashboard w przeglądarce nieodegrany; równoważny scenariusz zweryfikowany wyłącznie na poziomie HTTP na odizolowanej instancji)** → Operator checklist
- [x] CLI: `node --test lib/inbox-seed.test.js` przechodzi → PASS (14 pass / 0 fail, exit 0)
- [x] Grep: `grep -c "lock_group" skills/puls/SKILL.md` > 0 → PASS (5)

Uwaga: `npm test` powtarza się w pięciu Unitach — uruchomiony raz, wynik zastosowany do wszystkich
pięciu checkboxów (707 testów, exit 0).

---

## Operator checklist faza 1 (nie wchodzi do fix)

1. **Restart lokalnego daemona Pulsa** — proces na porcie 7777 (PID 8290) serwuje kod SPRZED commita
   `bde391d`; `GET /api/settings/concurrency` → 404, `/api/status` bez `current_runs`, a nowy
   `public/app.js` woła endpointy, których ten proces nie zna. Równoległość NIE jest aktywna na
   maszynie usera mimo zmergowanego kodu.
2. **Przebieg E2E w przeglądarce** (`/agent-browser`) — trzy scenariusze Unit 5 + `Weryfikacja:`
   z linii 114.
3. **Kill per run na Windowsie** — `taskkill /PID <pid> /T /F` przy dwóch równoczesnych drzewach
   procesów; cała suita równoległości jedzie na `spawn('node', …)` z Uniksa.
4. **Kroki deployowe** — rozstrzelenie cronów (VPS „CC Update", Mac poniedziałek 8:00) i ustawienie
   `max_concurrent` (VPS 3, Mac 2).

---

## Przebieg review

| Etap | Wartosc |
|---|---|
| Pliki w fazie (z tego kodu) | 21 (13) |
| Flagi warstw | ui=true dane=true typowanie=false nowyModul=true |
| Browserowe checkboxy `Weryfikacja:` | 1 |
| Reviewerzy aktywni | security, performance, architecture, spec-compliance, simplicity, test-coverage, e2e |
| Reviewerzy pominieci | typescript (domena nieobecna w mapie zmian fazy) |
| Findingi: znalezione -> dedup JS -> dedup semantyczny | 43 -> 42 -> 29 |
| Adversarial verify: weryfikowane / obalone / bez glosow | 15 / 2 / 0 |
