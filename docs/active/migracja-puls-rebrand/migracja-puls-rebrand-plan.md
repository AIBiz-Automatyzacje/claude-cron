# Plan: Migracja claude-cron → Puls (rebrand + nowy front z dema + 2 dodatki backendu)

Branch: `feature/migracja-puls-rebrand`
Ostatnia aktualizacja: 2026-06-23

## Podsumowanie wykonawcze

Rebrand `claude-cron` → **Puls** i podmiana całego frontu na zaakceptowany prototyp z `~/Documents/Kodowanie/puls-demo/`. Złota zasada: **front (HTML/CSS/render) z dema, logika (fetch API, cron, webhook, polling) zachowana z obecnego `public/app.js`**. Demo renderuje z mocka — produkcja renderuje z `/api/*`. Dochodzą **dwa kontrolowane dodatki backendu**: `GET /api/runs/recent?per_job=N` (window function) + wzbogacony `/api/status` (`today_success/today_failed/next`). Wprowadzamy też warstwę testów `node:test` (projekt nie ma żadnych testów).

## Cele i zakres

### Cele
- Pełny rebrand widoczny (Puls) bez ruszania technicznych ID.
- Nowy front 1:1 z demem, zasilany realnym API z poprawnym mapowaniem enumów (kanon §4.0).
- Dwa dodatki backendu zasilające gęstą tabelę zadań i globalny statbar bez N+1.
- Pierwsza warstwa testów backendu + regresja webhooka + moduł enumów.

### Poza zakresem
- Techniczne ID: `DB_PATH`, `PLIST_LABEL`, `WIN_TASK_NAME`, `$SERVICE_NAME`, env `CLAUDE_CRON_*`, pole `name` w `package.json`.
- `lib/config.js`, `lib/platform.js`, `lib/executor.js`, `scripts/install-*`, `scripts/uninstall-*`.
- Testy renderu `public/app.js` (global-script, wymaga refaktoru + jsdom) — poza modułem `enum-map`.
- `executor.js` (spawn Claude CLI) w testach.

## Analiza obecnego stanu

- `public/app.js` (795 linii) — logika (fetch/cron/webhook/format/poll) + render z innymi ID niż demo (`modal-overlay`, `form-name`, `panel-${tab}`).
- `public/index.html` (250) — stary retro markup; `public/style.css` (847) — retro arcade.
- `puls-demo/` — zaakceptowany wzorzec: `index.html` (187), `style.css` (481), `app.js` (337, render z mocka, **inne ID**: `modalOverlay`, `taskName`, `view-zadania`).
- `server.js` (392) — routing, `/api/status` (154-168), `/api/runs` (261-287), webhook regex (338, już z fixem query-string), SPA fallback, X-Forwarded-For block.
- `lib/db.js` (286) — `getRuns` (hideRoutine/job_id), `deleteOldRoutineRuns`, CASCADE; schema realna z migracji (NIE z `CREATE TABLE`, schema drift).
- `lib/scheduler.js` (197) — `getNextRun` (croner, per job).
- Brak testów. Node v22.22.3, `better-sqlite3 ^12` (window functions zweryfikowane).

## Proponowany stan docelowy

Front Puls (Dark Impact) zasilany z API; statbar health z wzbogaconego `/api/status`; tabela zadań ze sparkline z `/api/runs/recent`; historia z log viewerem i 5 statusami; skille w 2 widokach; modal binarny Skill/Skrypt + webhook ortogonalny; kalendarz tygodnia (odroczony). Warstwa testów `node:test` dla logiki backendu.

## Fazy wdrożenia

### Faza 1 — Fundament (statyka, backend, moduł enumów)
- Unit 1: Assety + podmiana CSS + fonty — **S** — `feature-builder-ui`
- Unit 2: `GET /api/runs/recent` (window function) + test — **M** — `feature-builder-data`
- Unit 3: Wzbogacony `/api/status` (today + next) + test — **M** — `feature-builder-data`
- Unit 4: Moduł `enum-map` (kanon §4.0) + test — **S** — `feature-builder-data`

### Faza 2 — Front + rebrand widoczny
- Unit 5: Przepisany `index.html` (markup dema + KONTRAKT ID + elementy produkcyjne) — **L** — `feature-builder-ui`
- Unit 6: Przepisany render w `app.js` (logika zachowana, render z API, poll z guardem) — **XL** — `feature-builder-ui`
- Unit 7: Rebrand backendu (banner) + `package.json` (description + test script) — **S** — `feature-builder-data`

### Faza 3 — Szersza warstwa testów backendu
- Unit 8: Regresja webhooka + legacy `db`/`scheduler` testy — **L** — `feature-builder-data`

### Faza 4 — Odroczone (po akceptacji Faz 1–3)
- Unit 9: Kalendarz (widok tygodnia, occurrences w JS) — **L** — `feature-builder-ui`
- Unit 10: README rebrand + usunięcie `_preview.html` — **S** — `feature-builder-data`

## Kryteria akceptacji (per faza)

- **Faza 1:** assety w `public/`, CSS zawiera fixy; `node --test` zielony dla `lib/db.test.js` + `public/enum-map.test.js`; oba endpointy odpowiadają; `node server.js` startuje.
- **Faza 2:** wszystkie ID kontraktu obecne w `index.html`; `node --check public/app.js` OK; render wszystkich zakładek z realnego API; rebrand widoczny (title/banner/description); `npm test` działa.
- **Faza 3:** pełny `node --test` zielony; `matchWebhookToken` wyciągnięty i używany w `server.js`.
- **Faza 4:** kalendarz tygodnia działa na realnych danych; README = Puls; `_preview.html` usunięty bez martwych referencji.

## Ocena ryzyka i mitygacja

- **Rozjazd KONTRAKTU ID** (główne) → grep-owa weryfikacja każdego ID (Unit 5); render-first jednej zakładki na raz (Unit 6).
- **Kolejność routów `server.js`** → `/api/runs/recent` przed ogólnym `/api/runs`; test integracyjny.
- **Granica „Dziś" UTC vs localtime** → `date('now','localtime')` + test regresyjny północy (Unit 3).
- **Daemon na starym kodzie** → praca na branchu; restart daemonów dopiero po akceptacji.
- **Parytet VPS** → wzbogacony `/api/status` i `/api/runs/recent` działają w trybie VPS dopiero po deployu kodu na VPS (graceful degrade do tego czasu).
- **Unit 2/3 ten sam plik** → różne funkcje/sekcje; sekwencjonować jeśli budowane równolegle.

## Mierniki sukcesu

- Lista/Historia/Skille/Statbar renderują się z realnych danych bez migotania (poll guard).
- Mapowanie enumów zgodne z kanonem §4.0 (5 statusów, triggery).
- `node --test` zielony; zero ruszonych technicznych ID; daemony działają po restarcie.

## Źródła
- Requirements doc: brak (dokument źródłowy: `MIGRACJA-PULS.md` w root repo)
- Plan techniczny: `docs/plans/2026-06-23-001-feat-migracja-puls-rebrand-plan.md`
