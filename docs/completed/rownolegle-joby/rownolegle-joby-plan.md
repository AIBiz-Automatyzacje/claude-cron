# Równoległe joby + sprint domykający — plan zadania

**Branch:** `feature/rownolegle-joby`
**Ostatnia aktualizacja:** 2026-07-30

## Źródła

- Requirements doc: — (brak; ustalenia powstały w sesji koncepcyjnej + sesji roastu 30.07)
- Plan techniczny: [docs/plans/2026-07-30-001-feat-rownolegle-joby-sprint-plan.md](../../plans/2026-07-30-001-feat-rownolegle-joby-sprint-plan.md)
- Dokument źródłowy (nieaktualny architektonicznie): [docs/plans/2026-07-30-rownolegle-joby.md](../../plans/2026-07-30-rownolegle-joby.md)

## Podsumowanie wykonawcze

Puls wykonuje dziś **jedno zadanie naraz**. Skutek zmierzony na żywej bazie: w poniedziałek
~9:00 job „Team OS — inbox sync" (typowo 2 s, kadencja co minutę) czeka kwadrans za jobem
„Classroom sync" (747 s), choć obiecuje latencję minuty.

Sprint zmienia to na **jeden konfigurowalny limit współbieżności z jednym slotem zarezerwowanym
dla zadań krótkich**, gdzie „krótkie" wynika z **pomiaru historii czasów**, a nie z typu
zadania. Przy okazji domyka trzy zaległe zakresy: instalator (bramka onboardingu zespołu),
autostart na Macu i opóźnienie startu jobów po wybudzeniu maszyny.

## Cele

1. **Krótkie zadania nigdy nie czekają** — także gdy trafiają do kolejki w trakcie długiego runu.
2. **Długie zadania biegną równolegle** (domyślnie do 2 przy limicie 3).
3. **Zero konfiguracji od użytkownika** dla klasyfikacji krótkie/długie.
4. **Mierzalny efekt** — czas oczekiwania w kolejce zapisywany i porównywalny przed/po.
5. **Zero regresji** — 640 istniejących testów przechodzi bez modyfikacji.

## Zakres

**W zakresie:** kolejka i executor (równoległość, kill per run), API + dashboard, seed jobów
skrzynki, instalator (katalog + port), autostart macOS, karencja sieciowa po wybudzeniu.

**Poza zakresem:** `/ask` (własne bramki, nie wlicza się do limitu), wykrywanie kolizji
plikowych z pomiaru, przycisk „zatrzymaj wszystko", zmiana identyfikatorów technicznych
`claude-cron`, rebrand (w `main` od 27.06).

## Analiza obecnego stanu

- `lib/executor.js:8-9` — globalne singletony `currentProcess`/`currentRunId`. Timery
  (idle/watchdog/sleep-aware, executor.js:218-250) **już są per-run**.
- `lib/scheduler.js:12-44` — `processQueue` przerywa pętlę na `executor.isRunning()`; retry-check
  czyta świeży stan z DB (poprawka z 03.07).
- `lib/db.js` — `getCurrentRun()` z `LIMIT 1`, `runs` bez znacznika wstawienia do kolejki
  (czas oczekiwania **niemierzalny**), `jobs` bez pola wyłączności.
- `lib/platform.js:6` — etykieta launchd `com.claude-cron.scheduler` rozjeżdża się z realnie
  działającym `com.claude-cron.daemon`; `generatePlist()` pisze logi w drzewo repo w `~/Documents`
  (TCC) i bierze `which node` zamiast portable Node.
- `install.sh:30` — `INSTALL_DIR` ma env-override, brak pytania interaktywnego; brak wykrycia
  zajętego portu.

## Stan docelowy

- Kolejka startuje **wszystkie kwalifikujące się** runy: limit `max_concurrent` (state, default 3,
  per maszyna), długie najwyżej `max_concurrent - 1`, ostatni slot wyłącznie dla krótkich.
- Klasyfikacja: mediana z ostatnich 10 **udanych** runów < 60 s = krótkie; brak historii = długie.
- Pętla drain budzi się na **nowy run** (nie tylko na zakończenie poprzedniego).
- Wyłączność: ten sam job, ten sam skill/skrypt (automatycznie), ta sama `lock_group` (jawnie).
- Kill per konkretny run; `/api/runs/current/kill` przy >1 aktywnym → 409 z listą.
- Panel pokazuje listę biegnących runów i pozwala ustawić limit.

## Fazy wdrożenia

### Faza 1 — Równoległość (rdzeń, ~⅔ sprintu)

| # | Unit | Nakład | Zależy od |
|---|---|---|---|
| 1 | Warstwa danych — `lock_group`, `queued_at`, statystyki czasów, `getRunningRuns` | M | — |
| 2 | Executor — mapa aktywnych runów, `killRun(runId)` | M | — |
| 3 | Scheduler — picker, slot rezerwowy, dzwonek | **L** | 1, 2 |
| 4 | API — kill per run, `current_runs`, ustawienie limitu | M | 1-3 |
| 5 | Dashboard — lista runów, pole grupy, ustawienie | M | 4 |
| 6 | Seed, harmonogramy, skill `/puls`, CLAUDE.md | S | 1, 3 |

### Faza 2 — Instalator

| # | Unit | Nakład | Zależy od |
|---|---|---|---|
| 7 | Konfigurowalny katalog instalacji + wykrycie zajętego portu | M | — |

### Faza 3 — Autostart na Macu

| # | Unit | Nakład | Zależy od |
|---|---|---|---|
| 8 | `installMac` przepisany pod wzorzec działającego plista | M | — |

### Faza 4 — Opóźnienie po wybudzeniu

| # | Unit | Nakład | Zależy od |
|---|---|---|---|
| 9 | Karencja sieciowa po wykryciu wybudzenia | S | 3 |

## Kryteria akceptacji (całość zadania)

- [ ] Run krótkiego joba dokolejkowany **w trakcie** biegnącego runu długiego kończy się przed nim
      (test odbioru — jedyny dowód, że pętla budzi się na nową pracę).
- [ ] Przy limicie 3 dwa długie runy biegną równolegle, trzeci długi czeka, krótki wchodzi od razu.
- [ ] Dwa runy tego samego joba nigdy nie biegną naraz; dwa joby z tym samym skillem/skryptem też nie.
- [ ] Kill celuje w konkretny run; drugi aktywny żyje. Kontrakt „killed milczy" nienaruszony.
- [ ] `npm test` — 640 istniejących testów przechodzi **bez modyfikacji** + nowe testy zielone.
- [ ] Panel pokazuje wszystkie biegnące runy i pozwala zatrzymać wybrany.
- [ ] Instalator pyta o katalog i czytelnie reaguje na zajęty port.
- [ ] Panel pokazuje prawdę o autostarcie na Macu, a instalowany plist wstaje po reboocie.
- [ ] Joby sieciowe nie padają na `ENOTFOUND` w pierwszej minucie po wybudzeniu Maca.

## Ocena ryzyka i mitygacja

| Ryzyko | Mitygacja |
|---|---|
| Wspólne okno limitu planu Claude — równoległość przyspiesza jego zużycie | Start od `max_concurrent = 3` (VPS) / 2 (Mac), tydzień obserwacji przed podnoszeniem |
| Fail-open: niezadeklarowana kolizja plikowa = cichy lost update | Dwie reguły automatyczne (ten sam skill / skrypt), rozstrzelenie znanych kolizji, opis w skillu `/puls` |
| Wyciek wpisu w mapie aktywnych runów cicho zmniejsza limit | Domknięcie na `'exit'` z karencją + idempotentne zwolnienie (wzorzec z awarii 14.07) |
| Pętla drain — najbardziej podatny na błędy fragment | Picker jako czysta funkcja + testy na wolnych skryptach; osobny test odbioru na dokolejkowanie w trakcie |
| Stary klient skilla `/puls` dostanie 409 | Skill aktualizowany razem z deployem (Unit 6) |
| `lib/platform.js` bez żadnego testu | Characterization test generatora plista **przed** zmianą zachowania |
| Windows: dwa równoczesne drzewa procesów | `taskkill /T /F` działa per PID; osobny przebieg operatorski na Windowsie |

## Mierniki sukcesu

1. **Podstawowy:** czas oczekiwania „Team OS — inbox sync" w kolejce (`queued_at → started_at`)
   w oknie pon. 8:00-10:00 spada z minut do sekund. Przed zmianą **niemierzalny** — dlatego
   `queued_at` ląduje w Unit 1, przed resztą.
2. **Kontrolny:** liczba runów `failed`/`timeout` w tygodniu po wdrożeniu nie rośnie.
3. **Regresyjny:** 640 istniejących testów zielonych na każdym kroku.

## Szacunki

| Faza | Nakład |
|---|---|
| Faza 1 (Unit 1-6) | 2-3 dni; ~połowa to Unit 3 i jego testy |
| Faza 2 (Unit 7) | ~0,5 dnia + przebieg na Windowsie |
| Faza 3 (Unit 8) | ~0,5 dnia |
| Faza 4 (Unit 9) | ~0,5 dnia |

## Kolejność wdrożenia

1. Faza 1 — jedyna zmieniająca architekturę; rollout najpierw Mac (efekt widać w poniedziałek), potem VPS.
2. Faza 2 — bramka onboardingu pierwszej osoby z zespołu.
3. Faza 3 — dziś objaw kosmetyczny na maszynie Kacpra, ale świeża instalacja na cudzym Macu jest zepsuta.
4. Faza 4 — dotyka tej samej pętli co Faza 1, więc po jej ustabilizowaniu; obejście (przesunięte godziny) działa.
