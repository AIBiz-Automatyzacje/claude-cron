# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Czym jest projekt

**Puls** — scheduler agentów AI (Claude Code). User ustawia joby (skill/prompt + harmonogram cron), a serwer w tle odpala CLI `claude` o wybranej porze, zbiera output i pokazuje historię w retro-arcade dashboardzie na `localhost:7777`. Działa lokalnie (macOS/Windows) oraz 24/7 na VPS (Linux), spięte przez Tailscale.

> **Nazwa produktu to Puls, ale identyfikatory techniczne wciąż używają starej nazwy `claude-cron`** — nie zmieniaj ich pochopnie: nazwa w `package.json`, plik bazy `data/claude-cron.db`, label launchd `com.claude-cron.scheduler`, task Windows `ClaudeCron`, zmienne środowiskowe `CLAUDE_CRON_*`, ścieżka instalacji `~/claude-cron`. Zmiana którejkolwiek psuje istniejące instalacje. "Puls" to warstwa prezentacji (README, UI, logi startowe).

## Komendy

```bash
npm start                 # uruchom serwer (node --disable-warning=ExperimentalWarning server.js)
npm test                  # wszystkie testy (node:test, wbudowany runner — zero zależności testowych)
node --test lib/db.test.js         # pojedynczy plik testowy
node --test setup.test.mjs         # testy setupu (ESM)
```

Nie ma buildu, bundlera, lintera ani typecheckera. Backend to czysty CommonJS, frontend to vanilla JS ładowany bezpośrednio przez `<script>` (patrz `public/index.html`). Testy używają wyłącznie wbudowanego `node:test` + `node:assert`.

Instalatory (odpalane przez usera, nie w dev-loopie): `install.sh` (macOS), `install.ps1` (Windows), `scripts/install-vps.sh` (Linux/VPS — komponentowy, Obsidian+Puls+Tailscale, flagi `--only-puls`/`--reset`, guard lib-only `CLAUDE_CRON_LIB_ONLY`). Ich testy: `install.test.sh`, `install.ps1.Tests.ps1` (Pester), `scripts/install-vps.test.sh`, `setup.test.mjs`.

## Runtime — twarde wymaganie Node

Aplikacja stoi na wbudowanym `node:sqlite` (klasa `DatabaseSync`), stabilnym bez flagi dopiero od **Node 22.13**. `engines` wymusza `>=22.13 <25`.

- `lib/runtime-guard.js` **MUSI być pierwszym `require` w `server.js`** — robi fail-fast z czytelnym komunikatem PRZED jakimkolwiek top-level `require('node:sqlite')` (który na starym Node rzuca nieczytelnym błędem).
- Po migracji `db.assertDbReturnsNumbers()` robi smoke-test: niektóre buildy zwracają `COUNT(*)`/`SUM(...)` jako BigInt zamiast number — wtedy arytmetyka i `JSON.stringify` cicho się psują. Fail-fast zamiast cichej korupcji.
- Instalatory pobierają **przenośny Node 22.17.0** do `.node/` (weryfikacja SHA256) — nie dotykają systemowego Node ani PATH. Wersja pinowana w `setup.mjs` (`NODE_VERSION`) musi być spójna z `install.sh`/`install.ps1`.

## Architektura backendu (`lib/`)

Przepływ joba: **cron/webhook/manual → kolejka runów w DB → executor (jeden na raz) → aktualizacja runu → opcjonalnie Discord.**

- **`config.js`** — jedyne źródło stałych i env-varów (`CLAUDE_CRON_PORT` 7777, `CLAUDE_CRON_VPS_URL`, `CLAUDE_CRON_WORKSPACE`, `DISCORD_WEBHOOK_URL`, `WEBHOOK_*`). `MIN/MAX_NODE_VERSION` żyją tu, żeby `runtime-guard` nie ciągnął `node:sqlite`.
- **`db.js`** — cała warstwa SQLite. `getDb()` leniwie otwiera połączenie i woła `migrate()` przy **każdym** starcie. Schemat: `jobs`, `runs`, `state` (key-value). Migracje przez `ALTER TABLE ... ` w try/catch (idempotentne). **Backfill danych owinięty sentinelem w `state`** (np. `wake_backfill_done`), bo `migrate()` leci co boot — gołe `UPDATE` clobberowałoby świadome opt-outy usera.
- **`scheduler.js`** — `croner` planuje joby w **lokalnej strefie** (`Intl...timeZone`). Kolejka jest serializowana (`processQueue`, jeden run na raz — `executor.isRunning()`). Retry po failu przez `max_retries`. **Missed-job detection**: heartbeat zapisuje `last_active_at` co 60 s; po restarcie `computeMissedJobs()` (czysta, testowalna) sprawdza, które joby z `run_on_wake=1` przegapiono podczas downtime'u i kolejkuje je jako `wake`. Strefa w `computeMissedJobs` MUSI być ta sama co w `scheduleJob`. **Retention**: co godzinę kasuje udane runy jobów `routine=1` starsze niż 24 h (fail/timeout/killed zostają na zawsze).
- **`executor.js`** — spawn CLI `claude --dangerously-skip-permissions --output-format stream-json -p <prompt>`. Prompt = `/skill` + `arguments` + `webhook_payload`. Czyści env `CLAUDE_CODE*`/`CLAUDECODE`, żeby spawnowany CLI nie myślał, że jest zagnieżdżony. Trzy warstwy timeoutów: total, idle (reset na każdym chunku stdout), watchdog wall-clock (przeżywa sen Maca). macOS: `caffeinate` blokuje idle-sleep na czas runu. Windows: `taskkill /T /F` (drzewo procesów). Drugi tryb: **`job_type: 'script'`** — odpala `node <command>` bez CLI Claude.
- **`platform.js`** — autostart per-OS: macOS = plist launchd, Windows = Task Scheduler (`schtasks`). Zwraca `getStatus()` dla dashboardu.
- **`skills.js`** — skanuje `SKILL.md` (frontmatter przez `gray-matter`) z trzech źródeł z priorytetem **project > user > plugin**: workspace `.claude/skills`, `~/.claude/skills`, oraz pluginy z `~/.claude/plugins/installed_plugins.json`.
- **`webhook.js`** / **`discord.js`** — matching tokenu z URL `/webhook/:token`; powiadomienia Discord parsują `type:'result'` ze stream-json i dzielą na chunki ≤2000 znaków.

## `server.js` — HTTP i granice bezpieczeństwa

Ręczny router na czystym `node:http` (bez frameworka), match po `segments`/`method`. Serwuje `public/` (SPA fallback, ETag/no-cache dla kodu, 1 h cache dla logo/favicon). Dwie kluczowe reguły:

- **Proxy `/api/vps/*` → instancja VPS** — dashboard lokalny przełącza widok między `local` a `vps` bez osobnego portu.
- **Blokada zewnętrzna**: request z nagłówkiem `X-Forwarded-For` (czyli przez Tailscale Funnel) dostaje 403 na wszystkim poza `/webhook/*`. Dashboard jest dostępny **tylko** przez Tailscale (prywatnie); publiczny jest wyłącznie endpoint webhooków.
- Przy starcie `reapOrphanedRuns()` oznacza osierocone runy `running` (po crashu/restarcie) jako `killed` — inaczej kill-bar w UI wisiałby w nieskończoność.

## Frontend (`public/`)

Vanilla JS, zero frameworka i buildu. `app.js` (duży, stanowy) + wydzielone czyste helpery `enum-map.js` i `render-helpers.js` (jedyne z testami — logika kalendarza, sparkline, podpisy poll). Polling co 3 s z guardem: liczy tani podpis payloadu i pomija `innerHTML`, gdy nic się nie zmieniło. Timeouty w UI są w minutach, w bazie/executorze w ms (`msToMin`/`minToMs`).

## Konwencje projektu

- **Testy: `node:test` kolokowane obok źródła** (`lib/db.test.js` przy `lib/db.js`). Wstrzykiwanie zależności dla testowalności: `db.setDbPath(':memory:')`, czyste funkcje z argumentami zamiast globali (`computeMissedJobs`, `isNodeSupported`, helpery `setup.mjs`). I/O to cienka skorupa w `main()`.
- **Komentarze po polsku, wyjaśniają NIE-oczywiste decyzje** (dlaczego localtime, dlaczego sentinel backfillu, dlaczego strefa musi być spójna) — utrzymuj ten styl, nie opisuj oczywistości.
- Obowiązują reguły z `.claude/rules/coding-rules.md` i `.claude/rules/learned-patterns.md` (wnioski z `docs/solutions/` — czytaj przed pracą w udokumentowanym obszarze).
- Praca nad zadaniami: `docs/active/` (w toku), `docs/plans/`, `docs/completed/`, `docs/solutions/` (baza wiedzy). Workflow przez skille `/dev-docs*` i `/dev-compound`.

## Pułapki (udokumentowane w `docs/solutions/`)

- **SQLite granica doby w `localtime`**: porównania "dziś" rób `date(col,'localtime') = date('now','localtime')` — goły `date('now')` liczy w UTC i przesuwa dobę o offset strefy.
- **Top-N per grupa = window function**: N ostatnich runów per job przez `ROW_NUMBER() OVER (PARTITION BY job_id ...)`, nie globalny `LIMIT` (jedna szybka grupa zjadłaby całe okno).
- **Instalator `curl|bash` / `irm|iex`**: stdin to pipe z treścią skryptu, nie klawiatura — interaktywne `read` dostaje EOF. Handoff do interaktywnego procesu przez `/dev/tty` (Unix) / `CONIN$` (Windows). Testuj ZAWSZE przez prawdziwy pipe, nie lokalne `bash install.sh`.
- **Entry-point guard w Node**: porównuj przez `fs.realpathSync` po obu stronach — macOS symlinkuje `/var`,`/tmp` do `/private/*`. Skrypt `.ps1` puszczany przez `iex` trzymaj w czystym ASCII (BOM/diakrytyki łamią parser PS 5.1).
