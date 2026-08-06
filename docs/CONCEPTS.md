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
Rozpoznanie (`is_inbox_hub`): własny Funnel **oraz** `INBOX_HUB_URL` wskazujący na siebie albo
istniejący członkowie — sam Funnel NIE wystarcza, bo zwykły członek też go miewa dla webhooków.
→ [CLAUDE.md § Team OS — Skrzynka](../CLAUDE.md)

## Job

Definicja zadania w schedulerze (skill/prompt + harmonogram cron + flagi). Sam się nie wykonuje —
każde wykonanie to osobny **run**. → [CLAUDE.md § Architektura backendu](../CLAUDE.md)

## Job-teczka

Job istniejący wyłącznie po to, by wykonania spoza schedulera (np. każde `/ask`) miały gdzie zapisać
run i skąd wziąć flagi powiadomień. Tworzony get-or-create po `name` i **nigdy nie nadpisujący ustawień
usera**. → [CLAUDE.md § `ask.js`](../CLAUDE.md)

## Karencja po wybudzeniu

45 s, o które pętla kolejki wstrzymuje **start** runów po wykryciu powrotu maszyny do życia (sen Maca
albo restart po reboocie) — sieć, DNS i Tailscale wstają wolniej niż scheduler. Kontrintuicyjne:
obejmuje **wszystkie** joby, nie tylko `run_on_wake`, i nie dotyka retry. Przy żyjącym procesie
wybudzenie rozpoznaje luka wall-clock między tyknięciami heartbeatu trzymanymi **w pamięci**, nie
`last_active_at` z bazy (heartbeat nadpisuje ten znacznik zaległym tyknięciem tuż po pobudce);
`last_active_at` służy wyłącznie do wykrycia downtime'u przy starcie, zanim heartbeat ruszy. Próg
luki to okres heartbeatu + definicja snu (120 s) — próg równy okresowi brałby każde tyknięcie za
wybudzenie. → [CLAUDE.md § `scheduler.js`](../CLAUDE.md)

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

## Slot rezerwowy

Ostatni z `max_concurrent` slotów współbieżności, na który **nie wchodzi zadanie długie** (budżet
długich = `max(1, limit-1)`). Nie jest to slot „dla ważnych jobów", tylko gwarancja, że run krótki
(inbox sync co minutę) nie czeka za kwadransowym. Przy limicie 1 rezerwy nie ma z czego zrobić.
→ [CLAUDE.md § `scheduler.js`](../CLAUDE.md)

## Stan aktualizacji

Czterowartościowy, **rozłączny** kontrakt panelu aktualizacji: `current` / `available` /
`unknown` (nie znam rewizji lokalnej — instalacja bez `data/version.json`) / `check_failed`
(pad API GitHuba). Kontrintuicyjne: „nie wiem" i „nie udało się sprawdzić" **nie mogą** zwijać się
do „masz aktualne" — fałszywa zieleń uczy usera, że sygnał kłamie. Wersję lokalną czytamy z
`data/version.json`, nie z gita (instalacja zipowa nie ma repozytorium).
→ [CLAUDE.md § Architektura backendu](../CLAUDE.md)

## Wake

Trigger runu dla joba przegapionego podczas downtime'u maszyny (sen Maca, restart). Kolejkowany po
starcie na podstawie heartbeatu `last_active_at`, tylko dla jobów z `run_on_wake=1`.
→ [CLAUDE.md § `scheduler.js`](../CLAUDE.md)

## Zadanie krótkie / długie

Klasyfikacja joba na potrzeby pickera kolejki, wyliczana **z pomiaru, nie z deklaracji**: mediana
czasów ostatnich 10 **udanych** runów < 60 s = krótkie, inaczej długie; brak historii = długie
(fail-safe). Kontrintuicyjne: **nie ma nic wspólnego z `job_type`** — najdłuższy job systemu (747 s)
to `script`, a 18-sekundowy to `claude`. Mediana, nie średnia: pojedynczy run przespany przez
maszynę (975 s) wrzuciłby najlżejszy job systemu do długich.
→ [CLAUDE.md § `scheduler.js`](../CLAUDE.md)
