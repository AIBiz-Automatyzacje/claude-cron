# Kontekst: Migracja claude-cron → Puls

Branch: `feature/migracja-puls-rebrand`
Ostatnia aktualizacja: 2026-06-23

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

## Źródła
- Requirements doc: brak (dokument źródłowy: `MIGRACJA-PULS.md` w root repo)
- Plan techniczny: `docs/plans/2026-06-23-001-feat-migracja-puls-rebrand-plan.md`
