# Code Review — Faza 3 (Szersza warstwa testów backendu)

Zadanie: `migracja-puls-rebrand`
Data review: 2026-06-23
Branch: `feature/migracja-puls-rebrand`
Status bramki: **✅ CZYSTE — zero P1/P2, same P3 (nity)**

Findings poniżej są już po adversarial verify (P1 = 3 sceptyków, P2 = 1). Lista finalna po bookkeepingu checkboxów `Weryfikacja:`.

Faza 3 to czysta warstwa testów backendu (`lib/webhook.test.js`, `lib/scheduler.test.js`, rozszerzony `lib/db.test.js`) plus jedna ekstrakcja produkcyjna: regex tokenu webhooka wyciągnięty z `server.js` do `lib/webhook.js` (`matchWebhookToken`) bez zmiany zachowania. Zero regresji — pełny zestaw 62/62 testów PASS.

---

## Statystyki

| Kategoria | Liczba |
|---|---|
| 🔴 P1 (blocking, KOD/TEST/E2E) | 0 |
| 🟠 P2 (important, KOD/TEST/E2E) | 0 |
| 🟡 P3 (nit, KOD/TEST/E2E) | 11 |
| 🔧 OPERATOR (niewykonalne headless) | 0 |
| **Razem findings** | **11** |

Bookkeeping (krok 4.7): zero nowych P2/P3 — wszystkie 3 niezaznaczone checkboxy `Weryfikacja:` fazy 3 to CLI/grep, wszystkie PASS (exit 0), odznaczone automatycznie.

Severity gate: **CZYSTE** (zero P1, zero P2 — sam P3 nie blokuje bramki). Faza gotowa do kontynuacji.

E2E: brak scenariuszy E2E w fazie 3 (warstwa testów backendu, zero checkboxów 🌐/browser). passed=0, failed=0, skipped=0.

---

## Findings — P1 (blocking)

Brak.

## Findings — P2 (important)

Brak.

## Findings — P3 (nit, KOD/TEST/E2E)

### P3-1 · KOD · `server.js:346`
handleWebhook zwraca rozróżnialne kody/komunikaty dla 'Webhooks disabled' (403), 'Invalid webhook token' (404) i 'Method not allowed' (405) na publicznym, internetowym endpoincie. Pozwala to nieuwierzytelnionemu atakującemu enumerować ważne tokeny webhooków (404 vs 200) bez rate-limitingu. NIE jest to regresja tej fazy — endpoint i jego logika są pre-existing; faza 3 jedynie wyekstrahowała dopasowanie tokenu (matchWebhookToken) bez zmiany zachowania. Zgłaszam jako nit do rozważenia (ujednolicenie odpowiedzi błędnej + rate-limit), nie jako blocker fazy.

### P3-2 · KOD · `lib/db.js:223`
getTodayRunStats opakowuje kolumnę w funkcję: `date(started_at,'localtime') = date('now','localtime')`. Predykat jest non-sargable — SQLite nie użyje idx_runs_started_at i robi full scan tabeli runs. Dla aplikacji jednomaszynowej z małym wolumenem to nieistotne, a kod jest PRE-EXISTING (nie wprowadzony w fazie 3 — faza tylko dodaje testy). Ewentualna optymalizacja: porównanie zakresowe `started_at >= <początek doby lokalnej w UTC>` by trafić w indeks. Zgłoszone informacyjnie, nie blokuje.

### P3-3 · KOD · `lib/db.js:202`
getRecentRunsPerJob: wewnętrzny subquery z `ROW_NUMBER() OVER (PARTITION BY job_id ORDER BY id DESC)` skanuje całą tabelę runs bez WHERE przed odfiltrowaniem rn<=N. Przy bardzo dużej tabeli runs koszt rośnie z całością, nie z N. Mitygacja istnieje: jawny select kolumn (bez stdout/stderr/payload) i indeks idx_runs_job_id. Brak N+1 (pojedyncze zapytanie). Pre-existing, akceptowalne dla skali narzędzia. Informacyjnie.

### P3-4 · TEST · `lib/scheduler.test.js:21`
Cleanup opiera się na hardcoded stałej `SCHEDULED_IDS = [1..6]` zamiast śledzić faktycznie zaplanowane joby. To coupling do wewnętrznego stanu modułu (activeJobs) i wymaga ręcznej synchronizacji listy przy dodaniu testu z innym ID. Pragmatyczne dla izolowanego testu (scheduler nie wystawia API do listowania aktywnych jobów), więc tylko nit — można rozważyć afterEach unschedulujący po ID użytych w danym teście, ale nie blokuje. Izolacja per-plik (node --test = osobny proces) chroni przed cross-file leakiem.

### P3-5 · KOD · `lib/webhook.js:7`
matchWebhookToken nie ma jawnego return type (to JS/CommonJS, nie TS — reguła explicit return types dotyczy TypeScript, więc nieaplikowalna). Funkcja jest zwięzła, jeden poziom abstrakcji, fail-fast na nie-stringu, nazewnictwo i UPPER_SNAKE dla stałej poprawne. Czysta ekstrakcja zgodna z granicami warstw (server deleguje do modułu) — zero realnych naruszeń SOLID/architektury, wpis tylko dla kompletności.

### P3-6 · KOD · `lib/webhook.js:7`
Projekt jest czystym JavaScriptem (CommonJS, brak tsconfig/TS build) — osie type-safety z brief'u (zakaz any/as/!, discriminated unions, explicit return types) nie mają zastosowania, bo nie ma kompilatora TS. Kontekstowo poprawnie: matchWebhookToken stosuje fail-fast (typeof url !== 'string' → null), regex z kotwicą (?:\?|$) poprawnie obcina query-string, zwraca jednolicie token|null. Brak realnego defektu — informacyjnie, że ścieżka 'type safety' tej fazy jest egzekwowana runtime guardem, nie typami.

### P3-7 · TEST · `lib/db.test.js:226`
getTodayRunStats zwraca `{ success: row.success, failed: row.failed }` gdzie wartości pochodzą z SUM(...) SQLite (typ liczbowy). Testy asertują na konkretne liczby (toEqual 2/1/0), więc zachowanie pokryte. Nit: brak asercji potwierdzającej że zwracane pola są number a nie string/BigInt (better-sqlite3 może zwracać BigInt dla dużych SUM tylko przy włączonym trybie) — w praktyce nieosiągalne przy tych rozmiarach, więc nie wymaga zmiany.

### P3-8 · TEST · `lib/db.test.js:193`
getRecentRunsPerJob jest w produkcji wołany z server.js:328-329 jako `db.getRecentRunsPerJob(params.get('per_job'))` — czyli ZAWSZE z wartością string (np. "7") albo null (param nieobecny). Testy pokrywają per_job jako int (0, 7, 999) i undefined, ale NIE pokrywają faktycznego typu z call-path: stringa numerycznego ("7"), stringa nienumerycznego ("abc"), ujemnego stringa ("-5"), ani null. Normalizacja (parseInt + fallback) obsługuje je poprawnie (zweryfikowano: "abc"->7, "-5"->7, "3.9"->3), ale brak asercji na rzeczywistej granicy API = niepokryta ścieżka. Sugerowany dodatkowy test: getRecentRunsPerJob("abc") i getRecentRunsPerJob("-5") -> default 7, getRecentRunsPerJob(null) -> default 7.

### P3-9 · TEST · `lib/db.test.js:230`
deleteOldRoutineRuns: test pokrywa happy path (kasuje stary success rutynowego, zostawia fresh/fail/timeout/nierutynowy) i zwraca count=1. Brak boundary na granicy cutoff: run z `finished_at == cutoff` (warunek SQL to ostre '<', więc run dokładnie na granicy NIE jest kasowany) oraz run z `finished_at = NULL` (porównanie NULL < cutoff w SQLite daje NULL, run nie kasowany). Te dwa przypadki brzegowe nie mają asercji — niski priorytet, bo główna logika retention jest pokryta.

### P3-10 · TEST · `lib/scheduler.test.js:98`
Test minutes '*/5 * * * *' asertuje deltaMs > 0 && <= 5min — poprawne. Brak natomiast asercji wprost na zachowanie getNextRun dla joba NIEzaplanowanego/unscheduled (cronJob brak w activeJobs -> return null) jako osobny happy-edge; jest to pośrednio pokryte przez test 'zły cron -> null' (scheduleJob nie dodaje do activeJobs), więc ścieżka null jest egzekwowana. Drobny gap dokumentacyjny, nie funkcjonalny.

### P3-11 · TEST · `lib/webhook.test.js:59`
Test 'nie-string input' pokrywa undefined i null. Brak asercji dla innych nie-stringów które mogą teoretycznie trafić (number, object) — guard to `typeof url !== 'string'`, więc wszystkie są obsługiwane jednolicie. Pokrycie wystarczające dla kontraktu (req.url jest zawsze stringiem w runtime http), ale 1-2 dodatkowe przypadki (np. {}) domknęłyby fail-fast. Bardzo niski priorytet.

---

## Zgodność ze spec

Faza 3 (Unit 8) wymagała: ekstrakcja `matchWebhookToken`, nowe testy `lib/webhook.test.js` i `lib/scheduler.test.js`, rozszerzenie `lib/db.test.js` (getRuns hideRoutine/job_id, deleteOldRoutineRuns, CASCADE).

- (a) Braki / częściowo zaimplementowane: brak.
- (b) Scope creep: brak — zmiany ograniczone do warstwy testów i jednej ekstrakcji wymaganej przez plan.
- (c) Błędnie zaimplementowane: brak. Ekstrakcja matchWebhookToken zachowuje zachowanie (regresja `?query` pokryta testem), wszystkie scenariusze z planu mają odpowiadające testy z asercjami.

---

## Bookkeeping checkboxów Weryfikacja:

- Odznaczone automatycznie (CLI/grep): 3
- Odznaczone na podstawie Agent 5 E2E: 0
- Pozostawione dla operatora (Manual): 0
- Niejasne (P3): 0
- Failujące (P2): 0

### Szczegóły
- [x] CLI: `node --test (cały zestaw) przechodzi` → PASS (komenda: `node --test`, exit 0, 62 pass / 0 fail)
- [x] CLI: `node -e "require('./lib/webhook').matchWebhookToken" nie rzuca` → PASS (komenda: `node -e "require('./lib/webhook').matchWebhookToken"`, exit 0)
- [x] Grep: `grep -q 'matchWebhookToken' server.js` → PASS (exit 0)

Bookkeeping nie wprowadził nowych P2/P3. Severity gate bez zmian: **CZYSTE**.
