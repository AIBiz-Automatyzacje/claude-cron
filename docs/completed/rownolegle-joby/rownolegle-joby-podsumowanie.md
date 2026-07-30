# Równoległe joby + sprint domykający — podsumowanie

**Data ukończenia:** 2026-07-30
**Branch:** `feature/rownolegle-joby`
**Fazy:** 4/4 zamknięte (execute + review + fix). Testy: `npm test` **790 pass / 0 fail**
(baseline 640 → 150 nowych testów, **zero modyfikacji istniejących** — kontrakt R7 utrzymany).

## Co zostało dostarczone

### Faza 1 — Równoległość (rdzeń, Unit 1-6)

Puls przestał wykonywać jedno zadanie naraz. Kolejka startuje wszystkie kwalifikujące się runy:

- **Warstwa danych** — kolumny `lock_group` (jobs) i `queued_at` (runs), `getRunningRuns()`,
  `getRecentSuccessDurations()`, `getQueueWaitStats()` (metryka odbioru: `queued_at → started_at`,
  wcześniej niemierzalna).
- **Executor** — singletony `currentProcess`/`currentRunId` zastąpione mapą `activeRuns`,
  `killRun(runId)` (zapis `killed` do DB **przed** ubiciem procesu), `getActiveRuns()`,
  domknięcie na `'exit'` z karencją `EXIT_RELEASE_GRACE_MS`.
- **Scheduler** — czysty picker `pickEligibleRuns` (limit → slot rezerwowy → 3 reguły wyłączności),
  klasyfikacja krótki/długi z **pomiaru** (mediana 10 udanych runów, próg 60 s),
  dzwonek `ringNewWorkBell` budzący `Promise.race` pętli drain.
- **API** — `POST /api/runs/:id/kill`, 409 z listą przy `killCurrent` i >1 aktywnym,
  `current_runs` w `/api/status`, `GET/PUT /api/settings/concurrency` (sufit 10).
- **Dashboard** — kill-bar przepisany na siatkę wierszy (lista biegnących runów, kill per wiersz),
  pole „Grupa wyłączności" na jobie, modal limitu przez `apiBase()` (LOKALNY/VPS).
- **Seed + dokumentacja** — `lock_group:'dashboard'` na jobie inbox sync (tylko `createJob`),
  aktualizacja `CLAUDE.md` i skilla `/puls` (endpoint limitu, nowy kod 409).

### Faza 2 — Instalator (Unit 7)

Konfigurowalny katalog instalacji (`install.sh` → `ask_install_dir`/`resolve_install_dir`,
`install.ps1` → `Read-InstallDir`/`Resolve-InstallDir`, env `INSTALL_DIR` pomija pytanie)
i rozstrzygnięcie kolizji portu przed hookiem i startem serwera (`setup.mjs` →
`resolveDashboardPort`, `classifyPortState`, `probeDashboardPort`). Port wypalany w trzy miejsca
naraz (env User-scope, źródło hooka autostartu, `spawnServer`).

### Faza 3 — Autostart na Macu (Unit 8)

`lib/platform.js` przepisany pod wzorzec plista, który realnie wstaje: wrapper `/bin/sh -c`
z `cd && exec`, logi w `~/Library/Logs/claude-cron/` (repo w `~/Documents` = brak zgody TCC →
`EX_CONFIG 78` bez śladu w logu), portable Node z `.node/`, whitelist `EnvironmentVariables`,
`escapeXml` + `shellQuote`, rozpoznanie i sprzątanie legacy etykiety `com.claude-cron.daemon`.
`getStatus()` decyduje po **kolumnie PID** z `launchctl list`, nie po substringu.
Pierwsze pokrycie modułu testami (36 testów, przenośne na Linuksie).

### Faza 4 — Karencja po wybudzeniu (Unit 9)

Po wykryciu powrotu maszyny do życia pętla drain wstrzymuje **start** runów o `WAKE_GRACE_MS = 45 s`
— koniec `ENOTFOUND` w pierwszej minucie po pobudce Maca. Dwa źródła detekcji: luka między
tyknięciami heartbeatu (sen przy żyjącym procesie) oraz `detectWakeFromDowntime()` w `start()`
(reboot). Timer karencji jest własnym bodźcem pętli (`Promise.race` obok dzwonka).

## Kluczowe decyzje

1. **Jeden limit + slot rezerwowy, nie dwa pasy po `job_type`.** Dane z żywej bazy klasyfikują
   odwrotnie w obie strony: najdłuższy job systemu (747 s) to `script`, 18-sekundowy to `claude`.
2. **Klasyfikacja z pomiaru: mediana (nie średnia) z 10 ostatnich UDANYCH runów, próg 60 s.**
   Rozkład czasów jest bimodalny (747…115 ‖ 18, 2, 0 s) — między 18 a 115 s nie ma nic.
   Brak historii = długi (fail-safe): pomyłka w drugą stronę blokuje slot rezerwowy.
3. **`max_concurrent` w tabeli `state` (default 3, per maszyna), czytany w momencie picku.**
   Zero migracji schematu, zmiana z dashboardu bez restartu (wzorzec `notify-config.js`).
4. **Model wyłączności fail-open**: brak deklaracji = zgoda na równoległość. Dwie reguły
   automatyczne (ten sam `job_id`, ten sam niepusty `skill_name`/`command`) + jedna deklaratywna
   (`lock_group` = współdzielony ARTEFAKT, nigdy „cały vault").
5. **Znane kolizje harmonogramu naprawiamy harmonogramem, nie kodem** (rozstrzelenie cronów).
6. **`/ask` poza limitem** — ma własne bramki i od tygodni utrzymuje 4 równoległe procesy `claude`
   w produkcji; to empiryczne obalenie tezy „1 ciężki naraz, bo zasoby".
7. **Detekcja wybudzenia opiera się o chwilę WYBUDZENIA, nie `last_active_at`** — po pobudce Node
   natychmiast odpala zaległy callback heartbeatu i nadpisuje znacznik, więc luka znika, zanim
   ktokolwiek zdąży ją przeczytać.
8. **Karencja obejmuje WSZYSTKIE joby i jest sztywnym czekaniem, nie probe'em sieci** — probe wnosi
   I/O do pętli kolejki (wiszący DNS blokuje drain) i jest nietestowalny bez sieci.
9. **Etykieta launchd zostaje `com.claude-cron.scheduler`** (identyfikator techniczny z CLAUDE.md);
   rozjazd z ręcznym `com.claude-cron.daemon` rozwiązany przez `LEGACY_PLIST_LABELS` +
   sprzątanie przed `load` (dwa agenty biją się o port 7777).
10. **Zakres Unitu 8: moduł TAK, wpięcie w ścieżkę usera NIE.** Autostart na Macu robi dziś hook
    Claude Code (`setup.mjs`); dołożenie launchd bez wygaszenia hooka = dwa mechanizmy wskrzeszające
    serwer na tym samym porcie. Decyzja produktowa zapisana jako Unit 10 (follow-up).
11. **Stan portu z DWÓCH sygnałów** (bind-test + kontrakt pól `/api/status`), nie z `lsof`:
    narzędzia systemowe różnią się per OS i nie powiedzą, **czyj** to serwer.

## Główne pliki

| Plik | Zmiana |
|---|---|
| `lib/scheduler.js` | picker, slot rezerwowy, dzwonek, karencja po wybudzeniu, `sanitizeMaxConcurrent` |
| `lib/executor.js` | mapa `activeRuns`, `killRun(runId)`, `getActiveRuns()`, domknięcie na `'exit'` |
| `lib/db.js` | `lock_group`, `queued_at`, `getRunningRuns`, `getRecentSuccessDurations`, `getQueueWaitStats` |
| `server.js` | `/api/runs/:id/kill`, 409, `current_runs`, `GET/PUT /api/settings/concurrency` |
| `public/app.js`, `public/index.html`, `public/style.css` | lista biegnących runów, pole grupy, modal limitu |
| `lib/platform.js` | `buildPlist`, `resolvePortableNodeBin`, `parseLaunchctlList`, sprzątanie legacy |
| `install.sh`, `install.ps1`, `setup.mjs` | katalog instalacji + rozstrzygnięcie portu |
| `lib/inbox-seed.js`, `skills/puls/SKILL.md`, `CLAUDE.md` | `lock_group`, dokumentacja równoległości |
| Testy | `lib/scheduler.test.js`, `lib/executor.test.js`, `lib/db.test.js`, `lib/platform.test.js` (nowy), `server.runs.test.js` (nowy), `setup.test.mjs`, `install.test.sh`, `install.ps1.Tests.ps1` |

## Wyciągnięte wnioski

- **Każde nowe źródło zmiany stanu kolejki musi mieć swój dzwonek, a każda ścieżka wyjścia z runu —
  swoje domknięcie.** Picker (czyste funkcje) był zdrowy; trzy defekty żywotności siedziały
  w obietnicach: odrzucona obietnica `executeRun` zapętlała drain, slot zwalniał się dopiero na
  `'close'`, zmiana limitu nie dzwoniła.
- **Próg wykrywający lukę między okresowymi śladami życia musi być ostro większy od okresu tykania**
  — timery libuv gwarantują „nie wcześniej niż", więc `gap > period` bierze KAŻDE tyknięcie za
  wybudzenie. `t.mock.timers.tick(period)` daje gap dokładnie równy progowi (wartość nieosiągalną
  w produkcji), więc test jest zielony przy złamanym zachowaniu — dokładaj jawny jitter.
  Udokumentowane: `docs/solutions/runtime-errors/2026-07-30-prog-detekcji-snu-rowny-okresowi-heartbeatu.md`
  (reguła w `.claude/rules/learned-patterns.md`).
- **Zdarzenie globalne (pobudka maszyny) wykrywaj na ścieżce, która po nim faktycznie biegnie**, nie
  w jednym callbacku timera — po pobudce kolejność zaległych timerów nie jest twoja.
- **Zmiana źródła wartości na wolne wejście usera wymaga przeglądu KAŻDEGO destrukcyjnego
  konsumenta** (Faza 2: `mv "$INSTALL_DIR"` do tmp kasowanego trapem, `Contains` bez granicy
  ścieżki ubijający cudze `node`). Ten sam antywzorzec wrócił w Fazie 3 (`.node/` po substringu).
- **Guard XFF nie jest guardem CSRF** — powtórka learned-patternu 2026-07-24 na nowych endpointach
  mutujących; „endpoint nie zwraca sekretu" zamyka wektor odczytu, nie zapisu.
- **Kolumna PID / dokładna fraza, nie substring** — `!out.includes('-')` w starym `getStatus()`
  zwracało `running:false` zawsze, bo myślnik siedzi w nazwie `claude-cron`.
- **Seed `createJob`-only chroni tylko nowe instalacje** — `lock_group` na istniejących maszynach
  zostaje `NULL` (świadomy koszt reguły „seed nigdy nie robi `UPDATE`").
- **Testy czystych funkcji przechodzą przy złamanym zachowaniu systemowym** — potwierdzone trzy razy
  w tym sprincie (szew klasyfikacji, ścieżka I/O `installMac()`, szew heartbeat→karencja).

## Otwarte pozycje (świadomie poza zakresem)

- **Kroki operatora** (nieodhaczone, wymagają człowieka): restart lokalnego daemona na kod po
  `bde391d`, ustawienie `max_concurrent` (VPS 3 / Mac 2) i tydzień obserwacji, rozstrzelenie
  kolidujących cronów, przebieg instalatora przez prawdziwy pipe i na Windowsie (Pester),
  realny `launchctl load` + reboot Maca z kopią `.bak` starego plista, E2E dashboardu przez
  przeglądarkę (dwa wiersze runów, kill per wiersz, round-trip pól).
- **Unit 10 (follow-up):** wpięcie `platform.install()` w ścieżkę usera — decyzja produktowa
  „hook Claude Code vs launchd"; rozstrzyga też dwa zawieszone findingi P3 wokół `buildMacStatus`.
- **Dług:** `lib/scheduler.js` = 655 linii przy limicie 300 — wyraźny szew do wyjęcia
  (`lib/scheduler-wake.js`: karencja + heartbeat + detekcja wybudzenia). Plus otwarte P3:
  N+1 `getRecentSuccessDurations` w pętli drain (window function), backfill `lock_group` dla
  istniejących instalacji, `SELECT *` w `getRunningRuns` (wycieka `webhook_payload`/`stdout`
  do `/api/status`), sufit w `resolveMaxConcurrent`, nielimitowany bufor `stdout` w executorze.
