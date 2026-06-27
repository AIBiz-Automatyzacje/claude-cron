# Review fazy 4: Warning okna restartu + domyślny checkbox wake + pure helper overlap

**Data:** 2026-06-27
**Faza:** 4 (Unit 4)
**Status:** ⚠️ KONTYNUUJ Z ZASTRZEŻENIAMI

## Statystyki

- Findingi razem: 17 (po adversarial verify)
- 🔴 P1 (blocking): 0
- 🟠 P2 (important, KOD/TEST/E2E): 1
- 🟡 P3 (nit, KOD/TEST/E2E): 15
- 📋 OPERATOR (niewykonalne headless): 1
- E2E automatyczne: 0 passed / 0 failed / 0 skipped (brak harnessu E2E headless w repo — wszystkie scenariusze E2E z planu pokryte unit pure helpera + operator checklist)
- Unit pure helper `overlapsMaintenanceWindow`: 43/43 PASS (`node --test public/render-helpers.test.js`)

**Severity gate: ZASTRZEZENIA** — jeden P2 (typ E2E) do naprawy. Brak P1. P3/OPERATOR nie blokują gate'u.

## Findingi (P1 → P2 → P3)

### P2 (important)

1. 🟠 **P2 · E2E · public/app.js:1138** — Pobranie `maintenance_window` z `/api/env` i zapis do stanu modułu (`maintenanceWindow`) nie ma testu integracyjnego. Plan Unit 3 przewidział [E2E] `curl /api/env` → obecność `maintenance_window` ze `startHour:6`, z fallbackiem na Operator checklist gdy brak `.env.e2e`. Realnie weryfikowalne tylko przez uruchomiony serwer (operator).

### P3 (nity — opcjonalne)

1. 🟡 **P3 · E2E · public/app.js:820** — `openCreateModal` ustawia `form-wake.checked=true` (R1 domyślny wake) — brak automatycznego testu (DOM). Plan wymienił to jako osobny [E2E] scenariusz ("checkbox Uruchom po przebudzeniu zaznaczony domyślnie"). Weryfikowalne tylko w realnym formularzu (E2E/operator), nie unit headless.
2. 🟡 **P3 · KOD · public/app.js:270-279** — `updateMaintenanceWarning(cron)` wywoływane dwukrotnie w `updateSchedulePreview` — raz w gałęzi webhook-only przed return, raz po niej. Mała duplikacja wywołania pure helpera (O(1)). Można uprościć: policzyć cron raz na początku i wywołać warning jednokrotnie przed gałęziami. Nit czytelności, nie defekt wydajności.
3. 🟡 **P3 · KOD · public/render-helpers.js:187** — Parametr funkcji `overlapsMaintenanceWindow` nazwany `window` przesłania globalny obiekt `window` przeglądarki (render-helpers.js działa w Node i w przeglądarce). Helper nie potrzebuje globalnego `window`, więc działa poprawnie, ale to zapach nazewniczy — bezpieczniej `maintenanceWindow`/`windowConfig`.
4. 🟡 **P3 · TEST · public/render-helpers.test.js:266** — highFreq godzinowy z minutą poza oknem nie ma testu rozróżniającego intencję — test używa `'0 */2 * * *'` (odpala o 6:00, w oknie), ale helper zwraca `true` dla KAŻDEGO highFreq niezależnie od minuty. Zgodne z planem (linia 256: świadomy konserwatywny over-warn), nie defekt — jedynie test nie dokumentuje granicy tej świadomej nadgorliwości. Nit dokumentacyjny.
5. 🟡 **P3 · E2E · public/app.js:282** — `updateMaintenanceWarning` (wiring DOM: pokaż/ukryj `#maintenance-warning`) nie ma unit testu — pokryta tylko ścieżką E2E/agent-browser z planu. Zgodne ze split projektu (pure logika w node:test, DOM wiring przez E2E). Reaktywność potwierdzona w kodzie: `onFreqChange→updateSchedulePreview→updateMaintenanceWarning` oraz `parseCronToForm→updateSchedulePreview`. Wymaga realnego uruchomienia UI.
6. 🟡 **P3 · KOD · public/render-helpers.js:67** — Parametr `window` cieni globalny obiekt `window` przeglądarki. Helper pure, nie używa globalnego `window`, więc bez buga, ale w pliku UMD ładowanym w przeglądarce shadowing globalnej nazwy to pułapka czytelności. Sugestia: `maintenanceWindow`.
7. 🟡 **P3 · KOD · public/app.js:282** — `updateMaintenanceWarning(cron)` — parametr `cron` może być `null` (webhook-only). `overlapsMaintenanceWindow` poprawnie zwraca `false` dla `null/''`. Nit: brak explicit komentarza/typu przy publicznym helperze w czystym JS — projekt nie używa JSDoc, więc spójne z resztą. Zerowy wpływ funkcjonalny.
8. 🟡 **P3 · KOD · public/render-helpers.js:77** — `overlapsMaintenanceWindow(cronExpr, window)` — parametr `window` cieni globalny obiekt przeglądarki. Funkcja pure, w ciele nie odwołuje się do globalnego `window`, brak defektu, ale shadowing globalnej nazwy w kodzie do przeglądarki stylistycznie ryzykowny. Plan (linia 256) sam używał `window` jako arg.
9. 🟡 **P3 · KOD · public/render-helpers.js:78** — Świadomy false-positive zgodny z planem (linie 104,117): dla highFreq helper zawsze zwraca `true`, więc cron `'0 */5 * * *'` (odpala 0/5/10/15/20, NIE trafia w 06:00) pokaże warning mimo braku realnego pokrycia. Celowy uproszczony heurystyk (R5), nie defekt — potencjalny szum UX zostawiony do wizualnego potwierdzenia.
10. 🟡 **P3 · E2E · public/app.js:271** — Plan Unit 4 wymienia dwa scenariusze E2E (checkbox wake domyślnie zaznaczony; 06:05 pokazuje `#maintenance-warning`, 09:00 ukrywa). Wiring poprawny i kompletny, logika pokryta unit testami pure helpera (43/43 PASS). Brak realnego testu E2E w repo — weryfikacja w przeglądarce pozostaje operatorsko/agent-browser.
11. 🟡 **P3 · E2E · public/render-helpers.test.js:271** — Pure helper `overlapsMaintenanceWindow` ma pełne pokrycie unit (43 testy PASS): wszystkie 5 scenariuszy z planu (6:00, 6:10, 9:00, */5, pusty) + granice 6:15 inclusive, 5:59/6:16 tuż poza oknem, highFreq godzinowy, nieobsługiwany kształt, brak window. Każdy test ma asercję. Brak luk w warstwie pure helpera.
12. 🟡 **P3 · TEST · public/render-helpers.test.js:239** — Komentarz fixture odwołuje się do "review-faza-4 P2" jako uzasadnienie TZ-odpornego `started_at`, ale plik `review-faza-4.md` jeszcze nie istniał w momencie pisania testu (forward-reference). Mylące dla czytelnika. Nie wpływa na asercje ani PASS.
13. 🟡 **P3 · KOD · public/render-helpers.js:190** — `overlapsMaintenanceWindow` nie obsługuje okna przekraczającego północ (`end < start`): porównanie `fireMinutes>=start && fireMinutes<=end` dałoby zawsze `false` dla okna zawijanego. Dla obecnego okna 6:00-6:15 (nie zawija) to nie defekt i YAGNI jest OK (config = jedyne źródło prawdy), ale brak testu/komentarza dokumentującego to założenie.

## Pozycje OPERATOR (poza fix — Operator checklist faza 4)

1. 📋 **OPERATOR · docs/plans/2026-06-27-001-feat-nocny-restart-przegapione-joby-plan.md:278** — Operator checklist fazy: wizualne potwierdzenie że warning jest czytelny i nie blokuje zapisu joba (element ma klasę `.hint` obok `#schedule-preview`, treść z ⚠ i informacją o nadrobieniu). Weryfikacja niewykonalna headless — wymaga realnego renderu strony i oceny czytelności. Nie defekt kodu.

## Zgodność ze spec

Wszystkie wymagania Unit 4 (R1 UI default, R5) zaimplementowane:
- R1 UI default: `openCreateModal` → `form-wake.checked=true` (app.js:820) — wiring poprawny, weryfikacja DOM przez operatora.
- R5 overlap warning: pure `overlapsMaintenanceWindow` (render-helpers.js) + DOM wiring `updateMaintenanceWarning` (app.js) + element `#maintenance-warning` (index.html). Logika pure pokryta 43/43 unit. Świadomy over-warn dla highFreq zgodny z planem (R5).

Brak scope creep. Brak błędnie zaimplementowanych wymagań. Luki pokrycia to wyłącznie warstwa DOM/E2E, świadomie wydzielona ze split testowego projektu (pure → node:test, DOM → E2E/operator).

## Bookkeeping checkboxów Weryfikacja:

Re-parsowano niezaznaczone `Weryfikacja:` w fazie 4 (Unit 4):

- Pozostawione dla operatora (E2E browser niewykonalny headless): 1
- Odznaczone automatycznie (CLI/grep): 0 (jedyna CLI-Weryfikacja Unit 4 — `node --test public/render-helpers.test.js` — była już odznaczona `[x]`; potwierdzona ponownie: 43/43 PASS)
- Failujące (P2): 0 z bookkeepingu (P2 pochodzi z review, nie z CLI/grep FAIL)

### Szczegóły

- [ ] E2E browser: `[E2E przez /agent-browser] formularz nowego joba — checkbox wake zaznaczony, godzina 06:05 pokazuje #maintenance-warning (hidden zdjęte w DOM)` (zadania.md:88) — wymaga operatora (checklist): brak harnessu E2E headless. Już anotowane w pliku; pozostawione `[ ]`, przeniesione do Operator checklist faza 4. NIE jest to P2 (oczekiwana ręczna weryfikacja środowiskowa).
- [x] CLI (potwierdzenie): `node --test public/render-helpers.test.js` → PASS (43/43). Checkbox był już odznaczony.

Brak nowych P2/P3 z bookkeepingu — severity gate bez zmian (ZASTRZEZENIA z powodu P2 review).
