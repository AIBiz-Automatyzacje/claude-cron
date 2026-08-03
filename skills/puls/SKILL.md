---
name: puls
description: "Zarządzanie schedulerem Puls (claude-cron) przez REST API. Używaj gdy user mówi: dodaj zadanie/task do Pulsa, zmień harmonogram lub cron joba, pokaż logi joba, dlaczego job padł, uruchom job teraz, włącz/wyłącz job, webhook do joba, status Pulsa, zabij bieżący run. Tworzy i edytuje joby oraz diagnozuje runy bez ręcznego projektowania promptów."
argument-hint: "[co zrobić w Pulsie, np. 'dodaj task X co poniedziałek 8:00']"
allowed-tools: ["Bash", "Read"]
---

# Puls — zarządzanie jobami przez REST API

Puls (claude-cron) to lokalny scheduler agentów AI. Serwer HTTP działa na
`http://localhost:7777` (port konfigurowalny przez env `CLAUDE_CRON_PORT`).
Wszystkie operacje wykonuj przez `curl` (narzędzie Bash). Odpowiedzi są JSON-em;
błąd ma kształt `{ "error": "komunikat" }` (HTTP 400/404).

Jeśli user ma instancję na VPS: te same endpointy są dostępne przez proxy
`http://localhost:7777/api/vps/*` (np. `/api/vps/jobs` = `/api/jobs` na VPS).
Domyślnie działaj na instancji lokalnej — VPS tylko gdy user o to prosi.

## Endpointy

| Metoda | Ścieżka | Opis |
|--------|---------|------|
| GET | `/api/status` | Status: uptime, `current_runs` (**tablica** — runy biegną równolegle; same metadane, bez `stdout`/`stderr`/`webhook_payload`), `current_run` (= `current_runs[0]` albo `null`, zgodność wstecz), `queue_length`, liczba jobów, statystyki dzisiaj, `next` (najbliższy run) |
| GET | `/api/jobs` | Lista jobów (każdy z polem `next_run`) |
| GET | `/api/jobs/:id` | Jeden job + `next_run` |
| POST | `/api/jobs` | Utwórz job (body JSON, patrz „Pola joba") → 201 z jobem |
| PUT | `/api/jobs/:id` | Częściowa aktualizacja — wysyłasz tylko zmieniane pola |
| DELETE | `/api/jobs/:id` | Usuń job (kasuje też jego runy) → `{ "ok": true }` |
| POST | `/api/jobs/:id/trigger` | Uruchom job teraz (kolejkuje run `trigger_type: manual`) |
| POST | `/api/jobs/:id/toggle` | Przełącz `enabled` (włącz/wyłącz) |
| POST | `/api/jobs/:id/webhook` | Wygeneruj/zregeneruj token webhooka (pole `webhook_token` w jobie) |
| DELETE | `/api/jobs/:id/webhook` | Usuń token webhooka |
| POST | `/webhook/:token` | Publiczny trigger joba — body JSON trafia do promptu jako `webhook_payload` |
| GET | `/api/runs?job_id=&limit=&offset=` | Historia runów (pełne wiersze ze `stdout`/`stderr`); `hide_routine=1` chowa udane runy jobów rutynowych |
| GET | `/api/runs/current` | Pierwszy z biegnących runów (`status: running`) albo `null` — same metadane, bez `stdout`/`stderr`/`webhook_payload`; pełną listę daje `current_runs` z `/api/status`, a pełny wiersz z logami `GET /api/runs/:id` |
| GET | `/api/runs/:id` | Pełny wiersz JEDNEGO runu (ze `stdout`/`stderr` **oraz** `webhook_payload`) — tędy dociągasz log konkretnego runu |
| POST | `/api/runs/current/kill` | Zabij bieżący run → `{ "killed": true/false }`. **409** gdy biegnie kilka runów (patrz niżej) |
| POST | `/api/runs/:id/kill` | Zabij KONKRETNY run → `{ "killed": true/false }` (`false` = run już nie biegnie); 404 gdy run nie istnieje |
| GET | `/api/settings/concurrency` | `{ "max_concurrent": N }` — limit równoległych runów tej maszyny |
| PUT | `/api/settings/concurrency` | Zmiana limitu: `{ "max_concurrent": N }`, N całkowite 1–10 (śmieć → 400 z komunikatem) |
| GET | `/api/runs/recent?per_job=N` | N ostatnich runów per job (tylko metadane, bez stdout) |
| GET | `/api/skills` | Skille widziane przez Pulsa (project > user > plugin) |
| GET | `/api/env` | `vps_configured`, `webhook_base_url`, `maintenance_window` |
| GET | `/api/settings/notifications` | Konfiguracja powiadomień — zamaskowana (`configured` + końcówka sekretu) |
| PUT | `/api/settings/notifications` | Zapis: `discord_webhook_url`, `telegram_bot_token`, `telegram_chat_id` (stringi; pusty string czyści klucz — wraca fallback env) |
| POST | `/api/settings/notifications/push-to-vps` | Wyślij konfigurację powiadomień na VPS (200 ok; 503 brak VPS; 400 nic do wysłania; 502 pad) |

## Pola joba (POST /api/jobs, PUT /api/jobs/:id)

Serwer przyjmuje TYLKO te pola (reszta jest ignorowana):

| Pole | Default | Znaczenie |
|------|---------|-----------|
| `name` | — | **Wymagane.** Nazwa joba (idempotencja seedów działa po nazwie) |
| `job_type` | `"claude"` | `"claude"` = run CLI Claude Code; `"script"` = `node <command>` bez Claude |
| `skill_name` | `""` | Skill odpalany jako `/skill_name` w prompcie (typ `claude`) |
| `arguments` | `""` | Argumenty skilla / goły prompt (typ `claude`) |
| `command` | `null` | Ścieżka skryptu dla `job_type: "script"` — uruchamiany jako `node <command>` |
| `cron_expr` | `""` | Harmonogram cron (5 pól, **lokalna strefa czasowa** maszyny). Pusty = job tylko manual/webhook |
| `enabled` | `1` | 0/1 — czy scheduler planuje job |
| `run_on_wake` | `1` | 0/1 — nadrób przegapiony run po przebudzeniu/restarcie |
| `timeout_ms` | `600000` | Twardy limit całkowity runu — **milisekundy** (10 min) |
| `idle_timeout_ms` | `300000` | Limit ciszy na stdout — **milisekundy** (5 min) |
| `max_retries` | `1` | Ile razy ponowić po failu |
| `discord_notify` | `0` | 0/1 — powiadomienie Discord po runie |
| `telegram_notify` | `0` | 0/1 — powiadomienie Telegram po runie |
| `routine` | `0` | 0/1 — job rutynowy: udane runy chowane w UI i kasowane po 24 h |
| `lock_group` | `null` | **Grupa wyłączności** — dwa joby z tą samą niepustą wartością nigdy nie biegną równolegle (patrz „Równoległość"). Pusty string/`null` = job do żadnej grupy nie należy |

Reguły walidacji (serwer odrzuca z `{ "error": ... }`):

- `name` — zawsze wymagane.
- `job_type: "script"` → wymagane `command`.
- `job_type: "claude"` (lub brak) → wymagane `skill_name` LUB `arguments`.
- Timeouty podawaj w **ms** (dashboard pokazuje minuty, ale API mówi w ms).

## Równoległość (runy biegną obok siebie)

Puls wykonuje do `max_concurrent` runów naraz (domyślnie 3, per maszyna). Nie zakładaj,
że „biegnie jeden run" — `GET /api/status` zwraca **tablicę** `current_runs`.

**Klasyfikacja krótki/długi — nie wymyślaj własnej.** Puls liczy ją sam, z pomiaru:
mediana czasów **ostatnich 10 udanych runów joba < 60 s = zadanie krótkie**, inaczej długie;
job bez historii udanych runów jest traktowany jak długi. To **nie zależy od `job_type`** —
`script` bywa najdłuższym jobem w systemie, a `claude` kilkunastosekundowym. Zadania długie
nie zajmują ostatniego wolnego slotu (jest rezerwą dla krótkich), więc job o kadencji minutowej
nie czeka za kwadransowym. Nie ma pola, którym da się to nadpisać — jeśli user chce, żeby coś
ruszało natychmiast, prawdziwą dźwignią jest podniesienie `max_concurrent`
(`PUT /api/settings/concurrency`) albo rozstrzelenie harmonogramów.

**Wyłączność.** Nigdy nie biegną równolegle: dwa runy tego samego joba, dwa joby o tym samym
`skill_name`, dwa joby o tym samym `command`, oraz dwa joby z tą samą niepustą `lock_group`.
Konflikt nie jest błędem — run czeka w kolejce i rusza, gdy blokada zniknie (FIFO).

**Kiedy nadać `lock_group`:** gdy dwa joby **piszą po tym samym pliku/artefakcie**, a każdy
przepisuje go w całości — równoległy zapis cicho gubi jedną z wersji. Nazwą grupy jest
współdzielony artefakt, np. `dashboard` dla jobów przepisujących `Zadania/Dashboard.md`
(job „Team OS — inbox sync" ma tę grupę z seedu; job `/daily` piszący ten sam banner powinien
dostać `{"lock_group":"dashboard"}`). **Nie** nadawaj grup typu `vault` czy `wszystko` —
to przywraca dawny globalny slot i kasuje sens równoległości.

**Kill przy kilku runach.** `POST /api/runs/current/kill` zwraca **409** z treścią
`{ "error": ..., "current_runs": [...] }`, gdy aktywnych runów jest więcej niż jeden — serwer
świadomie nie zgaduje, który ubić. Wtedy wybierz run z `current_runs` (pole `id`) i wołaj
`POST /api/runs/<id>/kill`. Przy zerze aktywnych runów wraca `{ "killed": false }` (200).

## Czytanie logów i diagnoza failu

Run ma pola: `status`, `trigger_type` (`scheduled`/`manual`/`webhook`/`wake`/`retry`),
`started_at`, `finished_at`, `exit_code`, `stdout`, `stderr`, `error_msg`.

Statusy: `queued` → `running` → `success` | `failed` | `timeout` | `killed`.

Biegnące runy (`current_runs`, `/api/runs/current`) niosą **same metadane** — logu i tak
jeszcze nie ma w bazie, bo executor zapisuje `stdout`/`stderr` dopiero przy finalizacji.
Log czytasz z `GET /api/runs?job_id=<ID>` albo `GET /api/runs/<ID_RUNU>` po zakończeniu runu.

- `stdout` (typ `claude`) to **stream-json**: jedna linia = jeden obiekt JSON.
  Końcowa odpowiedź agenta jest w linii z `"type":"result"` (pole `result`).
- Przy failu patrz na `error_msg` (np. timeout, brak skilla) i `stderr`.
- Diagnoza „dlaczego job padł": pobierz ostatnie runy joba
  `GET /api/runs?job_id=<ID>&limit=5`, znajdź run ze statusem ≠ `success`,
  przeczytaj `error_msg`/`stderr`, a z `stdout` wyciągnij linię `type:"result"`.

## Przykłady curl

```bash
# Lista jobów
curl -s http://localhost:7777/api/jobs

# Nowy job: skill co poniedziałek 8:00, timeout 20 min
curl -s -X POST http://localhost:7777/api/jobs \
  -H 'Content-Type: application/json' \
  -d '{"name":"Reflect tygodniowy","skill_name":"reflect","arguments":"weekly","cron_expr":"0 8 * * 1","timeout_ms":1200000}'

# Nowy job: goły prompt bez skilla, codziennie 6:30
curl -s -X POST http://localhost:7777/api/jobs \
  -H 'Content-Type: application/json' \
  -d '{"name":"Poranny brief","arguments":"Przygotuj brief dnia z moich notatek","cron_expr":"30 6 * * *"}'

# Zmiana harmonogramu istniejącego joba
curl -s -X PUT http://localhost:7777/api/jobs/3 \
  -H 'Content-Type: application/json' \
  -d '{"cron_expr":"0 9 * * 5"}'

# Uruchom teraz / wyłącz / usuń
curl -s -X POST http://localhost:7777/api/jobs/3/trigger
curl -s -X POST http://localhost:7777/api/jobs/3/toggle
curl -s -X DELETE http://localhost:7777/api/jobs/3

# Ostatnie runy joba (diagnoza) i bieżący run
curl -s 'http://localhost:7777/api/runs?job_id=3&limit=5'
curl -s http://localhost:7777/api/runs/current

# Co biegnie TERAZ (tablica) i ubicie konkretnego runu; 409 z current_runs = wybierz id
curl -s http://localhost:7777/api/status
curl -s -X POST http://localhost:7777/api/runs/current/kill
curl -s -X POST http://localhost:7777/api/runs/128/kill

# Limit równoległych runów tej maszyny (1–10)
curl -s http://localhost:7777/api/settings/concurrency
curl -s -X PUT http://localhost:7777/api/settings/concurrency \
  -H 'Content-Type: application/json' -d '{"max_concurrent":4}'

# Wyłączność na współdzielonym pliku: /daily pisze ten sam banner co inbox sync
curl -s -X PUT http://localhost:7777/api/jobs/7 \
  -H 'Content-Type: application/json' -d '{"lock_group":"dashboard"}'

# Wynik agenta z ostatniego runu (linia type:"result" ze stream-json)
curl -s 'http://localhost:7777/api/runs?job_id=3&limit=1' \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const r=JSON.parse(d)[0];for(const l of (r.stdout||"").split("\n")){try{const e=JSON.parse(l);if(e.type==="result"){console.log(e.result);break}}catch{}}})'

# Te same operacje na instancji VPS (proxy)
curl -s http://localhost:7777/api/vps/jobs
```

## Szablony startowe

Gotowe definicje typowych jobów (memory update, reflect, skill scout) są w repo
Pulsa: `templates/starter-jobs.json` (instalacja domyślnie w `~/claude-cron`).
Użyj ich jako wzorca pól przy tworzeniu podobnych zadań.
