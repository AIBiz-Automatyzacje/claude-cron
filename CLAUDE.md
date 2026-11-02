# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Czym jest projekt

**Puls** — scheduler agentów AI (Claude Code). User ustawia joby (skill/prompt + harmonogram cron), a serwer w tle odpala CLI `claude` o wybranej porze, zbiera output i pokazuje historię w retro-arcade dashboardzie na `localhost:7777`. Działa lokalnie (macOS/Windows) oraz 24/7 na VPS (Linux), spięte przez Tailscale.

> **Identyfikatory techniczne używają starej nazwy `claude-cron` — nie zmieniaj ich**: nazwa w `package.json`, plik bazy `data/claude-cron.db`, label launchd `com.claude-cron.scheduler`, task Windows `ClaudeCron`, zmienne środowiskowe `CLAUDE_CRON_*`, ścieżka instalacji `~/claude-cron`. "Puls" to warstwa prezentacji (README, UI, logi startowe).

## Komendy

```bash
npm start                 # uruchom serwer (node --disable-warning=ExperimentalWarning server.js)
npm test                  # wszystkie testy (node:test, wbudowany runner — zero zależności testowych)
node --test lib/db.test.js         # pojedynczy plik testowy
node --test setup.test.mjs         # testy setupu (ESM)
node --test scripts/inbox/inbox-pull.test.mjs   # testy skryptów Team OS inbox (ESM)
```

Nie ma buildu, bundlera, lintera ani typecheckera. Backend to czysty CommonJS, frontend to vanilla JS ładowany bezpośrednio przez `<script>` (patrz `public/index.html`). Testy używają wyłącznie wbudowanego `node:test` + `node:assert`.

Instalatory (odpalane przez usera, nie w dev-loopie): `install.sh` (macOS), `install.ps1` (Windows), `scripts/install-vps.sh` (Linux/VPS), setup lokalny `setup.mjs`. Ich testy: `install.test.sh`, `install.ps1.Tests.ps1` (na macOS: `pwsh -NoProfile -File install.ps1.Tests.ps1`), `scripts/install-vps.test.sh`, `setup.test.mjs`. Szczegóły instalatorów i setupu: [docs/architektura/instalacja-i-setup.md](docs/architektura/instalacja-i-setup.md).

## Runtime — twarde wymaganie Node

Aplikacja stoi na wbudowanym `node:sqlite` (klasa `DatabaseSync`). `engines` wymusza `>=22.13 <25`.

- `lib/runtime-guard.js` **MUSI być pierwszym `require` w `server.js`** — fail-fast PRZED jakimkolwiek top-level `require('node:sqlite')`.
- Po migracji `db.assertDbReturnsNumbers()` robi smoke-test typów agregatów (BigInt zamiast number = fail-fast).
- Instalatory pobierają **przenośny Node 22.17.0** do `.node/` (weryfikacja SHA256) — nie dotykają systemowego Node ani PATH. `NODE_VERSION` w `setup.mjs` musi być spójny z `install.sh`/`install.ps1`.
- Po postawieniu portable Node, PRZED handoffem do `setup.mjs`, bootstrap odpala `npm install --omit=dev` **npm-em z portable Node** (`ensure_dependencies`/`Install-Dependencies`), z portable Node na czele PATH; deterministycznie przez `package-lock.json`.

## Architektura w skrócie

Przepływ joba: **cron/webhook/manual → kolejka runów w DB → picker (do `max_concurrent` runów równolegle) → executor → aktualizacja runu → opcjonalnie powiadomienia (Discord/Telegram).**

- `lib/config.js` — jedyne źródło stałych i env-varów; `lib/db.js` — warstwa SQLite (`jobs`, `runs`, `state`), `migrate()` przy każdym starcie.
- `lib/scheduler.js` (croner + równoległa kolejka), `lib/executor.js` + `lib/claude-spawn.js` (spawn CLI `claude` albo `node <command>` dla `job_type: 'script'`), `lib/ask.js` (asystent głosowy), powiadomienia (`discord.js`, `telegram.js`, `notify-*.js`), `lib/updater.js`, seedy przy starcie (`starter-jobs.js`, `inbox-seed.js`).
- Szczegóły warstw `lib/`: [docs/architektura/backend-lib.md](docs/architektura/backend-lib.md)
- Team OS — Skrzynka (hub `lib/inbox-*.js` + klienci `scripts/inbox/`): [docs/architektura/team-os-skrzynka.md](docs/architektura/team-os-skrzynka.md)
- Frontend (`public/`): [docs/architektura/frontend.md](docs/architektura/frontend.md)

## `server.js` — HTTP i granice bezpieczeństwa

Ręczny router na czystym `node:http`, match po `segments`/`method`. Serwuje `public/` (SPA fallback, ETag/no-cache dla kodu, 1 h cache dla logo/favicon). Pełna wersja z uzasadnieniami: [docs/architektura/server-http.md](docs/architektura/server-http.md).

- **Proxy `/api/vps/*` → instancja VPS** (dashboard przełącza widok `local`/`vps` bez osobnego portu).
- **Blokada zewnętrzna**: request z `X-Forwarded-For` (Tailscale Funnel) dostaje 403 na wszystkim poza `/webhook/*`, `/ask/*` i `/inbox/v1/*`. Dashboard jest dostępny **tylko** przez Tailscale.
- **Kolejność matcherów (kontrakt): webhook → ask → inbox → guard XFF → api/static.** Publiczne endpointy przed guardem, guard przed api/static.
- **`POST /ask/:token`**: opt-in `ASK_ENABLED=1` (bez niego 403); token z URL + nagłówek `X-Secret`, oba porównania `timingSafeEqual` zawsze. Kody błędów tylko dla intruzów (403/405/413 bez szczegółów); wszystko „dla człowieka” = 200 text/plain. Body (czytane PRZED autoryzacją) przez `readTextBody` z capem 64 KB.
- **Inbox**: `/inbox/v1/:token/*` (ping/pull/done/send/claim-query) jest publiczny. `/api/inbox/members` (GET/POST/DELETE) jest prywatny: za guardem XFF **i** za guardem cross-origin `isCrossOriginRequest` (`Origin ≠ Host` na mutujących → 403). POST zwraca pełny token jednorazowo (GET zawsze maskuje); brak `WEBHOOK_BASE_URL` = 503 PRZED utworzeniem członka.
- **Settings powiadomień**: `GET/PUT /api/settings/notifications` — GET zawsze zamaskowany; PUT whitelist 3 kluczy state, tylko stringi, pusty string czyści klucz (fallback env wraca). `POST /api/settings/notifications/push-to-vps` — push robi serwer z własnego state/env, dashboard nigdy nie operuje pełnymi sekretami; 503 brak VPS, 400 nic do wysłania, 502 pad pusha.
- **`GET/POST /api/update`** (`lib/updater.js`): za guardem XFF; POST dodatkowo za guardem cross-origin `handleApi` i serwerową flagą „aktualizacja już trwa” (409).
- Przy starcie `reapOrphanedRuns()` oznacza osierocone runy `running` jako `killed`.

## Konwencje projektu

- **Testy: `node:test` kolokowane obok źródła** (`lib/db.test.js` przy `lib/db.js`). Wstrzykiwanie zależności dla testowalności: `db.setDbPath(':memory:')`, czyste funkcje z argumentami zamiast globali (`computeMissedJobs`, `isNodeSupported`, helpery `setup.mjs`). I/O to cienka skorupa w `main()`. Testy HTTP na żywym procesie: `CLAUDE_CRON_DB_PATH` (ścieżka bazy), `CLAUDE_CRON_CLAUDE_BIN` (atrapa CLI).
- **Komentarze po polsku, wyjaśniają NIE-oczywiste decyzje** — nie opisuj oczywistości.
- Obowiązują reguły z `.claude/rules/coding-rules.md` i indeks wiedzy [docs/learned-patterns.md](docs/learned-patterns.md) (czytaj przed pracą w udokumentowanym obszarze).
- Praca nad zadaniami: `docs/active/` (w toku), `docs/plans/`, `docs/completed/`, `docs/solutions/` (baza wiedzy). Workflow przez skille `/dev-docs*` i `/dev-compound`.

## Pułapki

Pułapki i reguły z rozwiązanych problemów: [docs/learned-patterns.md](docs/learned-patterns.md) — indeks generowany z `docs/solutions/` (`node .claude/scripts/wiedza/wiedza.mjs indeks --zapisz`), nie edytuj ręcznie.
