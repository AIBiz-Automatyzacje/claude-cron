# Migracja claude-cron → Puls (rebrand + nowy front)

> Plan wdrożenia. Demo (klikalny prototyp UI) jest gotowe i zaakceptowane — to wzorzec 1:1 dla nowego frontu. Ten dokument opisuje **wszystkie zmiany do naniesienia w tym repo**. Zero zmian wprowadzonych — to jest instrukcja wykonawcza.

**Repo:** `~/Documents/Kodowanie/claude-cron`
**Demo (źródło UI):** `~/Documents/Kodowanie/puls-demo/` (`index.html` + `style.css` + `app.js`, render z mocka)
**Figma (wzorzec):** https://www.figma.com/design/LHNwwdO9B0o9Sn82nNrn3W — strona „Puls — F (produkcja)" (`47:2`)
**Handoff projektu:** `Zadania/projekty/personal-team-os/_wznow-claude-cron-rebrand.md` w vaultcie (10 punktów logiki)

Złota zasada: **front (HTML/CSS/render) bierzemy z dema, logikę (fetch API, cron, webhook, polling) zachowujemy z obecnego `app.js`.** Demo renderuje z mocka — produkcja renderuje z `/api/*`. Markup i style identyczne, źródło danych inne.

> **Aktualizacja po roaście planu (2026-06-22):** backend NIE jest już w całości nietykany. Dochodzą **dwa** kontrolowane dodatki: (1) nowy endpoint `GET /api/runs/recent?per_job=N` (window function — patrz 4.2), (2) wzbogacony `/api/status` o `today_success/today_failed/next` (patrz 4.1). Reszta backendu (routing, executor, scheduler, SPA fallback) pozostaje nietknięta. Mapowania enumów: patrz **nowa sekcja 4.0** (zastępuje „DO WERYFIKACJI" 4.5/4.6 — oba okazały się błędne). ⚠️ `CREATE TABLE` w `lib/db.js:22-49` jest przestarzały (schema drift — brak `routine`, `webhook_token`, `job_type`, `command`, `idle_timeout_ms`, dodane migracjami) — mapowanie danych wyprowadzaj z realnych wierszy/PRAGMA, NIE z definicji tabeli.

---

## ⚠️ SEKCJA 0 — Czego NIE ruszać (inaczej psujesz działające instalacje)

Nazwa „claude-cron" żyje w dwóch warstwach. **Zmieniamy tylko widoczną. Techniczne ID zostają** — to osobna migracja z planem (rename DB + przełączenie serwisów + env), nie część tego rebrandu.

| Identyfikator | Plik | Co się stanie przy zmianie |
|---|---|---|
| `DB_PATH = data/claude-cron.db` | `lib/config.js:10` | Serwer startuje z **pustą bazą** — wszystkie joby i historia znikają z widoku (plik istnieje, kod go nie szuka) |
| `PLIST_LABEL = com.claude-cron.scheduler` | `lib/platform.js:6`, `scripts/install-macos.sh:4`, `scripts/uninstall-macos.sh:4` | Stary daemon zostaje, nowy install tworzy **drugi obok** → konflikt portu 7777 |
| `WIN_TASK_NAME = ClaudeCron` | `lib/platform.js:8` | jw. na Windows |
| `$SERVICE_NAME` (systemd) | `scripts/install-vps.sh` | jw. na VPS |
| env `CLAUDE_CRON_PORT/VPS_URL/WORKSPACE` | `lib/config.js:14,18,21` | Daemony Mac+CAVE+VPS mają je w plistach/systemd — zmiana nazwy = przestają być czytane |

➡️ **Te pozycje pomijamy w tym rebrandzie.** Jak kiedyś migrować technicznie: osobny skrypt, który zachowa DB (rename pliku + ścieżka), przełączy serwisy (uninstall stary → install nowy) i zmieni env w jednym przejściu, z restartem 3 daemonów.

---

## SEKCJA 1 — Rebrand widoczny (bezpieczny)

| # | Plik | Zmiana |
|---|---|---|
| 1.1 | `public/index.html:6` | `<title>CLAUDE-CRON 🕹️</title>` → `<title>Puls — Zadania dla Twojego Asystenta AI</title>` |
| 1.2 | `public/index.html:6` (head) | Dodać `<link rel="icon" type="image/png" href="/favicon.png">` |
| 1.3 | `public/index.html` header | `<h1>CLAUDE-CRON</h1>` + `scheduler skilli` → logo (img) + „Puls" + claim „Zadania dla Twojego Asystenta AI" (markup z dema) |
| 1.4 | `server.js:371-372` | Banner `🕹️  CLAUDE-CRON running...` → `🫀  Puls running at http://localhost:${PORT}` |
| 1.5 | `package.json:4` | `description` → np. `"Puls — scheduler agentów AI (Claude Code), AIBIZ"` (⚠️ pole `name` ZOSTAW „claude-cron" — patrz Sekcja 0) |
| 1.6 | `README.md` | Nagłówek + opis → Puls (kosmetyka, do zrobienia na końcu) |

**Assety do skopiowania z dema do `public/`:**
```
cp ~/Documents/Kodowanie/puls-demo/logo-puls.png  ~/Documents/Kodowanie/claude-cron/public/logo-puls.png
cp ~/Documents/Kodowanie/puls-demo/favicon.png    ~/Documents/Kodowanie/claude-cron/public/favicon.png
```
Fonty: demo używa Google Fonts (Outfit + Inter + JetBrains Mono) przez `<link>` — przenieść te same linki do `index.html`.

---

## SEKCJA 2 — Podmiana frontu (główna robota)

### 2.1 `public/style.css`
**Akcja:** zastąp w całości zawartością `puls-demo/style.css`. To kompletny design system AIBIZ Dark Impact (zmienne, tabela, kalendarz, log viewer, modal, skille, statbar). Zawiera już fixy z budowy dema:
- `.modal-overlay[hidden]{display:none}` — inaczej overlay z `display:flex` nadpisuje `hidden` i blokuje klik
- `.view{display:none}/.view.active{display:block}` — przełączanie sekcji
- `.switch{display:inline-block}` — inaczej width/height ignorowane na `<label>`
- `min-width:0` na komórkach grida + szersza kolumna ZADANIE — inaczej tag nachodzi na sąsiednią kolumnę
- `--mute:#7d7d7d` — WCAG AA (4.6:1), nie #6e6e6e

⚠️ Klasy w obecnym `app.js` (`.tab-panel`, `.badge-enabled`, `.kill-bar` itd.) znikną — dlatego `index.html` i `app.js` trzeba przepisać razem, nie pojedynczo.

### 2.2 `public/index.html`
**Akcja:** markup z `puls-demo/index.html` jako baza, ale **domerge'uj produkcyjne elementy, których demo nie ma** (patrz Sekcja 3). Szkielet docelowy:
- `<header class="header">` — logo + brand-text (Puls + claim) + env-toggle LOKALNY/VPS (pokazywać tylko gdy VPS skonfigurowany — jak obecnie `id="env-toggle" style="display:none"`)
- `<nav class="tabs">` — Zadania · Historia · Skille
- `<div class="statbar">` — Następne · Aktywne · Dziś+health · Kolejka · Uptime
- `<section class="view" id="view-zadania">` — toolbar (tytuł + toggle Lista/Kalendarz + Szukaj + „+ Nowe zadanie") + `#zadania-lista` + `#zadania-kalendarz`
- `<section class="view" id="view-historia">` — toolbar (checkbox „Ukryj rutynowe" + Odśwież) + `#historia-tabela`
- `<section class="view" id="view-skille">` — toolbar (toggle Kafelki/Lista + Odśwież) + filtry + `#skille-kafelki` + `#skille-lista`
- **modal** „Nowe zadanie" (segmented typ + pola warunkowe + akordeon) — DOMERGE z produkcyjnymi polami (idle_timeout, retries, wake/discord/routine, webhook) z obecnego modala
- **kill-bar** (zachować z obecnego — patrz 3.1)
- **toast-container** (zachować)
- `<script src="/app.js">`

> ⚠️ **KONTRAKT ID (nie wolny markup dema).** Zachowywana logika czyta DOM po sztywnych ID — nowy markup MUSI je odtworzyć 1:1, inaczej „zachowana logika" cicho pęka. `saveJob` czyta: `form-id, form-job-type, form-name, form-skill, form-command, form-args, form-timeout, form-idle-timeout, form-retries, form-wake, form-discord, form-routine`. Cron (`buildCronFromForm/parseCronToForm`) czyta: `form-freq, form-time, form-day, form-interval` (+ `time-group/day-group/interval-group/interval-label` do widoczności). Pozostałe ID kotwiczące logikę: `modal-title, webhook-section, skill-group, schedule-preview, stat-jobs, stat-queue, stat-uptime, kill-bar, kill-job-name, jobs-body, jobs-empty, runs-body, runs-empty, skills-grid, skills-empty, count-all/project/user/plugin, runs-hide-routine`.

### 2.3 `public/app.js`
**Akcja:** to NIE jest podmiana 1:1 demo→produkcja. Zachowaj logikę z obecnego pliku, podmień warstwę render. Co zostaje vs co przepisać:

**ZACHOWAĆ z obecnego `app.js` (logika — działa z API):**
- `API` helper + `apiBase()` + `switchEnv()` (VPS proxy)
- `loadStatus / loadJobs / loadRuns / loadSkills` (fetch)
- `saveJob / triggerJob / toggleJob / deleteJob / killCurrent`
- cron: `onFreqChange / buildCronFromForm / parseCronToForm / updateSchedulePreview / cronToHuman`
- webhook: `generateWebhook / removeWebhook / copyWebhookUrl / updateWebhookUI`
- `formatClaudeOutput / formatToolUse` (parsowanie stream-json do log viewera)
- helpery: `formatUptime / formatDateTime / formatCountdown / formatDuration / esc / truncate / toast / showPromptPopup`
- `poll()` (interwał 3s) + `init()` — ⚠️ **ZMODYFIKOWAĆ poll** (patrz niżej): guard zmian + zachowanie stanu rozwinięcia; statbar zawsze z `/api/status`, nie z tab-zależnych fetchy

**PRZEPISAĆ render (z mocka dema → z danych API):**
- `renderJobs()` → gęsta tabela z dema: ico+nazwa+tag-pill, HARMONOGRAM (`cronToHuman`), OSTATNI RUN (kropka+czas), 7 RUN (sparkline), NASTĘPNY (`formatDateTime`+`formatCountdown`), STATUS (switch z `enabled`), AKCJE (▶⏻✎✕)
- `renderRuns()` → tabela z dema + paleta 5 statusów + log viewer (akcje Kopiuj/Zawijaj/Pełny ekran, podświetlenie błędu, `formatClaudeOutput` w body)
- `renderSkills()` → toggle Kafelki/Lista + filtry + stopki „N zadań · ostatnio X"
- nowy `renderStatbar(status)` → Następne/Aktywne/Dziś+health/Kolejka/Uptime — **wyłącznie z wzbogaconego `/api/status`** (nie z `/api/runs` ani `/api/jobs`); statbar jest globalny, a te fetche są tab-zależne (patrz 4.1)
- nowy `renderKalendarz()` → patrz Sekcja 5
- modal: segmented typ **BINARNY Skill/Skrypt** steruje polami warunkowymi (Skill → `form-skill`+`form-args`; Skrypt → `form-command`). **Webhook NIE jest segmentem** — `job_type` ma tylko `claude`/`script`, webhook to ortogonalna zdolność (`webhook_token` na jobie dowolnego typu) → zostaje osobną sekcją `webhook-section`. Segment pisze wybór do **ukrytego `input#form-job-type`** (`claude`/`script`) → `saveJob` zostaje **bez zmian** (czyta `form-job-type.value`). „prompt" nie jest osobnym typem — to Skill bez wybranego skilla (pill liczony przy renderze)

**ZMODYFIKOWAĆ `poll()` (decyzja po roaście):**
- **guard zmian** — przed `body.innerHTML` porównaj tani podpis payloadu (np. `runs.length` + `runs[0].id` + statusy); jeśli bez zmian → **pomiń re-render** (brak migotania, log się nie zwija). Stosuj też do `renderJobs`.
- **zachowanie stanu rozwinięcia** — `const expandedRuns = new Set()`; rozwijanie add/delete `run.id`; po realnym re-renderze ponownie nałóż klasę `expanded` na wiersze z setu. Historia DALEJ pollowana co 3s (nie wyłączamy — inaczej dane stoją do ręcznego „Odśwież").
- **statbar** — `loadStatus` (pollowany 3s na KAŻDEJ zakładce) zasila cały statbar z wzbogaconego `/api/status`.

---

## SEKCJA 3 — Czego demo NIE pokrywa, a produkcja wymaga (NIE zgubić)

Demo to prototyp wizualny — te realne funkcje są w obecnym `app.js`/`index.html` i muszą przeżyć:

| # | Funkcja | Gdzie teraz | Co zrobić w nowym froncie |
|---|---|---|---|
| 3.1 | **Kill-bar** (pasek „DZIAŁA + ZATRZYMAJ" gdy job leci) | `index.html:117`, `app.js:loadStatus/killCurrent` | Zachować markup + podpiąć pod `status.current_run` |
| 3.2 | **Usuwanie joba** (✕ + confirm) | `app.js:deleteJob` | Demo ma tylko ▶⏻✎ — dodać 4. akcję ✕ |
| 3.3 | **Webhook w modalu** (generate/regenerate/remove/copy URL) | `index.html:221`, `app.js:generateWebhook...` | Wpiąć w wariant Webhook + sekcję zaawansowaną |
| 3.4 | **idle_timeout_ms / max_retries** | modal `form-idle-timeout`, `form-retries` | Do akordeonu „Opcje zaawansowane" (czytelnie: „30 min", w kodzie ms) |
| 3.5 | **run_on_wake / discord_notify / routine** (checkboxy) | modal | Do akordeonu „Opcje zaawansowane" |
| 3.6 | **Env toggle VPS** (proxy local/VPS) | `app.js:switchEnv`, `init` | Toggle LOKALNY/VPS w headerze — pokazać tylko gdy `vps_configured` |
| 3.7 | **Prompt popup** (długi prompt po kliknięciu) | `app.js:showPromptPopup` | Zachować dla skróconych promptów w tabeli |
| 3.8 | **formatClaudeOutput** (stream-json → czytelny log) | `app.js:647` | Użyć w log viewerze Historii (nie surowy stdout) |
| 3.9 | **Schedule preview** (podgląd „Codziennie o 09:00") | `app.js:updateSchedulePreview` | Zachować pod polami harmonogramu w modalu |
| 3.10 | **SPA fallback / X-Forwarded-For block** | `server.js` | Bez zmian. ⚠️ Reszta backendu też nietykana POZA dwoma dodatkami: `GET /api/runs/recent` (4.2) i wzbogacony `/api/status` (4.1) |

---

## SEKCJA 4 — Mapowanie danych: UI dema → API produkcji

### 4.0 ⭐ KANON ENUMÓW (źródło prawdy — zastępuje 4.5/4.6)

Demo renderowało z mocka, który używał **fikcyjnych, abstrakcyjnych kodów** (`puls-demo/app.js:57-59`: `ok/err/run/stop/timeout`) — NIE realnych wartości backendu. Poniższa tabela jest jedynym źródłem mapowań. Kody dema są abstrakcyjne, więc klasy CSS `badge-*` zostają — dochodzi tylko warstwa mapująca `realna_wartość → demo-kod`.

Zweryfikowane na `data/claude-cron.db` (1829 runów): status `success`=1405, `failed`=249, `timeout`=175; trigger `scheduled`=1805, `manual`=23, `webhook`=1; job_type `claude`=5, `script`=2; `retry`=0.

| Realna wartość (kod/baza) | Demo-kod / UI | Uwaga |
|---|---|---|
| status `success` | `ok` „Sukces" (badge-ok) | |
| status `failed` | `err` „Błąd" (badge-err) | **najczęstszy błąd — demo miało fikcyjne `error`** |
| status `timeout` | `timeout` (badge-timeout) | |
| status `killed` | `stop` „Zatrzymany" (badge-stop) | demo/plan miały `stopped` — nie istnieje |
| status `running` | `run` „Działa" (badge-run) | przejściowy |
| status `queued` | → `run` „W kolejce" (badge-run) | bez nowego badge'a (0 w historii, przejściowy) |
| trigger `scheduled` | Harmonogram | demo/plan miały `schedule`/`cron` |
| trigger `manual` | Ręcznie | |
| trigger `webhook` | Webhook | |
| trigger `retry` | → fallback Harmonogram | 0 w danych, nie projektuj osobno |
| **`job.routine=1`** | **pill „Rutynowe" (z `jobsMap`)** | **NIE trigger** — to flaga joba; `hide_routine` filtruje server-side (chowa tylko UDANE runy rutynowe, `db.js:172`) |
| `job_type='script'` | ikona `›_` + pill „skrypt" | źródło treści: kolumna `command` (NIE `arguments`) |
| `job_type='claude'` + `skill_name` | ikona `◷` + pill `/skill` | |
| `job_type='claude'` + puste `skill_name` | ikona `◷` + pill „prompt" | źródło: `arguments` (np. job #12) |

> `getRuns()` zwraca **tylko kolumny `runs`** (`SELECT r.*`) — ani `name`, ani `routine` joba. Pill „Rutynowe" ORAZ nazwa zadania w Historii wymagają `jobsMap[run.job_id]` z `/api/jobs`. Sierot brak (`FOREIGN KEY ... ON DELETE CASCADE`, `db.js:48`), więc lookup zawsze trafia.

### 4.1 Statbar — JEDYNE źródło: wzbogacony `/api/status`

Statbar jest globalny (widoczny na każdej zakładce), więc NIE może zależeć od tab-zależnych fetchy `/api/jobs` (tylko zakładka Zadania) ani `/api/runs` (tylko Historia). **Decyzja po roaście: wzbogacić `/api/status`** o `today_success`, `today_failed`, `next:{job_name,next_run}` — liczone server-side w SQL. `loadStatus` (poll 3s na każdej zakładce) zasila całość.

| Element UI | Źródło (po wzbogaceniu `/api/status`) |
|---|---|
| **Następne:** `<nazwa> za <czas>` | `status.next.job_name` + `formatCountdown(status.next.next_run)` |
| **Aktywne** `6/7` | `status.enabled_jobs / status.total_jobs` |
| **Dziś** `12✓ 1✗` + health bar | `status.today_success` / `status.today_failed`; health bar = proporcja (flex) |
| **Kolejka** | `status.queue_length` |
| **Uptime** | `formatUptime(status.uptime)` |

> ⚠️ Backend (nowe pola w `/api/status`): „Dziś" licz `WHERE date(started_at)=date('now','localtime')` — `date('now')` w SQLite jest UTC, bez `localtime` „Dziś" przeskoczy o północy UTC (dla PL 1:00/2:00 w nocy). „Następne" = min `next_run` z enabled jobów (scheduler już liczy per job: `scheduler.getNextRun`).

### 4.2 Tabela zadań (wiersz = job z `/api/jobs`)
| Kolumna | Źródło |
|---|---|
| Ikona | `job_type==='script'` → `›_`, inaczej `◷` |
| Nazwa | `job.name` |
| Tag-pill | `skill_name` → `/<skill_name>` (pomarańcz mono-pill); script → `skrypt` (badge); inaczej `prompt` (badge) |
| HARMONOGRAM | `cronToHuman(job.cron_expr)` lub „tylko webhook" gdy brak crona |
| OSTATNI RUN | ostatni run joba z `/api/runs?job_id=` → `formatCountdown`-style + kropka (success=zielony/error=czerwony) |
| 7 RUN (sparkline) | ostatnie 7 runów joba (status) → słupki zielony/czerwony |
| NASTĘPNY | `job.next_run` → `formatDateTime` + `formatCountdown` |
| STATUS (switch) | `job.enabled` → `toggleJob(id)` |
| AKCJE | ▶ `triggerJob` · ⏻ `toggleJob` · ✎ `openEditModal` · ✕ `deleteJob` |

> **OSTATNI RUN + 7 RUN wymagają runów per job — DECYZJA: nowy endpoint z window function.** Wariant „(a) jeden `GET /api/runs?limit=N` + grupowanie w JS" z pierwotnego planu jest **BŁĘDNY**: job rutynowy #18 leci `*/1 * * * *` i zajmuje całe okno (ostatnie 50 runów = 100% job #18; ostatnie 200 = 199× #18). Nawet bez niego flat-limit nie złapie 7 runów joba tygodniowego (#11 `0 8 * * 1`). Skoro backend jest tykalny → **`GET /api/runs/recent?per_job=7`**:
> ```sql
> SELECT * FROM (
>   SELECT r.*, ROW_NUMBER() OVER (PARTITION BY job_id ORDER BY id DESC) rn FROM runs r
> ) WHERE rn <= 7
> ```
> Jedno zapytanie, zawsze dokładnie N per job, niezależne od kadencji. SQLite (better-sqlite3 v12) ma window functions. Per-job fetch (7× `?job_id=X&limit=7`) to fallback, gdyby endpoint odpadł.

### 4.3 Historia (wiersz = run z `/api/runs`)
| Kolumna | Źródło |
|---|---|
| ID | `#${run.id}` |
| ZADANIE | `jobsMap[run.job_id].name` |
| STATUS (badge) | `run.status` → mapowanie na 5 stanów (patrz 4.5) |
| WYZWALACZ | `run.trigger_type` → ikona+label (patrz 4.6) |
| START | `formatDateTime(run.started_at)` |
| CZAS | `formatDuration(started_at, finished_at)` |
| Rozwinięcie (błąd) | log viewer: nagłówek (proc + exit + czas) + `formatClaudeOutput(stdout)` / `stderr` / `error_msg` |

### 4.4 Skille (karta/wiersz = skill z `/api/skills`)
| Element | Źródło |
|---|---|
| Nazwa | `/<skill.dir_name>` |
| Badge typu | `skill.source` → `project`→PROJEKT / `user`→USER / `plugin`→PLUGIN (+ `skill.plugin` jak jest) |
| Opis | `skill.description` |
| Stopka „N zadań · ostatnio X" | policzyć joby gdzie `skill_name===dir_name`; „ostatnio" = ostatni run takiego joba; gdy 0 → „nieużywany" |
| Filtry + liczniki | grupowanie po `source` |

### 4.5 / 4.6 — ZWERYFIKOWANE, przeniesione do 4.0
~~DO WERYFIKACJI~~ — zrobione. Oba pierwotne założenia były błędne (`error`→realnie `failed`, `stopped`→`killed`, „schedule/cron"→`scheduled`, „Rutynowe" to NIE trigger lecz flaga joba). Pełne mapowanie: **sekcja 4.0**.

---

## SEKCJA 5 — Kalendarz (decyzja + jak policzyć)

Backend **nie zwraca occurrences** — kalendarz to nowa logika po stronie frontu.

**Rekomendacja: zostaw na osobny krok PO domknięciu Listy/Historii/Skilli** (mniej ryzyka w jednym podejściu). W międzyczasie ukryj toggle „Kalendarz" albo pokaż placeholder.

**Gdy robić — occurrences w JS (nie trzeba pełnego parsera cron):** formularz generuje tylko 5 wzorców (`buildCronFromForm`), więc wystarczy obsłużyć:
- `daily` (`mm hh * * *`) → wystąpienie każdego dnia o hh:mm
- `weekdays` (`* * 1-5`) → pon–pt
- `weekly` (`* * <dow>`) → dany dzień tygodnia
- `hours` (`0 */n * * *`) / `minutes` (`*/n * * * *`) → **wysoka częstotliwość = filtr skryptowy, domyślnie ukryte w kalendarzu** (punkt logiki #1 — inaczej każdy dzień to ściana kropek)

Dla każdego enabled joba policz wystąpienia w bieżącym tygodniu → wrzuć do kolumn dni. Status kropki = 3 stany: zielony (run sukces danego dnia), czerwony (błąd), szary (nieuruchomione/przyszłe). Wyłączone joby = brak wystąpień. Demo ma tylko widok Tydzień (Miesiąc wycięty — dla cyklicznego schedulera bezużyteczny).

---

## SEKCJA 6 — 10 punktów logiki (z handoffu, do wpięcia w render)

1. **Filtr zadań skryptowych w kalendarzu** — domyślnie ukryte (sekcja 5)
2. **Pasek zdrowia dnia** — success/fail ratio z dzisiejszych runów (sekcja 4.1)
3. **Scroll w kolumnie dnia** — stała wysokość + `overflow-y` gdy >N wystąpień (jest w CSS dema)
4. **Kropka statusu wystąpienia = 3 stany** (zielony/czerwony/szary), wyłączone joby bez wystąpień
5. **Historia — filtr „Ukryj rutynowe"** domyślnie ON (`hide_routine=1`, już w API)
6. **tabular-nums** w ID/czasach/timestampach (jest w CSS dema: `font-variant-numeric`)
7. **Historia — paleta 5 statusów** (sekcja 4.5)
8. **Log viewer — Kopiuj/Zawijaj/Pełny ekran + kolorowanie heurystyczne** po treści linii (✕/Error/exit≠0 → czerwone), `formatClaudeOutput` w body
9. **Skille — stopka „N zadań" + 2 widoki** (sekcja 4.4)
10. **Modal — segmented typ + pola warunkowe + akordeon**, limity czytelne („10 min"), w kodzie ms (600000/300000)

---

## SEKCJA 7 — Kolejność wykonania (sugerowana)

1. **Backup** — `git checkout -b rebrand-puls` (praca na branchu, nie na main)
2. **Assety** — skopiuj `logo-puls.png` + `favicon.png` do `public/`
3. **CSS** — podmień `public/style.css` na wersję z dema
4. ~~Weryfikacja status/trigger~~ — ZROBIONE, kanon w sekcji 4.0. Zamiast tego: **dodaj 2 endpointy backendu** — `GET /api/runs/recent?per_job=7` (window function, 4.2) + wzbogać `/api/status` o `today_success/today_failed/next` (4.1)
5. **HTML** — przepisz `index.html` (markup dema + domerge produkcyjnych elementów z sekcji 3)
6. **app.js** — przepisz render, zachowaj logikę (sekcja 2.3)
7. **Rebrand widoczny** — title/banner/package description (sekcja 1)
8. **Test lokalny** (sekcja 8)
9. **Kalendarz** — osobny krok (sekcja 5)
10. **README** — na końcu

---

## SEKCJA 8 — Test lokalny (przed deployem)

```bash
cd ~/Documents/Kodowanie/claude-cron
node server.js            # uruchom lokalnie (NIE pod daemonem)
# otwórz http://localhost:7777
```
Sprawdź na realnych danych:
- [ ] Lista zadań ładuje się z `/api/jobs`, tagi/sparkline/następny/switch działają
- [ ] ▶ trigger, ⏻ toggle, ✎ edit, ✕ delete — każda akcja + toast
- [ ] Modal: nowy + edycja, segmented typ przełącza pola, webhook generate/copy, zapis (POST/PUT)
- [ ] Historia: statusy, rozwijanie błędu, log viewer (Kopiuj/Zawijaj), filtr rutynowych
- [ ] Skille: toggle Kafelki/Lista, filtry, stopki „N zadań"
- [ ] Statbar: Następne/Aktywne/Dziś+health/Kolejka/Uptime na realnych liczbach
- [ ] Kill-bar pokazuje się gdy job leci
- [ ] Polling 3s odświeża bez migotania
- [ ] Env toggle VPS (jeśli skonfigurowany)

⚠️ **Daemon** — po testach lokalnych pamiętaj że Mac+CAVE chodzą na starym kodzie; restart daemona dopiero po akceptacji (`pkill -9 -f "node server.js"` → relaunch z repo).

### Windows (parytet Mac+Win — system działa na obu)
Rebrand jest **platform-agnostyczny**: Node + statyczne `public/` + daemon przez `schtasks "ClaudeCron"` (już w `lib/platform.js`). Nowy front serwuje się na Windows identycznie — **zero osobnej roboty frontowej**. Po deployu: restart daemona Windows analogicznie do Mac (`schtasks /End /TN ClaudeCron` → relaunch, lub re-logon).

> **Stary fork `claude-cron-windows` — zarchiwizowany** (`_ARCHIWUM-claude-cron-windows`, 2026-06-22). Był to porzucony staruszek (kod z kwietnia, stary schemat bez `routine/job_type/command`); rdzeń Windows już dawno wmergowany do main (`405ce1e`). Wyciągnięto z niego 2 zaległe fixy: (1) **regex webhooka z query string** `server.js` `/^\/webhook\/([a-zA-Z0-9_-]+)(?:\?|$)/` — main 404-ował na `?param=...`; (2) **sanityzacja hosta VPS** w ówczesnym `setup-windows.ps1` (strip protokołu/slasha/portu) — od fazy 2 „ułatwienie instalacji" root `setup.sh`/`setup-windows.ps1` usunięte, konfigurację robi wspólny `setup.mjs` (`buildVpsUrl`). Folder do usunięcia po weryfikacji, że nic więcej nie trzeba.

---

## SEKCJA 9 — Testy automatyczne (zakres B: warstwa backendu `lib`)

Projekt nie ma żadnych testów. Zakres B = **cała testowalna logika backendu** (A: nowe endpointy + regression webhooka + moduł enumów, PLUS szersza warstwa `lib/db.js` + `lib/scheduler.js`). Front (`app.js` — global-script sklejony z DOM) **poza zakresem** dopóki nie zostanie zmodularyzowany; jedyny wyjątek to wyciągnięty moduł mapowania enumów (4.0).

### 9.1 Stack (zero nowych zależności)
- **Runner:** wbudowany `node:test` + `node:assert/strict` (Node v22). NIE dodajemy vitest/jest — reguła „preferuj istniejące / nie dodawaj deps".
- **Baza w testach:** `better-sqlite3` (już jest) w trybie **`:memory:`** — szybko, izolowanie, bez śmiecenia plikiem. Fixture: seed kilku jobów/runów w `beforeEach`, NIE ładuj realnego datasetu.
- **Skrypt:** dodać `"test": "node --test"` do `package.json` (⚠️ `name` i reszta bez zmian — Sekcja 0).
- **Kolokacja:** testy obok źródła — `lib/db.test.js`, `lib/scheduler.js` → `lib/scheduler.test.js` itd.
- **Wzorzec:** Arrange-Act-Assert; wertykalnie (tracer bullets: jeden test → implementacja → następny), nie wszystkie naraz.

### 9.2 Co testować (każdy: min. happy path + error/edge case)

| Moduł / funkcja | Kluczowe asercje |
|---|---|
| `db.getRuns({hideRoutine})` | UDANY run rutynowego joba **ukryty**, ale jego **FAIL widoczny** (`WHERE NOT (routine=1 AND status='success')`); nierutynowe zawsze widoczne |
| `db.getRuns({job_id})` | zwraca tylko runy danego joba, DESC, respektuje `limit` |
| nowy `recent` (window function) | dokładnie N per job niezależnie od kadencji (seed: job co-minutę + job rzadki → oba dostają N) |
| `db.deleteOldRoutineRuns` | kasuje TYLKO `success` rutynowych starsze niż cutoff; fail/timeout/nierutynowe zostają |
| CASCADE | `deleteJob` kasuje też jego runy (FK `ON DELETE CASCADE`) |
| `scheduler.getNextRun` / cron | 5 wzorców (`daily/weekdays/weekly/hours/minutes`) → poprawny następny czas; zły cron → błąd, nie cichy `null` |
| **webhook token matching** | wyciągnij regex do funkcji: `plain` ✓, `?query` ✓ (regression buga), token bez query ✓, nielegalny znak → brak matcha |
| nowy `/api/status` (today + next) | `today_success/today_failed` liczone z `date('now','localtime')` (granica północy lokalnej, nie UTC); `next` = min next_run enabled |
| **moduł mapowania enumów (4.0)** | `failed→err`, `killed→stop`, `queued→run`, nieznany status → fallback (nie pusty badge); trigger `scheduled→Harmonogram`, `retry→Harmonogram` |

### 9.3 Czego NIE testować (świadomie poza zakresem)
- Skrypty install/uninstall (launchd/schtasks) — platform-specific, niska zmienność, weryfikacja ręczna.
- `executor.js` (spawn Claude CLI) — integracja wymagająca mocka CLI; kruche i drogie. Ewentualnie później, cienko.
- `public/app.js` render — global-script, wymaga refaktoru do modułów + jsdom. Odłożone (zob. wyjątek: moduł enumów).

### 9.4 Kolejność (wpiąć w Sekcję 7)
Testy piszemy **wertykalnie razem z nowym kodem**: nowy endpoint `recent` → jego test; wzbogacony `/api/status` → jego test; przy okazji regression webhooka. Szersza warstwa (`getRuns` legacy, `scheduler`, `deleteOldRoutineRuns`) — po domknięciu rebrandu, jako osobny przebieg. Reguła: po napisaniu kodu uruchom `node --test` PRZED „gotowe".

---

## SEKCJA 10 — Powiązanie z kursem: połączony instalator VPS (B1)

> Decyzja produktowa (kurs „Osobisty Asystent AI", 01.07). Nie część rebrandu frontu — osobny wątek na instalatorze `scripts/install-vps.sh`, ale zapisane tu, żeby nie zginęło.

Kurs łączy dwie lekcje VPS w jedną („B1 — Asystent w chmurze"), bo dziś kursant przechodzi **dwa osobne instalatory** pokrywające się w ~60%:
- `obsidian-vps-installer` (repo `AIBiz-Automatyzacje/obsidian-vps-installer`) — środowisko + Claude CLI + login + Obsidian Sync/Remote
- `scripts/install-vps.sh` (to repo) — Node + Claude CLI + login + Tailscale + scheduler

**Cel: `install-vps.sh` wchłania kroki Obsidian** (headless `ob` install + `ob sync-setup` + `ob sync-config --file-types …,unsupported` + dwukierunkowy Remote), tak żeby **jedna komenda** postawiła: środowisko + login Claude (raz) + dwukierunkowy sync + Tailscale + Puls. Po merge'u `obsidian-vps-installer` do wycofania.

Konsekwencje:
- Dziś `install-vps.sh` NIE klonuje vaulta ani nie konfiguruje Obsidian Sync — zakłada gotowe repo `~/vault-git` (tylko `git pull` w auto-update cronie). Po merge'u ma to ogarnąć sam (login Obsidian + `sync-setup` + `sync-config`).
- ⚠️ **Pamiętać o `--file-types …,unsupported`** — bez tego raporty HTML/JSON ze skilli zostają na VPS i nie docierają na komputer (zweryfikowane 27.06; przewodnik `Zasoby/Archiwum/Tech/obsidian-headless-vps-guide.md` sekcja 3).
- Login do Claude ma lecieć **raz** (dziś jest dublowany między dwoma instalatorami).
- Audyt kursu z pełnym kontekstem lekcji B1/B4: `…/asystent_obsidian/Aktualizacja/Co poprawić?.md` (sekcje „B1", „B4").

---

## Załącznik — pliki repo dotknięte

**Front (przepisać/podmienić):** `public/index.html`, `public/style.css`, `public/app.js`, +`public/logo-puls.png`, +`public/favicon.png`
**Rebrand widoczny:** `server.js` (banner), `package.json` (description), `README.md`
**Backend (2 dodatki — patrz Sekcja 0):** `server.js` + `lib/db.js` — nowy `GET /api/runs/recent?per_job=N` (window function) + wzbogacony `/api/status` (`today_success/today_failed/next`)
**Testy (zakres B — Sekcja 9):** +`lib/db.test.js`, +`lib/scheduler.test.js`, +test regexa webhooka, +test modułu enumów; `"test": "node --test"` w `package.json`
**NIE ruszać (Sekcja 0):** `lib/config.js`, `lib/platform.js`, `scripts/install-*`, `scripts/uninstall-*` — techniczne ID
**Usunąć po migracji:** `public/_preview.html` (stary mockup roboczy)
