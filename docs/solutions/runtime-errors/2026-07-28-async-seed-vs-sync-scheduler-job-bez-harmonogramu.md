---
title: "Async seed + synchroniczny scheduler.start() = job bez harmonogramu do następnego restartu"
date: 2026-07-28
category: runtime-errors
severity: high
stack:
  - Node.js
  - croner
  - node:sqlite
tags:
  - race-condition
  - startup-order
  - scheduler
  - seed
  - team-os
  - test-szwu
status: verified
last_verified: 2026-07-28
---

# Job zaseedowany przy starcie nie dostaje harmonogramu

## Symptomy

Na świeżo zainstalowanej maszynie job Team OS istnieje w bazie, jest włączony, ma poprawnego crona — i **nigdy się nie wykonuje**:

```
name       : "Team OS — asystent auto-reply"
enabled    : 1
cron_expr  : "*/1 * * * *"
next_run   : null          ← scheduler go nie zna
runy       : 0             ← przy uptime 1h 35min
```

Skutek zależy od roli maszyny: `agent` → asystent milczy na pytania zespołu; `client` → `Skrzynka.md` nigdy się nie renderuje (cicha śmierć skrzynki).

**Objaw znika po `systemctl restart`** — i to jest najgorsza część. Każda diagnoza „po fakcie" pokazuje działający system, więc problem wygląda na jednorazowy przypadek.

## Root Cause

`server.js` woła seed i scheduler w tym samym tiku:

```js
inboxSeed.seedInboxSyncJob().then(...);   // async — ma `await loadEnvFn()`
scheduler.start();                         // synchronicznie, ZARAZ potem
```

`scheduler.start()` wykonuje `db.getAllJobs()` i planuje to, co znajdzie. Ale seed jest `async` — pierwszy `await` oddaje kontrolę do event loopu, więc `db.createJob(...)` wykonuje się **po** starcie schedulera. Job powstaje sekundy później i nikt go już nie planuje.

Przy **drugim** boocie job jest już w bazie przed `scheduler.start()`, więc zostaje zaplanowany i problem znika bez śladu.

## Rozwiązanie

Seed nie może znać schedulera (coupling warstw), więc dostaje hak przez DI — wołany **wyłącznie** po realnym `createJob`:

```js
// lib/inbox-seed.js
async function seedInboxSyncJob({ loadEnvFn, repoRoot, onJobCreated = null } = {}) {
  // ...
  if (db.getAllJobs().some((job) => job.name === jobName)) return `exists:${label}`;
  db.createJob(isAgent ? assistantJobDef(repoRoot) : inboxSyncJobDef(repoRoot));
  // Hak to efekt uboczny startu — jego pad nie może zabrać ze sobą seedu ani daemona
  // (job JEST już w bazie, więc najgorszy scenariusz to harmonogram od kolejnego bootu).
  if (typeof onJobCreated === 'function') {
    try { onJobCreated(); } catch (err) {
      console.error(`[seed] Hak po utworzeniu joba "${jobName}" rzucił: ${err.message}`);
    }
  }
  return `seeded:${label}`;
}
```

```js
// server.js — wołający dostarcza scheduler
inboxSeed.seedInboxSyncJob({ onJobCreated: () => scheduler.rescheduleAll() }).then((result) => { ... });
```

`rescheduleAll()` jest idempotentne (`scheduleJob` robi najpierw `unscheduleJob`), więc wywołanie przed lub po `scheduler.start()` daje ten sam wynik.

## Dlaczego trzy review tego nie złapały

`lib/inbox-seed.test.js` testował seed, `lib/scheduler.test.js` testował planowanie. **Obie strony zielone przy złamanym zachowaniu systemowym** — nikt nie sprawdził szwu. Grep potwierdził: `seedInboxSyncJob` nie występował w żadnym teście poza własnym.

Test szwu musi odtwarzać **kolejność startu daemona**, nie tylko wołać obie funkcje:

```js
test('szew: job zaseedowany PO starcie schedulera dostaje harmonogram bez restartu', async () => {
  const seeding = seedInboxSyncJob({ ...seedOpts(), onJobCreated: () => scheduler.rescheduleAll() });
  scheduler.start();                    // czyta PUSTĄ listę — jak w server.js
  try {
    await seeding;
    const job = db.getAllJobs().find((j) => j.name === JOB_NAME);
    assert.notEqual(scheduler.getNextRun(job.id), null,
      'job bez harmonogramu = cicha śmierć Skrzynki do następnego restartu daemona');
  } finally {
    scheduler.stop();                   // start() zostawia setInterval — bez tego pad asercji WIESZA proces
  }
});
```

Pułapka przy pisaniu tego testu: `scheduler.start()` uruchamia `setInterval` (heartbeat, retention). Bez `try/finally` nieudana asercja nie oblewa testu, tylko **zawiesza cały proces testowy**.

## Komendy diagnostyczne

```bash
# next_run == null przy enabled=1 i poprawnym cronie = job nie jest zaplanowany
curl -s localhost:7777/api/jobs | python3 -c "
import sys,json
for j in json.load(sys.stdin):
    print(j['enabled'], j['cron_expr'], j['next_run'], j['name'])"

# zero runów przy długim uptime potwierdza
curl -s localhost:7777/api/runs | python3 -c "import sys,json;print(len(json.load(sys.stdin)))"

# rozstrzygnięcie: restart i ponowny odczyt next_run
systemctl restart claude-cron && sleep 5 && curl -s localhost:7777/api/jobs | grep -o '"next_run":"[^"]*"'
```

## Zapobieganie

- Każdy `createJob` poza `scheduler` musi zasygnalizować schedulerowi zmianę — inaczej job istnieje, ale nie chodzi.
- Fire-and-forget przy starcie jest bezpieczne tylko wtedy, gdy nic po nim nie czyta stanu, który ta operacja zmienia. Tutaj `scheduler.start()` czytał dokładnie tę tabelę, którą seed miał zapisać.
- Gdy moduł A zakłada, że moduł B coś zrobił — testuj szew, nie obie strony osobno. Test musi odtworzyć rzeczywistą kolejność wywołań.
- Objaw znikający po restarcie to sygnał ostrzegawczy, nie dowód naprawy: sprawdzaj stan **przed** restartem.

## Powiązane

- `docs/solutions/runtime-errors/2026-07-03-stale-obiekt-w-pamieci-vs-stan-db-martwe-retry.md` — ten sam wzorzec (założenie międzymodułowe niepokryte testem szwu), inny mechanizm
- `docs/solutions/runtime-errors/2026-06-27-backfill-w-migrate-clobberuje-opt-outy.md` — sąsiednia pułapka startu daemona

## Kontekst

Wykryte podczas testu instalacji na świeżym VPS-ie (Ubuntu 24.04, Node 22.23, `feature/team-os-onboarding-instalatory`). Job auto-reply stał 1h 35min z `next_run: null`; po `systemctl restart` — `next_run` ustawiony i pierwszy run w 20 s (auto-reply odpowiedział poprawnie).

Potwierdzone niezależnie na drugiej platformie i drugiej roli: świeża instalacja na Windowsie (rola `client`) po fiksie utworzyła job „Team OS — inbox sync" o 06:03:48 z `next_run: 06:40` — bez restartu.
