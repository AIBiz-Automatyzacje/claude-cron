# Review fazy 1 — Nadrabianie jobów przegapionych przez nocny restart VPS

**Data:** 2026-06-27
**Faza:** 1
**Severity gate:** ✅ CZYSTE (zero P1/P2 typu KOD/TEST/E2E)

## Podsumowanie

Faza 1 obejmuje 4 Implementation Units:
- Unit 1: `run_on_wake` opt-out — schema, createJob default, backfill (lib/db.js)
- Unit 2: fix strefy w `detectMissedJobs` + ekstrakcja pure `computeMissedJobs` (lib/scheduler.js)
- Unit 3: `MAINTENANCE_WINDOW` w config.js + ekspozycja przez `/api/env` (lib/config.js, server.js)
- Unit 4: warning okna restartu + domyślny checkbox wake + pure helper overlap (public/render-helpers.js, public/app.js, public/index.html)

Po adversarial verify wszystkie findingi zostały sklasyfikowane jako **P3 (nity)** lub **OPERATOR** (niewykonalne headless). Brak findingów blokujących (P1) ani important (P2). Pełen suite testów przechodzi: **106/106 PASS**.

## Statystyki

- 🔴 [P1-blocking]: 0
- 🟠 [P2-important]: 0
- 🟡 [P3-nit]: 10 (KOD/TEST)
- 📋 OPERATOR (poza fix): 1 (finding E2E niewykonalny headless)
- ✅ E2E: 0 passed / 0 failed / 1 skipped (brak harnessu headless)

## Findingi P3 (KOD / TEST)

### KOD

1. **public/render-helpers.js:190** — parametr `window` cieniuje globalny `window` przeglądarki (UMD). Działa, ale myląca nazwa. Sugestia: `maintenanceWindow`/`restartWindow`.
2. **public/render-helpers.js:196-199** — brak walidacji kształtu `window`: niepełny obiekt → NaN → warning się nie pokaże (cicha, bezpieczna degradacja). Produkcyjnie nie występuje (stała z config.js).
3. **public/app.js:1138** — `maintenance_window` konsumowane bez runtime guardu na pola liczbowe. Dane z zaufanego same-origin configu; zły kształt → NaN → false. Brak realnego ryzyka injection/XSS.
4. **public/app.js:1138** — niespójność warstwy danych w trybie VPS: `maintenance_window` czytane tylko z lokalnego `/api/env`, nie z `/api/vps/env` (obok webhook_base_url JEST dociągany z VPS). Dziś OK (ta sama stała na obu instancjach). Latentny coupling.
5. **public/app.js:267-285** — `updateMaintenanceWarning` robi `getElementById` przy każdej zmianie pola. Mikro-koszt, nieodczuwalny.
6. **lib/scheduler.js:102** — pusty catch (skip invalid cron) bez logu (§4). Pure funkcja bez I/O; zły cron loguje się w `scheduleJob`. Spójność z `scheduleJob:63` sugerowałaby minimalny log.
7. **lib/scheduler.js:120-123** — `enqueueJob` w pętli woła `processQueue()` za każdym razem. Nie realny N+1 (guard `queueProcessing` → no-op), ale wywołanie raz po pętli byłoby czytelniejsze.
8. **lib/scheduler.js:121** — regresja czytelności logu (DX): loguje surowe `jobId` zamiast nazwy joba. Plan nie specyfikuje treści logu.
9. **lib/db.js:124-125** — backfill `UPDATE jobs SET run_on_wake = 1` to pełny table scan bez WHERE. Jednorazowy (flaga), mała tabela. Ewentualnie `WHERE run_on_wake != 1`.

### TEST

10. **public/render-helpers.test.js:10** — `MAINTENANCE_WINDOW` zduplikowane jako literał, niezależne od `lib/config.js:43` (R4). UMD frontowy nie importuje configu — fixture izolowany, akceptowalny, ale może dryfować.
11. **lib/scheduler.test.js** — wrapper I/O `detectMissedJobs()` bez testu (tylko pure `computeMissedJobs` pokryte). Plan świadomie zostawił cienki wrapper — akceptowany tradeoff.

## Findingi OPERATOR (poza fix — do operator-checklist)

- **docs/.../nocny-restart-przegapione-joby-zadania.md:64,79** (E2E) — niedomknięte weryfikacje E2E/Operator z Unit 3 i Unit 4: curl `/api/env` → `maintenance_window` oraz wizualne potwierdzenie domyślnego checkboxa wake i warningu przy 06:05. Logika pokryta unit-testami (106/106 PASS), wiring w app.js poprawny — ryzyko niskie, ale faktyczne renderowanie w przeglądarce nie zweryfikowane headless. Do potwierdzenia przez operatora.

## Zgodność ze spec

Wszystkie wymagania (R1-R5) zaimplementowane i pokryte testami. Brak braków krytycznych, brak scope creep, brak błędnie zaimplementowanych wymagań na poziomie blokującym. Dwie obserwacje latentne (finding #4 — coupling warstwy danych VPS; finding #11 — niepokryty wrapper I/O) odnotowane jako P3, świadomy tradeoff planu.

## Bookkeeping checkboxów Weryfikacja:

- Odznaczone automatycznie (CLI/grep): 7
- Odznaczone na podstawie Agent 5 E2E: 0
- Pozostawione dla operatora (Manual/E2E headless): 1
- Niejasne (P3): 0
- Failujące (P2): 0

### Szczegóły

- [x] CLI: `node --test lib/db.test.js` → PASS (24/24)
- [x] Grep: `grep -n "DEFAULT 1" lib/db.js` → PASS (linia 39 `run_on_wake INTEGER DEFAULT 1`)
- [x] CLI: `node --test lib/scheduler.test.js` → PASS (14/14)
- [x] Grep: `grep -n "timezone" lib/scheduler.js` → PASS (linie 58, 88, 95, 116, 119 — strefa w ścieżce detekcji)
- [x] Grep: `grep -n "MAINTENANCE_WINDOW" lib/config.js server.js` → PASS (config.js:43,72; server.js:5,180)
- [x] CLI: `node --test` (cały suite) → PASS (106/106)
- [x] CLI: `node --test public/render-helpers.test.js` → PASS (43/43)
- [ ] E2E/Manual: `[E2E przez /agent-browser]` checkbox wake + warning 06:05 → przeniesione do Operator checklist faza 1 (brak harnessu E2E headless; finding sklasyfikowany jako OPERATOR/P3, nie P2)

## Liczniki

| Kategoria | Liczba |
|---|---|
| P1 | 0 |
| P2 | 0 |
| P3 (KOD/TEST/E2E) | 10 |
| OPERATOR | 1 |

## Severity gate

✅ **CZYSTE** — zero P1/P2. Sam P3/OPERATOR nie blokuje gate'u. Faza gotowa do kontynuacji; findingi P3 opcjonalne do rozważenia.
