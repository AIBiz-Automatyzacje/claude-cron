# Zadania: Nadrabianie jobów przegapionych przez nocny restart VPS

**Branch:** `feature/nocny-restart-przegapione-joby`
**Ostatnia aktualizacja:** 2026-06-27

## Unit 1: `run_on_wake` opt-out — schema, createJob default, backfill
**Delegate:** feature-builder-data · **Wymagania:** R1, R2 · **Zależności:** brak

### Implementacja
- [x] `lib/db.js:39` — schema kolumny `run_on_wake` → `DEFAULT 1` (kosmetyczne, świeże bazy)
- [x] `lib/db.js:129` — `createJob` domyślny arg `run_on_wake = 1`, zachowaj jawne `? 1 : 0` przy bindowaniu
- [x] `lib/db.js` `migrate()` — po `CREATE TABLE state` dodać guarded backfill (odczyt `wake_backfill_done` z `state` przez przekazany `db`; brak → `UPDATE jobs SET run_on_wake = 1` → ustaw flagę)
- [x] `lib/db.test.js` — testy (backfill test-first, zob. niżej)

### Testy
- [x] Test: `createJob` bez `run_on_wake` → job ma `run_on_wake === 1` (happy path R1)
- [x] Test: `createJob({ run_on_wake: 0 })` → job ma `run_on_wake === 0` (opt-out działa)
- [x] Test: Backfill — seed 2 joby z `run_on_wake=0` przed flagą → po `migrate` oba mają `1`, flaga `wake_backfill_done` ustawiona (R2 happy path)
- [x] Test: Idempotencja — po backfillu ustaw ręcznie job na `0`, wywołaj `migrate` ponownie → job pozostaje `0` (flaga blokuje re-backfill, error case R2)

### Weryfikacja
- [x] Weryfikacja: `node --test lib/db.test.js` przechodzi bez błędów
- [x] Weryfikacja: `grep -n "DEFAULT 1" lib/db.js` pokazuje kolumnę `run_on_wake` ze schematem `DEFAULT 1`

---

## Unit 2: Fix strefy w `detectMissedJobs` + ekstrakcja pure `computeMissedJobs`
**Delegate:** feature-builder-data · **Wymagania:** R3 · **Zależności:** brak (równoległy do Unit 1)

### Implementacja
- [x] `lib/scheduler.js` — wyciągnij pure `computeMissedJobs(jobs, lastActive, now, timezone)` (filtruje `enabled && run_on_wake`, `new Cron(expr, { timezone })`, `nextRun(lastActive) < now`; try/catch na zły cron wewnątrz)
- [x] `lib/scheduler.js` — `detectMissedJobs` cienki wrapper: czyta `last_active_at`, `getAllJobs()`, `new Date()`, przekazuje `Intl.DateTimeFormat().resolvedOptions().timeZone`, `enqueueJob(id, 'wake')` dla zwróconych id
- [x] `lib/scheduler.test.js` — testy pure funkcji (test-first od scenariusza ze źródła)

### Testy
- [x] Test: Job `0 6 * * *`, `lastActive`=dziś 5:59, `now`=dziś 6:03, strefa lokalna → `[jobId]` (happy path R3)
- [x] Test: Ten sam job, `lastActive`=dziś 6:30, `now`=dziś 6:35 (strzelił przed downtime) → `[]` (brak podwójnego odpalenia)
- [x] Test: N przegapionych cykli (`*/5 * * * *`, `lastActive` 30 min temu) → job dokładnie raz (collapse)
- [x] Test: Job z `run_on_wake=0` lub `enabled=0` → pominięty (`[]`)
- [x] Test: Zły cron (`'garbage'`) → pominięty bez rzucenia wyjątku (error case)
- [x] Test: Strefa — ten sam `lastActive`/`now` z dwiema różnymi `timezone` daje różną granicę okna (regresja buga)

### Weryfikacja
- [x] Weryfikacja: `node --test lib/scheduler.test.js` przechodzi bez błędów
- [x] Weryfikacja: `grep -n "timezone" lib/scheduler.js` pokazuje strefę w ścieżce detekcji przegapionych (nie tylko w `scheduleJob`)

---

## Unit 3: `MAINTENANCE_WINDOW` w config.js + ekspozycja przez `/api/env`
**Delegate:** feature-builder-data · **Wymagania:** R4 · **Zależności:** brak

### Implementacja
- [x] `lib/config.js` — dodaj `MAINTENANCE_WINDOW = { startHour: 6, startMin: 0, endHour: 6, endMin: 15 }` + eksport; komentarz z odwołaniem do potwierdzenia empirycznego
- [x] `server.js:178-181` — `GET /api/env` zwraca `maintenance_window: MAINTENANCE_WINDOW`

### Testy
- [x] Test: (pokrycie pośrednie w Unit 4) helper overlap przyjmuje ten kształt window i poprawnie klasyfikuje

### Weryfikacja
- [x] Weryfikacja: `grep -n "MAINTENANCE_WINDOW" lib/config.js server.js` pokazuje definicję i użycie w `/api/env`
- [x] Weryfikacja: `node --test` (cały suite) przechodzi bez regresji

### Operator checklist *(brak `.env.e2e`)*
- [ ] Operator odpala serwer i `curl localhost:7777/api/env` → widzi `maintenance_window` z `startHour: 6`

---

## Unit 4: Warning okna restartu + domyślny checkbox wake + pure helper overlap
**Delegate:** feature-builder-ui · **Wymagania:** R1 (UI default), R5 · **Zależności:** Unit 3

### Implementacja
- [x] `public/render-helpers.js` — pure `overlapsMaintenanceWindow(cronExpr, window)` (reuse `parseCronForCalendar`; `null` → false; `highFreq` → true; inaczej porównaj `{hour, minute}` z `[start, end]`) + eksport w `api`
- [x] `public/app.js` — `openCreateModal` → `form-wake.checked = true`; jednorazowy fetch `maintenance_window` z `/api/env`; w `updateSchedulePreview` policz overlap dla `buildCronFromForm()` i pokaż/ukryj warning
- [x] `public/index.html:217` — `<div id="maintenance-warning" class="hint" hidden>` obok `#schedule-preview`; treść „⚠ Pokrywa się z nocnym restartem VPS (06:00) — zostanie nadrobione po starcie"
- [x] `public/render-helpers.test.js` — testy pure helpera (test-first)

### Testy
- [x] Test: `overlapsMaintenanceWindow('0 6 * * *', window)` → `true` (job dokładnie o 6:00)
- [x] Test: `overlapsMaintenanceWindow('10 6 * * *', window)` → `true` (6:10 w oknie)
- [x] Test: `overlapsMaintenanceWindow('0 9 * * *', window)` → `false` (9:00 poza oknem)
- [x] Test: `overlapsMaintenanceWindow('*/5 * * * *', window)` → `true` (highFreq odpala też w oknie)
- [x] Test: `overlapsMaintenanceWindow('', window)` / niepoprawny → `false` (brak crashu, error case)
- [ ] Test (E2E): otwórz formularz nowego joba → checkbox „Uruchom po przebudzeniu" zaznaczony domyślnie (R1) — *przeniesione do Operator checklist (brak harnessu E2E)*
- [ ] Test (E2E): freq=daily, godzina 06:05 → `#maintenance-warning` widoczny; zmień na 09:00 → ukryty (R5) — *przeniesione do Operator checklist (brak harnessu E2E)*

### Weryfikacja
- [x] Weryfikacja: `node --test public/render-helpers.test.js` przechodzi bez błędów
- [ ] Weryfikacja: [E2E przez /agent-browser] formularz nowego joba — checkbox wake zaznaczony, godzina 06:05 pokazuje `#maintenance-warning` (`hidden` zdjęte w DOM) — wymaga operatora (checklist): brak harnessu E2E headless, przeniesione do Operator checklist faza 4

### Operator checklist *(brak `.env.e2e`)*
- [ ] Operator wizualnie potwierdza, że warning jest czytelny i nie blokuje zapisu joba

---

## Do poprawy po review fazy 4

Severity gate: **ZASTRZEZENIA** — jeden P2 (typ E2E). Brak P1.

P2 (important — do naprawy):

- [x] 🟠 [P2] **public/app.js:1138** — Pobranie `maintenance_window` z `/api/env` i zapis do stanu modułu (`maintenanceWindow`) nie ma testu integracyjnego. Plan Unit 3 przewidział [E2E] `curl /api/env` → obecność `maintenance_window` ze `startHour:6`, z fallbackiem na Operator checklist gdy brak `.env.e2e`. Realnie weryfikowalne tylko przez uruchomiony serwer (operator). — NAPRAWIONE (review fazy 4): dodano integracyjny test `server.env.test.js` (boot serwera jako proces potomny → `GET /api/env` → asercja `maintenance_window` === `MAINTENANCE_WINDOW` z config, `startHour:6`). E2E zweryfikowane na realnie wystartowanym serwerze: `curl localhost:7799/api/env` → `{"maintenance_window":{"startHour":6,"startMin":0,"endHour":6,"endMin":15}}` PASS. Suite 108/108.

P3 (nity — opcjonalne, nie blokują fazy):

- [ ] 🟡 [P3] **public/app.js:820** — `openCreateModal` ustawia `form-wake.checked=true` (R1 domyślny wake) — brak automatycznego testu (DOM). Plan wymienił to jako osobny [E2E] scenariusz. Weryfikowalne tylko w realnym formularzu (E2E/operator).
- [ ] 🟡 [P3] **public/app.js:270-279** — `updateMaintenanceWarning(cron)` wywoływane dwukrotnie w `updateSchedulePreview` (gałąź webhook-only przed return i po niej). Mała duplikacja wywołania pure helpera (O(1)). Można policzyć cron raz i wywołać warning jednokrotnie. Nit czytelności.
- [ ] 🟡 [P3] **public/render-helpers.js:187** — Parametr `window` przesłania globalny `window` przeglądarki (plik działa w Node i w przeglądarce). Działa poprawnie, ale zapach nazewniczy. Sugestia: `maintenanceWindow`/`windowConfig`.
- [ ] 🟡 [P3] **public/render-helpers.test.js:266** — highFreq godzinowy z minutą poza oknem nie ma testu rozróżniającego intencję — test używa `'0 */2 * * *'` (w oknie), helper zwraca `true` dla każdego highFreq niezależnie od minuty. Zgodne z planem (świadomy over-warn) — test nie dokumentuje granicy. Nit dokumentacyjny.
- [ ] 🟡 [P3] **public/app.js:282** — `updateMaintenanceWarning` (wiring DOM pokaż/ukryj `#maintenance-warning`) nie ma unit testu — pokryta tylko E2E/agent-browser. Zgodne ze split projektu. Reaktywność potwierdzona w kodzie.
- [ ] 🟡 [P3] **public/render-helpers.js:67** — Parametr `window` cieni globalny obiekt przeglądarki w pliku UMD. Pure helper, brak buga, ale pułapka czytelności. Sugestia: `maintenanceWindow`.
- [ ] 🟡 [P3] **public/app.js:282** — `updateMaintenanceWarning(cron)` — `cron` może być `null` (webhook-only); helper poprawnie zwraca `false`. Nit: kontrakt `cron: string|null` nigdzie nie zadeklarowany (projekt bez JSDoc). Zerowy wpływ.
- [ ] 🟡 [P3] **public/render-helpers.js:77** — Parametr `window` cieni globalny obiekt przeglądarki. Pure, brak defektu, shadowing stylistycznie ryzykowny. Plan sam używał `window` jako arg.
- [ ] 🟡 [P3] **public/render-helpers.js:78** — Świadomy false-positive (plan linie 104,117): dla highFreq helper zawsze `true`, więc `'0 */5 * * *'` (nie trafia w 06:00) pokaże warning. Celowy heurystyk R5, nie defekt — potencjalny szum UX do wizualnego potwierdzenia.
- [ ] 🟡 [P3] **public/app.js:271** — Scenariusze E2E Unit 4 (checkbox wake domyślny; 06:05 pokazuje warning, 09:00 ukrywa) bez testu automatycznego — wiring poprawny, logika pokryta unit (43/43 PASS). Brak realnego E2E w repo.
- [ ] 🟡 [P3] **public/render-helpers.test.js:271** — Pure helper ma pełne pokrycie unit (43 PASS): 5 scenariuszy z planu + granice 6:15 inclusive, 5:59/6:16, highFreq, nieobsługiwany kształt, brak window. Brak luk w warstwie pure.
- [ ] 🟡 [P3] **public/render-helpers.test.js:239** — Komentarz fixture odwołuje się do "review-faza-4 P2" jako uzasadnienie TZ-odpornego `started_at`, ale plik nie istniał w momencie pisania testu (forward-reference). Mylące, nie wpływa na asercje.
- [ ] 🟡 [P3] **public/render-helpers.js:190** — `overlapsMaintenanceWindow` nie obsługuje okna przekraczającego północ (`end < start`) — dla obecnego 6:00-6:15 nie defekt, YAGNI OK, ale brak testu/komentarza dokumentującego założenie.

## Operator checklist faza 4

Warunki środowiskowe dla operatora (niewykonalne headless — NIE liczą się do ukończenia fazy):

- [ ] Operator: wizualne potwierdzenie, że warning okna restartu jest czytelny i nie blokuje zapisu joba (element `.hint` obok `#schedule-preview`, treść z ⚠ i informacją o nadrobieniu) — Operator action: otwórz formularz nowego joba w przeglądarce, ustaw freq=daily godzina 06:05 → potwierdź że `#maintenance-warning` jest widoczny (`hidden` zdjęte) i czytelny; zmień na 09:00 → potwierdź że warning znika; potwierdź że obecność warningu nie blokuje przycisku zapisu joba. (Plan linia 278; weryfikacja wymaga realnego renderu strony.)
- [ ] Operator: E2E formularz nowego joba — checkbox „Uruchom po przebudzeniu" zaznaczony domyślnie + warning przy 06:05 (E2E Unit 4, zadania.md:88) — Operator action: otwórz formularz nowego joba → sprawdź że checkbox wake jest zaznaczony domyślnie; ustaw godzinę 06:05 → potwierdź `#maintenance-warning` widoczny (`hidden` zdjęte w DOM); zmień na 09:00 → warning ukryty. (Brak harnessu E2E headless — przeniesione z Weryfikacja: zadania.md:88.)
- [x] Operator: curl `/api/env` zwraca `maintenance_window` z `startHour: 6` (powiązany P2 E2E app.js:1138) — ZWERYFIKOWANE w fix fazy 4 na realnie wystartowanym serwerze (`CLAUDE_CRON_PORT=7799 node server.js` → `curl localhost:7799/api/env`): odpowiedź zawiera `maintenance_window` ze `startHour:6, startMin:0, endHour:6, endMin:15`. Zabezpieczone automatycznym testem `server.env.test.js`.

## Do poprawy po review fazy 3

Brak findingów P1/P2 (blokujących ani important) typu KOD/TEST/E2E. Severity gate: **CZYSTE**.

Findingi P3 (nity — opcjonalne, nie blokują fazy):

- [ ] 🟡 [P3] **server.js:180** — Bezpośredni deliverable Fazy 3 — pole `maintenance_window` w odpowiedzi `GET /api/env` — nie ma ŻADNEJ asercji automatycznej (brak `server.test.js`, suite nie sprawdza kształtu/obecności pola). Min. test integracyjny: odpowiedź `/api/env` zawiera `maintenance_window` równe `MAINTENANCE_WINDOW` z config.
- [ ] 🟡 [P3] **public/render-helpers.test.js:10** — Zakładane pokrycie pośrednie kształtu `MAINTENANCE_WINDOW` nie istnieje: test hardkoduje własną kopię okna (`{startHour:6,...}`) zamiast importować z `lib/config.js`. Drift kształtu w config NIE zostanie wychwycony. (UMD frontend nie importuje configu Node — rozważyć komentarz wiążący fixture z configiem.)
- [ ] 🟡 [P3] **lib/config.js:43** — `MAINTENANCE_WINDOW` to eksportowany mutowalny obiekt bez `Object.freeze` — współdzielona referencja mogłaby zostać przypadkowo zmutowana. Sugestia: `Object.freeze({...})`. Spójne z resztą configu (żaden obiekt nie freezowany) — do ewentualnej globalnej decyzji, nie do naprawy w tej fazie.

## Operator checklist faza 3

Warunki środowiskowe dla operatora (niewykonalne headless — NIE liczą się do ukończenia fazy):

- [ ] Operator: curl `/api/env` zwraca `maintenance_window` z `startHour: 6` (Operator checklist + E2E Unit 3) — Operator action: uruchom serwer, wykonaj `curl localhost:7777/api/env`, sprawdź że odpowiedź zawiera `maintenance_window` ze `startHour: 6`, `startMin: 0`, `endHour: 6`, `endMin: 15`. Alternatywnie: otwórz `/` w przeglądarce → w devtools/network sprawdź `GET /api/env` → potwierdź obecność `maintenance_window` z `startHour: 6`. (Brak `.env.e2e` — weryfikacja wymaga realnie wystartowanego serwera; kod to trywialny passthrough stałej z config.js:43.)

## Do poprawy po review fazy 2

P2 (important — do naprawy):

- [x] 🟠 [P2] **lib/scheduler.test.js** — brak testu z WIELOMA jobami w jednym wywołaniu `computeMissedJobs` (główna ścieżka produkcyjna: `getAllJobs()` jako batch). Dodać test mieszanej listy, np. `[job(id:1,przegapiony), job(id:2,run_on_wake:0), job(id:3,o 9:00 nieprzegapiony)] -> [1]` — filtrowanie + zwrócenie wielu id naraz. Kod działa poprawnie (empirycznie) — to luka pokrycia.

P3 (nity — opcjonalne, nie blokują fazy):

- [ ] 🟡 [P3] **lib/scheduler.js:102-104** — pusty `catch {}` w `computeMissedJobs` połyka zły cron bez logu (§4). Świadomy skip invalid, ale rozważyć debug-log z `job.id` lub zwracanie listy skipniętych id, logowanej w wrapperze.
- [ ] 🟡 [P3] **lib/scheduler.js:104** — `scheduleJob:64` loguje `err.message`, `computeMissedJobs` połyka — niespójność. Sugestia: `catch (err) { console.error(\`[scheduler] computeMissedJobs skip job ${job.id}: ${err.message}\`); }`.
- [ ] 🟡 [P3] **lib/scheduler.js:58,116** — `Intl.DateTimeFormat().resolvedOptions().timeZone` zduplikowane (scheduleJob + detectMissedJobs); ta faza dodała drugie wystąpienie. Spójność strefy = rdzeń R3. Ekstrakcja do `const LOCAL_TIMEZONE` domyka ryzyko driftu.
- [ ] 🟡 [P3] **lib/scheduler.js:117,178** — tabela jobs czytana dwukrotnie przy starcie (detectMissedJobs + start). Wpływ pomijalny, struktura pre-existing. Ewentualnie reuse jednej listy.
- [ ] 🟡 [P3] **lib/scheduler.test.js:99** — granica okna `nextRun === now` nieprzetestowana (kod używa ścisłego `<`). Empirycznie `now==fire -> []` poprawnie. Boundary bez asercji.
- [ ] 🟡 [P3] **lib/scheduler.test.js:122** — brak bezpośredniego testu wrappera `detectMissedJobs` (I/O: getState, early-return, enqueueJob('wake')). Kontrakt `enqueueJob(id,'wake')` niezweryfikowany testem.
- [ ] 🟡 [P3] **lib/scheduler.test.js** — brak testu pustej tablicy jobów oraz `null/undefined cron_expr` (przechodzą catch → `[]`). Degenerate inputs nieasercjonowane.
- [ ] 🟡 [P3] **lib/scheduler.js:110** — wrapper `detectMissedJobs` nieeksportowany/nietestowany; gałąź `if (!lastActive) return` i mapowanie `missedIds->enqueueJob('wake')` niepokryte. Akceptowalne per plan.

## Do poprawy po review fazy 1

Brak findingów P1/P2 (blokujących ani important) typu KOD/TEST/E2E. Severity gate: **CZYSTE**.

Findingi P3 (nity — opcjonalne, do rozważenia, nie blokują fazy):

- [ ] 🟡 [P3] **public/render-helpers.js:190** — parametr `window` w `overlapsMaintenanceWindow(cronExpr, window)` cieniuje globalny `window` przeglądarki (plik UMD ładowany jako `<script>`); działa poprawnie, ale myląca nazwa. Sugestia: `maintenanceWindow`/`restartWindow`.
- [ ] 🟡 [P3] **public/render-helpers.js:196-199** — brak walidacji kształtu `window` na granicy: niepełny obiekt (`{}`) → `undefined*60 = NaN` → warning się nie pokaże (cicha degradacja). Produkcyjnie nie występuje (stała z config.js). Ewentualnie guard `Number.isFinite(startMinutes)`.
- [ ] 🟡 [P3] **public/app.js:1138** — `maintenance_window` z `/api/env` konsumowane bez runtime guardu na pola liczbowe (dane z zaufanego same-origin configu, zły kształt → NaN → bezpieczne false). Nit.
- [ ] 🟡 [P3] **public/app.js:1138** — niespójność warstwy danych w trybie VPS: `maintenance_window` czytane wyłącznie z lokalnego `/api/env`, nie z `/api/vps/env` (obok webhook_base_url JEST dociągany z VPS). Dziś OK (ta sama stała na obu instancjach). Latentny coupling — spójny wzorzec: dociągnąć z `vpsEnv`.
- [ ] 🟡 [P3] **public/app.js:267-285** — `updateMaintenanceWarning` robi `getElementById('maintenance-warning')` przy każdej zmianie pola formularza. Mikro-koszt, nieodczuwalny, brak potrzeby cache'owania referencji.
- [ ] 🟡 [P3] **lib/scheduler.js:102** — pusty catch w `computeMissedJobs` (skip invalid cron) bez logowania (§4). Pure funkcja bez I/O; zły cron i tak loguje się w `scheduleJob`. Spójność z `scheduleJob:63` sugerowałaby minimalny log.
- [ ] 🟡 [P3] **lib/scheduler.js:120-123** — `detectMissedJobs` woła `enqueueJob` w pętli (każde wywołanie `processQueue()`). Nie realny N+1 (guard `queueProcessing` → no-op), ale `processQueue()` raz po pętli byłoby czytelniejsze.
- [ ] 🟡 [P3] **lib/scheduler.js:121** — regresja czytelności logu (DX): po refaktorze loguje surowe `jobId` zamiast nazwy joba (`Missed job detected: ${jobId}`). Plan/IU nie specyfikuje treści logu. Rozważyć przeniesienie nazwy do logu.
- [ ] 🟡 [P3] **lib/db.js:124-125** — backfill `UPDATE jobs SET run_on_wake = 1` to pełny table scan bez WHERE. Jednorazowy (flaga `wake_backfill_done`), mała tabela. Ewentualnie `WHERE run_on_wake != 1`.
- [ ] 🟡 [P3] **public/render-helpers.test.js:10** — `MAINTENANCE_WINDOW` zduplikowane jako literał, niezależne od źródła prawdy `lib/config.js:43` (R4). render-helpers.js to UMD frontowy, nie importuje configu — fixture izolowany, akceptowalny, ale może dryfować. Rozważyć komentarz wiążący fixture z configiem.
- [ ] 🟡 [P3] **lib/scheduler.test.js** — wrapper I/O `detectMissedJobs()` bez testu (tylko pure `computeMissedJobs` pokryte). Nieprzetestowane: czytanie `last_active_at`, early-return, dokolejkowanie `trigger_type='wake'`, brak podwójnego odpalenia. Plan świadomie zostawił cienki wrapper — akceptowany tradeoff, integracyjne zachowanie wrappera niepokryte.

## Operator checklist faza 1

Warunki środowiskowe dla operatora (niewykonalne headless — NIE liczą się do ukończenia fazy):

- [ ] Operator: curl `/api/env` zwraca `maintenance_window` z `startHour: 6` (Operator checklist Unit 3) — Operator action: uruchom serwer, wykonaj `curl localhost:7777/api/env`, sprawdź że odpowiedź zawiera `maintenance_window` ze `startHour: 6`, `startMin: 0`, `endHour: 6`, `endMin: 15`.
- [ ] Operator: wizualne potwierdzenie domyślnie zaznaczonego checkboxa wake oraz warningu okna restartu przy godzinie 06:05 (E2E Unit 4) — Operator action: otwórz formularz nowego joba w przeglądarce → sprawdź że checkbox „Uruchom po przebudzeniu" jest zaznaczony domyślnie; ustaw freq=daily, godzina 06:05 → potwierdź że `#maintenance-warning` jest widoczny (`hidden` zdjęte); zmień na 09:00 → potwierdź że warning znika; potwierdź że warning jest czytelny i nie blokuje zapisu joba.
