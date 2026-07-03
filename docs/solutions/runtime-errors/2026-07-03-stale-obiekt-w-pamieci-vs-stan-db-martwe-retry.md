---
title: "Stale-owy obiekt w pamięci vs stan w DB — martwe retry i zjadanie statusu killed, zamaskowane testami czystych funkcji"
date: 2026-07-03
category: runtime-errors
severity: high
stack:
  - Node.js
  - SQLite (node:sqlite)
tags:
  - stale-state
  - retry
  - notifications
  - integration-seam
  - node-test
status: verified
last_verified: 2026-07-03
---

# Stale-owy obiekt w pamięci vs stan w DB — martwe retry i zjadanie statusu `killed`

## Symptomy

- Job z domyślnym `max_retries=1` i włączonym `telegram_notify`/`discord_notify` pada (exit ≠ 0) i **user nie dostaje ŻADNEGO powiadomienia ❌** (R9 cicho złamane) — retry też nigdy nie powstaje.
- ❌ przychodziło dopiero gdy job padł drugi raz z rzędu przy kolejnym runie z crona (potencjalnie po dobie).
- Ubicie runu przez usera (`killCurrent` → status `killed`) kończyło się w close handlerze statusem `failed` (policzonym z exit code po SIGTERM) — R9 wysłałoby ❌ po świadomym killu.
- **Cały suite testów przechodził** (230/230) — czyste funkcje (`isFinalFailure`, `sendFailureNotification`) testowane osobno, wiring między nimi nigdy.

## Root Cause

`scheduler.processQueue` sprawdzał `run.status === 'failed'` na obiekcie pobranym z `getQueuedRuns()` PRZED `executeRun` — a `executeRun` zapisuje wynik wyłącznie do DB przez `db.updateRun(run.id, ...)` i **nie mutuje przekazanego obiektu**. In-memory `run.status` zostawał `'queued'`, więc retry było martwe od zawsze (pre-existing). Faza 2 zbudowała na tym założeniu próg `isFinalFailure` („wstrzymaj ❌, bo scheduler doda retry") — dwie warstwy poprawne osobno, złamane razem. Ten sam wzorzec w drugą stronę: close handler liczył status z exit code, nie wiedząc że `killCurrent` już zapisał `killed` w DB.

## Rozwiązanie

1. **Po operacji zapisującej wynik do DB czytaj świeży rekord, nie stale obiekt** (`lib/scheduler.js`):

```javascript
await executor.executeRun(run);

// Status po runie czytamy ŚWIEŻO z DB — executeRun zapisuje wynik wyłącznie przez
// db.updateRun i NIE mutuje obiektu z getQueuedRuns()
const finished = db.getRunWithPayload(run.id);

if (finished && finished.status === 'failed' && job && job.max_retries > 0) {
  if (db.countRecentFailedRuns(run.job_id, job.max_retries) <= job.max_retries) {
    db.createRun({ job_id: run.job_id, trigger_type: 'retry' });
  }
}
```

2. **Jedna definicja progu w jednym miejscu**: wspólny helper `db.countRecentFailedRuns(jobId, maxRetries)` używany przez retry (scheduler) i ostateczność failu ❌/R9 (`executor.notifyRunOutcome`) — próg „będzie retry / final fail" nie może żyć w dwóch rozjeżdżających się kopiach.

3. **Guard `killed` symetrycznie**: close handler czyta `priorRun` z DB PRZED policzeniem statusu z exit code — `killCurrent` zapisuje `killed` zanim proces się domknie; bez odczytu SIGTERM ≠ 0 nadpisałby `killed` na `failed`.

4. **Test szwu integracji, nie tylko czystych funkcji**: testy integracyjne fail→retry→❌ (raz, po ostatecznym failu) na DB `:memory:` w `scheduler.test.js` + testy `notifyRunOutcome` z mockami kanałów (gating flag, success/final-fail/killed, niezależność kanałów) w `executor.test.js`.

## Komendy diagnostyczne

```bash
# Czy executeRun mutuje przekazany obiekt, czy pisze tylko do DB?
grep -n "updateRun\|run.status" lib/executor.js lib/scheduler.js

# Repro martwego retry: job z max_retries=1, run failuje — czy powstaje run trigger_type='retry'?
sqlite3 data/claude-cron.db "SELECT id,status,trigger_type FROM runs ORDER BY id DESC LIMIT 5"

node --test lib/scheduler.test.js lib/executor.test.js
```

## Zapobieganie

- Po każdej operacji, która zapisuje wynik do DB (executor, worker, handler), **kolejne decyzje podejmuj na świeżym odczycie z DB** — nigdy na obiekcie sprzed operacji. Obiekt JS nie jest widokiem na wiersz bazy.
- Gdy moduł A wstrzymuje akcję zakładając, że moduł B coś zrobi (retry, cleanup, kompensacja) — napisz **test integracyjny łączący A i B**. Testy czystych funkcji obu stron przechodzą nawet gdy zachowanie systemowe jest złamane; to dokładnie ta luka zamaskowała P1.
- Zachowania „nigdy nie rób X przy stanie Y" (tu: nigdy ❌ przy `killed`) testuj na poziomie wykrycia stanu Y, nie tylko czystej funkcji decydującej.
- Progi/okna współdzielone przez moduły wyciągaj do jednego helpera (tu `db.countRecentFailedRuns`) — duplikacja definicji progu rozjeżdża się cicho.

## Powiązane

- `docs/active/telegram-powiadomienia-skill-taski/review-faza-2.md` — pełny raport (P1-1/P1-2, P2-3/P2-4).
- `docs/solutions/deployment-issues/2026-07-03-guardy-instalatora-falszywe-sygnaly-statusow-cli.md` — ta sama rodzina: decyzje podejmuj na stanie faktycznym, nie na sygnale zastępczym.
- Fix: commit `0abd9db` (248/248 PASS, +18 testów, zero zmian w istniejących asercjach).

## Kontekst

Wykryte podczas review fazy 2 zadania `telegram-powiadomienia-skill-taski` (powiadomienia Telegram + wariant fail R9). Root cause martwego retry był pre-existing w schedulerze — ujawnił się dopiero, gdy nowa logika (`isFinalFailure`) zbudowała na nim założenie. W tym samym commicie domknięto pokrewne P2 w chunkingu: `smartSplit` fail-fast przy `maxLen <= 0` (nieskończona pętla = DoS event loopu przy nazwie joba ~4090+ znaków) i off-by-one (`'. '` na indeksie `maxLen` dawał chunk 4097 > limit Telegrama 4096 → Bot API 400, fire-and-forget połykał błąd).
