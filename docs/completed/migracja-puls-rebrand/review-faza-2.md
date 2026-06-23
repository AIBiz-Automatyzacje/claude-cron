# Code Review — Faza 2 (Front + rebrand widoczny)

Zadanie: `migracja-puls-rebrand`
Data review: 2026-06-23
Branch: `feature/migracja-puls-rebrand`
Status bramki: **⚠️ ZASTRZEZENIA — same P2, brak P1 blokujacych**

Findings ponizej sa juz po adversarial verify (P1 = 3 sceptykow, P2 = 1). Lista finalna po bookkeepingu checkboxow `Weryfikacja:`.

---

## Statystyki

| Kategoria | Liczba |
|---|---|
| 🔴 P1 (blocking, KOD/TEST/E2E) | 0 |
| 🟠 P2 (important, KOD/TEST/E2E) | 2 |
| 🟡 P3 (nit, KOD/TEST/E2E) | 18 |
| 🔧 OPERATOR (niewykonalne headless) | 4 |
| **Razem findings** | **24** |

Bookkeeping (krok 4.7): +1 P2 — Grep FAIL na `class="env-btn"` (wzorzec nietrafiony, token klasy obecny). Trzymany osobno w sekcji bookkeepingu (artefakt checkboxa, nie defekt kodu), ale wliczony do licznika P2 bramki.

Severity gate: **ZASTRZEZENIA** (zero P1, sa P2 → kontynuacja z zastrzezeniami; oba P2 to czesciowa realizacja wymagania R4/Unit 6 oraz luka pokrycia testowego pollSignature).

---

## Findings — P2 (important)

### P2-1 · KOD · `public/index.html:112 + public/app.js:544`
Under-implementation R4 / Unit 6: plan wymaga dla Skilli „toggle Kafelki/Lista + filtry + stopki" (R4 „skille 2 widoki", Unit 6: „renderSkills() → toggle Kafelki/Lista"). Zaimplementowano TYLKO widok Kafelki — index.html (Unit 5) nie zawiera segmentu Kafelki/Lista (demo mial #skilleViews data-sview kafelki/lista + kontener #skille-lista, oba pominiete), a renderSkills() renderuje wylacznie kafelki. Filtry po source i stopki „N zadan / nieuzywany" dzialaja, ale drugi widok (Lista) calkowicie brakuje. To NIE jest funkcja odroczona (odroczony jest tylko Kalendarz — R10), wiec to czesciowa realizacja wymagania Fazy 2. Odchylenie udokumentowane w zadania.md, ale pozostaje rozbieznoscia ze spec planu.

### P2-2 · TEST · `public/render-helpers.test.js:6-31`
pollSignature: brak asercji ze pola statbara today_success/today_failed oraz next.next_run wchodza do podpisu. Plan R7/R8 czyni statbar zalezny od tych pol, a R8 wymaga, by guard poll() NIE pomijal re-renderu gdy zmieni sie tylko status/statbar. Testy pokrywaja queue_length i status istniejacego runu (kanon), ale zmiana today_success albo next.next_run nie ma testu regresyjnego — zweryfikowane recznie: implementacja DZIALA poprawnie (a!==b), wiec to luka pokrycia, nie defekt kodu. Dodac >=1 test: zmiana today_success zmienia podpis; zmiana next.next_run zmienia podpis.

---

## Findings — P3 (nit, KOD/TEST/E2E)

### P3-1 · E2E · `public/app.js:475 + public/style.css:337-343`
Niespojnosc markup vs CSS w log viewerze historii. CSS dema zaprojektowano dla struktury div-owej `.hrow-wrap.open .hrow.err .id-cell::before` (obrot strzalki rozwijania). Render produkcyjny generuje tabele `<tr class="hrow grid-historia err">` + osobny `<tr class="run-detail show">` — NIE tworzy `.hrow-wrap` ani nie dodaje klasy `.open`. Skutek: strzalka rozwijania nigdy sie nie animuje. Rozwijanie loga dziala (przez `.logbox.hidden` toggle w JS), ale wskaznik wizualny stanu otwarcia jest martwy. Weryfikowalne tylko w przegladarce (Manual/E2E).

### P3-2 · KOD · `public/app.js:567-569`
renderSkills() fallback dla nieznanego source: `meta = { cls:'type-plugin', label: esc(s.source).toUpperCase() }`. esc() zwraca string z encjami HTML, a .toUpperCase() jest na nim wolane PO escapowaniu — wartosc jest bezpieczna (nie ma sinka XSS), ale kolejnosc esc→toUpperCase potrafi znieksztalcic encje. Czysto kosmetyczne. Sugestia: toUpperCase przed esc. Brak realnego XSS w warstwie render Fazy 2.

### P3-3 · KOD · `public/app.js:308-320, 951-955`
Network nie jest objety guardem podpisu — tylko innerHTML. Na zakladce 'jobs' poll() co 3s wola loadJobs(), ktore BEZWARUNKOWO robi 2 fetche: GET /api/jobs oraz (w loadRecentRuns) GET /api/runs/recent?per_job=7. Guard (R8) oszczedza prace DOM, ale nie siec: 2 req/3s leca niezaleznie od zmian. Dla single-user lokalnego schedulera akceptowalne. Plan §R8 mowi 'pomin re-render gdy podpis bez zmian' — implementacja pomija render, nie fetch.

### P3-4 · KOD · `public/app.js:540-543, 565-584`
countJobsForSkill(dirName) robi allJobs.filter(...) (O(jobs)) raz na kazda kafelke skilla w renderSkills() → O(skills × jobs). Przy obecnej skali bez znaczenia, ale to zagniezdzony skan. Tanszy wariant: raz zbudowac mape job_count przed map() i czytac countMap[s.dir_name] ?? 0. Nit.

### P3-5 · KOD · `public/app.js:951-957`
poll() robi 'await loadStatus()' przed warunkowym loadJobs()/pollRuns(). loadStatus jest sekwencyjnie blokujace przed fetchem danych zakladki. Przy zdrowym lokalnym serwerze nieistotne. Mozna odpalic rownolegle (statbar i tab-data sa niezalezne). Mikro-optymalizacja, nie defekt.

### P3-6 · KOD · `public/render-helpers.js:24-46`
buildSparkData/groupRecentByJob/jobsSignature/pollSignature sa czysto O(n) po liscie runow/jobow z poprawnym slice(0,7) na sparkline — brak problemow zlozonosci, brak alokacji nieograniczonych. recentByJob i allRuns sa nadpisywane (limit=100, per_job=7), wiec struktury ograniczone — brak wycieku pamieci. Pozytywna weryfikacja fokusu — zostawiam jako potwierdzenie wydajnosci guard-signatur i grupowania.

### P3-7 · KOD · `public/app.js:497 (renderRuns, klasa wiersza)`
Mylaca semantyka nazwy klasy: kazdy wiersz historii dostaje bezwarunkowo klase `err`, niezaleznie od statusu runu. W CSS `.hrow.err` to hook na 'wiersz rozwijalny' (cursor:pointer + strzalka), nie 'wiersz bledu' — nazwa odziedziczona z dema. Lamie 5-sekundowa regule nazewnictwa. Sugestia: zmienic klase na semantyczna (np. `expandable`) i zaktualizowac selektory CSS, albo udokumentowac. Nie blokuje dzialania.

### P3-8 · KOD · `public/app.js:380-383 (renderJobs)`
Czesc logiki podpisu guarda budowana inline w renderJobs (`recentSig`), reszta przez czysty testowalny helper `jobsSignature`/`pollSignature`. Asymetria: podpis recent runs (nietestowany, inline) vs podpis jobow (testowany helper). Spojniej byloby wyciagnac `recentSignature(recentByJob)` do render-helpers.js i pokryc testem. Wg reguly '2+ uzycia' to wciaz 1 uzycie — stad P3.

### P3-9 · KOD · `public/app.js:362 (sparklineHtml)`
Magic numbers w wysokosci slupkow sparkline: `height:${4 + (s.ok ? 12 : 8)}px`. Trzy niewyjasnione liczby (baza 4, delta ok 12, delta err 8) inline. Wyciagnac do named constants (np. SPARK_BASE_PX, SPARK_OK_PX, SPARK_ERR_PX). Drobne.

### P3-10 · KOD · `public/app.js:18 + public/index.html:271-273`
Top-level destrukturyzacja globali (`const { mapStatus, mapTrigger } = EnumMap;` i `const {...} = RenderHelpers;`) zaklada twarda kolejnosc ladowania <script> (enum-map.js i render-helpers.js PRZED app.js). Kolejnosc poprawna w index.html (zweryfikowane), ale jesli ktorys plik sie nie zaladuje (404), app.js rzuca ReferenceError natychmiast i cala strona jest martwa (brak graceful degradacji). Akceptowalny tradeoff dla lokalnego single-origin schedulera bez bundlera. Odnotowane jako kruchy punkt couplingu.

### P3-11 · KOD · `public/render-helpers.js:46-54 (groupRecentByJob)`
`groupRecentByJob` buduje mape `{}` z kluczami numerycznymi (job_id) — zwykly obiekt jako slownik. Dla spojnosci mozna by uzyc Map, ale obecne rozwiazanie poprawne dla integer keys (int PK z SQLite) i prostsze. Nit — zadnej zmiany nie wymaga przy znanym typie kluczy.

### P3-12 · E2E · `public/app.js:475`
Martwy CSS / brakujacy stan rozwiniecia: style.css ma regule `.hrow-wrap.open .hrow.err .id-cell::before { transform: rotate(90deg) }`, ale produkcyjny render uzywa struktury tabelarycznej — toggluje `.show` na osobnym `<tr class=run-detail>`, a `.hrow-wrap`/`.open` w ogole nie istnieja w renderowanym markupie (grep: 0 wystapien). Skutek: wiersz rozwija sie poprawnie (logbox), ale chevron przy #id sie nie obraca. Czysto kosmetyczne, weryfikowalne tylko wizualnie (E2E). Fix opcjonalny. (Powiazane z P3-1.)

### P3-13 · KOD · `public/app.js:478`
Drobne odejscie od wzorca demo (Unit 6 „Wzorce: puls-demo/app.js renderHistoria"). Demo nadaje klase 'err' warunkowo: `${h.log ? 'err' : ''}` — tylko wiersze z logiem sa rozwijalne. Produkcja hardcoduje `class="hrow grid-historia err"` na KAZDYM wierszu + onclick na kazdym, wiec nawet zwykle runy 'success' bez outputu dostaja chevron bledu i pointer (rozwijaja sie do 'Brak outputu'). Funkcjonalnie dziala, ale kosmetyczna niezgodnosc z zaakceptowanym designem dema. (Powiazane z P3-7.)

### P3-14 · KOD · `public/render-helpers.js:1 + public/render-helpers.test.js:1`
Scope creep / odejscie od granic planu: plan §Granice scope deklaruje „Jedyny testowany modul frontowy to wyciagniety enum-map (§4.0)", a Unit 6 lokuje guard poll i sparkline WEWNATRZ app.js (R8). Faza 2 wprowadza DRUGI testowalny modul frontowy public/render-helpers.js (pollSignature/jobsSignature/buildSparkData/groupRecentByJob) + osobny plik testow. To wykracza poza zadeklarowana granice. Lagodzace: ekstrakcja czysta, dobrze otestowana, udokumentowana w commit/zadania.md, nie psuje zachowania — stad nit. Wymaga swiadomej akceptacji rozszerzenia listy modulow frontu.

### P3-15 · TEST · `public/render-helpers.test.js:35-44`
jobsSignature: testowany tylko toggle enabled i pusta lista. Brak asercji dla pozostalych pol podpisu (cron_expr — rozroznienie 'tylko webhook' vs harmonogram; next_run; webhook_token). Behawioralnie istotne (zmiana cron-a lub wygenerowanie webhooka MUSI re-renderowac tabele zadan). Zweryfikowane recznie: dzialaja. Luka pokrycia — dodac testy per pole.

### P3-16 · TEST · `public/render-helpers.test.js:48-58`
buildSparkData: asercja kolejnosci chronologicznej jest slaba — sprawdza tylko ostatni element (.ok=true) i liczbe ok. Nie wychwyci zgubionego .reverse() przy mieszanym wejsciu, bo nie asertuje pierwszego (najstarszego) elementu. Test 'spark[0].ok===false (oldest=failed)' przy wejsciu [success,failed] domknalby kontrakt kolejnosci.

### P3-17 · TEST · `public/app.js:380-382`
renderJobs() buduje wlasny inline recentSig (id+status pierwszego recent runu per job) — drugi, niewspoldzielony mechanizm podpisu obok jobsSignature/pollSignature, nietestowalny (zalezny od globala recentByJob i DOM). To kanoniczna sciezka guardu zakladki Zadania (R8: zakonczony run MUSI odswiezyc sparkline/kropke). Logika powinna byc wyekstrahowana do testowalnego helpera (np. recentSignature(recentByJob)) i pokryta testem — inaczej kluczowy warunek R8 dla tabeli zadan nie ma automatycznej weryfikacji. (Powiazane z P3-8.)

### P3-18 · E2E · `public/index.html:?`
Unit 5 (markup + KONTRAKT ID) i Unit 6 (render z API: tabela zadan/historia/skille/statbar, poll bez migotania, expandedRuns przezywa re-poll, kill-bar, env-toggle) maja w planie wylacznie scenariusze [Manual] (Operator checklist). Brak jakiegokolwiek automatycznego E2E/DOM (plan §scope: 'Testy frontu poza zakresem', brak .env.e2e/jsdom). Weryfikacja kontraktu ID jest grep-owalna (i przechodzi), ale poprawnosc renderu/poll-guardu na realnych danych nie ma automatu — pokrycie tych sciezek jest tylko manualne.

---

## Findings — OPERATOR (niewykonalne headless, do Operator checklist)

### OP-1 · `public/app.js:998-999`
Brak realnego pomiaru migracji (plan §R8: 'polling 3s nie powoduje migotania, rozwiniety log nie zwija sie przy re-poll'). Single setInterval(poll,3000), zero listenerow per-render (inline onclick), expandedRuns przezywa re-render — statycznie OK, ale weryfikacja braku migotania i kosztu innerHTML przy realnej liczbie jobow/runow wymaga uruchomienia w przegladarce (headless niemozliwe wg planu — brak .env.e2e). Do checklisty operatora.

### OP-2 · `public/app.js, public/render-helpers.js, public/enum-map.js`
Fokus review fazy (brak any/as/!, discriminated unions, explicit return types) jest NIEAPLIKOWALNY: cala warstwa frontu to czysty CommonJS/browser JS bez TypeScriptu (brak tsconfig, brak typow). Brak plikow .ts → nie istnieja konstrukty any/as/non-null. Type-safety-ekwiwalent na poziomie runtime jest spelniony: mapStatus/mapTrigger maja jawne fallbacki (STATUS_FALLBACK/TRIGGER_FALLBACK), pollSignature/jobsSignature/buildSparkData/groupRecentByJob degraduja cicho przy null/undefined (Array.isArray guard) i sa pokryte testami zachowania (39/39 PASS). Klasyfikacja OPERATOR/context — nie defekt kodu, nie idzie do fix.

### OP-3 · `public/app.js:377 + public/index.html`
Weryfikacja poprawnosci renderu na realnych danych jest niewykonalna headless (brak harnessu E2E — plan §Otwarte pytania: „brak .env.e2e → scenariusze przegladarkowe = Operator checklist [Manual]"). Scenariusze Manual z Unit 6 (sparkline/ostatni-run z /api/runs/recent, statbar Nastepne/Dzis+health na realnych liczbach, brak migotania przy poll 3s, przezycie rozwinietego logu przez re-poll, kill-bar gdy job leci, env-toggle tylko gdy VPS skonfigurowany) wymagaja realnego serwera + bazy + przegladarki. Grepy kontraktu ID i node --check/--test przechodza (39/39 PASS), ale wizualna zgodnosc z demem i poprawnosc mapowania danych do UI musza zostac potwierdzone manualnie.

### OP-4 · `public/app.js:951-969`
Antymigotanie pollingu 3s i zachowanie rozwinietego log-viewera (expandedRuns Set przezywa re-poll) — R8 — sa weryfikowalne wylacznie w realnej przegladarce z zywym backendem i uplywem czasu (>=2 cykle poll). Niewykonywalne headless w tym srodowisku; wymaga realnego deploya/operatora wg Operator checklist planu §8. Nie defekt kodu.

---

## Zgodnosc ze spec (os Spec, osobno od osi Standards)

- (a) BRAKUJACE/czesciowe: R4/Unit 6 „skille 2 widoki — toggle Kafelki/Lista" — zaimplementowano tylko Kafelki (P2-1). Brak widoku Lista (#skille-lista) i przelacznika data-sview. Filtry+stopki obecne.
- (b) Scope creep: wprowadzenie drugiego testowalnego modulu frontowego `public/render-helpers.js` poza zadeklarowana granica (plan: „jedyny testowany modul to enum-map"). Lagodzace — czysta ekstrakcja, otestowana, udokumentowana (P3-14).
- (c) Bledne: brak — wymagania renderu (5 statusow przez EnumMap, statbar z /api/status, sparkline z /api/runs/recent, guard poll, KONTRAKT ID) zrealizowane poprawnie wg weryfikacji statycznej (grep ID = wszystkie obecne, node --check PASS, npm test 39/39).

---

## Bookkeeping checkboxow Weryfikacja:

- Odznaczone automatycznie (CLI/grep): 11
- Odznaczone na podstawie Agent 5 E2E: 0
- Pozostawione dla operatora (Manual): 6 (Test: [Manual] z Unit 5/6)
- Niejasne (P3): 0
- Failujace (P2): 1 (Grep FAIL `class="env-btn"`)

### Szczegoly

Unit 5:
- [x] Grep: kazdy ID z kontraktu obecny (petla grep, brak „BRAK") → PASS (54/54 ID obecne w public/index.html)
- [x] Grep: `enum-map.js` w index.html i przed `app.js` → PASS (enum-map line 271, app.js line 273)
- [x] Grep: `<title>Puls` i `rel="icon"` → PASS
- [ ] Grep: `class="env-btn"` → FAIL — atrybut to `class="env-opt env-btn active"`, wzorzec literalny `class="env-btn"` nietrafiony; token klasy `env-btn` JEST obecny (linia 25-26). Analogia do `--mute` z Fazy 1 — mismatch wzorca grep, nie brak funkcji. (P2)
- [ ] Manual: Render header/taby/statbar/sekcje, modal otwiera/zamyka, akordeon — wymaga operatora (checklist)

Unit 6:
- [x] CLI: `node --check public/app.js` → PASS
- [x] Grep: `EnumMap` w app.js → PASS
- [x] Grep: `/api/runs/recent` w app.js → PASS
- [x] Grep: `renderStatbar` w app.js → PASS
- [x] Grep: `tab-panel` zwraca pusto → PASS (0 wystapien, tab-switching przepisany)
- [ ] Manual: Lista zadan z /api/jobs; tagi/sparkline/nastepny/switch — wymaga operatora (checklist)
- [ ] Manual: akcje ▶/⏻/✎/✕ + toast; modal nowy/edycja, segment, webhook, zapis — wymaga operatora (checklist)
- [ ] Manual: Historia 5 statusow, rozwijanie, log viewer, filtr rutynowych — wymaga operatora (checklist)
- [ ] Manual: Statbar na realnych liczbach na kazdej zakladce — wymaga operatora (checklist)
- [ ] Manual: Polling 3s bez migotania, rozwiniety log nie zwija sie — wymaga operatora (checklist)
- [ ] Manual: Kill-bar gdy job leci; env-toggle tylko gdy VPS — wymaga operatora (checklist)

Unit 7:
- [x] Grep: `Puls running` w server.js i brak `CLAUDE-CRON running` → PASS
- [x] CLI: `node -e package.json` (name=claude-cron, scripts.test='node --test', /Puls/ w description) → PASS (exit 0)
- [x] CLI: `npm test` → PASS (39 pass / 0 fail)

---

## Severity gate (finalny po bookkeepingu)

- P1 (KOD/TEST/E2E): 0
- P2 (KOD/TEST/E2E): 2 findingi + 1 Grep FAIL z bookkeepingu = 3 do naprawy
- P3 (KOD/TEST/E2E): 18
- OPERATOR: 4

**Bramka: ZASTRZEZENIA** — zero P1 blokujacych. Same P2 (czesciowa realizacja R4/Lista, luka pokrycia pollSignature, mismatch wzorca grep env-btn). Kontynuacja z zastrzezeniami; P2 do naprawy przed zamknieciem fazy.
