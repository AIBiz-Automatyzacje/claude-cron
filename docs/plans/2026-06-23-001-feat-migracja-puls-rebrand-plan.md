---
title: "feat: Migracja claude-cron → Puls (rebrand + nowy front z dema + 2 dodatki backendu)"
type: feat
status: active
date: 2026-06-23
origin: MIGRACJA-PULS.md
design_md: null          # brak docs/DESIGN.md; źródło designu = puls-demo/style.css (zaakceptowany 1:1, kopiowany w całości)
figma_spec: null         # demo materializuje już cały design z Figmy — fetch SPEC redundantny
figma_screens: {}        # wzorzec wizualny: puls-demo/index.html + style.css (na dysku poza repo)
---

# feat: Migracja claude-cron → Puls (rebrand + nowy front z dema + 2 dodatki backendu)

## Przegląd

Rebrand `claude-cron` → **Puls** i podmiana całego frontu na zaakceptowany prototyp z projektu `~/Documents/Kodowanie/puls-demo/`. Złota zasada (zob. źródło: `MIGRACJA-PULS.md` §intro): **front (HTML/CSS/render) bierzemy z dema, logikę (fetch API, cron, webhook, polling) zachowujemy z obecnego `public/app.js`**. Demo renderuje z mocka — produkcja renderuje z `/api/*`; markup i style identyczne, źródło danych inne.

Dochodzą **dwa kontrolowane dodatki backendu** (decyzja po roaście, zob. źródło §4.1/§4.2): nowy `GET /api/runs/recent?per_job=N` (window function) oraz wzbogacony `/api/status` o `today_success/today_failed/next`. Reszta backendu (routing, executor, scheduler, SPA fallback, X-Forwarded-For block) pozostaje nietknięta. Projekt nie ma żadnych testów — wprowadzamy warstwę `node:test` dla testowalnej logiki backendu (zob. źródło §9).

## Ujęcie problemu

Obecny front to retro-arcade UI sklejone ad-hoc; nie pokrywa nowego designu AIBIZ „Dark Impact" ani gęstej tabeli zadań, log viewera, statbara health i widoku skilli w dwóch trybach. Demo zostało zaprojektowane i zaakceptowane jako docelowy UX, ale renderuje z mocka z **fikcyjnymi enumami** — produkcja musi renderować z realnych danych API z poprawnym mapowaniem statusów/triggerów. Dodatkowo dwa elementy UI (OSTATNI RUN + 7-run sparkline w tabeli zadań oraz globalny statbar) są niemożliwe do zasilenia istniejącym API bez N+1 albo bez tab-zależnych fetchy — stąd dwa dodatki backendu.

## Śledzenie wymagań

- **R1.** Rebrand widoczny: tytuł, favicon, header (logo + „Puls" + claim), banner serwera, `package.json.description` — bez ruszania technicznych ID (zob. źródło §0, §1).
- **R2.** `public/style.css` zastąpione w całości wersją z dema (design system Dark Impact wraz z fixami: `.modal-overlay[hidden]`, `.view/.view.active`, `.switch`, `min-width:0`, `--mute`) (źródło §2.1).
- **R3.** `public/index.html` = markup dema + **domerge** produkcyjnych elementów (kill-bar, toast, prompt-popup, webhook section, pola zaawansowane modala) przy zachowaniu **KONTRAKTU ID** czytanego przez zachowaną logikę (źródło §2.2, §3).
- **R4.** `public/app.js` = zachowana logika (fetch/cron/webhook/format/poll) + przepisana warstwa render (tabela zadań, historia + log viewer, skille 2 widoki, statbar, modal binarny Skill/Skrypt) (źródło §2.3).
- **R5.** Mapowanie danych UI dema → API produkcji wg **kanonu enumów §4.0** (status `success→ok`, `failed→err`, `killed→stop`, `timeout`, `running/queued→run`; trigger `scheduled→Harmonogram`, `manual→Ręcznie`, `webhook→Webhook`, `retry→Harmonogram`; `routine=1` to **flaga joba**, nie trigger).
- **R6.** Nowy `GET /api/runs/recent?per_job=N` (window function `ROW_NUMBER() OVER (PARTITION BY job_id ...)`) zasila OSTATNI RUN + 7-run sparkline, dokładnie N per job niezależnie od kadencji (źródło §4.2).
- **R7.** Wzbogacony `/api/status` o `today_success`, `today_failed` (liczone `date('now','localtime')`) i `next:{job_name,next_run}` (min next_run enabled) — JEDYNE źródło globalnego statbara (źródło §4.1).
- **R8.** `poll()` z guardem zmian (pomiń re-render gdy podpis payloadu bez zmian) + zachowanie stanu rozwinięcia runów (`expandedRuns`), statbar pollowany 3s na każdej zakładce (źródło §2.3).
- **R9.** Testy `node:test` dla nowej logiki backendu + regresja webhooka + moduł mapowania enumów; `"test": "node --test"` w `package.json` (źródło §9).
- **R10.** Kalendarz (widok tygodnia, occurrences liczone w JS, 3-stanowe kropki, filtr script-jobów) — **odroczony do osobnej fazy** po domknięciu Listy/Historii/Skilli (źródło §5, §6 p.1).

## Granice scope'u

- **NIE ruszamy technicznych ID** (źródło §0): `DB_PATH`, `PLIST_LABEL`, `WIN_TASK_NAME`, `$SERVICE_NAME`, env `CLAUDE_CRON_*`, pole `name` w `package.json` (zostaje `claude-cron`). Migracja techniczna = osobny skrypt, poza tym rebrandem.
- **NIE ruszamy** `lib/config.js`, `lib/platform.js`, `lib/executor.js`, `scripts/install-*`, `scripts/uninstall-*`.
- Backend tykany **wyłącznie** w dwóch miejscach (`server.js` + `lib/db.js`) — żadnych zmian w routingu, executorze, schedulerze poza dodaniem helperów.
- Testy frontu (`public/app.js` render) **poza zakresem** — global-script wymaga refaktoru do modułów + jsdom. Jedyny testowany moduł frontowy to wyciągnięty `enum-map` (§4.0).
- `executor.js` (spawn Claude CLI) poza testami — kruche, drogie, wymaga mocka CLI.

## Kontekst i research

### Relevantny kod i wzorce

- **Logika do zachowania 1:1** — `public/app.js`: `API`/`apiBase`/`switchEnv` (1-54), `loadStatus/loadJobs/loadRuns/loadSkills` (239-286), `saveJob/triggerJob/toggleJob/deleteJob/killCurrent` (431-589), cron helpers `onFreqChange/buildCronFromForm/parseCronToForm/updateSchedulePreview/cronToHuman` (120-236), webhook `generateWebhook/removeWebhook/copyWebhookUrl/updateWebhookUI` (696-753), `formatClaudeOutput/formatToolUse` (624-694), helpery format/esc/truncate/toast/showPromptPopup (66-622).
- **Render do przepisania** — `public/app.js`: `renderJobs` (289-336), `renderRuns` (338-372), `renderSkills` (376-408), tab-switching (57-64, do zmiany na `.view/.view.active`), `poll/init` (756-795).
- **Wzorzec markupu/render docelowego** — `puls-demo/index.html` (struktura sekcji, modal, statbar) + `puls-demo/app.js` (`renderZadaniaLista` ze sparkline/grid-zadania, `renderHistoria` z log viewerem, `renderSkille*` 2 widoki, `renderKalendarz`). **UWAGA: demo używa innych ID** (`modalOverlay`, `taskName`, `view-zadania`) — produkcja MUSI użyć ID z kontraktu (§Kluczowe decyzje).
- **Backend pod dodatki** — `lib/db.js`: `getRuns` (163-177, wzorzec window/hideRoutine), `deleteOldRoutineRuns` (181-190), `createRun` (192-198), eksport (265-286). `server.js`: `/api/status` (154-168), `/api/runs` (261-287), webhook regex (338). `lib/scheduler.js`: `getNextRun` (76-81) — już liczy next per job (croner `nextRun()`).
- **Schema realna (NIE z `CREATE TABLE`)** — definicja w `lib/db.js:22-49` jest przestarzała (schema drift). Kolumny realne dodane migracjami (95-106): `job_type`, `command`, `routine`, `idle_timeout_ms`, `webhook_token`, `webhook_payload`. Mapowanie danych wyprowadzaj z PRAGMA / realnych wierszy.

### Wiedza instytucjonalna

- Brak `docs/solutions/` w repo — projekt nie prowadził bazy wniosków. Po domknięciu rebrandu warto udokumentować przez `/dev-compound` (kontrakt ID, kanon enumów, decyzja window function).

### Referencje zewnętrzne

- `better-sqlite3 ^12` — window functions zweryfikowane lokalnie (`ROW_NUMBER() OVER (PARTITION BY ...)` działa na Node v22.22.3, test inline PASS).
- `node:test` + `node:assert/strict` — wbudowane w Node v22, zero nowych zależności.

## Kluczowe decyzje techniczne

- **KONTRAKT ID — markup produkcji odtwarza ID czytane przez zachowaną logikę, NIE wolny markup dema.** `saveJob` czyta: `form-id, form-job-type, form-name, form-skill, form-command, form-args, form-timeout, form-idle-timeout, form-retries, form-wake, form-discord, form-routine`. Cron: `form-freq, form-time, form-day, form-interval` (+ `time-group/day-group/interval-group/interval-label`). Pozostałe: `modal-title, modal-overlay, webhook-section, webhook-empty, webhook-active, webhook-url, skill-group, args-group, command-group, schedule-preview, stat-jobs, stat-queue, stat-uptime, kill-bar, kill-job-name, jobs-body, jobs-empty, runs-body, runs-empty, skills-grid, skills-empty, count-all/project/user/plugin, runs-hide-routine, toast-container, env-toggle`. Klasy logiki: `.tab`+`data-tab`, `.env-btn`+`data-env`. Uzasadnienie: zachowana logika cicho pęka, jeśli ID się rozjadą — to główne ryzyko migracji.
- **Tab-switching przepisany na `.view`/`.view.active`** zamiast `.tab-panel`/`panel-${tab}` — demo CSS używa `.view{display:none}/.view.active{display:block}` (klasa `.tab-panel` znika z CSS). To zmiana render-layer w app.js, nie zmiana logiki danych.
- **Modal: segment BINARNY Skill/Skrypt, webhook ortogonalny.** `job_type ∈ {claude, script}`. Segment pisze do ukrytego `input#form-job-type` → `saveJob` bez zmian. Webhook to zdolność (`webhook_token` na jobie dowolnego typu) → osobna sekcja `webhook-section`. „prompt" = Skill bez wybranego skilla (nie osobny typ). Demo ma 3-way segment (Skill/Skrypt/Webhook) — produkcja redukuje do 2 (zob. źródło §2.3).
- **OSTATNI RUN + 7-run = window function, nie flat-limit.** Job rutynowy `*/1 * * * *` zjada całe okno flat-limitu; window function gwarantuje dokładnie N per job. Per-job fetch (`?job_id=X&limit=7`) to fallback (zob. źródło §4.2).
- **Statbar wyłącznie z `/api/status`.** Statbar jest globalny (każda zakładka), więc nie może zależeć od `/api/jobs` (tylko Zadania) ani `/api/runs` (tylko Historia). „Dziś" liczone `date('now','localtime')` — bez `localtime` SQLite liczy UTC i „Dziś" przeskakuje o północy UTC.
- **Moduł `enum-map` z dual-export (CJS + global).** Jedyny testowalny moduł frontowy; plik `public/enum-map.js` eksportuje przez `module.exports` (dla `node:test`) i przypisuje do globala (dla `<script>` w przeglądarce); ładowany w `index.html` PRZED `app.js`. Uzasadnienie: brak bundlera, app.js to global-script — dual-export to najprostszy sposób współdzielenia kodu testowalnego między Node a browserem (Duplication > Complexity).
- **Design source = `puls-demo/style.css` (kopiowany 1:1).** Brak `docs/DESIGN.md` i brak fetchu Figmy — demo jest zaakceptowanym, w pełni zmaterializowanym wzorcem; SPEC.md z Figmy byłby redundantny. Odroczone: utworzyć `docs/DESIGN.md` przed kolejnym UI feature'em budowanym od zera.

## Otwarte pytania

### Rozwiązane podczas planowania

- **Mapowanie enumów** (źródło §4.5/4.6 „DO WERYFIKACJI"): zweryfikowane na `data/claude-cron.db` (1829 runów) → kanon §4.0. Oba pierwotne założenia były błędne (`error`→realnie `failed`, `stopped`→`killed`).
- **Jak zasilić OSTATNI RUN + 7-run bez N+1?** → window function w nowym endpoincie (R6).
- **Window functions w better-sqlite3 ^12?** → TAK (zweryfikowane inline na Node v22.22.3).
- **Czy fetchować Figmę / tworzyć DESIGN.md?** → NIE; demo to zaakceptowany design source (§Kluczowe decyzje).
- **Lokalizacja modułu enumów testowalnego z `node:test` i ładowalnego w przeglądarce?** → `public/enum-map.js` dual-export.
- **Harness E2E?** → brak `.env.e2e` w projekcie; scenariusze przeglądarkowe → `Operator checklist [Manual]`, nie autonomiczne `[E2E]`.

### Odroczone do implementacji

- Dokładne nazwy nowych helperów `db.js` (np. `getRecentRunsPerJob`, `getTodayRunStats`) — do ustalenia przy dotknięciu kodu.
- Finalny kształt „podpisu payloadu" dla guardu `poll()` (np. `runs.length + runs[0]?.id + statuses.join`) — do dostrojenia przy renderze, by uniknąć migotania.
- Kalendarz: szczegóły liczenia occurrences (granice tygodnia, mapowanie statusu run→kropka) — odroczone do fazy kalendarza (R10).
- Czy `enum-map` ma też mapować trigger→ikona, czy ikony zostają w renderze app.js — decyzja przy ekstrakcji (minimalizuj zakres modułu).

## Implementation Units

> Fazy: **Faza 1** (1–4) statyczne + backend + moduł — można równolegle. **Faza 2** (5–7) front + rebrand — zależne od Fazy 1. **Faza 3** (8) szersza warstwa testów. **Faza 4** (9–10) kalendarz + README/cleanup, odroczone.

### Faza 1 — Fundament (statyka, backend, moduł enumów)

- [x] **Unit 1: Assety + podmiana CSS + fonty**

**Cel:** Wgrać design system Dark Impact i assety brandu, by markup z Fazy 2 miał komplet klas/zmiennych.

**Wymagania:** R1 (częściowo: favicon/fonty), R2

**Zależności:** Brak

**Pliki:**
- Stwórz: `public/logo-puls.png` (kopia z `~/Documents/Kodowanie/puls-demo/logo-puls.png`)
- Stwórz: `public/favicon.png` (kopia z `~/Documents/Kodowanie/puls-demo/favicon.png`)
- Modyfikuj (zastąp w całości): `public/style.css` ← `puls-demo/style.css`

**Delegate to:** feature-builder-ui

**Skills in play:** tailwind-react-guidelines, ux-ui-guidelines, figma:figma-use, figma:figma-implement-design

**Podejście:**
- `public/style.css` zastępujemy w całości — zawiera już fixy z budowy dema (`.modal-overlay[hidden]{display:none}`, `.view/.view.active`, `.switch{display:inline-block}`, `min-width:0` na komórkach grida, `--mute:#7d7d7d` WCAG AA).
- Assety kopiujemy binarnie (nie przepisywać). Fonty (Outfit + Inter + JetBrains Mono) wchodzą jako `<link>` w Fazie 2 (Unit 5) — tu tylko CSS ich używa.

**Wzorce do naśladowania:**
- `puls-demo/style.css` (źródło 1:1)

**Scenariusze testowe:**
- [Manual] Po Fazie 2: brak FOUC/brakujących glifów, kolory zgodne z demem.

**Weryfikacja:**
- `test -f public/logo-puls.png && test -f public/favicon.png` zwraca sukces (oba assety istnieją)
- `grep -q '\.modal-overlay\[hidden\]' public/style.css` i `grep -q '\.view\.active' public/style.css` przechodzą (fixy obecne)
- `grep -q -- '--mute:#7d7d7d' public/style.css` przechodzi (WCAG AA wariant)

---

- [x] **Unit 2: Backend — `GET /api/runs/recent?per_job=N` (window function) + test**

**Cel:** Jeden endpoint zwracający dokładnie N ostatnich runów per job, niezależnie od kadencji — źródło OSTATNI RUN + 7-run sparkline.

**Wymagania:** R6, R9

**Zależności:** Brak

**Pliki:**
- Modyfikuj: `lib/db.js` (dodaj helper, np. `getRecentRunsPerJob(perJob)` z window function; dopisz do `module.exports`)
- Modyfikuj: `server.js` (dodaj route `GET /api/runs/recent` PRZED ogólnym `/api/runs` matcherem; czytaj `per_job` z params, walidacja int, sensowny default i cap)
- Test (unit): `lib/db.test.js`

**Delegate to:** feature-builder-data

**Skills in play:** supabase-dev-guidelines, security, sentry-integration

**Podejście:**
- SQL: `SELECT * FROM (SELECT r.*, ROW_NUMBER() OVER (PARTITION BY job_id ORDER BY id DESC) rn FROM runs r) WHERE rn <= ?`.
- Route musi być dopasowany **przed** `segments[1]==='runs'` ogólnym matcherem w `server.js` (kolejność if-ów), inaczej zostanie złapany przez `/api/runs`.
- Walidacja `per_job`: parseInt, fallback (np. 7), górny cap (np. 50) — fail-safe na granicy API.

**Notatka wykonawcza:** Test-first — najpierw test seeda (job co-minutę + job rzadki → oba dostają dokładnie N), potem helper.

**Wzorce do naśladowania:**
- `lib/db.js:getRuns` (przygotowane statementy, `.all()`), eksport w 265-286
- `server.js` matchery `/api/runs` (261-287) — wzorzec parsowania params

**Scenariusze testowe:**
- [Unit] Seed: job A `*/1` z 20 runami + job B rzadki z 3 runami; `getRecentRunsPerJob(7)` → A dostaje 7, B dostaje 3 (mniej niż N gdy mniej runów).
- [Unit] Wynik DESC po `id` w obrębie joba.
- [Unit] `per_job=0` lub brak → fallback default (nie crash, nie pusta tablica gdy są runy).
- [Manual] `curl localhost:7777/api/runs/recent?per_job=7` zwraca runy pogrupowane per job.

**Weryfikacja:**
- `node --test lib/db.test.js` przechodzi (testy recent PASS)
- `node -e "require('./lib/db').getRecentRunsPerJob"` nie rzuca (helper wyeksportowany)
- `node server.js` startuje bez błędu (route nie psuje routingu) — proces wstaje i nasłuchuje na 7777

---

- [x] **Unit 3: Backend — wzbogacony `/api/status` (today + next) + test**

**Cel:** `/api/status` jako jedyne źródło globalnego statbara — dorzucić `today_success`, `today_failed`, `next:{job_name,next_run}`.

**Wymagania:** R7, R9

**Zależności:** Brak (równolegle z Unit 2; oba dotykają `lib/db.js` + `server.js` — uwaga na merge, ale różne funkcje/sekcje)

**Pliki:**
- Modyfikuj: `lib/db.js` (helper np. `getTodayRunStats()` → `{success, failed}` liczone `WHERE date(started_at)=date('now','localtime')`; dopisz do eksportu)
- Modyfikuj: `server.js` (`/api/status` 154-168: dorzuć `today_success/today_failed` z db oraz `next` policzone z enabled jobów przez `scheduler.getNextRun` — min `next_run` + `job.name`)
- Test (unit): `lib/db.test.js` (rozszerz)

**Delegate to:** feature-builder-data

**Skills in play:** supabase-dev-guidelines, security, sentry-integration

**Podejście:**
- „Dziś" MUSI używać `date('now','localtime')` — bez tego granica liczona w UTC (dla PL przeskok o 1:00/2:00).
- „Następne": iteruj enabled joby, `scheduler.getNextRun(job.id)`, wybierz min nie-null → `{job_name, next_run}`. Scheduler już liczy per job (croner), nie duplikuj logiki cron.
- Zachowaj istniejące pola `/api/status` (uptime, current_run, queue_length, total_jobs, enabled_jobs, autostart) — tylko dodajemy.

**Notatka wykonawcza:** Test-first dla `getTodayRunStats` (granica północy lokalnej).

**Wzorce do naśladowania:**
- `server.js:/api/status` (154-168), `lib/scheduler.js:getNextRun` (76-81)

**Scenariusze testowe:**
- [Unit] Seed runów z `started_at` dziś (localtime) i wczoraj → `getTodayRunStats` liczy tylko dzisiejsze, rozdziela success vs failed.
- [Unit] Run tuż po północy lokalnej (ale przed północą UTC) liczony jako „dziś" (regresja UTC).
- [Unit] Brak runów dziś → `{success:0, failed:0}` (nie null).
- [Manual] `curl localhost:7777/api/status` zawiera `today_success`, `today_failed`, `next`.

**Weryfikacja:**
- `node --test lib/db.test.js` przechodzi (testy today PASS)
- `node -e "require('./lib/db').getTodayRunStats"` nie rzuca
- `node -e "const http=require('http');require('./server.js');setTimeout(()=>http.get('http://localhost:7777/api/status',r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{const j=JSON.parse(d);process.exit(('today_success'in j&&'next'in j)?0:1)})}),500)"` kończy się kodem 0 (pola obecne) — *(jeśli niewygodne w autopilot, zastąp grep-em na obecność kluczy w handlerze `server.js`)*

---

- [x] **Unit 4: Moduł `enum-map` (kanon §4.0) + test**

**Cel:** Wyciągnąć mapowanie realna-wartość → demo-kod/UI do jednego testowalnego modułu (dual-export), używanego przez render w app.js.

**Wymagania:** R5, R9

**Zależności:** Brak

**Pliki:**
- Stwórz: `public/enum-map.js` (dual-export: `module.exports` + global; funkcje np. `mapStatus(status)→{cls,label}`, `mapTrigger(trigger)→{ico,label}`)
- Test (unit): `public/enum-map.test.js`

**Delegate to:** feature-builder-data

**Skills in play:** supabase-dev-guidelines, security, sentry-integration

**Podejście:**
- Mapowania (kanon §4.0): status `success→{badge-ok,'Sukces'}`, `failed→{badge-err,'Błąd'}`, `timeout→{badge-timeout,'Timeout'}`, `killed→{badge-stop,'Zatrzymany'}`, `running→{badge-run,'Działa'}`, `queued→{badge-run,'W kolejce'}`, nieznany → fallback (nie pusty badge). Trigger `scheduled→{◷,'Harmonogram'}`, `manual→{⚇,'Ręcznie'}`, `webhook→{⬡,'Webhook'}`, `retry→Harmonogram` (fallback).
- Dual-export wzór: `(function(root){ const api={...}; if(typeof module!=='undefined'&&module.exports) module.exports=api; else root.EnumMap=api; })(typeof globalThis!=='undefined'?globalThis:this);`
- Pill „Rutynowe" to **flaga joba** (`jobsMap[run.job_id].routine`), NIE trigger — moduł NIE mapuje routine jako triggera; render dokłada pill osobno.

**Notatka wykonawcza:** Test-first — wertykalnie: jeden mapping → test → następny.

**Wzorce do naśladowania:**
- `puls-demo/app.js:STATUS_META/TRIGGER_ICO` (56-61) — kształt danych (ale wartości wg kanonu §4.0, NIE fikcyjnych z mocka)

**Scenariusze testowe:**
- [Unit] `mapStatus('failed')` → `{cls:'badge-err', label:'Błąd'}`.
- [Unit] `mapStatus('killed')` → `badge-stop`; `mapStatus('queued')` → `badge-run`.
- [Unit] `mapStatus('cokolwiek-nieznane')` → fallback z niepustym cls i label (nie pusty badge).
- [Unit] `mapTrigger('scheduled')` → Harmonogram; `mapTrigger('retry')` → Harmonogram (fallback).

**Weryfikacja:**
- `node --test public/enum-map.test.js` przechodzi (wszystkie mapping PASS)
- `node -e "const m=require('./public/enum-map.js'); process.exit(m.mapStatus('failed').cls==='badge-err'?0:1)"` kończy się kodem 0

---

### Faza 2 — Front + rebrand widoczny

- [ ] **Unit 5: Przepisany `public/index.html` (markup dema + KONTRAKT ID + elementy produkcyjne)**

**Cel:** Docelowy szkielet UI z dema, z ID czytanymi przez zachowaną logikę i z elementami produkcyjnymi, których demo nie ma.

**Wymagania:** R1 (head: title/favicon/fonty), R3

**Zależności:** Unit 1 (klasy CSS), Unit 4 (`enum-map.js` istnieje do `<script>`)

**Pliki:**
- Modyfikuj (przepisz): `public/index.html`

**Delegate to:** feature-builder-ui

**Skills in play:** tailwind-react-guidelines, ux-ui-guidelines, figma:figma-use, figma:figma-implement-design

**Podejście:**
- Baza markupu: `puls-demo/index.html`. Szkielet: `<header class="header">` (logo + brand-text + env-toggle z `id="env-toggle"` `style="display:none"` + przyciski `.env-btn data-env`), `<nav class="tabs">` (`.tab data-tab="jobs/history/skills"` — dopasuj `data-tab` do tego, co czyta `poll()` w app.js), `<div class="statbar">` (z ID: `stat-jobs/stat-queue/stat-uptime` + elementy „Następne"/„Dziś"+health), 3× `<section class="view" id="view-...">`.
- **DOMERGE elementów produkcyjnych (źródło §3):** kill-bar (`id="kill-bar"`, `id="kill-job-name"`, przycisk `onclick="killCurrent()"`), `toast-container`, modal z pełnym kontraktem pól (`form-*`), `webhook-section` (`webhook-empty/active/url`), akordeon „Opcje zaawansowane" (idle-timeout, retries, wake, discord, routine). Prompt-popup tworzony dynamicznie w app.js (nie wymaga statycznego markupu).
- **Segment typu BINARNY** Skill/Skrypt + ukryty `input#form-job-type`. Webhook = osobna sekcja, NIE segment.
- Head: `<title>Puls — Zadania dla Twojego Asystenta AI</title>`, `<link rel="icon" href="/favicon.png">`, fonty Google (Outfit+Inter+JetBrains Mono), `<link rel="stylesheet" href="/style.css">`. Skrypty na końcu: `<script src="/enum-map.js"></script>` PRZED `<script src="/app.js"></script>`.
- **KONTRAKT ID** — odtworzyć 1:1 listę z §Kluczowe decyzje. To jest twardy wymóg: rozjazd = cicha awaria logiki.

**Wzorce do naśladowania:**
- `puls-demo/index.html` (struktura), obecny `public/index.html` (ID i elementy produkcyjne do zachowania)

**Scenariusze testowe:**
- [Manual] Render strony: header/taby/statbar/sekcje widoczne, modal otwiera się i zamyka, akordeon działa.

**Weryfikacja:**
- Każdy ID z kontraktu obecny: `for id in form-id form-job-type form-name form-skill form-command form-args form-timeout form-idle-timeout form-retries form-wake form-discord form-routine form-freq form-time form-day form-interval modal-title modal-overlay webhook-section schedule-preview stat-jobs stat-queue stat-uptime kill-bar kill-job-name jobs-body jobs-empty runs-body runs-empty skills-grid skills-empty count-all count-project count-user count-plugin runs-hide-routine toast-container env-toggle; do grep -q "id=\"$id\"" public/index.html || echo "BRAK: $id"; done` nie wypisuje żadnego „BRAK"
- `grep -q 'enum-map.js' public/index.html` i kolejność: `enum-map.js` występuje przed `app.js` w pliku
- `grep -q '<title>Puls' public/index.html` i `grep -q 'rel="icon"' public/index.html`
- `grep -q 'class="env-btn"' public/index.html` (klasa czytana przez `switchEnv`)

---

- [ ] **Unit 6: Przepisany render w `public/app.js` (logika zachowana, render z API, poll z guardem)**

**Cel:** Podmienić warstwę render (mock dema → dane API) zachowując całą logikę; zaimplementować statbar, mapowanie enumów, guard poll i zachowanie rozwinięć.

**Wymagania:** R4, R5, R6, R7, R8

**Zależności:** Unit 5 (DOM/ID), Unit 2 (`/api/runs/recent`), Unit 3 (wzbogacony `/api/status`), Unit 4 (`enum-map`)

**Pliki:**
- Modyfikuj: `public/app.js`

**Delegate to:** feature-builder-ui

**Skills in play:** tailwind-react-guidelines, ux-ui-guidelines, figma:figma-use, figma:figma-implement-design

**Podejście:**
- **ZACHOWAĆ bez zmian:** `API/apiBase/switchEnv`, `loadJobs/loadSkills`, `saveJob/triggerJob/toggleJob/deleteJob/killCurrent`, cron helpers, webhook helpers, `formatClaudeOutput/formatToolUse`, helpery format/esc/truncate/toast/showPromptPopup.
- **PRZEPISAĆ render:**
  - `renderJobs()` → gęsta tabela (grid-zadania): ico (`job_type==='script'?'›_':'◷'`) + nazwa + tag-pill (`/skill` | `skrypt` | `prompt`), HARMONOGRAM (`cronToHuman` lub „tylko webhook"), OSTATNI RUN (kropka+czas z `/api/runs/recent`), 7-run sparkline (z `/api/runs/recent`), NASTĘPNY (`formatDateTime`+`formatCountdown`), STATUS (switch z `enabled` → `toggleJob`), AKCJE ▶⏻✎✕ (dodaj ✕ `deleteJob` — demo ma tylko ▶⏻✎, źródło §3.2).
  - `renderRuns()` → tabela + `EnumMap.mapStatus/mapTrigger` (paleta 5 statusów), log viewer (Kopiuj/Zawijaj/Pełny ekran, podświetlenie błędu heurystyczne, `formatClaudeOutput` w body). Pill „Rutynowe" z `jobsMap[run.job_id].routine`. Nazwa zadania z `jobsMap[run.job_id].name`.
  - `renderSkills()` → toggle Kafelki/Lista + filtry po `source` + stopki „N zadań · ostatnio X" (policz joby gdzie `skill_name===dir_name`; 0 → „nieużywany").
  - **nowy `renderStatbar(status)`** → Następne/Aktywne/Dziś+health/Kolejka/Uptime, wyłącznie z wzbogaconego `/api/status` (Następne: `status.next.job_name`+`formatCountdown`; Dziś: `today_success/today_failed`+health bar flex-proporcja).
  - Modal: logika segmentu binarnego Skill/Skrypt pisząca do `form-job-type` (`onJobTypeChange` zostaje, dostrojona do nowego segmentu).
- **Tab-switching:** przepisać na `.view`/`view-${tab}`+`.active` (demo CSS), zamiast `.tab-panel`/`panel-${tab}`. Zmapuj `data-tab` na `jobs/history/skills` (zgodnie z `poll()`).
- **ZMODYFIKOWAĆ `poll()`:** statbar z `loadStatus` co 3s na KAŻDEJ zakładce; **guard zmian** (tani podpis payloadu np. `runs.length + runs[0]?.id + statusy` — pomiń `innerHTML` gdy bez zmian; analogicznie `renderJobs`); **zachowanie rozwinięć** (`expandedRuns` Set już istnieje — po re-renderze ponownie nałóż klasę `show`/`expanded` na wiersze z setu). Historia DALEJ pollowana co 3s.
- **OSTATNI RUN + 7-run:** preferuj `/api/runs/recent?per_job=7` (jeden fetch), fallback per-job gdyby endpoint odpadł.

**Notatka wykonawcza:** Zachowaj sygnatury zachowanych funkcji nietknięte — render woła je tak jak teraz. Najpierw podmień render jednej zakładki, zweryfikuj wizualnie, potem następne (wertykalnie), by nie zgubić ID.

**Wzorce do naśladowania:**
- `puls-demo/app.js` (`renderZadaniaLista`, `renderHistoria`, `renderSkille*`, sparkline, log viewer) — kształt markupu
- obecny `public/app.js` (cała zachowana logika)

**Scenariusze testowe:**
- [Manual] Lista zadań ładuje się z `/api/jobs`; tagi/sparkline/następny/switch poprawne na realnych danych.
- [Manual] ▶/⏻/✎/✕ działają + toast; modal nowy/edycja, segment przełącza pola, webhook generate/copy, zapis POST/PUT.
- [Manual] Historia: 5 statusów wg kanonu, rozwijanie błędu, log viewer (Kopiuj/Zawijaj/Pełny ekran), filtr „Ukryj rutynowe".
- [Manual] Statbar: Następne/Aktywne/Dziś+health/Kolejka/Uptime na realnych liczbach, na każdej zakładce.
- [Manual] Polling 3s nie powoduje migotania, rozwinięty log nie zwija się przy re-poll.
- [Manual] Kill-bar pokazuje się gdy job leci; env-toggle widoczny tylko gdy VPS skonfigurowany.

**Weryfikacja:**
- `node --check public/app.js` przechodzi (brak błędów składni)
- `grep -q 'EnumMap' public/app.js` (render używa modułu enumów)
- `grep -q '/api/runs/recent' public/app.js` (sparkline z window-function endpointu)
- `grep -q 'renderStatbar' public/app.js` (nowa funkcja statbara obecna)
- Brak odwołań do martwych klas: `grep -q 'tab-panel' public/app.js` zwraca pusto (tab-switching przepisany na `.view`)

---

- [ ] **Unit 7: Rebrand widoczny backendu + `package.json` (description + test script)**

**Cel:** Banner serwera „Puls", opis w `package.json`, włączenie `node --test`.

**Wymagania:** R1, R9

**Zależności:** Brak (niezależny; może iść równolegle)

**Pliki:**
- Modyfikuj: `server.js` (banner 371-372: `🫀  Puls running at http://localhost:${PORT}`)
- Modyfikuj: `package.json` (`description` → „Puls — scheduler agentów AI (Claude Code), AIBIZ"; dodaj `"test": "node --test"`; **`name` zostaje `claude-cron`** — §0)

**Delegate to:** feature-builder-data

**Skills in play:** supabase-dev-guidelines, security, sentry-integration

**Podejście:**
- Zmieniamy wyłącznie `description` i `scripts.test`. Pole `name`, `version`, reszta scriptów install/uninstall — nietknięte (techniczne ID, §0).

**Wzorce do naśladowania:**
- `server.js:370-372` (istniejący banner)

**Scenariusze testowe:**
- [Unit] `npm test` (`node --test`) uruchamia istniejące testy i kończy się sukcesem.

**Weryfikacja:**
- `grep -q 'Puls running' server.js` i brak `CLAUDE-CRON running` w server.js
- `node -e "const p=require('./package.json'); process.exit((p.name==='claude-cron' && p.scripts.test==='node --test' && /Puls/.test(p.description))?0:1)"` kończy się kodem 0
- `npm test` przechodzi

---

### Faza 3 — Szersza warstwa testów backendu

- [ ] **Unit 8: Regresja webhooka + legacy `db`/`scheduler` testy**

**Cel:** Pokryć testami istniejącą logikę backendu (zakres B, osobny przebieg po domknięciu rebrandu, źródło §9.2/§9.4).

**Wymagania:** R9

**Zależności:** Unit 2, Unit 3 (helpery db istnieją; współdzielony `lib/db.test.js`)

**Pliki:**
- Stwórz: `lib/webhook.js` (wyciągnij regex matchingu tokenu z `server.js:338` do funkcji, np. `matchWebhookToken(url)→token|null`) — i podmień użycie w `server.js`
- Stwórz: `lib/webhook.test.js`
- Stwórz: `lib/scheduler.test.js` (`getNextRun`/cron dla 5 wzorców + zły cron)
- Modyfikuj: `lib/db.test.js` (rozszerz: `getRuns` hideRoutine, `getRuns` job_id, `deleteOldRoutineRuns`, CASCADE)

**Delegate to:** feature-builder-data

**Skills in play:** supabase-dev-guidelines, security, sentry-integration

**Podejście:**
- Baza w testach: `better-sqlite3` w trybie `:memory:`; seed kilku jobów/runów w `beforeEach`, NIE ładuj realnego datasetu.
- Webhook: wyciągnięcie regexu do `lib/webhook.js` jest refaktorem zachowującym zachowanie — `server.js` woła nową funkcję. Regex już obsługuje query string (`(?:\?|$)`, fix z `claude-cron-windows`) — test to **regresja**.
- Scheduler test: cron przez croner, weryfikuj że 5 wzorców z `buildCronFromForm` daje poprawny następny czas; zły cron → błąd/null kontrolowany (nie cichy crash).

**Notatka wykonawcza:** Wertykalnie — jeden test → (ekstrakcja/impl) → następny. Nie modyfikuj testów by przeszły; napraw kod.

**Wzorce do naśladowania:**
- `lib/db.js:getRuns` (167-177 hideRoutine — `WHERE NOT (routine=1 AND status='success')`), `deleteOldRoutineRuns` (181-190), `lib/scheduler.js:getNextRun`

**Scenariusze testowe:**
- [Unit] `getRuns({hideRoutine:true})`: UDANY run rutynowego joba ukryty, ale jego FAIL widoczny; nierutynowe zawsze widoczne.
- [Unit] `getRuns({job_id})`: tylko runy danego joba, DESC, respektuje `limit`.
- [Unit] `deleteOldRoutineRuns`: kasuje TYLKO `success` rutynowych starszych niż cutoff; fail/timeout/nierutynowe zostają.
- [Unit] CASCADE: `deleteJob` kasuje też jego runy.
- [Unit] `scheduler.getNextRun`/cron: 5 wzorców (`daily/weekdays/weekly/hours/minutes`) → poprawny następny czas; zły cron → kontrolowany błąd.
- [Unit] `matchWebhookToken`: `plain` ✓, `?query` ✓ (regresja), token bez query ✓, nielegalny znak → null.

**Weryfikacja:**
- `node --test` (cały zestaw) przechodzi — wszystkie pliki `*.test.js` PASS
- `node -e "require('./lib/webhook').matchWebhookToken"` nie rzuca (funkcja wyeksportowana)
- `grep -q 'matchWebhookToken' server.js` (server używa wyciągniętej funkcji, nie inline-regexu)

---

### Faza 4 — Odroczone (po akceptacji Faz 1–3)

- [ ] **Unit 9: Kalendarz (widok tygodnia, occurrences w JS)**

**Cel:** Widok kalendarza tygodnia z occurrences liczonymi po stronie frontu (backend nie zwraca occurrences).

**Wymagania:** R10

**Zależności:** Unit 6 (render + dane jobów/runów)

**Pliki:**
- Modyfikuj: `public/app.js` (dodaj `renderKalendarz()` + liczenie occurrences z `cron_expr` enabled jobów)
- Modyfikuj: `public/index.html` (kontener `#zadania-kalendarz` + toggle Lista/Kalendarz — już w szkielecie dema; do czasu tej fazy toggle ukryty/placeholder z Unit 5)

**Delegate to:** feature-builder-ui

**Skills in play:** tailwind-react-guidelines, ux-ui-guidelines, figma:figma-use, figma:figma-implement-design

**Podejście:**
- Occurrences w JS bez pełnego parsera cron — formularz generuje tylko 5 wzorców: `daily` (każdy dzień hh:mm), `weekdays` (pon–pt), `weekly` (dany dzień tygodnia), `hours`/`minutes` (wysoka częstotliwość → **domyślnie filtr skryptowy, ukryte**, źródło §6 p.1 — inaczej ściana kropek).
- Dla każdego enabled joba policz wystąpienia w bieżącym tygodniu → kolumny dni. Kropka = 3 stany: zielony (run sukces danego dnia), czerwony (błąd), szary (nieuruchomione/przyszłe). Wyłączone joby = brak wystąpień.
- Tylko widok Tydzień (Miesiąc wycięty — dla cyklicznego schedulera bezużyteczny).

**Wzorce do naśladowania:**
- `puls-demo/app.js:renderKalendarz` (132-154) — markup `cal-week/cal-day/cal-event`, `dotFor`

**Scenariusze testowe:**
- [Manual] Job daily widoczny każdego dnia tygodnia; weekly tylko w swoim dniu; minutowy/godzinowy domyślnie ukryty (filtr).
- [Manual] Kropki 3-stanowe poprawne (sukces/błąd/przyszłe); wyłączony job bez wystąpień; scroll w kolumnie dnia gdy dużo eventów.

**Weryfikacja:**
- `node --check public/app.js` przechodzi
- `grep -q 'renderKalendarz' public/app.js`

**Operator checklist:**
- [ ] Operator weryfikuje w przeglądarce widok tygodnia na realnych danych (occurrences vs faktyczne next_run jobów).

---

- [ ] **Unit 10: README rebrand + usunięcie `_preview.html`**

**Cel:** Domknięcie kosmetyki i sprzątanie.

**Wymagania:** R1

**Zależności:** Faza 2 ukończona

**Pliki:**
- Modyfikuj: `README.md` (nagłówek + opis → Puls)
- Usuń: `public/_preview.html` (stary mockup roboczy)

**Delegate to:** feature-builder-data

**Skills in play:** supabase-dev-guidelines, security, sentry-integration

**Podejście:**
- README: rebrand nagłówka i opisu, bez zmiany instrukcji technicznych dot. ID/serwisów (§0).
- `_preview.html` — potwierdź że to faktycznie martwy mockup (nie linkowany z index/serwera) przed usunięciem.

**Scenariusze testowe:**
- [Manual] README czyta się jako „Puls", instrukcje instalacji wciąż poprawne.

**Weryfikacja:**
- `grep -q -i 'Puls' README.md`
- `test ! -f public/_preview.html` (plik usunięty)
- `grep -rq '_preview.html' public server.js` zwraca pusto (brak martwych referencji)

## Wpływ systemowy

- **Graf interakcji:** Nowy `enum-map.js` ładowany globalnie przed `app.js`; render woła `EnumMap.*`. Nowe routy w `server.js` muszą być dopasowane przed ogólnym `/api/runs` matcherem (kolejność if-ów). `/api/status` rozszerzony — proxy VPS (`/api/vps/*`) przekazuje 1:1, więc VPS musi mieć ten sam kod, by statbar w trybie VPS działał (zob. Ryzyka).
- **Propagacja błędów:** `loadStatus` ma `catch { /* silent */ }` — statbar degraduje cicho gdy `/api/status` padnie; nowe pola nie mogą rzucać przy braku danych (fallback `{success:0,failed:0}`, `next:null`).
- **Ryzyka cyklu życia stanu:** `expandedRuns` Set musi przeżyć re-poll; guard poll nie może pominąć re-renderu gdy zmienił się tylko status istniejącego runu (podpis musi zawierać statusy, nie tylko `length`+`id[0]`).
- **Parytet surface API:** Instancja VPS (proxy) serwuje własne `/api/*` — wzbogacony `/api/status` i `/api/runs/recent` działają w trybie VPS dopiero po deployu tego samego kodu na VPS. Do tego czasu statbar/sparkline w trybie VPS mogą mieć braki (graceful).
- **Pokrycie integracyjne:** Testy backendu (`node:test`) nie udowodnią poprawności renderu — front weryfikowany manualnie wg §8 (Operator checklist). Kontrakt ID weryfikowany grep-em (automatyzowalne), ale poprawność danych w UI — manualnie.

## Ryzyka i zależności

- **Rozjazd KONTRAKTU ID** (główne ryzyko) — demo używa innych ID (`modalOverlay`/`taskName`) niż produkcja (`modal-overlay`/`form-name`). Mitygacja: grep-owa weryfikacja każdego ID w Unit 5; render-first jednej zakładki na raz w Unit 6.
- **Kolejność routów `server.js`** — `/api/runs/recent` złapany przez ogólny `/api/runs` jeśli źle uszeregowany. Mitygacja: dodać przed ogólnym matcherem; test `curl`/integracyjny.
- **Granica „Dziś" UTC vs localtime** — bez `date('now','localtime')` statbar „Dziś" przeskakuje o północy UTC. Mitygacja: test regresyjny północy lokalnej (Unit 3).
- **Daemon na starym kodzie** — Mac+CAVE+Windows chodzą na starym kodzie; restart daemonów dopiero PO akceptacji testów lokalnych (§8). Praca na branchu `rebrand-puls`, nie na main.
- **Parytet VPS** — patrz Wpływ systemowy; deploy kodu na VPS osobno.
- **Unit 2 i 3 dotykają tych samych plików** (`lib/db.js`, `server.js`, `lib/db.test.js`) — różne funkcje/sekcje, ale uwaga na konflikty przy równoległym wykonaniu; sekwencjonuj jeśli budowane przez autopilot równolegle.

## Dokumentacja / Notatki operacyjne

- Po domknięciu: `/dev-compound` na kontrakt ID, kanon enumów §4.0 (zweryfikowany na 1829 runach), decyzję window-function vs flat-limit — to wiedza instytucjonalna warta zapisania (brak `docs/solutions/`).
- Rozważ utworzenie `docs/DESIGN.md` przed kolejnym UI feature'em od zera (teraz design source = `puls-demo/style.css`).
- Rollout: test lokalny (`node server.js` na 7777, NIE pod daemonem) → akceptacja → restart 3 daemonów (Mac `pkill -9 -f "node server.js"`+relaunch; Windows `schtasks /End /TN ClaudeCron`+relaunch) → deploy VPS.
- Po weryfikacji usunąć folder `_ARCHIWUM-claude-cron-windows` (poza tym repo) — zarchiwizowany fork (§8 footnote).

## Źródła i referencje

- **Dokument źródłowy:** [MIGRACJA-PULS.md](../../MIGRACJA-PULS.md) (9 sekcji + załącznik)
- **Wzorzec UI (poza repo):** `~/Documents/Kodowanie/puls-demo/` (`index.html` + `style.css` + `app.js`)
- **Figma (origin dema):** https://www.figma.com/design/LHNwwdO9B0o9Sn82nNrn3W — strona „Puls — F (produkcja)" (`47:2`)
- **Handoff logiki (vault):** `Zadania/projekty/personal-team-os/_wznow-claude-cron-rebrand.md`
- Powiązany kod: `public/app.js`, `public/index.html`, `server.js`, `lib/db.js`, `lib/scheduler.js`
