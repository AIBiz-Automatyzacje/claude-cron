# Zadania: Migracja claude-cron → Puls

Branch: `feature/migracja-puls-rebrand`
Ostatnia aktualizacja: 2026-06-23

---

## Faza 1 — Fundament (statyka, backend, moduł enumów)

### Unit 1: Assety + podmiana CSS + fonty — `feature-builder-ui` (S)
- [x] Skopiuj `puls-demo/logo-puls.png` → `public/logo-puls.png`
- [x] Skopiuj `puls-demo/favicon.png` → `public/favicon.png`
- [x] Zastąp `public/style.css` w całości wersją z `puls-demo/style.css` (diff vs źródło: IDENTYCZNE 1:1)
- [ ] Test: [Manual] Po Fazie 2: brak FOUC/brakujących glifów, kolory zgodne z demem
- [x] Weryfikacja: `test -f public/logo-puls.png && test -f public/favicon.png` zwraca sukces
- [x] Weryfikacja: `grep -q '\.modal-overlay\[hidden\]' public/style.css` i `grep -q '\.view\.active' public/style.css` przechodzą
- [ ] Weryfikacja: `grep -q -- '--mute:#7d7d7d' public/style.css` przechodzi (FAIL — CSS ma `--mute: #7d7d7d` ze spacją; token koloru poprawny, wzorzec grep nietrafiony; P2)

### Unit 2: `GET /api/runs/recent` (window function) + test — `feature-builder-data` (M)
- [x] Dodaj helper `getRecentRunsPerJob(perJob)` w `lib/db.js` (window function) + eksport
- [x] Dodaj route `GET /api/runs/recent` w `server.js` PRZED ogólnym `/api/runs` matcherem (walidacja `per_job`, default+cap)
- [x] Test (unit): `lib/db.test.js`
- [x] Notatka wykonawcza: test-first — najpierw test seeda, potem helper
- [x] Test: [Unit] Job A `*/1` (20 runów) + job B rzadki (3 runy); `getRecentRunsPerJob(7)` → A=7, B=3
- [x] Test: [Unit] Wynik DESC po `id` w obrębie joba
- [x] Test: [Unit] `per_job=0`/brak → fallback default (nie crash, nie pusta tablica gdy są runy)
- [x] Test: [Manual] `curl localhost:7777/api/runs/recent?per_job=7` zwraca runy pogrupowane per job (zweryfikowane na izolowanej instancji :7799)
- [x] Weryfikacja: `node --test lib/db.test.js` przechodzi
- [x] Weryfikacja: `node -e "require('./lib/db').getRecentRunsPerJob"` nie rzuca
- [x] Weryfikacja: `node server.js` startuje bez błędu i nasłuchuje na 7777

### Unit 3: Wzbogacony `/api/status` (today + next) + test — `feature-builder-data` (M)
- [x] Dodaj helper `getTodayRunStats()` w `lib/db.js` (`date('now','localtime')`) + eksport
- [x] Wzbogać `/api/status` w `server.js` o `today_success/today_failed` (db) + `next:{job_name,next_run}` (min z `scheduler.getNextRun` enabled jobów), zachowując istniejące pola
- [x] Test (unit): rozszerz `lib/db.test.js`
- [x] Notatka wykonawcza: test-first dla `getTodayRunStats` (granica północy lokalnej)
- [x] Test: [Unit] Seed runów dziś (localtime) i wczoraj → liczy tylko dzisiejsze, rozdziela success/failed
- [x] Test: [Unit] Run po północy lokalnej (przed północą UTC) liczony jako „dziś" (regresja UTC)
- [x] Test: [Unit] Brak runów dziś → `{success:0, failed:0}` (nie null)
- [x] Test: [Manual] `curl localhost:7777/api/status` zawiera `today_success`, `today_failed`, `next` (zweryfikowane na :7799 → today_success:530, next:{job_name,next_run})
- [x] Weryfikacja: `node --test lib/db.test.js` przechodzi
- [x] Weryfikacja: `node -e "require('./lib/db').getTodayRunStats"` nie rzuca
- [x] Weryfikacja: `/api/status` zwraca klucze `today_success` i `next` (test integracyjny lub grep handlera w `server.js`) — grep handlera PASS

### Unit 4: Moduł `enum-map` (kanon §4.0) + test — `feature-builder-data` (S)
- [x] Stwórz `public/enum-map.js` (dual-export; `mapStatus`, `mapTrigger`)
- [x] Test (unit): `public/enum-map.test.js`
- [x] Notatka wykonawcza: test-first, wertykalnie (jeden mapping → test → następny)
- [x] Test: [Unit] `mapStatus('failed')` → `{cls:'badge-err', label:'Błąd'}`
- [x] Test: [Unit] `mapStatus('killed')` → `badge-stop`; `mapStatus('queued')` → `badge-run`
- [x] Test: [Unit] `mapStatus('nieznane')` → fallback z niepustym cls i label
- [x] Test: [Unit] `mapTrigger('scheduled')` → Harmonogram; `mapTrigger('retry')` → Harmonogram (fallback)
- [x] Weryfikacja: `node --test public/enum-map.test.js` przechodzi
- [x] Weryfikacja: `node -e "const m=require('./public/enum-map.js'); process.exit(m.mapStatus('failed').cls==='badge-err'?0:1)"` kończy się kodem 0

---

## Do poprawy po review fazy 1

- [x] 🟠 [P2] **public/logo-puls.png** — logo waży 1.2 MB (nieskompresowany PNG, 60x większy od favicona); Faza 2 podpina je w headerze → ładowane przy każdym wejściu. Zoptymalizować (kompresja PNG/WebP/downscale, cel < 50 KB). → FIX: downscale 1254→256px + paleta 256 kolorów (alfa zachowana, RMSE 0.006), 1.2 MB → 17.7 KB.
- [x] 🟠 [P2] **server.js:64-67** — `serveStatic` używa `fs.readFileSync` (blokuje event-loop) i nie ustawia `Cache-Control`/`ETag`/`Last-Modified`; przy 1.2 MB logo => re-pobieranie przy każdym odświeżeniu. Dodać nagłówki cache dla assetów statycznych. → FIX: `fs.readFile` (async), `Cache-Control: public, max-age=3600` + `ETag` + `Last-Modified` dla assetów, `no-cache` dla HTML, obsługa 304.
- [x] 🟠 [P2] **lib/db.js:190-196** — `getRecentRunsPerJob` używa `SELECT *`, ciągnie `stdout/stderr/webhook_payload` (do 50 runów/job, ~450 KB zbędnego payloadu/poll); endpoint sparkline ich nie wyświetla. Wybrać jawnie `id, job_id, status, started_at` (+ ewent. trigger/finished). → FIX: jawne kolumny `id, job_id, status, trigger_type, started_at, finished_at`, usunięty wyciek `rn`.
- [x] 🟠 [P2] **server.js:134** — `computeNextRun` nie ma testu jednostkowego (zadeklarowana lokalnie, nieeksportowana → nietestowalna). Wyciągnąć do `lib/` i pokryć: brak enabled → null, kilka jobów → min, job z null nextRun pomijany. → FIX: wyciągnięta do `lib/next-run.js` (DI `getNextRun`), `lib/next-run.test.js` 5 testów.
- [x] 🟠 [P2] **lib/config.js:10** — naruszenie granicy scope: plan §Granice (l.20) listuje `lib/config.js` jako „NIE ruszamy", a Unit 2/3 dodał override `CLAUDE_CRON_DB`. Produkcja zachowana (default niezmieniony), ale wymaga świadomego sign-offu albo przeniesienia izolacji testów do warstwy testu (`:memory:`/DI) bez dotykania config.js. → FIX: config.js przywrócony (bez env override), izolacja przeniesiona do warstwy testu przez `db.setDbPath(':memory:')` (DI, źródło §292).
- [x] 🟠 [P2] **server.js:133-146** — `computeNextRun` (R7, zasila `next` w statbarze) bez żadnego testu; plan pominął ją (zdefiniował tylko `getTodayRunStats`). Testowalna jako czysta logika (stub `scheduler.getNextRun`). Dodać 1 happy path (min z 2 jobów) + 1 edge (null gdy brak/wszystkie disabled). → FIX: pokryte w `lib/next-run.test.js` (min z 2 jobów, null gdy wszystkie disabled, pomijanie null nextRun).
- [x] 🟠 [P2] **server.js:301-307** [E2E] — route `GET /api/runs/recent?per_job=N` bez testu integracyjnego; krytyczny porządek if-ów (musi być PRZED `/api/runs`), inaczej zły kształt odpowiedzi. Brak asercji headless — wymaga wstania serwera HTTP. → E2E PASS: serwer na :7788, fetch z origin przeglądarki → `/api/runs/recent` zwraca kształt per-job (bez stdout/rn), `/api/runs` ma stdout → kształty różne (route dopasowany przed `/api/runs`).
- [ ] 🟠 [P2] **public/style.css** — checkbox weryfikacji `--mute` failuje: CSS ma `--mute: #7d7d7d` (spacja po dwukropku), wzorzec grep szuka `--mute:#7d7d7d`. Token koloru poprawny; poprawić wzorzec checkboxa lub formatowanie CSS.

P3 (nity — opcjonalnie, szczegóły w `review-faza-1.md`): `SELECT *` + wyciek kolumny `rn` w `/api/runs/recent` (lib/db.js:182-194), nie-sargable `date(...,'localtime')` przy pollu `/api/status` (server.js:144-157), niejawny kontrakt porównania ISO-string (server.js:134-146), walidacja `per_job` poza granicą API (server.js:303-306), nieudokumentowana decyzja agregacji timeout/killed jako failed (getTodayRunStats), brak pinowania TZ w teście regresji UTC (lib/db.test.js:105-118), brak jawnej asercji boundary string-nie-int (lib/db.test.js:168-203), kontrakt API `/api/status` bez asercji headless (server.js:172-189).

## Operator checklist faza 1

- [ ] Operator: parytet API w trybie VPS — wzbogacony `/api/status` (today_success/today_failed/next) i nowy `/api/runs/recent` działają w proxy VPS dopiero po deployu tego samego kodu na VPS; do tego czasu statbar/sparkline w trybie VPS mogą mieć braki (graceful degrade) — Operator action: zdeployuj kod Fazy 1 na VPS, następnie zweryfikuj `curl <vps>/api/status` (obecność today_success/next) oraz `curl <vps>/api/runs/recent?per_job=7` (kształt pogrupowany per job) i porównaj z instancją lokalną.

---

## Faza 2 — Front + rebrand widoczny

### Unit 5: Przepisany `public/index.html` (markup dema + KONTRAKT ID + elementy produkcyjne) — `feature-builder-ui` (L)
- [ ] Przepisz `public/index.html`: header (logo+brand+env-toggle), `nav.tabs`, `statbar`, 3× `section.view`
- [ ] DOMERGE elementów produkcyjnych: kill-bar, toast-container, modal (pełny kontrakt `form-*`), webhook-section, akordeon zaawansowany
- [ ] Segment typu BINARNY Skill/Skrypt + ukryty `input#form-job-type`; webhook osobna sekcja
- [ ] Head: `<title>Puls — Zadania dla Twojego Asystenta AI</title>`, favicon, fonty Google; `enum-map.js` PRZED `app.js`
- [ ] Odtwórz KONTRAKT ID 1:1 (lista w kontekst.md)
- [ ] Test: [Manual] Render: header/taby/statbar/sekcje widoczne, modal otwiera/zamyka, akordeon działa
- [ ] Weryfikacja: każdy ID z kontraktu obecny (pętla grep po `id="..."` nie wypisuje „BRAK")
- [ ] Weryfikacja: `grep -q 'enum-map.js' public/index.html` i `enum-map.js` przed `app.js` w pliku
- [ ] Weryfikacja: `grep -q '<title>Puls' public/index.html` i `grep -q 'rel="icon"' public/index.html`
- [ ] Weryfikacja: `grep -q 'class="env-btn"' public/index.html`

### Unit 6: Przepisany render w `public/app.js` (logika zachowana, render z API, poll z guardem) — `feature-builder-ui` (XL)
- [ ] ZACHOWAJ bez zmian: `API/apiBase/switchEnv`, `loadJobs/loadSkills`, akcje, cron helpers, webhook helpers, `formatClaudeOutput/formatToolUse`, helpery format/esc/truncate/toast/showPromptPopup
- [ ] Przepisz `renderJobs()` (gęsta tabela + sparkline z `/api/runs/recent` + akcja ✕ deleteJob)
- [ ] Przepisz `renderRuns()` (5 statusów przez `EnumMap`, log viewer Kopiuj/Zawijaj/Pełny ekran, pill „Rutynowe" z `jobsMap`)
- [ ] Przepisz `renderSkills()` (toggle Kafelki/Lista + filtry + stopki „N zadań · ostatnio X")
- [ ] Nowy `renderStatbar(status)` wyłącznie z wzbogaconego `/api/status`
- [ ] Modal: logika segmentu binarnego pisząca do `form-job-type` (`onJobTypeChange`)
- [ ] Tab-switching przepisany na `.view`/`view-${tab}`+`.active`; `data-tab` = `jobs/history/skills`
- [ ] Zmodyfikuj `poll()`: statbar 3s na każdej zakładce + guard zmian + zachowanie `expandedRuns`
- [ ] Notatka wykonawcza: zachowaj sygnatury zachowanych funkcji; render-first jednej zakładki na raz
- [ ] Test: [Manual] Lista zadań z `/api/jobs`; tagi/sparkline/następny/switch poprawne
- [ ] Test: [Manual] ▶/⏻/✎/✕ + toast; modal nowy/edycja, segment przełącza pola, webhook generate/copy, zapis POST/PUT
- [ ] Test: [Manual] Historia: 5 statusów, rozwijanie błędu, log viewer, filtr „Ukryj rutynowe"
- [ ] Test: [Manual] Statbar na realnych liczbach na każdej zakładce
- [ ] Test: [Manual] Polling 3s bez migotania, rozwinięty log nie zwija się
- [ ] Test: [Manual] Kill-bar gdy job leci; env-toggle tylko gdy VPS skonfigurowany
- [ ] Weryfikacja: `node --check public/app.js` przechodzi
- [ ] Weryfikacja: `grep -q 'EnumMap' public/app.js`
- [ ] Weryfikacja: `grep -q '/api/runs/recent' public/app.js`
- [ ] Weryfikacja: `grep -q 'renderStatbar' public/app.js`
- [ ] Weryfikacja: `grep -q 'tab-panel' public/app.js` zwraca pusto (tab-switching przepisany)

### Unit 7: Rebrand backendu + `package.json` — `feature-builder-data` (S)
- [ ] Zmień banner w `server.js` (371-372): `🫀  Puls running at http://localhost:${PORT}`
- [ ] `package.json`: `description` → „Puls — scheduler agentów AI (Claude Code), AIBIZ"; dodaj `"test": "node --test"` (`name` ZOSTAJE `claude-cron`)
- [ ] Test: [Unit] `npm test` (`node --test`) uruchamia testy i kończy się sukcesem
- [ ] Weryfikacja: `grep -q 'Puls running' server.js` i brak `CLAUDE-CRON running`
- [ ] Weryfikacja: `node -e "const p=require('./package.json'); process.exit((p.name==='claude-cron' && p.scripts.test==='node --test' && /Puls/.test(p.description))?0:1)"` kończy się kodem 0
- [ ] Weryfikacja: `npm test` przechodzi

---

## Faza 3 — Szersza warstwa testów backendu

### Unit 8: Regresja webhooka + legacy `db`/`scheduler` testy — `feature-builder-data` (L)
- [ ] Wyciągnij regex tokenu z `server.js:338` do `lib/webhook.js` (`matchWebhookToken`) i podmień użycie w `server.js`
- [ ] Stwórz `lib/webhook.test.js`
- [ ] Stwórz `lib/scheduler.test.js` (`getNextRun`/cron dla 5 wzorców + zły cron)
- [ ] Rozszerz `lib/db.test.js` (`getRuns` hideRoutine/job_id, `deleteOldRoutineRuns`, CASCADE)
- [ ] Notatka wykonawcza: wertykalnie; nie modyfikuj testów by przeszły — napraw kod
- [ ] Test: [Unit] `getRuns({hideRoutine:true})`: udany run rutynowego ukryty, jego FAIL widoczny; nierutynowe zawsze
- [ ] Test: [Unit] `getRuns({job_id})`: tylko runy danego joba, DESC, respektuje `limit`
- [ ] Test: [Unit] `deleteOldRoutineRuns`: kasuje tylko `success` rutynowych > cutoff; reszta zostaje
- [ ] Test: [Unit] CASCADE: `deleteJob` kasuje też jego runy
- [ ] Test: [Unit] `scheduler.getNextRun`/cron: 5 wzorców → poprawny czas; zły cron → kontrolowany błąd
- [ ] Test: [Unit] `matchWebhookToken`: `plain` ✓, `?query` ✓ (regresja), bez query ✓, nielegalny znak → null
- [ ] Weryfikacja: `node --test` (cały zestaw) przechodzi
- [ ] Weryfikacja: `node -e "require('./lib/webhook').matchWebhookToken"` nie rzuca
- [ ] Weryfikacja: `grep -q 'matchWebhookToken' server.js`

---

## Faza 4 — Odroczone (po akceptacji Faz 1–3)

### Unit 9: Kalendarz (widok tygodnia, occurrences w JS) — `feature-builder-ui` (L)
- [ ] Dodaj `renderKalendarz()` + liczenie occurrences z `cron_expr` enabled jobów w `public/app.js`
- [ ] Filtr script-jobów (`hours`/`minutes`) domyślnie ukryty; kropki 3-stanowe; tylko widok Tydzień
- [ ] Test: [Manual] Job daily codziennie; weekly tylko swój dzień; minutowy/godzinowy ukryty
- [ ] Test: [Manual] Kropki 3-stanowe; wyłączony job bez wystąpień; scroll w kolumnie dnia
- [ ] Weryfikacja: `node --check public/app.js` przechodzi
- [ ] Weryfikacja: `grep -q 'renderKalendarz' public/app.js`
- [ ] Operator checklist: weryfikacja widoku tygodnia w przeglądarce na realnych danych (occurrences vs next_run)

### Unit 10: README rebrand + usunięcie `_preview.html` — `feature-builder-data` (S)
- [ ] Rebrand nagłówka i opisu w `README.md` → Puls (bez zmiany instrukcji technicznych)
- [ ] Potwierdź że `public/_preview.html` jest martwy (brak referencji) i usuń
- [ ] Test: [Manual] README czyta się jako „Puls", instrukcje instalacji poprawne
- [ ] Weryfikacja: `grep -q -i 'Puls' README.md`
- [ ] Weryfikacja: `test ! -f public/_preview.html`
- [ ] Weryfikacja: `grep -rq '_preview.html' public server.js` zwraca pusto

---

## Operator checklist — test lokalny przed deployem (§8 dokumentu źródłowego)
- [ ] `node server.js` (NIE pod daemonem), otwórz http://localhost:7777
- [ ] Lista zadań z `/api/jobs`: tagi/sparkline/następny/switch
- [ ] ▶ trigger, ⏻ toggle, ✎ edit, ✕ delete — każda akcja + toast
- [ ] Modal: nowy + edycja, segment przełącza pola, webhook generate/copy, zapis POST/PUT
- [ ] Historia: statusy, rozwijanie błędu, log viewer, filtr rutynowych
- [ ] Skille: toggle Kafelki/Lista, filtry, stopki „N zadań"
- [ ] Statbar: Następne/Aktywne/Dziś+health/Kolejka/Uptime na realnych liczbach
- [ ] Kill-bar pokazuje się gdy job leci
- [ ] Polling 3s odświeża bez migotania
- [ ] Env toggle VPS (jeśli skonfigurowany)
- [ ] Po akceptacji: restart daemonów Mac+CAVE+Windows; deploy VPS
