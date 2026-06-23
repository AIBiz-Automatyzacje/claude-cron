# Review fazy 4 — Migracja claude-cron → Puls

Faza: 4 — Odroczone (Unit 9 Kalendarz + Unit 10 README rebrand / usunięcie `_preview.html`)
Data: 2026-06-23
Branch: `feature/migracja-puls-rebrand`
Status findings: po adversarial verify (P1 — 3 sceptyków, P2 — 1 sceptyk)

---

## Severity gate

⚠️ **KONTYNUUJ Z ZASTRZEŻENIAMI** — 2 problemy P2 do naprawy, 0 P1 blokujących.

| Kategoria | Liczba |
|---|---|
| 🔴 P1 (blocking) | 0 |
| 🟠 P2 (important, KOD/TEST/E2E) | 2 |
| 🟡 P3 (nit, KOD/TEST/E2E) | 17 |
| 📋 OPERATOR (niewykonalne headless) | 2 |

E2E browser: 0 passed / 0 failed / 0 skipped (Unit 9 kalendarz — wszystkie scenariusze [Manual]; render frontu poza zakresem testów automatycznych, weryfikacja wizualna tylko przez operatora).

---

## Findings — P2 (do naprawy)

### 🟠 P2 [KOD] `public/app.js:1072` — przeciek filtra `hide_routine` do kalendarza
`allRuns` ładowany z `/api/runs?limit=100` z doklejanym `&hide_routine=1` gdy zaznaczony `#runs-hide-routine` (app.js:1071 i 336). Kalendarz używa tego samego `allRuns` do oznaczania kropek (`renderKalendarz`, app.js:457). Gdy operator włączy filtr routine w sekcji Historia, runy routine znikają z `allRuns`, więc kropki kalendarza dla tych jobów gubią status (idle zamiast ok/err) mimo że joby są enabled i cykliczne. Kalendarz współdzieli mutowalny stan z widokiem, którego kontrolki są poza jego zasięgiem — coupling przez współdzielony stan z ukrytym side-effectem filtra. Dodatkowo `limit=100` może obcinać starsze runy z bieżącego tygodnia przy dużej liczbie jobów, dając fałszywe „idle".

### 🟠 P2 [TEST] `public/render-helpers.test.js:229-248` — test `computeWeekOccurrences: kropka 3-stanowa` TZ-zależny
Fixture używa `started_at:'2026-06-15T06:00:00Z'`; `indexRunsByDay` mapuje na lokalny dzień (`getFullYear/getMonth/getDate`), więc w `TZ=America/Los_Angeles` (UTC-7) run ląduje na 14 czerwca local i kropka wychodzi „idle" zamiast „ok". Zweryfikowane: `TZ=America/Los_Angeles node --test public/render-helpers.test.js` → 1 fail (not ok 30, expected 'ok' actual 'idle'); UTC/Kiritimati/Europe-Warsaw 32/32 PASS. To defekt testu (TZ-fragile fixture), nie kodu — lokalne mapowanie dnia jest zamierzone i spójne z `formatTime` w app.js. Naprawa: `started_at` o godzinie bezpiecznej dla wszystkich stref (np. 12:00Z) lub wymuszenie TZ. Plan wprost wymienia granicę UTC vs localtime jako ryzyko, a fixture daje fałszywe PASS na maszynie dev.

---

## Findings — P3 (nity, opcjonalne)

### KOD
- 🟡 P3 `public/app.js:467` — `renderKalendarz()` buduje markup jako string + `innerHTML`. Cały user-controlled output (`job.name`→`e.name`, `e.time`, `calRangeLabel`) poprawnie escapowany przez `esc()`. Brak realnego XSS — uwaga dokumentacyjna: wzorzec „string concat + innerHTML" kruchy przy przyszłych zmianach. Rozważyć DOM API lub konwencję obowiązkowego `esc()`. Nie wymaga naprawy w tej fazie.
- 🟡 P3 `public/app.js:430` — hook `if (zadaniaView==='kalendarz') renderKalendarz()` po guardzie `sig===lastJobsSig`; gdy joby się nie zmieniają, kalendarz nie odświeża się co poll, ale render operuje na danych w pamięci → narzut pomijalny. Guard chroni przed zbędnym re-renderem co 3s. Nie jest defektem wydajnościowym.
- 🟡 P3 `public/render-helpers.js:155` — `indexRunsByDay` buduje pełny indeks całej listy (do 100) przy KAŻDYM `computeWeekOccurrences`, choć kalendarz pokazuje tylko bieżący tydzień. Przy limit=100 O(100) — pomijalne. Gdyby limit urósł, warto filtrować runy do zakresu tygodnia przed indeksowaniem.
- 🟡 P3 `public/app.js:460` — `renderKalendarz` czyta `allRuns`, ale w `poll()` przy `activeTab==='jobs'` odświeżane jest tylko `loadJobs()` (allRuns nie re-fetchowane). Kwestia świeżości kropek, nie wydajności — narzut renderu liniowy O(7N+R).
- 🟡 P3 `public/render-helpers.js:117` — duplikacja formuły `dayKey` (lokalny YYYY-MM-DD) inline w 3 miejscach (117, 141, 147). Kandydat na helper `localDayKey(date)`. Wg reguły „Duplication > Complexity" 3× duplikacja w jednym module tolerowalna → P3, ale ekstrakcja zmniejszyłaby ryzyko rozjechania formatu.
- 🟡 P3 `public/render-helpers.js:188` — `formatHourMinute` eksportowany ale nieużywany na zewnątrz (app.js korzysta z `e.time` już sformatowanego, test nie importuje). Martwy public API — można zostawić w domknięciu bez eksportu. `parseCronForCalendar` słusznie eksportowany (testowany bezpośrednio).
- 🟡 P3 `public/render-helpers.js:127` — stringly-typed „enum" statusu (`'ok'/'err'/'idle'`) przekracza granicę modułu: produkuje `eventStatus()`, konsumuje `calDotFor()` i klasa `cal-event 'done'` (app.js:441,475). Brak współdzielonej stałej — zmiana literału po jednej stronie cicho rozjedzie drugą. JS-odpowiednik braku discriminated union. Sugestia: stałe `EVENT_STATUS` w render-helpers.js. Niblokujące — wartości spójne, pokryte testem kropki.
- 🟡 P3 `public/render-helpers.js:71` — `parseCronForCalendar` zwraca niejednorodny kształt: `highFreq=true` bez `hour/minute/dow`, `highFreq=false` pełny obiekt. Discriminated union zakodowany boolean flagą zamiast taga `kind`. Konsument (computeWeekOccurrences:153) poprawnie sprawdza `highFreq` → brak buga, ale nowy konsument musi pamiętać kolejność. Akceptowalne w izolowanym helperze; brak TS który by to wymusił.
- 🟡 P3 `public/render-helpers.js:114` — `indexRunsByDay` zakłada że `r.started_at` jest stringiem (`.endsWith`). Guard (113) sprawdza tylko falsy, nie typ. Gdyby API zwróciło number/obiekt — TypeError przerwie indeks. Zgodne z kontraktem API (ISO string), niegroźne, ale granica systemu bez walidacji typu.
- 🟡 P3 `public/app.js:1064` — freshness kropek: `renderKalendarz()` używa `allRuns`, ale `poll()` odświeża `allRuns` (pollRuns) WYŁĄCZNIE gdy `activeTab==='history'`. Kalendarz żyje na zakładce „jobs", więc po starcie `allRuns` ładowany raz w `init()→loadRuns()`, potem nigdy nieodświeżany dopóki user siedzi na Kalendarzu. Run wykonany podczas oglądania nie zmieni kropki aż do wizyty w Historii. Plan R10/Unit 9 nie precyzuje odświeżania kropek ([Manual]); occurrences (grafik) poprawne — degradacja drugorzędnego sygnału. Sugestia: w `poll()` dla `activeTab==='jobs'` (gdy `zadaniaView==='kalendarz'`) dociągnąć runy.
- 🟡 P3 `public/app.js:337` — przeciek `hide_routine` do kalendarza (wariant P2 z perspektywy konkretnej kadencji): job rutynowy o kadencji daily (NIE highFreq, widoczny w kalendarzu) pokaże „idle" zamiast „ok" gdy filtr włączony. Cross-tab coupling stanu UI. Niska istotność (routine+daily rzadka kombinacja; highFreq i tak filtrowane przez `parseCronForCalendar`).
- 🟡 P3 `README.md` — stale copy: nowy opis nadal mówi „Dashboard w stylu retro arcade", podczas gdy migracja (R1/R2) zastąpiła retro-arcade UI design systemem „Dark Impact". Unit 10 wymagał tylko rebrandu nagłówka+opisu (zrealizowane), ale fraza „retro arcade" nieaktualna. Kosmetyka dokumentacji.

### TEST
- 🟡 P3 `public/render-helpers.test.js:262` — brak testu joba ze strefą na granicy doby (run blisko północy UTC vs localtime). `indexRunsByDay` normalizuje UTC→localtime przez Date, ale brak testu regresyjnego analogicznego do Unit 3 (`getTodayRunStats`). Główna ścieżka pokryta 18 testami; luka brzegowa.
- 🟡 P3 `public/render-helpers.test.js` — brak testu granicy dnia UTC→localtime w `indexRunsByDay`/`computeWeekOccurrences`. Żaden test nie sprawdza runu bliskiego północy UTC przeskakującego na sąsiedni dzień lokalny (np. `2026-06-15T23:30:00Z`→wtorek 16 lokalnie w PL, zweryfikowane manualnie). Granica wymieniona w planie jako ryzyko. Sugestia: test regresyjny z wymuszoną TZ.
- 🟡 P3 `public/render-helpers.test.js` — brak testu „sukces wygrywa" przy wielu runach tego samego joba tego samego dnia. Kod (render-helpers.js:120 `if(map[key]===ok)continue`) gwarantuje że mix success+failed → „ok" niezależnie od kolejności (zweryfikowane manualnie). Nieoczywiste zachowanie biznesowe (priorytet sukcesu) bez asercji — regresja mogłaby odwrócić niezauważenie.
- 🟡 P3 `public/render-helpers.test.js` — brak boundary dla single-day weekly na skrajnych dniach: `parseCronForCalendar` dla `dow=0` (niedziela) i `dow=6` (sobota). Testy pokrywają tylko dow=3 i 1-5. Manualnie dow=0→Set{0}, dow=6→Set{6} działają, brak asercji — wartości graniczne regexu `/^[0-6]$/`.
- 🟡 P3 `docs/plans/2026-06-23-001-feat-migracja-puls-rebrand-plan.md:442-449` — plan dla Fazy 4 zdefiniował WSZYSTKIE scenariusze jako [Manual] — zero [Unit]. Implementacja słusznie dodała 18 testów node:test dla wyekstrahowanych helperów. Luka w samym planie (nie zdefiniował kontraktu testowego), nie w kodzie. `renderKalendarz/switchZadaniaView/calDotFor/calRangeLabel` (DOM render) nietestowane zgodnie z granicą scope „Testy frontu render poza zakresem".

---

## Findings — OPERATOR (niewykonalne headless)

- 📋 OPERATOR `docs/plans/2026-06-23-001-feat-migracja-puls-rebrand-plan.md:451` — Unit 9 Operator checklist niezahaczona: weryfikacja occurrences vs faktyczne `next_run` jobów na realnych danych w przeglądarce. Niewykonalna headless — wymaga uruchomionego serwera z realnymi jobami/runami i wizualnej kontroli widoku tygodnia. Reviewer potwierdza: składnia app.js OK (`node --check`), testy render-helpers 32/32 PASS, klasy CSS kalendarza (cal-week/cal-day/cal-event/cal-today-badge/dot-grey) istnieją w style.css, kontenery `#zadania-lista`/`#zadania-kalendarz` i toggle `#zadania-views` obecne w index.html.
- 📋 OPERATOR `docs/plans/2026-06-23-001-feat-migracja-puls-rebrand-plan.md:451-452` — Unit 9: weryfikacja w przeglądarce widoku tygodnia na realnych danych (occurrences vs faktyczne next_run). Render kalendarza (markup cal-week/cal-day/cal-event, klasy dot-green/dot-red/dot-grey) niepokryty automatem; jedyna weryfikacja to manualny ogląd operatora.

---

## Bookkeeping checkboxów Weryfikacja:

Re-parsowano niezaznaczone `- [ ] Weryfikacja:` w Fazie 4 (Unit 9 + Unit 10).

- Odznaczone automatycznie (CLI/grep): 5
- Odznaczone na podstawie Agent 5 E2E: 0
- Pozostawione dla operatora (Manual): 1 (Operator checklist Unit 9 — przeniesiona do sekcji Operator)
- Niejasne (P3): 0
- Failujące (P2): 0

### Szczegóły
- [x] CLI: `node --check public/app.js przechodzi` → PASS (exit 0)
- [x] Grep: `grep -q 'renderKalendarz' public/app.js` → PASS
- [x] Grep: `grep -q -i 'Puls' README.md` → PASS
- [x] Test -f: `test ! -f public/_preview.html` → PASS (plik usunięty)
- [x] Grep: `grep -rq '_preview.html' public server.js zwraca pusto` → PASS (0 referencji)
- [ ] Manual/Operator: `Operator checklist: weryfikacja widoku tygodnia w przeglądarce na realnych danych (occurrences vs next_run)` → wymaga operatora (przeniesione do „Operator checklist faza 4")

Potwierdzenie pełnego zestawu testów: `node --test public/render-helpers.test.js` → 32/32 PASS (default TZ). FAIL pojedynczego testu tylko pod `TZ=America/Los_Angeles` (defekt fixture, P2 powyżej).

Bookkeeping NIE wprowadził nowych P2 ani P3 — wszystkie automatyzowalne checkboxy przeszły. Severity gate bez zmian: **ZASTRZEZENIA** (2× P2, 0× P1).
