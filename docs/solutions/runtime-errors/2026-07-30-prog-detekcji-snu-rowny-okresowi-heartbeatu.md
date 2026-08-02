---
title: "Próg detekcji snu równy okresowi heartbeatu — każde tyknięcie brane za wybudzenie, testy zielone przez mock timers"
date: 2026-07-30
category: runtime-errors
severity: high
stack:
  - Node.js
  - node:test
  - SQLite
tags:
  - timery
  - libuv
  - heartbeat
  - detekcja-snu
  - mock-timers
  - scheduler
  - jitter
status: verified
last_verified: 2026-07-30
---

# Próg detekcji snu równy okresowi heartbeatu — każde tyknięcie brane za wybudzenie

## Symptomy

- Po dodaniu karencji sieciowej po wybudzeniu (`lib/scheduler.js`, Faza 4 sprintu „równoległe joby”)
  log daemona co ~60 s wypluwał fałszywy alarm:
  `[scheduler] wybudzenie po 60 s przerwy — karencja 45 s przed startem runów`.
- Wszystkie runy startowały z opóźnieniem do 45 s — okno startu skurczyło się do ~15 s na minutę.
  To łamało główny cel sprintu (R1: „krótkie zadania nigdy nie czekają”) **na całym systemie**,
  najmocniej dla joba „Team OS — inbox sync” (`* * * * *`) i dla retry.
- **Cała suita była zielona** (790/790). Objaw widać wyłącznie na żywym procesie.
- Drugi objaw tej samej rodziny (przed poprawką P2): pierwszy run po realnej pobudce Maca startował
  **bez** karencji i padał na `ENOTFOUND` — dokładnie ten scenariusz, dla którego karencja powstała.
- Trzeci objaw (P3): zwykły redeploy daemona wchodził w karencję 45 s, choć maszyna nie spała.

## Root Cause

Trzy niezależne błędy w jednej mechanice „wykryj lukę wall-clock”:

1. **Próg równy okresowi timera.** Detekcja liczyła `gap > SLEEP_GAP_MS` (60 s), a heartbeat tykał
   `setInterval(..., HEARTBEAT_INTERVAL_MS)` = dokładnie 60 s. Timery libuv gwarantują wyłącznie
   „nie wcześniej niż”, więc realna luka to **zawsze** 60 00x ms → każde normalne tyknięcie
   przekraczało próg. W `executor.js` ten sam próg 60 s jest poprawny tylko dlatego, że tam tick
   jest co 5 s (12× zapasu) — wartość przeniesiono bez sprawdzenia okresu po nowej stronie.
2. **Detekcja tylko w callbacku heartbeatu.** Po pobudce libuv odpala zaległe timery w kolejności
   due-time, a cron `* * * * *` typowo wypada wcześniej niż kolejne tyknięcie heartbeatu, więc
   `processQueue` biegł przy `wakeDetectedAt === null`.
3. **Znacznik pisany co N sekund porównywany progiem N.** `last_active_at` (start po downtimie) jest
   w chwili zatrzymania daemona przestarzały o 0–60 s, więc staleness + krótki downtime
   przekraczały próg przy zwykłym restarcie.

Dlaczego testy tego nie złapały: `t.mock.timers.tick(60_000)` przesuwa `Date` o **dokładnie** 60000 ms,
czyli daje `gap === próg` (`gap > próg` = false). Mock produkuje wartość nieosiągalną na realnym
event loopie — test był zielony przy złamanym zachowaniu produkcyjnym.

## Rozwiązanie

**1. Osobny próg dla śladów zostawianych co heartbeat — okres + definicja snu:**

```js
// lib/scheduler.js
// Świadomie NIE goły executor.SLEEP_GAP_MS: tam próg 60 s działa, bo tick jest co 5 s
// (12× zapasu), a tutaj tyknięcie jest DOKŁADNIE co 60 s, a timery libuv gwarantują tylko
// „nie wcześniej niż" — realna luka to zawsze 60_00x ms.
const WAKE_GAP_MS = HEARTBEAT_INTERVAL_MS + executor.SLEEP_GAP_MS; // 120 s

function isWakeGap(prevAt, now, sleepGapMs = executor.SLEEP_GAP_MS) {
  if (prevAt === null || prevAt === undefined) return false;
  const gap = now - prevAt;
  return Number.isFinite(gap) && gap > sleepGapMs;
}
```

Ten sam próg przekazywany jawnie w obu miejscach czytających ślad heartbeatu:
`noteWakeIfGap()` (tyknięcie w pamięci) i `detectWakeFromDowntime()` (`last_active_at` z DB).

**2. Detekcja na ścieżce, która faktycznie biegnie — nie tylko w callbacku timera:**

```js
// lib/scheduler.js — processQueue()
const now = Date.now();
// Detekcja TU, a nie tylko w callbacku heartbeatu: po pobudce libuv odpala zaległe timery
// w kolejności due-time, a cron `* * * * *` typowo wypada wcześniej niż kolejne tyknięcie.
// Koszt na normalnej ścieżce to jedno odejmowanie: zero await, zero zapytania do DB.
noteWakeIfGap(now);
const deferring = shouldDeferAfterWake(wakeDetectedAt, now);
if (!deferring) startEligibleRuns(ctx);
```

`noteWakeIfGap` przesuwa `lastHeartbeatAt = now` **jako część detekcji** — inaczej kolejna iteracja
zobaczyłaby tę samą lukę i przedłużała karencję w nieskończoność. Heartbeat i pętla kolejki patrzą na
TEN SAM ślad, więc wynik nie zależy od tego, który zaległy timer odpali pierwszy.

**3. Decyzja NIE na znaczniku z DB.** Pierwszym argumentem czystej funkcji jest chwila **wybudzenia**,
nie `last_active_at`: po pobudce Node odpala zaległy callback heartbeatu natychmiast i nadpisuje ten
znacznik świeżą wartością — luka znika, zanim ktokolwiek zdąży ją przeczytać.

**4. Test z realistycznym jitterem jako guard regresji:**

```js
// lib/scheduler.test.js
// Mock daje idealne 60000, dlatego jitter dokładamy jawnie — bez niego test byłby zielony
// przy złamanym zachowaniu produkcyjnym.
for (const jitterMs of [2, 3, 2]) {
  t.mock.timers.setTime(Date.now() + jitterMs);
  t.mock.timers.tick(HEARTBEAT_INTERVAL_MS);
  assert.equal(scheduler.getWakeDetectedAt(), null,
    `tyknięcie spóźnione o ${jitterMs} ms NIE jest wybudzeniem`);
}
```

Plus test szwu „pętla kolejki wykrywa lukę bez heartbeatu” i test graniczny
`last_active_at = now - 65_000` asertujący BRAK karencji.

## Komendy diagnostyczne

```bash
# Zmierz realny jitter setInterval na tej maszynie (obala „gap == period")
node -e 'let p=Date.now();let n=0;setInterval(()=>{const t=Date.now();console.log("gap",t-p);p=t;if(++n>2)process.exit(0);},60000)'

# Fałszywe wybudzenia w logu żywego daemona (powinno być 0 w normalnej pracy)
grep -c "wybudzenie po" ~/Library/Logs/claude-cron/*.log

# Testy warstwy kolejki
node --test lib/scheduler.test.js
```

## Zapobieganie

- Próg wykrywający lukę między okresowymi śladami życia MUSI być **ostro większy** od okresu tego
  śladu, z zapasem na jitter — nigdy równy. Przenosząc stałą progową między modułami sprawdź okres
  tickowania po nowej stronie (60 s przy ticku 5 s to co innego niż 60 s przy ticku 60 s).
- Znacznik zapisywany co N sekund jest w losowej chwili przestarzały o 0–N sekund — próg musi
  obejmować tę granulację, inaczej zwykły restart udaje wybudzenie.
- Testów opartych o `t.mock.timers.tick(period)` nie traktuj jako pokrycia progów granicznych —
  mock daje wartość dokładną, produkcja nigdy. Dokładaj jawny jitter (`setTime(now + 2)`).
- Zdarzenie globalne (pobudka maszyny) wykrywaj na ścieżce, która faktycznie biegnie po zdarzeniu,
  a nie tylko w jednym callbacku timera — po pobudce kolejność zaległych timerów nie jest twoja.

## Powiązane

- [docs/solutions/runtime-errors/2026-07-28-async-seed-vs-sync-scheduler-job-bez-harmonogramu.md](2026-07-28-async-seed-vs-sync-scheduler-job-bez-harmonogramu.md)
  — ta sama rodzina: testy obu stron zielone przy złamanym zachowaniu systemowym.
- [docs/solutions/runtime-errors/2026-07-03-stale-obiekt-w-pamieci-vs-stan-db-martwe-retry.md](2026-07-03-stale-obiekt-w-pamieci-vs-stan-db-martwe-retry.md)
  — stan czytany nie z tego źródła, co trzeba.
- [docs/solutions/runtime-errors/2026-07-14-close-nie-odpala-wnuk-dziedziczy-pipe-wyciek-slotu.md](2026-07-14-close-nie-odpala-wnuk-dziedziczy-pipe-wyciek-slotu.md)
  — cichy wyciek w tej samej pętli kolejki.

## Kontekst

- Sprint `docs/active/rownolegle-joby`, Faza 4 (Unit 9 — karencja sieciowa po wybudzeniu),
  commity `71d0944` (implementacja) i `73dd980` (P1+P2+P3 po review).
- Środowisko: Node 22.17 (portable), macOS 15 (sen maszyny) oraz VPS Linux (restart po reboocie),
  `lib/scheduler.js`, `lib/executor.js` (`SLEEP_GAP_MS`), `lib/config.js` (`HEARTBEAT_INTERVAL_MS`).
- Znaleziony w review fazy jako P1 z pomiarem na bezczynnym procesie: `gap=60003`, `gap=60002`
  (2/2 tyknięć ponad progiem). Po poprawce: `npm test` 790+/0 fail, zero modyfikacji istniejących testów.
- Dług do domknięcia: `lib/scheduler.js` ma ~655 linii przy limicie 300 — blok „wake” (`WAKE_GAP_MS`,
  `isWakeGap`, `wakeGraceRemainingMs`, `shouldDeferAfterWake`, `detectWakeFromDowntime`, heartbeat)
  to wyraźny szew do wyjęcia w osobnym kroku. Karencja nie ma jeszcze pokrycia E2E na żywej maszynie.
