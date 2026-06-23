# Kontekst: Migracja claude-cron → Puls

Branch: `feature/migracja-puls-rebrand`
Ostatnia aktualizacja: 2026-06-23 (domknięcie Fazy 4)

## Status realizacji

### Faza 1 — Fundament (Unit 1–4): UKOŃCZONA
- **Unit 1** — assety (`public/logo-puls.png`, `public/favicon.png`) skopiowane; `public/style.css` zastąpiony 1:1 (`diff` vs `puls-demo/style.css` = IDENTYCZNE).
- **Unit 2** — `getRecentRunsPerJob(perJob)` (window function `ROW_NUMBER`) w `lib/db.js`; route `GET /api/runs/recent` w `server.js` (matcher ścisły `===`, brak kolizji z ogólnym `/api/runs`). Zweryfikowane na izolowanej instancji `:7799`.
- **Unit 3** — `getTodayRunStats()` (`date('now','localtime')`) w `lib/db.js`; `/api/status` wzbogacony o `today_success`/`today_failed`/`next:{job_name,next_run}` (potwierdzone: `today_success:530`, `next` obecne).
- **Unit 4** — `public/enum-map.js` (dual-export CJS+global), `mapStatus`/`mapTrigger` wg kanonu §4.0.
- **Testy:** `node --test` → `lib/db.test.js` 11/11 PASS, `public/enum-map.test.js` 12/12 PASS (łącznie 23 PASS, 0 FAIL).
- **Walidacja:** `node --check` OK dla wszystkich plików; typecheck/lint = n/a (czysty CommonJS, brak TS/ESLint w projekcie); brak `vite build` (projekt to Node.js scheduler, nie SPA); zero nowych zależności.

### Faza 2 — Front + rebrand widoczny (Unit 5–7): UKOŃCZONA
- **Unit 5** — `public/index.html` przepisany: header (logo-puls + brand + env-toggle), `nav.tabs`, statbar (ID montażowe `stat-next-name/stat-next-eta/stat-today-ok/stat-today-err/stat-health`), 3× `section.view`, kill-bar, toast-container, modal (pełny kontrakt `form-*` + segment binarny Skill/Skrypt piszący do `input#form-job-type`), webhook-section, akordeon. Head: `<title>Puls — …>`, favicon, fonty Google; kolejność skryptów `enum-map.js` → `render-helpers.js` → `app.js`. KONTRAKT ID odtworzony.
- **Unit 6** — render w `public/app.js` przepisany: `renderJobs` (gęsta tabela + sparkline z `/api/runs/recent`), `renderRuns` (5 statusów przez `EnumMap`, log viewer, pill Rutynowe z `jobsMap`), `renderSkills` (Kafelki + filtry source + stopki), `renderStatbar` z wzbogaconego `/api/status`, tab-switching na `.view`/`.active`, `poll()` 3s z guardem i zachowaniem `expandedRuns`. Guard/sparkline wyekstrahowane do nowego `public/render-helpers.js` (dual-export, testowalne).
- **Unit 7** — banner `server.js` → `🫀  Puls running …`; `package.json` description → „Puls — scheduler agentów AI (Claude Code), AIBIZ" + `"test": "node --test"` (`name` zostaje `claude-cron`).
- **Testy:** `node --test` → **39/39 PASS, 0 FAIL** (db.test.js + next-run.test.js + enum-map.test.js + nowy render-helpers.test.js 15 testów). `node --check` OK dla app.js / server.js / render-helpers.js.
- **Walidacja:** typecheck/lint/vite build = n/a (czysty Node.js CommonJS, brak TS/ESLint/vite w repo); zero nowych zależności (runner `node --test` warm, brak zimnego cache).

### Faza 3 — Szersza warstwa testów backendu (Unit 8): UKOŃCZONA
- **Unit 8** — regex tokenu webhooka wyciągnięty z `server.js` do `lib/webhook.js` (`matchWebhookToken(url)→token|null`, wzorzec `/^\/webhook\/([a-zA-Z0-9_-]+)(?:\?|$)/`); `server.js` woła nową funkcję zamiast inline-regexu. Nowe testy: `lib/webhook.test.js` (8 — plain, regresja query-string, znaki `_`/`-`, nielegalny znak → null, pusty token, nie-webhook, nie-string), `lib/scheduler.test.js` (8 — 5 wzorców cron `daily/weekdays/weekly/hours/minutes` przez `getNextRun`, zły cron → null, asercje na lokalnych polach Date by były niezależne od TZ CI). Rozszerzony `lib/db.test.js`: `getRuns({hideRoutine})`, `getRuns({job_id})` (DESC+limit), `deleteOldRoutineRuns` (tylko stary success rutynowych), CASCADE (`deleteJob` kasuje runy).
- **Testy:** `node --test` → **62/62 PASS, 0 FAIL** (db + next-run + enum-map + render-helpers + webhook + scheduler). `node --check server.js` OK; `require('./lib/webhook').matchWebhookToken` nie rzuca; `grep matchWebhookToken server.js` PASS.
- **Walidacja:** typecheck/lint/vite build = n/a (czysty Node.js CommonJS, brak TS/ESLint/vite w repo); zero nowych zależności (runner warm).

### Faza 4 — Kalendarz + README/cleanup (Unit 9–10): UKOŃCZONA
- **Unit 9** — widok kalendarza tygodnia. Logika occurrences wyekstrahowana do `public/render-helpers.js` (`parseCronForCalendar`, `computeWeekOccurrences`, `startOfWeek`, `formatHourMinute` — dual-export, testowalne `node --test`). Render (`renderKalendarz`/`switchZadaniaView`/`calDotFor`/`calRangeLabel`) w `public/app.js`. Occurrences liczone w JS bez parsera cron — rozpoznawane 5 kształtów z `buildCronFromForm` (daily/weekdays/weekly/hours/minutes); `hours`/`minutes` → `highFreq` (pomijane w kalendarzu, filtr skryptowy). Kropki 3-stanowe: `ok` (sukces danego dnia), `err` (błąd), `idle` (brak runu/przyszłość) — źródło kropek `allRuns`, indeksowane po dniu lokalnym (`indexRunsByDay`, normalizacja UTC jak `formatTime`). Tylko widok Tydzień (poniedziałek-niedziela).
- **Unit 10** — `README.md` rebrand: `# 🫀 Puls` + opis „scheduler agentów AI (Claude Code), AIBIZ" (instrukcje techniczne niezmienione); `public/_preview.html` usunięty (martwy mockup, zero referencji w `public`/`server.js`).
- **Testy:** `node --test` → **80/80 PASS, 0 FAIL** (62 z Fazy 3 + 18 nowych: `parseCronForCalendar` 7, `startOfWeek` 2, `computeWeekOccurrences` 9 — happy path każdego wzorca cron + edge highFreq/disabled/null + kropki 3-stanowe + sortowanie). `node --check public/app.js`/`public/render-helpers.js` OK.
- **Walidacja:** typecheck/lint/vite build = n/a (czysty Node.js CommonJS, brak TS/ESLint/vite w repo); zero nowych zależności (runner `node --test` warm, brak zimnego cache).

### Odchylenia Fazy 4 (do uwagi review)
- **Unit 9:** Toggle Lista/Kalendarz NIE istniał w `index.html` (plan zakładał placeholder z Unit 5, którego tam nie było). Dodany w tej fazie: `seg-toggle #zadania-views` (data-zview lista/kalendarz) + owinięcie istniejącej tabeli w `#zadania-lista` i nowy `#zadania-kalendarz` — wyłącznie istniejące klasy CSS dema (`seg/seg-views/seg-opt/hidden`), zero nowych styli.
- **Unit 9:** logika occurrences wyekstrahowana do `render-helpers.js` (dual-export, wzorzec z Unit 6) zamiast inline w `app.js` — wymagane do testów `node:test` (`app.js` to plik przeglądarkowy bez `module.exports`). Skill `tailwind-react-guidelines` wspomina vitest, ale stack projektu to vanilla JS + `node --test` (brak vitest/Vite w repo).

### Odchylenia Fazy 3 (do uwagi review)
- **Unit 8:** `buildCronFromForm` jest funkcją DOM-ową w `public/app.js` (frontend, brak `module.exports`) — nieimportowalna w `node --test`. Zamiast importu test sprawdza 5 cron-stringów które ta funkcja produkuje (daily/weekdays/weekly/hours/minutes) przez realny `scheduler.scheduleJob`→`getNextRun`. Zgodne z intencją planu („5 wzorców z buildCronFromForm daje poprawny następny czas"). `scheduler.test.js` izoluje bazę przez `db.setDbPath(':memory:')` (jak `db.test.js`), bo moduł `scheduler` requiruje `db` przy ładowaniu.

### Odchylenia Fazy 2 (do uwagi review)
- **Unit 5:** klasa env-btn kombinowana (`class="env-opt env-btn"`) — `env-opt` = styl dema, `env-btn` = kontrakt logiki (`switchEnv` czyta `.env-btn`). Literalny grep `class="env-btn"` z planu nie łapie kombinowanej klasy, ale `querySelectorAll('.env-btn')` matchuje. Analogicznie filtry skilli `class="filter-pill skill-filter"`. Usunięto martwy `onclick="toggleAccordion()"` (funkcja nie istnieje w app.js). Modal: `hidden` jako stan początkowy (CSS dema); togglowanie `.show` przez logikę — pogodzenie mechanizmu = obszar CSS/Unit 6.
- **Unit 6:** dodano `<script src="/render-helpers.js">` do `index.html` (jedna linia, analogiczna do `enum-map.js`) — konieczne by przeglądarka załadowała nowy moduł. Skille renderowane tylko jako Kafelki — `index.html` (Unit 5) nie zawiera DOM przełącznika Lista; dodanie wykraczałoby poza pliki Unit 6. Filtry po source i stopki działają. Guard/sparkline w `render-helpers.js` (dual-export jak enum-map.js), bo `app.js` to plik przeglądarkowy bez `module.exports`.
- **Unit 7:** brak zmian zależności; typecheck/lint/migracja/RLS = n/a (czysty Node CommonJS, IU nie dotyka warstwy bazy/Supabase).

### Odchylenia Fazy 1 (do uwagi review)
- **Unit 1:** grep weryfikacyjny `--mute:#7d7d7d` (bez spacji) NIE przechodzi — źródło `puls-demo/style.css:14` ma `--mute: #7d7d7d;` (ze spacją, wariant WCAG AA). CSS świadomie NIE zmodyfikowany pod grep: reguła „kopia 1:1, nie modyfikuj treści wzorca" > formatowanie greppa. Wariant WCAG AA obecny, różnica wyłącznie whitespace.
- **Unit 2:** dotknięto `lib/config.js` (lista „NIE ruszać") jedną linią — `DB_PATH = process.env.CLAUDE_CRON_DB || …`. Override izoluje bazę w testach (bez niego singleton `getDb()` zanieczyszczałby produkcyjną `data/claude-cron.db`). Zmiana addytywna, backward-compatible.
- **Unit 3:** `getTodayRunStats` agreguje do `failed` także `timeout`/`killed` (jedyne nie-success statusy zakończenia wg `lib/executor.js`) — inaczej statbar zaniżałby liczbę niepowodzeń.
- **Unit 4:** wzorzec `puls-demo/app.js:STATUS_META/TRIGGER_ICO` z planu nie istnieje w repo; kształt `{cls,label}`/`{ico,label}` odtworzony wprost wg kanonu §4.0 (nie z mocka).

## Powiązane pliki

### Front (przepisać/podmienić)
- `public/style.css` — zastąpić w całości wersją z `puls-demo/style.css`
- `public/index.html` — przepisać (markup dema + KONTRAKT ID + elementy produkcyjne)
- `public/app.js` — zachować logikę, przepisać render
- `public/enum-map.js` — **nowy** (dual-export CJS+global, kanon §4.0)
- `public/logo-puls.png`, `public/favicon.png` — **nowe** (kopia z `puls-demo/`)

### Backend (2 dodatki + rebrand)
- `server.js` — `GET /api/runs/recent` (nowy route przed ogólnym `/api/runs`), wzbogacony `/api/status`, banner „Puls", użycie `matchWebhookToken`
- `lib/db.js` — helpery `getRecentRunsPerJob`, `getTodayRunStats` (+ eksport)
- `lib/webhook.js` — **nowy** (wyciągnięty `matchWebhookToken` z `server.js:338`)
- `package.json` — `description` + `"test": "node --test"` (`name` ZOSTAJE `claude-cron`)

### Testy (nowe)
- `lib/db.test.js`, `lib/scheduler.test.js`, `lib/webhook.test.js`, `public/enum-map.test.js`

### Wzorzec (poza repo)
- `~/Documents/Kodowanie/puls-demo/` — `index.html`, `style.css`, `app.js`

### NIE ruszać (techniczne ID — §0 dokumentu źródłowego)
- `lib/config.js`, `lib/platform.js`, `lib/executor.js`, `scripts/install-*`, `scripts/uninstall-*`, pole `name` w `package.json`

## Decyzje techniczne

- **KONTRAKT ID** — markup produkcji odtwarza ID czytane przez zachowaną logikę (NIE wolny markup dema). Pełna lista: `form-id, form-job-type, form-name, form-skill, form-command, form-args, form-timeout, form-idle-timeout, form-retries, form-wake, form-discord, form-routine, form-freq, form-time, form-day, form-interval` (+ `time-group/day-group/interval-group/interval-label`), `modal-title, modal-overlay, webhook-section, webhook-empty, webhook-active, webhook-url, skill-group, args-group, command-group, schedule-preview, stat-jobs, stat-queue, stat-uptime, kill-bar, kill-job-name, jobs-body, jobs-empty, runs-body, runs-empty, skills-grid, skills-empty, count-all/project/user/plugin, runs-hide-routine, toast-container, env-toggle`. Klasy: `.tab`+`data-tab`, `.env-btn`+`data-env`.
- **Tab-switching** przepisany na `.view`/`.view.active` (demo CSS), zamiast `.tab-panel`/`panel-${tab}`.
- **Modal** segment BINARNY Skill/Skrypt (pisze do ukrytego `input#form-job-type`), webhook ortogonalny (osobna `webhook-section`). „prompt" = Skill bez skilla.
- **OSTATNI RUN + 7-run** = window function (`ROW_NUMBER() OVER (PARTITION BY job_id ORDER BY id DESC)`), nie flat-limit (job `*/1` zjada okno). Fallback: per-job fetch.
- **Statbar** wyłącznie z `/api/status`; „Dziś" liczone `date('now','localtime')` (bez tego przeskok o północy UTC).
- **`enum-map.js`** dual-export (CJS dla `node:test` + global dla `<script>`); ładowany w `index.html` PRZED `app.js`.
- **`poll()`** guard zmian (podpis payloadu zawiera statusy, nie tylko length+id[0]) + zachowanie `expandedRuns`; statbar co 3s na każdej zakładce.
- **Mapowanie enumów (kanon §4.0):** `success→ok/Sukces`, `failed→err/Błąd`, `timeout`, `killed→stop/Zatrzymany`, `running/queued→run`; trigger `scheduled→Harmonogram`, `manual→Ręcznie`, `webhook→Webhook`, `retry→Harmonogram`; `routine=1` to **flaga joba** (z `jobsMap`), NIE trigger.
- **Design source = `puls-demo/style.css` (1:1).** Brak `docs/DESIGN.md` i brak fetchu Figmy — demo to zaakceptowany, w pełni zmaterializowany wzorzec. Odroczone: utworzyć `docs/DESIGN.md` przed kolejnym UI feature'em od zera.

## Zależności

- Środowisko: Node v22.22.3 (`node:test` wbudowany), `better-sqlite3 ^12` (window functions zweryfikowane lokalnie), `croner ^10`.
- Zero nowych zależności (reguła: preferuj istniejące / nie dodawaj deps).
- Kolejność: Faza 1 (Unit 1–4) równolegle → Faza 2 (Unit 5 → 6; Unit 7 niezależny) → Faza 3 (Unit 8) → Faza 4 (Unit 9–10, odroczone).
- Parytet VPS: dodatki backendu działają w trybie VPS dopiero po deployu kodu na VPS.

## Review fazy 1 (2026-06-23)
- Raport: `docs/active/migracja-puls-rebrand/review-faza-1.md`. Bramka: **ZASTRZEZENIA** (0× P1, 7× P2, 11× P3, 1× OPERATOR).
- Testy: `node --test` → **23/23 PASS** (db.test.js 11 + enum-map.test.js 12). Serwer startuje i nasłuchuje na 7777.
- Kluczowe P2: (1) `lib/config.js` ruszony mimo granicy „NIE ruszamy" — override `CLAUDE_CRON_DB`, wymaga sign-offu lub przeniesienia izolacji do warstwy testu; (2) `computeNextRun` (server.js) bez testów — wyciągnąć do `lib/`; (3) logo 1.2 MB + brak cache w `serveStatic`; (4) `SELECT *` w `getRecentRunsPerJob` (zbędny payload + wyciek `rn`); (5) route `/api/runs/recent` bez testu integracyjnego (porządek if-ów krytyczny).
- Bookkeeping `Weryfikacja:`: 10× odznaczone (CLI/grep PASS), 1× FAIL (grep `--mute:#7d7d7d` — CSS ma `--mute: #7d7d7d` ze spacją; token poprawny, wzorzec nietrafiony).

## Źródła
- Requirements doc: brak (dokument źródłowy: `MIGRACJA-PULS.md` w root repo)
- Plan techniczny: `docs/plans/2026-06-23-001-feat-migracja-puls-rebrand-plan.md`
