# Podsumowanie: Migracja claude-cron → Puls (rebrand + nowy front + dodatki backendu)

**Data ukończenia:** 2026-06-23
**Branch:** `feature/migracja-puls-rebrand`
**Status:** Wszystkie 4 fazy ukończone (execute + review + fix). Walidacja i compound: done.

---

## Co zostało dostarczone

Pełny rebrand `claude-cron` → **Puls** oraz podmiana całego frontu na zaakceptowany prototyp z `puls-demo/`, z zachowaniem dotychczasowej logiki (fetch API, cron, webhook, polling). Dołożono dwa kontrolowane dodatki backendu i pierwszą warstwę testów `node:test` (projekt nie miał wcześniej żadnych testów).

- **Faza 1 — Fundament:** assety (`public/logo-puls.png` zoptymalizowane 1.2 MB → 17.7 KB, `public/favicon.png`), `public/style.css` 1:1 z dema, nowy route `GET /api/runs/recent?per_job=N` (window function `ROW_NUMBER`), wzbogacony `/api/status` (`today_success`/`today_failed`/`next`), moduł `public/enum-map.js` (kanon §4.0).
- **Faza 2 — Front + rebrand widoczny:** przepisany `public/index.html` (markup dema + KONTRAKT ID + elementy produkcyjne), przepisany render w `public/app.js` (render z realnego API, poll 3s z guardem), banner serwera „🫀 Puls running", `package.json` description + `"test": "node --test"`.
- **Faza 3 — Warstwa testów backendu:** ekstrakcja `matchWebhookToken` do `lib/webhook.js`, testy `lib/webhook.test.js` / `lib/scheduler.test.js`, rozszerzony `lib/db.test.js`.
- **Faza 4 — Kalendarz + cleanup:** widok kalendarza tygodnia (occurrences liczone w JS, logika w `public/render-helpers.js`), rebrand `README.md`, usunięcie martwego `public/_preview.html`.

**Wynik testów na końcu Fazy 4:** `node --test` → **80/80 PASS, 0 FAIL**. Zero nowych zależności.

---

## Kluczowe decyzje

- **Złota zasada:** front (HTML/CSS/render) z dema, logika (fetch/cron/webhook/poll) zachowana z produkcji. Demo renderuje z mocka — produkcja z `/api/*`.
- **KONTRAKT ID 1:1** — markup produkcji odtwarza ID czytane przez zachowaną logikę (nie wolny markup dema), weryfikowany grepem każdego ID.
- **OSTATNI RUN + sparkline = window function** (`ROW_NUMBER() OVER (PARTITION BY job_id ORDER BY id DESC)`), nie flat-limit — inaczej job `*/1` zjada okno.
- **Statbar „Dziś" liczone `date('now','localtime')`** — bez tego przeskok granicy o północy UTC (jest test regresyjny).
- **Dual-export modułów frontu** (`enum-map.js`, `render-helpers.js`): CJS dla `node:test` + global dla `<script>`, bo `app.js` to plik przeglądarkowy bez `module.exports`. Logika testowalna wyciągana do `render-helpers.js`.
- **Modal segment BINARNY Skill/Skrypt** piszący do ukrytego `input#form-job-type`; webhook ortogonalny (osobna sekcja). „prompt" = Skill bez skilla.
- **Pole `name` w `package.json` ZOSTAJE `claude-cron`** oraz nietknięte techniczne ID (`DB_PATH`, `PLIST_LABEL`, `WIN_TASK_NAME`, env `CLAUDE_CRON_*`) — rebrand wyłącznie widoczny.
- **`lib/config.js` przywrócony** po review fazy 1: izolacja bazy w testach przeniesiona z env-override do warstwy testu przez `db.setDbPath(':memory:')` (DI), bez dotykania configu produkcyjnego.

---

## Główne pliki

**Nowe:**
- `public/enum-map.js` (+ `public/enum-map.test.js`)
- `public/render-helpers.js` (+ `public/render-helpers.test.js`) — guard/sparkline + logika occurrences kalendarza
- `lib/webhook.js` (+ `lib/webhook.test.js`) — `matchWebhookToken`
- `lib/next-run.js` (+ `lib/next-run.test.js`) — wyciągnięte `computeNextRun`
- `lib/scheduler.test.js`
- `public/logo-puls.png`, `public/favicon.png`

**Zmodyfikowane:**
- `public/index.html` (przepisany), `public/app.js` (render przepisany), `public/style.css` (1:1 z dema)
- `server.js` (route `/api/runs/recent`, wzbogacony `/api/status`, banner Puls, `matchWebhookToken`)
- `lib/db.js` (`getRecentRunsPerJob`, `getTodayRunStats`), `lib/db.test.js` (rozszerzony)
- `package.json` (description + test script), `README.md` (rebrand)

**Usunięte:** `public/_preview.html`

---

## Wnioski

- **Schema drift w `lib/db.js`** — realna schema bazy pochodzi z migracji, nie z `CREATE TABLE`; testy seedują przez realne helpery, nie przez surowy DDL.
- **Stack projektu = vanilla JS + `node --test`** (Node v22, `node:test` wbudowany). Brak TS/ESLint/vite/vitest — typecheck/lint/build to `n/a`; walidacja = `node --check`. Skille zakładające vitest/Vite są nieadekwatne dla tego repo.
- **Testowalność frontu** wymaga ekstrakcji czystej logiki do modułów dual-export — render w `app.js` (DOM, brak `module.exports`) pozostaje weryfikowany manualnie/E2E.
- **Pułapka TZ w testach** — fixtures z `started_at` o granicy doby (np. `06:00Z`) failują poza Europe/Warsaw; używać godzin środka doby (12:00Z) lub wymuszać TZ.
- **Porządek routów w `server.js`** krytyczny: `/api/runs/recent` musi być dopasowany PRZED ogólnym `/api/runs` (test E2E to chroni).
- **Parytet VPS** — dodatki backendu (`/api/status` rozszerzony, `/api/runs/recent`) działają w trybie VPS dopiero po deployu kodu na VPS; do tego czasu graceful degrade.

## Pozostałe pozycje (nieblokujące)

- Operator checklisty (manualna weryfikacja w przeglądarce na realnych danych, restart daemonów Mac+CAVE+Windows, deploy VPS) — wymagają operatora, poza zakresem headless.
- Drobny mismatch greppa `--mute:#7d7d7d` vs `--mute: #7d7d7d` (whitespace) — token koloru WCAG AA poprawny, kosmetyka wzorca weryfikacyjnego.
- Findingi P3 (nity) udokumentowane w `review-faza-{1..4}.md` — opcjonalne.
- Odroczone: utworzyć `docs/DESIGN.md` przed kolejnym UI feature'em od zera (design source był = `puls-demo/style.css` 1:1).

---

## Źródła
- Dokument źródłowy: `MIGRACJA-PULS.md` (root repo)
- Plan techniczny: `docs/plans/2026-06-23-001-feat-migracja-puls-rebrand-plan.md`
- Raporty review: `review-faza-1.md` … `review-faza-4.md` (w tym folderze)
