# Concepts — słownik domenowy Puls

Glosariusz pojęć o znaczeniu specyficznym dla tego projektu (encje, nazwane procesy, statusy).
Jedno hasło = zwięzła definicja + opcjonalny link do CLAUDE.md/docs. Tylko słownik, nie spec.
Narasta przez /dev-compound, porządkowany przez /dev-compound-refresh.

## Asystent auto-reply

Job Team OS, w którym agent odpowiada na wiadomość `query` z wiedzy vaulta, **zanim zrobi to człowiek**.
Spawn jest tylko-do-odczytu (`Read,Glob,Grep`, `cwd` = vault) i to `cwd` jest granicą bezpieczeństwa —
prompt zawiera niezaufaną treść cudzej wiadomości. → [CLAUDE.md § Team OS — Skrzynka](../CLAUDE.md)

## Hub

Instancja Pulsa na VPS-ie admina — **jedyny proces piszący** do bazy skrzynki (`data/inbox.db`).
Wszyscy klienci gadają z nim przez `/inbox/v1/:token/*`, nigdy z bazą bezpośrednio.
→ [CLAUDE.md § Team OS — Skrzynka](../CLAUDE.md)

## Job

Definicja zadania w schedulerze (skill/prompt + harmonogram cron + flagi). Sam się nie wykonuje —
każde wykonanie to osobny **run**. → [CLAUDE.md § Architektura backendu](../CLAUDE.md)

## Job-teczka

Job istniejący wyłącznie po to, by wykonania spoza schedulera (np. każde `/ask`) miały gdzie zapisać
run i skąd wziąć flagi powiadomień. Tworzony get-or-create po `name` i **nigdy nie nadpisujący ustawień
usera**. → [CLAUDE.md § `ask.js`](../CLAUDE.md)

## Kod zaproszenia

Jedyna rzecz, jaką dostaje nowy członek zespołu: `puls-inbox:<funnel-url>#<token>` — adres huba i token
tożsamości w jednym stringu. Zastępuje connection stringi i konfigurację Tailscale po stronie członka.
→ [CLAUDE.md § Team OS — Skrzynka](../CLAUDE.md)

## NO_ANSWER

Kontrakt wyjścia asystenta auto-reply: to słowo **gdziekolwiek** w odpowiedzi agenta znaczy „nie wiem",
a wiadomość wraca do człowieka zamiast dostać automatyczną odpowiedź.
→ [CLAUDE.md § Team OS — Skrzynka](../CLAUDE.md)

## Puls

Nazwa produktu. Identyfikatory techniczne (`package.json`, `data/claude-cron.db`, `CLAUDE_CRON_*`,
label launchd) świadomie zostają przy starej nazwie `claude-cron` — zmiana psuje istniejące instalacje.
→ [CLAUDE.md § Czym jest projekt](../CLAUDE.md)

## Rola maszyny (`inbox_role`)

Flaga w `state` (`client` | `agent`, brak flagi = `client`) rozstrzygająca, które joby skrzynki seeduje
dana instalacja: `client` = sync vaulta (maszyna człowieka), `agent` = auto-reply (maszyna 24/7).
Ustawiana **wyłącznie przez instalatory**, nigdy backfillowana w `migrate()`; zmiana roli **nie wyłącza**
joba z poprzedniej roli. → [CLAUDE.md § Team OS — Skrzynka](../CLAUDE.md)

## Routine (`routine=1`)

Job o wysokiej kadencji (np. sync co minutę). Kontrintuicyjne: włączona flaga kanału powiadomień na
jobie routine znaczy „**alarmuj o failach**", nie „raportuj sukcesy" — sukcesy są tłumione, a udane runy
kasowane po 24 h. → [CLAUDE.md § Powiadomienia](../CLAUDE.md)

## Run

Pojedyncze wykonanie joba (wiersz w `runs`) z własnym statusem i outputem. Status `killed` obejmuje też
runy **osierocone** przez restart serwera — inaczej kill-bar w UI wisiałby w nieskończoność.
→ [CLAUDE.md § Architektura backendu](../CLAUDE.md)

## Script-job (`job_type: 'script'`)

Job odpalający `node <command>` **bez CLI Claude** — tak działają klienci skrzynki. Dziedziczy env
daemona, więc mutacja `process.env` przy starcie zamroziłaby jego konfigurację.
→ [CLAUDE.md § `executor.js`](../CLAUDE.md)

## Skrzynka

Podsystem wymiany wiadomości w zespole (typy `task`/`query`/`reply`/`close`, statusy
`pending`/`delivered`/`done`) z UI w pliku `Skrzynka.md` w vaultcie Obsidiana — nie w dashboardzie Pulsa.
→ [CLAUDE.md § Team OS — Skrzynka](../CLAUDE.md)

## Wake

Trigger runu dla joba przegapionego podczas downtime'u maszyny (sen Maca, restart). Kolejkowany po
starcie na podstawie heartbeatu `last_active_at`, tylko dla jobów z `run_on_wake=1`.
→ [CLAUDE.md § `scheduler.js`](../CLAUDE.md)
