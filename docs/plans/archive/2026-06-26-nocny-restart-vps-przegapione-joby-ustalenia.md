---
data: 2026-06-26
typ: ustalenia / pre-plan
status: zwalidowane (sesja dyskusyjna)
temat: Joby przegapione przez nocny restart/auto-update VPS
---

# Nocny restart VPS a przegapione joby — ustalenia

Rekord decyzji z sesji. VPS co noc robi auto-update (`git pull` o **6:00**, README:379)
i restartuje serwis. Job zaplanowany na okno restartu jest tracony. To NIE jest jeszcze
plan z Implementation Units — żeby go takim zrobić, odpal `/dev-plan` na tym dokumencie.

## Kontekst wyjściowy — dwa tryby awarii

`croner` trzyma harmonogram **tylko w RAM** (`activeJobs` Map, `lib/scheduler.js:6`).
Gdy proces nie żyje w momencie odpalenia, są dwa różne scenariusze:

1. **Przegapione odpalenie** — serwer wyłączony dokładnie gdy cron miał strzelić.
   Odpalenie nie następuje, job **przepada bez śladu** (brak nawet runu `failed`).
2. **Zabity w trakcie** — job wystartował przed restartem, restart go ubił.
   Obsłużone: `reapOrphanedRuns()` (`lib/db.js:275-282`, wołane w `server.js:423`)
   oznacza go jako `killed` z `error_msg = 'Przerwany — restart serwera'`. Bez retry
   (retry łapie tylko `failed`, `scheduler.js:29`).

## Stan istniejący — mechanizm JUŻ jest, ale domyślnie wyłączony

`detectMissedJobs()` (`scheduler.js:85-106`) odpala się przy starcie i dla jobów z
`run_on_wake=1`:
- bierze `last_active_at` (heartbeat co 60s, `scheduler.js:110-115`),
- liczy `cron.nextRun(last_active_at)` — pierwsze odpalenie, które miało nastąpić w przestoju,
- jeśli przed `now` → dokolejkowuje **jeden** run z `trigger='wake'`.

Zweryfikowane na scenariuszu (job `0 6 * * *`, restart 5:59 → powrót 6:03):
`nextRun(5:59)=6:00 < 6:03` → job odpala się o 6:03. ✅
- **Collapse wbudowany:** liczy tylko pierwsze przegapione odpalenie → po N przegapionych
  cyklach odpala raz, nie N razy.
- **Brak podwójnego odpalenia:** jeśli job strzelił normalnie przed restartem, `nextRun`
  wskaże już następną dobę → nic się nie dokolejkowuje.

Flaga `run_on_wake` jest wystawiona w UI (checkbox `form-wake`, `public/app.js:853,908`),
ale **domyślnie wyłączona** (`run_on_wake INTEGER DEFAULT 0`, `db.js:39` + `createJob` `db.js:129`).
To jest sedno problemu: nie brak mechanizmu, tylko domyślny opt-out.

## Decyzje (zatwierdzone)

1. **Przełącz `run_on_wake` na domyślnie WŁĄCZONE (opt-out).** Trzy miejsca:
   - `db.js:39` — schema `DEFAULT 1` (uwaga: dotyczy nowych baz; istniejące joby przez migrację
     lub świadomie zostawić bez zmian — do rozważenia na etapie planu).
   - `db.js:129` — domyślny arg `run_on_wake = 1` w `createJob`.
   - `public/app.js` — domyślny stan checkboxa `form-wake` dla nowego joba = zaznaczony.
   Kto ma job nieidempotentny — odznacza. Załatwia „zwykły user planuje job w oknie restartu".
2. **Killed-w-trakcie — bez zmian.** Reaper oznacza `killed`, BEZ retry. Świadomie — job
   nieidempotentny nie powinien powtarzać częściowej pracy z efektami ubocznymi.
3. **Warning przy planowaniu w oknie restartu.** Stała `MAINTENANCE_WINDOW` w `lib/config.js`,
   a formularz przy zapisie joba w tym przedziale pokazuje ostrzeżenie:
   „uwaga: pokrywa się z nocnym restartem VPS, zostanie nadrobione po starcie".
   Uświadamia usera zamiast cicho ratować.

## Bug do poprawy (przy okazji implementacji)

- **`detectMissedJobs` liczy cron bez strefy czasowej.** `scheduler.js:95` tworzy
  `new Cron(job.cron_expr)` **bez** opcji `timezone`, podczas gdy `scheduleJob` (`scheduler.js:58`)
  przekazuje jawnie `{ timezone: ...resolvedOptions().timeZone }`. Przy serwerze z `TZ` inną
  niż lokalna detekcja przegapionych jobów policzy złą granicę okna. Ujednolicić strefę w obu
  miejscach. Patrz też ostrzeżenie UTC-vs-localtime w `.claude/rules/learned-patterns.md`.

## Pytania otwarte

- **Dokładne okno restartu.** README:379 podaje `git pull` o 6:00. Trzeba potwierdzić:
  jak długo trwa restart/update (np. 6:00–6:15?) i czy `MAINTENANCE_WINDOW` ma być stałą
  godziną czy przedziałem. To wartość do wpisania w config dla decyzji #3.

## Następny krok

Odpal `/dev-plan` na tym dokumencie, żeby rozbić #1–#3 + fix strefy na Implementation Units.
