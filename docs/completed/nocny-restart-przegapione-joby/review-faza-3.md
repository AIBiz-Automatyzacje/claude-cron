# Review fazy 3 — `MAINTENANCE_WINDOW` w config.js + ekspozycja przez `/api/env`

**Data:** 2026-06-27
**Faza:** 3 (Unit 3)
**Pliki w zakresie:** `lib/config.js`, `server.js`
**Severity gate:** ✅ CZYSTE (0× P1, 0× P2; sam P3 + OPERATOR)

## Podsumowanie

Faza 3 realizuje Unit 3 planu: dodanie stałej `MAINTENANCE_WINDOW = { startHour: 6, startMin: 0, endHour: 6, endMin: 15 }` w `lib/config.js` (z eksportem i komentarzem o potwierdzeniu empirycznym) oraz przepuszczenie jej przez `GET /api/env` jako pole `maintenance_window` (server.js:180). Implementacja zgodna ze spec R4: `server.js:5` importuje `MAINTENANCE_WINDOW`, endpoint zwraca trywialny passthrough stałej, a kształt `{startHour, startMin, endHour, endMin}` jest spójny z konsumentem (helper `overlapsMaintenanceWindow` z Unit 4).

Po adversarial verify: **0× P1, 0× P2**. Wszystkie findingi to **P3** (nity) oraz **OPERATOR** (warunki środowiskowe niewykonalne headless). Bezpośredni deliverable fazy — pole `maintenance_window` w `/api/env` — nie ma asercji automatycznej (brak `server.test.js`), a zakładane pokrycie pośrednie przez helper z Unit 4 faktycznie nie istnieje (test render-helpers hardkoduje własną kopię okna zamiast importować `MAINTENANCE_WINDOW`). To luki pokrycia/nity, nie defekty KOD — statyczna analiza i pełny suite (107/107 PASS) potwierdzają poprawność.

## Statystyki

- 🔴 [P1-blocking]: 0
- 🟠 [P2-important]: 0
- 🟡 [P3-nit]: 4 (2× TEST, 2× KOD)
- 📋 OPERATOR (poza fix): 4
- ✅ E2E: 0 passed / 0 failed / 1 skipped (scenariusz `/api/env` w devtools — niewykonalny headless, brak `.env.e2e`)

## Findingi

### 🟡 P3 — nity (KOD/TEST)

1. **server.js:180** (TEST) — Bezpośredni deliverable Fazy 3 — pole `maintenance_window` w odpowiedzi `GET /api/env` — nie ma ŻADNEJ asercji automatycznej. Brak `server.test.js`, a w całym suite (`node --test`) nic nie sprawdza kształtu/obecności `maintenance_window` w `/api/env`. Plan przewidział dla tego tylko `[E2E]` curl, który wobec braku `.env.e2e` ląduje na Operator checklist — przez co kontrakt endpointu (nowe pole) jest niezweryfikowany przez jakikolwiek test. Min. test integracyjny: odpowiedź `/api/env` zawiera `maintenance_window` równe `MAINTENANCE_WINDOW` z config.

2. **public/render-helpers.test.js:10** (TEST) — Plan deklarował, że kształt `MAINTENANCE_WINDOW` z config.js będzie pokryty POŚREDNIO przez helper `overlapsMaintenanceWindow` konsumujący realne okno (single source of truth). W praktyce test deklaruje WŁASNĄ, zahardkodowaną kopię okna (`{startHour:6,startMin:0,endHour:6,endMin:15}`) zamiast importować `MAINTENANCE_WINDOW` z `lib/config.js`. Skutek: drift kształtu w config (np. zmiana na minuty-od-północy) NIE zostanie wychwycony — zakładane pokrycie pośrednie Fazy 3 faktycznie nie istnieje.

3. **lib/config.js:43** (KOD) — `MAINTENANCE_WINDOW` to jedyny eksportowany obiekt referencyjny w configu (pozostałe eksporty to immutable prymitywy) i jest zwracany przez `require()` jako współdzielona referencja oraz bezpośrednio w `/api/env`. Brak ochrony przed mutacją — odpowiednik braku `as const`/zamrożenia stałej. Sugestia: `Object.freeze({ startHour: 6, startMin: 0, endHour: 6, endMin: 15 })`, by zagwarantować niezmienność kontraktu (źródło prawdy R4). Nit — dziś żaden konsument tego nie mutuje, serializacja w `/api/env` i tak robi kopię.

4. **lib/config.js:43** (KOD) — Nit (nie regresja fazy): `MAINTENANCE_WINDOW` jest eksportowanym mutowalnym obiektem bez `Object.freeze` — współdzielona referencja mogłaby zostać przypadkowo zmutowana przez konsumenta. Spójne z resztą `module.exports` configu (żaden obiekt nie jest freezowany), więc do ewentualnej globalnej decyzji, nie do naprawy w tej fazie.

### 📋 OPERATOR — warunki środowiskowe (niewykonalne headless, poza fix)

5. **server.js:180** (OPERATOR) — Weryfikacja E2E z planu (otwórz `/` → network `GET /api/env` zawiera `maintenance_window` z `startHour:6`) jest niewykonalna headless — w repo brak `.env.e2e` (potwierdzone: `ls .env.e2e` => brak). Plan Unit 3 sam to przewiduje (Operator checklist: operator odpala serwer i `curl localhost:7777/api/env` → widzi `maintenance_window`). Wymaga realnego uruchomienia serwera przez operatora, nie defekt kodu.

6. **server.js:180** (OPERATOR) — Unit 3 scenariusz `[E2E]`: „otwórz `/` (dev e2e), w devtools/network sprawdź `GET /api/env` → odpowiedź zawiera `maintenance_window` z `startHour: 6`". Projekt nie ma `.env.e2e` — plan sam przenosi to do Operator checklist. Weryfikacja niewykonalna headless: wymaga uruchomionego serwera. Statyczna analiza potwierdza zgodność: `server.js:5` importuje `MAINTENANCE_WINDOW`, `server.js:180` zwraca `maintenance_window: MAINTENANCE_WINDOW`, a `config.js:43` ma `startHour:6`. Nie defekt kodu — pozostawione do potwierdzenia przez operatora.

7. **server.js:179** (OPERATOR) — Scenariusz E2E z planu dla Unit 3 (uruchom serwer, `curl localhost:7777/api/env` → widać `maintenance_window` z `startHour:6`) jest niewykonalny headless: brak `.env.e2e` w repo, weryfikacja wymaga realnie wystartowanego serwera. Należy do Operator checklist planu — nie defekt kodu.

8. **nocny-restart-przegapione-joby-zadania.md:64** (OPERATOR) — Weryfikacja Unit 3 `curl localhost:7777/api/env` → odpowiedź zawiera `maintenance_window` ze `startHour:6` pozostaje `[ ]` (niedomknięta). Niewykonalna headless — wymaga realnego uruchomienia serwera. To weryfikacja operatorska, nie defekt kodu: endpoint `/api/env` (server.js:180) to trywialny passthrough stałej z config.js, kontrakt zgodny ze spec (`{startHour,startMin,endHour,endMin}`). Do potwierdzenia przez operatora, brak akcji w kodzie.

## Zgodność ze spec

R4 zaimplementowane poprawnie: `MAINTENANCE_WINDOW` zdefiniowane w `lib/config.js:43` z komentarzem o potwierdzeniu empirycznym (restart ~06:00 CEST), wyeksportowane (config.js:72), zaimportowane w `server.js:5` i zwracane przez `GET /api/env` jako `maintenance_window` (server.js:180). Brak scope creep, brak braków krytycznych. Latentne: brak testu kontraktu endpointu i brak realnego pokrycia pośredniego (test hardkoduje kopię okna) — odnotowane jako P3, świadomy tradeoff (UMD frontend nie importuje configu Node).

## Bookkeeping checkboxów Weryfikacja:

Sekcja fazy 3 (Unit 3) ma 2 checkboxy `Weryfikacja:` (zadania.md:60-61), oba już zaznaczone `[x]` przez execute. Re-walidacja potwierdzająca:

- Odznaczone automatycznie (CLI/grep): 2 (potwierdzone)
- Odznaczone na podstawie E2E: 0
- Pozostawione dla operatora (Manual): 0
- Niejasne (P3): 0
- Failujące (P2): 0

### Szczegóły

- [x] Grep: `grep -n "MAINTENANCE_WINDOW" lib/config.js server.js` → PASS (config.js:43 definicja, config.js:72 eksport, server.js:5 import, server.js:180 użycie w `/api/env`)
- [x] CLI: `node --test` (cały suite) → PASS (107/107, exit 0, zero regresji)

Operator checklist (zadania.md:64) — `curl localhost:7777/api/env` → pozostaje `[ ]`, niewykonalny headless (brak `.env.e2e`), przeniesiony do sekcji „Operator checklist faza 3".

## Liczniki

| Kategoria | Liczba |
|---|---|
| P1 | 0 |
| P2 | 0 |
| P3 (KOD/TEST/E2E) | 4 |
| OPERATOR | 4 |

## Severity gate

✅ **CZYSTE** — 0× P1, 0× P2. Sam P3 (4 nity: brak testu kontraktu endpointu, brak realnego pokrycia pośredniego, brak `Object.freeze` na eksportowanej stałej) oraz 4× OPERATOR (weryfikacja `/api/env` niewykonalna headless — brak `.env.e2e`). Gate nie blokuje fazy. P3 opcjonalne do rozważenia; OPERATOR do potwierdzenia przez operatora poza ścieżką fix.
